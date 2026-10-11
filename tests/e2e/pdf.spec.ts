import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { pdfReaderPath } from '@pdf/readerUrl';
import {
  PROSE_TITLE,
  lockedDoc,
  outlinedDoc,
  partlyScannedDoc,
  REPEATED_SENTENCE,
  proseDoc,
  repeatedDoc,
  rotatedDoc,
  scannedDoc,
  scannedPages,
  twoColumnDoc,
  wrappedDoc,
} from '../fixtures/pdf/docs';
import { startPdfServer, type PdfServer } from '../fixtures/pdf/server';
import { expect, patchSettings, test, type Env } from './helpers.pages';

/**
 * The PDF reader (ADR-006) in real Chromium with the real built extension: open, render, select,
 * save, restore, zoom/rotate, search, passwords, scanned pages and local OCR, web open and its
 * failures, navigation pane, stored copies, accessibility.
 *
 * Harness limits (observed, not assumed):
 *  - The e2e build holds loopback host permissions, so a `?src=` address on 127.0.0.1 needs no
 *    native permission prompt (which Playwright cannot click). The prompt path is covered by unit
 *    tests of the open panel, not here.
 *  - The native context menu cannot be clicked. The menu's address logic is unit-tested
 *    (entrypoints/background/pdf.test.ts); here the registration is checked in the real browser and
 *    the reader is opened with the exact address the menu handler builds.
 *  - The real OCR runs are their own tests with long timeouts (WebAssembly engine + language data).
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const OCR_TIMEOUT = 180_000;

interface Reader {
  page: Page;
  /** Uncaught exceptions and console errors seen since the page opened. */
  errors: string[];
}

async function openReader(env: Env, query = ''): Promise<Reader> {
  const page = await env.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  await page.goto(`chrome-extension://${env.extensionId}/pdf-reader.html${query}`);
  await expect(page.getByTestId('pdf-reader')).toBeVisible();
  return { page, errors };
}

/** Choose a file through the real file chooser behind "Choose a PDF file". */
async function chooseFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('pdf-choose-file').click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: bytes });
}

async function openDocument(env: Env, name: string, bytes: Buffer, query = ''): Promise<Reader> {
  const reader = await openReader(env, query);
  await chooseFile(reader.page, name, bytes);
  await expect(reader.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
  return reader;
}

/** Wait until a page has its text layer (the page is drawn and its text is selectable). */
async function textOnPage(page: Page, pageNumber: number): Promise<string> {
  const layer = page.locator(`[data-testid="pdf-page-${pageNumber}"] .sv-textlayer`);
  await expect(layer).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(async () => ((await layer.textContent()) ?? '').trim().length)
    .toBeGreaterThan(0);
  return (await layer.textContent()) ?? '';
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Screen box of `text` as laid out in the text layer of a page. `occurrence` picks the n-th span that
 * contains it (0-based); without it the box covers every span that does.
 */
async function textBox(
  page: Page,
  pageNumber: number,
  text: string,
  occurrence?: number,
): Promise<Box> {
  const box = await page.evaluate(
    ({ pageNumber, text, occurrence }) => {
      const spans = [
        ...document.querySelectorAll(`[data-testid="pdf-page-${pageNumber}"] .sv-textlayer span`),
      ] as HTMLElement[];
      const rects: DOMRect[] = [];
      let seen = 0;
      for (const span of spans) {
        const node = span.firstChild;
        const at = (span.textContent ?? '').indexOf(text);
        if (!node || node.nodeType !== 3 || at < 0) continue;
        if (occurrence === undefined || occurrence === seen) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          rects.push(range.getBoundingClientRect());
        }
        seen += 1;
      }
      if (rects.length === 0) return null;
      const x0 = Math.min(...rects.map((r) => r.left));
      const y0 = Math.min(...rects.map((r) => r.top));
      const x1 = Math.max(...rects.map((r) => r.right));
      const y1 = Math.max(...rects.map((r) => r.bottom));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    },
    { pageNumber, text, occurrence },
  );
  if (!box) throw new Error(`"${text}" is not in the text layer of page ${pageNumber}`);
  return box;
}

function unionOf(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  return {
    x: x0,
    y: y0,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x0,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y0,
  };
}

/** Boxes of two passages once they have stopped moving (a pane opened, a zoom or resize redraw). */
async function settledBoxes(
  page: Page,
  pageNumber: number,
  from: string,
  to: string,
): Promise<[Box, Box]> {
  let a = await textBox(page, pageNumber, from);
  let b = await textBox(page, pageNumber, to);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const a2 = await textBox(page, pageNumber, from);
    const b2 = await textBox(page, pageNumber, to);
    const still =
      Math.abs(a2.x - a.x) + Math.abs(a2.y - a.y) + Math.abs(b2.x - b.x) + Math.abs(b2.y - b.y) < 1;
    a = a2;
    b = b2;
    if (still) break;
  }
  return [a, b];
}

/** Drag-select from the start of `from` to the end of `to` with the real mouse (horizontal text). */
async function dragSelect(page: Page, pageNumber: number, from: string, to: string): Promise<void> {
  const [a, b] = await settledBoxes(page, pageNumber, from, to);
  await page.mouse.move(a.x + 1, a.y + a.h / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.w - 1, b.y + b.h / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId('pdf-savebar')).toBeVisible();
}

/**
 * Starts recording what the browser really delivers (pointer, mouse, drag, focus and selection
 * events with their button state), and returns a function that prints it. For failures that depend on
 * the order of those events: the report then says what happened instead of guessing.
 */
async function recordInput(page: Page): Promise<() => Promise<string>> {
  await page.evaluate(() => {
    const w = window as unknown as { __svInput?: string[] };
    const log: string[] = (w.__svInput = []);
    const t0 = performance.now();
    const name = (t: EventTarget | null): string =>
      t === window
        ? 'window'
        : t === document
          ? 'document'
          : `${(t as Element | null)?.tagName ?? '?'}.${(t as Element | null)?.className ?? ''}`;
    const types = [
      'pointerdown',
      'pointerup',
      'pointercancel',
      'pointermove',
      'mousedown',
      'mouseup',
      'mousemove',
      'dragstart',
      'dragend',
      'selectionchange',
      'blur',
      'focus',
    ];
    for (const type of types) {
      window.addEventListener(
        type,
        (e) => {
          if (type === 'mousemove') return; // the pointermove next to it says the same
          const m = e as MouseEvent;
          const state = 'buttons' in e ? ` button=${m.button} buttons=${m.buttons}` : '';
          log.push(`${Math.round(performance.now() - t0)}ms ${type} on ${name(e.target)}${state}`);
        },
        true,
      );
    }
  });
  return () =>
    page.evaluate(() =>
      ((window as unknown as { __svInput?: string[] }).__svInput ?? []).join('\n'),
    );
}

