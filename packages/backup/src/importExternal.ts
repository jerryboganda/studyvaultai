import { HIGHLIGHT_KINDS, MAX_COMMENT_CHARS, MAX_QUOTE_CHARS, MAX_TITLE_CHARS } from '@shared';
import { DEFAULT_CSV_LIMITS, parseCsv } from './csv';
import { resolveCrypto, type Subtle } from './crypto';
import { BackupError } from './errors';
import { cleanText, normalizeQuote, quoteHash, safeHttpUrl } from './text';

export interface ImportLimits {
  /** Largest accepted input, in UTF-8 bytes. */
  maxBytes: number;
  /** Highlights/records per file. Above this the whole file is refused. */
  maxRecords: number;
  maxQuoteChars: number;
  maxCommentChars: number;
  maxTags: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRecords: 10_000,
  maxQuoteChars: MAX_QUOTE_CHARS,
  maxCommentChars: MAX_COMMENT_CHARS,
  maxTags: 32,
};

export interface ImportOptions {
  limits?: Partial<ImportLimits>;
  /** quoteHash values already in the vault: matching candidates are reported as duplicates. */
  existingQuoteHashes?: ReadonlySet<string>;
  subtle?: Subtle;
}

/**
 * One candidate highlight from an external file. It is UNTRUSTED text: it must be shown as text,
 * reviewed by the user, and stored with `origin: 'imported'`. It is never source provenance:
 * the quote did not come from a page the extension saw, and `sourceUrl` is a claim, not a capture.
 */
export interface ImportedHighlight {
  origin: 'imported';
  needsReview: true;
  format: 'markdown' | 'csv';
  /** 1-based line (Markdown) or record number (CSV, header = 1) in the input. */
  position: number;
  quote: string;
  normalizedQuote: string;
  /** SHA-256 hex of normalizedQuote: the same rule storage uses for duplicate detection. */
  quoteHash: string;
  comment: string;
  tags: string[];
  /** Name hints only; the vault decides where it goes. */
  bank: string | null;
  folder: string | null;
  kind: (typeof HIGHLIGHT_KINDS)[number] | null;
  sourceTitle: string | null;
  /** http(s) only, credentials removed. */
  sourceUrl: string | null;
  /** Valid ISO timestamp or null. */
  capturedAt: string | null;
}

export type ImportRejection =
  'empty_quote' | 'quote_too_long' | 'comment_too_long' | 'too_many_tags';

export interface ImportRowSet {
  highlights: ImportedHighlight[];
  duplicates: { position: number; quoteHash: string; of: 'import' | 'existing' }[];
  rejected: { position: number; reason: ImportRejection }[];
  stats: { records: number; accepted: number; duplicates: number; rejected: number };
}

interface Raw {
  position: number;
  quote: string;
  comment: string;
  tags: string[];
  bank: string | null;
  folder: string | null;
  kind: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  capturedAt: string | null;
}

const limitsOf = (o: ImportOptions): ImportLimits => ({ ...DEFAULT_IMPORT_LIMITS, ...o.limits });

function checkSize(input: string, limits: ImportLimits): void {
  // UTF-8 length without allocating: BMP chars <= 3 bytes, so length*3 is an upper bound.
  if (input.length * 3 <= limits.maxBytes) return;
  const bytes = new TextEncoder().encode(input).length;
  if (bytes > limits.maxBytes) {
    throw new BackupError('limit_exceeded', 'The file is larger than the import limit.', {
      bytes,
      maxBytes: limits.maxBytes,
    });
  }
}

const KINDS = new Set<string>(HIGHLIGHT_KINDS);

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v.trim());
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year >= 1990 && year <= 2100 ? new Date(t).toISOString() : null;
}

