import { clozeToText } from './anki';
import { parseCsv } from './csv';
import { BackupError, isBackupError } from './errors';
import { listZip, looksLikeZip, readZipEntry, type ZipInfo } from './format';
import {
  ANKI_DIRECTIVE,
  MAX_DOCUMENT_BYTES,
  checkSize,
  finalize,
  limitsOf,
  type ImportFormat,
  type ImportOptions,
  type ImportRowSet,
  type Raw,
} from './importExternal';
import { cleanText } from './text';

/**
 * Anki text exports, standalone HTML, EPUB, DOCX and PPTX as import candidates (docs/adr/014).
 * Every file is hostile. Nothing here touches the network, a page or the live DOM:
 *  - ZIP containers are read through the central-directory reader of format.ts only (never
 *    fflate's own walk), under entry-count, per-entry, total and expansion-ratio caps, one entry at
 *    a time, and the stream of an entry must be exactly as long as its header says;
 *  - XML (OOXML, EPUB package files) goes through DOMParser after a DOCTYPE/ENTITY refusal (so
 *    there is nothing to expand); HTML and XHTML go through DOMParser's inert 'text/html' parser.
 *    A DOMParser document has no browsing context: scripts do not run and nothing is fetched. It
 *    is read and dropped, never attached to a page;
 *  - the result is the same ImportRowSet the Markdown/CSV importers make, so the dry run, the
 *    duplicate detection and the write side (one transaction, needs-review marker) are shared.
 * Loaded lazily by the import screen: this module is not part of the page's first chunk.
 */

const MiB = 1024 * 1024;

export interface DocumentLimits {
  /** The file as picked, in bytes. */
  maxFileBytes: number;
  /** Entries of a ZIP-based file. */
  maxEntries: number;
  /** Sum of the declared uncompressed sizes of all entries (archive-wide zip-bomb guard). */
  maxTotalBytes: number;
  /** One entry, decompressed. */
  maxEntryBytes: number;
  /** One XML or HTML part handed to the parser. */
  maxMarkupBytes: number;
  /** What the archive may declare to expand to, as a multiple of its own size (above 8 MiB). */
  maxRatio: number;
  /** Text taken out of one file, in characters. */
  maxTextChars: number;
}

export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = {
  maxFileBytes: MAX_DOCUMENT_BYTES,
  maxEntries: 5_000,
  maxTotalBytes: 256 * MiB,
  maxEntryBytes: 32 * MiB,
  maxMarkupBytes: 16 * MiB,
  maxRatio: 100,
  maxTextChars: 8 * MiB,
};

export type DocumentImportOptions = ImportOptions & { documentLimits?: Partial<DocumentLimits> };

export interface DocumentFile {
  /** The file name as picked: used for the format, the title and the locator, never for a path. */
  name: string;
  bytes: Uint8Array;
}

const invalid = (message: string, details: Record<string, unknown> = {}) =>
  new BackupError('import_invalid', message, details);
const tooBig = (message: string, details: Record<string, unknown> = {}) =>
  new BackupError('limit_exceeded', message, details);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const APKG =
  'Anki .apkg packages are not supported: they hold a SQLite database that StudyVault does not read. In Anki choose File > Export, pick "Notes in Plain Text (.txt)", and import that file here.';
const LEGACY =
  'Old binary Word and PowerPoint files (.doc, .ppt) are not supported. Open the file in Word or PowerPoint and save a copy as .docx or .pptx.';
const OLE =
  'This is an old-style or password-protected Office file, not a .docx or .pptx. StudyVault does not read legacy .doc and .ppt files and does not open password-protected ones. Save an unprotected .docx or .pptx copy and import that.';

// ---------------------------------------------------------------------------------------------
// ZIP containers
// ---------------------------------------------------------------------------------------------

interface Archive {
  names: string[];
  has(name: string): boolean;
  /** One entry's bytes, or null when the archive has no such entry. */
  read(name: string): Uint8Array | null;
}

