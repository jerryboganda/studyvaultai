import type { Page } from '@playwright/test';
import { KIND_DECORATION } from '@highlights';
import { DEFAULT_DENY_HOSTS, HIGHLIGHT_KINDS, KIND_LABELS } from '@shared';
import { IN_PAGE_KEYS, describeCommand } from '@ui/shortcuts';
import { openDisclosure } from './helpers.backup';
import { pickCard } from './helpers.graph';
import {
  activate,
  activeTexts,
  bgData,
  captureSelectionVia,
  closedPort,
  errorsOf,
  expect,
  highlightRuleFor,
  highlightsOf,
  layoutReport,
  luminanceOf,
  openExt,
  openFixture,
  openRealPopup,
  pageLuminance,
  pageListState,
  paintedByColor,
  patchSettings,
  publishedRangeCount,
  saveBlock,
  saveBlockToBank,
  selectBlockProgrammatically,
  storedSettings,
  tabIdOf,
  targetIds,
  test,
  toolbarOf,
  tripleClickBlock,
  viewing,
  waitForPageList,
  RawTarget,
  OVERLAY_HOST,
} from './helpers.pages';

/**
 * Extension pages (popup, side panel, options) in real Chromium with the real built extension.
 * See helpers.pages.ts for how a fixture page is made the "active tab" of popup/side panel.
 */

// =============================================================================================
// POPUP
// =============================================================================================

