import type { Locator, Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { showTask } from './helpers.backup';

/**
 * Fixtures and handles for import-formats.spec.ts: Word, PowerPoint, EPUB, HTML and Anki files built
 * in Node (small ZIPs of XML, as the real programs write them) and handed to the Options page's real
 * file input. Hostile variants (zip bomb, entities, unsafe names ...) are built here too.
 */

export const external = (page: Page): Locator => page.getByTestId('backup-external');

export interface ImportFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** "Import", then hand `file` to the importer's file input. */
export async function chooseImport(page: Page, file: ImportFile): Promise<void> {
  await showTask(page, 'import');
  await external(page)
    .getByTestId('backup-external-file')
    .setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.bytes) });
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const text = (s: string) => strToU8(s);

// ---- Word ------------------------------------------------------------------------------------

export const DOCX_QUOTES = [
  'Aldosterone increases sodium reabsorption in the distal nephron.',
  'The loop of Henle builds the medullary concentration gradient.',
] as const;

export const docxXml = (...paragraphs: string[]): string =>
  `${XML}<w:document xmlns:w="${W}"><w:body>${paragraphs
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join('')}</w:body></w:document>`;

export function docx(extra: Record<string, Uint8Array> = {}): ImportFile {
  return {
    name: 'renal-physiology.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: zipSync({
      '[Content_Types].xml': text('<Types/>'),
      'word/document.xml': text(docxXml(DOCX_QUOTES[0], '* * *', DOCX_QUOTES[1])),
      'word/media/image1.png': new Uint8Array([137, 80, 78, 71]),
      ...extra,
    }),
  };
}

// ---- PowerPoint ------------------------------------------------------------------------------

export const PPTX_SLIDES = [
  'Beta blockers\nMetoprolol lowers heart rate by blocking beta-1 receptors.',
  'ACE inhibitors\nLisinopril prevents conversion of angiotensin I to angiotensin II.',
] as const;

const slideXml = (...lines: string[]) =>
  `${XML}<p:sld xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${lines
    .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

export function pptx(): ImportFile {
  return {
    name: 'cardiac-pharmacology.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    bytes: zipSync({
      '[Content_Types].xml': text('<Types/>'),
      'ppt/presentation.xml': text(`${XML}<p:presentation xmlns:p="${P}"/>`),
      'ppt/slides/slide1.xml': text(slideXml(...PPTX_SLIDES[0].split('\n'))),
      'ppt/slides/slide2.xml': text(slideXml(...PPTX_SLIDES[1].split('\n'))),
      'ppt/slides/slide3.xml': text(slideXml()),
    }),
  };
}

// ---- EPUB ------------------------------------------------------------------------------------

export const EPUB_QUOTES = [
  'The brainstem',
  'The medulla oblongata controls breathing and heart rate.',
  'The cerebellum coordinates voluntary movement and balance.',
] as const;

const chapter = (body: string) =>
  `${XML}\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">` +
  `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title><script>window.__svRan=true</script></head><body>${body}</body></html>`;

export function epub(extra: Record<string, Uint8Array> = {}): ImportFile {
  return {
    name: 'neuroanatomy.epub',
    mimeType: 'application/epub+zip',
    bytes: zipSync({
      mimetype: text('application/epub+zip'),
      'META-INF/container.xml': text(
        `${XML}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      ),
      'OEBPS/content.opf': text(
        `${XML}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Neuroanatomy primer</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`,
      ),
      'OEBPS/a.xhtml': text(chapter(`<h1>${EPUB_QUOTES[0]}</h1><p>${EPUB_QUOTES[1]}</p>`)),
      'OEBPS/b.xhtml': text(chapter(`<p>${EPUB_QUOTES[2]}</p>`)),
      ...extra,
    }),
  };
}

// ---- HTML ------------------------------------------------------------------------------------

export const HTML_QUOTES = [
  'Thyroid',
  'Thyroxine raises the basal metabolic rate.',
  'Calcitonin lowers serum calcium.',
] as const;

export const html = (): ImportFile => ({
  name: 'endocrine-notes.html',
  mimeType: 'text/html',
  bytes: text(
    `<!doctype html><html><head><meta charset="utf-8"><title>Endocrine notes</title>` +
      `<script>window.__svRan = true</script><link rel="stylesheet" href="http://evil.invalid/s.css"></head><body>` +
      `<h1>${HTML_QUOTES[0]}</h1><p>${HTML_QUOTES[1]}</p><p>${HTML_QUOTES[2]}</p>` +
      `<img src="http://evil.invalid/pixel.png" onerror="window.__svRan = true">` +
      `<iframe src="http://evil.invalid/frame.html"></iframe></body></html>`,
  ),
});

// ---- Anki ------------------------------------------------------------------------------------

export const ANKI_QUOTES = [
  'Beta-lactams such as penicillin inhibit cell wall synthesis.',
  'Statins inhibit HMG-CoA reductase.',
] as const;

export const anki = (): ImportFile => ({
  name: 'pharmacology-deck.txt',
  mimeType: 'text/plain',
  bytes: text(
    [
      '#separator:tab',
      '#html:true',
      '#guid column:1',
      '#notetype column:2',
      '#deck column:3',
      '#tags column:6',
      [
        'g1',
        'Basic',
        'Pharmacology::Antibiotics',
        'Which class inhibits cell wall synthesis?',
        'Beta-lactams such as <b>penicillin</b> inhibit cell wall synthesis.',
        'antibiotics exam',
      ].join('\t'),
      [
        'g2',
        'Cloze',
        'Pharmacology',
        'Statins inhibit {{c1::HMG-CoA reductase}}.',
        '',
        'lipids',
      ].join('\t'),
      '',
    ].join('\n'),
  ),
});

// ---- Hostile and unsupported -----------------------------------------------------------------

const MIB = 1024 * 1024;

/** 24 MiB of zeros in ~24 KB: expands 1000:1, far over the archive-wide ratio guard. */
export const zipBomb = (): ImportFile => ({
  name: 'bomb.docx',
  mimeType: 'application/octet-stream',
  bytes: zipSync({
    '[Content_Types].xml': text('<Types/>'),
    'word/document.xml': new Uint8Array(24 * MIB),
  }),
});

export const unsafeName = (): ImportFile => ({
  name: 'traversal.docx',
  mimeType: 'application/octet-stream',
  bytes: zipSync({
    '[Content_Types].xml': text('<Types/>'),
    'word/document.xml': text(docxXml('Innocent looking text.')),
    '../../outside.txt': text('x'),
  }),
});

export const billionLaughs = (): ImportFile => ({
  name: 'laughs.docx',
  mimeType: 'application/octet-stream',
  bytes: zipSync({
    '[Content_Types].xml': text('<Types/>'),
    'word/document.xml': text(
      `${XML}<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">` +
        `<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>` +
        `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&lol3;</w:t></w:r></w:p></w:body></w:document>`,
    ),
  }),
});

export const protectedEpub = (): ImportFile => ({
  ...epub({ 'META-INF/rights.xml': text('<rights/>') }),
  name: 'protected.epub',
});

export const apkg = (): ImportFile => ({
  name: 'deck.apkg',
  mimeType: 'application/octet-stream',
  bytes: zipSync({
    'collection.anki2': new Uint8Array([83, 81, 76, 105, 116, 101]),
    media: text('{}'),
  }),
});

export const legacyDoc = (): ImportFile => ({
  name: 'old-notes.doc',
  mimeType: 'application/msword',
  bytes: Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
});

export const passwordProtectedDocx = (): ImportFile => ({
  name: 'locked.docx',
  mimeType: 'application/octet-stream',
  bytes: Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
});
