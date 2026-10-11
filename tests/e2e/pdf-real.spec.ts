import type { Page, TestInfo } from '@playwright/test';
import { readRealPdfs, stemOf, type RealPdf } from '../fixtures/pdf/real/manifest';
import { expect, test } from './helpers.pages';
import {
  STATUS_LABEL,
  chooseFile,
  dragAcross,
  expectOverlayOnWords,
  expectPageDrawn,
  findColumnBand,
  findPassage,
  goToPage,
  openRealPdf,
  queryFrom,
  saveSelection,
  expectOverlayOnBox,
  selectAcrossBoundary,
  selectPassage,
  selectWords,
  squash,
  storedHighlights,
  storedOcrPages,
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
 *
 * Cost on a runner (this spec is meant to stay well under 6 minutes): documents of 100 pages or more
 * are only opened by the unit suite and by pdf-real-memory.spec.ts (a full traversal); the save, reload
 * and reopen round trip, the costly part, runs for the three smallest text files plus the Korean one
 * (CJK anchoring); the second, whole-document search only for short files.
 */

const PDFS = readRealPdfs();
const SHORT = PDFS.filter((p) => p.pages < 100);
const ROUND_TRIP = new Set([
  ...SHORT.filter((p) => p.text === 'text')
    .sort((a, b) => a.bytes - b.bytes)
    .slice(0, 3)
    .map((p) => p.file),
  'cdc-covid-sick-korean-2020.pdf',
]);
/** A test that is not finished in this long is stuck: a retry costs the same again. */
const PER_TEST_MS = 90_000;
const OCR_TIMEOUT_MS = 150_000;
/** What recognition of the first page without text must read, per file. */
const OCR_READS: Record<string, RegExp> = {
  'naca-sr256-ground-speed-1943.pdf': /ADVISORY/i,
  // Page 1 is stored sideways (text running bottom to top, /Rotate 0): it is read by turning it.
  'nasa-msfc-60k-combustion-testbed-2000.pdf': /Technology Goals and Objectives/i,
};
/** Scans stored sideways: their highlight round trip is `real layouts` > "a scan stored sideways". */
const SIDEWAYS = new Set(['nasa-msfc-60k-combustion-testbed-2000.pdf']);
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

for (const pdf of SHORT) {
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
        if (pdf.pages <= 40) {
          // A word that is not in the document finds nothing (a second pass over every page).
          await page.getByTestId('pdf-search').fill('qzxqzxqzx');
          await expect(count).toHaveText('No matches', { timeout: 90_000 });
        }
      }

      expect(errors, 'no uncaught exception or console error while reading').toEqual([]);
      report(testInfo, pdf, timings);
    });

    if (ROUND_TRIP.has(pdf.file)) {
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
        const recognised = (
          (await page.locator(`[data-testid="pdf-page-${target}"] .sv-textlayer`).textContent()) ??
          ''
        ).trim();
        timings.ocrChars = recognised.length;
        timings.ocrSample = recognised.replace(/\s+/g, ' ').slice(0, 90);
        console.log(
          `[real-pdf-ocr] ${pdf.file} page ${target}: ${recognised.replace(/\s+/g, ' ').slice(0, 400)}`,
        );

        const reads = OCR_READS[pdf.file];
        expect(reads, `${pdf.file} must be listed in OCR_READS`).toBeDefined();
        await expect
          .poll(
            async () =>
              (await page
                .locator(`[data-testid="pdf-page-${target}"] .sv-textlayer`)
                .textContent()) ?? '',
            { timeout: 30_000 },
          )
          .toMatch(reads!);
        if (!SIDEWAYS.has(pdf.file)) {
          // A highlight on recognised text of a real scan: anchored in the OCR stream, labelled as
          // machine-recognised, and painted on the words it quotes (the page may carry /Rotate).
          const words = await selectWords(page, target, 4);
          expect(words, 'a line of four recognised words').not.toBeNull();
          await expect(page.getByTestId('pdf-save-ocr-note')).toContainText(
            'recognised from a scanned image',
          );
          await saveSelection(page);
          const rows = await storedHighlights(page);
          expect(rows).toHaveLength(1);
          const anchor = (rows[0] as { anchorSet: { contentSignature: string } }).anchorSet;
          expect(anchor.contentSignature.startsWith('ocr1:')).toBe(true);
          await expect(page.getByTestId('pdf-highlight-card').first()).toContainText('OCR text');
          await expectOverlayOnBox(
            page,
            target,
            words!.box,
            'the highlight sits on the recognised words',
          );
        } else {
          // The page says the text is machine output and shows its confidence.
          await page.getByRole('tab', { name: 'Page text' }).click();
          await expect(page.getByTestId('pdf-ocr-panel')).toContainText('Machine-recognised text');
          await expect(page.getByTestId('pdf-ocr-legend')).toContainText('Low confidence');
        }
        expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
        report(testInfo, pdf, timings);
      });
    }
  });
}

// =============================================================================================
// Layouts only a real document has
// =============================================================================================