async function finalize(
  raws: Raw[],
  format: 'markdown' | 'csv',
  options: ImportOptions,
  limits: ImportLimits,
): Promise<ImportRowSet> {
  const { subtle } = resolveCrypto(options);
  const out: ImportRowSet = {
    highlights: [],
    duplicates: [],
    rejected: [],
    stats: { records: raws.length, accepted: 0, duplicates: 0, rejected: 0 },
  };
  const seen = new Set<string>();
  const reject = (position: number, reason: ImportRejection) => {
    out.rejected.push({ position, reason });
  };
  for (const r of raws) {
    const quote = r.quote.trim();
    if (quote === '') {
      reject(r.position, 'empty_quote');
      continue;
    }
    if (quote.length > limits.maxQuoteChars) {
      reject(r.position, 'quote_too_long');
      continue;
    }
    if (r.comment.length > limits.maxCommentChars) {
      reject(r.position, 'comment_too_long');
      continue;
    }
    if (r.tags.length > limits.maxTags) {
      reject(r.position, 'too_many_tags');
      continue;
    }
    const normalizedQuote = normalizeQuote(quote);
    const hash = await quoteHash(subtle, normalizedQuote);
    if (options.existingQuoteHashes?.has(hash)) {
      out.duplicates.push({ position: r.position, quoteHash: hash, of: 'existing' });
      continue;
    }
    if (seen.has(hash)) {
      out.duplicates.push({ position: r.position, quoteHash: hash, of: 'import' });
      continue;
    }
    seen.add(hash);
    out.highlights.push({
      origin: 'imported',
      needsReview: true,
      format,
      position: r.position,
      quote,
      normalizedQuote,
      quoteHash: hash,
      comment: r.comment.trim(),
      tags: [...new Set(r.tags)],
      bank: r.bank,
      folder: r.folder,
      kind: r.kind && KINDS.has(r.kind) ? (r.kind as ImportedHighlight['kind']) : null,
      sourceTitle: r.sourceTitle ? r.sourceTitle.slice(0, MAX_TITLE_CHARS) : null,
      sourceUrl: safeHttpUrl(r.sourceUrl),
      capturedAt: isoOrNull(r.capturedAt),
    });
  }
  out.stats.accepted = out.highlights.length;
  out.stats.duplicates = out.duplicates.length;
  out.stats.rejected = out.rejected.length;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const unescapeMd = (s: string): string => s.replace(/\\([\\`*_{}[\]()#+\-.!<>~|&$=%])/g, '$1');
const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
/** A line that belongs to a highlight's metadata: citation, tag/block-id line, comment, "Also in". */
const META_LINE =
  /^((—|–|--)\s|(#[\p{L}\p{N}_/-]+|\^[\w-]+)(\s+(#[\p{L}\p{N}_/-]+|\^[\w-]+))*$|\*\*Comment:\*\*|Also in:)/u;

/** `\s` for one character (the ASCII cases without a regular expression: this runs per character). */
function isSpace(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return c === 32 || (c >= 9 && c <= 13) || (c > 127 && /\s/.test(ch));
}

/**
 * `^(#{1,6})\s+(.*?)\s*#*\s*$` by hand. The regular expression is cubic on a line of the form
 * "# a" + many spaces + "b" (seconds at 2,000 characters, which a 1 MB line turns into forever);
 * this is one pass.
 */
export function parseHeading(line: string): { level: number; text: string } | null {
  let level = 0;
  while (line[level] === '#') level++;
  if (level < 1 || level > 6 || !isSpace(line[level])) return null;
  // `.` in the regular expression does not match these, so such a line is not a heading
  if (/[\u2028\u2029]/.test(line)) return null;
  let start = level;
  while (isSpace(line[start])) start++;
  let end = line.length;
  while (end > start && isSpace(line[end - 1])) end--;
  while (end > start && line[end - 1] === '#') end--;
  while (end > start && isSpace(line[end - 1])) end--;
  return { level, text: line.slice(start, end) };
}

/**
 * The first `[text](url)` of a line: the regular expression
 * `\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)` retried from every `[`, which is quadratic on "[[[[[…".
 * Whatever the scan from one `[` finds at the next `]` is what every later `[` before it finds, so
 * the search resumes after that `]`; and an address scan that failed at `end` without meeting a
 * `)` fails the same way for every address that starts before `end`. The line is read once.
 */
export function findLink(t: string): { text: string; url: string } | null {
  let doomedUntil = 0;
  let open = t.indexOf('[');
  while (open >= 0) {
    let close = open + 1;
    while (close < t.length && t[close] !== ']') {
      if (t[close] === '\\') {
        if (close + 1 >= t.length) return null; // a lone backslash ends the line: no `]` follows
        close++;
      }
      close++;
    }
    if (close >= t.length) return null; // no unescaped `]` anywhere after this `[`
    const from = close + 2;
    if (t[close + 1] === '(' && from >= doomedUntil) {
      let end = from;
      while (end < t.length && t[end] !== ')' && !isSpace(t[end])) end++;
      if (end > from && t[end] === ')') {
        return { text: t.slice(open + 1, close), url: t.slice(from, end) };
      }
      doomedUntil = end;
    }
    open = t.indexOf('[', close + 1);
  }
  return null;
}

function parseMarkdown(text: string, limits: ImportLimits): Raw[] {
  // A line longer than anything a highlight or comment may hold is cut: a quote or comment cut here
  // is still over its limit and is rejected as such, never imported shortened.
  const lineCap = Math.max(limits.maxQuoteChars, limits.maxCommentChars) + 1024;
  const lines = cleanText(text)
    .split('\n')
    .map((l) => (l.length > lineCap ? l.slice(0, lineCap) : l));
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.slice(1, 80).findIndex((l) => l.trim() === '---');
    if (end >= 0) i = end + 2;
  }
  const headings: string[] = [];
  const out: Raw[] = [];
  const quoteRe = /^\s{0,3}>\s?(.*)$/;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    const h = parseHeading(line);
    if (h) {
      headings.length = h.level - 1;
      headings[h.level - 1] = unescapeMd(h.text);
      continue;
    }
    if (!quoteRe.test(line)) continue;
    const start = i;
    const q: string[] = [];
    while (i < lines.length && quoteRe.test(lines[i] as string)) {
      q.push((quoteRe.exec(lines[i] as string) as RegExpExecArray)[1] as string);
      i++;
    }
    // callouts (> [!note] ...) are notes, not quotes
    if (/^\[![A-Za-z-]+\]/.test(q[0] ?? '')) {
      i--;
      continue;
    }
    const raw: Raw = {
      position: start + 1,
      quote: q.map(unescapeMd).join('\n').trim(),
      comment: '',
      tags: [],
      bank: headings[0] ?? null,
      folder: headings.length > 1 ? headings.slice(1).filter(Boolean).join(' / ') : null,
      kind: null,
      sourceTitle: null,
      sourceUrl: null,
      capturedAt: null,
    };
    const comment: string[] = [];
    // The citation block may follow after one blank line; a "**Comment:**" paragraph after that.
    const blockLines: string[] = [];
    const takeBlock = (): void => {
      for (; i < lines.length; i++) {
        const m = lines[i] as string;
        if (m.trim() === '' || quoteRe.test(m) || /^#{1,6}\s/.test(m)) break;
        blockLines.push(m);
      }
    };
    // Consecutive paragraphs that look like metadata (citation, tags, block id, comment). A plain
    // prose paragraph is not ours: it ends the highlight instead of being imported as a comment.
    for (;;) {
      let k = i;
      while (k < lines.length && lines[k]?.trim() === '') k++;
      if (k >= lines.length || !META_LINE.test((lines[k] as string).trim())) break;
      i = k;
      takeBlock();
    }
    for (const m of blockLines) {
      const t = m.trim();
      if (/^(—|–|--)\s/.test(t) && raw.sourceTitle === null && raw.sourceUrl === null) {
        const link = findLink(t);
        const parts = t.replace(/^(—|–|--)\s*/, '').split(' · ');
        raw.sourceTitle = unescapeMd(link ? link.text : (parts[0] ?? ''));
        raw.sourceUrl = link ? link.url : null;
        for (const p of parts.slice(1)) {
          const day = /^captured (\d{4}-\d{2}-\d{2})$/.exec(p.trim());
          if (day) raw.capturedAt = `${day[1]}T00:00:00.000Z`;
          else if (KINDS.has(unescapeMd(p.trim()))) raw.kind = unescapeMd(p.trim());
        }
        for (const tm of t.matchAll(TAG_RE)) raw.tags.push(tm[1] as string);
        continue;
      }
      if (/^(#[\p{L}\p{N}_/-]+|\^[\w-]+)(\s+(#[\p{L}\p{N}_/-]+|\^[\w-]+))*$/u.test(t)) {
        for (const tm of t.matchAll(TAG_RE)) raw.tags.push(tm[1] as string);
        continue;
      }
      if (/^Also in:/.test(t)) continue;
      comment.push(unescapeMd(t.replace(/^\*\*Comment:\*\*\s*/, '')));
    }
    raw.comment = comment.join('\n');
    out.push(raw);
    if (out.length > limits.maxRecords) {
      throw new BackupError(
        'limit_exceeded',
        `The file has more than ${limits.maxRecords} highlights.`,
        {
          maxRecords: limits.maxRecords,
        },
      );
    }
    i--; // the for-loop increments
  }
  return out;
}

/**
 * Highlights from Markdown: every blockquote is a quote; the nearest headings become bank/folder
 * hints; a following "— [title](url) · captured YYYY-MM-DD · kind" line, #tags and plain lines are
 * read as source, tags and comment. Understands StudyVault's own Markdown export and plain notes.
 */
export async function importMarkdownHighlights(
  text: string,
  options: ImportOptions = {},
): Promise<ImportRowSet> {
  const limits = limitsOf(options);
  checkSize(text, limits);
  return finalize(parseMarkdown(text, limits), 'markdown', options, limits);
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

const ALIASES: Record<keyof Omit<Raw, 'position'>, string[]> = {
  quote: ['quote', 'exactquote', 'text', 'highlight', 'excerpt', 'passage'],
  comment: ['comment', 'comments', 'note', 'notes', 'usercomment', 'annotation'],
  sourceTitle: ['sourcetitle', 'title', 'source', 'pagetitle'],
  sourceUrl: ['sourceurl', 'url', 'link', 'href', 'uri'],
  capturedAt: ['capturedat', 'captured', 'date', 'created', 'createdat', 'timestamp'],
  tags: ['tags', 'tag', 'labels'],
  bank: ['bank', 'deck', 'collection', 'notebook', 'category'],
  folder: ['folder', 'topic', 'section'],
  kind: ['kind', 'type'],
};

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => head.split(c).length - 1;
  const opts: (',' | ';' | '\t')[] = [',', ';', '\t'];
  return opts.reduce((best, c) => (count(c) > count(best) ? c : best), ',');
}

/** Undo the formula guard of the CSV export (`'=1+1` -> `=1+1`). */
const unguard = (s: string): string => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

/**
 * Highlights from a CSV with a header row. Columns are recognised by name (quote, comment, source
 * title, url, captured at, tags, bank, folder, kind and common synonyms); at least a quote column is
 * required. RFC 4180 quoting; the export's formula guard is undone.
 */
export async function importCsvHighlights(
  text: string,
  options: ImportOptions = {},
): Promise<ImportRowSet> {
  const limits = limitsOf(options);
  checkSize(text, limits);
  const delimiter = detectDelimiter(text);
  const records = parseCsv(cleanText(text), delimiter, {
    ...DEFAULT_CSV_LIMITS,
    maxRecords: limits.maxRecords + 1,
  });
  const header = records[0];
  if (!header) throw new BackupError('import_invalid', 'The CSV file is empty.');
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const col = {} as Record<keyof typeof ALIASES, number>;
  for (const key of Object.keys(ALIASES) as (keyof typeof ALIASES)[]) {
    col[key] = norm.findIndex((n) => ALIASES[key].includes(n));
  }
  if (col.quote < 0) {
    throw new BackupError(
      'import_invalid',
      'No quote column found (expected a header such as "quote" or "text").',
    );
  }
  const cell = (r: string[], key: keyof typeof ALIASES): string | null => {
    const at = col[key];
    const v = at >= 0 ? r[at] : undefined;
    return v === undefined || v === '' ? null : unguard(v);
  };
  const raws: Raw[] = records.slice(1).map((r, n) => ({
    position: n + 2,
    quote: cell(r, 'quote') ?? '',
    comment: cell(r, 'comment') ?? '',
    tags: (cell(r, 'tags') ?? '')
      .split(/[,;\n]/)
      .map((t) => t.trim())
      .filter(Boolean),
    bank: cell(r, 'bank'),
    folder: cell(r, 'folder'),
    kind: cell(r, 'kind'),
    sourceTitle: cell(r, 'sourceTitle'),
    sourceUrl: cell(r, 'sourceUrl'),
    capturedAt: cell(r, 'capturedAt'),
  }));
  return finalize(raws, 'csv', options, limits);
}