/** Select by range (for text that is not horizontal on screen). `occurrence` as in textBox. */
async function selectText(
  page: Page,
  pageNumber: number,
  from: string,
  to: string,
  occurrence = 0,
): Promise<void> {
  await page.evaluate(
    ({ pageNumber, from, to, occurrence }) => {
      const spans = [
        ...document.querySelectorAll(`[data-testid="pdf-page-${pageNumber}"] .sv-textlayer span`),
      ] as HTMLElement[];
      const pick = (needle: string) =>
        spans.filter((sp) => (sp.textContent ?? '').includes(needle))[occurrence];
      const a = pick(from);
      const b = pick(to);
      if (!a?.firstChild || !b?.firstChild) throw new Error('text not found');
      const start = (a.textContent ?? '').indexOf(from);
      const end = (b.textContent ?? '').indexOf(to) + to.length;
      document.getSelection()!.setBaseAndExtent(a.firstChild, start, b.firstChild, end);
    },
    { pageNumber, from, to, occurrence },
  );
  await expect(page.getByTestId('pdf-savebar')).toBeVisible();
}

async function saveSelection(page: Page, note = ''): Promise<void> {
  if (note) await page.getByTestId('pdf-save-note').fill(note);
  await page.getByTestId('pdf-save').click();
  await expect(page.getByTestId('pdf-savebar')).toHaveCount(0);
  await expect(page.getByTestId('pdf-highlight-card').first()).toBeVisible();
}

/** Union box of the painted highlight rectangles (of one page, or of the whole document). */
async function highlightBox(page: Page, pageNumber?: number): Promise<Box | null> {
  return page.evaluate((pageNumber) => {
    const scope =
      pageNumber === undefined
        ? document
        : document.querySelector(`[data-testid="pdf-page-${pageNumber}"]`);
    const nodes = [...(scope?.querySelectorAll('.sv-pdf-hl') ?? [])] as HTMLElement[];
    if (nodes.length === 0) return null;
    const rects = nodes.map((n) => n.getBoundingClientRect());
    const x0 = Math.min(...rects.map((r) => r.left));
    const y0 = Math.min(...rects.map((r) => r.top));
    const x1 = Math.max(...rects.map((r) => r.right));
    const y1 = Math.max(...rects.map((r) => r.bottom));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, pageNumber);
}

/**
 * Wait until the painted highlight of `pageNumber` covers the same screen box as the words it quotes
 * (each part is a substring of one text-layer span; `occurrence` as in textBox).
 */
async function expectOnWords(
  page: Page,
  pageNumber: number,
  parts: string[],
  label: string,
  occurrence?: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const hl = await highlightBox(page, pageNumber);
        if (!hl) return 'no overlay';
        const want = unionOf(
          await Promise.all(parts.map((p) => textBox(page, pageNumber, p, occurrence))),
        );
        const off = Math.max(
          Math.abs(hl.x - want.x),
          Math.abs(hl.y - want.y),
          Math.abs(hl.x + hl.w - (want.x + want.w)),
          Math.abs(hl.y + hl.h - (want.y + want.h)),
        );
        return off <= 9 ? 'aligned' : `off by ${Math.round(off)}px`;
      },
      { message: label, timeout: 15_000 },
    )
    .toBe('aligned');
}

async function storedHighlights(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('studyvault');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('highlights', 'readonly');
          const all = tx.objectStore('highlights').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result as Array<Record<string, unknown>>);
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/**
 * Page numbers that have a recognised-text row in the vault right now. This is the durable fact an
 * OCR test can wait on: a status line is a moment (a fast engine passes through "page 2" between two
 * polls, which is what failed on CI), a saved row stays.
 */
async function storedOcrPages(page: Page): Promise<number[]> {
  const rows = await storedRows<{ pageNumber: number }>(page, 'ocrPages');
  return rows.map((r) => r.pageNumber).sort((a, b) => a - b);
}

/** Every row of one vault table (empty when the database or the table does not exist yet). */
async function storedRows<T = Record<string, unknown>>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (store) => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'studyvault')) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('studyvault');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result);
    });
    try {
      if (!db.objectStoreNames.contains(store)) return [];
      return await new Promise<unknown[]>((resolve, reject) => {
        const all = db.transaction(store, 'readonly').objectStore(store).getAll();
        all.onsuccess = () => resolve(all.result as unknown[]);
        all.onerror = () => reject(all.error);
      });
    } finally {
      db.close();
    }
  }, store) as Promise<T[]>;
}

/** How much of one document the vault holds: what a private window must leave at zero. */
async function storedCounts(page: Page): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const store of ['documents', 'highlights', 'attachments', 'ocrPages']) {
    counts[store] = (await storedRows(page, store)).length;
  }
  return counts;
}

// =============================================================================================
// Open, render, lazy window
// =============================================================================================

test.describe('open and render', () => {
  test('a local file opens through the file chooser; only a window of pages holds a canvas', async ({
    env,
  }) => {
    const { page, errors } = await openReader(env);
    // The open screen says what the reader is and is not.
    await expect(page.getByTestId('pdf-open')).toContainText('does not upload it');
    await expect(page.getByTestId('pdf-builtin-note')).toContainText('built-in PDF viewer');
    await expect(page.getByTestId('pdf-builtin-note')).toContainText('Open in StudyVault reader');

    await chooseFile(page, 'renal.pdf', proseDoc(120));
    await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sv-doc__title')).toHaveText(PROSE_TITLE);
    await expect(page.getByTestId('pdf-text-status')).toHaveText('selectable text');
    expect(await textOnPage(page, 1)).toContain('Page 1 line 1: the quick brown fox');
    await expect(page.getByTestId('pdf-page-120')).toBeAttached(); // a slot per page ...

    const canvases = page.locator('canvas.sv-pdf-canvas');
    await expect.poll(() => canvases.count()).toBeLessThanOrEqual(4); // ... but a window of canvases

    // Jump far away: the window moves, it does not grow.
    await page.getByTestId('pdf-page-input').fill('100');
    await page.getByTestId('pdf-page-input').press('Enter');
    expect(await textOnPage(page, 100)).toContain('Page 100 line 1');
    await expect.poll(() => canvases.count()).toBeLessThanOrEqual(4);
    await expect(page.locator('[data-testid="pdf-page-1"] canvas')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('a damaged file and a non-PDF are refused with a reason and the open screen stays usable', async ({
    env,
  }) => {
    const { page } = await openReader(env);
    await chooseFile(page, 'broken.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog'));
    await expect(page.getByTestId('pdf-open')).toContainText('That file could not be opened');
    await expect(page.getByTestId('pdf-choose-file')).toBeVisible();

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('pdf-choose-file').click(),
    ]);
    await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await expect(page.getByTestId('pdf-open')).toContainText('is not a PDF file');
  });

  test('a password-protected PDF asks, reports a wrong password and opens with the right one', async ({
    env,
  }) => {
    const { page } = await openReader(env);
    await chooseFile(page, 'locked.pdf', lockedDoc('s3cret'));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('does not store it');
    await page.getByTestId('pdf-password').fill('wrong');
    await page.getByTestId('pdf-password').press('Enter');
    await expect(page.getByRole('alert')).toContainText('did not open the file');
    await page.getByTestId('pdf-password').fill('s3cret');
    await page.getByTestId('pdf-password').press('Enter');
    await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    expect(await textOnPage(page, 1)).toContain('Page 1 line 1');
    // Encrypted fixtures carry no title, so the reader names the document after the file.
    await expect(page.locator('.sv-doc__title')).toHaveText('locked');
  });
});

