import type { Page } from '@playwright/test';
import {
  activate,
  activeTexts,
  bgData,
  closedPort,
  errorsOf,
  expect,
  highlightsOf,
  layoutReport,
  luminanceOf,
  openExt,
  openFixture,
  openRealPopup,
  pageLuminance,
  paintedByColor,
  patchSettings,
  saveBlock,
  saveBlockToBank,
  storedSettings,
  tabIdOf,
  targetIds,
  test,
  toolbarOf,
  viewing,
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
    await expect(popup.getByText('StudyVault cannot run on this page')).toBeVisible();
    await expect(popup.getByText(/"chrome-extension:" address type/)).toBeVisible();
    await expect(
      popup.getByRole('button', { name: /Activate on this tab|Open side panel|Always enable/ }),
    ).toHaveCount(0);
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
      await expect(popup.getByText('StudyVault cannot run on this page')).toBeVisible();
      await expect(popup.getByText('Open a regular website to capture highlights.')).toBeVisible();
      await expect(
        popup.getByRole('button', { name: /Activate on this tab|Open side panel|Always enable/ }),
      ).toHaveCount(0);
      // The only control left is the way out to settings.
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

    await expect(popup.getByText('StudyVault is off on localhost')).toBeVisible();
    await expect(popup.getByText(/This site is on your deny list \(localhost\)/)).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Activate on this tab' })).toHaveCount(0);

    await popup.getByRole('button', { name: 'Allow StudyVault on localhost' }).click();
    await expect(popup.getByText('StudyVault is not running on this tab')).toBeVisible();
    await expect
      .poll(async () => (await storedSettings(ext))?.denyList)
      .toEqual(['accounts.google.com']);

    // And activation now really works on that origin.
    await popup.getByRole('button', { name: 'Activate on this tab' }).click();
    await expect(popup.getByText('0 highlights')).toBeVisible();
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await page.locator('#p-intro').click({ clickCount: 3 });
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
    await expect(popup.getByText('127.0.0.1', { exact: true })).toBeVisible();
    await expect(popup.getByText('2 highlights')).toBeVisible();
    await expect(popup.getByText('Last used bank:')).toBeVisible();
    await expect(popup.locator('strong', { hasText: 'Cardiology' })).toBeVisible();

    const recent = popup.getByRole('region', { name: 'Recent saves' }).getByRole('listitem');
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
    await page.locator('#p-intro').click({ clickCount: 3 });
    await page.waitForTimeout(400); // 6x the controller's documented 60 ms selection debounce
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
    await expect(toolbarOf(page)).toHaveCount(0);

    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText('StudyVault is not running on this tab')).toBeVisible();
    await popup.getByRole('button', { name: 'Activate on this tab' }).click();
    await expect(popup.getByText('0 highlights')).toBeVisible();
    await expect(popup.getByText('Active on this tab only.')).toBeVisible();

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

    await expect(popup.getByText('StudyVault is not running on this tab')).toBeVisible();
    await popup.getByRole('button', { name: 'Activate on this tab' }).click();

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
    await tabIdOf(ext, page); // bring the fixture page to the front

    const popup = await openRealPopup(env);
    await popup.waitForText(/StudyVault is not running on this tab/);
    expect(await popup.text()).toContain('127.0.0.1');
    await popup.clickButton('Activate on this tab');
    await popup.waitForText(/0 highlights on this page/);
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);

    await saveBlock(ext, page, '#p-intro');
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
    const text = await panel.waitForText(/Cardiac Physiology Primer/);
    expect(text).toContain('1 highlight saved');
    expect(text).toContain('sinoatrial node is the primary pacemaker');
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
    await expect(side.getByText('2 highlights')).toBeVisible();
    await expect(side.getByRole('tab', { name: /This page \(2\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const cards = side.getByRole('article');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAccessibleName(/^Essential fact: The sinoatrial node/);
    await expect(cards.nth(1)).toHaveAccessibleName(/^Formula: Depolarisation spreads/);
    await expect(cards.nth(0).getByText('Inbox')).toBeVisible();
    await expect(cards.nth(0).getByText('Resolved', { exact: true })).toBeVisible();
    expect(errorsOf(side)).toEqual([]);
  });

  test('an empty page says so', async ({ env }) => {
    const page = await openFixture(env, '/pages-b.html');
    const side = await viewing(env, 'sidepanel', page);
    await expect(
      side.getByRole('heading', { level: 2, name: 'Renal Physiology Notes' }),
    ).toBeVisible();
    await expect(side.getByText('No highlights on this page yet')).toBeVisible();
    await expect(side.getByRole('tab', { name: /This page \(0\)/ })).toBeVisible();
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
    await side.getByLabel('Kind').selectOption('formula');
    await expect
      .poll(() => paintedByColor(page))
      .toEqual({ blue: [expect.stringContaining('sinoatrial node')] });
    await expect(side.getByRole('article')).toHaveAccessibleName(/^Formula:/);

    await side.getByLabel('Priority').selectOption('5');
    await expect.poll(async () => (await highlightsOf(ext, page.url()))[0]?.priority).toBe(5);
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
    await expect(side.getByText('Showing this highlight on the page.')).toBeVisible();
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
    await side.getByRole('button', { name: 'Delete' }).click();
    await expect(side.getByText('Highlight deleted.')).toBeVisible();
    await expect(side.getByText('No highlights on this page yet')).toBeVisible();
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
        side.getByRole('heading', { level: 3, name: 'Needs attention (1)' }),
      ).toBeVisible();
      await expect(side.getByText('1 highlight saved · 1 needs attention')).toBeVisible();
      const card = side.getByRole('article');
      await expect(card.getByText('Orphaned · not found on page')).toBeVisible();
      await expect(card.getByText(/could not be found on the page/)).toBeVisible();
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
      side.getByRole('heading', { level: 3, name: 'Needs attention (1)' }),
    ).toBeVisible();
    await expect(side.getByText('Ambiguous · not painted')).toBeVisible();
    await expect(side.getByText(/matches more than one place on the page/)).toBeVisible();
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
    await expect(side.getByText('No highlights on this page yet')).toBeVisible();
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
    await side.getByRole('tab', { name: 'Recent' }).click();
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
    await expect(side.getByRole('button', { name: 'Delete' }).first()).toBeVisible();
  });

  test('the popup stays within its 360 px column with long unbroken text', async ({ env }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/pages-b.html');
    await saveBlock(ext, page, '#p-long');
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText('1 highlight')).toBeVisible();
    await popup.setViewportSize({ width: 360, height: 640 });
    const report = await layoutReport(popup);
    expect(report.scrollWidth).toBeLessThanOrEqual(report.innerWidth);
    expect(report.offenders, report.offenders.join('\n')).toEqual([]);
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
    const options = await openExt(env, 'options');
    const popup = await viewing(env, 'popup', page);
    const side = await viewing(env, 'sidepanel', page);

    // Baseline: light everywhere.
    await expect(options.getByRole('radio', { name: /^Match my system/ })).toBeChecked();
    const lightOptions = await pageLuminance(options);
    expect(lightOptions).toBeGreaterThan(0.8);

    await options.getByRole('radio', { name: /^Dark/ }).click();
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => pageLuminance(options)).toBeLessThan(0.3);

    // Already-open pages follow without a reload.
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => pageLuminance(popup)).toBeLessThan(0.3);
    await expect(side.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => pageLuminance(side)).toBeLessThan(0.3);

    // The in-page overlay: attribute on the shadow host and the toolbar's computed background.
    await page.bringToFront();
    await expect(page.locator(OVERLAY_HOST)).toHaveAttribute('data-theme', 'dark');
    await page.locator('#p-intro').click({ clickCount: 3 });
    const bar = toolbarOf(page);
    await expect(bar).toBeVisible();
    const toolbarSurface = page.locator(`${OVERLAY_HOST} .sv-toolbar`);
    await expect.poll(() => luminanceOf(toolbarSurface)).toBeLessThan(0.35);

    // Persisted: a fresh options tab and a brand-new popup come up dark; switching back goes light.
    const fresh = await openExt(env, 'options');
    await expect(fresh.getByRole('radio', { name: /^Dark/ })).toBeChecked();
    await expect.poll(() => pageLuminance(fresh)).toBeLessThan(0.3);
    await fresh.getByRole('radio', { name: /^Light/ }).click();
    await expect.poll(() => pageLuminance(fresh)).toBeGreaterThan(0.8);
    await expect.poll(() => pageLuminance(popup)).toBeGreaterThan(0.8);
  });

  test('"Match my system" follows prefers-color-scheme', async ({ env }) => {
    const options = await openExt(env, 'options');
    await options.emulateMedia({ colorScheme: 'dark' });
    await expect(options.getByRole('radio', { name: /^Match my system/ })).toBeChecked();
    await expect.poll(() => pageLuminance(options)).toBeLessThan(0.3);
    await options.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => pageLuminance(options)).toBeGreaterThan(0.8);
  });
});

