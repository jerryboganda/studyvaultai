import type { Page } from '@playwright/test';
import { buildPdf, proseFixture, type FixturePage } from '@pdf/testing/pdfWriter';

/**
 * PDFs for the reader's browser tests, generated in code (nothing binary is checked in). The plain
 * ones come from the unit-test writer; the scanned one needs a raster of real glyphs, which only a
 * browser can draw, so it is rendered through a canvas on a throwaway page.
 */

export const PROSE_TITLE = 'Renal physiology';

/** Ten short pages: "Page N line M: the quick brown fox jumps over the lazy dog." */
export function proseDoc(pages = 3, title = PROSE_TITLE): Buffer {
  return Buffer.from(buildPdf(proseFixture(pages), { title }));
}

/** Page 1 holds one sentence that wraps over two lines; the selection tests cross that wrap. */
export const WRAPPED_LINE_1 = 'The glomerulus filters plasma at a steady rate and the';
export const WRAPPED_LINE_2 = 'tubule reabsorbs most of the filtered water and salts.';

export function wrappedDoc(title = 'Wrapped lines'): Buffer {
  const pages: FixturePage[] = [
    {
      texts: [
        { x: 72, y: 700, text: 'A short heading for the page', size: 16 },
        { x: 72, y: 660, text: WRAPPED_LINE_1 },
        { x: 72, y: 646, text: WRAPPED_LINE_2 },
        { x: 72, y: 610, text: 'Unrelated closing sentence about the loop of Henle.' },
      ],
    },
    ...proseFixture(2),
  ];
  return Buffer.from(buildPdf(pages, { title }));
}

/** Twelve pages with bookmarks: two chapters, the first with two sections. */
export function outlinedDoc(title = 'Outlined notes'): Buffer {
  return Buffer.from(
    buildPdf(proseFixture(12), {
      title,
      outline: [
        {
          title: 'Chapter one: filtration',
          page: 1,
          children: [
            { title: 'Section 1.1 Glomerulus', page: 2, fromTop: 60 },
            { title: 'Section 1.2 Bowman capsule', page: 4, fromTop: 60 },
          ],
        },
        { title: 'Chapter two: transport', page: 7 },
      ],
    }),
  );
}

export function lockedDoc(password: string, title = 'Locked notes'): Buffer {
  return Buffer.from(buildPdf(proseFixture(2), { title, userPassword: password }));
}

/** Page 1 has text, page 2 is an image only: a partly scanned document. */
export function partlyScannedDoc(): Buffer {
  return Buffer.from(
    buildPdf([...proseFixture(1), { imageOnly: true }, ...proseFixture(1)], { title: 'Partly scanned' }),
  );
}

/**
 * Scanned pages: for each entry of `pages` a grayscale raster of its lines set in a bold sans-serif at a
 * size a recogniser reads reliably, as a page with NO text layer. `page` is any open page (it is only
 * used to get a canvas).
 */