test.describe('popup: state matrix', () => {
  test('an extension page that is itself the active tab is reported as unsupported', async ({
    env,
  }) => {
    const popup = await openExt(env, 'popup'); // opened as a tab: active tab == the popup
    await expect(popup.getByRole('heading', { name: "Can't run here" })).toBeVisible();
    await expect(popup.getByText('Not a website', { exact: true })).toBeVisible();
    // The address type is named in the (i), which also describes its button.
    await expect(popup.getByRole('button', { name: 'Why not here' })).toHaveAccessibleDescription(
      /This is a chrome-extension: page/,
    );
    // Nothing to activate here, but the side panel (saved highlights from every page) is always offered.
    await expect(popup.getByRole('button', { name: /^(Turn on|Always on)/ })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();
    expect(errorsOf(popup)).toEqual([]);
  });

  const BROWSER_PAGES = [
    { label: 'about:blank', url: null },
    { label: 'a data: URL', url: 'data:text/html,<title>Data</title><p>hello</p>' },
    { label: 'chrome://version', url: 'chrome://version/' },
    { label: 'chrome://extensions', url: 'chrome://extensions/' },
  ] as const;

  for (const { label, url } of BROWSER_PAGES) {
    test(`${label} is reported as unsupported and offers no actions`, async ({ env }) => {
      const page = await env.context.newPage();
      if (url) await page.goto(url);
      const popup = await viewing(env, 'popup', page);
      await expect(popup.getByRole('heading', { name: "Can't run here" })).toBeVisible();
      // Chrome shares no address for these tabs (the popup's own tab said "Not a website").
      await expect(popup.getByText('Browser page', { exact: true })).toBeVisible();
      // The way out is in the (i), which also describes its button.
      await expect(popup.getByRole('button', { name: 'Why not here' })).toHaveAccessibleDescription(
        /Open a regular website to save\./,
      );
      await expect(popup.getByRole('button', { name: /^(Turn on|Always on)/ })).toHaveCount(0);
      // What is left: the side panel (it works without the page) and the way out to settings.
      await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Settings and privacy' })).toBeVisible();
      expect(errorsOf(popup)).toEqual([]);
    });
  }

  test('a denied host shows why, and "Allow" removes only its entry and re-enables activation', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    await patchSettings(ext, { denyList: ['localhost', 'accounts.google.com'] });
    const page = await openFixture(env, '/article.html', {
      activate: false,
      origin: env.altOrigin,
    });
    const popup = await viewing(env, 'popup', page);

    await expect(popup.getByRole('heading', { name: 'localhost' })).toBeVisible();
    await expect(popup.getByText('Not allowed', { exact: true })).toBeVisible();
    await expect(popup.getByText('On your deny list', { exact: true })).toBeVisible();
    await expect(
      popup.getByRole('button', { name: 'About the deny list' }),
    ).toHaveAccessibleDescription(/localhost is on your deny list/);
    await expect(popup.getByRole('button', { name: 'Turn on' })).toHaveCount(0);

    await popup.getByRole('button', { name: 'Allow this site' }).click();
    // Not running yet: the off state offers Turn on.
    await expect(popup.getByText('Off', { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await storedSettings(ext))?.denyList)
      .toEqual(['accounts.google.com']);

    // And activation now really works on that origin.
    await popup.getByRole('button', { name: 'Turn on' }).click();
    await expect(popup.getByTestId('popup-page-count')).toHaveText('0 highlights on this page');
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
  });

  test('an active page shows its highlight count, recent saves and the last-used bank', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await bgData(ext, 'bank.create', { name: 'Cardiology' });
    await saveBlock(ext, page, '#p-intro', 'Save as Formula');
    await saveBlockToBank(ext, page, '#p-multiline', 'Cardiology');

    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByRole('heading', { name: '127.0.0.1', exact: true })).toBeVisible();
    await expect(popup.getByTestId('popup-page-count')).toHaveText('2 highlights on this page');
    const saves = popup.getByRole('region', { name: 'Recent saves' });
    // The bank pill shows the name; "Last used bank:" is its spoken prefix.
    await expect(saves).toContainText('Last used bank: Cardiology');
    await expect(saves.locator('strong', { hasText: 'Cardiology' })).toBeVisible();

    const recent = saves.getByRole('listitem');
    await expect(recent).toHaveCount(2);
    // Newest first: the Cardiology save, then the Formula save.
    await expect(recent.nth(0)).toContainText('atrioventricular node');
    await expect(recent.nth(0)).toContainText('Essential fact');
    await expect(recent.nth(1)).toContainText('sinoatrial node is the primary pacemaker');
    await expect(recent.nth(1)).toContainText('Formula');
    await expect(recent.nth(1)).toContainText('Cardiac Physiology Primer · 127.0.0.1');
    expect(errorsOf(popup)).toEqual([]);
  });

  test('a page StudyVault is not running on offers Activate, and activating makes the toolbar work', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html', { activate: false });

    // Before: nothing of StudyVault is in the page and a selection produces no toolbar.
    await tripleClickBlock(page, '#p-intro');
    await page.waitForTimeout(400); // 6x the controller's documented 60 ms selection debounce
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
    await expect(toolbarOf(page)).toHaveCount(0);

    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText('Off', { exact: true })).toBeVisible();
    await popup.getByRole('button', { name: 'Turn on' }).click();
    await expect(popup.getByTestId('popup-page-count')).toHaveText('0 highlights on this page');
    // Active on this tab only: the "Always on" switch stays off, and its (i) says what that means.
    await expect(popup.getByRole('switch', { name: 'Always on' })).not.toBeChecked();
    await expect(
      popup.getByRole('button', { name: 'About always on' }),
    ).toHaveAccessibleDescription(/Off: on for this tab only/);

    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await saveBlock(ext, page, '#p-intro');
    await expect(page.getByText(/Saved to Inbox/)).toBeVisible();
  });

  test('an activation failure on a real browser error page is shown with a working Retry', async ({
    env,
  }) => {
    const port = await closedPort();
    const page = await env.context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`).catch(() => undefined); // ERR_CONNECTION_REFUSED
    const popup = await viewing(env, 'popup', page);

    await expect(popup.getByText('Off', { exact: true })).toBeVisible();
    await popup.getByRole('button', { name: 'Turn on' }).click();

    const alert = popup.getByRole('alert');
    await expect(alert).toContainText('That did not work');
    await expect(alert).toContainText(/StudyVault cannot run on this page/);
    await expect(alert).toContainText(/error page/);

    // Retry is not a dead control: it runs again, ends in the same explained error, and recovers.
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(alert).toContainText(/error page/);
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});

test.describe('popup: Open side panel', () => {
  test('the click opens the real side panel and the popup closes itself', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    const popup = await viewing(env, 'popup', page);
    await expect(targetIdsAsync(env, '/sidepanel.html')).resolves.toEqual([]);

    const closed = popup.waitForEvent('close');
    await popup.getByRole('button', { name: 'Open side panel' }).click();
    await closed; // window.close() only runs after chrome.sidePanel.open() resolved
    await expect.poll(() => targetIdsAsync(env, '/sidepanel.html')).toHaveLength(1);
  });

  test('the genuine action popup (chrome.action.openPopup) reflects the active tab and drives the genuine side panel', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html', { activate: false });
    const tabId = await tabIdOf(ext, page); // the fixture page is the window's active tab

    // From here on NOTHING may activate another window or tab: Chrome closes an action popup as
    // soon as it loses activation (observed on the Linux runner, where the old flow brought the
    // page to the front and clicked in it, and the popup was gone before "Open side panel"). So
    // the page work below uses the DOM Selection API plus the shortcut/context-menu RPC instead
    // of pointer input; the toolbar's own save path is covered by every saveBlock() test.
    const popup = await openRealPopup(env);
    await popup.waitForText(/\bTurn on\b/);
    expect(await popup.text()).toContain('127.0.0.1');
    await popup.clickButton('Turn on');
    // "0" is visible; " highlights on this page" is its visually hidden rest.
    await popup.waitForText(/\b0\s*highlights on this page/);
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);

    await selectBlockProgrammatically(page, '#p-intro');
    const saved = await captureSelectionVia(ext, tabId);
    expect(saved).toMatchObject({ ok: true, data: { status: 'created' } });
    await expect.poll(async () => (await highlightsOf(ext, page.url())).length).toBe(1);
    expect(popup.closed, 'the popup must still be open after the page saved a highlight').toBe(
      false,
    );

    await popup.clickButton('Open side panel');
    await expect.poll(() => targetIdsAsync(env, '/popup.html')).toHaveLength(0);
    let panelId = '';
    await expect
      .poll(async () => {
        panelId = (await targetIds(env.context, '/sidepanel.html'))[0] ?? '';
        return panelId;
      })
      .not.toBe('');

    // The real side panel sees the real active tab and lists the saved highlight.
    const panel = await RawTarget.attach(env.context, panelId);
    await panel.waitForText(/Cardiac Physiology Primer/);
    await panel.waitForText(/sinoatrial node is the primary pacemaker/);
    // One saved highlight (the old header's "1 highlight saved"): one card in This page.
    expect(await panel.eval<number>('document.querySelectorAll("article").length')).toBe(1);
  });
});

/** targetIds as a plain promise for `expect(...).resolves` / `expect.poll`. */
function targetIdsAsync(env: { context: Parameters<typeof targetIds>[0] }, suffix: string) {
  return targetIds(env.context, suffix);
}

// =============================================================================================
// SIDE PANEL
// =============================================================================================

test.describe('side panel: page list and editing', () => {
  test('lists the active tab highlights in reading order with kind, banks and count', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-multiline', 'Save as Formula');
    await saveBlock(ext, page, '#p-intro'); // later in time, earlier on the page

    const side = await viewing(env, 'sidepanel', page);
    await expect(
      side.getByRole('heading', { level: 2, name: 'Cardiac Physiology Primer' }),
    ).toBeVisible();
    // The count's parentheses are visually hidden spans, so the name reads "On this page ( 2 )".
    await expect(
      side.getByRole('heading', { level: 3, name: /^On this page \(\s*2\s*\)$/ }),
    ).toBeVisible();
    await expect(side.getByRole('tab', { name: /This page \(2\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const cards = side.getByRole('article');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAccessibleName(/^Essential fact: The sinoatrial node/);
    await expect(cards.nth(1)).toHaveAccessibleName(/^Formula: Depolarisation spreads/);
    await expect(
      cards.nth(0).getByRole('list', { name: 'Banks and tags' }).getByText('Inbox'),
    ).toBeVisible();
    // Found on the page: stored as resolved, and the card shows no status badge (only states that
    // need a look, or a changed source, are badged).
    await expect
      .poll(async () => (await highlightsOf(ext, page.url())).map((h) => h.resolveStatus))
      .toEqual(['resolved', 'resolved']);
    await expect(cards.nth(0).locator('.hl-card__state')).toHaveCount(0);
    expect(errorsOf(side)).toEqual([]);
  });

  test('an empty page says so', async ({ env }) => {
    const page = await openFixture(env, '/pages-b.html');
    const side = await viewing(env, 'sidepanel', page);
    await expect(
      side.getByRole('heading', { level: 2, name: 'Renal Physiology Notes' }),
    ).toBeVisible();
    // The heading comes from the tab; the list comes from the database. Wait for the panel's own
    // settled state (not for a text that may or may not show up) and then assert WHICH state it is:
    // a failed load must surface as its own message, not as a 10 s "text not found".
    await expect(side.getByRole('tab', { name: /^This page/ })).toBeVisible();
    await waitForPageList(side);
    expect(await pageListState(side), 'the panel loaded the list of an empty page').toBe('empty');
    await expect(side.getByRole('heading', { level: 3, name: 'Nothing saved yet' })).toBeVisible();
    // A zero count is not drawn: the tab is just "This page".
    await expect(side.getByRole('tab', { name: 'This page', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('a note autosaves after a pause and survives a reload of the side panel', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    const side = await viewing(env, 'sidepanel', page);

    const note = side.getByLabel('Your note');
    await note.fill('Check the resting rate against the textbook value.');
    await expect(side.getByText('Saved', { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await highlightsOf(ext, page.url()))[0]?.userComment)
      .toBe('Check the resting rate against the textbook value.');

    await side.reload();
    await expect(side.getByLabel('Your note')).toHaveValue(
      'Check the resting rate against the textbook value.',
    );
  });

  test('changing the kind repaints the highlight in the new colour on the page; priority persists', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro'); // Essential fact => amber
    await expect
      .poll(() => paintedByColor(page))
      .toEqual({ amber: [expect.stringContaining('sinoatrial node')] });

    const side = await viewing(env, 'sidepanel', page);
    // Kind and priority are radio groups behind the card's "More actions".
    await side.getByTestId('card-more').click();
    const formula = side.getByRole('radio', { name: KIND_LABELS.formula.label, exact: true });
    await formula.click(); // controlled: it shows checked once the save comes back
    await expect
      .poll(() => paintedByColor(page))
      .toEqual({ blue: [expect.stringContaining('sinoatrial node')] });
    await expect(side.getByRole('article')).toHaveAccessibleName(/^Formula:/);
    await expect(formula).toBeChecked();

    await side.getByRole('radio', { name: '5 (highest)' }).click();
    await expect.poll(async () => (await highlightsOf(ext, page.url()))[0]?.priority).toBe(5);
    await expect(side.getByRole('radio', { name: '5 (highest)' })).toBeChecked();
    const [row] = await highlightsOf(ext, page.url());
    expect(row).toMatchObject({ kind: 'formula', color: 'blue', priority: 5 });
  });

  test('Show on page scrolls to the highlight and flashes the active style, then clears it', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await page.setViewportSize({ width: 800, height: 300 });
    await saveBlock(ext, page, '#p-refs'); // the last paragraph, below the fold
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    expect(await activeTexts(page)).toEqual([]);

    const side = await viewing(env, 'sidepanel', page);
    await side.getByRole('button', { name: 'Show on page' }).click();
    // Shown in the card and also spoken through the panel's status region: look at the card's.
    await expect(
      side.getByRole('article').getByText('Showing this highlight on the page.'),
    ).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await expect
      .poll(() => activeTexts(page))
      .toEqual([expect.stringContaining('Guyton and Hall')]);
    // The product clears the flash after REVEAL_FLASH_MS (2 s).
    await expect.poll(() => activeTexts(page), { timeout: 8_000 }).toEqual([]);
  });

  test('Delete removes the highlight everywhere and Undo brings it back', async ({ env }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });

    const side = await viewing(env, 'sidepanel', page);
    // Delete sits behind the card's "More actions".
    await side.getByTestId('card-more').click();
    await side.getByTestId('card-drawer').getByRole('button', { name: 'Delete' }).click();
    await expect(side.getByText('Highlight deleted. It stays in Trash.')).toBeVisible();
    await expect(side.getByRole('heading', { level: 3, name: 'Nothing saved yet' })).toBeVisible();
    await expect.poll(() => paintedByColor(page)).toEqual({});
    expect(await highlightsOf(ext, page.url())).toHaveLength(0);

    await side.getByRole('button', { name: 'Undo' }).click();
    await expect(side.getByText('Highlight restored.')).toBeVisible();
    await expect(side.getByRole('article')).toHaveCount(1);
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });
    expect(await highlightsOf(ext, page.url())).toHaveLength(1);
  });
});

test.describe('side panel: highlights that need attention', () => {
  test('an orphaned highlight (source text removed) is grouped under Needs attention', async ({
    env,
    fixtureServer,
  }) => {
    const ext = await openExt(env, 'options');
    fixtureServer.setVariant('original');
    try {
      const page = await openFixture(env, '/mutable.html');
      await saveBlock(ext, page, '#target');

      fixtureServer.setVariant('removed');
      await page.reload();
      await activate(env, page);
      await expect
        .poll(async () => (await highlightsOf(ext, page.url()))[0]?.resolveStatus)
        .toBe('orphaned');
      await expect.poll(() => paintedByColor(page)).toEqual({});

      const side = await viewing(env, 'sidepanel', page);
      await expect(
        side.getByRole('heading', { level: 3, name: /^Needs a look \(\s*1\s*\)$/ }),
      ).toBeVisible();
      // One saved, and it is the one that needs a look: nothing is listed as found on the page.
      await expect(side.getByRole('tab', { name: 'This page (1)' })).toBeVisible();
      await expect(side.getByRole('heading', { name: /^On this page/ })).toHaveCount(0);
      const card = side.getByRole('article');
      await expect(card.getByText('Not found', { exact: true })).toBeVisible();
      await expect(
        card.getByRole('button', { name: 'Why it needs a look' }),
      ).toHaveAccessibleDescription(/could not be found on the page/);
      // The saved quote is unchanged and still readable.
      await expect(card).toContainText('Calcium channels open when the membrane depolarises');

      // Show on page is honest about not finding it instead of failing silently.
      await card.getByRole('button', { name: 'Show on page' }).click();
      await expect(
        card.getByText(/could not find this highlight on the page right now/),
      ).toBeVisible();
    } finally {
      fixtureServer.setVariant('original');
    }
  });

  test('an ambiguous highlight (quote now occurs twice) is grouped under Needs attention and not painted', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/pages-mutate.html');
    await saveBlock(ext, page, '#finding');
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });

    // Same page identity (the fragment is not part of it), different content.
    await page.goto('about:blank');
    await page.goto(`${env.origin}/pages-mutate.html#v=ambiguous`);
    await activate(env, page);
    await expect
      .poll(
        async () => (await highlightsOf(ext, `${env.origin}/pages-mutate.html`))[0]?.resolveStatus,
      )
      .toBe('ambiguous');
    await expect.poll(() => paintedByColor(page)).toEqual({});

    const side = await viewing(env, 'sidepanel', page);
    await expect(
      side.getByRole('heading', { level: 3, name: /^Needs a look \(\s*1\s*\)$/ }),
    ).toBeVisible();
    const card = side.getByRole('article');
    await expect(card.getByText('Many matches', { exact: true })).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Why it needs a look' }),
    ).toHaveAccessibleDescription(/matches more than one place on the page/);
  });
});