test.describe('options: deny list', () => {
  const field = (options: Page) => options.getByRole('textbox', { name: 'Add a site' });
  const add = (options: Page) => options.getByRole('button', { name: 'Add to deny list' });

  test('invalid input gets a specific message, nothing is added, and the message clears as you type', async ({
    env,
  }) => {
    const options = await openExt(env, 'options');
    const rows = options.getByRole('group', { name: 'Deny list' }).getByRole('listitem');
    const count = await rows.count();
    expect(count).toBe(11); // the shipped defaults

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
    expect(await storedSettings(options)).toBeUndefined(); // nothing was written by any rejection
  });

  test('valid entries are normalised, listed, persisted and removable; defaults can be restored', async ({
    env,
  }) => {
    const options = await openExt(env, 'options');
    const list = options.getByRole('group', { name: 'Deny list' });

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
    const options = await openExt(env, 'options');

    await page.bringToFront();
    await page.locator('#p-intro').click({ clickCount: 3 });
    await expect(toolbarOf(page)).toBeVisible(); // positive control: it works before the entry

    await options.bringToFront();
    await field(options).fill('localhost');
    await add(options).click();
    await expect(options.getByText('localhost', { exact: true })).toBeVisible();

    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
    await expect(toolbarOf(page)).toHaveCount(0);
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText('StudyVault is off on localhost')).toBeVisible();

    await options.bringToFront();
    await options.getByRole('button', { name: 'Remove localhost from the deny list' }).click();
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await page.bringToFront();
    await page.locator('#p-intro').click({ clickCount: 3 });
    await expect(toolbarOf(page)).toBeVisible();
  });

  test('is usable at 320 px with a very long entry (no horizontal scroll, nothing clipped)', async ({
    env,
  }) => {
    const options = await openExt(env, 'options');
    await field(options).fill(
      'a-very-long-subdomain-name-for-layout-testing.example-institution-of-higher-learning.org',
    );
    await add(options).click();
    await expect(options.getByText(/a-very-long-subdomain-name/)).toBeVisible();
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
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');

    // Positive control with the toggle on.
    await page.locator('#p-intro').click({ clickCount: 3 });
    await expect(toolbarOf(page)).toBeVisible();

    const checkbox = ext.getByRole('checkbox', { name: /Show the floating toolbar/ });
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
    await page.locator('#p-multiline').click({ clickCount: 3 });
    await page.waitForTimeout(400); // 6x the documented 60 ms selection debounce
    await expect(toolbarOf(page)).toHaveCount(0);
    expect(await page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(20);

    // The side panel says so, and the keyboard-shortcut / context-menu RPC still captures.
    const side = await viewing(env, 'sidepanel', page);
    await expect(
      side.getByText(
        /The floating toolbar is turned off in Settings\. The keyboard shortcut and the context menu\s+still save a selection\./,
      ),
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
    await page.locator('#p-intro').click({ clickCount: 3 });
    await expect(toolbarOf(page)).toBeVisible();
  });
});
