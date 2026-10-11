import type { Page } from '@playwright/test';
import { COLOR_IDS, HIGHLIGHT_KINDS, MAX_FOLDER_DEPTH, type ResolveStatus } from '@shared';
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
  dashboardHref,
  dialogOf,
  ensureVault,
  expect,
  expectList,
  expectResult,
  expectTotal,
  externalRequests,
  openControl,
  openDashboard,
  openPalette,
  openPreview,
  pageErrors,
  probeOf,
  readTable,
  recordPerf,
  renderedIds,
  rowEl,
  runCommand,
  settle,
  storedHighlights,
  summaryTotal,
  test,
  toast,
  treeCount,
  treeItem,
  treeMenu,
  treeOf,
  treeOutline,
  writeDataset,
  type Dataset,
  type DatasetInput,
  type Env,
  type HighlightSpec,
} from './helpers.dashboard';

// ===============================================================================================
// Shared data
// ===============================================================================================

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
        i % 10 === 0
          ? new Date(BASE_TIME + 45 * DAY_MS + i * 60_000).toISOString()
          : capturedAt,
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
    expect(await treeCount(page, 'Inbox')).toBe(0);
    await expect(page.getByTestId('view-library')).toHaveText(/All highlights\s*0$/);
    await expect(page.getByText('Your vault is empty')).toBeVisible();
    await expect(page.getByTestId('result-summary')).toContainText('0 highlights');
    await expect(page.getByTestId('preview-empty')).toBeVisible();
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
    expect(await treeOutline(page)).toEqual(['1:Inbox']);

    // A search that finds nothing says so and offers a way out.
    await page.getByTestId('search-input').fill('zzzzqx');
    await expect(page.getByText('No results for “zzzzqx”')).toBeVisible();
    await page.getByRole('button', { name: 'Clear the search' }).click();
    await expect(page.getByText('Your vault is empty')).toBeVisible();

    // A filter on an empty vault is "no match", not "empty vault".
    const group = page.getByTestId('filter-kind');
    await group.locator('summary').click();
    await group.getByRole('checkbox', { name: 'Formula' }).check();
    await expect(page.getByText('No highlights match these filters')).toBeVisible();
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
    expect(await treeOutline(page)).toEqual(outline);

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
    expect(await treeOutline(page)).toEqual(outline);
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
    expect((await treeOutline(page)).at(-1)).toBe(`${MAX_FOLDER_DEPTH + 1}:Level ${MAX_FOLDER_DEPTH}`);

    await treeItem(page, `Level ${MAX_FOLDER_DEPTH}`).click({ button: 'right' });
    const item = page.getByRole('menu').getByRole('menuitem', { name: /New subfolder/ });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toContainText('at most 8 levels deep');
    await item.click();
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
        { key: 'h1', quote: 'Valves keep blood moving one way.', source: 's', places: [{ bank: 'cardio', folder: 'valves' }] },
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
    expect(await treeCount(page, 'Heart valves')).toBe(1);
    await expectList(page, [ds.id.hl('h1')]);
    await page.reload();
    await settle(page);
    await expect(treeItem(page, 'Heart valves')).toHaveAttribute('aria-selected', 'false');
    expect(await treeCount(page, 'Heart valves')).toBe(1);
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
    await expect.poll(outline).toEqual([
      '1:Inbox', '1:Alpha', '2:One', '2:Two', '3:TwoChild', '2:Three', '1:Beta', '1:Gamma',
    ]);

    // Banks: Beta moves above Alpha, then cannot pass the Inbox.
    await treeItem(page, 'Beta').click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(outline).toEqual([
      '1:Inbox', '1:Beta', '1:Alpha', '2:One', '2:Two', '3:TwoChild', '2:Three', '1:Gamma',
    ]);
    await expect(treeItem(page, 'Beta')).toBeFocused();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(toast(page, 'The Inbox always stays first.')).toBeVisible();
    await expect(treeItem(page, 'Beta')).toBeFocused();
    // ...and keeps moving with further presses without clicking again.
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(outline).toEqual([
      '1:Inbox', '1:Alpha', '2:One', '2:Two', '3:TwoChild', '2:Three', '1:Beta', '1:Gamma',
    ]);
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(outline).toEqual([
      '1:Inbox', '1:Alpha', '2:One', '2:Two', '3:TwoChild', '2:Three', '1:Gamma', '1:Beta',
    ]);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(toast(page, 'Already last.')).toBeVisible();

    // Folders: reorder among siblings, indent under the sibling above, outdent again.
    await treeItem(page, 'Two').click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(outline).toEqual([
      '1:Inbox', '1:Alpha', '2:Two', '3:TwoChild', '2:One', '2:Three', '1:Gamma', '1:Beta',
    ]);
    await treeItem(page, 'One').click();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(outline).toEqual([
      '1:Inbox', '1:Alpha', '2:Two', '3:TwoChild', '3:One', '2:Three', '1:Gamma', '1:Beta',
    ]);
    await expect(treeItem(page, 'One')).toBeFocused();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(outline).toEqual([
      '1:Inbox', '1:Alpha', '2:Two', '3:TwoChild', '2:One', '2:Three', '1:Gamma', '1:Beta',
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
    await expect.poll(outline).toEqual([
      '1:Inbox', '1:Alpha', '2:Two', '3:TwoChild', '2:One', '2:Three', '1:Gamma', '1:Beta',
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
    expect(await treeOutline(page)).toEqual(['1:Inbox', '1:Alpha']);
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
    expect(await treeOutline(page)).toEqual(['1:Inbox', '1:Alpha']);
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
        { key: 'm1', quote: 'First travelling fact.', source: 's', places: [{ bank: 'srcb', folder: 'mv' }] },
        { key: 'm2', quote: 'Second travelling fact.', source: 's', places: [{ bank: 'srcb', folder: 'mv' }] },
      ],
    });
    const page = await openDashboard(env);
    expect(await treeCount(page, 'From bank')).toBe(2);
    await treeMenu(page, 'Travelling', /^Move to/);
    const dialog = dialogOf(page, 'Move folder “Travelling”');
    await dialog.getByTestId('place-bank').selectOption(ds.id.bank('dstb'));
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Moved “Travelling”.')).toBeVisible();

    await expect
      .poll(() => treeOutline(page))
      .toEqual(['1:Inbox', '1:From bank', '1:To bank', '2:Travelling']);
    expect(await treeCount(page, 'From bank')).toBe(0);
    expect(await treeCount(page, 'To bank')).toBe(2);
    expect(await treeCount(page, 'Travelling')).toBe(2);
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
        { key: 'm1', quote: 'Merge fact one.', source: 's', places: [{ bank: 'src', folder: 'sf' }] },
        { key: 'm2', quote: 'Merge fact two.', source: 's', places: [{ bank: 'src' }] },
        { key: 'm3', quote: 'Merge fact three.', source: 's', places: [{ bank: 'src' }, { bank: 'tgt' }] },
        { key: 'm4', quote: 'Merge fact four.', source: 's', places: [{ bank: 'tgt' }] },
        { key: 'm5', quote: 'Merge fact five.', source: 's', places: [{ bank: 'tgt' }] },
        { key: 'w1', quote: 'Work fact one.', source: 's', places: [{ bank: 'work', folder: 'fa' }] },
        { key: 'w2', quote: 'Work fact two.', source: 's', places: [{ bank: 'work', folder: 'fa' }] },
        { key: 'w3', quote: 'Work fact three.', source: 's', places: [{ bank: 'work', folder: 'fb' }] },
        { key: 'w4', quote: 'Work fact four.', source: 's', places: [{ bank: 'work', folder: 'fbc' }] },
      ],
    });
    const page = await openDashboard(env);
    const total = await summaryTotal(page);
    expect(total).toBe(9);

    // ---- bank into bank
    await treeMenu(page, 'Source', /^Merge into another bank/);
    let dialog = dialogOf(page, 'Merge bank “Source”');
    await dialog.getByTestId('merge-target').selectOption(ds.id.bank('tgt'));
    const explain = dialog.getByTestId('merge-explain');
    await expect(explain).toContainText('Every folder and 3 highlights of “Source” move into “Target”.');
    await expect(explain).toContainText(
      '“Source” is then removed (it goes to the Trash). Highlights already in “Target” are not duplicated.',
    );
    // Cancelling changes nothing.
    await dialog.getByTestId('dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(await treeCount(page, 'Source')).toBe(3);
    expect(await treeCount(page, 'Target')).toBe(3);

    await treeMenu(page, 'Source', /^Merge into another bank/);
    dialog = dialogOf(page, 'Merge bank “Source”');
    await dialog.getByTestId('merge-target').selectOption(ds.id.bank('tgt'));
    await dialog.getByTestId('dialog-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(
      toast(page, 'Merged “Source” into “Target”: 3 highlights and 1 folder moved.'),
    ).toBeVisible();
    await expect(treeItem(page, 'Source')).toHaveCount(0);
    expect(await treeCount(page, 'Target')).toBe(5);
    expect(await treeOutline(page)).toContain('2:Source folder');
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
    expect(await treeCount(page, 'Folder A')).toBe(4);

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
        { key: 't1', quote: 'Zebrafish embryos are transparent.', source: 's', places: [{ bank: 'tmp', folder: 'tf' }] },
        { key: 't2', quote: 'Zebrafish regenerate heart tissue.', source: 's', places: [{ bank: 'tmp' }] },
        { key: 't3', quote: 'Zebrafish share genes with humans.', source: 's', places: [{ bank: 'tmp' }, { bank: 'keep' }] },
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
    expect(await treeCount(page, 'Inbox')).toBe(3); // i1 + t1 + t2 (t3 stays in Keep)
    expect(await treeCount(page, 'Keep')).toBe(1);

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
        { key: 'a', quote: 'Fact in the middle folder.', source: 's', places: [{ bank: 'b', folder: 'mid' }] },
        { key: 'c', quote: 'Fact in the leaf folder.', source: 's', places: [{ bank: 'b', folder: 'leaf' }] },
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
    expect(await treeCount(page, 'Top')).toBe(2);
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
    expect(await treeOutline(page)).toEqual(['1:Inbox', '1:Other']);
  });
});
