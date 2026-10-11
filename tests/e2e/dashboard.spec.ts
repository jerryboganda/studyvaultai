import type { Locator, Page } from '@playwright/test';
import { HIGHLIGHT_KINDS, MAX_FOLDER_DEPTH, type ResolveStatus } from '@shared';
import {
  BASE_TIME,
  DAY_MS,
  Model,
  buildDataset,
  captureQuote,
  collectIds,
  countTables,
  createBankRpc,
  createBankUi,
  createFolderUi,
  dialogOf,
  ensureVault,
  expect,
  expectAxeClean,
  expectList,
  expectOutline,
  expectResult,
  expectTotal,
  expectTreeCount,
  externalRequests,
  listbox,
  openControl,
  openDashboard,
  openPalette,
  openPreview,
  pageErrors,
  probeOf,
  rawPut,
  readTable,
  recordPerf,
  rowEl,
  runCommand,
  settle,
  storedHighlights,
  summaryTotal,
  test,
  toast,
  treeItem,
  treeMenu,
  treeOf,
  treeOutline,
  writeDataset,
  type DatasetInput,
  type Env,
  type HighlightSpec,
} from './helpers.dashboard';
import { openFixture, saveBlock } from './helpers.pages';
import {
  launchSession,
  markWorker,
  newUserDataDir,
  removeDir,
  stopWorker,
  wakeWorker,
  workerState,
} from './helpers.lifecycle';

// ===============================================================================================
// Shared data
// ===============================================================================================

// The dashboard specs seed a vault, open several extension pages and drive real input; on a busy
// machine that needs more than the suite's 60 s default. Individual waits keep their own bounds.
test.describe.configure({ timeout: 240_000 });

const sourceA = (env: Env) => `${env.origin}/dash-source-a.html`;
const sourceB = (env: Env) => `${env.origin}/dash-source-b.html`;

/** A vault seeded with `input` through the raw writer, ready for the first dashboard load. */
async function seed(env: Env, input: DatasetInput) {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  const ds = buildDataset(input);
  await writeDataset(ctrl, ds);
  return { ctrl, ds, model: new Model(input) };
}

const STATUSES: ResolveStatus[] = ['unchecked', 'resolved', 'changed', 'ambiguous', 'orphaned'];
const TOPICS = ['aorta', 'nephron', 'neuron', 'alveolus', 'sarcomere', 'ribosome', 'lysosome'];

/**
 * 90 highlights over the Inbox and three banks, with folders three levels deep, tags, notes,
 * comments, three trashed rows, two date clusters and all kinds / priorities / statuses. Every
 * attribute is a pure function of the index, so the expected result of a filter is computed from
 * this description and never from the product.
 */
function libraryInput(): DatasetInput {
  const highlights: HighlightSpec[] = [];
  for (let i = 1; i <= 90; i++) {
    const bank = (['inbox', 'cardio', 'renal', 'neuro'] as const)[i % 4]!;
    const places: HighlightSpec['places'] = [];
    if (bank === 'cardio') {
      const folder = [null, 'valves', 'mitral', 'stenosis', 'rhythm'][i % 5] ?? null;
      places.push({ bank, folder });
    } else if (bank === 'renal') {
      places.push({ bank, folder: i % 8 === 2 ? 'gfr' : null });
    } else {
      places.push({ bank });
    }
    if (i % 10 === 0 && bank !== 'cardio') places.push({ bank: 'cardio' });
    const tags: string[] = [];
    if (i % 3 === 0) tags.push('exam');
    if (i % 4 === 1) tags.push('pearl');
    if (i % 5 === 0) tags.push('osce');
    const capturedAt = new Date(BASE_TIME + (i % 28) * DAY_MS + i * 60_000).toISOString();
    highlights.push({
      key: `l${i}`,
      quote: `Library fact ${i} about ${TOPICS[i % TOPICS.length]}.`,
      source: `s${(i % 9) + 1}`,
      places,
      kind: HIGHLIGHT_KINDS[i % 7]!,
      priority: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5,
      status: STATUSES[Math.floor(i / 3) % 5]!,
      comment: i % 7 === 0 ? `Comment ${i}` : '',
      tags,
      notes: i % 6 === 0 ? [{ body: `Note on fact ${i}` }] : [],
      capturedAt,
      updatedAt:
        i % 10 === 0 ? new Date(BASE_TIME + 45 * DAY_MS + i * 60_000).toISOString() : capturedAt,
      trashed: i % 25 === 0,
    });
  }
  return {
    banks: [
      { key: 'cardio', name: 'Cardiology' },
      { key: 'renal', name: 'Renal' },
      { key: 'neuro', name: 'Neurology' },
    ],
    folders: [
      { key: 'valves', bank: 'cardio', name: 'Valves' },
      { key: 'mitral', bank: 'cardio', parent: 'valves', name: 'Mitral' },
      { key: 'stenosis', bank: 'cardio', parent: 'mitral', name: 'Stenosis' },
      { key: 'rhythm', bank: 'cardio', name: 'Rhythm' },
      { key: 'gfr', bank: 'renal', name: 'GFR' },
    ],
    tags: [
      { key: 'exam', name: 'exam' },
      { key: 'pearl', name: 'pearl' },
      { key: 'osce', name: 'osce' },
    ],
    sources: Array.from({ length: 9 }, (_, k) => ({
      key: `s${k + 1}`,
      url: `https://${k % 2 ? 'med' : 'bio'}.example/article-${k + 1}`,
      title: `Article ${k + 1}`,
    })),
    highlights,
  };
}

/** The kind label shown in the Kind filter for a kind id. */
const KIND_NAME: Record<string, string> = {
  essential: 'Essential fact',
  formula: 'Formula',
  exception: 'Exception',
  differential: 'Differential',
  weak_area: 'Weak area',
  correction: 'Correction (checked by you)',
  question: 'Question',
};
const STATUS_NAME: Record<ResolveStatus, string> = {
  unchecked: 'Not checked yet',
  resolved: 'Found on page',
  changed: 'Source changed',
  ambiguous: 'Ambiguous · not painted',
  orphaned: 'Orphaned · not found on page',
};

/** Open a filter popover (a <details>) of the filter bar. */
async function openFilter(page: Page, testId: string) {
  const group = page.getByTestId(testId);
  if ((await group.getAttribute('open')) === null) await group.locator('summary').click();
  await expect(group).toHaveAttribute('open', '');
  return group;
}

async function closeFilters(page: Page) {
  await page.keyboard.press('Escape');
}

const keysOf = (list: HighlightSpec[]) => list.map((h) => h.key);

// ===============================================================================================
// 1. Opening: empty vault, deep links
// ===============================================================================================

test.describe('open: empty vault and deep links', () => {
  test('an empty vault is described honestly in every view', async ({ env }) => {
    const page = await openDashboard(env);

    await expect(page).toHaveTitle('StudyVault AI dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'StudyVault' })).toBeVisible();

    // Library: the only bank is the protected Inbox, with zero highlights.
    await expect(treeItem(page, 'Inbox')).toBeVisible();
    await expectTreeCount(page, 'Inbox', 0);
    await expect(page.getByTestId('view-library')).toHaveText(/All highlights\s*0$/);
    await expect(page.getByText('Your vault is empty')).toBeVisible();
    await expect(page.getByTestId('result-summary')).toContainText('0 highlights');
    await expect(page.getByTestId('preview-empty')).toBeVisible();
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
    await expectOutline(page, ['1:Inbox']);

    // A search that finds nothing says so and offers a way out.
    await page.getByTestId('search-input').fill('zzzzqx');
    await expect(page.getByText('No results for “zzzzqx”')).toBeVisible();
    await page.getByRole('button', { name: 'Clear the search' }).click();
    await expect(page.getByText('Your vault is empty')).toBeVisible();

    // A filter on an empty vault is "no match", not "empty vault".
    const group = page.getByTestId('filter-kind');
    await group.locator('summary').click();
    await group.getByRole('checkbox', { name: 'Formula' }).check();
    await expect(page.getByText('No highlights match these filters').first()).toBeVisible();
    await page.keyboard.press('Escape'); // close the popover that covers the chips
    await page.getByTestId('clear-filters').click();
    await expect(page.getByText('Your vault is empty')).toBeVisible();

    // The other views.
    await page.getByTestId('view-trash').click();
    await expect(page.getByText('The trash is empty')).toBeVisible();
    await page.getByTestId('view-duplicates').click();
    await expect(page.getByText('No duplicates found')).toBeVisible();
    await page.getByTestId('view-storage').click();
    await expect(page.getByTestId('storage-panel')).toBeVisible();
    await expect(page.getByTestId('no-cached-pdfs')).toBeVisible();
    await expect(
      page.getByTestId('storage-table').getByRole('row', { name: /^Highlights\s+0$/ }),
    ).toBeVisible();
    await expect(page.getByTestId('index-summary')).toHaveText('0 documents indexed.');

    expect(pageErrors(page)).toEqual([]);
    expect(externalRequests(page)).toEqual([]);
  });

  test('?q=, ?bank= and ?highlight= open the dashboard on that search, bank and highlight', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const cardio = await createBankRpc(ctrl, 'Cardiology');
    const renal = await createBankRpc(ctrl, 'Renal');
    const aortic = await captureQuote(ctrl, {
      url: sourceA(env),
      title: 'Cardiology primer',
      quote: 'Aortic stenosis narrows the valve outflow tract.',
      bankId: cardio,
      at: 10,
    });
    const mitral = await captureQuote(ctrl, {
      url: sourceA(env),
      title: 'Cardiology primer',
      quote: 'Mitral regurgitation lets blood flow backwards.',
      bankId: cardio,
      at: 200,
    });
    const nephron = await captureQuote(ctrl, {
      url: sourceB(env),
      title: 'Kidney notes',
      quote: 'The nephron filters plasma at the glomerulus.',
      bankId: renal,
      at: 10,
    });

    // ?q= opens in search mode with the text in the box.
    const bySearch = await openDashboard(env, { q: 'nephron' });
    await expect(bySearch.getByTestId('search-input')).toHaveValue('nephron');
    await expectList(bySearch, [nephron.id]);
    await expect(bySearch.getByRole('listbox', { name: 'Search results' })).toBeVisible();

    // ?bank= scopes the list to that bank and marks it in the tree.
    const byBank = await openDashboard(env, { bank: cardio });
    await expect(treeItem(byBank, 'Cardiology')).toHaveAttribute('aria-selected', 'true');
    await expectList(byBank, [mitral.id, aortic.id], { ordered: false });

    // ?highlight= shows that highlight in the preview.
    const byHighlight = await openDashboard(env, { highlight: nephron.id });
    await expect(byHighlight.getByTestId('preview')).toHaveAttribute(
      'data-highlight-id',
      nephron.id,
    );
    await expect(byHighlight.getByTestId('preview-quote')).toHaveText(
      'The nephron filters plasma at the glomerulus.',
    );

    // All three together.
    const all = await openDashboard(env, { q: 'mitral', bank: cardio, highlight: aortic.id });
    await expect(all.getByTestId('search-input')).toHaveValue('mitral');
    await expect(treeItem(all, 'Cardiology')).toHaveAttribute('aria-selected', 'true');
    await expectList(all, [mitral.id]);
    await expect(all.getByTestId('preview-quote')).toHaveText(
      'Aortic stenosis narrows the valve outflow tract.',
    );

    for (const page of [bySearch, byBank, byHighlight, all]) {
      expect(pageErrors(page)).toEqual([]);
    }
  });

  test('a hostile or stale address is ignored or explained, never trusted', async ({ env }) => {
    const hostile = await openDashboard(env, {
      highlight: '../../etc/passwd',
      bank: '<img src=x onerror=window.__svPwned=1>',
      q: 'x'.repeat(600),
    });
    const box = hostile.getByTestId('search-input');
    expect((await box.inputValue()).length).toBeLessThanOrEqual(512);
    await expect(hostile.getByTestId('preview-empty')).toBeVisible();
    await expect(treeOf(hostile).locator('[aria-selected="true"]')).toHaveCount(0);
    expect(await hostile.evaluate(() => (window as { __svPwned?: number }).__svPwned)).toBe(
      undefined,
    );
    expect(pageErrors(hostile)).toEqual([]);

    // A well-formed id that is not in the vault: the preview says so instead of failing silently.
    const missing = await openDashboard(env, { highlight: 'e2e-hl-does-not-exist' });
    await expect(missing.getByTestId('preview-error')).toContainText(
      'This highlight is no longer here',
    );
    expect(pageErrors(missing)).toEqual([]);
  });
});

// ===============================================================================================
// 2. The bank / folder tree
// ===============================================================================================