test.describe('side panel: tabs and cross-page views', () => {
  test('follows tab switches: live page, another live page, and a page StudyVault is not running on', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const a = await openFixture(env, '/article.html');
    await saveBlock(ext, a, '#p-intro');
    const b = await openFixture(env, '/pages-b.html');
    await saveBlock(ext, b, '#p-gfr');
    const c = await openFixture(env, '/index.html', { activate: false });

    const side = await viewing(env, 'sidepanel', a);
    await expect(
      side.getByRole('heading', { level: 2, name: 'Cardiac Physiology Primer' }),
    ).toBeVisible();
    await expect(side.getByRole('article')).toHaveCount(1);
    await expect(side.getByRole('article')).toContainText('sinoatrial node');

    await b.bringToFront();
    await expect(
      side.getByRole('heading', { level: 2, name: 'Renal Physiology Notes' }),
    ).toBeVisible();
    await expect(side.getByRole('article')).toHaveCount(1);
    await expect(side.getByRole('article')).toContainText('glomerular filtration rate');
    await expect(side.getByRole('article')).not.toContainText('sinoatrial');

    await c.bringToFront();
    await expect(side.getByText('StudyVault is not running on this tab')).toBeVisible();
    await expect(side.getByRole('article')).toHaveCount(0);
    await side.getByRole('button', { name: 'Activate on this tab' }).click();
    await expect(side.getByRole('heading', { level: 3, name: 'Nothing saved yet' })).toBeVisible();
    await expect(c.locator(OVERLAY_HOST)).toHaveCount(1);

    await a.bringToFront();
    await expect(side.getByRole('article')).toContainText('sinoatrial node');
  });

  test('a page that is not running keeps saved highlights readable but disables Show on page with a reason', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await page.reload(); // the injected script does not survive navigation

    const side = await viewing(env, 'sidepanel', page);
    await expect(side.getByText('StudyVault is not running on this tab')).toBeVisible();
    const card = side.getByRole('article');
    await expect(card).toContainText('sinoatrial node');
    const show = card.getByRole('button', { name: 'Show on page' });
    await expect(show).toHaveAttribute('aria-disabled', 'true');
    await expect(show).toHaveAccessibleDescription(/not running in the current tab/);
    expect(await paintedByColor(page)).toEqual({});

    await side.getByRole('button', { name: 'Activate on this tab' }).click();
    await expect(side.getByText('StudyVault is not running on this tab')).toHaveCount(0);
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });
    await expect(show).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('Recent lists highlights from all pages newest first and ties each to its source', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const a = await openFixture(env, '/article.html');
    await saveBlock(ext, a, '#p-intro');
    const b = await openFixture(env, '/pages-b.html');
    await saveBlock(ext, b, '#p-gfr');

    const side = await viewing(env, 'sidepanel', a);
    // Recent is a page of the More tab.
    await side.getByRole('tab', { name: 'More', exact: true }).click();
    await side.getByRole('button', { name: 'Recent', exact: true }).click();
    await expect(side.getByRole('heading', { level: 2, name: 'Recent' })).toBeVisible();
    const cards = side.getByRole('article');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('glomerular filtration rate');
    await expect(cards.nth(0)).toContainText('From Renal Physiology Notes · 127.0.0.1');
    await expect(cards.nth(0).getByRole('link', { name: 'Open page' })).toHaveAttribute(
      'href',
      `${env.origin}/pages-b.html`,
    );
    await expect(cards.nth(1)).toContainText('From Cardiac Physiology Primer · 127.0.0.1');

    // Only the highlight that belongs to the active page can be shown on it.
    const other = cards.nth(0).getByRole('button', { name: 'Show on page' });
    await expect(other).toHaveAttribute('aria-disabled', 'true');
    await expect(other).toHaveAccessibleDescription(/from another page/);
    const own = cards.nth(1).getByRole('button', { name: 'Show on page' });
    await expect(own).not.toHaveAttribute('aria-disabled', 'true');
    await own.click();
    await expect.poll(() => activeTexts(a)).toEqual([expect.stringContaining('sinoatrial node')]);
  });
});