// =============================================================================================
// Selection, highlights, restore, zoom and rotation, search
// =============================================================================================

test.describe('highlights', () => {
  test('a selection across a wrapped line saves one quote, survives a reload and is painted again', async ({
    env,
  }) => {
    const bytes = wrappedDoc();
    const { page } = await openDocument(env, 'wrapped.pdf', bytes);
    await textOnPage(page, 1);

    await dragSelect(page, 1, 'glomerulus filters', 'tubule reabsorbs');
    const bar = page.getByTestId('pdf-savebar');
    // The quote crosses the wrap and reads as one sentence.
    await expect(bar).toContainText(
      'glomerulus filters plasma at a steady rate and the tubule reabsorbs',
    );
    await saveSelection(page, 'wraps over two lines');

    const card = page.getByTestId('pdf-highlight-card').first();
    await expect(card).toContainText('glomerulus filters plasma');
    await expect(page.getByTestId('pdf-card-page').first()).toHaveText('p. 1');
    await expect(page.locator('.sv-pdf-hl').first()).toBeAttached();
    const rows = await storedHighlights(page);
    expect(rows).toHaveLength(1);
    const stored = rows[0] as {
      exactQuote: string;
      anchorSet: { type: string; contentSignature: string; rects: unknown[] };
    };
    expect(stored.exactQuote.startsWith('glomerulus filters plasma')).toBe(true);
    expect(stored.exactQuote.endsWith('tubule reabsorbs')).toBe(true);
    expect(stored.anchorSet.type).toBe('pdf');
    expect(stored.anchorSet.contentSignature.startsWith('ocr1:')).toBe(false);
    expect(stored.anchorSet.rects.length).toBeGreaterThanOrEqual(2); // one rect per visual line

    // Reload: the reader forgets the file (nothing was kept), choosing it again re-attaches.
    await page.reload();
    await expect(page.getByTestId('pdf-open')).toBeVisible();
    await chooseFile(page, 'wrapped.pdf', bytes);
    await expect(page.locator('.sv-pdf-hl').first()).toBeAttached({ timeout: 30_000 });
    await expect(page.getByTestId('pdf-highlight-card')).toHaveCount(1);
    await expect(page.getByTestId('pdf-highlight-card').first()).toContainText('Found on page');
    await expect(page.getByLabel('Note').first()).toHaveValue('wraps over two lines');
  });

  test('the save bar waits for the button to be released, so a drag never runs on into it', async ({
    env,
  }) => {
    const { page } = await openDocument(env, 'wrapped.pdf', wrappedDoc());
    await textOnPage(page, 1);
    // The bar used to appear 80 ms into a drag and, placed over the selection, swallowed the rest of
    // the drag: the quote then ran through the bar's own text into the next page (seen on CI).
    await page.setViewportSize({ width: 1280, height: 480 });
    const [from, to] = await settledBoxes(page, 1, 'glomerulus filters', 'tubule reabsorbs');
    const sentInput = await recordInput(page);
    await page.mouse.move(from.x + 1, from.y + from.h / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.w - 1, to.y + to.h / 2, { steps: 12 });
    // The drag has selected the text ...
    await expect
      .poll(async () => page.evaluate(() => document.getSelection()?.toString() ?? ''))
      .toContain('tubule reabsorbs');
    // Browsers also report moves with no button down, and focus changes, in the middle of a drag
    // (after a layout change, an auto-scroll): none of that is a release.
    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointermove', { buttons: 0, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { buttons: 0, bubbles: true }));
      window.dispatchEvent(new Event('blur'));
    });
    await page.waitForTimeout(300); // ... well past the 80 ms a selection takes to be evaluated
    // ... and the button is still down: the page knows a drag is on, and there is no bar yet.
    try {
      await expect(page.locator('html')).toHaveAttribute('data-sv-drag', '', { timeout: 2_000 });
      await expect(page.getByTestId('pdf-savebar')).toHaveCount(0, { timeout: 2_000 });
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nThe browser delivered, in order:\n${await sentInput()}`,
        { cause: err },
      );
    }
    await page.mouse.up();

    const bar = page.getByTestId('pdf-savebar');
    await expect(bar).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-sv-drag', '');
    await expect(bar.locator('blockquote')).toHaveText(
      'glomerulus filters plasma at a steady rate and the tubule reabsorbs',
    );
    await saveSelection(page);
    expect(await storedHighlights(page)).toHaveLength(1);
  });

  test('the overlay stays on its words through zoom and rotation', async ({ env }) => {
    const { page } = await openDocument(env, 'wrapped.pdf', wrappedDoc());
    await textOnPage(page, 1);
    await dragSelect(page, 1, 'glomerulus filters', 'tubule reabsorbs');
    await saveSelection(page);
    await expect(page.locator('.sv-pdf-hl').first()).toBeAttached();

    const quote = ['glomerulus filters plasma at a steady rate and the', 'tubule reabsorbs'];
    const aligned = (label: string) => expectOnWords(page, 1, quote, label);

    await aligned('at fit width');
    for (const zoom of ['0.75', '2']) {
      await page.getByTestId('pdf-zoom').selectOption(zoom);
      await aligned(`at zoom ${zoom}`);
    }
    await page.getByTestId('pdf-zoom').selectOption('1');
    for (const turns of [1, 2, 3]) {
      await page.getByTestId('pdf-rotate').click();
      await aligned(`after ${turns} rotation(s)`);
    }
    // The stored anchor does not depend on the display: one highlight, same rects.
    expect(await storedHighlights(page)).toHaveLength(1);
  });

  test('search finds text across pages, counts, steps and marks matches', async ({ env }) => {
    const { page } = await openDocument(env, 'renal.pdf', proseDoc(8));
    await textOnPage(page, 1);
    await page.getByTestId('pdf-search').fill('lazy dog');
    await expect(page.getByTestId('pdf-find-count')).toHaveText(/^1 of 48$/, { timeout: 30_000 });
    await expect(page.locator('.sv-pdf-find').first()).toBeAttached();
    await page.getByTestId('pdf-search').press('Enter');
    await expect(page.getByTestId('pdf-find-count')).toHaveText('2 of 48');
    await page.getByTestId('pdf-search').fill('zzzz');
    await expect(page.getByTestId('pdf-find-count')).toHaveText('No matches', { timeout: 30_000 });
  });

  test('a highlight can be deleted and the deletion undone', async ({ env }) => {
    const { page } = await openDocument(env, 'wrapped.pdf', wrappedDoc());
    await textOnPage(page, 1);
    await dragSelect(page, 1, 'Unrelated closing', 'loop of Henle');
    await saveSelection(page);
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('pdf-highlight-card')).toHaveCount(0);
    // Two toasts can be on screen (the save and the deletion): undo the deletion.
    await page.getByRole('button', { name: 'Undo', description: 'Highlight deleted.' }).click();
    await expect(page.getByTestId('pdf-highlight-card')).toHaveCount(1);
  });
});

// =============================================================================================
// Compatibility fixtures: columns, rotation, repeated passages
// =============================================================================================

test.describe('compatibility fixtures', () => {
  test('a drag inside one column of a two-column page saves that column only', async ({ env }) => {
    const { page } = await openDocument(env, 'columns.pdf', twoColumnDoc());
    await textOnPage(page, 1);
    await dragSelect(page, 1, 'left column row 2', 'left column row 4 about glomerular filtration');
    const bar = page.getByTestId('pdf-savebar');
    await expect(bar).toContainText('left column row 3 about glomerular filtration');
    await expect(bar).not.toContainText('right column');
    await saveSelection(page);
    const quote = ((await storedHighlights(page))[0] as { exactQuote: string }).exactQuote;
    expect(quote.startsWith('left column row 2')).toBe(true);
    expect(quote).not.toContain('right column');
    // The reading order is column by column: row 8 of the left column precedes row 1 of the right.
    await page.getByTestId('pdf-search').fill('column row');
    await expect(page.getByTestId('pdf-find-count')).toHaveText(/^1 of 16$/, { timeout: 30_000 });
  });

  test('a page with /Rotate 90 and a landscape page keep highlights on their words', async ({
    env,
  }) => {
    const { page } = await openDocument(env, 'rotated.pdf', rotatedDoc());
    await textOnPage(page, 1);
    await selectText(page, 1, 'First line of the rotated page', 'Second line of the rotated page');
    await expect(page.getByTestId('pdf-savebar')).toContainText(
      'First line of the rotated page Second line of the rotated page',
    );
    await saveSelection(page);
    const parts = ['First line of the rotated page', 'Second line of the rotated page'];
    await expectOnWords(page, 1, parts, 'rotated page at fit width');
    await page.getByTestId('pdf-rotate').click();
    await expectOnWords(page, 1, parts, 'rotated page after a quarter turn');
    await page.getByTestId('pdf-zoom').selectOption('2');
    await expectOnWords(page, 1, parts, 'rotated page at 200%');
    await page.getByTestId('pdf-zoom').selectOption('1');
    await page.getByTestId('pdf-rotate').click();
    await page.getByTestId('pdf-rotate').click();
    await page.getByTestId('pdf-rotate').click();

    // The landscape page (page 2).
    await page.getByTestId('pdf-page-input').fill('2');
    await page.getByTestId('pdf-page-input').press('Enter');
    await textOnPage(page, 2);
    await dragSelect(page, 2, 'Landscape page first', 'second line of text');
    await saveSelection(page);
    await expectOnWords(
      page,
      2,
      ['Landscape page first line of text', 'Landscape page second line of text'],
      'landscape page',
    );
    expect(await storedHighlights(page)).toHaveLength(2);
  });

  test('the second of two identical sentences keeps its own place across a reload', async ({
    env,
  }) => {
    const bytes = repeatedDoc();
    const { page } = await openDocument(env, 'repeated.pdf', bytes);
    await textOnPage(page, 1);
    await selectText(page, 1, REPEATED_SENTENCE, REPEATED_SENTENCE, 1);
    await saveSelection(page);
    await expectOnWords(page, 1, [REPEATED_SENTENCE], 'second occurrence', 1);

    await page.reload();
    await chooseFile(page, 'repeated.pdf', bytes);
    await textOnPage(page, 1);
    await expect(page.locator('.sv-pdf-hl').first()).toBeAttached({ timeout: 30_000 });
    await expect(page.getByTestId('pdf-highlight-card').first()).toContainText('Found on page');
    // Painted on the second sentence only, not on the first one that reads the same.
    await expectOnWords(page, 1, [REPEATED_SENTENCE], 'second occurrence after reopening', 1);
    const first = await textBox(page, 1, REPEATED_SENTENCE, 0);
    const painted = (await highlightBox(page, 1))!;
    expect(painted.y).toBeGreaterThan(first.y + first.h);
  });
});

// =============================================================================================
// Navigation pane, heading context, properties, stored copies
// =============================================================================================

test.describe('navigation and documents', () => {
  test('outline and lazy thumbnails navigate; a highlight records the heading it sits under', async ({
    env,
  }) => {
    const { page } = await openDocument(env, 'outlined.pdf', outlinedDoc());
    await textOnPage(page, 1);
    // Opening a pane narrows the pages (fit width): the reader stays on the page they were reading.
    await page.getByTestId('pdf-page-input').fill('5');
    await page.getByTestId('pdf-page-input').press('Enter');
    await textOnPage(page, 5);
    await page.getByTestId('pdf-toggle-sidepane').click();
    await page.waitForTimeout(600); // the size is re-measured after a short pause
    await expect(page.getByTestId('pdf-page-input')).toHaveValue('5');
    const outline = page.getByTestId('pdf-outline');
    await expect(outline).toContainText('Chapter one: filtration');
    await expect(outline).toContainText('Section 1.2 Bowman capsule');

    await outline.getByRole('button', { name: /Chapter two: transport/ }).click();
    await expect(page.getByTestId('pdf-page-input')).toHaveValue('7');
    await expect(outline.getByRole('button', { name: /Chapter two: transport/ })).toHaveAttribute(
      'aria-current',
      'location',
    );

    await page.getByRole('tab', { name: 'Pages' }).click();
    const thumbs = page.getByTestId('pdf-thumbs').getByRole('button');
    await expect(thumbs).toHaveCount(12);
    // Thumbnails are drawn lazily: the visible ones have pixels, the whole list is not rendered.
    await expect
      .poll(() =>
        page
          .locator('.sv-thumb canvas')
          .evaluateAll((cs) => cs.filter((c) => (c as HTMLCanvasElement).width > 0).length),
      )
      .toBeGreaterThan(0);
    await thumbs.nth(4).click();
    await expect(page.getByTestId('pdf-page-input')).toHaveValue('5');

    // A highlight on page 5 sits under "Section 1.2 Bowman capsule" (page 4).
    await textOnPage(page, 5);
    await dragSelect(page, 5, 'Page 5 line 2', 'Page 5 line 3');
    await saveSelection(page);
    await expect(page.getByTestId('pdf-card-heading').first()).toContainText(
      'Section 1.2 Bowman capsule',
    );
    const rows = await storedHighlights(page);
    expect((rows[0] as { headingContext: string }).headingContext).toBe(
      'Section 1.2 Bowman capsule',
    );
  });

  test('properties show the file facts; a kept copy has a size, is listed, reopens and is removed', async ({
    env,
  }) => {
    const { page } = await openDocument(env, 'renal.pdf', proseDoc(5));
    await textOnPage(page, 1);
    const props = page.getByTestId('pdf-props');
    await props.locator('summary').click();
    await expect(props).toContainText('Renal physiology');
    await expect(props).toContainText('5'); // pages
    await expect(props).toContainText('A file on this device');
    await expect(props).toContainText('first 12 digits of the SHA-256');
    await expect(page.getByTestId('pdf-props-copy')).toContainText('None');

    await page.getByTestId('pdf-keep-copy').click();
    await expect(page.getByTestId('pdf-props-copy')).toContainText('Kept on this device');
    await expect(page.getByTestId('pdf-remove-copy')).toContainText('KB');

    // The open screen lists it with its size and reopens it without choosing a file.
    await page.getByRole('button', { name: 'Open another PDF' }).click();
    const copies = page.getByTestId('pdf-copies');
    await expect(copies).toBeVisible();
    await expect(page.getByTestId('pdf-copy')).toHaveCount(1);
    await expect(page.getByTestId('pdf-copy')).toContainText('Renal physiology');
    await page.getByTestId('pdf-copy').getByRole('button', { name: 'Open' }).click();
    await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    expect(await textOnPage(page, 1)).toContain('Page 1 line 1');

    await page.getByRole('button', { name: 'Open another PDF' }).click();
    await page.getByTestId('pdf-copy').getByRole('button', { name: 'Remove copy' }).click();
    await expect(page.getByTestId('pdf-copies-empty')).toBeVisible();
  });
});

// =============================================================================================
// Scanned pages and local OCR
// =============================================================================================

test.describe('scanned pages and OCR', () => {
  // The recognition engine (wasm + language data) is the heaviest thing the suite loads: these run
  // one after another in one worker, each with its own bounded timeout.
  test.describe.configure({ mode: 'serial' });

  test('a scanned document says so, and OCR is offered with its on-device promise', async ({
    env,
  }) => {
    const { page } = await openDocument(env, 'mixed.pdf', partlyScannedDoc());
    await textOnPage(page, 1);
    await expect(page.getByTestId('pdf-text-status')).toHaveText('partly scanned', {
      timeout: 30_000,
    });
    // Page 2 is the picture: scroll to it so its verdict is learned.
    await page.getByTestId('pdf-page-input').fill('2');
    await page.getByTestId('pdf-page-input').press('Enter');
    await expect(page.getByTestId('pdf-page-2')).toContainText('No selectable text');
    const banner = page.getByText('Some pages of this PDF have no selectable text');
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('pdf-ocr')).toBeEnabled();
    await expect(page.getByTestId('pdf-ocr-this-page')).toBeEnabled();
    await expect(page.getByText('nothing is uploaded, and it works offline')).toBeVisible();
    // The "Page text" tab offers the same action for the page in view.
    await page.getByRole('tab', { name: 'Page text' }).click();
    await expect(page.getByTestId('pdf-ocr-page')).toBeVisible();
  });

  test('OCR recognises a scanned page on this device; the text is selectable, anchored, correctable and persists', async ({
    env,
  }) => {
    test.setTimeout(OCR_TIMEOUT);
    const scratch = await env.context.newPage();
    const bytes = await scannedDoc(scratch, [
      'The mitochondria is the powerhouse',
      'of the cell and makes ATP',
    ]);
    await scratch.close();
    const { page, errors } = await openDocument(env, 'scan.pdf', bytes);
    await expect(page.getByTestId('pdf-text-status')).toHaveText('scanned (no text)', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('pdf-ocr')).toBeEnabled();

    await page.getByTestId('pdf-ocr').click();
    // Per-page progress is real: a status line and a cancel button while it runs.
    await expect(page.getByTestId('pdf-ocr-status')).toBeVisible();
    await expect(page.getByTestId('pdf-ocr-cancel')).toBeVisible();
    await expect(page.getByTestId('pdf-ocr-outcome')).toContainText('machine-recognised', {
      timeout: OCR_TIMEOUT - 30_000,
    });
    await expect(page.getByText('Recognised 1 page')).toBeVisible();

    // The words are real, selectable text in the page's text layer.
    await expect
      .poll(async () => (await textOnPage(page, 1)).toLowerCase(), { timeout: 30_000 })
      .toContain('mitochondria');
    await expect(page.getByTestId('pdf-text-status')).toContainText('scanned');
    await expect(page.getByTestId('pdf-ocr')).toHaveCount(0); // nothing is left to recognise

    // A highlight on OCR text is anchored in the OCR stream and says so.
    await dragSelect(page, 1, 'mitochondria', 'powerhouse');
    await expect(page.getByTestId('pdf-save-ocr-note')).toContainText(
      'recognised from a scanned image',
    );
    // Copying recognised text keeps the spaces between its words.
    const copied = await page.evaluate(() => document.getSelection()?.toString() ?? '');
    expect(copied.replace(/\s+/g, ' ')).toMatch(/mitochondria \w+/i);
    await saveSelection(page);
    const card = page.getByTestId('pdf-highlight-card').first();
    await expect(card).toContainText('OCR text');
    const rows = await storedHighlights(page);
    expect(rows).toHaveLength(1);
    const anchor = (rows[0] as { anchorSet: { contentSignature: string }; exactQuote: string })
      .anchorSet;
    expect(anchor.contentSignature.startsWith('ocr1:')).toBe(true);
    const quote = (rows[0] as { exactQuote: string }).exactQuote;
    expect(quote.toLowerCase()).toContain('mitochondria');

    // Correction UI: confidence in words, per-line edit, revert; the saved quote never changes.
    await page.getByRole('tab', { name: 'Page text' }).click();
    const panel = page.getByTestId('pdf-ocr-panel');
    await expect(panel).toContainText('Machine-recognised text');
    await expect(page.getByTestId('pdf-ocr-legend')).toContainText('Low confidence (under 60%)');
    await expect(page.getByTestId('pdf-ocr-line-text').first()).toContainText(/mitochondria/i);
    await page.getByTestId('pdf-ocr-edit').first().click();
    await page.getByTestId('pdf-ocr-input').fill('The nucleus is the control centre');
    await page.getByTestId('pdf-ocr-line-save').click();
    await expect(page.getByTestId('pdf-ocr-recognised').first()).toContainText(/mitochondria/i);
    await expect(panel.getByText('Edited')).toBeVisible();
    await expect.poll(async () => (await textOnPage(page, 1)).toLowerCase()).toContain('nucleus');

    const after = await storedHighlights(page);
    expect((after[0] as { exactQuote: string }).exactQuote).toBe(quote); // immutable
    // The old highlight is not silently re-bound to other words.
    await page.getByRole('tab', { name: /Highlights/ }).click();
    await expect(page.getByTestId('pdf-highlight-card')).toHaveCount(1);

    // Persistence: reload, choose the same file again; no recognition runs, the text is back.
    await page.reload();
    await chooseFile(page, 'scan.pdf', bytes);
    await expect.poll(async () => (await textOnPage(page, 1)).toLowerCase()).toContain('nucleus');
    await expect(page.getByTestId('pdf-ocr-status')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Page text' }).click();
    await expect(page.getByText('Edited')).toBeVisible();
    await page.getByTestId('pdf-ocr-revert-line').first().click();
    await expect
      .poll(async () => (await textOnPage(page, 1)).toLowerCase())
      .toContain('mitochondria');
    expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
  });

  test('cancel stops text recognition for real and the action can be started again', async ({
    env,
  }) => {
    test.setTimeout(OCR_TIMEOUT);
    const scratch = await env.context.newPage();
    const bytes = await scannedDoc(scratch, ['Cancel this run before it finishes']);
    await scratch.close();
    const { page } = await openDocument(env, 'scan.pdf', bytes);
    await expect(page.getByTestId('pdf-ocr')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('pdf-ocr').click();
    await expect(page.getByTestId('pdf-ocr-cancel')).toBeVisible();
    await page.getByTestId('pdf-ocr-cancel').click();
    await expect(page.getByTestId('pdf-ocr-outcome')).toContainText(
      /nothing was recognised|were kept|was kept/i,
      { timeout: 60_000 },
    );
    await expect(page.getByText('Text recognition cancelled')).toBeVisible();
    await expect(page.getByTestId('pdf-ocr-cancel')).toHaveCount(0);
    expect(await textOnPage(page, 1).catch(() => '')).not.toContain('Cancel');
    // Not stuck: the document can be recognised afterwards.
    await expect(page.getByTestId('pdf-ocr')).toBeEnabled();
  });
});

test.describe('OCR resume', () => {
  // The recognition engine is fast on a CI runner (about a second a page), so "cancel when the status
  // line says page 2" is a race it loses. Instead: a document of several pages, a wait on the durable
  // fact (page 1 is a saved row), a cancel straight after it with pages still to do, and every count
  // below is read from the vault rather than assumed.
  test.describe.configure({ mode: 'serial', timeout: OCR_TIMEOUT });

  const ORGANS = ['nephron', 'glomerulus', 'tubule', 'ureter', 'bladder', 'urethra'];
  const PAGE_COUNT = ORGANS.length;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

  test('a cancelled run keeps the pages it finished and resumes with the rest after a reload', async ({
    env,
  }) => {
    const scratch = await env.context.newPage();
    const bytes = await scannedPages(
      scratch,
      ORGANS.map((organ, i) => [
        `Scanned page ${i + 1} names the ${organ}`,
        'Machine recognition is checked',
        'before it is relied upon',
      ]),
    );
    await scratch.close();
    const { page } = await openDocument(env, 'six-scans.pdf', bytes);
    await expect(page.getByTestId('pdf-ocr')).toBeEnabled({ timeout: 30_000 });
    expect(await storedOcrPages(page)).toEqual([]);

    await page.getByTestId('pdf-ocr').click();
    // Wait on the saved row, not on a status line: cancel as soon as page 1 is kept, with pages left.
    await expect
      .poll(async () => (await storedOcrPages(page)).length, {
        message: 'the first page is saved',
        timeout: OCR_TIMEOUT - 60_000,
        intervals: [50, 100, 200],
      })
      .toBeGreaterThan(0);
    await page.getByTestId('pdf-ocr-cancel').click({ timeout: 10_000 });
    await expect(page.getByText('Text recognition cancelled')).toBeVisible({ timeout: 60_000 });

    const kept = (await storedOcrPages(page)).length;
    expect(kept, 'the run was stopped part-way, not after it had finished').toBeGreaterThan(0);
    expect(kept, 'the run was stopped part-way, not after it had finished').toBeLessThan(
      PAGE_COUNT,
    );
    await expect(page.getByTestId('pdf-ocr-outcome')).toContainText(
      `${plural(kept, 'page')} recognised so far ${kept === 1 ? 'was' : 'were'} kept`,
    );
    await expect.poll(async () => (await textOnPage(page, 1)).toLowerCase()).toContain('nephron');

    // Reload and choose the same file: the kept pages are back without recognising them again, and
    // the run that follows recognises exactly the pages that were left.
    await page.reload();
    await chooseFile(page, 'six-scans.pdf', bytes);
    await expect.poll(async () => (await textOnPage(page, 1)).toLowerCase()).toContain('nephron');
    await expect(page.getByTestId('pdf-ocr')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('pdf-ocr').click();
    await expect(
      page.getByText(`Recognised ${plural(PAGE_COUNT - kept, 'page')}`, { exact: true }),
    ).toBeVisible({ timeout: OCR_TIMEOUT - 60_000 });
    expect(await storedOcrPages(page)).toEqual(Array.from({ length: PAGE_COUNT }, (_, i) => i + 1));

    await page.getByTestId('pdf-page-input').fill(String(PAGE_COUNT));
    await page.getByTestId('pdf-page-input').press('Enter');
    await expect
      .poll(async () => (await textOnPage(page, PAGE_COUNT)).toLowerCase(), { timeout: 30_000 })
      .toContain('urethra');
    await expect(page.getByTestId('pdf-ocr')).toHaveCount(0); // nothing left to recognise
  });
});

// =============================================================================================
// Web open: success and every failure mode
// =============================================================================================

test.describe('web open', () => {
  let server: PdfServer;
  const login = '<!doctype html><title>Sign in</title><form>Please sign in</form>';

  test.beforeEach(async () => {
    server = await startPdfServer({
      '/docs/renal.pdf': { body: proseDoc(3, 'From the web') },
      '/docs/download': { body: proseDoc(2, 'No extension') }, // application/pdf without .pdf
      '/docs/short': { status: 302, type: null, headers: { location: '/docs/download' } },
      '/docs/private.pdf': { status: 401, type: 'text/html', body: login },
      '/docs/forbidden.pdf': { status: 403, type: 'text/html', body: login },
      '/docs/soft-login.pdf': { type: 'text/html; charset=utf-8', body: login },
      '/docs/redirect.pdf': { status: 302, type: null, headers: { location: '/login.html' } },
      '/login.html': { type: 'text/html; charset=utf-8', body: login },
      '/docs/missing.pdf': { status: 404, type: 'text/html', body: 'gone' },
      '/docs/octet.pdf': { type: 'application/octet-stream', body: proseDoc(1, 'Octet stream') },
      '/docs/lies.pdf': { type: 'application/pdf', body: 'this is not a pdf at all' },
    });
  });
  test.afterEach(async () => {
    await server.close();
  });

  const reader = (env: Env, path: string) =>
    openReader(env, `?src=${encodeURIComponent(`${server.origin}${path}`)}`);

  test('opens a PDF from an address: no cookies, no referrer, no CSP error; the content type decides', async ({
    env,
  }) => {
    await env.context.addCookies([{ name: 'sid', value: 'top-secret', url: server.origin }]);
    const { page, errors } = await reader(env, '/docs/renal.pdf');
    await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sv-doc__title')).toHaveText('From the web');
    expect(await textOnPage(page, 1)).toContain('Page 1 line 1');
    await expect(page.locator('.sv-doc__head')).toContainText('from 127.0.0.1');

    const hits = server.requests.filter((r) => r.path === '/docs/renal.pdf');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.headers.cookie, 'cookies are never sent').toBeUndefined();
      expect(hit.headers.referer, 'no referrer').toBeUndefined();
      expect(hit.headers.authorization).toBeUndefined();
    }
    // The fetch must not need a CSP exemption it does not have.
    expect(errors.filter((e) => /Content Security Policy|violates/i.test(e))).toEqual([]);

    // application/pdf without a .pdf name, and octet-stream with a PDF header, open too.
    const noExtension = await reader(env, '/docs/download');
    await expect(noExtension.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(noExtension.page.locator('.sv-doc__title')).toHaveText('No extension');
    // ... and so does a redirected address that ends at one.
    const redirected = await reader(env, '/docs/short');
    await expect(redirected.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(redirected.page.locator('.sv-doc__title')).toHaveText('No extension');
    const octet = await reader(env, '/docs/octet.pdf');
    await expect(octet.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
  });

  test('every failure says what happened, offers no way around it, and keeps the manual file fallback', async ({
    env,
  }) => {
    const cases = [
      ['/docs/private.pdf', /asked for a sign-in \(HTTP 401\)/, false],
      ['/docs/forbidden.pdf', /asked for a sign-in \(HTTP 403\)/, false],
      ['/docs/soft-login.pdf', /web page \(text\/html\) instead of a PDF/, false],
      ['/docs/redirect.pdf', /redirected to 127\.0\.0\.1.*sign-in page/, false],
      ['/docs/missing.pdf', /No file exists at that address any more \(HTTP 404\)/, false],
      ['/docs/lies.pdf', /did not return a PDF file/, false],
    ] as const;
    for (const [path, message, retry] of cases) {
      await test.step(path, async () => {
        const { page } = await reader(env, path);
        const web = page.getByTestId('pdf-web');
        await expect(web).toContainText('The PDF could not be downloaded', { timeout: 30_000 });
        await expect(web.getByRole('alert')).toContainText(message);
        await expect(page.getByTestId('pdf-viewer')).toHaveCount(0);
        await expect(page.getByTestId('pdf-choose-file')).toBeVisible();
        await expect(web.getByRole('button', { name: 'Try again' })).toHaveCount(retry ? 1 : 0);
        if (path === '/docs/private.pdf' || path === '/docs/forbidden.pdf') {
          await expect(web).toContainText('does not use your browser sign-ins');
        }
        await page.close();
      });
    }

    // The fallback works after a failure: the file downloaded by hand opens.
    const { page } = await reader(env, '/docs/private.pdf');
    await expect(page.getByTestId('pdf-web')).toContainText('asked for a sign-in', {
      timeout: 30_000,
    });
    await chooseFile(page, 'downloaded.pdf', proseDoc(2, 'Downloaded by hand'));
    await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sv-doc__title')).toHaveText('Downloaded by hand');
  });

  test('offline is reported as offline, not as a CORS problem', async ({ env }) => {
    await env.context.setOffline(true);
    try {
      const { page } = await reader(env, '/docs/renal.pdf');
      await expect(page.getByTestId('pdf-web')).toContainText('appears to be offline', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('pdf-choose-file')).toBeVisible();
    } finally {
      await env.context.setOffline(false);
    }
  });

  test('addresses the reader refuses are explained and never fetched', async ({ env }) => {
    for (const src of [
      'http://example.org/a.pdf',
      'ftp://example.org/a.pdf',
      'https://user:pw@example.org/a.pdf',
      'javascript:alert(1)',
    ]) {
      const { page } = await openReader(env, `?src=${encodeURIComponent(src)}`);
      await expect(page.getByTestId('pdf-web')).toContainText('This address cannot be opened');
      await expect(page.getByRole('button', { name: /Allow access/ })).toHaveCount(0);
      await page.close();
    }
    expect(server.requests).toHaveLength(0);
  });

  test('a redirect to another origin that is allowed opens; nothing is sent to it but the request', async ({
    env,
  }) => {
    // A second origin (another port of the loopback host the e2e build is allowed to reach).
    const other = await startPdfServer({ '/files/final.pdf': { body: proseDoc(2, 'Final stop') } });
    try {
      server.route('/docs/bounce.pdf', {
        status: 302,
        type: null,
        headers: { location: `${other.origin}/files/final.pdf` },
      });
      const { page, errors } = await reader(env, '/docs/bounce.pdf');
      await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.sv-doc__title')).toHaveText('Final stop');
      const hits = other.requests.filter((r) => r.path === '/files/final.pdf');
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of [...server.requests, ...other.requests]) {
        expect(hit.headers.cookie, 'cookies are never sent').toBeUndefined();
        expect(hit.headers.referer, 'no referrer').toBeUndefined();
      }
      expect(errors.filter((e) => /Content Security Policy|violates/i.test(e))).toEqual([]);
    } finally {
      await other.close();
    }
  });

  test('the menu opens the reader on the address its handler builds, and the menus are registered', async ({
    env,
  }) => {
    // The address "Open in StudyVault reader" opens (built by the same pure helper the worker uses).
    const target = `${server.origin}/docs/renal.pdf?v=2`;
    const path = pdfReaderPath({ src: target });
    expect(path).toBe(`pdf-reader.html?src=${encodeURIComponent(target)}`);
    const page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/${path}`);
    await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sv-doc__title')).toHaveText('From the web');

    // Both items exist in the real browser: creating them again reports a duplicate id.
    const options = await env.context.newPage();
    await options.goto(`chrome-extension://${env.extensionId}/options.html`);
    const duplicates = await options.evaluate(async () => {
      const result: Record<string, string> = {};
      for (const id of ['sv-open-pdf-link', 'sv-open-pdf-page']) {
        result[id] = await new Promise<string>((resolve) => {
          chrome.contextMenus.create({ id, title: 'probe', contexts: ['page'] }, () => {
            resolve(chrome.runtime.lastError?.message ?? 'created');
          });
        });
      }
      return result;
    });
    for (const message of Object.values(duplicates)) expect(message).toMatch(/duplicate id/i);
  });
});

