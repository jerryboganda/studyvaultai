import type { Page, TestInfo } from '@playwright/test';
import { readRealPdfs, stemOf, type RealPdf } from '../fixtures/pdf/real/manifest';
import { expect, test } from './helpers.pages';
import {
  STATUS_LABEL,
  chooseFile,
  expectOverlayOnWords,
  expectPageDrawn,
  findPassage,
  goToPage,
  openRealPdf,
  queryFrom,
  saveSelection,
  selectPassage,
  squash,
  storedHighlights,
  type Passage,
} from './helpers.pdfReal';

/**
 * Real public-domain PDFs (tests/fixtures/pdf/real, listed in SOURCES.md) in the real reader: each file
 * is opened through the file chooser, its first page is drawn, it is navigated, searched, and (when it
 * has text) a passage is selected and saved as a highlight that is found again, on the same words,
 * after the reader is reloaded and the file is chosen again. Timings are printed and attached.
 *
 * What the synthetic fixtures (pdf.spec.ts) cannot say, these can: real fonts, real column layouts,
 * outlines with nested destinations, scans with /Rotate 270, CJK, 8-megapixel page images.
 *
 * Harness limits: one real engine run (OCR) is in its own test with its own timeout and only ever
 * recognises ONE page; the memory/windowing check of the long documents is pdf-real-memory.spec.ts.
 */

const PDFS = readRealPdfs();
const PER_TEST_MS = 150_000;
const OCR_TIMEOUT_MS = 240_000;
/** Pages tried, in order, when looking for a passage of prose. */
const PASSAGE_PAGES = 8;

function report(testInfo: TestInfo, pdf: RealPdf, timings: Record<string, number | string>): void {
  const line = JSON.stringify({ file: pdf.file, pages: pdf.pages, bytes: pdf.bytes, ...timings });
  console.log(`[real-pdf-timing] ${line}`);
  testInfo.annotations.push({ type: 'real-pdf-timing', description: line });
}

/** The text layer of page `n` is complete (its spans exist and the end-of-content sentinel is placed). */
async function pageRendered(page: Page, n: number): Promise<void> {
  await expect(
    page.locator(`[data-testid="pdf-page-${n}"] .sv-textlayer .endOfContent`),
  ).toBeAttached({ timeout: 60_000 });
}

/** First page (from 1) that holds a passage worth selecting. */
async function passageSomewhere(page: Page, pdf: RealPdf): Promise<Passage> {
  for (let n = 1; n <= Math.min(pdf.pages, PASSAGE_PAGES); n++) {
    if (n > 1) await goToPage(page, n);
    await pageRendered(page, n);
    const found = await findPassage(page, n);
    if (found) return found;
  }
  throw new Error(`no passage of selectable text on the first ${PASSAGE_PAGES} pages`);
}

const PLURAL = (n: number): string => `${n} page${n === 1 ? '' : 's'}`;

