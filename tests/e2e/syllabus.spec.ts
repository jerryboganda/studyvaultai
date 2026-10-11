import type { Page } from '@playwright/test';
import {
  dashboardHref,
  dialogOf,
  expect,
  expectAxeClean,
  expectRenderedSet,
  expectTotal,
  externalRequests,
  openControl,
  openDashboard,
  pageErrors as dashboardErrors,
  readTable,
  settle,
  test,
  toast,
} from './helpers.dashboard';
import { deleteAllData, downloadOf, openBackupPage } from './helpers.backup';
import {
  UTC_DAY,
  axeReport,
  openReview,
  pageErrors as reviewErrors,
  tableRows,
  whenText,
} from './helpers.review';
import {
  OUTLINE,
  SID,
  expectedRows,
  mapTopic,
  openSyllabusView,
  overallText,
  pasteOutline,
  putSyllabus,
  seedSyllabusVault,
  sortId,
  storedThresholds,
  syllabusRows,
  topicId,
  topicItem,
  topicsTree,
  topicsByTitle,
} from './helpers.syllabus';

/**
 * Custom syllabus and coverage (ADR-020 part 2) in a real loaded extension: real Chromium, the real
 * built extension, real input. The vault is seeded into IndexedDB before the first load (see
 * helpers.syllabus.ts for exactly what is in it and what every topic must show), and the expected
 * numbers are computed from that description, never read back from the product.
 */
test.describe.configure({ timeout: 240_000 });

const analyticsTable = (rows: string[][]) =>
  Object.fromEntries(
    rows.map((r) => [(r[0] ?? '').replace(/ \(map a bank or tag to this topic\)$/, ''), r]),
  ) as Record<string, string[]>;