test.describe('side panel: narrow widths', () => {
  test('no horizontal scroll or clipped controls at 320 px and at 200% browser zoom', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/pages-b.html');
    await saveBlock(ext, page, '#p-long'); // 300+ unbroken characters
    await saveBlock(ext, page, '#p-gfr');
    const side = await viewing(env, 'sidepanel', page);
    await expect(side.getByRole('article')).toHaveCount(2);

    await side.setViewportSize({ width: 320, height: 700 });
    await expect.poll(() => side.evaluate(() => window.innerWidth)).toBe(320);
    let report = await layoutReport(side);
    expect(
      report.scrollWidth,
      'document must not scroll horizontally at 320px',
    ).toBeLessThanOrEqual(report.innerWidth);
    expect(report.offenders, report.offenders.join('\n')).toEqual([]);

    // Real browser zoom: tabs.setZoom(2) halves the CSS viewport (320 -> 160 CSS px).
    const zoomed = await side.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      await chrome.tabs.setZoom(tab?.id ?? 0, 2);
      return chrome.tabs.getZoom(tab?.id ?? 0);
    });
    expect(zoomed).toBe(2);
    await expect.poll(() => side.evaluate(() => window.innerWidth)).toBe(160);
    report = await layoutReport(side);
    expect(
      report.scrollWidth,
      'document must not scroll horizontally at 200% zoom',
    ).toBeLessThanOrEqual(report.innerWidth);
    expect(report.offenders, report.offenders.join('\n')).toEqual([]);
    // The card's editors (kind, priority, tags, notes, Delete) open from "More actions": they fit too.
    await side.getByTestId('card-more').first().click();
    const drawer = side.getByTestId('card-drawer');
    await expect(drawer.getByRole('button', { name: 'Delete' })).toBeVisible();
    report = await layoutReport(side);
    expect(
      report.scrollWidth,
      'an open card drawer must not scroll horizontally at 200% zoom',
    ).toBeLessThanOrEqual(report.innerWidth);
    expect(report.offenders, `drawer: ${report.offenders.join('\n')}`).toEqual([]);

    // All five tabs stay reachable at 160 CSS px (icons on one row), and no tab's content overflows.
    // Recent is a page of More: it is checked after More.
    await expect(side.getByRole('tab')).toHaveCount(5);
    for (const name of ['Search', 'Banks', 'Review', 'More', 'Recent']) {
      if (name === 'Recent') {
        await side.getByRole('button', { name: 'Recent', exact: true }).click();
        await expect(side.getByRole('heading', { level: 2, name: 'Recent' })).toBeVisible();
      } else {
        await side.getByRole('tab', { name, exact: true }).click();
        await expect(side.getByRole('tab', { name, exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      }
      if (name === 'Search') {
        await side.getByRole('searchbox').fill('A'.repeat(300));
        await side.getByRole('button', { name: 'Search syntax' }).click();
      }
      report = await layoutReport(side);
      expect(
        report.scrollWidth,
        `the ${name} tab must not scroll horizontally at 200% zoom`,
      ).toBeLessThanOrEqual(report.innerWidth);
      expect(report.offenders, `${name}: ${report.offenders.join('\n')}`).toEqual([]);
    }
  });

  test('the popup stays within its 360 px column with long unbroken text', async ({ env }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/pages-b.html');
    await saveBlock(ext, page, '#p-long');
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByTestId('popup-page-count')).toHaveText('1 highlight on this page');
    // The long quote is in Recent saves, which is what could push the column wider.
    await expect(popup.getByRole('region', { name: 'Recent saves' })).toContainText(
      'Reference token: AAAAAAAAAA',
    );
    await popup.setViewportSize({ width: 360, height: 640 });
    const report = await layoutReport(popup);
    expect(report.scrollWidth).toBeLessThanOrEqual(report.innerWidth);
    expect(report.offenders, report.offenders.join('\n')).toEqual([]);
  });
});