for (const pdf of PDFS) {
  const stem = stemOf(pdf);

  test.describe(stem, () => {
    test.describe.configure({ timeout: PER_TEST_MS });

    test('opens, says what it is, draws page 1, navigates by outline and page, and searches', async ({
      env,
    }, testInfo) => {
      const timings: Record<string, number | string> = {};
      const started = Date.now();
      const { page, errors, openMs } = await openRealPdf(env, pdf);
      timings.openMs = openMs;

      // What the header says about the file.
      await expect(page.getByTestId('pdf-text-status')).toHaveText(STATUS_LABEL[pdf.text], {
        timeout: 30_000,
      });
      await expect(page.locator('.sv-doc__head')).toContainText(PLURAL(pdf.pages));
      await expect(page.locator('.sv-doc__title')).not.toBeEmpty();
      await expect(page.getByTestId('pdf-page-input')).toHaveAttribute('max', String(pdf.pages));
      await expect(page.getByTestId(`pdf-page-${pdf.pages}`)).toBeAttached(); // a slot per page

      // Page 1 is really painted (not a blank canvas) and, for a text document, selectable.
      const ink = await expectPageDrawn(page, 1);
      timings.firstPageMs = Date.now() - started;
      timings.page1Ink = Math.round(ink * 1000) / 1000;
      if (pdf.text === 'text') {
        await pageRendered(page, 1);
        const layer = await page.locator('[data-testid="pdf-page-1"] .sv-textlayer').textContent();
        expect((layer ?? '').trim().length).toBeGreaterThan(0);
        timings.textLayerMs = Date.now() - started;
      }
      // Only a window of pages holds a canvas, whatever the document size.
      expect(await page.locator('canvas.sv-pdf-canvas').count()).toBeLessThanOrEqual(4);

      // The outline: as many entries as SOURCES.md says; a bookmark moves to its page and draws it.
      await page.getByTestId('pdf-toggle-sidepane').click();
      if (pdf.outline > 0) {
        const outline = page.getByTestId('pdf-outline');
        await expect(outline).toBeVisible();
        await expect(outline.locator('li')).toHaveCount(pdf.outline);
        const targets = outline.getByRole('button').filter({ hasText: /· p\. \d+/ });
        const last = targets.last();
        const label = (await last.textContent()) ?? '';
        const wanted = Number(/p\. (\d+)/.exec(label)?.[1]);
        expect(wanted).toBeGreaterThanOrEqual(1);
        expect(wanted).toBeLessThanOrEqual(pdf.pages);
        const t = Date.now();
        await last.click();
        await expect(page.getByTestId('pdf-page-input')).toHaveValue(String(wanted));
        await expectPageDrawn(page, wanted);
        timings.outlineJumpMs = Date.now() - t;
        await expect(last).toHaveAttribute('aria-current', 'location');
      } else {
        await expect(page.getByTestId('pdf-outline-empty')).toBeVisible();
      }
      await page.getByTestId('pdf-toggle-sidepane').click();

      // The last page, far from the window: it is drawn and the window moved with it.
      const jump = Date.now();
      await goToPage(page, pdf.pages);
      await expect(page.getByTestId('pdf-page-input')).toHaveValue(String(pdf.pages));
      await expectPageDrawn(page, pdf.pages);
      timings.lastPageMs = Date.now() - jump;
      expect(await page.locator('canvas.sv-pdf-canvas').count()).toBeLessThanOrEqual(4);
      await goToPage(page, 1);

      // Search. Text documents: a word taken from the document itself is found, counted and marked.
      // A document with no text at all must say so instead of inventing matches.
      const count = page.getByTestId('pdf-find-count');
      if (pdf.text === 'scanned') {
        const t = Date.now();
        await page.getByTestId('pdf-search').fill('the');
        await expect(count).toHaveText('No matches', { timeout: 60_000 });
        timings.searchMs = Date.now() - t;
        timings.searchHits = 0;
      } else {
        await pageRendered(page, 1);
        const passage = await passageSomewhere(page, pdf);
        const query = queryFrom(passage.first);
        const t = Date.now();
        await page.getByTestId('pdf-search').fill(query);
        await expect(count).toHaveText(/^\d+ of \d+\+?$/, { timeout: 90_000 });
        timings.searchMs = Date.now() - t;
        timings.searchQuery = query;
        const total = Number(/of (\d+)/.exec((await count.textContent()) ?? '')?.[1]);
        expect(total).toBeGreaterThanOrEqual(1);
        timings.searchHits = total;
        await expect(page.locator('.sv-pdf-find').first()).toBeAttached({ timeout: 30_000 });
        // A word that is not in the document finds nothing.
        await page.getByTestId('pdf-search').fill('qzxqzxqzx');
        await expect(count).toHaveText('No matches', { timeout: 90_000 });
      }

      expect(errors, 'no uncaught exception or console error while reading').toEqual([]);
      report(testInfo, pdf, timings);
    });

    if (pdf.text !== 'scanned') {
      test('selects a passage and saves a highlight that is found again on the same words after reopening', async ({
        env,
      }, testInfo) => {
        const timings: Record<string, number | string> = {};
        const { page, errors, bytes } = await openRealPdf(env, pdf);
        const passage = await passageSomewhere(page, pdf);
        const n = passage.pageNumber;
        timings.passagePage = n;

        // Select by range (a drag on real, tiny, rotated or CJK text is the pdf.spec.ts job).
        await selectPassage(page, passage);
        const nfkc = (s: string): string => squash(s).normalize('NFKC');
        const quote = nfkc(await page.getByTestId('pdf-savebar').locator('blockquote').innerText());
        expect(quote).toContain(nfkc(passage.first).slice(0, 20));
        expect(quote).toContain(nfkc(passage.last).slice(-20));

        const t0 = Date.now();
        await saveSelection(page);
        timings.saveMs = Date.now() - t0;
        const rows = await storedHighlights(page);
        expect(rows).toHaveLength(1);
        const saved = rows[0] as {
          exactQuote: string;
          anchorSet: { type: string; rects: unknown[]; contentSignature: string };
        };
        expect(saved.anchorSet.type).toBe('pdf');
        expect(saved.anchorSet.rects.length).toBeGreaterThanOrEqual(1);
        expect(saved.anchorSet.contentSignature.startsWith('ocr1:')).toBe(false); // embedded text
        expect(nfkc(saved.exactQuote)).toContain(nfkc(passage.first).slice(0, 20));
        await expect(page.getByTestId('pdf-card-page').first()).toHaveText(`p. ${n}`);
        const parts =
          passage.first === passage.last ? [passage.first] : [passage.first, passage.last];
        await expectOverlayOnWords(page, n, parts, 'the saved highlight sits on its words');

        // Reload: the reader forgets the file; choosing it again re-attaches its highlights.
        await page.reload();
        await expect(page.getByTestId('pdf-open')).toBeVisible();
        const t1 = Date.now();
        await chooseFile(page, pdf, bytes);
        await expect(page.getByTestId('pdf-highlight-card')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('pdf-highlight-card').first()).toContainText('Found on page');
        await expect(page.getByTestId('pdf-card-page').first()).toHaveText(`p. ${n}`);
        // "Go to highlight" is the user's way back to it: the page is drawn and the overlay is on
        // the same words, not on a neighbour.
        await page.getByTestId('pdf-card-goto').click();
        await pageRendered(page, n);
        await expectOverlayOnWords(page, n, parts, 'the restored highlight sits on the same words');
        timings.restoreMs = Date.now() - t1;

        // Nothing was duplicated or rewritten by reopening.
        const again = await storedHighlights(page);
        expect(again).toHaveLength(1);
        expect((again[0] as { exactQuote: string }).exactQuote).toBe(saved.exactQuote);
        expect((again[0] as { id: string }).id).toBe((rows[0] as { id: string }).id);

        expect(errors, 'no uncaught exception or console error').toEqual([]);
        report(testInfo, pdf, timings);
      });
    }

    if (pdf.text !== 'text') {
      // The real engine (wasm + language data) on ONE page of a real scan: the first page that has no
      // selectable text. Never the whole document: a 33-page scan would be minutes of CPU on a runner.
      test('recognises one scanned page on this device, and its text becomes selectable', async ({
        env,
      }, testInfo) => {
        test.setTimeout(OCR_TIMEOUT_MS);
        const timings: Record<string, number | string> = {};
        const { page, errors } = await openRealPdf(env, pdf);
        await expect(page.getByTestId('pdf-ocr-this-page')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText('nothing is uploaded, and it works offline')).toBeVisible();

        // The first page whose verdict is "no selectable text" (page 1 may carry a stamp).
        let target = 0;
        for (let n = 1; n <= Math.min(pdf.pages, PASSAGE_PAGES) && target === 0; n++) {
          if (n > 1) await goToPage(page, n);
          await expectPageDrawn(page, n);
          const slotText = (await page.getByTestId(`pdf-page-${n}`).textContent()) ?? '';
          if (/No selectable text/.test(slotText)) target = n;
        }
        expect(target, 'a page without selectable text among the first pages').toBeGreaterThan(0);
        await goToPage(page, target);
        await expect(page.getByTestId('pdf-page-input')).toHaveValue(String(target));
        await expect(page.getByTestId('pdf-ocr-this-page')).toBeEnabled();
        await expect(page.getByTestId('pdf-ocr-this-page')).toHaveText(`OCR page ${target}`);

        const t = Date.now();
        await page.getByTestId('pdf-ocr-this-page').click();
        await expect(page.getByTestId('pdf-ocr-status')).toBeVisible();
        await expect(page.getByTestId('pdf-ocr-cancel')).toBeVisible();
        await expect(page.getByTestId('pdf-ocr-outcome')).toContainText('machine-recognised', {
          timeout: OCR_TIMEOUT_MS - 60_000,
        });
        await expect(page.getByText('Recognised 1 page', { exact: true })).toBeVisible();
        timings.ocrOnePageMs = Date.now() - t;
        timings.ocrPage = target;

        // Exactly one page was recognised, and its words are real text in the page's text layer.
        await expect
          .poll(
            async () =>
              (
                (await page
                  .locator(`[data-testid="pdf-page-${target}"] .sv-textlayer`)
                  .textContent()) ?? ''
              ).trim().length,
            { timeout: 30_000 },
          )
          .toBeGreaterThan(0);
        timings.ocrChars = (
          (await page.locator(`[data-testid="pdf-page-${target}"] .sv-textlayer`).textContent()) ??
          ''
        ).trim().length;
        expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
        report(testInfo, pdf, timings);
      });
    }
  });
}
