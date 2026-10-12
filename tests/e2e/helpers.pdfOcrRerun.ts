import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { settleAnimations } from './axeSettle';
import { expect } from './helpers.pages';
import { storedOcrPages } from './helpers.pdfReal';

/**
 * Helpers for pdf-ocr-rerun.spec.ts: reading recognised pages again in the real reader, in real
 * Chromium. The vault is read (and, for one test, written) through IndexedDB directly, because the
 * durable row is the fact these tests assert on: a status line is a moment, a stored row stays.
 */

export const OCR_TIMEOUT = 180_000;
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

/** The shape of an `ocrPages` row as far as these tests look at it. */
export interface OcrRow {
  documentId: string;
  pageNumber: number;
  text: string;
  correctedText: string | null;
  words: Array<{ text: string }>;
  updatedAt: string;
  previousReading?: {
    text: string;
    correctedText: string | null;
    replacedAt: string;
  };
}

export async function ocrRows(page: Page): Promise<OcrRow[]> {
  const rows = (await storedOcrPages(page)) as unknown as OcrRow[];
  return rows.sort((a, b) => a.pageNumber - b.pageNumber);
}

/** Run "OCR this document" and wait until every page has a stored reading. */
export async function recogniseDocument(page: Page, pages: number): Promise<OcrRow[]> {
  await expect(page.getByTestId('pdf-ocr')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('pdf-ocr').click();
  await expect
    .poll(async () => (await ocrRows(page)).length, {
      message: 'every page is recognised and stored',
      timeout: OCR_TIMEOUT - 60_000,
      intervals: [100, 250, 500],
    })
    .toBe(pages);
  await expect(page.getByTestId('pdf-ocr-status')).toHaveCount(0, { timeout: 30_000 });
  return ocrRows(page);
}

export async function openPageText(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Page text' }).click();
  await expect(page.getByTestId('pdf-ocr-panel')).toBeVisible();
}

/** Page `n` has its complete text layer: words in it, and the end-of-content sentinel placed. */
export async function layerText(page: Page, n: number): Promise<string> {
  const layer = page.locator(`[data-testid="pdf-page-${n}"] .sv-textlayer:has(> .endOfContent)`);
  await expect(layer).toBeAttached({ timeout: 30_000 });
  return (await layer.textContent()) ?? '';
}

/** Select the words of recognised text from the word `from` to the word `to` (one span per word). */
export async function selectWordRange(
  page: Page,
  n: number,
  from: string,
  to: string,
): Promise<void> {
  await expect
    .poll(async () => (await layerText(page, n)).toLowerCase(), { timeout: 30_000 })
    .toContain(from.toLowerCase());
  await page.evaluate(
    ({ n, from, to }) => {
      const spans = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="pdf-page-${n}"] .sv-textlayer span`,
        ),
      ].filter((sp) => sp.firstChild?.nodeType === 3 && sp.children.length === 0);
      const find = (word: string) =>
        spans.find((sp) => (sp.textContent ?? '').trim().toLowerCase() === word.toLowerCase());
      const a = find(from);
      const b = find(to);
      if (!a?.firstChild || !b?.firstChild) throw new Error(`"${from}" .. "${to}" not on the page`);
      a.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      document
        .getSelection()!
        .setBaseAndExtent(a.firstChild, 0, b.firstChild, (b.textContent ?? '').trimEnd().length);
    },
    { n, from, to },
  );
  await expect(page.getByTestId('pdf-savebar')).toBeVisible();
}

/**
 * Make a stored reading worse on purpose, as if the page had been recognised badly earlier: replace
 * `from` by `to` in the page's recognised text and in its words. Read it back in a reopened reader.
 */
export async function worsenStoredReading(
  page: Page,
  pageNumber: number,
  from: string,
  to: string,
): Promise<void> {
  const changed = await page.evaluate(
    async ({ pageNumber, from, to }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('studyvault');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      try {
        const tx = db.transaction('ocrPages', 'readwrite');
        const store = tx.objectStore('ocrPages');
        const all = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>);
          req.onerror = () => reject(req.error);
        });
        const row = all.find((r) => r.pageNumber === pageNumber);
        if (!row) return false;
        row.text = String(row.text).replace(from, to);
        // `correctedText` holds every line as the person sees it: an untouched line must stay equal
        // to the recognised one, or the changed word would read as a correction of that line.
        if (typeof row.correctedText === 'string') {
          row.correctedText = row.correctedText.replace(from, to);
        }
        row.words = (row.words as Array<{ text: string }>).map((w) =>
          w.text === from ? { ...w, text: to } : w,
        );
        store.put(row);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        return true;
      } finally {
        db.close();
      }
    },
    { pageNumber, from, to },
  );
  expect(changed, `page ${pageNumber} has a stored reading to change`).toBe(true);
}

/**
 * Move the words of every line after the first down the page in the stored reading, as if the page
 * had been segmented differently earlier: the text is unchanged, the boxes of those lines sit where
 * no line of a fresh reading will be. `y` is the new top, 0..1 of the page.
 */
export async function moveStoredLinesAfterFirst(
  page: Page,
  pageNumber: number,
  y: number,
): Promise<void> {
  const moved = await page.evaluate(
    async ({ pageNumber, y }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('studyvault');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      try {
        const tx = db.transaction('ocrPages', 'readwrite');
        const store = tx.objectStore('ocrPages');
        const all = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>);
          req.onerror = () => reject(req.error);
        });
        const row = all.find((r) => r.pageNumber === pageNumber);
        if (!row) return false;
        const firstLine = String(row.text).split('\n')[0] ?? '';
        const inFirst = firstLine.split(' ').filter(Boolean).length;
        row.words = (row.words as Array<{ y: number; h: number }>).map((w, i) =>
          i < inFirst ? w : { ...w, y: Math.min(y, 1 - w.h) },
        );
        store.put(row);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        return true;
      } finally {
        db.close();
      }
    },
    { pageNumber, y },
  );
  expect(moved, `page ${pageNumber} has a stored reading to change`).toBe(true);
}

/** WCAG A/AA violations of the page as it is now, as one readable string ('' when there are none). */
export async function violations(page: Page): Promise<string> {
  await settleAnimations(page);
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

/** Requests the page made that left the machine (not the extension, not data or blob). */
export function watchNetwork(page: Page): string[] {
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/^(https?|wss?|ftp):/i.test(url)) outside.push(url);
  });
  return outside;
}