test.describe('side panel: tabs, address hash and Search', () => {
  test('five tabs in order; the address hash picks the tab and tab changes update it', async ({
    env,
  }) => {
    const page = await openFixture(env, '/pages-b.html');
    const side = await viewing(env, 'sidepanel', page);
    await expect(side.getByRole('tablist', { name: 'Side panel' })).toBeVisible();
    await expect(side.getByRole('tab')).toHaveText([
      /^This page/,
      /^Banks$/,
      /^Review/,
      /^Search$/,
      /^More$/,
    ]);
    // Recent lives in More; its old address still works and selects More.
    await side.evaluate(() => {
      location.hash = '#recent';
    });
    await expect(side.getByRole('tab', { name: 'More', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(side.getByRole('heading', { level: 2, name: 'Recent' })).toBeVisible();

    await side.getByRole('tab', { name: 'Search' }).click();
    await expect.poll(() => side.evaluate(() => location.hash)).toBe('#search');
    await side.reload();
    await expect(side.getByRole('tab', { name: 'Search' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      side.getByRole('searchbox', { name: 'Search highlights and notes' }),
    ).toBeVisible();
  });

  test('Search finds a saved quote with the words marked, works offline and says when nothing matches', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await saveBlock(ext, page, '#p-refs');
    const side = await viewing(env, 'sidepanel', page);
    await side.getByRole('tab', { name: 'Search' }).click();
    const box = side.getByRole('searchbox', { name: 'Search highlights and notes' });

    await env.context.setOffline(true);
    try {
      await box.fill('sinoatrial');
      const cards = side.getByTestId('search-results').getByRole('article');
      await expect(cards).toHaveCount(1);
      await expect(cards.locator('mark')).toHaveText('sinoatrial');
      await expect(side.getByTestId('search-status')).toContainText('1 match');

      await box.fill('guyton');
      await expect(cards).toHaveCount(1);
      await expect(cards).toContainText('Guyton and Hall');

      await box.fill('zyzzyva');
      await expect(side.getByText('No results')).toBeVisible();
      await expect(side.getByTestId('search-status')).toHaveText('No matches.');
    } finally {
      await env.context.setOffline(false);
    }
    expect(errorsOf(side)).toEqual([]);
  });

  test('a hit can be shown on the page, opened in the dashboard and turned into a flashcard', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    const [row] = await highlightsOf(ext, page.url());
    const side = await viewing(env, 'sidepanel', page);
    await side.getByRole('tab', { name: 'Search' }).click();
    await side.getByRole('searchbox').fill('sinoatrial');
    const card = side.getByTestId('search-results').getByRole('article');
    await expect(card).toHaveCount(1);

    await card.getByRole('button', { name: 'Show on page' }).click();
    await expect(card.getByText('Showing this highlight on the page.')).toBeVisible();
    await expect
      .poll(() => activeTexts(page))
      .toEqual([expect.stringContaining('sinoatrial node')]);

    const [author] = await Promise.all([
      env.context.waitForEvent('page'),
      card.getByRole('button', { name: 'Make flashcard' }).click(),
    ]);
    await author.waitForURL(/review\.html\?/);
    const authorUrl = new URL(author.url());
    expect(authorUrl.searchParams.get('view')).toBe('create');
    expect(authorUrl.searchParams.get('highlight')).toBe(row!.id);
    await author.close();

    await page.bringToFront();
    await expect(card).toHaveCount(1);
    const [dashboard] = await Promise.all([
      env.context.waitForEvent('page'),
      card.getByRole('button', { name: 'Open in dashboard' }).click(),
    ]);
    await dashboard.waitForURL(/dashboard\.html\?/);
    expect(new URL(dashboard.url()).searchParams.get('highlight')).toBe(row!.id);
    await dashboard.close();
  });

  test('a hit from another page cannot be shown here, and says why', async ({ env }) => {
    const ext = await openExt(env, 'options');
    const a = await openFixture(env, '/article.html');
    await saveBlock(ext, a, '#p-intro');
    const b = await openFixture(env, '/pages-b.html');
    await saveBlock(ext, b, '#p-gfr');
    const side = await viewing(env, 'sidepanel', a);
    await side.getByRole('tab', { name: 'Search' }).click();
    await side.getByRole('searchbox').fill('glomerular');
    const card = side.getByTestId('search-results').getByRole('article');
    await expect(card).toHaveCount(1);
    const show = card.getByRole('button', { name: 'Show on page' });
    await expect(show).toHaveAttribute('aria-disabled', 'true');
    await expect(show).toHaveAccessibleDescription(/from another page/);
  });
});

test.describe('side panel: tags and notes on a card', () => {
  test('a tag and a Markdown note are added on the card, survive a reload, and are searchable', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    const side = await viewing(env, 'sidepanel', page);
    const card = side.getByRole('article');
    const tags = (c: typeof card) => c.getByRole('list', { name: 'Tags', exact: true });

    // Tags and study notes are edited behind the card's "More actions".
    await card.getByTestId('card-more').click();
    await card.getByLabel('Add a tag').fill('exam pearl');
    await card.getByRole('button', { name: 'Add tag' }).click();
    await expect(tags(card).getByText('exam pearl')).toBeVisible();

    await card.getByRole('button', { name: 'Add a note' }).click();
    await card.getByLabel('New study note (Markdown)').fill('Resting rate **60-100** bpm');
    await card.getByRole('button', { name: 'Save note' }).click();
    await expect(card.getByTestId('card-note').locator('strong')).toHaveText('60-100');

    await side.reload();
    const again = side.getByRole('article');
    // Closed card: the tag and the note count are chips.
    const chips = again.getByRole('list', { name: 'Banks and tags' });
    await expect(chips.getByText('exam pearl')).toBeVisible();
    await expect(chips).toContainText('1 study note');
    await again.getByTestId('card-more').click();
    await expect(tags(again).getByText('exam pearl')).toBeVisible();
    await expect(again.getByTestId('card-note').locator('strong')).toHaveText('60-100');
    // The quick note keeps its place as the first text field of the card (the hand-over target).
    await expect(again.locator('textarea').first()).toHaveAttribute('id', /-note$/);

    await side.getByRole('tab', { name: 'Search' }).click();
    const box = side.getByRole('searchbox');
    await box.fill('tag:"exam pearl"');
    await expect(side.getByTestId('search-results').getByRole('article')).toHaveCount(1);
    await box.fill('bpm');
    const hit = side.getByTestId('search-results').getByRole('article');
    await expect(hit).toHaveCount(1);
    await expect(hit.getByText('Matched a note')).toBeVisible();
    expect(errorsOf(side)).toEqual([]);
  });

  test('removing a tag detaches it from this highlight only', async ({ env }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    const side = await viewing(env, 'sidepanel', page);
    const card = side.getByRole('article');
    await card.getByTestId('card-more').click();
    await card.getByLabel('Add a tag').fill('rhythm');
    await card.getByLabel('Add a tag').press('Enter');
    await expect(card.getByRole('list', { name: 'Tags', exact: true })).toContainText('rhythm');

    await card.getByRole('button', { name: 'Remove tag rhythm' }).click();
    await expect(card.getByText('No tags yet.')).toBeVisible();
    // The vocabulary keeps the tag: the field offers it again.
    const listId = await card.getByLabel('Add a tag').getAttribute('list');
    await expect(side.locator(`datalist[id="${listId}"] option[value="rhythm"]`)).toHaveCount(1);
  });
});

test.describe('side panel: banks, folders and the bank filter', () => {
  test('a bank chosen in Banks narrows Recent and Search to it, and opens in the dashboard', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-refs'); // Inbox (the default bank)
    const side = await viewing(env, 'sidepanel', page);
    await side.getByRole('tab', { name: 'Banks' }).click();
    // "New bank" is a wizard: name, icon, colour, Looks good?, then a done screen.
    await side.getByRole('button', { name: 'New bank' }).click();
    const wizard = side.getByRole('dialog', { name: 'New bank' });
    await wizard.getByLabel('Bank name').fill('Cardiology');
    for (let step = 0; step < 3; step++) await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Create bank' }).click();
    const done = side.getByTestId('new-bank-done');
    await expect(done.getByRole('heading', { name: 'Bank ready!' })).toBeVisible();
    await done.getByRole('button', { name: 'Done' }).click();
    await expect(side.getByRole('list', { name: 'Your banks' })).toContainText('Cardiology');
    await saveBlockToBank(ext, page, '#p-intro', 'Cardiology');

    const bank = side.getByTestId('bank-item').filter({ hasText: 'Cardiology' });
    await expect(bank).toContainText('1 saved');
    // Pressing a bank opens it here and narrows Recent and Search to it.
    await bank.getByTestId('bank-filter').click();
    const scope = side.getByTestId('bank-scope');
    await expect(scope.getByRole('heading', { level: 2, name: 'Cardiology' })).toBeVisible();
    await expect(scope).toContainText('1 saved');
    await side.getByRole('button', { name: 'Show folders of Cardiology' }).click();
    await expect(side.getByText('No folders in this bank yet.')).toBeVisible();
    await expect(side.getByRole('article')).toHaveCount(1);
    await expect(side.getByRole('article')).toContainText('sinoatrial node');

    await side.getByRole('tab', { name: 'More', exact: true }).click();
    await side.getByRole('button', { name: 'Recent', exact: true }).click();
    await expect(side.getByRole('article')).toHaveCount(1);
    await expect(side.getByRole('article')).toContainText('sinoatrial node');
    await expect(side.getByTestId('recent-scope')).toContainText('Only Cardiology');

    await side.getByRole('tab', { name: 'Search' }).click();
    await expect(side.getByTestId('search-scope')).toContainText('Only in Cardiology');
    // No words typed: the bank itself is the query.
    const hit = side.getByTestId('search-results').getByRole('article');
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText('sinoatrial node');
    await side.getByRole('searchbox').fill('guyton');
    await expect(side.getByText('No results')).toBeVisible();
    await side.getByTestId('search-everywhere').click();
    await expect(side.getByTestId('search-results').getByRole('article')).toHaveCount(1);

    // "Search everywhere" cleared the bank: open it again for its dashboard action.
    await side.getByRole('tab', { name: 'Banks' }).click();
    await bank.getByTestId('bank-filter').click();
    const [dashboard] = await Promise.all([
      env.context.waitForEvent('page'),
      side.getByRole('button', { name: 'Open Cardiology in the dashboard' }).click(),
    ]);
    await dashboard.waitForURL(/dashboard\.html\?/);
    expect(new URL(dashboard.url()).searchParams.get('bank')).toBeTruthy();
    await dashboard.close();
  });
});

test.describe('side panel: Review tab', () => {
  test('explains that there are no cards yet and opens the card author', async ({ env }) => {
    const page = await openFixture(env, '/pages-b.html');
    const side = await viewing(env, 'sidepanel', page);
    await side.getByRole('tab', { name: 'Review' }).click();
    await expect(side.getByRole('heading', { level: 3, name: 'No cards yet' })).toBeVisible();

    const [author] = await Promise.all([
      env.context.waitForEvent('page'),
      side.getByRole('button', { name: 'Create cards' }).click(),
    ]);
    await author.waitForURL(/review\.html\?/);
    expect(new URL(author.url()).searchParams.get('view')).toBe('create');
    await author.close();
  });
});

// =============================================================================================
// OPTIONS
// =============================================================================================

test.describe('options: theme', () => {
  test('the theme choice persists and applies to options, popup, side panel and the in-page overlay', async ({
    env,
  }) => {
    const page = await openFixture(env, '/article.html');
    const options = await openExt(env, 'options', 'appearance');
    const popup = await viewing(env, 'popup', page);
    const side = await viewing(env, 'sidepanel', page);

    // Baseline: light everywhere.
    await expect(options.getByRole('radio', { name: /^System/ })).toBeChecked();
    const lightOptions = await pageLuminance(options);
    expect(lightOptions).toBeGreaterThan(0.8);

    await pickCard(options.getByRole('radio', { name: /^Dark/ }));
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => pageLuminance(options)).toBeLessThan(0.3);

    // Already-open pages follow without a reload.
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => pageLuminance(popup)).toBeLessThan(0.3);
    await expect(side.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => pageLuminance(side)).toBeLessThan(0.3);

    // The in-page overlay: attribute on the shadow host and the toolbar's computed background.
    await page.bringToFront();
    // The host carries only its marker attribute (a page script can read it); the theme is applied
    // on the root element inside the shadow root.
    await expect(page.locator(OVERLAY_HOST)).not.toHaveAttribute('data-theme', /.*/);
    await expect(page.locator(`${OVERLAY_HOST} .sv-root`)).toHaveAttribute('data-theme', 'dark');
    await tripleClickBlock(page, '#p-intro');
    const bar = toolbarOf(page);
    await expect(bar).toBeVisible();
    const toolbarSurface = page.locator(`${OVERLAY_HOST} .sv-toolbar`);
    await expect.poll(() => luminanceOf(toolbarSurface)).toBeLessThan(0.35);

    // Persisted: a fresh options tab and a brand-new popup come up dark; switching back goes light.
    const fresh = await openExt(env, 'options', 'appearance');
    await expect(fresh.getByRole('radio', { name: /^Dark/ })).toBeChecked();
    await expect.poll(() => pageLuminance(fresh)).toBeLessThan(0.3);
    await pickCard(fresh.getByRole('radio', { name: /^Light/ }));
    await expect.poll(() => pageLuminance(fresh)).toBeGreaterThan(0.8);
    await expect.poll(() => pageLuminance(popup)).toBeGreaterThan(0.8);
  });

  // The choice is now named "System" ("Match device").
  test('"Match my system" follows prefers-color-scheme', async ({ env }) => {
    const options = await openExt(env, 'options', 'appearance');
    await options.emulateMedia({ colorScheme: 'dark' });
    await expect(options.getByRole('radio', { name: /^System/ })).toBeChecked();
    await expect.poll(() => pageLuminance(options)).toBeLessThan(0.3);
    await options.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => pageLuminance(options)).toBeGreaterThan(0.8);
  });
});