test.describe('syllabus editor and coverage', () => {
  test('an outline becomes a syllabus, topics are mapped to banks and tags, and the coverage equals the seeded vault; offline, no request, axe clean', async ({
    env,
  }) => {
    const seed = await seedSyllabusVault(env);
    const page = await openDashboard(env);
    await env.context.setOffline(true);
    try {
      // ---- the view starts honest and empty ----------------------------------------------------
      await openSyllabusView(page);
      await expect(page.getByText('You have no syllabus yet')).toBeVisible();
      await expect(page.getByTestId(SID.add)).toHaveCount(0);

      // ---- an outline is previewed (a dry run), and one the schema refuses is not importable ----
      await page.getByTestId(SID.import).click();
      const dialog = dialogOf(page, 'Import an outline');
      await expect(dialog.getByTestId('dialog-confirm')).toHaveAttribute('aria-disabled', 'true');
      await expect(dialog.getByTestId('dialog-confirm')).toHaveAttribute(
        'title',
        'Paste an outline first.',
      );

      await pasteOutline(
        page,
        Array.from({ length: 8 }, (_, i) => `${'  '.repeat(i)}- level ${i + 1}`).join('\n'),
      );
      await expect(dialog.getByTestId(SID.importErrors)).toContainText('Line 7');
      await expect(dialog.getByTestId(SID.importErrors)).toContainText('at most 6 are allowed');
      await expect(dialog.getByTestId('dialog-confirm')).toHaveAttribute('aria-disabled', 'true');
      expect(await syllabusRows(seed.ctrl)).toEqual([]);

      await pasteOutline(page, OUTLINE);
      await expect(dialog.getByTestId(SID.importSummary)).toContainText(
        '6 topics in 2 levels will be created as “Cardiorenal exam”',
      );
      await expect(dialog.getByTestId(SID.importPreview).getByRole('listitem')).toHaveText([
        'Cardiology (weight 3)',
        'Heart failure',
        'Rhythm',
        'Renal (weight 3)',
        'Misc notes',
        'Not started',
      ]);
      expect(await syllabusRows(seed.ctrl), 'a preview saves nothing').toEqual([]);
      expect(await axeReport(page), 'axe: the import dialog').toBe('');
      await dialog.getByTestId('dialog-confirm').click();
      await expect(dialog).toHaveCount(0);

      // ---- the outline is the stored syllabus, in order, with its weights and no mapping -------
      await expect(page.getByTestId(SID.select)).toContainText('Cardiorenal exam');
      await expect(page.getByTestId(SID.size)).toContainText('6 of 500 topics · 2 of 6 levels');
      await expect(topicsTree(page).getByRole('treeitem')).toHaveCount(6);
      await expect
        .poll(async () => (await syllabusRows(seed.ctrl)).length, { message: 'syllabus stored' })
        .toBe(1);
      const stored = (await syllabusRows(seed.ctrl))[0]!;
      expect(stored.name).toBe('Cardiorenal exam');
      expect(stored.nodes.map((n) => [n.title, n.weight ?? null, n.children.length])).toEqual([
        ['Cardiology', 3, 2],
        ['Renal', 3, 0],
        ['Misc notes', null, 0],
        ['Not started', null, 0],
      ]);

      // ---- map banks and tags with the pickers; every change is saved ---------------------------
      await mapTopic(page, 'Heart failure', { banks: ['Cardiology'] });
      await mapTopic(page, 'Renal', { banks: ['Renal'], tags: ['High Yield'] });
      await mapTopic(page, 'Misc notes', { banks: ['Inbox'] });
      await expect
        .poll(async () => {
          const t = await topicsByTitle(seed.ctrl);
          return [
            t.get('Heart failure')?.bankIds,
            t.get('Renal')?.bankIds,
            t.get('Renal')?.tagIds,
            t.get('Misc notes')?.bankIds,
          ];
        })
        .toEqual([[seed.id.cardio], [seed.id.renal], [seed.id.hy], [seed.id.inbox]]);
      await expect(topicItem(page, 'Renal')).toContainText('1 bank, 1 tag');
      await expect(topicItem(page, 'Rhythm')).toContainText('not mapped');

      // ---- keyboard: Alt+Arrow reorders, and the buttons say why a move is not possible ---------
      await topicItem(page, 'Renal').focus();
      await page.keyboard.press('Alt+ArrowUp');
      await expect
        .poll(async () => (await syllabusRows(seed.ctrl))[0]!.nodes.map((n) => n.title))
        .toEqual(['Renal', 'Cardiology', 'Misc notes', 'Not started']);
      await expect(page.getByTestId(SID.up)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByTestId(SID.up)).toHaveAttribute(
        'title',
        'Already the first topic at this level.',
      );
      await page.getByTestId(SID.down).click();
      await expect
        .poll(async () => (await syllabusRows(seed.ctrl))[0]!.nodes.map((n) => n.title))
        .toEqual(['Cardiology', 'Renal', 'Misc notes', 'Not started']);

      // ---- export reads back as the same outline ------------------------------------------------
      const file = await downloadOf(page, () => page.getByTestId(SID.export).click());
      expect(file.name).toBe('Cardiorenal-exam.md');
      expect(file.bytes.toString('utf8')).toBe(
        [
          '# Cardiorenal exam',
          '',
          '- Cardiology (weight 3)',
          '  - Heart failure',
          '  - Rhythm',
          '- Renal (weight 3)',
          '- Misc notes',
          '- Not started',
          '',
        ].join('\n'),
      );

      await topicItem(page, 'Renal').click();
      await expectAxeClean(page, `[data-testid="${SID.view}"]`);
      expect(externalRequests(page), 'the editor made no network request').toEqual([]);
      expect(dashboardErrors(page)).toEqual([]);

      // ---- the coverage on the review page is the seeded vault ---------------------------------
      const review = await openReview(env, { query: '?view=analytics', settings: UTC_DAY });
      const overall = review.getByTestId(SID.rvOverall);
      await expect(overall).toBeVisible();
      await expect(overall).toContainText(
        `${overallText.covered}of the syllabus is covered, by weight`,
      );
      await expect(overall).toContainText(`${overallText.started}has at least some material`);
      await expect(overall).toContainText('2of 6 topics point at no bank or tag yet');

      const lastK1 = await whenText(review, seed.at(-3), 'UTC');
      const lastK3 = await whenText(review, seed.at(-5), 'UTC');
      const want = expectedRows(lastK1, lastK3);
      await expect(review.getByTestId(SID.rvTable)).toBeVisible();
      const got = analyticsTable(await tableRows(review.getByTestId(SID.rvTable)));
      for (const [title, cells] of Object.entries(want)) {
        // The first eight cells; the ninth is the "Show" button.
        expect(got[title]?.slice(0, 8), `row ${title}`).toEqual(cells);
      }
      expect(Object.keys(got)).toHaveLength(6);

      // The chart is the same numbers as text.
      const chart = review.getByTestId(SID.rvChart);
      await expect(chart.getByRole('img')).toContainText(
        '4 top-level topics: 1 covered, 2 thin, 1 with no material',
      );
      expect(await tableRows(chart.locator('table'))).toEqual([
        ['1. Cardiology', '50', '0', '37.5%'],
        ['2. Renal', '100', '0', '37.5%'],
        ['3. Misc notes', '0', '100', '12.5%'],
        ['4. Not started', '0', '0', '12.5%'],
      ]);

      expect(await axeReport(review), 'axe: the coverage section').toBe('');
      expect(reviewErrors(review)).toEqual([]);
    } finally {
      await env.context.setOffline(false);
    }
  });

  test('the table sorts by a column, and the thresholds are adjustable and kept on the device', async ({
    env,
  }) => {
    const seed = await seedSyllabusVault(env);
    await putSyllabus(seed);
    const review = await openReview(env, { query: '?view=analytics', settings: UTC_DAY });
    const overall = review.getByTestId(SID.rvOverall);
    await expect(overall).toContainText(`${overallText.covered}of the syllabus is covered`);
    const table = review.getByTestId(SID.rvTable);

    // Outline order first; then ascending and descending by highlights, then back to the outline.
    const titles = async () =>
      (await tableRows(table)).map((r) => (r[0] ?? '').replace(/ in .*$| \(map a bank.*$/, ''));
    const outline = ['Cardiology', 'Heart failure', 'Rhythm', 'Renal', 'Misc notes', 'Not started'];
    expect(await titles()).toEqual(outline);
    const header = review.getByRole('columnheader', { name: 'Highlights', exact: true });
    await review.getByTestId(sortId('highlights')).click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(await titles()).toEqual([
      'Rhythm',
      'Not started',
      'Misc notes',
      'Cardiology',
      'Heart failure',
      'Renal',
    ]);
    await review.getByTestId(sortId('highlights')).click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    expect((await titles())[0]).toBe('Renal');
    await review.getByTestId(sortId('highlights')).click();
    await expect(header).not.toHaveAttribute('aria-sort', /./);
    expect(await titles()).toEqual(outline);

    // The thresholds are shown, and a nonsense value is refused without saving anything.
    const highlights = review.getByTestId(SID.rvMinHighlights);
    const cards = review.getByTestId(SID.rvMinCards);
    await expect(highlights).toHaveValue('3');
    await expect(cards).toHaveValue('1');
    await expect(review.getByTestId(SID.rvReset)).toHaveAttribute('aria-disabled', 'true');
    await highlights.fill('1.5');
    await highlights.blur();
    await expect(review.getByRole('alert')).toContainText('Use a whole number from 0 to 999');
    expect(await storedThresholds(seed.ctrl)).toBeUndefined();

    // Four highlights are needed: Heart failure (3) is thin now, Renal (4) is still covered.
    await highlights.fill('4');
    await highlights.blur();
    await expect(review.getByTestId(SID.rvStatus)).toContainText(
      'Saved on this device: covered from 4 highlights and 1 card',
    );
    await expect(overall).toContainText('38%of the syllabus is covered');
    await expect(overall).toContainText(`${overallText.started}has at least some material`);
    expect(await storedThresholds(seed.ctrl)).toEqual({ minHighlights: 4, minCards: 1 });
    const lastK1 = await whenText(review, seed.at(-3), 'UTC');
    const lastK3 = await whenText(review, seed.at(-5), 'UTC');
    const want = expectedRows(lastK1, lastK3, 'strict');
    const got = analyticsTable(await tableRows(table));
    for (const title of ['Cardiology', 'Heart failure', 'Renal']) {
      expect(got[title]?.slice(0, 8), `row ${title}`).toEqual(want[title]);
    }

    // It survives a reload (the number is what the page opens with), and resets.
    await review.reload();
    await expect(review.getByTestId(SID.rvMinHighlights)).toHaveValue('4');
    await expect(review.getByTestId(SID.rvOverall)).toContainText('38%of the syllabus is covered');
    await review.getByTestId(SID.rvReset).click();
    await expect(review.getByTestId(SID.rvMinHighlights)).toHaveValue('3');
    await expect(review.getByTestId(SID.rvOverall)).toContainText(
      `${overallText.covered}of the syllabus is covered`,
    );
    await expect.poll(() => storedThresholds(seed.ctrl)).toEqual({ minHighlights: 3, minCards: 1 });
    expect(reviewErrors(review)).toEqual([]);
  });

  test('"Show" opens the dashboard list of exactly the highlights the table counted', async ({
    env,
  }) => {
    const seed = await seedSyllabusVault(env);
    await putSyllabus(seed);
    const review = await openReview(env, { query: '?view=analytics', settings: UTC_DAY });
    await expect(review.getByTestId(SID.rvTable)).toBeVisible();
    const got = analyticsTable(await tableRows(review.getByTestId(SID.rvTable)));
    const { hl } = seed.ds.id;

    // One bank: the list is scoped to the bank.
    const opened = env.context.waitForEvent('page');
    await review.getByRole('button', { name: 'Show highlights of Heart failure' }).click();
    const list = await opened;
    await expect(list.getByTestId('dashboard')).toBeVisible();
    await settle(list);
    expect(new URL(list.url()).searchParams.get('bank')).toBe(seed.id.cardio);
    await expectTotal(list, Number(got['Heart failure']![2]));
    await expectRenderedSet(list, [hl('c1'), hl('c2'), hl('c3')]);

    // A bank and a tag: any of them, each highlight once, the trashed one never.
    await review.bringToFront();
    await review.getByRole('button', { name: 'Show highlights of Renal' }).click();
    await list.waitForURL(/[?&]q=/);
    await expect(list.getByTestId('dashboard')).toBeVisible();
    expect(new URL(list.url()).searchParams.get('q')).toBe('(bank:"Renal" OR tag:"High Yield")');
    await settle(list);
    await expectTotal(list, Number(got.Renal![2]));
    await expectRenderedSet(list, [hl('c3'), hl('r1'), hl('c2'), hl('t1')]);

    // A topic nothing points at offers to map it, never a dead "show".
    await review.bringToFront();
    const rhythm = review.getByRole('button', { name: 'Map a bank or tag to Rhythm' });
    await expect(rhythm).toBeVisible();
    await expect(review.getByRole('button', { name: 'Show highlights of Rhythm' })).toHaveCount(0);
    expect(dashboardErrors(list)).toEqual([]);
  });

  test('reflows at 320 px: the page never scrolls sideways, and what is edited stays on screen', async ({
    env,
  }) => {
    const seed = await seedSyllabusVault(env);
    await putSyllabus(seed);
    const sideways = (page: Page) =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    const review = await openReview(env, { query: '?view=analytics', settings: UTC_DAY });
    await review.setViewportSize({ width: 320, height: 900 });
    await expect(review.getByTestId(SID.rvOverall)).toBeVisible();
    await expect(review.getByTestId(SID.rvMinHighlights)).toBeVisible();
    expect(await sideways(review), 'the review page scrolls sideways').toBeLessThanOrEqual(0);
    const numbers = await review.getByTestId(SID.rvMinHighlights).boundingBox();
    expect(numbers!.x).toBeGreaterThanOrEqual(0);
    expect(numbers!.x + numbers!.width).toBeLessThanOrEqual(320);

    const page = await openDashboard(env, {}, { settle: false });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${dashboardHref(env)}?view=syllabus`);
    await expect(page.getByTestId(SID.view)).toBeVisible();
    await topicItem(page, 'Renal').click();
    await expect(page.getByTestId(SID.title)).toHaveValue('Renal');
    expect(await sideways(page), 'the dashboard scrolls sideways').toBeLessThanOrEqual(0);
    for (const id of [SID.title, SID.weight, SID.show]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.x, id).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, id).toBeLessThanOrEqual(320);
    }
  });

  test('a syllabus is deleted with an Undo, and "Delete all data" removes syllabi and thresholds', async ({
    env,
  }) => {
    const seed = await seedSyllabusVault(env);
    const id = await putSyllabus(seed);
    const page = await openDashboard(env, {}, { settle: false });
    await page.getByTestId('view-syllabus').click();
    await expect(page.getByTestId(SID.select)).toContainText('Cardiorenal exam');

    // Rename, then delete: the editor goes, Undo brings it back as it was.
    await page.getByTestId(SID.rename).click();
    const rename = dialogOf(page, 'Rename syllabus');
    await rename.getByTestId('name-input').fill('Final exam');
    await rename.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId(SID.select)).toContainText('Final exam');
    await expect.poll(async () => (await syllabusRows(seed.ctrl))[0]?.name).toBe('Final exam');

    await page.getByTestId(SID.remove).click();
    await expect(page.getByText('You have no syllabus yet')).toBeVisible();
    await expect(toast(page, /Deleted the syllabus “Final exam”/)).toBeVisible();
    expect((await syllabusRows(seed.ctrl))[0]!.deletedAt).not.toBeNull();
    await toast(page, /Deleted the syllabus/)
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(page.getByTestId(SID.select)).toContainText('Final exam');
    await expect(topicsTree(page).getByRole('treeitem')).toHaveCount(6);
    await expect.poll(async () => (await syllabusRows(seed.ctrl))[0]!.deletedAt).toBeNull();
    // Nothing was lost on the way: same topics, same mapping.
    const topics = await topicsByTitle(seed.ctrl);
    expect(topics.get('Renal')).toMatchObject({
      id: topicId('renal'),
      weight: 3,
      bankIds: [seed.id.renal],
      tagIds: [seed.id.hy],
    });
    expect((await syllabusRows(seed.ctrl))[0]!.id).toBe(id);

    // A threshold is kept on this device (in the meta table, not in backups).
    const review = await openReview(env, { query: '?view=analytics', settings: UTC_DAY });
    await expect(review.getByTestId(SID.rvOverall)).toBeVisible();
    await review.getByTestId(SID.rvMinCards).fill('2');
    await review.getByTestId(SID.rvMinCards).blur();
    await expect.poll(() => storedThresholds(seed.ctrl)).toEqual({ minHighlights: 3, minCards: 2 });

    // "Delete all data" removes the syllabus, its deleted copies and the thresholds with the vault.
    const options = await openBackupPage(env);
    await deleteAllData(options);
    const control = await openControl(env);
    expect(await syllabusRows(control)).toEqual([]);
    expect(await storedThresholds(control)).toBeUndefined();
    expect(await readTable(control, 'cards')).toEqual([]);

    const empty = await openReview(env, { query: '?view=analytics', settings: UTC_DAY });
    await expect(empty.getByTestId(SID.rvEmpty)).toContainText('A syllabus is your own outline');
    await expect(empty.getByTestId(SID.rvCreate)).toBeVisible();
    expect(await axeReport(empty), 'axe: the empty coverage section').toBe('');
    expect(reviewErrors(empty)).toEqual([]);
  });
});