export async function scannedPages(
  page: Page,
  pages: string[][],
  title = 'Scanned notes',
): Promise<Buffer> {
  const pxPerLine = 130;
  const width = 1800;
  const rasters: FixturePage[] = [];
  for (const lines of pages) {
    const height = 120 + lines.length * pxPerLine;
    const base64 = await page.evaluate(
      ({ lines, width, height, pxPerLine }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 84px Arial, Helvetica, sans-serif';
        ctx.textBaseline = 'top';
        lines.forEach((line, i) => ctx.fillText(line, 60, 60 + i * pxPerLine));
        const rgba = ctx.getImageData(0, 0, width, height).data;
        const gray = new Uint8Array(width * height);
        for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4]!;
        let binary = '';
        for (let i = 0; i < gray.length; i += 0x8000) {
          binary += String.fromCharCode(...gray.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      },
      { lines, width, height, pxPerLine },
    );
    const data = new Uint8Array(Buffer.from(base64, 'base64'));
    // 3 raster pixels per point (216 dpi).
    rasters.push({ width: width / 3, height: height / 3, gray: { width, height, data } });
  }
  return Buffer.from(buildPdf(rasters, { title }));
}

/** One scanned page. */
export function scannedDoc(page: Page, lines: string[], title?: string): Promise<Buffer> {
  return scannedPages(page, [lines], title);
}

/** One page, two columns of eight rows under a full-width heading (reading order is column by column). */
export function twoColumnDoc(): Buffer {
  const rows = Array.from({ length: 8 }, (_, i) => [
    { x: 72, y: 690 - i * 16, text: `left column row ${i + 1} about glomerular filtration` },
    { x: 330, y: 690 - i * 16, text: `right column row ${i + 1} about tubular secretion` },
  ]).flat();
  return Buffer.from(
    buildPdf([{ texts: [{ x: 72, y: 740, text: 'Two column article heading', size: 18 }, ...rows] }], {
      title: 'Two columns',
    }),
  );
}

/** Page 1 carries /Rotate 90 (text written along the page's +y axis); page 2 is landscape. */
export function rotatedDoc(): Buffer {
  return Buffer.from(
    buildPdf(
      [
        {
          rotate: 90,
          texts: [
            { x: 160, y: 72, text: 'Second line of the rotated page', angle: 90 },
            { x: 120, y: 72, text: 'First line of the rotated page', angle: 90 },
          ],
        },
        {
          width: 792,
          height: 612,
          texts: [
            { x: 72, y: 540, text: 'Landscape page first line of text' },
            { x: 72, y: 524, text: 'Landscape page second line of text' },
          ],
        },
      ],
      { title: 'Rotated and landscape' },
    ),
  );
}

/** The same sentence twice on one page, with different neighbours. */
export const REPEATED_SENTENCE = 'The proximal tubule reabsorbs most of the filtered sodium.';
export function repeatedDoc(): Buffer {
  return Buffer.from(
    buildPdf(
      [
        {
          texts: [
            { x: 72, y: 700, text: 'First paragraph introduces the nephron segments.' },
            { x: 72, y: 684, text: REPEATED_SENTENCE },
            { x: 72, y: 640, text: 'Second paragraph restates the point for emphasis.' },
            { x: 72, y: 624, text: REPEATED_SENTENCE },
            { x: 72, y: 608, text: 'It then moves on to the loop of Henle.' },
          ],
        },
      ],
      { title: 'Repeated sentence' },
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Links (pdf-links.spec.ts)
// ---------------------------------------------------------------------------------------------

/** What each link of `linkedDoc` page 1 says, in the order they sit on the page (top to bottom). */
export const LINK_TEXTS = {
  internal: 'Internal link: go to page three',
  named: 'Named destination: the glossary',
  external: 'External link: example.org',
  script: 'Script link: do not open',
  mail: 'Mail link: not a web address',
  plain: 'A plain line of text with no link on it',
} as const;
export const LINK_EXTERNAL_URL = 'https://example.org/path?a=1';
export const GLOSSARY_HEADING = 'Glossary: the named destination points here.';
export const PAGE_THREE_HEADING = 'Page three: the internal link points here.';

/**
 * Four pages. Page 1 has one link per line: a GoTo to page 3, a named destination (page 2), an
 * https address, a `javascript:` address and a `mailto:` address, and a line with no link. Pages 2 and
 * 3 hold the targets, page 4 is filler so that page 3 is not the last.
 */
export function linkedDoc(title = 'Linked notes'): Buffer {
  const line = (y: number, text: string) => ({ x: 72, y, text });
  const pages: FixturePage[] = [
    {
      texts: [
        line(700, LINK_TEXTS.internal),
        line(660, LINK_TEXTS.named),
        line(620, LINK_TEXTS.external),
        line(580, LINK_TEXTS.script),
        line(540, LINK_TEXTS.mail),
        line(500, LINK_TEXTS.plain),
        line(460, 'A link that wraps'),
        line(446, 'over two lines'),
      ],
      links: [
        { rect: [72, 696, 262, 712], goTo: { page: 3, fromTop: 100 } },
        { rect: [72, 656, 262, 672], named: 'glossary' },
        { rect: [72, 616, 232, 632], uri: LINK_EXTERNAL_URL },
        { rect: [72, 576, 200, 592], uri: 'javascript:alert(1)' },
        { rect: [72, 536, 236, 552], uri: 'mailto:someone@example.org' },
        {
          rect: [72, 442, 180, 472],
          quads: [
            [72, 456, 180, 472],
            [72, 442, 160, 458],
          ],
          uri: 'https://example.org/wrapped',
        },
      ],
    },
    {
      texts: [
        line(720, 'Second page heading'),
        line(592, GLOSSARY_HEADING),
        line(560, 'Back to the first page'),
      ],
      links: [{ rect: [72, 556, 200, 572], goTo: 1 }],
    },
    { texts: [line(720, 'Third page heading'), line(692, PAGE_THREE_HEADING)] },
    { texts: [line(720, 'Fourth page heading'), line(692, 'Filler text on the last page.')] },
  ];
  return Buffer.from(buildPdf(pages, { title, namedDests: { glossary: { page: 2, fromTop: 200 } } }));
}

/** One page with /Rotate 90 and a link over the first words of its (sideways-written) line. */
export const ROTATED_LINK_TEXT = 'Rotated page text with a link on its first words';
export function linkedRotatedDoc(): Buffer {
  return Buffer.from(
    buildPdf(
      [
        {
          rotate: 90,
          texts: [{ x: 120, y: 72, text: ROTATED_LINK_TEXT, angle: 90 }],
          links: [{ rect: [108, 72, 128, 230], uri: 'https://example.org/rotated' }],
        },
      ],
      { title: 'Rotated link' },
    ),
  );
}

/**
 * A page of 45 links (more than the reader puts in the tab order), 5 per row, laid out in a grid; the
 * even ones go to page 2, the odd ones are https addresses. Page 2 is the target.
 */
export const DENSE_LINK_COUNT = 45;
export function denseLinksDoc(): Buffer {
  const links = Array.from({ length: DENSE_LINK_COUNT }, (_, i) => {
    const x = 72 + (i % 5) * 100;
    const y = 700 - Math.floor(i / 5) * 40;
    return {
      rect: [x, y - 4, x + 60, y + 12] as [number, number, number, number],
      ...(i % 2 === 0 ? { goTo: 2 } : { uri: `https://example.org/item-${i + 1}` }),
    };
  });
  const texts = links.map((l, i) => ({ x: l.rect[0], y: l.rect[1] + 4, text: `Item ${i + 1}` }));
  return Buffer.from(
    buildPdf([{ texts, links }, ...proseFixture(1)], { title: 'Many links' }),
  );
}