// =============================================================================================
// Private windows
// =============================================================================================

test.describe('private windows', () => {
  test.fixme('in a real incognito window the reader stores nothing unless "Save from private windows" is on', () => {
    // NOT DRIVABLE in this harness (same limit as overlay.spec.ts "private windows"): Playwright's
    // persistent context is one non-incognito context, an unpacked extension is off in incognito until
    // "Allow in Incognito" is switched on at chrome://extensions, and incognito windows made with
    // chrome.windows.create({incognito:true}) are not attached to Playwright pages.
    // What IS covered: detecting the window (windows/tabs.getCurrent().incognito, never the
    // split-mode-only inIncognitoContext) by the unit tests of detectWindowPrivacy; the refusal at the
    // storage write path by packages/storage/src/pdf.private.test.ts; and everything after detection
    // in a real extension page by the next test, which opens the reader the way the context menu does
    // for a private tab (?incognito=1).
  });

  test('a reader opened from a private tab reads in memory, stores nothing, says so, and saves once allowed', async ({
    env,
  }) => {
    const bytes = wrappedDoc();
    const { page } = await openReader(env, '?incognito=1');
    // Said before anything is opened, as a status message.
    await expect(
      page.getByRole('status').filter({ hasText: 'Nothing is being saved' }),
    ).toContainText('does not save from private');

    await chooseFile(page, 'wrapped.pdf', bytes);
    await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await textOnPage(page, 1); // reading works
    await expect(
      page.getByRole('status').filter({ hasText: 'Nothing is being saved' }),
    ).toBeVisible();

    // Keeping a copy is refused with the reason (checked first: a click elsewhere drops a selection).
    const props = page.getByTestId('pdf-props').locator('summary');
    await props.click();
    await expect(page.getByTestId('pdf-keep-copy')).toHaveAttribute('aria-disabled', 'true');
    await props.click(); // closed again: the text is back where a drag can reach it
    await page.setViewportSize({ width: 1280, height: 900 });
    // Saving a highlight is refused with the reason and cannot be triggered.
    await dragSelect(page, 1, 'glomerulus filters', 'tubule reabsorbs');
    await expect(page.getByTestId('pdf-savebar')).toContainText('does not save from private');
    await expect(page.getByTestId('pdf-save')).toHaveAttribute('aria-disabled', 'true');

    // The vault holds nothing about this document: no row, highlight, copy or recognised text.
    expect(await storedCounts(page)).toEqual({
      documents: 0,
      highlights: 0,
      attachments: 0,
      ocrPages: 0,
    });

    // The person turns "Save from private windows" on: the open reader follows, no reload.
    await patchSettings(page, { allowIncognitoCapture: true });
    await expect(page.getByTestId('pdf-save')).not.toHaveAttribute('aria-disabled', 'true');
    await saveSelection(page, 'saved after consent');
    expect(await storedCounts(page)).toMatchObject({ documents: 1, highlights: 1 });

    // Turning it off again blocks the next save: the open reader follows in both directions.
    // (A selection by range: the page has scrolled and the earlier highlight now lies under the
    // pointer's path, which says nothing about this rule.)
    await patchSettings(page, { allowIncognitoCapture: false });
    await selectText(page, 1, 'tubule reabsorbs', 'filtered water');
    await expect(page.getByTestId('pdf-save')).toHaveAttribute('aria-disabled', 'true');
    expect(await storedCounts(page)).toMatchObject({ documents: 1, highlights: 1 });
  });

  test('a normal window shows no such message and keeps what it saves', async ({ env }) => {
    const { page } = await openDocument(env, 'wrapped.pdf', wrappedDoc());
    await textOnPage(page, 1);
    await expect(page.getByText('Nothing is being saved')).toHaveCount(0);
    expect(await storedCounts(page)).toMatchObject({ documents: 1, highlights: 0 });
  });
});

