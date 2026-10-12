import { deleteAllData, openBackupPage } from './helpers.backup';
import {
  dialogOf,
  expect,
  expectAxeClean,
  externalRequests,
  openDashboard,
  openPalette,
  openPreview,
  pageErrors,
  readTable,
  test,
  toast,
} from './helpers.dashboard';
import {
  NOTE_BODY,
  TEXT,
  addLink,
  connectionRow,
  connectionRows,
  fillLink,
  focusedNode,
  graphNodes,
  graphView,
  linkItems,
  linkTo,
  linksSection,
  linksToggle,
  nodeOf,
  openLinks,
  putRelations,
  relationRows,
  seedGraph,
} from './helpers.graph';

/**
 * Links between highlights, notes and knowledge points, and the knowledge graph drawn from them:
 * real Chromium, the real built extension, the real vault. Nothing is mocked; the links are made
 * through the dashboard's own controls (the first test) or written straight into the vault before
 * the first load (the others, which are about what happens to links, not about making them).
 */
test.describe.configure({ timeout: 240_000 });

test.describe('links and the knowledge graph', () => {
  test('links are made in the preview, show on the other end, are drawn as a graph and walked by keyboard; offline', async ({
    env,
  }) => {
    const { ctrl, id } = await seedGraph(env);
    const noteId = (await readTable<{ id: string }>(ctrl, 'notes'))[0]!.id;
    const page = await openDashboard(env);
    await env.context.setOffline(true);
    try {
      // ---- the section is closed, says how many, and starts empty -----------------------------
      await openPreview(page, id.a);
      await expect(linksSection(page).getByRole('heading', { name: 'Links' })).toBeVisible();
      await expect(linksToggle(page)).toHaveText('Show links (0)');
      await expect(linksToggle(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(linkItems(page)).toHaveCount(0);
      await openLinks(page);
      await expect(linksSection(page).getByTestId('links-summary')).toContainText('No links yet');

      // ---- add: aspirin supports clopidogrel, with a note -------------------------------------
      await addLink(page, {
        query: 'clopidogrel',
        pick: id.b,
        type: 'supports',
        note: 'same pathway',
      });
      await expect(linkItems(page)).toHaveCount(1);
      const first = linkTo(page, TEXT.b);
      await expect(first.getByTestId('link-phrase')).toHaveText('Supports');
      await expect(first.getByTestId('link-note')).toContainText('same pathway');
      await expect(first).toContainText('P2Y12 inhibitors'); // the other end's source
      expect(await relationRows(ctrl)).toMatchObject([
        { fromId: id.a, toId: id.b, type: 'supports', note: 'same pathway', deletedAt: null },
      ]);

      // ---- itself and a repeat are refused, with the reason -----------------------------------
      await linksSection(page).getByTestId('link-add').click();
      await linksSection(page).getByTestId('link-search').fill('aspirin');
      const self = linksSection(page).locator(`[data-testid="link-candidate"][data-id="${id.a}"]`);
      await expect(self).toContainText('this is the item you are linking from');
      await expect(self.getByRole('radio')).toBeDisabled();

      await fillLink(page, { query: 'clopidogrel', pick: id.b, type: 'supports' });
      await expect(linksSection(page).getByTestId('link-reason')).toContainText(
        'Already linked as Supports',
      );
      await expect(linksSection(page).getByTestId('link-submit')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expectAxeClean(page, '[data-testid="preview-links"]');
      await linksSection(page).getByTestId('link-cancel').click();
      expect(await relationRows(ctrl)).toHaveLength(1);

      // ---- a link to another highlight and to a note ------------------------------------------
      await addLink(page, { query: 'heparin', pick: id.c, type: 'contradicts' });
      await addLink(page, { query: 'before choosing', pick: noteId, type: 'example' });
      await expect(linkItems(page)).toHaveCount(3);
      await expect(linkTo(page, NOTE_BODY).getByTestId('link-phrase')).toHaveText(
        'Is an example of',
      );
      expect((await relationRows(ctrl)).map((r) => r.type).sort()).toEqual([
        'contradicts',
        'example',
        'supports',
      ]);

      // ---- the other end shows the backlink, with the note ------------------------------------
      await linkTo(page, TEXT.b).getByTestId('link-open').click();
      await expect(page.getByTestId('preview')).toHaveAttribute('data-highlight-id', id.b);
      await expect(linksToggle(page)).toHaveText('Show links (1)');
      await openLinks(page);
      const back = linkTo(page, TEXT.a);
      await expect(back.getByTestId('link-phrase')).toHaveText('Supported by');
      await expect(back.getByTestId('link-note')).toContainText('same pathway');

      // ---- the graph around it ----------------------------------------------------------------
      await linksSection(page).getByTestId('link-graph').click();
      await expect(graphView(page).getByRole('heading', { name: 'Knowledge graph' })).toBeVisible();
      await expect(page.getByTestId('view-graph')).toHaveAttribute('aria-current', 'page');
      await expect(graphNodes(page)).toHaveCount(2);
      await expect(page.getByTestId('graph-summary')).toHaveText('2 items and 1 link.');
      await expect(nodeOf(page, id.b)).toHaveAttribute('data-centre', 'true');

      await graphView(page).getByTestId('graph-depth-2').check();
      await expect(graphNodes(page)).toHaveCount(4);
      await expect(page.getByTestId('graph-summary')).toHaveText('4 items and 3 links.');
      await expect(connectionRows(page)).toHaveCount(4);
      const legend = page.getByTestId('graph-legend');
      for (const line of [
        'Supports thick solid line, arrow',
        'Contradicts dashed line, arrow',
        'Example dash-dot line, arrow',
      ]) {
        await expect(legend).toContainText(line);
      }
      // the same graph as a table: the row of aspirin lists what it is linked to, in words
      const row = connectionRow(page, `highlight:${id.a}`);
      await expect(row).toContainText(TEXT.a);
      await expect(row).toContainText('Supports');
      await expect(row).toContainText('Contradicts');
      await expect(row).toContainText('Is an example of');
      await expectAxeClean(page, '[data-testid="graph-view"]');

      // ---- the keyboard walks the links; Enter opens; Escape returns --------------------------
      await nodeOf(page, id.b).focus();
      expect(await focusedNode(page)).toBe(`highlight:${id.b}`);
      await page.keyboard.press('ArrowRight');
      expect(await focusedNode(page)).toBe(`highlight:${id.a}`);
      await page.keyboard.press('ArrowRight');
      const further = await focusedNode(page);
      expect([`highlight:${id.c}`, `note:${noteId}`]).toContain(further);
      await page.keyboard.press('ArrowDown');
      expect(await focusedNode(page)).not.toBe(further);
      await page.keyboard.press('ArrowLeft');
      expect(await focusedNode(page)).toBe(`highlight:${id.a}`);
      await page.keyboard.press('Enter');
      await expect(graphView(page)).toHaveCount(0);
      await expect(page.getByTestId('preview')).toHaveAttribute('data-highlight-id', id.a);

      // the command palette and the nav button reach the graph; Escape leaves it
      const palette = await openPalette(page);
      await palette.locator('[data-command-id="view-graph"]').click();
      await expect(graphNodes(page)).toHaveCount(4); // aspirin and what it is linked to
      await nodeOf(page, id.a).focus();
      await page.keyboard.press('Escape');
      await expect(graphView(page)).toHaveCount(0);
      await expect(page.getByTestId('view-library')).toHaveAttribute('aria-current', 'page');
    } finally {
      await env.context.setOffline(false);
    }
    expect(externalRequests(page)).toEqual([]);
    expect(pageErrors(page)).toEqual([]);
  });

  test('changing the type, the note and removing are undoable', async ({ env }) => {
    const { ctrl, id } = await seedGraph(env);
    await putRelations(ctrl, [{ from: id.a, to: id.b, type: 'related' }]);
    const page = await openDashboard(env);
    await openPreview(page, id.a);
    await openLinks(page);
    const link = linkTo(page, TEXT.b);

    await link.getByTestId('link-type').selectOption('prerequisite');
    await expect(link).toHaveAttribute('data-type', 'prerequisite');
    await expect(link.getByTestId('link-phrase')).toHaveText('Is a prerequisite of');
    await expect
      .poll(async () =>
        (await relationRows(ctrl)).filter((r) => r.deletedAt === null).map((r) => r.type),
      )
      .toEqual(['prerequisite']);
    await toast(page, 'Changed the link to Prerequisite.')
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(link).toHaveAttribute('data-type', 'related');

    await link.getByTestId('link-note-edit').click();
    await link.getByTestId('link-note-input').fill('check the chapter');
    await link.getByTestId('link-note-save').click();
    await expect(link.getByTestId('link-note')).toContainText('check the chapter');

    await link.getByTestId('link-remove').click();
    await expect(linkItems(page)).toHaveCount(0);
    const undo = toast(page, 'Removed the link.').getByRole('button', { name: 'Undo' });
    await expect(undo).toBeFocused();
    await undo.click();
    await expect(linkItems(page)).toHaveCount(1);
    expect((await relationRows(ctrl)).filter((r) => r.deletedAt === null)).toMatchObject([
      { fromId: id.a, toId: id.b, type: 'related', note: 'check the chapter' },
    ]);
    expect(pageErrors(page)).toEqual([]);
  });

  test('an end in the trash hides the link in every window, restoring brings it back, purging removes it', async ({
    env,
  }) => {
    const { ctrl, id } = await seedGraph(env);
    await putRelations(ctrl, [
      { from: id.a, to: id.b, type: 'supports' },
      { from: id.b, to: id.c, type: 'cause' },
    ]);
    const page = await openDashboard(env);
    await openPreview(page, id.a);
    await expect(linksToggle(page)).toHaveText('Show links (1)');

    // A second window moves clopidogrel to the trash.
    const other = await openDashboard(env);
    await openPreview(other, id.b);
    await expect(linksToggle(other)).toHaveText('Show links (2)');
    await other.getByTestId('preview-trash').click();
    await expect(toast(other, 'Moved the highlight to the trash.')).toBeVisible();

    // The first window follows without a reload: the link is hidden, not deleted.
    await expect(linksToggle(page)).toHaveText('Show links (0)');
    expect((await relationRows(ctrl)).filter((r) => r.deletedAt === null)).toHaveLength(2);
    await page.getByTestId('view-graph').click();
    await expect(graphNodes(page)).toHaveCount(1);
    await expect(page.getByText('This item has no links yet')).toBeVisible();

    // Restoring it from the Trash brings both links back.
    await other.getByTestId('view-trash').click();
    await other.getByTestId('trash-list').getByRole('checkbox').first().check();
    await other.getByTestId('trash-restore').click();
    await expect(other.getByTestId('trash-outcome')).toContainText('Restored');
    await expect(graphNodes(page)).toHaveCount(2);
    await page.getByTestId('view-library').click();
    await expect(linksToggle(page)).toHaveText('Show links (1)');

    // Purging it removes the links for good, in the same step.
    await other.getByTestId('view-library').click();
    await openPreview(other, id.b);
    await other.getByTestId('preview-trash').click();
    await other.getByTestId('view-trash').click();
    await other.getByTestId('trash-list').getByRole('checkbox').first().check();
    await other.getByTestId('trash-purge').click();
    await dialogOf(other, /^Permanently delete/)
      .getByTestId('dialog-confirm')
      .click();
    await expect(other.getByTestId('trash-outcome')).toContainText('Permanently deleted');
    await expect.poll(() => relationRows(ctrl)).toEqual([]);
    await expect(linksToggle(page)).toHaveText('Show links (0)');
    await page.getByTestId('view-graph').click();
    await expect(page.getByText('This item has no links yet')).toBeVisible();
    await page.getByTestId('graph-overview').click();
    await expect(page.getByText('No links yet', { exact: true })).toBeVisible();
    expect(pageErrors(page)).toEqual([]);
    expect(pageErrors(other)).toEqual([]);
  });

  test('the whole-vault view lists what is most connected instead of drawing everything', async ({
    env,
  }) => {
    const { ctrl, id } = await seedGraph(env);
    await putRelations(ctrl, [
      { from: id.a, to: id.b, type: 'supports' },
      { from: id.a, to: id.c, type: 'contradicts' },
    ]);
    const page = await openDashboard(env);
    await page.getByTestId('view-graph').click();
    await expect(page.getByTestId('graph-summary')).toHaveText(
      /^2 links between 3 items, in 1 group/,
    );
    await expect(page.getByTestId('graph-svg')).toHaveCount(0);
    const top = page.getByTestId('graph-top-item');
    await expect(top).toHaveCount(3);
    await expect(top.first()).toHaveAttribute('data-node', `highlight:${id.a}`);
    await expect(top.first()).toContainText('2 connections');
    await expectAxeClean(page, '[data-testid="graph-view"]');

    await top.first().getByTestId('graph-centre').click();
    await expect(graphNodes(page)).toHaveCount(3);
    await page.getByTestId('graph-overview').click();
    await expect(page.getByTestId('graph-svg')).toHaveCount(0);
  });

  test('Delete all data removes the links, and the graph is empty afterwards', async ({ env }) => {
    const { ctrl, id } = await seedGraph(env);
    await putRelations(ctrl, [
      { from: id.a, to: id.b, type: 'supports' },
      { from: id.b, to: id.c, type: 'example' },
    ]);
    expect(await relationRows(ctrl)).toHaveLength(2);

    const options = await openBackupPage(env);
    await deleteAllData(options);
    expect(await relationRows(ctrl)).toEqual([]);

    const page = await openDashboard(env, {}, { settle: false });
    await page.getByTestId('view-graph').click();
    await expect(page.getByText('No links yet', { exact: true })).toBeVisible();
    expect(pageErrors(page)).toEqual([]);
  });
});