const byName = (file: string): RealPdf => {
  const pdf = PDFS.find((p) => p.file === file);
  if (!pdf) throw new Error(`${file} is not listed in tests/fixtures/pdf/real/SOURCES.md`);
  return pdf;
};

const nfkc = (s: string): string => squash(s).normalize('NFKC');

test.describe('real layouts', () => {
  test.describe.configure({ timeout: PER_TEST_MS });

  test('a real mouse drag over three lines of one column of a two-column article saves that column only', async ({
    env,
  }) => {
    const pdf = byName('cdc-mmwr-vaccination-coverage-2023.pdf');
    const { page, errors } = await openRealPdf(env, pdf);
    let found: { n: number; lines: string[]; others: string[] } | null = null;
    for (let n = 1; n <= pdf.pages && !found; n++) {
      if (n > 1) await goToPage(page, n);
      await pageRendered(page, n);
      const band = await findColumnBand(page, n, 3, true);
      if (band) found = { n, ...band };
    }
    if (!found) throw new Error('no band of three lines with another column beside it');
    const { n, lines, others } = found;
    await dragAcross(page, n, lines[0]!, lines[2]!);
    const quote = nfkc(await page.getByTestId('pdf-savebar').locator('blockquote').innerText());
    for (const line of lines) expect(quote).toContain(nfkc(line));
    for (const other of others) {
      expect(quote, `text of the other column: "${other}"`).not.toContain(nfkc(other));
    }
    await saveSelection(page);
    const rows = await storedHighlights(page);
    expect(rows).toHaveLength(1);
    const stored = nfkc((rows[0] as { exactQuote: string }).exactQuote);
    expect(stored.startsWith(nfkc(lines[0]!).slice(0, 15))).toBe(true);
    expect(stored.endsWith(nfkc(lines[2]!).slice(-15))).toBe(true);
    await expectOverlayOnWords(
      page,
      n,
      lines,
      'the saved column highlight sits on its three lines',
    );
    expect(errors).toEqual([]);
  });

  test('a selection across a page boundary is saved as one highlight per page', async ({ env }) => {
    const pdf = byName('nist-cswp29-csf-2-0.pdf');
    const { page, errors } = await openRealPdf(env, pdf);
    await goToPage(page, 3);
    await pageRendered(page, 3);
    await pageRendered(page, 4); // inside the window: the neighbour of a visible page
    const { from, to } = await selectAcrossBoundary(page, 3);
    const quote = nfkc(await page.getByTestId('pdf-savebar').locator('blockquote').innerText());
    expect(quote).toContain(nfkc(from).slice(0, 15));
    expect(quote).toContain(nfkc(to).slice(-15));
    await saveSelection(page);
    const rows = await storedHighlights(page);
    expect(rows).toHaveLength(2);
    await expect(page.getByTestId('pdf-card-page')).toHaveCount(2);
    const badges = await page.getByTestId('pdf-card-page').allTextContents();
    expect(badges.sort()).toEqual(['p. 3', 'p. 4']);
    expect(errors).toEqual([]);
  });

  // Seen on CI with a 150 s timeout: the save bar was placed beside a selection that lay under the
  // bottom edge of the window, so "Save highlight" was outside the viewport and could not be clicked.
  // A selection can be off screen by keyboard, by a long drag that auto-scrolled, or by script.
  test('the save bar stays inside the window when the selection is off screen', async ({ env }) => {
    const pdf = byName('cdc-mmwr-vaccination-coverage-2023.pdf');
    const { page, errors } = await openRealPdf(env, pdf);
    await pageRendered(page, 1);
    const below = await findPassage(page, 1, { belowFold: true });
    expect(below, 'text on page 1 that is under the bottom edge of the window').not.toBeNull();
    await selectPassage(page, below!, { scroll: false });
    const bar = page.getByTestId('pdf-savebar');
    await expect(bar).toBeVisible();
    const view = page.viewportSize()!;
    const box = (await page.getByTestId('pdf-save').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    await saveSelection(page); // a real click: Playwright refuses an element outside the viewport
    expect(await storedHighlights(page)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  // The real MSFC scan: page 1 is stored sideways (lines run bottom to top, /Rotate 0). Recognition
  // used to read it upright and returned junk ("s (c) [7] s (c) NS 0 8 ...", 793 characters) under a
  // green "Recognised 1 page". The reader now finds the way the lines run, turns the page image to
  // read it (no extra data, no network), and says so; the words keep their place on the page as it is
  // shown, so a highlight made on them is found again on the same words after reopening.
  test('a scan stored sideways is read without turning the view, and a highlight on it is found again after reopening', async ({
    env,
  }, testInfo) => {
    test.setTimeout(OCR_TIMEOUT_MS);
    const pdf = byName('nasa-msfc-60k-combustion-testbed-2000.pdf');
    const timings: Record<string, number | string> = {};
    const { page, errors, bytes } = await openRealPdf(env, pdf);
    await expectPageDrawn(page, 1);
    const layer = page.locator('[data-testid="pdf-page-1"] .sv-textlayer');
    const complete = page.locator(
      '[data-testid="pdf-page-1"] .sv-textlayer:has(> .endOfContent):has(> span)',
    );

    // Recognise page 1 exactly as it is shown: the view is NOT turned first.
    const t = Date.now();
    await page.getByTestId('pdf-ocr-this-page').click();
    await expect(page.getByTestId('pdf-ocr-status')).toBeVisible();
    await expect(page.getByText('Recognised 1 page', { exact: true })).toBeVisible({
      timeout: OCR_TIMEOUT_MS - 60_000,
    });
    timings.ocrOnePageMs = Date.now() - t;
    // The outcome says what was done to the page, so nobody is told it was read as it was.
    await expect(page.getByTestId('pdf-ocr-outcome')).toContainText(
      'Page 1 is stored sideways (its lines run from bottom to top); it was turned to be read.',
    );

    // Real words, not 793 characters of noise.
    await expect(complete).toBeAttached({ timeout: 30_000 });
    const text = ((await layer.textContent()) ?? '').replace(/\s+/g, ' ');
    const plausible = text.match(/\b[A-Za-z]{4,}\b/g) ?? [];
    timings.ocrChars = text.length;
    timings.plausibleWords = plausible.length;
    console.log(`[real-pdf-ocr] ${pdf.file} page 1 (stored sideways): ${text.slice(0, 300)}`);
    expect(plausible.length, 'words of four letters or more').toBeGreaterThan(40);
    expect(text).toMatch(/Technology Goals and Objectives/i);
    expect(text).toMatch(/Mitigate risk/i);

    // The stored row records the turn; its boxes are in the page's own frame (tall, narrow words).
    const rows = (await storedOcrPages(page)) as Array<{
      pageNumber: number;
      orientation?: number;
      words: Array<{ w: number; h: number }>;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pageNumber).toBe(1);
    expect(rows[0]!.orientation).toBe(90);
    const tall = rows[0]!.words.filter((w) => w.h > w.w).length;
    expect(tall, 'most words are taller than wide on the stored page').toBeGreaterThan(
      rows[0]!.words.length * 0.5,
    );
    await page.getByRole('tab', { name: 'Page text' }).click();
    await expect(page.getByTestId('pdf-ocr-orientation')).toContainText('stored sideways');
    await page.getByRole('tab', { name: /Highlights/ }).click();

    // Turn the view so the sideways lines read left to right, select four words, save.
    await page.getByTestId('pdf-rotate').click();
    const rotated = await layer.getAttribute('data-main-rotation');
    const words = await selectWords(page, 1, 4);
    expect(words, 'a line of four recognised words').not.toBeNull();
    await expect(page.getByTestId('pdf-save-ocr-note')).toContainText(
      'recognised from a scanned image',
    );
    await saveSelection(page);
    const saved = await storedHighlights(page);
    expect(saved).toHaveLength(1);
    const anchor = (saved[0] as { anchorSet: { contentSignature: string; pageNumber: number } })
      .anchorSet;
    expect(anchor.contentSignature.startsWith('ocr1:')).toBe(true);
    expect(anchor.pageNumber).toBe(1);
    await expect(page.getByTestId('pdf-highlight-card').first()).toContainText('OCR text');
    await expectOverlayOnBox(page, 1, words!.box, 'the highlight sits on the recognised words');

    // Reopen: the reader forgets the file; the recognised text and the highlight come back from the
    // vault, the highlight resolves against the stored words (same stream, same signature) and is
    // painted on the same words. No recognition runs.
    await page.reload();
    await expect(page.getByTestId('pdf-open')).toBeVisible();
    const t1 = Date.now();
    await chooseFile(page, pdf, bytes);
    await expect(page.getByTestId('pdf-highlight-card')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('pdf-highlight-card').first()).toContainText('Found on page');
    await expect(page.getByTestId('pdf-highlight-card').first()).toContainText('OCR text');
    await expect(page.getByTestId('pdf-ocr-status')).toHaveCount(0);
    await page.getByTestId('pdf-card-goto').click();
    await expect(complete).toBeAttached({ timeout: 30_000 });
    // Same view as before the reload, so the screen box is comparable.
    for (let i = 0; i < 3 && (await layer.getAttribute('data-main-rotation')) !== rotated; i++) {
      await page.getByTestId('pdf-rotate').click();
      await expect(complete).toBeAttached({ timeout: 30_000 });
    }
    await expectOverlayOnBox(page, 1, words!.box, 'the restored highlight sits on the same words');
    timings.restoreMs = Date.now() - t1;

    // Nothing was duplicated or re-recognised by reopening.
    const again = await storedHighlights(page);
    expect(again).toHaveLength(1);
    expect((again[0] as { id: string }).id).toBe((saved[0] as { id: string }).id);
    expect((await storedOcrPages(page)).length).toBe(1);
    expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
    report(testInfo, pdf, timings);
  });
});