/** Entry names that mean "not a document": parent segments, absolute or drive paths, `\`, controls. */
// eslint-disable-next-line no-control-regex
const UNSAFE_ENTRY = /(^|\/)\.\.(\/|$)|^\/|\\|[\u0000-\u001f]|^[A-Za-z]:/;
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** A damaged ZIP in a document import is an invalid file, not a damaged StudyVault backup. */
function asInvalid(err: unknown): unknown {
  if (isBackupError(err) && err.code === 'corrupt_archive') {
    const message = err.details.zip64
      ? 'This file uses the ZIP64 extension, which StudyVault does not read.'
      : err.message;
    return new BackupError('import_invalid', message, err.details, err);
  }
  return err;
}

function openArchive(bytes: Uint8Array, limits: DocumentLimits): Archive {
  if (!looksLikeZip(bytes)) {
    throw invalid(
      OLE_SIGNATURE.every((b, i) => bytes[i] === b)
        ? OLE
        : 'This file is not a ZIP-based document. It may be damaged or have the wrong extension.',
    );
  }
  let entries: Map<string, ZipInfo>;
  try {
    entries = listZip(bytes, limits);
  } catch (err) {
    throw asInvalid(err);
  }
  let declared = 0;
  for (const [name, info] of entries) {
    if (UNSAFE_ENTRY.test(name)) {
      throw invalid(
        `The file lists an entry with an unsafe name ("${name.slice(0, 60)}"), so it was refused.`,
      );
    }
    declared += info.originalSize;
  }
  if (declared > Math.max(8 * MiB, bytes.length * limits.maxRatio)) {
    throw tooBig('The file expands to far more than its size, which is how a zip bomb looks.', {
      declaredBytes: declared,
      fileBytes: bytes.length,
    });
  }
  let budget = limits.maxTotalBytes;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const info = entries.get(name);
      if (!info) return null;
      if (info.originalSize > budget) {
        throw tooBig('The parts of the file that are read add up to more than StudyVault allows.');
      }
      try {
        const out = readZipEntry(bytes, entries, name, limits.maxEntryBytes, true);
        budget -= out.length;
        return out;
      } catch (err) {
        throw asInvalid(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------------------------

/** UTF-8 unless a BOM or a declared charset/encoding in the first 1 KiB says otherwise. */
function decodeText(bytes: Uint8Array): string {
  let label = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  else if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    const m = /(?:charset|encoding)\s*=\s*["']?\s*([A-Za-z0-9_.:-]{2,40})/i.exec(head);
    if (m?.[1]) label = m[1];
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function domParse(text: string, type: 'text/html' | 'application/xml'): Document {
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!Parser) {
    throw invalid('This browser context cannot parse documents. Open StudyVault in its own tab.');
  }
  try {
    return new Parser().parseFromString(text, type);
  } catch (cause) {
    throw new BackupError('import_invalid', 'The file could not be parsed.', {}, cause);
  }
}

/** One part of a package: size cap, then (XML) DOCTYPE/ENTITY refusal, then the parser. */
function parseMarkup(
  bytes: Uint8Array,
  kind: 'xml' | 'html',
  what: string,
  limits: DocumentLimits,
): Document {
  if (bytes.length > limits.maxMarkupBytes) {
    throw tooBig(`${what} is larger than the ${limits.maxMarkupBytes / MiB} MB StudyVault parses.`);
  }
  const text = decodeText(bytes);
  if (kind === 'html') return domParse(text, 'text/html');
  // Office and EPUB package files never carry a DOCTYPE; one with entities is an expansion attack.
  if (/<!(?:DOCTYPE|ENTITY)/i.test(text)) {
    throw invalid(
      `${what} declares a document type or entities, which genuine Office and EPUB files never do, so the file was refused.`,
    );
  }
  const doc = domParse(text, 'application/xml');
  if (!doc.documentElement || doc.getElementsByTagName('parsererror').length > 0) {
    throw invalid(`${what} is not well-formed XML; the file may be damaged.`);
  }
  return doc;
}

const BLOCK_TAGS = new Set(
  (
    'address article aside blockquote body caption dd details dialog div dl dt fieldset figcaption ' +
    'figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary ' +
    'table tbody td tfoot th thead tr ul'
  ).split(' '),
);
/** Elements whose text is not prose, or which only exist to run or load something. */
const NOT_TEXT =
  'script,style,noscript,template,iframe,object,embed,head,svg,canvas,audio,video,select,button,textarea,input,annotation';
/** Stands for <br> while whitespace is collapsed. NUL cannot occur in parsed HTML text. */
const BR = '\u0000';

/**
 * The text blocks of a parsed HTML document, in order. Text nodes are grouped by their nearest block
 * element, so `<div>a<p>b</p>c</div>` is three blocks. Whitespace is collapsed except in `<pre>`.
 * Scripts, styles, frames, forms, SVG and templates are dropped first. Consumes `doc`.
 */
function htmlBlocks(doc: Document): { blocks: string[]; images: number } {
  const images = doc.querySelectorAll('img').length;
  for (const el of Array.from(doc.querySelectorAll(NOT_TEXT))) el.remove();
  for (const br of Array.from(doc.querySelectorAll('br'))) br.replaceWith(doc.createTextNode(BR));
  const blocks: string[] = [];
  let owner: Element | null = null;
  let buf = '';
  const flush = () => {
    if (buf === '') return;
    const keep = owner?.closest('pre') != null;
    const lines = buf
      .split(BR)
      .map((l) => (keep ? l : l.replace(/[ \t\n\r\f\u00a0]+/g, ' ').trim()));
    buf = '';
    const text = cleanText(lines.join('\n')).trim();
    if (text !== '') blocks.push(text);
  };
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let block = node.parentElement;
    while (block && !BLOCK_TAGS.has(block.localName)) block = block.parentElement;
    if (block !== owner) {
      flush();
      owner = block;
    }
    buf += node.nodeValue ?? '';
  }
  flush();
  return { blocks, images };
}

/** A fragment of HTML (an Anki field) as plain text, lines kept. */
function htmlFieldText(html: string): string {
  if (!/[<&]/.test(html)) return cleanText(html).trim();
  return htmlBlocks(domParse(html, 'text/html')).blocks.join('\n');
}

// OOXML: the transitional and the strict namespaces of WordprocessingML and DrawingML.
const W_NS = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const A_NS = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);

function nearest(el: Element, localName: string): Element | null {
  for (let n = el.parentElement; n; n = n.parentElement) if (n.localName === localName) return n;
  return null;
}

/**
 * Every paragraph (`w:p` or `a:p`) of an OOXML part with its text: runs `t`, `tab`, `br`, `cr`.
 * A paragraph nested in another (a text box) is its own paragraph and is left out of the outer one;
 * the `mc:Fallback` copy of a drawing is skipped (the `mc:Choice` one has the same text).
 */
function ooxmlParagraphs(
  doc: Document,
  namespaces: ReadonlySet<string>,
): { p: Element; text: string }[] {
  const out: { p: Element; text: string }[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS('*', 'p'))) {
    const ns = p.namespaceURI;
    if (!ns || !namespaces.has(ns) || nearest(p, 'Fallback')) continue;
    let text = '';
    for (const el of Array.from(p.getElementsByTagNameNS(ns, '*'))) {
      const name = el.localName;
      if (name !== 't' && name !== 'tab' && name !== 'br' && name !== 'cr') continue;
      if (nearest(el, 'p') !== p) continue;
      text += name === 't' ? (el.textContent ?? '') : name === 'tab' ? '\t' : '\n';
    }
    out.push({ p, text });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blocks -> rows
// ---------------------------------------------------------------------------------------------

interface Sink {
  /** One text block; empty and symbol-only ones are dropped here and counted. */
  add(text: string, locator: string, position?: number): void;
  readonly symbolOnly: number;
  readonly blocks: { text: string; locator: string; position: number }[];
}

function makeSink(limits: DocumentLimits, maxRecords: number, maxQuoteChars: number): Sink {
  const blocks: Sink['blocks'] = [];
  let seen = 0;
  let chars = 0;
  let symbolOnly = 0;
  return {
    blocks,
    get symbolOnly() {
      return symbolOnly;
    },
    add(raw, locator, position) {
      const text = raw.trim();
      if (text === '') return;
      seen++;
      chars += text.length;
      if (chars > limits.maxTextChars) {
        throw tooBig(`The file holds more than ${limits.maxTextChars} characters of text.`);
      }
      if (!/[\p{L}\p{N}]/u.test(text)) {
        symbolOnly++;
        return;
      }
      if (blocks.length >= maxRecords) {
        throw tooBig(`The file has more than ${maxRecords} text blocks. Import it in parts.`, {
          maxRecords,
        });
      }
      // Over the quote limit it stays over (and is rejected as such): never imported shortened.
      blocks.push({
        text: text.length > maxQuoteChars ? text.slice(0, maxQuoteChars + 1) : text,
        locator,
        position: position ?? seen,
      });
    },
  };
}

interface Parsed {
  /** The document's own title, when it has one. */
  title: string | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------

function parseHtmlFile(bytes: Uint8Array, limits: DocumentLimits, sink: Sink): Parsed {
  const doc = parseMarkup(bytes, 'html', 'The HTML file', limits);
  const title = doc.title.replace(/\s+/g, ' ').trim();
  const { blocks, images } = htmlBlocks(doc);
  blocks.forEach((text, i) => sink.add(text, `Paragraph ${i + 1}`));
  return {
    title: title || null,
    warnings: images > 0 ? [`${count(images, 'image')} skipped: only text is imported.`] : [],
  };
}

// ---------------------------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------------------------

/** Font obfuscation (IDPF, Adobe) leaves the text readable; every other algorithm is DRM. */
const FONT_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

/** `href` relative to `baseDir` inside the archive, or null when it leaves it or is external. */
function resolveHref(baseDir: string, href: string): string | null {
  let path = href.split('#')[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (
    path === '' ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.startsWith('/') ||
    path.includes('\\')
  ) {
    return null;
  }
  const out = baseDir === '' ? [] : baseDir.split('/');
  for (const seg of path.split('/')) {
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

function parseEpub(
  bytes: Uint8Array,
  limits: DocumentLimits,
  maxRecords: number,
  sink: Sink,
): Parsed {
  const zip = openArchive(bytes, limits);
  const protectedBook = (): never => {
    throw invalid(
      'This EPUB is protected (DRM or encryption). StudyVault does not open protected books; use a copy without protection that you are entitled to.',
    );
  };
  if (zip.has('META-INF/rights.xml') || zip.has('META-INF/sinf.xml')) protectedBook();
  const encryption = zip.read('META-INF/encryption.xml');
  if (encryption) {
    for (const m of decodeText(encryption).matchAll(/Algorithm\s*=\s*["']([^"']+)["']/g)) {
      if (!FONT_ALGORITHMS.has(m[1] as string)) protectedBook();
    }
  }
  const container = zip.read('META-INF/container.xml');
  if (!container)
    throw invalid('This does not look like an EPUB: META-INF/container.xml is missing.');
  const rootfile = parseMarkup(container, 'xml', 'META-INF/container.xml', limits)
    .getElementsByTagNameNS('*', 'rootfile')[0]
    ?.getAttribute('full-path');
  const opfPath = rootfile ? resolveHref('', rootfile) : null;
  const opfBytes = opfPath ? zip.read(opfPath) : null;
  if (!opfPath || !opfBytes) throw invalid('The EPUB names a package file that is not there.');
  const opf = parseMarkup(opfBytes, 'xml', opfPath, limits);
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const items = new Map<string, { href: string; type: string; props: string }>();
  let images = 0;
  for (const item of Array.from(opf.getElementsByTagNameNS('*', 'item'))) {
    const type = item.getAttribute('media-type') ?? '';
    if (type.startsWith('image/')) images++;
    items.set(item.getAttribute('id') ?? '', {
      href: item.getAttribute('href') ?? '',
      type,
      props: item.getAttribute('properties') ?? '',
    });
  }
  // a chapter listed twice is read once: the spine is the file's to repeat, not a way to repeat work
  const spine = [
    ...new Set(
      Array.from(opf.getElementsByTagNameNS('*', 'itemref')).map(
        (r) => r.getAttribute('idref') ?? '',
      ),
    ),
  ];
  if (spine.length === 0) throw invalid('The EPUB lists no chapters.');

  let chapter = 0;
  let unreadable = 0;
  for (const id of spine) {
    const item = items.get(id);
    if (!item || !/html/.test(item.type) || /\bnav\b/.test(item.props)) continue;
    const path = resolveHref(dir, item.href);
    const data = path ? zip.read(path) : null;
    if (!path || !data) {
      unreadable++;
      continue;
    }
    chapter++;
    const { blocks } = htmlBlocks(parseMarkup(data, 'html', path, limits));
    if (blocks.length > maxRecords) {
      throw tooBig(`A chapter has more than ${maxRecords} text blocks.`, { maxRecords });
    }
    blocks.forEach((text, i) => sink.add(text, `Chapter ${chapter}, paragraph ${i + 1}`));
  }
  if (chapter === 0) throw invalid('The EPUB has no readable chapters.');
  const title = opf
    .getElementsByTagNameNS('*', 'title')[0]
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();
  const warnings: string[] = [];
  if (images > 0) warnings.push(`${count(images, 'image')} skipped: only text is imported.`);
  if (unreadable > 0) {
    warnings.push(
      `${count(unreadable, 'chapter')} could not be read and ${unreadable === 1 ? 'was' : 'were'} skipped.`,
    );
  }
  return { title: title || null, warnings };
}

// ---------------------------------------------------------------------------------------------
// DOCX and PPTX
// ---------------------------------------------------------------------------------------------

function parseDocx(bytes: Uint8Array, limits: DocumentLimits, sink: Sink): Parsed {
  const zip = openArchive(bytes, limits);
  const body = zip.read('word/document.xml');
  if (!body) {
    throw invalid('This does not look like a Word .docx file: word/document.xml is missing.');
  }
  let n = 0;
  for (const { text } of ooxmlParagraphs(
    parseMarkup(body, 'xml', 'word/document.xml', limits),
    W_NS,
  )) {
    if (text.trim() !== '') sink.add(text, `Paragraph ${++n}`, n);
  }
  const warnings: string[] = [];
  const images = zip.names.filter((name) => name.startsWith('word/media/')).length;
  if (images > 0) warnings.push(`${count(images, 'image')} skipped: only text is imported.`);
  const extras = ['footnotes', 'endnotes', 'comments'].filter((p) => zip.has(`word/${p}.xml`));
  if (extras.length > 0) warnings.push(`Not imported: ${extras.join(', ')}.`);
  return { title: null, warnings };
}

const SLIDE_CHROME = new Set(['sldNum', 'ftr', 'dt']);

function parsePptx(
  bytes: Uint8Array,
  limits: DocumentLimits,
  maxRecords: number,
  sink: Sink,
): Parsed {
  const zip = openArchive(bytes, limits);
  const slides = zip.names
    .flatMap((name) => {
      const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
      return m ? [{ name, number: Number(m[1]) }] : [];
    })
    .sort((a, b) => a.number - b.number);
  if (!zip.has('ppt/presentation.xml') || slides.length === 0) {
    throw invalid('This does not look like a PowerPoint .pptx file: it has no slides.');
  }
  if (slides.length > maxRecords) {
    throw tooBig(`The file has more than ${maxRecords} slides.`, { maxRecords });
  }
  let empty = 0;
  for (const { name, number } of slides) {
    const data = zip.read(name) as Uint8Array;
    const lines = ooxmlParagraphs(parseMarkup(data, 'xml', name, limits), A_NS)
      .filter(({ p }) => {
        // slide number, footer and date placeholders are the template's, not the slide's text
        const type = nearest(p, 'sp')?.getElementsByTagNameNS('*', 'ph')[0]?.getAttribute('type');
        return !(type && SLIDE_CHROME.has(type));
      })
      .map(({ text }) => text.trim())
      .filter(Boolean);
    if (lines.length === 0) empty++;
    else sink.add(lines.join('\n'), `Slide ${number}`, number);
  }
  const warnings: string[] = [];
  if (empty > 0) warnings.push(`${count(empty, 'slide')} without text skipped.`);
  const media = zip.names.filter((name) => name.startsWith('ppt/media/')).length;
  if (media > 0)
    warnings.push(`${count(media, 'image or media file')} skipped: only text is imported.`);
  const notes = zip.names.filter((name) =>
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name),
  ).length;
  if (notes > 0) warnings.push(`Speaker notes (${count(notes, 'slide')}) are not imported.`);
  return { title: null, warnings };
}

// ---------------------------------------------------------------------------------------------
// Entry point for binary and markup files
// ---------------------------------------------------------------------------------------------

const extensionOf = (name: string): string =>
  (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase();

/**
 * Highlights from a DOCX, PPTX, EPUB or HTML file: one candidate per paragraph (a slide's text for
 * PPTX), each with the file name and a locator. The extension picks the reader and the reader
 * checks the file really has that structure. Throws `import_invalid` (wrong or protected file),
 * `limit_exceeded` (a size or ratio cap) and never partially returns: it is a dry run.
 */
export async function importDocument(
  file: DocumentFile,
  options: DocumentImportOptions = {},
): Promise<ImportRowSet> {
  const limits = { ...DEFAULT_DOCUMENT_LIMITS, ...options.documentLimits };
  const importLimits = limitsOf(options);
  const ext = extensionOf(file.name);
  if (ext === 'apkg' || ext === 'colpkg') throw invalid(APKG);
  if (ext === 'doc' || ext === 'ppt') throw invalid(LEGACY);
  if (file.bytes.length > limits.maxFileBytes) {
    throw tooBig('The file is larger than the import limit.', {
      bytes: file.bytes.length,
      maxBytes: limits.maxFileBytes,
    });
  }
  const sink = makeSink(limits, importLimits.maxRecords, importLimits.maxQuoteChars);
  let format: ImportFormat;
  let parsed: Parsed;
  switch (ext) {
    case 'docx':
      format = 'docx';
      parsed = parseDocx(file.bytes, limits, sink);
      break;
    case 'pptx':
      format = 'pptx';
      parsed = parsePptx(file.bytes, limits, importLimits.maxRecords, sink);
      break;
    case 'epub':
      format = 'epub';
      parsed = parseEpub(file.bytes, limits, importLimits.maxRecords, sink);
      break;
    case 'html':
    case 'htm':
    case 'xhtml':
      format = 'html';
      parsed = parseHtmlFile(file.bytes, limits, sink);
      break;
    default:
      throw invalid(
        'This file type is not one StudyVault imports. Supported: .docx, .pptx, .epub, .html, Anki text exports, Markdown and CSV.',
      );
  }
  const title = parsed.title ?? file.name;
  const raws: Raw[] = sink.blocks.map((b) => ({
    position: b.position,
    quote: b.text,
    comment: '',
    tags: [],
    bank: null,
    folder: null,
    kind: null,
    sourceTitle: title,
    sourceUrl: null,
    capturedAt: null,
    file: file.name,
    locator: b.locator,
  }));
  const set = await finalize(raws, format, options, importLimits);
  const warnings = [...parsed.warnings];
  if (sink.symbolOnly > 0) {
    warnings.push(
      `${count(sink.symbolOnly, 'block')} with no letters or digits (rules, page marks) skipped.`,
    );
  }
  if (raws.length === 0) warnings.push('No text was found in this file.');
  return { ...set, warnings };
}

// ---------------------------------------------------------------------------------------------
// Anki plain-text exports
// ---------------------------------------------------------------------------------------------

const SEPARATOR_NAMES: Record<string, string> = {
  tab: '\t',
  pipe: '|',
  semicolon: ';',
  colon: ':',
  comma: ',',
  space: ' ',
};

/**
 * Notes of an Anki "Notes in Plain Text" export. The `#separator`, `#html`, and `#tags`, `#deck`,
 * `#notetype`, `#guid` column directives are honoured; every other column is a field. A Cloze note
 * becomes its sentence with the deletions filled in (comment: the extra field); any other note
 * becomes its Back as the quote with the Front as the comment (a note with no Back: the Front).
 * Tags are kept as they are; the deck is a bank/folder hint. Scheduling is not in these files.
 */
export async function importAnkiHighlights(
  text: string,
  options: DocumentImportOptions & { name?: string } = {},
): Promise<ImportRowSet> {
  const limits = limitsOf(options);
  checkSize(text, limits);
  const lines = cleanText(text).split('\n');
  const header = new Map<string, string>();
  let at = 0;
  for (; at < lines.length; at++) {
    const m = ANKI_DIRECTIVE.exec(lines[at] as string);
    if (!m) break;
    header.set((m[1] as string).toLowerCase(), (m[2] as string).trim());
  }
  const body = lines.slice(at).join('\n');
  const named = header.get('separator')?.toLowerCase() ?? '';
  const guess = [...'\t;,|'].reduce((best, c) => {
    const first = body.split('\n', 1)[0] ?? '';
    return first.split(c).length > first.split(best).length ? c : best;
  }, '\t');
  const delimiter = SEPARATOR_NAMES[named] ?? (named.length === 1 ? named : guess);
  let records: string[][];
  try {
    records = parseCsv(body, delimiter, {
      maxRecords: limits.maxRecords,
      maxColumns: 64,
      maxFieldChars: 100_000,
    });
  } catch (err) {
    // the quoting rules are CSV's; the person did not pick a CSV file
    if (isBackupError(err) && err.code === 'import_invalid') {
      throw new BackupError('import_invalid', err.message.replace(/^CSV: /, 'Anki export: '));
    }
    throw err;
  }

  const column = (key: string): number => {
    const n = Number(header.get(key));
    return Number.isInteger(n) && n >= 1 ? n - 1 : -1;
  };
  const tagsAt = column('tags column');
  const deckAt = column('deck column');
  const meta = new Set([tagsAt, deckAt, column('notetype column'), column('guid column')]);
  const html = (header.get('html') ?? '').toLowerCase() === 'true';
  const name = options.name ?? 'Anki export';
  let withImages = 0;
  const field = (s: string | undefined): string => {
    if (!s) return '';
    if (html && /<img\b/i.test(s)) withImages++;
    const t = html ? htmlFieldText(s) : cleanText(s);
    return t.replace(/\[sound:[^\]]*\]/g, '').trim();
  };

  const raws: Raw[] = records.map((rec, i) => {
    const [first = '', second = ''] = rec.filter((_, c) => !meta.has(c)).map(field);
    const cloze = /\{\{c\d+::/.test(first);
    const quote = cloze ? clozeToText(first) : second || first;
    const comment = cloze ? second : second && first ? `Front: ${first}` : '';
    const deck = (deckAt >= 0 ? (rec[deckAt] ?? '') : (header.get('deck') ?? ''))
      .split('::')
      .map((s) => s.trim());
    return {
      position: i + 1,
      quote,
      comment,
      tags: [header.get('tags') ?? '', tagsAt >= 0 ? (rec[tagsAt] ?? '') : '']
        .join(' ')
        .split(/\s+/)
        .filter(Boolean),
      bank: deck[0] || null,
      folder: deck.length > 1 ? deck.slice(1).filter(Boolean).join(' / ') || null : null,
      kind: null,
      sourceTitle: name,
      sourceUrl: null,
      capturedAt: null,
      file: name,
      locator: `Note ${i + 1}`,
    };
  });
  const set = await finalize(raws, 'anki', options, limits);
  const warnings: string[] = [];
  if (withImages > 0) {
    warnings.push(`${count(withImages, 'field')} had images, which are not imported (text only).`);
  }
  if (!header.has('separator')) {
    warnings.push(
      'The file does not say which separator it uses; it was guessed from the first line.',
    );
  }
  return { ...set, warnings };
}