test.describe('options: deny list', () => {
  const field = (options: Page) => options.getByRole('textbox', { name: 'Add a site' });
  const add = (options: Page) => options.getByRole('button', { name: 'Add site', exact: true });
  /** The deny list card in Settings > Site access: your own sites, then the starter sites. */
  const denyCard = (options: Page) =>
    options.getByRole('region', { name: 'Deny list', exact: true });

  test('invalid input gets a specific message, nothing is added, and the message clears as you type', async ({
    env,
  }) => {
    const options = await openExt(env, 'options', 'site-access');
    // The starter sites are listed behind their own disclosure: open it to count every entry.
    await openDisclosure(denyCard(options), 'Starter sites');
    const rows = denyCard(options).getByRole('listitem');
    // The list renders after settings load: wait for it, then compare with the shipped starter list
    // (imported, never a literal count).
    await expect(rows).not.toHaveCount(0);
    const count = DEFAULT_DENY_HOSTS.length;
    await expect(rows).toHaveCount(count);
    // The worker may write settings on its own (the install-time site sync); a rejected entry may not.
    const before = await storedSettings(options);

    const CASES: Array<[string, RegExp]> = [
      ['', /Enter a site such as example\.com\./],
      ['   ', /Enter a site such as example\.com\./],
      ['ftp://example.com', /Enter a web address that starts with http:\/\/ or https:\/\//],
      ['exa mple.com', /Enter only the site name/],
      ['example.com/private/page', /Enter only the site name/],
      ['localhost:8080', /Enter only the site name/],
      ['-bad-.com', /"-bad-\.com" is not a valid site name\./],
      ['Accounts.Google.com', /accounts\.google\.com is already on the deny list\./],
    ];
    for (const [input, message] of CASES) {
      await field(options).fill(input);
      await add(options).click();
      await expect(options.getByRole('alert').filter({ hasText: message })).toBeVisible();
      await expect(field(options)).toHaveAttribute('aria-invalid', 'true');
      await expect(rows).toHaveCount(count);
    }
    // Typing again clears the complaint.
    await field(options).fill('example.com');
    await expect(options.getByRole('alert')).toHaveCount(0);
    await expect(field(options)).not.toHaveAttribute('aria-invalid', 'true');
    expect(await storedSettings(options)).toEqual(before); // nothing was written by any rejection
  });

  test('valid entries are normalised, listed, persisted and removable; defaults can be restored', async ({
    env,
  }) => {
    const options = await openExt(env, 'options', 'site-access');
    const list = denyCard(options);

    await field(options).fill('HTTPS://Example.COM/some/path?x=1');
    await add(options).click();
    await expect(list.getByText('example.com', { exact: true })).toBeVisible();
    await expect(field(options)).toHaveValue('');
    await field(options).fill('*.Example.org');
    await add(options).click();
    await expect(list.getByText('example.org', { exact: true })).toBeVisible();

    await expect
      .poll(async () => (await storedSettings(options))?.denyList)
      .toEqual(expect.arrayContaining(['example.com', 'example.org', 'accounts.google.com']));

    // Persisted across a reload.
    await options.reload();
    await expect(list.getByText('example.com', { exact: true })).toBeVisible();

    await options.getByRole('button', { name: 'Remove example.com from the deny list' }).click();
    await expect(list.getByText('example.com', { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => (await storedSettings(options))?.denyList)
      .not.toContain('example.com');

    // Defaults: the restore button is disabled (with its reason) until a default entry is missing.
    const restore = options.getByRole('button', { name: 'Restore default sites' });
    await expect(restore).toHaveAttribute('aria-disabled', 'true');
    await expect(restore).toHaveAccessibleDescription('All default sites are already on the list.');
    await openDisclosure(list, 'Starter sites'); // where a default entry is listed
    await options.getByRole('button', { name: 'Remove paypal.com from the deny list' }).click();
    await expect(options.getByText('Missing: paypal.com.')).toBeVisible();
    await expect(restore).not.toHaveAttribute('aria-disabled', 'true');
    await restore.click();
    await expect(list.getByText('paypal.com', { exact: true })).toBeVisible();
    await expect(restore).toHaveAttribute('aria-disabled', 'true');
    await expect
      .poll(async () => (await storedSettings(options))?.denyList)
      .toContain('paypal.com');
  });

  test('an entry switches StudyVault off on that site live, and removing it switches it back on', async ({
    env,
  }) => {
    const page = await openFixture(env, '/article.html', { origin: env.altOrigin });
    const options = await openExt(env, 'options', 'site-access');

    await page.bringToFront();
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible(); // positive control: it works before the entry

    await options.bringToFront();
    await field(options).fill('localhost');
    await add(options).click();
    await expect(denyCard(options).getByText('localhost', { exact: true })).toBeVisible();

    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
    await expect(toolbarOf(page)).toHaveCount(0);
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByRole('heading', { name: 'localhost' })).toBeVisible();
    await expect(popup.getByText('On your deny list', { exact: true })).toBeVisible();

    await options.bringToFront();
    await options.getByRole('button', { name: 'Remove localhost from the deny list' }).click();
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await page.bringToFront();
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
  });

  test('is usable at 320 px with a very long entry (no horizontal scroll, nothing clipped)', async ({
    env,
  }) => {
    const options = await openExt(env, 'options', 'site-access');
    const long =
      'a-very-long-subdomain-name-for-layout-testing.example-institution-of-higher-learning.org';
    await field(options).fill(long);
    await add(options).click();
    // The entry is also spoken through the page's status region (and named in its Remove button's
    // tooltip): look at the chip in the list.
    await expect(denyCard(options).getByText(long, { exact: true })).toBeVisible();
    await options.setViewportSize({ width: 320, height: 700 });
    await expect.poll(() => options.evaluate(() => window.innerWidth)).toBe(320);
    const report = await layoutReport(options);
    expect(report.scrollWidth).toBeLessThanOrEqual(report.innerWidth);
    expect(report.offenders, report.offenders.join(', ')).toEqual([]);
  });
});

test.describe('options: floating toolbar toggle', () => {
  test('off hides the toolbar but the shortcut/menu capture path still saves; on restores it', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options', 'capture');
    const page = await openFixture(env, '/article.html');

    // Positive control with the toggle on.
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();

    const checkbox = ext.getByRole('checkbox', { name: 'Floating toolbar', exact: true });
    await ext.bringToFront();
    await expect(checkbox).toBeChecked();
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    await expect.poll(async () => (await storedSettings(ext))?.toolbarEnabled).toBe(false);
    await ext.reload();
    await expect(checkbox).not.toBeChecked(); // persisted

    // The toolbar goes away and a new selection does not bring it back.
    await page.bringToFront();
    await expect(toolbarOf(page)).toHaveCount(0);
    await tripleClickBlock(page, '#p-multiline');
    await page.waitForTimeout(400); // 6x the documented 60 ms selection debounce
    await expect(toolbarOf(page)).toHaveCount(0);
    expect(await page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(20);

    // The side panel says so, and the keyboard-shortcut / context-menu RPC still captures.
    const side = await viewing(env, 'sidepanel', page);
    await expect(
      side.getByText('Toolbar off. The shortcut and right-click still save.'),
    ).toBeVisible();
    const tabId = await tabIdOf(ext, page);
    const reply = await ext.evaluate(async (id) => {
      return chrome.tabs.sendMessage(id, {
        v: 1,
        type: 'content.captureSelection',
        payload: { method: 'shortcut', bankId: null },
      }) as Promise<{ ok: boolean; data?: { status?: string } }>;
    }, tabId);
    expect(reply.ok).toBe(true);
    expect(reply.data?.status).toBe('created');
    await expect(page.getByText(/Saved to Inbox/)).toBeVisible();
    const [row] = await highlightsOf(ext, page.url());
    expect(row?.exactQuote).toContain('atrioventricular node');

    // Back on: the toolbar returns for the next selection.
    await ext.bringToFront();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await page.bringToFront();
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
  });
});

// =============================================================================================
// OPTIONS: highlights on pages, capture, shortcuts, delete all data
// =============================================================================================

test.describe('options: highlights on pages', () => {
  // The switch is now labelled "Show on pages" (Settings > Appearance > Highlights).
  test('"Show highlights on pages" off stops painting (saving continues), disables the style choice, and on restores it', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options', 'appearance');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });

    const toggle = ext.getByRole('checkbox', { name: 'Show on pages', exact: true });
    await ext.bringToFront();
    await expect(toggle).toBeChecked();
    // The trade-off: one line on the switch, the full sentence behind its (i).
    await expect(toggle).toHaveAccessibleDescription('Sites can see which passages are painted.');
    await expect(
      ext.getByRole('button', { name: 'About show on pages' }),
    ).toHaveAccessibleDescription(/scripts that a site itself runs can read/);
    await toggle.click();
    await expect.poll(async () => (await storedSettings(ext))?.paintHighlights).toBe(false);
    await expect(ext.getByRole('radio', { name: /^Strong/ })).toBeDisabled();
    await expect(ext.getByText('No effect while highlights are not shown on pages.')).toBeVisible();

    await expect
      .poll(() => publishedRangeCount(page), { message: 'the page registry is left alone' })
      .toBe(0);
    // Quiet mode still saves; the side panel (not the page) is where the highlight is seen.
    await saveBlock(ext, page, '#quote');
    expect(await highlightsOf(ext, page.url())).toHaveLength(2);
    expect(await publishedRangeCount(page)).toBe(0);

    await ext.bringToFront();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => publishedRangeCount(page)).toBe(2);
  });

  test("highlight style: Automatic by default; Strong thickens every underline; the legend names each kind's underline", async ({
    env,
  }) => {
    const ext = await openExt(env, 'options', 'appearance');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await expect
      .poll(async () => (await highlightRuleFor(page, 'sv-hl-amber-essential'))?.thickness)
      .toBe(`${KIND_DECORATION.essential.thickness}px`);

    await ext.bringToFront();
    await expect(ext.getByRole('radio', { name: /^Automatic/ })).toBeChecked();
    // The legend sits with the colours, behind their disclosure.
    await openDisclosure(ext, 'Colours and underlines');
    const legend = ext.getByRole('list', { name: 'Underline for each highlight kind' });
    await expect(legend.getByRole('listitem')).toHaveCount(HIGHLIGHT_KINDS.length);
    for (const kind of HIGHLIGHT_KINDS) {
      const row = legend.getByRole('listitem').filter({ hasText: KIND_LABELS[kind].label });
      await expect(row).toContainText(KIND_DECORATION[kind].label);
    }

    // A controlled radio: its state changes when the saved setting comes back, so click, then wait.
    await pickCard(ext.getByRole('radio', { name: /^Strong/ }));
    await expect.poll(async () => (await storedSettings(ext))?.highlightStyle).toBe('strong');
    await expect
      .poll(async () => (await highlightRuleFor(page, 'sv-hl-amber-essential'))?.thickness)
      .toBe(`${KIND_DECORATION.essential.thickness + 1}px`);

    await pickCard(ext.getByRole('radio', { name: /^Normal/ }));
    await expect
      .poll(async () => (await highlightRuleFor(page, 'sv-hl-amber-essential'))?.thickness)
      .toBe(`${KIND_DECORATION.essential.thickness}px`);
  });
});

