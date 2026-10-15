import { scannedPages } from '../fixtures/pdf/docs';
import { expect, test, type Env } from './helpers.pages';
import {
  OCR_TIMEOUT,
  layerText,
  moveStoredLinesAfterFirst,
  ocrRows,
  openPageText,
  recogniseDocument,
  selectWordRange,
  violations,
  watchNetwork,
  worsenStoredReading,
} from './helpers.pdfOcrRerun';
import { openBytes } from './helpers.pdfLinks';
import { expectOverlayOnWords, saveSelection, storedHighlights } from './helpers.pdfReal';

/**
 * Reading recognised pages again (ADR-006, Amendment 5), in the real reader in real Chromium with the
 * real bundled engine. The fixtures are generated scans (a raster of bold lines of text, no text
 * layer). To make "the new reading differs from the stored one" a fact instead of a hope, a stored
 * reading is made worse in the vault before the reader reopens it (`worsenStoredReading`); the engine
 * then reads the page properly and the two can be told apart.
 */

const LINES = ['The mitochondria is the powerhouse', 'of the cell and makes ATP'];
const CORRECTION = 'of the whole cell and makes ATP';

test.describe('reading recognised pages again', () => {
  // The engine (wasm and language data) is the heaviest thing the suite loads: one test after another.
  test.describe.configure({ mode: 'serial', timeout: OCR_TIMEOUT });

  async function scan(env: Env, pages: string[][], title: string): Promise<Buffer> {
    const scratch = await env.context.newPage();
    try {
      return await scannedPages(scratch, pages, title);
    } finally {
      await scratch.close();
    }
  }

  test('one page: the correction is kept, the highlight is found again, and the previous reading comes back', async ({
    env,
  }) => {
    const bytes = await scan(env, [LINES], 'Cell biology');
    const first = await openBytes(env, 'cell.pdf', bytes);
    const [recognised] = await recogniseDocument(first.page, 1);
    expect(recognised!.text.toLowerCase()).toContain('mitochondria');
    const firstWord = recognised!.words[0]!.text;

    // A highlight on recognised words, and a correction of the second line.
    await selectWordRange(first.page, 1, 'mitochondria', 'powerhouse');
    await saveSelection(first.page);
    const quote = (await storedHighlights(first.page))[0]!.exactQuote as string;
    expect(quote.toLowerCase()).toContain('mitochondria');
    await openPageText(first.page);
    await first.page.getByTestId('pdf-ocr-edit').nth(1).click();
    await first.page.getByTestId('pdf-ocr-input').fill(CORRECTION);
    await first.page.getByTestId('pdf-ocr-line-save').click();
    await expect(first.page.getByTestId('pdf-ocr-recognised')).toBeVisible();

    // The page was recognised badly the first time: its first word is wrong in the vault.
    await worsenStoredReading(first.page, 1, firstWord, 'Zzqx');
    await first.page.close();

    const { page, errors } = await openBytes(env, 'cell.pdf', bytes);
    const outside = watchNetwork(page);
    await expect.poll(async () => await layerText(page, 1)).toContain('Zzqx');
    await expect(page.getByTestId('pdf-ocr')).toHaveCount(0); // nothing is left to recognise
    await openPageText(page);
    await expect(page.getByTestId('pdf-ocr-restore')).toHaveCount(0); // never read again yet
    await expect(page.getByTestId('pdf-ocr-line-text').nth(1)).toHaveText(CORRECTION);

    // Ask first: what it costs, what is kept, what happens to the correction. The dialog is accessible.
    await page.getByTestId('pdf-ocr-rerun-page').click();
    const dialog = page.getByRole('dialog', { name: 'Read page 1 again?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('pdf-ocr-rerun-estimate')).toContainText('About');
    await expect(dialog.getByTestId('pdf-ocr-rerun-corrections')).toContainText(
      'You corrected 1 line on this page',
    );
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await violations(page)).toBe('');
    await dialog.getByRole('button', { name: 'Re-recognise page 1' }).click();
    await expect(dialog).toHaveCount(0);

    // Real progress while it runs, then the result.
    await expect(page.getByText('Recognised 1 page again', { exact: true })).toBeVisible({
      timeout: OCR_TIMEOUT - 60_000,
    });
    await expect(page.getByTestId('pdf-ocr-outcome')).toContainText('Your corrections: 1 kept.');
    await expect(page.getByTestId('pdf-ocr-outcome')).toContainText(
      'Highlights on these pages: 1 found again.',
    );

    // The new text replaced the old; the correction followed its line.
    await expect.poll(async () => await layerText(page, 1)).not.toContain('Zzqx');
    expect((await layerText(page, 1)).toLowerCase()).toContain('mitochondria');
    await expect(page.getByTestId('pdf-ocr-line-text').nth(1)).toHaveText(CORRECTION);
    await expect(page.getByText('Edited', { exact: true })).toBeVisible();
    let [row] = await ocrRows(page);
    expect(row!.text).not.toContain('Zzqx');
    expect(row!.correctedText).toContain(CORRECTION);
    expect(row!.previousReading?.text).toContain('Zzqx'); // the reading it replaced is kept...
    expect(row!.previousReading?.correctedText).toContain(CORRECTION); // ...with its corrections

    // The highlight is still the person's, with the same quote, and is painted on the same words.
    expect((await storedHighlights(page)).map((h) => h.exactQuote)).toEqual([quote]);
    await page.getByRole('tab', { name: /Highlights/ }).click();
    await expect(page.getByText(/not painted/)).toHaveCount(0);
    await expectOverlayOnWords(
      page,
      1,
      ['mitochondria', 'powerhouse'],
      'the highlight sits on its words after the page was read again',
    );

    // One step back: the earlier reading, corrections and all, and the new one is kept in its place.
    await openPageText(page);
    await page.getByTestId('pdf-ocr-restore').click();
    await expect(page.getByTestId('pdf-ocr-restore-status')).toHaveText(
      'Restored the earlier reading of page 1.',
    );
    await expect.poll(async () => await layerText(page, 1)).toContain('Zzqx');
    [row] = await ocrRows(page);
    expect(row!.text).toContain('Zzqx');
    expect(row!.previousReading?.text).not.toContain('Zzqx');
    await expect(page.getByTestId('pdf-ocr-line-text').nth(1)).toHaveText(CORRECTION);
    await page.getByRole('tab', { name: /Highlights/ }).click();
    await expect(page.getByText(/not painted/)).toHaveCount(0);
    await expectOverlayOnWords(
      page,
      1,
      ['mitochondria', 'powerhouse'],
      'the highlight sits on its words after the earlier reading was restored',
    );

    expect(outside, 'nothing left the machine').toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a correction whose line the new reading has no counterpart for is dropped, listed, and comes back with Undo', async ({
    env,
  }) => {
    const bytes = await scan(env, [LINES], 'Cell biology, again');
    const first = await openBytes(env, 'cell.pdf', bytes);
    await recogniseDocument(first.page, 1);
    await openPageText(first.page);
    await first.page.getByTestId('pdf-ocr-edit').nth(1).click();
    await first.page.getByTestId('pdf-ocr-input').fill(CORRECTION);
    await first.page.getByTestId('pdf-ocr-line-save').click();
    await expect(first.page.getByTestId('pdf-ocr-recognised')).toBeVisible();
    // Stored with the second line somewhere else on the page: no line of a fresh reading is there.
    await moveStoredLinesAfterFirst(first.page, 1, 0.7);
    await first.page.close();

    const { page, errors } = await openBytes(env, 'cell.pdf', bytes);
    await openPageText(page);
    await expect(page.getByText('Edited', { exact: true })).toBeVisible();
    await page.getByTestId('pdf-ocr-rerun-page').click();
    await page
      .getByRole('dialog', { name: 'Read page 1 again?' })
      .getByRole('button', { name: 'Re-recognise page 1' })
      .click();

    await expect(page.getByText('Recognised 1 page again', { exact: true })).toBeVisible({
      timeout: OCR_TIMEOUT - 60_000,
    });
    const list = page.getByTestId('pdf-ocr-outcome-list');
    await expect(list).toContainText('Page 1, line 2');
    await expect(list).toContainText('was dropped');
    await expect(list).toContainText(CORRECTION);
    await expect(page.getByTestId('pdf-ocr-outcome')).toContainText('1 dropped');
    await expect(page.getByText('Edited', { exact: true })).toHaveCount(0);
    let [row] = await ocrRows(page);
    expect(row!.correctedText).toBeNull();
    expect(row!.previousReading?.correctedText).toContain(CORRECTION);

    // Nothing was lost: the earlier reading has the correction, and Undo puts it back.
    await page.getByTestId('pdf-ocr-restore').click();
    await expect(page.getByTestId('pdf-ocr-restore-status')).toHaveText(
      'Restored the earlier reading of page 1.',
    );
    await expect(page.getByText('Edited', { exact: true })).toBeVisible();
    await expect(page.getByTestId('pdf-ocr-line-text').nth(1)).toHaveText(CORRECTION);
    [row] = await ocrRows(page);
    expect(row!.correctedText).toContain(CORRECTION);
    expect(errors).toEqual([]);
  });

  test('all pages: it asks with an estimate, a cancelled question changes nothing, and a cancelled run leaves the pages it did not reach as they were', async ({
    env,
  }) => {
    const ORGANS = ['nephron', 'glomerulus', 'tubule', 'ureter', 'bladder', 'urethra'];
    const bytes = await scan(
      env,
      ORGANS.map((organ, i) => [
        `Scanned page ${i + 1} names the ${organ}`,
        'Machine recognition is checked',
        'before it is relied upon',
      ]),
      'Six scans',
    );
    const { page, errors } = await openBytes(env, 'six-scans.pdf', bytes);
    const before = await recogniseDocument(page, ORGANS.length);
    expect(before.every((r) => r.previousReading === undefined)).toBe(true);
    await openPageText(page);

    // The question first. Its estimate comes from the page count; cancelling it writes nothing.
    await page.getByTestId('pdf-ocr-rerun-all').click();
    const dialog = page.getByRole('dialog', { name: 'Read all 6 recognised pages again?' });
    await expect(dialog.getByTestId('pdf-ocr-rerun-estimate')).toContainText('for 6 pages');
    await expect(dialog).toContainText('You can cancel at any time');
    expect(await violations(page)).toBe('');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('pdf-ocr-status')).toHaveCount(0);
    expect(await ocrRows(page)).toEqual(before);

    // Run it, and cancel as soon as one page has been replaced (a saved row, not a status line).
    await page.getByTestId('pdf-ocr-rerun-all').click();
    await dialog.getByRole('button', { name: 'Re-recognise all pages' }).click();
    await expect(page.getByTestId('pdf-ocr-status')).toBeVisible();
    await expect
      .poll(async () => (await ocrRows(page)).filter((r) => r.previousReading).length, {
        message: 'the first page has been replaced',
        timeout: OCR_TIMEOUT - 60_000,
        intervals: [50, 100, 200],
      })
      .toBeGreaterThan(0);
    await page.getByTestId('pdf-ocr-cancel').click({ timeout: 10_000 });
    await expect(page.getByText('Reading again cancelled', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId('pdf-ocr-outcome')).toContainText(
      'Every other page keeps its earlier text',
    );

    const after = await ocrRows(page);
    expect(after.map((r) => r.pageNumber)).toEqual(before.map((r) => r.pageNumber));
    const replaced = after.filter((r) => r.previousReading);
    expect(replaced.length, 'the run was stopped part-way').toBeGreaterThan(0);
    expect(replaced.length, 'the run was stopped part-way').toBeLessThan(ORGANS.length);
    for (const row of after) {
      const was = before.find((b) => b.pageNumber === row.pageNumber)!;
      if (row.previousReading) {
        expect(row.previousReading.text).toBe(was.text); // the reading it replaced
      } else {
        expect(row, `page ${row.pageNumber} was not reached and is untouched`).toEqual(was);
      }
    }
    expect(errors).toEqual([]);
  });

  test('it works offline: nothing is requested from the network', async ({ env }) => {
    const bytes = await scan(env, [LINES], 'Offline reading');
    const { page, errors } = await openBytes(env, 'offline.pdf', bytes);
    await recogniseDocument(page, 1);
    const outside = watchNetwork(page);
    await openPageText(page);

    await env.context.setOffline(true);
    try {
      await page.getByTestId('pdf-ocr-rerun-page').click();
      await page
        .getByRole('dialog', { name: 'Read page 1 again?' })
        .getByRole('button', { name: 'Re-recognise page 1' })
        .click();
      await expect(page.getByText('Recognised 1 page again', { exact: true })).toBeVisible({
        timeout: OCR_TIMEOUT - 60_000,
      });
    } finally {
      await env.context.setOffline(false);
    }
    const [row] = await ocrRows(page);
    expect(row!.previousReading).toBeDefined();
    expect(outside, 'nothing left the machine').toEqual([]);
    expect(errors).toEqual([]);
  });
});