test.describe('tree: banks, folders, topics', () => {
  test('creates a bank, folder, topic and subtopic through the UI and keeps them after a reload', async ({
    env,
  }) => {
    const page = await openDashboard(env);
    await createBankUi(page, 'Cardiology');
    await expect(toast(page, 'Created bank Cardiology.')).toBeVisible();
    await createFolderUi(page, 'Cardiology', 'Valves');
    await createFolderUi(page, 'Valves', 'Mitral');
    await createFolderUi(page, 'Mitral', 'Stenosis');

    const outline = ['1:Inbox', '1:Cardiology', '2:Valves', '3:Mitral', '4:Stenosis'];
    await expectOutline(page, outline);

    // The stored folders form that chain inside one bank.
    const ctrl = await openControl(env);
    const folders = await readTable<{
      id: string;
      name: string;
      bankId: string;
      parentFolderId: string | null;
    }>(ctrl, 'folders');
    const byName = new Map(folders.map((f) => [f.name, f]));
    expect(byName.get('Valves')!.parentFolderId).toBeNull();
    expect(byName.get('Mitral')!.parentFolderId).toBe(byName.get('Valves')!.id);
    expect(byName.get('Stenosis')!.parentFolderId).toBe(byName.get('Mitral')!.id);
    expect(new Set(folders.map((f) => f.bankId)).size).toBe(1);

    await page.reload();
    await settle(page);
    await expectOutline(page, outline);
    expect(pageErrors(page)).toEqual([]);
  });

  test('refuses blank names and over-long names in the name dialog', async ({ env }) => {
    const page = await openDashboard(env);
    await page.getByTestId('new-bank').click();
    const dialog = dialogOf(page, 'New bank');
    const input = dialog.getByTestId('name-input');
    const confirm = dialog.getByTestId('dialog-confirm');

    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await input.fill('   ');
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await input.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(treeOf(page).getByRole('treeitem')).toHaveCount(1);

    await expect(input).toHaveAttribute('maxlength', '80');
    await input.fill('');
    await input.pressSequentially('B'.repeat(95));
    expect((await input.inputValue()).length).toBe(80);

    await dialog.getByTestId('dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(treeOf(page).getByRole('treeitem')).toHaveCount(1);
  });

  test('folders can be nested eight levels deep and no further', async ({ env }) => {
    const folders = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => ({
      key: `lvl${i + 1}`,
      bank: 'deep',
      parent: i === 0 ? null : `lvl${i}`,
      name: `Level ${i + 1}`,
    }));
    await seed(env, {
      banks: [{ key: 'deep', name: 'Deep' }],
      folders,
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [],
    });
    const page = await openDashboard(env);
    await expect
      .poll(async () => (await treeOutline(page)).at(-1), { timeout: 15_000 })
      .toBe(`${MAX_FOLDER_DEPTH + 1}:Level ${MAX_FOLDER_DEPTH}`);

    await treeItem(page, `Level ${MAX_FOLDER_DEPTH}`).click({ button: 'right' });
    const item = page.getByRole('menu').getByRole('menuitem', { name: /New subfolder/ });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toContainText('at most 8 levels deep');
    await item.click({ force: true }); // a disabled item explains itself and does nothing
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // One level up the same action is offered.
    await treeItem(page, `Level ${MAX_FOLDER_DEPTH - 1}`).click({ button: 'right' });
    await expect(
      page.getByRole('menu').getByRole('menuitem', { name: /New subfolder/ }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('renames with F2, keeps the highlights and returns focus to the node', async ({ env }) => {
    const { ds } = await seed(env, {
      banks: [{ key: 'cardio', name: 'Cardiology' }],
      folders: [{ key: 'valves', bank: 'cardio', name: 'Valves' }],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [
        {
          key: 'h1',
          quote: 'Valves keep blood moving one way.',
          source: 's',
          places: [{ bank: 'cardio', folder: 'valves' }],
        },
      ],
    });
    const page = await openDashboard(env);
    await treeItem(page, 'Valves').click();
    await expect(treeItem(page, 'Valves')).toHaveAttribute('aria-selected', 'true');

    // Escape cancels and focus goes back to the node.
    await page.keyboard.press('F2');
    const dialog = dialogOf(page, 'Rename folder');
    const input = dialog.getByTestId('name-input');
    await expect(input).toHaveValue('Valves');
    await input.fill('Heart valves');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(treeItem(page, 'Valves')).toBeFocused();

    // Enter saves.
    await page.keyboard.press('F2');
    await input.fill('Heart valves');
    await input.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Renamed to Heart valves.')).toBeVisible();
    await expect(treeItem(page, 'Heart valves')).toBeVisible();
    await expect(treeItem(page, 'Valves')).toHaveCount(0);
    await expect(treeItem(page, 'Heart valves')).toBeFocused();

    // The highlight is still filed there, and the new name is what the list scope uses.
    await expectTreeCount(page, 'Heart valves', 1);
    await expectList(page, [ds.id.hl('h1')]);
    await page.reload();
    await settle(page);
    await expect(treeItem(page, 'Heart valves')).toHaveAttribute('aria-selected', 'false');
    await expectTreeCount(page, 'Heart valves', 1);
  });

  test('reorders, indents and outdents with Alt+Arrow and keeps focus on the moved node', async ({
    env,
  }) => {
    await seed(env, {
      banks: [
        { key: 'alpha', name: 'Alpha' },
        { key: 'beta', name: 'Beta' },
        { key: 'gamma', name: 'Gamma' },
      ],
      folders: [
        { key: 'one', bank: 'alpha', name: 'One' },
        { key: 'two', bank: 'alpha', name: 'Two' },
        { key: 'twochild', bank: 'alpha', parent: 'two', name: 'TwoChild' },
        { key: 'three', bank: 'alpha', name: 'Three' },
      ],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [],
    });
    const page = await openDashboard(env);
    const outline = () => treeOutline(page);
    await expect
      .poll(outline)
      .toEqual([
        '1:Inbox',
        '1:Alpha',
        '2:One',
        '2:Two',
        '3:TwoChild',
        '2:Three',
        '1:Beta',
        '1:Gamma',
      ]);

    // Banks: Beta moves above Alpha, then cannot pass the Inbox.
    await treeItem(page, 'Beta').click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect
      .poll(outline)
      .toEqual([
        '1:Inbox',
        '1:Beta',
        '1:Alpha',
        '2:One',
        '2:Two',
        '3:TwoChild',
        '2:Three',
        '1:Gamma',
      ]);
    await expect(treeItem(page, 'Beta')).toBeFocused();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(toast(page, 'The Inbox always stays first.')).toBeVisible();
    await expect(treeItem(page, 'Beta')).toBeFocused();
    // ...and keeps moving with further presses without clicking again.
    await page.keyboard.press('Alt+ArrowDown');
    await expect
      .poll(outline)
      .toEqual([
        '1:Inbox',
        '1:Alpha',
        '2:One',
        '2:Two',
        '3:TwoChild',
        '2:Three',
        '1:Beta',
        '1:Gamma',
      ]);
    await page.keyboard.press('Alt+ArrowDown');
    await expect
      .poll(outline)
      .toEqual([
        '1:Inbox',
        '1:Alpha',
        '2:One',
        '2:Two',
        '3:TwoChild',
        '2:Three',
        '1:Gamma',
        '1:Beta',
      ]);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(toast(page, 'Already last.')).toBeVisible();

    // Folders: reorder among siblings, indent under the sibling above, outdent again.
    await treeItem(page, 'Two').click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect
      .poll(outline)
      .toEqual([
        '1:Inbox',
        '1:Alpha',
        '2:Two',
        '3:TwoChild',
        '2:One',
        '2:Three',
        '1:Gamma',
        '1:Beta',
      ]);
    await treeItem(page, 'One').click();
    await page.keyboard.press('Alt+ArrowRight');
    await expect
      .poll(outline)
      .toEqual([
        '1:Inbox',
        '1:Alpha',
        '2:Two',
        '3:TwoChild',
        '3:One',
        '2:Three',
        '1:Gamma',
        '1:Beta',
      ]);
    await expect(treeItem(page, 'One')).toBeFocused();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect
      .poll(outline)
      .toEqual([
        '1:Inbox',
        '1:Alpha',
        '2:Two',
        '3:TwoChild',
        '2:One',
        '2:Three',
        '1:Gamma',
        '1:Beta',
      ]);

    // Refusals say why.
    await treeItem(page, 'Two').click();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(toast(page, 'There is no folder above to move this one into.')).toBeVisible();
    await treeItem(page, 'Alpha').click();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(toast(page, 'Banks are top-level; only folders can be nested.')).toBeVisible();

    // Everything is stored, not just painted.
    await page.reload();
    await settle(page);
    await expect
      .poll(outline)
      .toEqual([
        '1:Inbox',
        '1:Alpha',
        '2:Two',
        '3:TwoChild',
        '2:One',
        '2:Three',
        '1:Gamma',
        '1:Beta',
      ]);
    expect(pageErrors(page)).toEqual([]);
  });

  test('arrow keys expand, collapse and move through the tree, and collapse survives a reload', async ({
    env,
  }) => {
    await seed(env, {
      banks: [{ key: 'alpha', name: 'Alpha' }],
      folders: [
        { key: 'one', bank: 'alpha', name: 'One' },
        { key: 'two', bank: 'alpha', parent: 'one', name: 'Two' },
      ],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [],
    });
    const page = await openDashboard(env);
    await treeItem(page, 'Alpha').focus();
    await expect(treeItem(page, 'Alpha')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(treeItem(page, 'Alpha')).toHaveAttribute('aria-expanded', 'false');
    await expectOutline(page, ['1:Inbox', '1:Alpha']);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(treeItem(page, 'One')).toBeFocused();
    await page.keyboard.press('End');
    await expect(treeItem(page, 'Two')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(treeItem(page, 'Inbox')).toBeFocused();

    await treeItem(page, 'Alpha').focus();
    await page.keyboard.press('ArrowLeft');
    await page.reload();
    await settle(page);
    await expectOutline(page, ['1:Inbox', '1:Alpha']);
  });

  test('moves a folder to another bank with its highlights', async ({ env }) => {
    const { ds } = await seed(env, {
      banks: [
        { key: 'srcb', name: 'From bank' },
        { key: 'dstb', name: 'To bank' },
      ],
      folders: [{ key: 'mv', bank: 'srcb', name: 'Travelling' }],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [
        {
          key: 'm1',
          quote: 'First travelling fact.',
          source: 's',
          places: [{ bank: 'srcb', folder: 'mv' }],
        },
        {
          key: 'm2',
          quote: 'Second travelling fact.',
          source: 's',
          places: [{ bank: 'srcb', folder: 'mv' }],
        },
      ],
    });
    const page = await openDashboard(env);
    await expectTreeCount(page, 'From bank', 2);
    await treeMenu(page, 'Travelling', /^Move to/);
    const dialog = dialogOf(page, 'Move folder “Travelling”');
    await dialog.getByTestId('place-bank').selectOption(ds.id.bank('dstb'));
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Moved “Travelling”.')).toBeVisible();

    await expect
      .poll(() => treeOutline(page))
      .toEqual(['1:Inbox', '1:From bank', '1:To bank', '2:Travelling']);
    await expectTreeCount(page, 'From bank', 0);
    await expectTreeCount(page, 'To bank', 2);
    await expectTreeCount(page, 'Travelling', 2);
    await expect(page.getByTestId('view-library')).toHaveText(/All highlights\s*2$/);
  });

  test('merging banks and folders explains what will happen first, then does exactly that', async ({
    env,
  }) => {
    const { ds } = await seed(env, {
      banks: [
        { key: 'src', name: 'Source' },
        { key: 'tgt', name: 'Target' },
        { key: 'work', name: 'Work' },
      ],
      folders: [
        { key: 'sf', bank: 'src', name: 'Source folder' },
        { key: 'fa', bank: 'work', name: 'Folder A' },
        { key: 'fb', bank: 'work', name: 'Folder B' },
        { key: 'fbc', bank: 'work', parent: 'fb', name: 'Folder B child' },
      ],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [
        {
          key: 'm1',
          quote: 'Merge fact one.',
          source: 's',
          places: [{ bank: 'src', folder: 'sf' }],
        },
        { key: 'm2', quote: 'Merge fact two.', source: 's', places: [{ bank: 'src' }] },
        {
          key: 'm3',
          quote: 'Merge fact three.',
          source: 's',
          places: [{ bank: 'src' }, { bank: 'tgt' }],
        },
        { key: 'm4', quote: 'Merge fact four.', source: 's', places: [{ bank: 'tgt' }] },
        { key: 'm5', quote: 'Merge fact five.', source: 's', places: [{ bank: 'tgt' }] },
        {
          key: 'w1',
          quote: 'Work fact one.',
          source: 's',
          places: [{ bank: 'work', folder: 'fa' }],
        },
        {
          key: 'w2',
          quote: 'Work fact two.',
          source: 's',
          places: [{ bank: 'work', folder: 'fa' }],
        },
        {
          key: 'w3',
          quote: 'Work fact three.',
          source: 's',
          places: [{ bank: 'work', folder: 'fb' }],
        },
        {
          key: 'w4',
          quote: 'Work fact four.',
          source: 's',
          places: [{ bank: 'work', folder: 'fbc' }],
        },
      ],
    });
    const page = await openDashboard(env);
    await expectTotal(page, 9);

    // ---- bank into bank
    await treeMenu(page, 'Source', /^Merge into another bank/);
    let dialog = dialogOf(page, 'Merge bank “Source”');
    await dialog.getByTestId('merge-target').selectOption(ds.id.bank('tgt'));
    const explain = dialog.getByTestId('merge-explain');
    await expect(explain).toContainText(
      'Every folder and 3 highlights of “Source” move into “Target”.',
    );
    await expect(explain).toContainText(
      '“Source” is then removed (it goes to the Trash). Highlights already in “Target” are not duplicated.',
    );
    // Cancelling changes nothing.
    await dialog.getByTestId('dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expectTreeCount(page, 'Source', 3);
    await expectTreeCount(page, 'Target', 3);

    await treeMenu(page, 'Source', /^Merge into another bank/);
    dialog = dialogOf(page, 'Merge bank “Source”');
    await dialog.getByTestId('merge-target').selectOption(ds.id.bank('tgt'));
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(
      toast(page, 'Merged “Source” into “Target”: 3 highlights and 1 folder moved.'),
    ).toBeVisible();
    await expect(treeItem(page, 'Source')).toHaveCount(0);
    await expectTreeCount(page, 'Target', 5);
    await expect.poll(() => treeOutline(page)).toContain('2:Source folder');
    await expect(page.getByTestId('view-library')).toHaveText(/All highlights\s*9$/);

    // ---- folder into folder
    await treeMenu(page, 'Folder B', /^Merge into another folder/);
    dialog = dialogOf(page, 'Merge folder “Folder B”');
    await dialog.getByTestId('merge-target').selectOption(ds.id.folder('fa'));
    await expect(dialog.getByTestId('merge-explain')).toContainText(
      '1 highlight and 1 subfolder move from “Folder B” into “Folder A”.',
    );
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(
      toast(page, 'Merged “Folder B” into “Folder A”: 1 highlight and 1 folder moved.'),
    ).toBeVisible();
    await expect(treeItem(page, 'Folder B')).toHaveCount(0);
    await expectTreeCount(page, 'Folder A', 4);

    // The merged-away bank and folder are in the trash, restorable.
    await page.getByTestId('view-trash').click();
    const list = page.getByTestId('trash-list');
    await expect(list).toContainText('Source');
    await expect(list).toContainText('Folder B');
    expect(pageErrors(page)).toEqual([]);
  });

  test('deleting a bank re-homes its highlights to the Inbox; nothing is lost and all are findable', async ({
    env,
  }) => {
    const { ds } = await seed(env, {
      banks: [
        { key: 'tmp', name: 'Temp' },
        { key: 'keep', name: 'Keep' },
      ],
      folders: [{ key: 'tf', bank: 'tmp', name: 'Temp folder' }],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [
        {
          key: 't1',
          quote: 'Zebrafish embryos are transparent.',
          source: 's',
          places: [{ bank: 'tmp', folder: 'tf' }],
        },
        {
          key: 't2',
          quote: 'Zebrafish regenerate heart tissue.',
          source: 's',
          places: [{ bank: 'tmp' }],
        },
        {
          key: 't3',
          quote: 'Zebrafish share genes with humans.',
          source: 's',
          places: [{ bank: 'tmp' }, { bank: 'keep' }],
        },
        { key: 'i1', quote: 'An unrelated inbox fact.', source: 's' },
      ],
    });
    const page = await openDashboard(env);
    await treeItem(page, 'Temp').click();
    await expectList(page, [ds.id.hl('t3'), ds.id.hl('t2'), ds.id.hl('t1')], { ordered: false });

    await treeItem(page, 'Temp').press('Delete');
    const dialog = dialogOf(page, 'Delete bank “Temp”?');
    const lines = dialog.getByTestId('explain-lines');
    await expect(lines).toContainText(
      '3 highlights are filed in “Temp”. Those that are not also in another bank are filed in the Inbox; none are deleted.',
    );
    await expect(lines).toContainText('1 top-level folder');
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Deleted Temp. It is in the Trash.')).toBeVisible();

    // The bank is gone from the tree, the list left the deleted bank, nothing was deleted.
    await expect(treeItem(page, 'Temp')).toHaveCount(0);
    await expect(page.getByTestId('view-library')).toHaveText(/All highlights\s*4$/);
    await expectTreeCount(page, 'Inbox', 3); // i1 + t1 + t2 (t3 stays in Keep)
    await expectTreeCount(page, 'Keep', 1);

    // ...and they are findable: by browsing the Inbox and by search.
    await treeItem(page, 'Inbox').click();
    await expectList(page, [ds.id.hl('i1'), ds.id.hl('t1'), ds.id.hl('t2')], { ordered: false });
    await page.getByTestId('search-input').fill('zebrafish');
    await expectList(page, [ds.id.hl('t1'), ds.id.hl('t2')], { ordered: false });
    await treeItem(page, 'Keep').click();
    await expectList(page, [ds.id.hl('t3')], { ordered: false });

    const stored = await storedHighlights(await openControl(env));
    expect(stored.filter((h) => h.deletedAt !== null)).toEqual([]);

    // The bank can be restored from the trash.
    await page.getByTestId('search-input').fill('');
    await page.getByTestId('view-trash').click();
    await page.getByTestId('trash-list').getByRole('checkbox', { name: /Temp/ }).first().check();
    await page.getByTestId('trash-restore').click();
    await expect(page.getByTestId('trash-outcome')).toContainText('Restored');
    await expect(treeItem(page, 'Temp')).toBeVisible();
  });

  test('deleting a folder moves its highlights and subfolders up a level', async ({ env }) => {
    const { ds } = await seed(env, {
      banks: [{ key: 'b', name: 'Bank' }],
      folders: [
        { key: 'top', bank: 'b', name: 'Top' },
        { key: 'mid', bank: 'b', parent: 'top', name: 'Middle' },
        { key: 'leaf', bank: 'b', parent: 'mid', name: 'Leaf' },
      ],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [
        {
          key: 'a',
          quote: 'Fact in the middle folder.',
          source: 's',
          places: [{ bank: 'b', folder: 'mid' }],
        },
        {
          key: 'c',
          quote: 'Fact in the leaf folder.',
          source: 's',
          places: [{ bank: 'b', folder: 'leaf' }],
        },
      ],
    });
    const page = await openDashboard(env);
    await treeItem(page, 'Middle').click();
    await page.keyboard.press('Delete');
    const dialog = dialogOf(page, 'Delete folder “Middle”?');
    await expect(dialog.getByTestId('explain-lines')).toContainText(
      '1 highlight filed directly in “Middle” stay in Bank and move to its parent folder.',
    );
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(() => treeOutline(page)).toEqual(['1:Inbox', '1:Bank', '2:Top', '3:Leaf']);
    // The deleted folder was the scope; the list fell back to its parent and still has both.
    await expectTreeCount(page, 'Top', 2);
    await treeItem(page, 'Top').click();
    await expectList(page, [ds.id.hl('a'), ds.id.hl('c')], { ordered: false });
  });

  test('the Inbox is protected from rename, delete, merge and reorder', async ({ env }) => {
    await seed(env, {
      banks: [{ key: 'other', name: 'Other' }],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [{ key: 'h', quote: 'An inbox fact.', source: 's' }],
    });
    const page = await openDashboard(env);
    await treeItem(page, 'Inbox').click();

    await page.keyboard.press('F2');
    await expect(toast(page, 'The Inbox cannot be renamed.')).toBeVisible();
    await page.keyboard.press('Delete');
    await expect(toast(page, 'The Inbox cannot be deleted.')).toBeVisible();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(toast(page, 'The Inbox always stays first.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The context menu offers the actions but disables them with the reason.
    await treeItem(page, 'Inbox').click({ button: 'right' });
    const menu = page.getByRole('menu');
    for (const [name, reason] of [
      [/^Rename/, 'The Inbox cannot be renamed.'],
      [/^Delete bank/, 'The Inbox cannot be deleted.'],
      [/^Merge into another bank/, 'The Inbox cannot be merged into another bank.'],
      [/^Move up/, 'The Inbox always stays first.'],
    ] as const) {
      const item = menu.getByRole('menuitem', { name });
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item).toContainText(reason);
    }
    await page.keyboard.press('Escape');

    // The palette commands answer the same way.
    await runCommand(page, 'node-rename');
    await expect(toast(page, 'The Inbox cannot be renamed.').first()).toBeVisible();

    // Nothing changed in the vault.
    const banks = await readTable<{ id: string; name: string; deletedAt: string | null }>(
      await openControl(env),
      'banks',
    );
    const inbox = banks.find((b) => b.id === 'inbox-default');
    expect(inbox?.name).toBe('Inbox');
    expect(inbox?.deletedAt).toBeNull();
    await expectOutline(page, ['1:Inbox', '1:Other']);
  });
});

/** Id of the first saved search in the vault (the palette lists it as "saved-<id>"). */
async function readSavedId(ctrl: Page): Promise<string> {
  const meta = await readTable<{ key: string; value: string }>(ctrl, 'meta');
  const raw = meta.find((m) => m.key === 'savedSearches')?.value ?? '{"items":[]}';
  return (JSON.parse(raw) as { items: Array<{ id: string }> }).items[0]!.id;
}

// ===============================================================================================
// 3. List: scope, filters, sort, counts
// ===============================================================================================

const localDay = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

test.describe('list: scope, filters, sort, counts', () => {
  test('bank and folder scopes list their whole subtree and every count agrees', async ({
    env,
  }) => {
    const input = libraryInput();
    const { ds, model } = await seed(env, input);
    const page = await openDashboard(env);
    const total = model.live.length;

    await expectResult(page, keysOf(model.live), ds);
    await expect(page.getByTestId('view-library')).toHaveText(
      new RegExp(`All highlights\\s*${total}$`),
    );
    for (const [bank, name] of [
      ['inbox', 'Inbox'],
      ['cardio', 'Cardiology'],
      ['renal', 'Renal'],
      ['neuro', 'Neurology'],
    ] as const) {
      await expectTreeCount(page, name, model.inBank(bank).length);
    }
    for (const [folder, name] of [
      ['valves', 'Valves'],
      ['mitral', 'Mitral'],
      ['stenosis', 'Stenosis'],
      ['rhythm', 'Rhythm'],
      ['gfr', 'GFR'],
    ] as const) {
      await expectTreeCount(page, name, model.inFolder(folder).length);
    }

    await treeItem(page, 'Cardiology').click();
    await expect(treeItem(page, 'Cardiology')).toHaveAttribute('aria-selected', 'true');
    await expectResult(page, keysOf(model.inBank('cardio')), ds);

    // A folder lists its own highlights and those of every folder below it.
    await treeItem(page, 'Valves').click();
    await expectResult(page, keysOf(model.inFolder('valves')), ds);
    await treeItem(page, 'Stenosis').click();
    await expectResult(page, keysOf(model.inFolder('stenosis')), ds);
    await treeItem(page, 'GFR').click();
    await expectResult(page, keysOf(model.inFolder('gfr')), ds);
    await treeItem(page, 'Inbox').click();
    await expectResult(page, keysOf(model.inBank('inbox')), ds);

    // Trashed rows are in no list and in no count.
    const trashed = input.highlights.filter((h) => h.trashed).map((h) => ds.id.hl(h.key));
    await page.getByTestId('view-library').click();
    await expectTotal(page, total);
    expect(await collectIds(page)).not.toEqual(expect.arrayContaining([trashed[0]!]));
    expect(pageErrors(page)).toEqual([]);
  });

  test('tag filter matches any or all of the chosen tags, and the chips and counts say so', async ({
    env,
  }) => {
    const input = libraryInput();
    const { ds, model } = await seed(env, input);
    const page = await openDashboard(env);
    await settle(page);

    const has = (tag: string) => model.live.filter((h) => h.tags?.includes(tag));
    const group = await openFilter(page, 'filter-tags');
    // The tag list shows the number of (live) highlights per tag.
    await expect(
      group.getByRole('checkbox', { name: `exam (${has('exam').length})` }),
    ).toBeVisible();
    await expect(
      group.getByRole('checkbox', { name: `pearl (${has('pearl').length})` }),
    ).toBeVisible();

    await group.getByRole('checkbox', { name: /^exam \(/ }).check();
    await expectResult(page, keysOf(has('exam')), ds);
    await group.getByRole('checkbox', { name: /^pearl \(/ }).check();
    const union = model.live.filter((h) => h.tags?.includes('exam') || h.tags?.includes('pearl'));
    const both = model.live.filter((h) => h.tags?.includes('exam') && h.tags?.includes('pearl'));
    expect(both.length).toBeGreaterThan(0);
    expect(union.length).toBeGreaterThan(both.length);
    await expectResult(page, keysOf(union), ds);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText(
      'Tags (any): exam, pearl',
    );

    await group.getByLabel('Match').selectOption('all');
    await expectResult(page, keysOf(both), ds);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText(
      'Tags (all): exam, pearl',
    );

    await closeFilters(page);
    await page.getByTestId('clear-filters').click();
    await expectTotal(page, model.live.length);
    await expect(page.getByRole('list', { name: 'Active filters' })).toHaveCount(0);
  });

  test('kind, priority, status and note filters narrow the list and combine', async ({ env }) => {
    const input = libraryInput();
    const { ds, model } = await seed(env, input);
    const page = await openDashboard(env);
    await settle(page);
    const live = model.live;

    let group = await openFilter(page, 'filter-kind');
    await group.getByRole('checkbox', { name: KIND_NAME.formula! }).check();
    const formula = live.filter((h) => h.kind === 'formula');
    await expectResult(page, keysOf(formula), ds);
    await group.getByRole('checkbox', { name: KIND_NAME.exception! }).check();
    const two = live.filter((h) => h.kind === 'formula' || h.kind === 'exception');
    await expectResult(page, keysOf(two), ds);
    await group.getByRole('checkbox', { name: KIND_NAME.exception! }).uncheck();

    group = await openFilter(page, 'filter-priority');
    await group.getByRole('checkbox', { name: 'Priority 5 (highest)' }).check();
    const formulaP5 = formula.filter((h) => h.priority === 5);
    expect(formulaP5.length).toBeGreaterThan(0);
    await expectResult(page, keysOf(formulaP5), ds);

    group = await openFilter(page, 'filter-status');
    const status = formulaP5[0]!.status!;
    await group.getByRole('checkbox', { name: STATUS_NAME[status] }).check();
    const formulaP5S = formulaP5.filter((h) => h.status === status);
    await expectResult(page, keysOf(formulaP5S), ds);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText(
      `Status: ${STATUS_NAME[status]}`,
    );

    // Remove one chip at a time: the list widens step by step.
    await closeFilters(page);
    await page.getByRole('button', { name: /^Remove filter Status/ }).click();
    await expectResult(page, keysOf(formulaP5), ds);
    await page.getByRole('button', { name: /^Remove filter Priority/ }).click();
    await expectResult(page, keysOf(formula), ds);
    await page.getByTestId('clear-filters').click();

    // "Has a note" is about note records; a comment alone is not a note.
    group = await openFilter(page, 'filter-note');
    await group.getByLabel('Your note').selectOption('yes');
    await expectResult(page, keysOf(live.filter((h) => (h.notes?.length ?? 0) > 0)), ds);
    await group.getByLabel('Your note').selectOption('no');
    await expectResult(page, keysOf(live.filter((h) => (h.notes?.length ?? 0) === 0)), ds);
    expect(pageErrors(page)).toEqual([]);
  });

  test('date filter uses the viewer’s local days, inclusive at both ends', async ({ env }) => {
    const input = libraryInput();
    const { ds, model } = await seed(env, input);
    const page = await openDashboard(env);
    await settle(page);

    const inRange = (field: 'capturedAt' | 'updatedAt', from: string, to: string) =>
      model.live.filter((h) => {
        const day = localDay(h[field]!);
        return day >= from && day <= to;
      });

    const group = await openFilter(page, 'filter-date');
    await group.getByLabel('From (your local date)').fill('2026-03-05');
    await group.getByLabel('Up to and including').fill('2026-03-09');
    const captured = inRange('capturedAt', '2026-03-05', '2026-03-09');
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.length).toBeLessThan(model.live.length);
    await expectResult(page, keysOf(captured), ds);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText(
      'Captured: 2026-03-05 to 2026-03-09',
    );

    // A single day: both ends are inclusive.
    await group.getByLabel('Up to and including').fill('2026-03-05');
    await expectResult(page, keysOf(inRange('capturedAt', '2026-03-05', '2026-03-05')), ds);

    // "Last updated" is a different clock: only the rows with a later edit fall in April.
    await group.getByLabel('Date to filter by').selectOption('updatedAt');
    await group.getByLabel('Up to and including').fill('2026-04-30');
    await group.getByLabel('From (your local date)').fill('2026-04-10');
    const updated = inRange('updatedAt', '2026-04-10', '2026-04-30');
    expect(updated.length).toBeGreaterThan(0);
    await expectResult(page, keysOf(updated), ds);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText(
      'Updated: 2026-04-10 to 2026-04-30',
    );
  });

  test('sorting orders the whole list by the chosen key', async ({ env }) => {
    const input = libraryInput();
    const { ds, model } = await seed(env, input);
    const page = await openDashboard(env);
    await settle(page);
    const live = model.live;
    const idOf = (h: HighlightSpec) => ds.id.hl(h.key);
    const byCaptured = [...live].sort((a, b) => b.capturedAt!.localeCompare(a.capturedAt!));
    const sort = page.getByTestId('sort-select');

    await expect(sort).toHaveValue('captured-desc');
    await expectList(page, byCaptured.map(idOf));
    await sort.selectOption('captured-asc');
    await expectList(page, [...byCaptured].reverse().map(idOf));
    await sort.selectOption('updated-desc');
    await expectList(
      page,
      [...live]
        .sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!) || idOf(b).localeCompare(idOf(a)))
        .map(idOf),
    );
    await sort.selectOption('priority-desc');
    await expectList(
      page,
      [...live]
        .sort(
          (a, b) =>
            b.priority! - a.priority! ||
            b.capturedAt!.localeCompare(a.capturedAt!) ||
            idOf(b).localeCompare(idOf(a)),
        )
        .map(idOf),
    );
    await sort.selectOption('priority-asc');
    await expectList(
      page,
      [...live]
        .sort(
          (a, b) =>
            a.priority! - b.priority! ||
            a.capturedAt!.localeCompare(b.capturedAt!) ||
            idOf(a).localeCompare(idOf(b)),
        )
        .map(idOf),
    );

    // Search has its own sort set; the choice the search cannot do falls back instead of failing.
    await page.getByTestId('search-input').fill('library');
    await expect(sort.locator('option')).toHaveText([
      'Best match',
      'Recently updated',
      'Priority, high to low',
    ]);
    expect(pageErrors(page)).toEqual([]);
  });
});

// ===============================================================================================
// 3b. Performance: 10,000 highlights
// ===============================================================================================

function bigInput(n: number): DatasetInput {
  const banks = Array.from({ length: 8 }, (_, k) => ({ key: `b${k + 1}`, name: `Bank ${k + 1}` }));
  const folders: NonNullable<DatasetInput['folders']> = [];
  for (const b of banks) {
    folders.push(
      { key: `${b.key}f1`, bank: b.key, name: `${b.name} topic 1` },
      { key: `${b.key}f2`, bank: b.key, parent: `${b.key}f1`, name: `${b.name} topic 2` },
      { key: `${b.key}f3`, bank: b.key, name: `${b.name} topic 3` },
    );
  }
  const highlights: HighlightSpec[] = [];
  for (let i = 1; i <= n; i++) {
    const b = i % 9;
    const bank = b === 0 ? 'inbox' : `b${b}`;
    const folder =
      bank === 'inbox' ? null : ([null, `${bank}f1`, `${bank}f2`, `${bank}f3`][i % 4] ?? null);
    highlights.push({
      key: `p${i}`,
      quote: `Seeded fact ${i} about ${TOPICS[i % TOPICS.length]} in system ${i % 97}.`,
      source: `s${(i % 200) + 1}`,
      places: [{ bank, folder }],
      kind: HIGHLIGHT_KINDS[i % 7]!,
      priority: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5,
      status: STATUSES[Math.floor(i / 3) % 5]!,
      comment: i % 7 === 0 ? `Comment ${i}` : '',
      tags: i % 3 === 0 ? [`t${i % 30}`] : [],
      notes: i % 10 === 0 ? [{ body: `My note on fact ${i}` }] : [],
      capturedAt: new Date(BASE_TIME + i * 60_000).toISOString(),
      trashed: i % 50 === 0,
    });
  }
  return {
    banks,
    folders,
    tags: Array.from({ length: 30 }, (_, k) => ({ key: `t${k}`, name: `tag${k}` })),
    sources: Array.from({ length: 200 }, (_, k) => ({
      key: `s${k + 1}`,
      url: `https://example.org/article/${k + 1}`,
      title: `Article ${k + 1}`,
    })),
    highlights,
  };
}

test.describe('perf: 10,000 highlights', () => {
  test('first paint, windowed scrolling, filtering, search and a bulk change stay responsive', async ({
    env,
  }) => {
    test.setTimeout(900_000);
    const N = 10_000;
    const input = bigInput(N);
    const live = N - N / 50;
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const ds = buildDataset(input, { validate: 'sample' });
    const seeded = Date.now();
    await writeDataset(ctrl, ds, 1_000);
    recordPerf('seed 10,000 highlights (rows written through IndexedDB)', Date.now() - seeded);

    // ---- first paint of the library
    const started = Date.now();
    const page = await openDashboard(env, {}, { settle: true });
    const settled = Date.now() - started;
    const probe = await probeOf(page);
    expect(probe.firstRowAt, 'a row was painted').not.toBeNull();
    recordPerf('library first row in DOM (ms since navigation start)', probe.firstRowAt!);
    recordPerf('library settled (navigation + list + counts)', settled);
    expect(probe.firstRowAt!).toBeLessThan(30_000);
    await expectTotal(page, live);
    await expect(page.getByTestId('view-library')).toHaveText(/All highlights\s*9,800$/);
    await expect(page.getByTestId('result-summary')).toContainText('9,800 highlights, 100 loaded');

    // ---- only a window of rows is in the DOM
    const options = page.locator('[role="option"]');
    const windowed = await options.count();
    expect(windowed).toBeGreaterThan(0);
    expect(windowed).toBeLessThanOrEqual(40);
    await expect(options.first()).toHaveAttribute('aria-setsize', String(live));
    const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    expect(domNodes, 'the whole page stays small').toBeLessThan(2_500);
    recordPerf(`rows in the DOM with ${live} in the list (count, not ms)`, windowed);

    // ---- scrolling to the end of what is loaded loads the next pages, still windowed
    const list = page.getByRole('listbox').first();
    const t0 = Date.now();
    for (let step = 1; step <= 5; step++) {
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(
          async () =>
            /(\d[\d,]*) loaded/.exec(
              (await page.getByTestId('result-summary').textContent()) ?? '',
            )?.[1],
        )
        .toBe(String(100 * (step + 1)));
      expect(await options.count()).toBeLessThanOrEqual(40);
    }
    recordPerf(
      'scroll to the end five times (500 rows loaded, last page included)',
      Date.now() - t0,
    );
    const firstIndex = await options.first().getAttribute('data-index');
    expect(Number(firstIndex)).toBeGreaterThan(400);

    // ---- a filter
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    const formulaRows = Array.from({ length: N }, (_, k) => k + 1).filter(
      (i) => i % 7 === 1 && i % 50 !== 0,
    );
    const formulaCount = formulaRows.length;
    // priority = (i % 5) + 1, so a formula row with i % 5 === 4 already has priority 5. The vault
    // reports only the rows that really changed: "Priority changed on N highlights".
    const willChange = formulaRows.filter((i) => i % 5 !== 4).length;
    expect(willChange).toBeLessThan(formulaCount);
    const filterStart = Date.now();
    const kinds = await openFilter(page, 'filter-kind');
    await kinds.getByRole('checkbox', { name: KIND_NAME.formula! }).check();
    await expectTotal(page, formulaCount);
    recordPerf(`filter by one kind (${formulaCount} rows)`, Date.now() - filterStart);

    // ---- the search index: when it is ready, then a query
    await closeFilters(page);
    await page.getByTestId('clear-filters').click();
    const indexStart = Date.now();
    await page.getByTestId('view-storage').click();
    await expect(page.getByTestId('index-summary')).toHaveText(/^[\d,]+ documents indexed\.$/, {
      timeout: 240_000,
    });
    const indexed = Number(
      ((await page.getByTestId('index-summary').textContent()) ?? '').replace(/\D/g, ''),
    );
    // Every live highlight is indexed, plus the notes (10% have one); trashed highlights stay in
    // the index as tombstones until a rebuild, so the count may go up to every row.
    expect(indexed).toBeGreaterThanOrEqual(live);
    expect(indexed).toBeLessThanOrEqual(N + N / 10);
    recordPerf(
      'search index built (wait counted from opening the storage view)',
      Date.now() - indexStart,
    );
    await page.getByTestId('view-library').click();
    const sarcomere = Array.from({ length: N }, (_, k) => k + 1).filter(
      (i) => TOPICS[i % TOPICS.length] === 'sarcomere' && i % 50 !== 0,
    ).length;
    const searchStart = Date.now();
    await page.getByTestId('search-input').fill('sarcomere');
    await expect(page.getByTestId('result-summary')).toContainText(/^[\d,]+ results/, {
      timeout: 60_000,
    });
    const resultTotal = await summaryTotal(page);
    recordPerf(`search "sarcomere" (${resultTotal} results)`, Date.now() - searchStart);
    expect(resultTotal).toBeGreaterThanOrEqual(sarcomere);
    expect(await options.count()).toBeLessThanOrEqual(40);
    await page.getByTestId('search-input').fill('');

    // ---- select everything that matches and change it
    await kinds.locator('summary').click();
    await kinds.getByRole('checkbox', { name: KIND_NAME.formula! }).check();
    await closeFilters(page);
    await expectTotal(page, formulaCount);
    await list.press('Control+A');
    await page.getByTestId('select-all-filtered').click();
    await expect(page.getByTestId('bulk-count')).toContainText(
      `${formulaCount.toLocaleString('en-US')} selected`,
    );
    const bulkStart = Date.now();
    await page.getByTestId('bulk-priority').click();
    await page
      .getByRole('menu', { name: 'Set priority' })
      .getByRole('menuitem', { name: /^Priority 5/ })
      .click();
    await expect(
      toast(page, `Priority changed on ${willChange.toLocaleString('en-US')} highlights.`),
    ).toBeVisible({ timeout: 120_000 });
    recordPerf(
      `bulk priority change: ${formulaCount} selected, ${willChange} changed`,
      Date.now() - bulkStart,
    );

    const rows = await storedHighlights(ctrl);
    const changed = rows.filter((h) => h.kind === 'formula' && h.deletedAt === null);
    expect(changed.length).toBe(formulaCount);
    expect(changed.every((h) => h.priority === 5)).toBe(true);
    const others = rows.filter((h) => h.kind !== 'formula').slice(0, 500);
    expect(others.some((h) => h.priority !== 5)).toBe(true);
    expect(pageErrors(page)).toEqual([]);
  });
});

// ===============================================================================================
// 4. Search
// ===============================================================================================

function searchInput(): DatasetInput {
  return {
    banks: [
      { key: 'cardio', name: 'Cardiology' },
      { key: 'bio', name: 'Biochemistry' },
      { key: 'renal', name: 'Renal' },
    ],
    folders: [{ key: 'valves', bank: 'cardio', name: 'Valves' }],
    tags: [
      { key: 'exam', name: 'exam' },
      { key: 'pearl', name: 'exam pearl' },
      { key: 'neuroanat', name: 'neuroanatomy' },
      { key: 'neurophys', name: 'neurophysiology' },
    ],
    sources: [
      { key: 'cell', url: 'https://bio.example/cell-energy', title: 'Cell energy' },
      { key: 'heart', url: 'https://med.example/cardiology', title: 'Cardiology primer' },
      {
        key: 'wiki',
        url: 'https://en.wikipedia.org/wiki/Hemoglobin',
        title: 'Hemoglobin - Wikipedia',
      },
    ],
    highlights: [
      {
        key: 'mito',
        quote: 'Mitochondria produce ATP through oxidative phosphorylation.',
        source: 'cell',
        places: [{ bank: 'bio' }],
        kind: 'essential',
        priority: 4,
        tags: ['exam'],
        comment: 'Remember the electron transport chain',
        heading: 'Energy metabolism',
      },
      {
        key: 'sino',
        quote: 'The sinoatrial node is the primary pacemaker of the heart.',
        source: 'heart',
        places: [{ bank: 'cardio', folder: 'valves' }],
        kind: 'essential',
        priority: 5,
        status: 'resolved',
        tags: ['exam', 'pearl'],
      },
      {
        key: 'hemo',
        quote: 'Hemoglobin carries oxygen from the lungs to the tissues.',
        source: 'wiki',
        places: [{ bank: 'bio' }],
        kind: 'essential',
        priority: 2,
        status: 'resolved',
      },
      {
        key: 'mi',
        quote: 'Myocardial infarction results from coronary artery occlusion.',
        source: 'heart',
        places: [{ bank: 'cardio' }],
        kind: 'exception',
        priority: 5,
        status: 'orphaned',
        tags: ['pearl'],
        notes: [{ body: 'Troponin rises within hours of the event' }],
      },
      {
        key: 'beta',
        quote: 'Beta-blockers reduce heart rate and myocardial oxygen demand.',
        source: 'heart',
        places: [{ bank: 'cardio' }],
        kind: 'differential',
        priority: 3,
      },
      {
        key: 'nephron',
        quote: 'The nephron is the functional unit of the kidney.',
        source: 'heart',
        places: [{ bank: 'renal' }],
        kind: 'essential',
        priority: 3,
      },
      {
        key: 'gfr',
        quote:
          'The glomerular filtration rate is normally about one hundred and twenty millilitres per minute.',
        source: 'heart',
        places: [{ bank: 'renal' }],
        kind: 'formula',
        priority: 4,
        status: 'changed',
        tags: ['exam'],
      },
      {
        key: 'neuron',
        quote: 'A neuron transmits electrical signals along its axon.',
        source: 'cell',
        kind: 'question',
        priority: 1,
        status: 'changed',
        tags: ['neuroanat'],
      },
      {
        key: 'synapse',
        quote: 'Chemical synapses release neurotransmitter into the synaptic cleft.',
        source: 'cell',
        kind: 'question',
        priority: 2,
        tags: ['neurophys'],
      },
      {
        key: 'heart2',
        quote: 'The heart has four chambers and pumps blood through two circuits.',
        source: 'heart',
        places: [{ bank: 'cardio' }],
        kind: 'essential',
        priority: 3,
      },
      {
        key: 'aorta',
        quote: 'The aorta is the largest artery in the body.',
        source: 'heart',
        places: [{ bank: 'cardio' }],
        kind: 'essential',
        priority: 3,
      },
      {
        key: 'lungs',
        quote: 'Alveoli exchange oxygen and carbon dioxide.',
        source: 'cell',
        kind: 'essential',
        priority: 3,
        notes: [
          { body: 'Oxygen diffuses across the alveolar wall. Surfactant reduces surface tension.' },
        ],
      },
    ],
  };
}

const keyOfId = (id: string) => id.replace(/^e2e-hl-/, '');

async function runQuery(page: Page, query: string) {
  const box = page.getByTestId('search-input');
  await box.fill(query);
  await expect(box).toHaveValue(query);
}

test.describe('search', () => {
  test('grammar: phrases, field filters, NOT/OR, prefix and typo matching', async ({ env }) => {
    const { ds } = await seed(env, searchInput());
    const page = await openDashboard(env);
    await settle(page);

    const cases: Array<[string, string[]]> = [
      ['heart', ['sino', 'beta', 'heart2']],
      ['"primary pacemaker"', ['sino']],
      ['"pacemaker primary"', []],
      ['heart -rate', ['sino', 'heart2']],
      ['heart NOT rate', ['sino', 'heart2']],
      ['aorta OR nephron', ['aorta', 'nephron']],
      ['(aorta OR nephron) kidney', ['nephron']],
      ['kind:formula', ['gfr']],
      ['bank:Cardiology', ['sino', 'mi', 'beta', 'heart2', 'aorta']],
      ['bank:Cardiology kind:exception', ['mi']],
      ['folder:Valves', ['sino']],
      ['tag:exam', ['mito', 'sino', 'gfr']],
      ['tag:"exam pearl"', ['sino', 'mi']],
      ['tag:neuro*', ['neuron', 'synapse']],
      ['priority:>=5', ['sino', 'mi']],
      ['priority:<2', ['neuron']],
      ['priority:=4', ['mito', 'gfr']],
      ['status:orphaned', ['mi']],
      ['status:changed', ['gfr', 'neuron']],
      ['has:note', ['mito', 'mi', 'lungs']],
      ['has:tag', ['mito', 'sino', 'mi', 'gfr', 'neuron', 'synapse']],
      ['host:wikipedia.org', ['hemo']],
      ['mitochon', ['mito']],
      ['hemoglobn', ['hemo']],
      ['surfactant', ['lungs']],
      // A highlight whose quote AND note match is one result, not two.
      ['oxygen', ['hemo', 'beta', 'lungs']],
      ['oxygen -hemoglobin', ['beta', 'lungs']],
    ];
    const failures: string[] = [];
    for (const [query, expected] of cases) {
      await runQuery(page, query);
      try {
        await expectResult(page, expected, ds);
      } catch {
        const got = (await collectIds(page)).map(keyOfId);
        failures.push(
          `${query}  expected ${JSON.stringify(expected)} got ${JSON.stringify(got)} (summary: ${await page.getByTestId('result-summary').textContent()})`,
        );
      }
    }
    expect(failures).toEqual([]);
    expect(pageErrors(page)).toEqual([]);
  });

  test('a match inside a note says so, and matched words are marked as text', async ({ env }) => {
    const { ds } = await seed(env, searchInput());
    const page = await openDashboard(env);
    await runQuery(page, 'surfactant');
    await expectResult(page, ['lungs'], ds);
    const row = rowEl(page, ds.id.hl('lungs'));
    await expect(row).toContainText('Matched a note');
    await expect(row.locator('mark').first()).toHaveText(/surfactant/i);

    await runQuery(page, 'nephron');
    await expectResult(page, ['nephron'], ds);
    await expect(rowEl(page, ds.id.hl('nephron')).locator('mark')).toHaveText('nephron');
  });

  test('warnings explain a query that is only partly understood', async ({ env }) => {
    await seed(env, searchInput());
    const page = await openDashboard(env);
    await settle(page);
    const warnings = page.getByTestId('search-warnings');

    await runQuery(page, 'aorta colour:red');
    await expect(warnings).toBeVisible();
    await expect(warnings.locator('li')).not.toHaveCount(0);
    await runQuery(page, '"aorta');
    await expect(warnings).toBeVisible();
    await runQuery(page, '(aorta');
    await expect(warnings).toBeVisible();
    await runQuery(page, 'aorta');
    await expect(warnings).toHaveCount(0);

    // The syntax help lists examples and each "Use" puts one into the box.
    await runQuery(page, '');
    await page.getByTestId('search-help-toggle').click();
    const help = page.getByTestId('search-help');
    await expect(help).toBeVisible();
    await help.getByRole('button', { name: 'Use' }).first().click();
    await expect(page.getByTestId('search-input')).toHaveValue('cell membrane');
  });

  test('facets count the whole result and a click narrows it by adding or removing a filter', async ({
    env,
  }) => {
    const { ds } = await seed(env, searchInput());
    const page = await openDashboard(env);
    await runQuery(page, 'oxygen');
    await expectResult(page, ['hemo', 'beta', 'lungs'], ds);

    const banks = page.getByTestId('facet-bank');
    await expect(banks).toHaveCount(3);
    await expect(page.getByTestId('facet-bank').filter({ hasText: 'Biochemistry' })).toContainText(
      '1',
    );
    await expect(page.getByTestId('facet-bank').filter({ hasText: 'Cardiology' })).toContainText(
      '1',
    );

    const chip = page.getByTestId('facet-bank').filter({ hasText: 'Biochemistry' });
    await chip.click();
    await expect(page.getByTestId('search-input')).toHaveValue('oxygen bank:"Biochemistry"');
    await expectResult(page, ['hemo'], ds);
    await expect(
      page.getByTestId('facet-bank').filter({ hasText: 'Biochemistry' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('facet-bank').filter({ hasText: 'Biochemistry' }).click();
    await expect(page.getByTestId('search-input')).toHaveValue('oxygen');
    await expectResult(page, ['hemo', 'beta', 'lungs'], ds);

    // Tag facets combine with the grammar's own OR without changing its meaning.
    await runQuery(page, 'aorta OR sinoatrial');
    await expectResult(page, ['aorta', 'sino'], ds);
    await page.getByTestId('facet-bank').filter({ hasText: 'Cardiology' }).click();
    await expect(page.getByTestId('search-input')).toHaveValue(
      '(aorta OR sinoatrial) bank:"Cardiology"',
    );
    await expectResult(page, ['aorta', 'sino'], ds);
  });

  test('"did you mean" offers the nearest indexed word and applies it on a click', async ({
    env,
  }) => {
    const { ds } = await seed(env, searchInput());
    const page = await openDashboard(env);
    await runQuery(page, 'mitochondira');
    const hint = page.getByTestId('did-you-mean');
    await expect(hint).toBeVisible();
    await expect(hint.getByRole('button')).toHaveText('mitochondria');
    await hint.getByRole('button').click();
    await expect(page.getByTestId('search-input')).toHaveValue('mitochondria');
    await expectResult(page, ['mito'], ds);
    await expect(page.getByTestId('did-you-mean')).toHaveCount(0);
  });

  test('a saved search survives a reload, runs on a click and can be deleted', async ({ env }) => {
    const { ds, ctrl } = await seed(env, searchInput());
    const page = await openDashboard(env);

    // Saving needs a query and a name.
    const save = page.getByTestId('saved-search-save');
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await runQuery(page, 'heart');
    await expect(save).toHaveAttribute('aria-disabled', 'true'); // still no name
    await page.getByTestId('saved-search-name').fill('Heart items');
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    await save.click();
    await expect(page.getByTestId('saved-search-run')).toHaveText('Heart items');

    // A second one with the same name is refused with the reason.
    await page.getByTestId('saved-search-name').fill('heart items');
    await save.click();
    await expect(page.getByRole('alert').filter({ hasText: 'already exists' })).toBeVisible();
    await expect(page.getByTestId('saved-search-run')).toHaveCount(1);

    // Stored in the vault, not just in the page.
    const meta = await readTable<{ key: string; value: unknown }>(ctrl, 'meta');
    expect(JSON.stringify(meta.find((m) => m.key === 'savedSearches')?.value)).toContain(
      'Heart items',
    );

    await page.reload();
    await settle(page);
    await expect(page.getByTestId('saved-search-run')).toHaveText('Heart items');
    await expect(page.getByTestId('search-input')).toHaveValue('');
    await page.getByTestId('saved-search-run').click();
    await expect(page.getByTestId('search-input')).toHaveValue('heart');
    await expectResult(page, ['sino', 'beta', 'heart2'], ds);
    await expect(page.getByTestId('saved-search-run')).toHaveAttribute('title', 'heart');

    // The palette lists it too.
    await runCommand(page, `saved-${await readSavedId(ctrl)}`);
    await page.getByTestId('saved-search-delete').click();
    await expect(page.getByTestId('saved-search-run')).toHaveCount(0);
    await page.reload();
    await settle(page);
    await expect(page.getByTestId('saved-search-run')).toHaveCount(0);
  });

  test('works offline: search, browse, preview and edit need no network', async ({ env }) => {
    const { ds } = await seed(env, searchInput());
    await env.context.setOffline(true);
    try {
      const page = await openDashboard(env, { q: 'aorta' });
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await expectResult(page, ['aorta'], ds);

      await runQuery(page, 'bank:Renal');
      await expectResult(page, ['nephron', 'gfr'], ds);
      await openPreview(page, ds.id.hl('gfr'));
      await expect(page.getByTestId('preview-quote')).toHaveText(
        'The glomerular filtration rate is normally about one hundred and twenty millilitres per minute.',
      );
      // Writes work too.
      await page.getByTestId('tag-input').fill('offline tag');
      await page.getByTestId('tag-add').click();
      await expect(page.getByTestId('tag-chip').filter({ hasText: 'offline tag' })).toBeVisible();
      await runQuery(page, 'tag:"offline tag"');
      await expectResult(page, ['gfr'], ds);
      expect(externalRequests(page)).toEqual([]);
      expect(pageErrors(page)).toEqual([]);
    } finally {
      await env.context.setOffline(false);
    }
  });

  test('the index is restored on reload, caught up on edits, rebuilt when damaged and after a purge', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, searchInput());

    // 1. first open: no index yet, so it is built (and then persisted).
    const first = await openDashboard(env);
    await expect(first.locator('.dash-search__status')).toContainText('Press / to search', {
      timeout: 30_000,
    });
    expect((await probeOf(first)).status).toContain('Building the search index');
    await runQuery(first, 'aorta');
    await expectResult(first, ['aorta'], ds);
    await expect
      .poll(async () => (await readTable<{ key: string }>(ctrl, 'meta')).map((m) => m.key), {
        timeout: 30_000,
        message: 'the index is written to the vault',
      })
      .toEqual(expect.arrayContaining(['searchIndex', 'searchIndexState']));
    await first.close();

    // 2. reopen: restored, not rebuilt.
    const second = await openDashboard(env, { q: 'aorta' });
    await expectResult(second, ['aorta'], ds);
    await expect(second.getByTestId('result-summary')).toContainText('1 result');
    expect((await probeOf(second)).status).not.toContain('Building the search index');
    await second.close();

    // 3. a change made while no dashboard was open is caught up from the stored index.
    const fresh = buildDataset({
      sources: [{ key: 'new', url: 'https://bio.example/new', title: 'New page' }],
      highlights: [
        {
          key: 'quokka',
          quote: 'The quokka is a small marsupial found on Rottnest Island.',
          source: 'new',
          updatedAt: new Date().toISOString(),
          capturedAt: new Date().toISOString(),
        },
      ],
    });
    await writeDataset(ctrl, fresh);
    const third = await openDashboard(env, { q: 'quokka' });
    await expectResult(third, ['quokka'], fresh);
    expect((await probeOf(third)).status).not.toContain('Building the search index');
    await third.close();

    // 4. a damaged index is detected and rebuilt, and search still answers.
    await rawPut(ctrl, {
      meta: [
        { key: 'searchIndex', value: '{"not":"an index"}', updatedAt: new Date().toISOString() },
      ],
    });
    const fourth = await openDashboard(env, { q: 'aorta' });
    await expectResult(fourth, ['aorta'], ds);
    expect((await probeOf(fourth)).status).toContain('Building the search index');

    // 5. permanently deleting a highlight leaves no row to report: the index must be rebuilt and
    //    the purged quote must stop matching.
    await runQuery(fourth, '');
    await openPreview(fourth, ds.id.hl('aorta'));
    await fourth.getByTestId('preview-trash').click();
    await fourth.getByTestId('view-trash').click();
    await fourth.getByTestId('trash-list').getByRole('checkbox').first().check();
    await fourth.getByTestId('trash-purge').click();
    await dialogOf(fourth, /^Permanently delete/)
      .getByTestId('dialog-confirm')
      .click();
    await expect(fourth.getByTestId('trash-outcome')).toContainText(
      'Permanently deleted 1 highlight',
    );
    await expect
      .poll(async () => (await probeOf(fourth)).status)
      .toContain('Items were permanently deleted');
    await fourth.getByTestId('view-library').click();
    await runQuery(fourth, 'aorta');
    await expect(fourth.getByText('No results for “aorta”')).toBeVisible();
    await fourth.reload();
    await runQuery(fourth, 'aorta');
    await expect(fourth.getByText('No results for “aorta”')).toBeVisible();
    await runQuery(fourth, 'heart');
    await expectResult(fourth, ['sino', 'beta', 'heart2'], ds);
  });
});

// ===============================================================================================
// 5. Preview: provenance, tags, fields, notes, duplicates
// ===============================================================================================

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The fields of a stored highlight that provenance promises never to change. */
const IMMUTABLE = [
  'exactQuote',
  'normalizedQuote',
  'quoteHash',
  'anchorSet',
  'capturedUrl',
  'capturedTitle',
  'sourceId',
  'capturedAt',
] as const;

function previewInput(env: Env): DatasetInput {
  return {
    banks: [
      { key: 'cardio', name: 'Cardiology' },
      { key: 'other', name: 'Other bank' },
    ],
    folders: [
      { key: 'valves', bank: 'cardio', name: 'Valves' },
      { key: 'mitral', bank: 'cardio', parent: 'valves', name: 'Mitral' },
    ],
    sources: [{ key: 's', url: sourceA(env), title: 'Dash Source A: Cell Biology' }],
    highlights: [
      {
        key: 'p1',
        quote: 'The mitral valve has two leaflets.',
        source: 's',
        places: [{ bank: 'cardio', folder: 'mitral' }],
        heading: 'Valve anatomy',
        capturedAt: '2026-03-12T10:30:00.000Z',
      },
      {
        key: 'p2',
        quote: 'The tricuspid valve has three leaflets.',
        source: 's',
        places: [{ bank: 'cardio' }],
        capturedAt: '2026-03-13T10:30:00.000Z',
      },
    ],
  };
}

test.describe('preview: provenance, tags, fields, notes, duplicates', () => {
  test('a quote saved with the real toolbar shows its exact text, source and place, and cannot be edited', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const bankId = await createBankRpc(ctrl, 'Cardiology');
    const dash = await openDashboard(env);
    await expect(dash.getByText('Your vault is empty')).toBeVisible();

    // The real path: a fixture page, a real triple-click and the selection toolbar.
    const article = await openFixture(env, '/dash-source-a.html');
    await saveBlock(ctrl, article, '#p-atp');
    await dash.bringToFront();

    // The dashboard picks the new highlight up without a reload.
    await expect(dash.getByTestId('result-row')).toHaveCount(1);
    const [saved] = await storedHighlights(ctrl);
    const stored = saved!;
    const paragraph = await article.locator('#p-atp').innerText();
    expect(stored.exactQuote.replace(/\s+/g, ' ').trim()).toBe(
      paragraph.replace(/\s+/g, ' ').trim(),
    );

    await openPreview(dash, stored.id);
    const quote = dash.getByTestId('preview-quote');
    await expect(quote).toHaveText(stored.exactQuote);
    const provenance = dash.getByTestId('preview-provenance');
    await expect(provenance).toContainText('Dash Source A: Cell Biology');
    await expect(provenance).toContainText(sourceA(env));
    await expect(provenance).toContainText('the selection toolbar');
    await expect(provenance).toContainText('Captured');
    await expect(dash.getByTestId('location')).toHaveText(/^Inbox/);

    // The quote has no editing surface at all.
    const editable = await quote.evaluate((el) => ({
      contentEditable: (el as HTMLElement).isContentEditable,
      controls: el.querySelectorAll('input, textarea, select, [contenteditable]').length,
      tabbable: (el as HTMLElement).tabIndex >= 0,
    }));
    expect(editable).toEqual({ contentEditable: false, controls: 0, tabbable: false });

    // The source link opens the page at the passage, in a new tab, without an opener.
    const link = dash.getByTestId('open-source');
    const href = (await link.getAttribute('href')) ?? '';
    expect(href.startsWith(`${sourceA(env)}#:~:text=`)).toBe(true);
    expect(decodeURIComponent(href.split('#:~:text=')[1]!).replace(/%2D/g, '-')).toBe(
      stored.exactQuote.replace(/\s+/g, ' ').trim(),
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    const [opened] = await Promise.all([env.context.waitForEvent('page'), link.click()]);
    await opened.waitForLoadState();
    expect(opened.url().startsWith(sourceA(env))).toBe(true);
    expect(await opened.title()).toBe('Dash Source A: Cell Biology');
    await opened.close();
    await dash.bringToFront();

    // "Only this source" narrows the list and says what it is doing.
    await dash.getByTestId('filter-source').click();
    await expect(dash.getByRole('list', { name: 'Active filters' })).toContainText(
      'Source: Dash Source A: Cell Biology',
    );
    await dash.getByTestId('clear-filters').click();

    // Everything the user may change leaves the immutable fields as captured.
    await dash.getByTestId('preview-kind').selectOption('formula');
    await dash.getByTestId('preview-priority').selectOption('5');
    await dash.getByTestId('preview-comment').fill('My own reading of this');
    await dash.getByTestId('preview-comment').blur();
    await expect(dash.getByText('Saved', { exact: true })).toBeVisible();
    await dash.getByTestId('tag-input').fill('exam');
    await dash.getByTestId('tag-add').click();
    await expect(dash.getByTestId('tag-chip')).toHaveCount(1);
    await dash.getByTestId('file-in-another').click();
    const dialog = dialogOf(dash, 'File in another bank');
    await dialog.getByTestId('place-bank').selectOption(bankId);
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(dash.getByTestId('location')).toHaveCount(2);
    await expect(dash.getByTestId('preview-locations')).toContainText('Cardiology');

    await expect
      .poll(async () => {
        const row = (await storedHighlights(ctrl)).find((h) => h.id === stored.id)!;
        return [row.kind, row.priority, row.userComment];
      })
      .toEqual(['formula', 5, 'My own reading of this']);
    const after = (await storedHighlights(ctrl)).find((h) => h.id === stored.id)!;
    for (const field of IMMUTABLE) {
      expect(after[field], `${field} is immutable`).toEqual(stored[field]);
    }
    expect(pageErrors(dash)).toEqual([]);
    expect(externalRequests(dash)).toEqual([]);
  });

  test('tags: add, reuse an existing tag by any capitalisation, remove, and see them in the filter', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, previewInput(env));
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('p1'));
    const tags = page.getByTestId('preview-tags');

    await expect(tags).toContainText('No tags.');
    await expect(page.getByTestId('tag-add')).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('tag-input').fill('Exam');
    await page.getByTestId('tag-add').click();
    await expect(tags.getByTestId('tag-chip')).toHaveText(/Exam/);

    // Same tag in another case is the same tag, not a second one.
    await page.getByTestId('tag-input').fill('EXAM');
    await page.getByTestId('tag-add').click();
    await expect(tags.getByTestId('tag-chip')).toHaveCount(1);
    await page.getByTestId('tag-input').fill('pearl');
    await page.getByTestId('tag-add').click();
    await expect(tags.getByTestId('tag-chip')).toHaveCount(2);
    expect((await readTable(ctrl, 'tags')).length).toBe(2);

    // The tag shows in the filter with its count; filtering by it finds this highlight.
    const group = await openFilter(page, 'filter-tags');
    await expect(group.getByRole('checkbox', { name: 'Exam (1)' })).toBeVisible();
    await group.getByRole('checkbox', { name: 'Exam (1)' }).check();
    await expectResult(page, ['p1'], ds);
    await closeFilters(page);
    await page.getByTestId('clear-filters').click();

    await page.getByRole('button', { name: 'Remove tag Exam' }).click();
    await expect(toast(page, 'Removed the tag Exam.')).toBeVisible();
    await expect(tags.getByTestId('tag-chip')).toHaveCount(1);
    const links = await readTable<{ highlightId: string; tagId: string }>(ctrl, 'highlightTags');
    expect(links.map((l) => l.highlightId)).toEqual([ds.id.hl('p1')]);
  });

  test('custom fields: text, number and yes/no values can be added, edited and removed', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, previewInput(env));
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('p1'));
    const fields = page.getByTestId('preview-fields');
    const add = async (name: string, type: 'text' | 'number' | 'boolean', value?: string) => {
      await fields.getByTestId('field-key').fill(name);
      await fields.getByTestId('field-type').selectOption(type);
      if (type === 'boolean') await fields.getByLabel('Value').selectOption(value ?? 'yes');
      else await fields.getByTestId('field-value').fill(value ?? '');
      await fields.getByTestId('field-save').click();
    };

    await add('exam', 'text', 'final');
    await expect(fields.getByTestId('custom-field').filter({ hasText: 'exam' })).toContainText(
      'final',
    );
    await add('weight', 'number', '2.5');
    await expect(fields.getByTestId('custom-field').filter({ hasText: 'weight' })).toContainText(
      '2.5',
    );
    await add('reviewed', 'boolean', 'yes');
    await expect(fields.getByTestId('custom-field').filter({ hasText: 'reviewed' })).toContainText(
      'Yes',
    );

    // A number field refuses text and says why; nothing is stored.
    await add('bad', 'number', 'abc');
    await expect(fields.getByRole('alert')).toContainText('Enter a number, such as 3 or 0.5.');
    await fields.getByTestId('field-key').fill('');

    // Edit loads the field into the form; saving the same name updates it.
    await page.getByRole('button', { name: 'Edit field exam' }).click();
    await expect(fields.getByTestId('field-key')).toHaveValue('exam');
    await expect(fields.getByTestId('field-value')).toHaveValue('final');
    await expect(fields.getByTestId('field-save')).toHaveText('Update field');
    await fields.getByTestId('field-value').fill('midterm');
    await fields.getByTestId('field-save').click();
    await expect(fields.getByTestId('custom-field').filter({ hasText: 'exam' })).toContainText(
      'midterm',
    );

    await page.getByRole('button', { name: 'Remove field weight' }).click();
    await expect(fields.getByTestId('custom-field')).toHaveCount(2);

    await expect
      .poll(
        async () =>
          (await storedHighlights(ctrl)).find((h) => h.id === ds.id.hl('p1'))?.customFields,
      )
      .toEqual({ exam: 'midterm', reviewed: true });
  });

  test('a highlight with 32 custom fields refuses a 33rd with the reason', async ({ env }) => {
    const fields = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field${i}`, `v${i}`]));
    const { ds } = await seed(env, {
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [{ key: 'full', quote: 'A very annotated fact.', source: 's', fields }],
    });
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('full'));
    const panel = page.getByTestId('preview-fields');
    await panel.getByTestId('field-key').fill('one more');
    const save = panel.getByTestId('field-save');
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await expect(save).toHaveAttribute('title', 'At most 32 fields. Remove one first.');
    // Editing an existing field is still allowed.
    await panel.getByTestId('field-key').fill('field3');
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    await expect(save).toHaveText('Update field');
  });

  test('the comment saves on blur, shows its state and survives a reload', async ({ env }) => {
    const { ds } = await seed(env, previewInput(env));
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('p1'));
    const box = page.getByTestId('preview-comment');
    await box.fill('Two leaflets: anterior and posterior');
    await expect(page.getByText('Unsaved changes (saved automatically)')).toBeVisible();
    await box.blur();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.reload();
    await settle(page);
    await openPreview(page, ds.id.hl('p1'));
    await expect(page.getByTestId('preview-comment')).toHaveValue(
      'Two leaflets: anterior and posterior',
    );
  });

  test('notes: add, render Markdown, edit, pin, delete with undo, and find them by search', async ({
    env,
  }) => {
    const { ds } = await seed(env, previewInput(env));
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('p1'));
    const notes = page.getByTestId('preview-notes');

    await expect(notes).toContainText('No notes yet.');
    await notes.getByTestId('note-add').click();
    await expect(notes.getByTestId('note-save')).toHaveAttribute('aria-disabled', 'true');
    await notes.getByTestId('note-title').fill('Leaflets');
    await notes.getByTestId('note-body').fill('**Two** leaflets\n\n- anterior\n- posteriorleaflet');
    await notes.getByRole('button', { name: 'Preview' }).click();
    const draft = notes.getByTestId('note-preview');
    await expect(draft.locator('strong')).toHaveText('Two');
    await expect(draft.locator('li')).toHaveCount(2);
    await notes.getByRole('button', { name: 'Back to editing' }).click();
    await notes.getByTestId('note-save').click();

    const note = notes.getByTestId('note').first();
    await expect(note.locator('h4')).toHaveText('Leaflets');
    await expect(note.locator('.sv-md strong')).toHaveText('Two');
    await expect(note.locator('.sv-md li')).toHaveCount(2);

    // The new note is searchable and counts as "has a note".
    await page.getByTestId('search-input').fill('posteriorleaflet');
    await expectResult(page, ['p1'], ds);
    await expect(rowEl(page, ds.id.hl('p1'))).toContainText('Matched a note');
    await page.getByTestId('search-input').fill('');
    const group = await openFilter(page, 'filter-note');
    await group.getByLabel('Your note').selectOption('yes');
    await expectResult(page, ['p1'], ds);
    await closeFilters(page);
    await page.getByTestId('clear-filters').click();

    // Edit, pin.
    await note.getByTestId('note-edit').click();
    await notes.getByTestId('note-body').fill('Edited body');
    await notes.getByTestId('note-save').click();
    await expect(note.locator('.sv-md')).toHaveText('Edited body');
    await note.getByRole('button', { name: 'Pin' }).click();
    await expect(note).toContainText('Pinned');

    // Delete is undoable.
    await note.getByTestId('note-delete').click();
    await expect(toast(page, 'Note moved to the trash.')).toBeVisible();
    await expect(notes.getByTestId('note')).toHaveCount(0);
    await toast(page, 'Note moved to the trash.').getByRole('button', { name: 'Undo' }).click();
    await expect(notes.getByTestId('note')).toHaveCount(1);
    await expect(notes.getByTestId('note').locator('.sv-md')).toHaveText('Edited body');
  });

  test('an unsaved note is kept while another highlight is shown and offered again', async ({
    env,
  }) => {
    const { ds } = await seed(env, previewInput(env));
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('p1'));
    await page.getByTestId('note-add').click();
    await page.getByTestId('note-body').fill('half-written thought');

    await openPreview(page, ds.id.hl('p2'));
    await expect(page.getByTestId('preview-notes')).toContainText('No notes yet.');
    await openPreview(page, ds.id.hl('p1'));
    await expect(page.getByTestId('note-draft-restored')).toBeVisible();
    await expect(page.getByTestId('note-body')).toHaveValue('half-written thought');

    // Cancel discards it for good.
    await page.getByTestId('note-cancel').click();
    await openPreview(page, ds.id.hl('p2'));
    await openPreview(page, ds.id.hl('p1'));
    await expect(page.getByTestId('note-draft-restored')).toHaveCount(0);
  });

  test('Markdown in notes never runs script, loads images or makes an unsafe link', async ({
    env,
  }) => {
    const hostile = [
      '**bold** and _italic_',
      '<img src=x onerror="window.__svPwned=1">',
      '<script>window.__svPwned=2</script>',
      `<iframe src="${env.origin}/index.html"></iframe>`,
      '[js link](javascript:window.__svPwned=3)',
      '[data link](data:text/html,<script>window.__svPwned=4</script>)',
      `![tracker](${env.origin}/pixel.png)`,
      '![inline](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9d2luZG93Ll9fc3ZQd25lZD01Pg==)',
      '<a href="javascript:window.__svPwned=5" onclick="window.__svPwned=6">raw anchor</a>',
      '[safe link](https://example.org/safe)',
    ].join('\n\n');
    const { ds } = await seed(env, {
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [
        {
          key: 'md',
          quote: 'A fact with a hostile note.',
          source: 's',
          notes: [{ body: hostile }],
        },
      ],
    });
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('md'));

    const inspect = (root: Locator) =>
      root.evaluate((el) => ({
        forbidden: el.querySelectorAll(
          'img, script, iframe, object, embed, svg, style, form, input, link, meta, base, video, audio',
        ).length,
        withHandlers: Array.from(el.querySelectorAll('*')).filter((n) =>
          Array.from(n.attributes).some((a) => a.name.toLowerCase().startsWith('on')),
        ).length,
        links: Array.from(el.querySelectorAll('a')).map((a) => ({
          href: a.getAttribute('href'),
          target: a.getAttribute('target'),
          rel: a.getAttribute('rel'),
          text: a.textContent,
        })),
        text: el.textContent ?? '',
      }));
    const expectSafe = async (root: Locator) => {
      const report = await inspect(root);
      expect(report.forbidden, 'no img/script/iframe/svg/... element was created').toBe(0);
      expect(report.withHandlers, 'no inline event handler attribute').toBe(0);
      for (const link of report.links) {
        expect(link.href === null || /^https?:\/\//i.test(link.href), `link ${link.href}`).toBe(
          true,
        );
      }
      const safe = report.links.find((l) => l.text === 'safe link');
      expect(safe).toEqual({
        href: 'https://example.org/safe',
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'safe link',
      });
      // Raw HTML is visible as text, images are replaced by their alt text.
      expect(report.text).toContain('<img src=x onerror="window.__svPwned=1">');
      expect(report.text).toContain('<script>window.__svPwned=2</script>');
      expect(report.text).toContain('tracker');
      expect(report.text).toContain('bold');
    };

    const saved = page.getByTestId('preview-notes').getByTestId('note').locator('.sv-md');
    await expect(saved).toContainText('safe link');
    await expectSafe(saved);

    // The editor's own preview pane goes through the same renderer.
    await page.getByTestId('note-edit').click();
    await page.getByRole('button', { name: 'Preview' }).click();
    const draft = page.getByTestId('note-preview');
    await expect(draft).toContainText('safe link');
    await expectSafe(draft.locator('.sv-md'));

    expect(await page.evaluate(() => (window as { __svPwned?: number }).__svPwned)).toBe(undefined);
    expect(externalRequests(page), 'no image or frame was requested').toEqual([]);
    expect(pageErrors(page)).toEqual([]);
  });

  test('a quote that contains markup is shown as text everywhere', async ({ env }) => {
    const markup =
      '<img src=x onerror="window.__svPwned=1"> and <script>window.__svPwned=2</script>';
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const saved = await captureQuote(ctrl, {
      url: sourceA(env),
      title: '<b>Bold title</b>',
      quote: markup,
      comment: '<u>underlined</u>',
    });
    const page = await openDashboard(env);
    const row = rowEl(page, saved.id);
    await expect(row).toContainText(markup);
    expect(await row.locator('img, script, b, u').count()).toBe(0);
    await openPreview(page, saved.id);
    await expect(page.getByTestId('preview-quote')).toHaveText(markup);
    expect(await page.getByTestId('preview').locator('img, script, b, u').count()).toBe(0);
    await expect(page.getByTestId('preview-provenance')).toContainText('<b>Bold title</b>');
    expect(await page.evaluate(() => (window as { __svPwned?: number }).__svPwned)).toBe(undefined);
    expect(pageErrors(page)).toEqual([]);
  });

  test('the same quote saved from several pages is shown as duplicates and never merged', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const shared = 'The cell membrane is a selectively permeable phospholipid bilayer.';
    const first = await captureQuote(ctrl, {
      url: sourceA(env),
      title: 'Source A',
      quote: shared,
      at: 100,
    });
    const second = await captureQuote(ctrl, {
      url: sourceB(env),
      title: 'Source B',
      quote: shared,
      at: 40,
    });
    const third = await captureQuote(ctrl, {
      url: `${env.origin}/article.html`,
      title: 'Cardiac primer',
      quote: shared,
      at: 700,
    });
    const unique = await captureQuote(ctrl, {
      url: sourceA(env),
      title: 'Source A',
      quote: 'Ribosomes are assembled in the nucleolus.',
      at: 900,
    });
    expect([first.status, second.status, third.status, unique.status]).toEqual([
      'created',
      'created',
      'created',
      'created',
    ]);

    const page = await openDashboard(env);
    await openPreview(page, first.id);
    const dups = page.getByTestId('preview-duplicates');
    await expect(dups).toContainText('This exact quote is saved 2 other times.');
    await expect(dups).toContainText('Nothing is merged automatically');
    await expect(dups.getByTestId('duplicate-member')).toHaveCount(2);
    // The unique quote has no such section.
    await openPreview(page, unique.id);
    await expect(page.getByTestId('preview-duplicates')).toHaveCount(0);

    await openPreview(page, first.id);
    await page.getByTestId('review-duplicates').click();
    const clusters = page.getByTestId('duplicate-cluster');
    await expect(clusters).toHaveCount(1);
    await expect(clusters).toContainText('Saved 3 times from 3 sources');
    await expect(clusters.getByTestId('duplicate-member')).toHaveCount(3);
    await expect(clusters).toHaveAttribute('aria-current', 'true'); // the one we came from

    // Looking at them changed nothing; all four are still there.
    expect((await storedHighlights(ctrl)).filter((h) => h.deletedAt === null)).toHaveLength(4);

    // Trashing one copy is the user's decision, one copy at a time, and is undoable.
    await clusters.getByTestId('duplicate-trash').nth(1).click();
    await expect(toast(page, 'Moved this copy to the trash.')).toBeVisible();
    await expect(clusters.getByTestId('duplicate-member')).toHaveCount(2);
    expect((await storedHighlights(ctrl)).filter((h) => h.deletedAt === null)).toHaveLength(3);
    await toast(page, 'Moved this copy to the trash.')
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(clusters.getByTestId('duplicate-member')).toHaveCount(3);
    expect((await storedHighlights(ctrl)).filter((h) => h.deletedAt === null)).toHaveLength(4);

    // "Show in library" goes back to the list with that highlight in the preview.
    await clusters.getByRole('button', { name: 'Show in library' }).nth(2).click();
    await expect(page.getByTestId('preview')).toHaveAttribute('data-highlight-id', /.+/);
    await expect(page.getByRole('main', { name: 'All highlights' })).toBeVisible();
    expect(pageErrors(page)).toEqual([]);
  });

  test('moving a highlight to the trash from the preview is undoable and leaves the list', async ({
    env,
  }) => {
    const { ds } = await seed(env, previewInput(env));
    const page = await openDashboard(env);
    await expectTotal(page, 2);
    await openPreview(page, ds.id.hl('p1'));
    await page.getByTestId('preview-trash').click();
    await expect(toast(page, 'Moved the highlight to the trash.')).toBeVisible();
    await expectTotal(page, 1);
    await expect(page.getByTestId('preview-empty')).toBeVisible();
    await toast(page, 'Moved the highlight to the trash.')
      .getByRole('button', { name: 'Undo' })
      .click();
    await expectTotal(page, 2);
    await expect(rowEl(page, ds.id.hl('p1'))).toBeVisible();
  });
});

// ===============================================================================================
// 6. Bulk actions, trash, purge
// ===============================================================================================

function bulkInput(env: Env, rows = 12): DatasetInput {
  const highlights: HighlightSpec[] = [];
  for (let i = 1; i <= rows; i++) {
    highlights.push({
      key: `m${i}`,
      quote: `Bulk fact number ${i} about the topic.`,
      source: 's',
      places: [{ bank: 'work', folder: i % 3 === 0 ? 'wf' : null }],
      capturedAt: new Date(BASE_TIME + i * 60_000).toISOString(),
    });
  }
  for (let i = 1; i <= 4; i++) {
    highlights.push({
      key: `o${i}`,
      quote: `Other bank fact ${i} about something else.`,
      source: 's',
      places: [{ bank: 'other' }],
      tags: ['old'],
      capturedAt: new Date(BASE_TIME + (100 + i) * 60_000).toISOString(),
    });
  }
  return {
    banks: [
      { key: 'work', name: 'Work' },
      { key: 'other', name: 'Other' },
    ],
    folders: [{ key: 'wf', bank: 'work', name: 'Work folder' }],
    tags: [{ key: 'old', name: 'old' }],
    sources: [{ key: 's', url: sourceA(env), title: 'Bulk source' }],
    highlights,
  };
}

/** Rows of the work bank, newest first (the default order). */
const newestFirst = (n: number) => Array.from({ length: n }, (_, i) => `m${n - i}`);

test.describe('bulk: selection and actions', () => {
  test('selects with click, Ctrl+click, Shift+click, the keyboard and Select all', async ({
    env,
  }) => {
    const { ds } = await seed(env, bulkInput(env, 12));
    const page = await openDashboard(env);
    await treeItem(page, 'Work').click();
    await expectTotal(page, 12);
    const order = newestFirst(12).map((k) => ds.id.hl(k));
    const option = (n: number) =>
      rowEl(page, order[n]!).locator('xpath=ancestor::div[@role="option"]');
    const count = page.getByTestId('bulk-count');

    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
    await rowEl(page, order[0]!).click();
    await expect(count).toHaveText('1 selected');
    await expect(option(0)).toHaveAttribute('aria-selected', 'true');
    // A plain click also opens it in the preview.
    await expect(page.getByTestId('preview')).toHaveAttribute('data-highlight-id', order[0]!);

    await rowEl(page, order[2]!).click({ modifiers: ['Control'] });
    await expect(count).toHaveText('2 selected');
    await rowEl(page, order[4]!).click({ modifiers: ['Shift'] });
    // Shift extends from the anchor (the last toggled row) and replaces the selection.
    await expect(count).toHaveText('3 selected');
    for (const n of [2, 3, 4]) await expect(option(n)).toHaveAttribute('aria-selected', 'true');
    await expect(option(0)).toHaveAttribute('aria-selected', 'false');

    // The check mark of a row toggles it without a modifier.
    await rowEl(page, order[1]!).locator('[data-check]').click();
    await expect(count).toHaveText('4 selected');

    // Keyboard: Ctrl+A, Escape, arrows with Space and Shift.
    const list = listbox(page);
    await list.press('Control+A');
    await expect(count).toHaveText('12 selected');
    await list.press('Escape');
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
    await rowEl(page, order[0]!).click();
    await list.press('Escape');
    await list.press('ArrowDown');
    await list.press('Space');
    await expect(count).toHaveText('1 selected');
    await list.press('Shift+ArrowDown');
    await list.press('Shift+ArrowDown');
    await expect(count).toHaveText('3 selected');

    // Choosing another bank is another set of rows: the selection does not follow.
    await treeItem(page, 'Other').click();
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
  });

  test('priority, kind and colour change every selected highlight and say how many', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, bulkInput(env, 12));
    const page = await openDashboard(env);
    await treeItem(page, 'Work').click();
    await expectTotal(page, 12);
    const order = newestFirst(12).map((k) => ds.id.hl(k));
    await rowEl(page, order[0]!).click();
    await rowEl(page, order[2]!).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('bulk-count')).toHaveText('3 selected');
    const chosen = order.slice(0, 3);

    await page.getByTestId('bulk-priority').click();
    await page
      .getByRole('menu', { name: 'Set priority' })
      .getByRole('menuitem', { name: /^Priority 5/ })
      .click();
    await expect(toast(page, 'Priority changed on 3 highlights.')).toBeVisible();

    await page.getByTestId('bulk-kind').click();
    await page
      .getByRole('menu', { name: 'Set kind' })
      .getByRole('menuitem', { name: /Exception/ })
      .click();
    await expect(toast(page, 'Kind changed on 3 highlights.')).toBeVisible();

    await page.getByTestId('bulk-color').click();
    await page
      .getByRole('menu', { name: 'Set colour' })
      .getByRole('menuitem', { name: 'Teal' })
      .click();
    await expect(toast(page, 'Colour changed on 3 highlights.')).toBeVisible();

    await expect
      .poll(async () => {
        const rows = await storedHighlights(ctrl);
        const touched = rows.filter((h) => chosen.includes(h.id));
        const rest = rows.filter((h) => !chosen.includes(h.id));
        return {
          touched: touched.map((h) => [h.priority, h.kind, h.color].join('/')),
          untouched: rest.every((h) => h.priority === 3 && h.kind === 'essential'),
        };
      })
      .toEqual({
        touched: ['5/exception/teal', '5/exception/teal', '5/exception/teal'],
        untouched: true,
      });
    // The selection is still there after the change, ready for the next action.
    await expect(page.getByTestId('bulk-count')).toHaveText('3 selected');
  });

  test('tags: add a new tag to the selection, then remove it again', async ({ env }) => {
    const { ds, ctrl } = await seed(env, bulkInput(env, 12));
    const page = await openDashboard(env);
    await treeItem(page, 'Work').click();
    await expectTotal(page, 12);
    const order = newestFirst(12).map((k) => ds.id.hl(k));
    await rowEl(page, order[0]!).click();
    await rowEl(page, order[3]!).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('bulk-count')).toHaveText('4 selected');

    await page.getByTestId('bulk-tags').click();
    let dialog = dialogOf(page, 'Tags for 4 highlights');
    await expect(dialog.getByTestId('dialog-confirm')).toHaveAttribute('aria-disabled', 'true');
    await dialog.getByTestId('bulk-new-tag').fill('revisit');
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Tags changed on 4 highlights.')).toBeVisible();

    const tagRows = await readTable<{ id: string; name: string }>(ctrl, 'tags');
    const revisit = tagRows.find((t) => t.name === 'revisit')!;
    const links = () =>
      readTable<{ highlightId: string; tagId: string }>(ctrl, 'highlightTags').then((rows) =>
        rows.filter((l) => l.tagId === revisit.id).map((l) => l.highlightId),
      );
    expect((await links()).sort()).toEqual(order.slice(0, 4).sort());

    // The existing tag can also be added; removing works from the same dialog.
    await page.getByTestId('bulk-tags').click();
    dialog = dialogOf(page, 'Tags for 4 highlights');
    await dialog
      .getByRole('group', { name: 'Remove these tags' })
      .getByRole('checkbox', { name: 'revisit' })
      .check();
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(links).toEqual([]);
  });

  test('move: from the viewed bank, or into one place only', async ({ env }) => {
    const { ds, ctrl } = await seed(env, bulkInput(env, 12));
    const page = await openDashboard(env);
    await treeItem(page, 'Work').click();
    await expectTotal(page, 12);
    const order = newestFirst(12).map((k) => ds.id.hl(k));
    await rowEl(page, order[0]!).click();
    await rowEl(page, order[1]!).click({ modifiers: ['Shift'] });

    await page.getByTestId('bulk-move').click();
    const dialog = dialogOf(page, 'Move 2 highlights');
    await expect(dialog.getByRole('radio')).toHaveCount(2); // a bank is being viewed: both modes
    await dialog.getByTestId('place-bank').selectOption(ds.id.bank('other'));
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Moved 2 highlights.')).toBeVisible();

    await expectTotal(page, 10);
    // The tree reloads its counts after the list has refreshed: wait for them, do not sample.
    await expectTreeCount(page, 'Work', 10);
    await expectTreeCount(page, 'Other', 6);
    const memberships = await readTable<{ highlightId: string; bankId: string }>(
      ctrl,
      'highlightBanks',
    );
    for (const id of order.slice(0, 2)) {
      expect(memberships.filter((m) => m.highlightId === id).map((m) => m.bankId)).toEqual([
        ds.id.bank('other'),
      ]);
    }
    await expect(page.getByTestId('view-library')).toHaveText(/All highlights\s*16$/);
  });

  test('Move to trash is immediate for a few rows, undoable, and asks first for everything that matches', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, bulkInput(env, 30));
    const page = await openDashboard(env);
    await treeItem(page, 'Work').click();
    await expectTotal(page, 30);
    const order = newestFirst(30).map((k) => ds.id.hl(k));

    // A few rows: no confirmation, an Undo in the toast.
    await rowEl(page, order[0]!).click();
    await rowEl(page, order[1]!).click({ modifiers: ['Shift'] });
    await page.getByTestId('bulk-delete').click();
    await expect(dialogOf(page, /Move .* to the trash\?/)).toHaveCount(0);
    await expect(toast(page, 'Moved 2 highlights to the trash.')).toBeVisible();
    await expectTotal(page, 28);
    await toast(page, 'Moved 2 highlights to the trash.')
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(toast(page, 'Restored 2 highlights.')).toBeVisible();
    await expectTotal(page, 30);

    // Everything that matches: the dialog says what happens; Cancel changes nothing.
    await rowEl(page, order[0]!).click();
    await page.getByTestId('select-all-filtered').click();
    await expect(page.getByTestId('bulk-count')).toContainText(
      '30 selected (everything that matches)',
    );
    await page.getByTestId('bulk-delete').click();
    const dialog = dialogOf(page, 'Move 30 highlights to the trash?');
    await expect(dialog.getByTestId('explain-lines')).toContainText(
      '30 highlights leave their banks and go to the Trash.',
    );
    await dialog.getByTestId('dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expectTotal(page, 30);
    await expect(page.getByTestId('bulk-delete')).toBeFocused();

    await page.getByTestId('bulk-delete').click();
    await dialogOf(page, 'Move 30 highlights to the trash?').getByTestId('dialog-confirm').click();
    await expect(toast(page, 'Moved 30 highlights to the trash.')).toBeVisible();
    await expect(page.getByText('No highlights match these filters')).toBeVisible();
    expect((await storedHighlights(ctrl)).filter((h) => h.deletedAt !== null)).toHaveLength(30);
    await toast(page, 'Moved 30 highlights to the trash.')
      .getByRole('button', { name: 'Undo' })
      .click();
    await expectTotal(page, 30);
  });

  test('select all matching reaches rows that are not loaded, and Ctrl+click excludes one', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, bulkInput(env, 230));
    const page = await openDashboard(env);
    await treeItem(page, 'Work').click();
    await expect(page.getByTestId('result-summary')).toContainText('230 highlights, 100 loaded');

    const first = newestFirst(230).map((k) => ds.id.hl(k));
    await rowEl(page, first[0]!).click();
    await expect(page.getByTestId('bulk-count')).toHaveText('1 selected');
    await page.getByTestId('select-all-filtered').click();
    await expect(page.getByTestId('bulk-count')).toHaveText(
      '230 selected (everything that matches)',
    );
    await rowEl(page, first[1]!).click({ modifiers: ['Control'] });
    await expect(page.getByTestId('bulk-count')).toContainText('229 selected');

    await page.getByTestId('bulk-priority').click();
    await page
      .getByRole('menu', { name: 'Set priority' })
      .getByRole('menuitem', { name: /^Priority 5/ })
      .click();
    await expect(toast(page, 'Priority changed on 229 highlights.')).toBeVisible({
      timeout: 60_000,
    });

    const rows = await storedHighlights(ctrl);
    const work = rows.filter((h) => h.exactQuote.startsWith('Bulk fact'));
    expect(work).toHaveLength(230);
    expect(work.filter((h) => h.priority === 5)).toHaveLength(229);
    expect(work.find((h) => h.id === first[1])?.priority).toBe(3);
    expect(
      rows.filter((h) => h.exactQuote.startsWith('Other bank')).every((h) => h.priority === 3),
    ).toBe(true);
  });
});

// ===============================================================================================
// 6b. Trash, restore, purge
// ===============================================================================================

/** The number in a row of the storage panel's table. */
async function storageRow(page: Page, label: string): Promise<number> {
  const cell = page
    .getByTestId('storage-table')
    .getByRole('row', { name: new RegExp(`^${escapeRe(label)}\\s`) })
    .getByRole('cell');
  return Number(((await cell.textContent()) ?? '').replace(/[^\d]/g, ''));
}

test.describe('trash: restore, purge, empty', () => {
  test('lists every kind, restores, purges only after a confirmation, and empties', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, {
      banks: [{ key: 'gone', name: 'Doomed bank' }],
      folders: [{ key: 'gf', bank: 'gone', name: 'Doomed folder' }],
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [
        {
          key: 'g1',
          quote: 'Fact filed in the doomed bank.',
          source: 's',
          places: [{ bank: 'gone', folder: 'gf' }],
        },
        { key: 'x1', quote: 'First inbox fact.', source: 's' },
        {
          key: 'x2',
          quote: 'Second inbox fact.',
          source: 's',
          notes: [{ title: 'Doomed note', body: 'body' }],
        },
      ],
    });
    const page = await openDashboard(env);
    await expectTotal(page, 3);

    // Fill the trash through the UI: a bank (with its folder), a highlight and a note.
    await treeItem(page, 'Doomed bank').click();
    await page.keyboard.press('Delete');
    await dialogOf(page, /^Delete bank/)
      .getByTestId('dialog-confirm')
      .click();
    await expect(toast(page, 'Deleted Doomed bank. It is in the Trash.')).toBeVisible();
    await page.getByTestId('view-library').click();
    await openPreview(page, ds.id.hl('x1'));
    await page.getByTestId('preview-trash').click();
    await expect(toast(page, 'Moved the highlight to the trash.')).toBeVisible();
    await openPreview(page, ds.id.hl('x2'));
    await page.getByTestId('note-delete').click();
    await expect(toast(page, 'Note moved to the trash.')).toBeVisible();

    await page.getByTestId('view-trash').click();
    const kind = page.getByTestId('trash-kind');
    await expect(kind.locator('option')).toHaveText([
      'Everything (4)',
      'highlights (1)',
      'notes (1)',
      'folders (1)',
      'banks (1)',
    ]);
    const list = page.getByTestId('trash-list');
    await expect(list).toContainText('First inbox fact.');
    await expect(list).toContainText('Doomed note');
    await expect(list).toContainText('Doomed folder');
    await expect(list).toContainText('Doomed bank');

    // Nothing selected: the actions say why they do nothing.
    await expect(page.getByTestId('trash-restore')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('trash-purge')).toHaveAttribute(
      'title',
      'Select items to delete first.',
    );

    // Restore the highlight.
    await kind.selectOption('highlight');
    await page.getByTestId('trash-select-all').click();
    await page.getByTestId('trash-restore').click();
    await expect(page.getByTestId('trash-outcome')).toHaveText('Restored 1 item.');
    await page.getByTestId('view-library').click();
    await expect(rowEl(page, ds.id.hl('x1'))).toBeVisible();

    // Permanently delete the note: Escape in the dialog keeps it, Delete permanently removes it.
    await page.getByTestId('view-trash').click();
    await page.getByTestId('trash-kind').selectOption('note');
    await page.getByTestId('trash-select-all').click();
    await page.getByTestId('trash-purge').click();
    let dialog = dialogOf(page, 'Permanently delete 1 item?');
    await expect(dialog.getByTestId('explain-lines')).toContainText(
      '1 note will be removed for good.',
    );
    await expect(dialog.getByTestId('explain-lines')).toContainText('This cannot be undone.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('trash-purge')).toBeFocused();
    expect((await readTable(ctrl, 'notes')).length).toBe(1);
    await page.getByTestId('trash-purge').click();
    dialog = dialogOf(page, 'Permanently delete 1 item?');
    await dialog.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('trash-outcome')).toContainText('Permanently deleted 1 note.');
    expect((await readTable(ctrl, 'notes')).length).toBe(0);

    // Empty the trash: the dialog counts what goes; the re-homed highlight stays live.
    await page.getByTestId('trash-empty').click();
    dialog = dialogOf(page, 'Empty the trash?');
    await expect(dialog.getByTestId('explain-lines')).toContainText(
      '1 folder will be removed for good.',
    );
    await expect(dialog.getByTestId('explain-lines')).toContainText(
      '1 bank will be removed for good.',
    );
    await dialog.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('trash-outcome')).toContainText('Permanently deleted');
    await expect(page.getByText('The trash is empty')).toBeVisible();
    expect(await readTable(ctrl, 'folders')).toHaveLength(0);
    expect((await readTable<{ id: string }>(ctrl, 'banks')).map((b) => b.id)).not.toContain(
      ds.id.bank('gone'),
    );
    const live = (await storedHighlights(ctrl)).filter((h) => h.deletedAt === null);
    expect(live.map((h) => h.id).sort()).toEqual(
      [ds.id.hl('g1'), ds.id.hl('x1'), ds.id.hl('x2')].sort(),
    );
    expect(pageErrors(page)).toEqual([]);
  });

  test('a permanent delete removes everything that hangs off the highlight and leaves no orphan', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, {
      banks: [{ key: 'b', name: 'Bank' }],
      folders: [{ key: 'f', bank: 'b', name: 'Folder' }],
      tags: [
        { key: 't1', name: 'alpha' },
        { key: 't2', name: 'beta' },
      ],
      sources: [
        { key: 'solo', url: sourceA(env), title: 'Only this highlight' },
        { key: 'shared', url: sourceB(env), title: 'Shared page' },
      ],
      highlights: [
        {
          key: 'doomed',
          quote: 'A doomed highlight with a quokka.',
          source: 'solo',
          places: [{ bank: 'b', folder: 'f' }, { bank: 'inbox' }],
          tags: ['t1', 't2'],
          notes: [{ body: 'first note' }, { body: 'second note' }],
          fields: { exam: 'final' },
        },
        {
          key: 'kept1',
          quote: 'Kept highlight on the shared page.',
          source: 'shared',
          tags: ['t1'],
        },
        {
          key: 'kept2',
          quote: 'Another kept highlight.',
          source: 'shared',
          notes: [{ body: 'kept note' }],
        },
      ],
    });
    const doomed = ds.id.hl('doomed');
    const counts = () =>
      countTables(ctrl, [
        'highlights',
        'notes',
        'highlightBanks',
        'highlightTags',
        'sources',
        'tags',
      ]);
    expect(await counts()).toMatchObject({
      highlights: 3,
      notes: 3,
      highlightBanks: 4,
      highlightTags: 3,
      sources: 2,
      tags: 2,
    });

    const page = await openDashboard(env);
    await openPreview(page, doomed);
    await page.getByTestId('preview-trash').click();
    await page.getByTestId('view-trash').click();
    await page.getByTestId('trash-select-all').click();
    await page.getByTestId('trash-purge').click();
    await dialogOf(page, /^Permanently delete/)
      .getByTestId('dialog-confirm')
      .click();
    await expect(page.getByTestId('trash-outcome')).toContainText(
      'Permanently deleted 1 highlight.',
    );
    await expect(page.getByTestId('trash-outcome')).toContainText('Also removed linked rows');

    // Raw tables: the highlight, its notes, filings and tag links are gone, nothing else is.
    const after = await counts();
    expect(after).toMatchObject({
      highlights: 2,
      notes: 1,
      highlightBanks: 2,
      highlightTags: 1,
      sources: 1,
      tags: 2,
    });
    for (const table of ['highlightBanks', 'highlightTags', 'notes'] as const) {
      const rows = await readTable<{ highlightId: string | null }>(ctrl, table);
      expect(
        rows.filter((r) => r.highlightId === doomed),
        `orphans in ${table}`,
      ).toEqual([]);
    }
    const sources = await readTable<{ id: string }>(ctrl, 'sources');
    expect(sources.map((s) => s.id)).toEqual([ds.id.src('shared')]);
    // Every remaining link points at a row that exists.
    const highlightIds = new Set((await storedHighlights(ctrl)).map((h) => h.id));
    for (const link of await readTable<{ highlightId: string }>(ctrl, 'highlightTags')) {
      expect(highlightIds.has(link.highlightId)).toBe(true);
    }
    for (const m of await readTable<{ highlightId: string }>(ctrl, 'highlightBanks')) {
      expect(highlightIds.has(m.highlightId)).toBe(true);
    }

    // A second, fresh dashboard load agrees through its own storage panel.
    const second = await openDashboard(env, {}, { settle: false });
    await second.getByTestId('view-storage').click();
    await expect(second.getByTestId('storage-panel')).toBeVisible();
    for (const [label, table] of [
      ['Highlights', 'highlights'],
      ['Notes', 'notes'],
      ['Highlight filings', 'highlightBanks'],
      ['Tag links', 'highlightTags'],
      ['Sources (pages)', 'sources'],
      ['Tags', 'tags'],
    ] as const) {
      expect(await storageRow(second, label), label).toBe(after[table]);
    }
    await second.getByTestId('view-library').click();
    await settle(second);
    await second.getByTestId('search-input').fill('quokka');
    await expect(second.getByText('No results for “quokka”')).toBeVisible();
  });
});

// ===============================================================================================
// 7. Keyboard, command palette, focus, accessibility
// ===============================================================================================

const LIGHT_DARK = ['light', 'dark'] as const;

async function bodyLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(
      getComputedStyle(document.body).backgroundColor,
    );
    if (!m) return -1;
    return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
  });
}

/** One page with rows, a selection and a kind filter: the busiest state of the library. */
async function busyLibrary(env: Env) {
  const base = bulkInput(env, 12);
  const { ds, ctrl } = await seed(env, {
    ...base,
    highlights: base.highlights.map((h, i) => ({
      ...h,
      notes: i === 3 ? [{ title: 'A note', body: '**Markdown** body' }] : [],
      tags: i === 3 ? ['old'] : h.tags,
      comment: i === 3 ? 'A comment' : '',
    })),
  });
  return { ds, ctrl };
}

test.describe('keyboard: palette, shortcuts, tab order, focus', () => {
  test('Ctrl+K opens the palette from anywhere; commands run real actions and disabled ones explain', async ({
    env,
  }) => {
    const { ds } = await seed(env, bulkInput(env, 5));
    const page = await openDashboard(env);
    await expectTotal(page, 9);

    // From inside the search box, and focus comes back there on Escape.
    await page.getByTestId('search-input').focus();
    const palette = await openPalette(page);
    await expect(page.getByTestId('palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(page.getByTestId('search-input')).toBeFocused();

    // Typing narrows the list; the first match runs with Enter.
    await openPalette(page);
    await page.getByTestId('palette-input').fill('storage');
    await expect(
      page.getByTestId('palette-list').getByRole('option', { selected: true }),
    ).toContainText('Show storage usage');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('storage-panel')).toBeVisible();
    await expect(page.getByRole('main', { name: 'Storage' })).toBeVisible();

    await runCommand(page, 'view-trash');
    await expect(page.getByRole('main', { name: 'Trash' })).toBeVisible();
    await runCommand(page, 'view-duplicates');
    await expect(page.getByTestId('duplicates-view')).toBeVisible();
    await runCommand(page, 'view-library');
    await expectTotal(page, 9);

    // A bank command scopes the list.
    await runCommand(page, `bank-${ds.id.bank('other')}`);
    await expectTotal(page, 4);
    await expect(treeItem(page, 'Other')).toHaveAttribute('aria-selected', 'true');
    await runCommand(page, 'view-library');

    // A command that cannot run is listed, says why, and leaves the palette open.
    await openPalette(page);
    await page.getByTestId('palette-input').fill('Clear all filters');
    const item = page.locator('[data-command-id="filters-clear"]');
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toContainText('No filters are active.');
    await item.click({ force: true }); // aria-disabled: the click must be answered, not ignored
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect(page.getByTestId('command-palette').getByRole('status')).toContainText(
      'Clear all filters is unavailable: No filters are active.',
    );
    await page.keyboard.press('Escape');

    // Selection commands act on the real selection.
    await runCommand(page, 'select-loaded');
    await expect(page.getByTestId('bulk-count')).toHaveText('9 selected');
    await runCommand(page, 'select-clear');
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);

    // Search commands.
    await page.getByTestId('search-input').fill('nothing matches this');
    await runCommand(page, 'search-clear');
    await expect(page.getByTestId('search-input')).toHaveValue('');

    // Dialog-opening commands.
    await runCommand(page, 'bank-new');
    await expect(dialogOf(page, 'New bank')).toBeVisible();
    await page.keyboard.press('Escape');
    await runCommand(page, 'shortcuts');
    await expect(dialogOf(page, 'Keyboard shortcuts')).toBeVisible();
    await page.keyboard.press('Escape');

    // Focus commands.
    await runCommand(page, 'focus-tree');
    await expect(treeOf(page).locator('[role="treeitem"]:focus')).toHaveCount(1);
    await runCommand(page, 'focus-list');
    await expect(listbox(page)).toBeFocused();
    await runCommand(page, 'focus-search');
    await expect(page.getByTestId('search-input')).toBeFocused();
    await runCommand(page, 'focus-preview');
    await expect(page.getByTestId('preview-pane')).toBeFocused();

    // Rebuilding the index is a real action with visible progress.
    await runCommand(page, 'index-rebuild');
    await expect
      .poll(async () => (await probeOf(page)).status)
      .toContain('Rebuilding as requested');
    await expect(page.locator('.dash-search__status')).toContainText('Press / to search');
    expect(pageErrors(page)).toEqual([]);
  });

  test('palette appearance commands change and keep the theme, density and contrast', async ({
    env,
  }) => {
    await seed(env, bulkInput(env, 3));
    const page = await openDashboard(env);
    const html = page.locator('html');
    const light = await bodyLuminance(page);

    await runCommand(page, 'theme-dark');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => bodyLuminance(page)).toBeLessThan(0.3);
    await page.locator('.dash-appearance > summary').click();
    await expect(page.getByTestId('opt-theme')).toHaveValue('dark');
    await page.keyboard.press('Escape');

    await runCommand(page, 'density-compact');
    await expect(page.getByTestId('dashboard')).toHaveAttribute('data-density', 'compact');
    await expect(page.locator('[role="option"]').first()).toHaveCSS('height', '100px');

    await runCommand(page, 'contrast-toggle');
    await expect(html).toHaveAttribute('data-contrast', 'high');
    await openPalette(page);
    await expect(page.locator('[data-command-id="contrast-toggle"]')).toContainText(
      'Turn high contrast off',
    );
    await page.keyboard.press('Escape');

    // All three are remembered across a reload.
    await page.reload();
    await settle(page);
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-contrast', 'high');
    await expect(page.getByTestId('dashboard')).toHaveAttribute('data-density', 'compact');

    await runCommand(page, 'theme-light');
    await expect.poll(() => bodyLuminance(page)).toBeGreaterThan(Math.min(light, 0.7));
  });

  test('single-key shortcuts and F6 move between panes and are ignored while typing', async ({
    env,
  }) => {
    await seed(env, bulkInput(env, 5));
    const page = await openDashboard(env);
    const search = page.getByTestId('search-input');

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
    // Typing "?" or "/" into the box is text, not a shortcut.
    await page.keyboard.type('a/b?');
    await expect(search).toHaveValue('a/b?');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await search.fill('');
    // The list comes back (it was an empty "no results" state) before F6 can focus it.
    await settle(page);
    await expect(listbox(page)).toBeVisible();

    // F6 cycles search -> list -> preview -> tree -> search.
    await page.keyboard.press('F6');
    await expect(listbox(page)).toBeFocused();
    await page.keyboard.press('F6');
    await expect(page.getByTestId('preview-pane')).toBeFocused();
    await page.keyboard.press('F6');
    await expect(treeOf(page).locator('[role="treeitem"]:focus')).toHaveCount(1);
    await page.keyboard.press('F6');
    await expect(search).toBeFocused();
    await page.keyboard.press('Shift+F6');
    await expect(treeOf(page).locator('[role="treeitem"]:focus')).toHaveCount(1);

    // "?" opens the shortcut legend, Escape closes it and focus goes back where it was.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?'); // key '?' (Shift+/ would send the key '/')
    const legend = dialogOf(page, 'Keyboard shortcuts');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('Command palette');
    await page.keyboard.press('Escape');
    await expect(legend).toHaveCount(0);
  });

  test('the tab order follows the visual order and every stop has a name', async ({ env }) => {
    await seed(env, bulkInput(env, 5));
    const page = await openDashboard(env);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const stops: string[] = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return '';
        const named =
          el.getAttribute('aria-label') ??
          (el instanceof HTMLInputElement
            ? (el.labels?.[0]?.textContent ?? el.placeholder)
            : null) ??
          el.textContent ??
          '';
        return `${el.localName}|${(named ?? '').replace(/\s+/g, ' ').trim()}`;
      });
      if (stop === '' || stops.includes(stop)) break; // focus left the page or the cycle closed
      stops.push(stop);
    }
    expect(
      stops.filter((s) => s === '' || s.endsWith('|')),
      'every tab stop has a name',
    ).toEqual([]);

    const expected = [
      /^a\|Skip to the main content/,
      /^input\|Search highlights and notes/,
      /^button\|Syntax help/,
      /^button\|Commands/,
      /^summary\|View options/,
      /^button\|All highlights/,
      /^button\|Duplicate quotes/,
      /^button\|Trash/,
      /^button\|Storage/,
      /^button\|New bank/,
      /^div\|Inbox/, // the tree is ONE stop (a roving tabindex)
      /^input\|Name for the current search/,
      /^button\|Save this search/,
      /^button\|StudyVault settings/,
      /^summary\|Kind/,
      /^summary\|Priority/,
      /^summary\|Status/,
      /^summary\|Tags/,
      /^summary\|Note/,
      /^summary\|Date/,
      /^select\|Sort by|^select\|Newest captured/,
      /^div\|Highlights/, // the list is ONE stop (aria-activedescendant)
    ];
    let at = -1;
    const missing: string[] = [];
    for (const pattern of expected) {
      const found = stops.findIndex((s, i) => i > at && pattern.test(s));
      if (found === -1) missing.push(String(pattern));
      else at = found;
    }
    expect(missing, `tab stops in order were: ${JSON.stringify(stops)}`).toEqual([]);

    // One stop for the tree and one for the list, however many rows they hold.
    expect(await treeOf(page).locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
    expect(await listbox(page).getAttribute('tabindex')).toBe('0');
    expect(await page.locator('[role="option"][tabindex]').count()).toBe(0);
  });

  test('focus returns to the control that opened a dialog, menu or palette', async ({ env }) => {
    const input = bulkInput(env, 6);
    // A non-empty trash, so that its actions exist.
    input.highlights.push({
      key: 'trashed1',
      quote: 'A trashed fact.',
      source: 's',
      trashed: true,
    });
    await seed(env, input);
    const page = await openDashboard(env);

    // New bank: Escape, Cancel and a successful create all go back to the button.
    const newBank = page.getByTestId('new-bank');
    await newBank.focus();
    await page.keyboard.press('Enter');
    await expect(dialogOf(page, 'New bank')).toBeVisible();
    await expect(page.getByTestId('name-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(newBank).toBeFocused();
    await newBank.click();
    await dialogOf(page, 'New bank').getByTestId('dialog-cancel').click();
    await expect(newBank).toBeFocused();
    await newBank.click();
    await page.getByTestId('name-input').fill('Focus bank');
    await page.keyboard.press('Enter');
    await expect(treeItem(page, 'Focus bank')).toBeVisible();
    await expect(newBank).toBeFocused();

    // Tree node -> context menu (Shift+F10) -> item -> dialog -> Cancel: back on the node.
    await treeItem(page, 'Work').focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(treeItem(page, 'Work')).toBeFocused();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: /^Rename/ }).click();
    await dialogOf(page, 'Rename bank').getByTestId('dialog-cancel').click();
    await expect(treeItem(page, 'Work')).toBeFocused();
    await page.keyboard.press('Delete');
    await dialogOf(page, /^Delete bank/)
      .getByTestId('dialog-cancel')
      .click();
    await expect(treeItem(page, 'Work')).toBeFocused();

    // Bulk bar buttons.
    await treeItem(page, 'Work').click();
    await expectTotal(page, 6);
    await listbox(page).focus();
    await listbox(page).press('Control+A');
    for (const [id, title] of [
      ['bulk-move', /^Move 6 highlights$/],
      ['bulk-tags', /^Tags for 6 highlights$/],
    ] as const) {
      await page.getByTestId(id).click();
      await expect(dialogOf(page, title)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(id)).toBeFocused();
    }
    await page.getByTestId('bulk-kind').click();
    await expect(page.getByRole('menu', { name: 'Set kind' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('bulk-kind')).toBeFocused();

    // Trash confirmations.
    await page.getByTestId('view-trash').click();
    await page.getByTestId('trash-empty').click();
    await expect(dialogOf(page, 'Empty the trash?')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('trash-empty')).toBeFocused();
    expect(pageErrors(page)).toEqual([]);
  });

  for (const scheme of LIGHT_DARK) {
    test.describe(`axe WCAG 2.2 AA (${scheme})`, () => {
      test(`library with rows, a selection, a filter and the syntax help (${scheme})`, async ({
        env,
      }) => {
        const { ds } = await busyLibrary(env);
        const page = await openDashboard(env);
        await page.emulateMedia({ colorScheme: scheme });
        await expectTotal(page, 16);
        if (scheme === 'dark') expect(await bodyLuminance(page)).toBeLessThan(0.3);
        else expect(await bodyLuminance(page)).toBeGreaterThan(0.7);

        await page.getByTestId('search-help-toggle').click();
        const kinds = await openFilter(page, 'filter-kind');
        await kinds.getByRole('checkbox', { name: KIND_NAME.essential! }).check();
        await closeFilters(page);
        await rowEl(page, ds.id.hl('m12')).click();
        await rowEl(page, ds.id.hl('m10')).click({ modifiers: ['Shift'] });
        await expect(page.getByTestId('bulk-bar')).toBeVisible();
        await expectAxeClean(page);
      });

      test(`preview of a highlight with a note, tags, fields and duplicates (${scheme})`, async ({
        env,
      }) => {
        const ctrl = await openControl(env);
        await ensureVault(ctrl);
        const quote = 'The cell membrane is a selectively permeable phospholipid bilayer.';
        const a = await captureQuote(ctrl, {
          url: sourceA(env),
          title: 'Source A',
          quote,
          comment: 'Mine',
          at: 1,
        });
        await captureQuote(ctrl, { url: sourceB(env), title: 'Source B', quote, at: 1 });
        const page = await openDashboard(env);
        await page.emulateMedia({ colorScheme: scheme });
        await openPreview(page, a.id);
        await page.getByTestId('tag-input').fill('exam');
        await page.getByTestId('tag-add').click();
        await page.getByTestId('field-key').fill('chapter');
        await page.getByTestId('field-value').fill('3');
        await page.getByTestId('field-save').click();
        await page.getByTestId('note-add').click();
        await page.getByTestId('note-body').fill('A **note**');
        await page.getByTestId('note-save').click();
        await expect(page.getByTestId('note')).toHaveCount(1);
        await expect(page.getByTestId('preview-duplicates')).toBeVisible();
        await expectAxeClean(page, '[data-testid="preview-pane"]');
      });

      test(`trash, storage and duplicates views (${scheme})`, async ({ env }) => {
        const { ds } = await seed(env, {
          ...previewInput(env),
          highlights: previewInput(env).highlights.map((h, i) => ({ ...h, trashed: i === 0 })),
        });
        const page = await openDashboard(env);
        await page.emulateMedia({ colorScheme: scheme });
        await page.getByTestId('view-trash').click();
        await page.getByTestId('trash-list').getByRole('checkbox').first().check();
        await expect(page.getByTestId('trash-restore')).toContainText('Restore 1 item');
        await expectAxeClean(page);

        await page.getByTestId('view-storage').click();
        await expect(page.getByTestId('storage-table')).toBeVisible();
        await expectAxeClean(page);

        await page.getByTestId('view-duplicates').click();
        await expect(page.getByText('No duplicates found')).toBeVisible();
        await expectAxeClean(page);
        expect(ds.id.hl('p1')).toBeTruthy();
      });

      test(`dialogs: new bank, merge, tags and the command palette (${scheme})`, async ({
        env,
      }) => {
        await seed(env, bulkInput(env, 6));
        const page = await openDashboard(env);
        await page.emulateMedia({ colorScheme: scheme });

        await page.getByTestId('new-bank').click();
        await expect(dialogOf(page, 'New bank')).toBeVisible();
        await expectAxeClean(page);
        await page.keyboard.press('Escape');

        await treeMenu(page, 'Other', /^Merge into another bank/);
        await expect(dialogOf(page, /^Merge bank/)).toBeVisible();
        await expectAxeClean(page);
        await page.keyboard.press('Escape');

        await treeItem(page, 'Work').click();
        await listbox(page).focus();
        await listbox(page).press('Control+A');
        await page.getByTestId('bulk-tags').click();
        await expect(dialogOf(page, /^Tags for/)).toBeVisible();
        await expectAxeClean(page);
        await page.keyboard.press('Escape');

        await openPalette(page);
        await expectAxeClean(page);
      });
    });
  }
});

// ===============================================================================================
// 8. Resilience
// ===============================================================================================

test.describe('resilience: reload, worker suspension, restart', () => {
  test('a dirty note asks before the tab goes away; saved text and comments are kept', async ({
    env,
  }) => {
    const { ds, ctrl } = await seed(env, previewInput(env));
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('p1'));

    // A comment is saved when the field loses focus, so a reload right after keeps it.
    await page.getByTestId('preview-comment').fill('typed before the reload');
    await page.getByTestId('preview-comment').blur();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    // An unsaved note is protected by the browser's own "leave site?" prompt.
    await page.getByTestId('note-add').click();
    await page.getByTestId('note-body').fill('not saved yet');
    const prompts: string[] = [];
    page.on('dialog', (dialog) => {
      prompts.push(dialog.type());
      void dialog.accept();
    });
    await page.reload();
    await settle(page);
    expect(prompts).toEqual(['beforeunload']);
    // Leaving discarded only the unsaved note; nothing half-written was stored.
    expect((await readTable(ctrl, 'notes')).length).toBe(0);
    await openPreview(page, ds.id.hl('p1'));
    await expect(page.getByTestId('preview-comment')).toHaveValue('typed before the reload');
    await expect(page.getByTestId('preview-notes')).toContainText('No notes yet.');

    // A clean page leaves without a prompt.
    prompts.length = 0;
    await page.reload();
    await settle(page);
    expect(prompts).toEqual([]);
  });

  test('keeps saving, reading and updating live while the service worker is suspended', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const dash = await openDashboard(env);
    await expect(dash.getByText('Your vault is empty')).toBeVisible();

    // Prove the worker really restarts: mark it, stop it, observe the marker gone.
    const before = await markWorker(env.context, env.extensionId, 'dashboard-suspend');
    const stoppedIn = await stopWorker(env.context, env.extensionId, ctrl);
    recordPerf('stop the extension service worker', stoppedIn);
    expect(await workerState(env.context, env.extensionId)).toBeNull();

    // The dashboard talks to the vault directly: it works with the worker down.
    await createBankUi(dash, 'While suspended');
    await createFolderUi(dash, 'While suspended', 'Folder one');
    await dash.getByTestId('view-trash').click();
    await expect(dash.getByText('The trash is empty')).toBeVisible();
    await dash.getByTestId('view-library').click();

    // A capture from a page wakes the worker, and the open dashboard shows it without a reload.
    const article = await openFixture(env, '/dash-source-a.html', { activate: true });
    await saveBlock(ctrl, article, '#p-shared');
    const revived = await workerState(env.context, env.extensionId);
    expect(revived, 'the worker was started again by the capture').not.toBeNull();
    expect(revived!.timeOrigin).not.toBe(before.timeOrigin);
    expect(revived!.probe).toBeNull();
    await dash.bringToFront();
    await expect(dash.getByTestId('result-row')).toHaveCount(1);
    await expect(dash.getByTestId('result-row')).toContainText('selectively permeable');

    // And again with the worker down: edits and reads still work.
    await stopWorker(env.context, env.extensionId, ctrl);
    const [saved] = await storedHighlights(ctrl);
    await openPreview(dash, saved!.id);
    await dash.getByTestId('tag-input').fill('after suspend');
    await dash.getByTestId('tag-add').click();
    await expect(dash.getByTestId('tag-chip')).toHaveCount(1);
    await dash.getByTestId('search-input').fill('selectively');
    await expect(dash.getByTestId('result-summary')).toContainText('1 result');
    await wakeWorker(ctrl, env.context, env.extensionId);
    expect(pageErrors(dash)).toEqual([]);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright needs a destructuring pattern; this test launches its own profile
  test('everything made in the dashboard is there after the browser is closed and reopened', async ({}) => {
    test.setTimeout(300_000);
    const dir = newUserDataDir();
    try {
      const first = await launchSession(dir);
      const env1 = { ...first, origin: 'http://127.0.0.1:1', altOrigin: '' } as unknown as Env;
      const ctrl1 = await openControl(env1);
      await ensureVault(ctrl1);
      const saved = await captureQuote(ctrl1, {
        url: 'https://bio.example/restart',
        title: 'Restart page',
        quote: 'Quokkas survive a browser restart.',
      });
      const dash1 = await openDashboard(env1);
      await createBankUi(dash1, 'Persisted bank');
      await createFolderUi(dash1, 'Persisted bank', 'Persisted folder');
      await openPreview(dash1, saved.id);
      await dash1.getByTestId('tag-input').fill('kept');
      await dash1.getByTestId('tag-add').click();
      await expect(dash1.getByTestId('tag-chip')).toHaveCount(1);
      await dash1.getByTestId('note-add').click();
      await dash1.getByTestId('note-body').fill('A note that must survive');
      await dash1.getByTestId('note-save').click();
      await expect(dash1.getByTestId('note')).toHaveCount(1);
      await dash1.getByTestId('search-input').fill('quokkas');
      await dash1.getByTestId('saved-search-name').fill('Quokka search');
      await dash1.getByTestId('saved-search-save').click();
      await expect(dash1.getByTestId('saved-search-run')).toHaveCount(1);
      await runCommand(dash1, 'theme-dark');
      await dash1.getByTestId('search-input').fill('');
      await expect(dash1.locator('html')).toHaveAttribute('data-theme', 'dark');
      // Let the index writer run (it persists 3 s after the last change).
      await expect
        .poll(async () => (await readTable<{ key: string }>(ctrl1, 'meta')).map((m) => m.key))
        .toContain('searchIndex');
      await first.context.close();

      const second = await launchSession(dir);
      const env2 = { ...second, origin: 'http://127.0.0.1:1', altOrigin: '' } as unknown as Env;
      const dash2 = await openDashboard(env2);
      await expect(treeItem(dash2, 'Persisted bank')).toBeVisible();
      await expect(treeItem(dash2, 'Persisted folder')).toBeVisible();
      await expect(dash2.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(dash2.getByTestId('saved-search-run')).toHaveText('Quokka search');
      await openPreview(dash2, saved.id);
      await expect(dash2.getByTestId('preview-quote')).toHaveText(
        'Quokkas survive a browser restart.',
      );
      await expect(dash2.getByTestId('tag-chip')).toHaveText(/kept/);
      await expect(dash2.getByTestId('note')).toContainText('A note that must survive');
      await dash2.getByTestId('saved-search-run').click();
      await expect(dash2.getByTestId('result-summary')).toContainText('1 result');
      expect((await probeOf(dash2)).status).not.toContain('Building the search index');
      expect(pageErrors(dash2)).toEqual([]);
      await second.context.close();
    } finally {
      // Chromium's child processes may hold the profile for a moment after the context closed.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          removeDir(dir);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  });
});