test.describe('options: capture and private windows', () => {
  test('"Save from private windows" is off by default, explains the trade-off, and persists', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options', 'capture');
    const box = ext.getByRole('checkbox', { name: 'Private windows', exact: true });
    await expect(box).not.toBeChecked();
    // The trade-off: one line on the switch, the full sentence behind its (i).
    await expect(box).toHaveAccessibleDescription('Saves stay in your normal profile.');
    const about = ext.getByRole('button', { name: 'About private windows' });
    await expect(about).toHaveAccessibleDescription(/private \(incognito\) windows/);
    await expect(about).toHaveAccessibleDescription(/stay after the window closes/);

    await box.click();
    await expect.poll(async () => (await storedSettings(ext))?.allowIncognitoCapture).toBe(true);
    await ext.reload();
    await expect(box).toBeChecked();
    await box.click();
    await expect.poll(async () => (await storedSettings(ext))?.allowIncognitoCapture).toBe(false);
  });
});

test.describe('options: keyboard shortcuts', () => {
  test("lists every command exactly as Chrome reports it, the fixed in-page keys, and opens Chrome's shortcut page", async ({
    env,
  }) => {
    const ext = await openExt(env, 'options', 'shortcuts');
    const commands = await ext.evaluate(() => chrome.commands.getAll());
    expect(commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(['quick-save', 'open-side-panel', 'focus-toolbar', 'next-highlight']),
    );

    const section = ext.locator('#shortcuts');
    await expect(ext.getByRole('heading', { name: 'Shortcuts', level: 1 })).toBeVisible();
    await expect(section.getByRole('heading', { name: 'In any tab', level: 2 })).toBeVisible();
    await expect(section.getByRole('heading', { name: 'Inside a page', level: 2 })).toBeVisible();
    const list = section.getByRole('list', { name: 'Browser shortcuts' });
    await expect(list.getByRole('listitem')).toHaveCount(commands.length);
    for (const c of commands) {
      const name = c.name ?? '';
      const row = list.getByRole('listitem').filter({
        has: ext.getByText(describeCommand(name, c.description), { exact: true }),
      });
      await expect(row, `${name} is listed`).toHaveCount(1);
      // An unset command says so instead of being hidden.
      if (!c.shortcut) await expect(row).toContainText(/Not set/i);
    }

    const inPage = section.getByRole('list', { name: 'In-page shortcuts' });
    await expect(inPage.getByRole('listitem')).toHaveCount(IN_PAGE_KEYS.length);
    for (const k of IN_PAGE_KEYS) await expect(inPage).toContainText(k.action);

    const opened = env.context.waitForEvent('page');
    await section.getByRole('button', { name: 'Change in Chrome' }).click();
    const shortcuts = await opened;
    await expect.poll(() => shortcuts.url()).toMatch(/^(chrome|edge):\/\/extensions\/shortcuts/);
  });
});