// =============================================================================================
// Accessibility
// =============================================================================================

test.describe('accessibility', () => {
  async function violations(page: Page): Promise<string> {
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    return results.violations
      .map(
        (v) =>
          `[${v.impact}] ${v.id}: ${v.help}\n` +
          v.nodes
            .slice(0, 3)
            .map((n) => `   ${JSON.stringify(n.target)} ${n.html.slice(0, 140)}`)
            .join('\n'),
      )
      .join('\n');
  }

  test('the open screen has no WCAG A/AA violations', async ({ env }) => {
    const { page } = await openReader(env);
    expect(await violations(page)).toBe('');
  });

  test('an open document with the navigation pane, highlights and page text tabs has none', async ({
    env,
  }) => {
    const { page } = await openDocument(env, 'outlined.pdf', outlinedDoc());
    await textOnPage(page, 1);
    await page.getByTestId('pdf-toggle-sidepane').click();
    await expect(page.getByTestId('pdf-outline')).toBeVisible();
    await dragSelect(page, 1, 'Page 1 line 1', 'Page 1 line 2');
    await saveSelection(page);
    await page.getByTestId('pdf-props').locator('summary').click();
    expect(await violations(page)).toBe('');

    await page.getByRole('tab', { name: 'Pages' }).click();
    await page.getByRole('tab', { name: 'Page text' }).click();
    expect(await violations(page)).toBe('');
  });

  test('the correction view of recognised text has none', async ({ env }) => {
    test.setTimeout(OCR_TIMEOUT);
    const scratch = await env.context.newPage();
    const bytes = await scannedDoc(scratch, ['Accessible recognised text appears here']);
    await scratch.close();
    const { page } = await openDocument(env, 'scan.pdf', bytes);
    await expect(page.getByTestId('pdf-ocr')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('pdf-ocr').click();
    await expect(page.getByText('Recognised 1 page')).toBeVisible({
      timeout: OCR_TIMEOUT - 30_000,
    });
    await page.getByRole('tab', { name: 'Page text' }).click();
    await expect(page.getByTestId('pdf-ocr-lines')).toBeVisible();
    await page.getByTestId('pdf-ocr-edit').first().click();
    expect(await violations(page)).toBe('');
  });
});