test.describe('options: delete all data', () => {
  // Asking first is now a guarded flow: "What goes" (focus on its title), then the typed word.
  test('asks first (focus starts on Cancel), then removes highlights, banks and settings, and the page repaints without them', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options', 'data');
    const page = await openFixture(env, '/article.html');
    await bgData(ext, 'bank.create', { name: 'Cardiology' });
    await saveBlock(ext, page, '#p-intro');
    await patchSettings(ext, { theme: 'dark' });
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });

    await ext.bringToFront();
    const open = ext.getByRole('button', { name: 'Delete all data', exact: true });
    await open.click();
    const dialog = ext.getByRole('dialog', { name: 'Delete all StudyVault data', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'What goes' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(dialog).toContainText('This cannot be undone.');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await highlightsOf(ext, page.url()), 'Close deletes nothing').toHaveLength(1);

    await open.click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    // Without the typed word nothing is deleted.
    await dialog.getByRole('button', { name: 'Delete everything' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Type delete to go on.');
    expect(await highlightsOf(ext, page.url()), 'no word, no delete').toHaveLength(1);
    await dialog.getByLabel('Type “delete”').fill('delete');
    await dialog.getByRole('button', { name: 'Delete everything' }).click();
    await expect(
      dialog.getByText(/All StudyVault data was deleted from this device/),
    ).toBeVisible();

    await expect.poll(async () => (await highlightsOf(ext, page.url())).length).toBe(0);
    const { banks } = await bgData<{ banks: Array<{ name: string }> }>(ext, 'banks.list');
    expect(banks.map((b) => b.name)).toEqual(['Inbox']);
    expect((await storedSettings(ext))?.theme ?? 'system', 'settings are back to defaults').toBe(
      'system',
    );
    await expect
      .poll(() => paintedByColor(page), { message: 'the open page drops the paint' })
      .toEqual({});
  });
});

// =============================================================================================
// CONTENT SECURITY POLICY (docs/adr/008, docs/adr/009)
// =============================================================================================

test.describe('extension pages: content security policy', () => {
  /**
   * Every violation the page reports, as the directive that refused it. The `securitypolicyviolation`
   * event is used (not the console) because eval, workers and inline styles do not all reach it, and
   * it is installed before the page's own scripts run.
   */
  async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
    type Seen = { __svCsp: string[] };
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as Seen).__svCsp = seen;
      window.addEventListener(
        'securitypolicyviolation',
        (e) => seen.push(`${e.effectiveDirective} blocked ${e.blockedURI || 'inline'}`),
        true,
      );
    });
    return () => page.evaluate(() => (window as unknown as Seen).__svCsp.slice());
  }

  test('every extension page loads and settles with no violation', async ({ env }) => {
    const names = [
      'popup',
      'sidepanel',
      'options',
      'dashboard',
      'review',
      'onboarding',
      'pdf-reader',
    ];
    for (const name of names) {
      const page = await env.context.newPage();
      const violations = await watchViolations(page);
      await page.goto(`chrome-extension://${env.extensionId}/${name}.html`);
      // `#root > *` would match the empty toast host, so wait for real content.
      await expect(
        page.locator('#root :is(h1, h2, button):visible').first(),
        `${name}.html`,
      ).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await violations(), `${name}.html`).toEqual([]);
      await page.close();
    }
  });

  // The manifest string is asserted in permissions.spec.ts; this proves Chrome ENFORCES it (a CSP that
  // fails validation is silently replaced by the default one, which has no style/img/connect rules).
  test('the policy is enforced: inline or remote content, plain http, eval and blob scripts are refused; CSSOM styles, data images and wasm still work', async ({
    env,
  }) => {
    const page = await env.context.newPage();
    const violations = await watchViolations(page);
    await page.goto(`chrome-extension://${env.extensionId}/options.html`);
    await expect(page.locator('#root :is(h1, h2, button):visible').first()).toBeVisible();

    const allowed = await page.evaluate(async () => {
      const el = document.createElement('div');
      document.body.append(el);
      el.style.color = 'rgb(1, 2, 3)'; // CSSOM: how React and pdf.js style elements
      const dataImage = await new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
      });
      const wasm = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(
        () => true,
        () => false,
      );
      return { color: getComputedStyle(el).color, dataImage, wasm };
    });
    expect(allowed).toEqual({ color: 'rgb(1, 2, 3)', dataImage: true, wasm: true });
    expect(await violations(), 'the allowed operations raise nothing').toEqual([]);

    await page.evaluate(async () => {
      const style = document.createElement('style');
      style.textContent = 'body { outline: 1px solid red; }';
      document.head.append(style); // style-src-elem
      document.body.setAttribute('style', 'outline: 1px solid red'); // style-src-attr
      new Image().src = 'https://example.invalid/pixel.png'; // img-src
      new Audio('https://example.invalid/clip.mp3'); // media-src
      const frame = document.createElement('iframe');
      frame.src = 'https://example.invalid/'; // frame-src
      document.body.append(frame);
      await fetch('http://example.invalid/').catch(() => undefined); // connect-src: http only on loopback
      // Outside this evaluate call: DevTools-initiated evaluation is itself exempt from the eval ban.
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          try {
            // eslint-disable-next-line no-restricted-syntax -- refusing this is what is under test
            new Function('return 1')(); // script-src: no unsafe-eval
          } catch {
            /* EvalError is the point */
          }
          resolve();
        }, 0),
      );
      // script-src-elem: no code from blob: (a blob Worker is NOT blocked by worker-src 'self' in
      // Chromium; see docs/adr/009 amendment, so it is deliberately not asserted here).
      await import(/* @vite-ignore */ URL.createObjectURL(new Blob(['export {}']))).catch(
        () => undefined,
      );
    });
    await expect
      .poll(async () => [...new Set((await violations()).map((v) => v.split(' ')[0]))].sort())
      .toEqual(
        [
          'connect-src',
          'frame-src',
          'img-src',
          'media-src',
          'script-src',
          'script-src-elem',
          'style-src-attr',
          'style-src-elem',
        ].sort(),
      );
  });
});
