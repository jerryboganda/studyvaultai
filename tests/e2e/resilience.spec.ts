import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  activate,
  dragSelect,
  enableDeveloperMode,
  evalInContentScript,
  expectPaintedExactly,
  hardKill,
  launchSession,
  liveHighlights,
  markWorker,
  newUserDataDir,
  norm,
  openExtensionPage,
  overlayHostCount,
  paintedDetail,
  patchSettings,
  readDb,
  recordRequests,
  registeredScripts,
  removeDir,
  rpc,
  saveSelection,
  savedToast,
  selectAndSave,
  stopWorker,
  tabIdOf,
  tabRpc,
  toastAction,
  toolbarOf,
  tripleClick,
  workerState,
  type Session,
} from './helpers.lifecycle';

/**
 * Resilience E2E (real Chromium, real built extension):
 *  - data survives a full browser restart and an extension reload
 *  - the service worker is really stopped (CDP) between and during operations
 *  - everything local works offline and nothing leaves loopback / the extension
 *  - persistent registration (registered content script) and the deny list
 */

const QUOTE = 'Cardiac output equals heart rate multiplied by stroke volume.';
const MULTILINE =
  'Depolarisation spreads from the sinoatrial node across the atria, pauses at the atrioventricular node, and then travels rapidly through the bundle of His and the Purkinje fibres. This delay at the atrioventricular node allows the ventricles to fill completely before they contract, which maximises stroke volume.';
const INTRO =
  'The sinoatrial node is the primary pacemaker of the heart. It initiates each heartbeat by spontaneously depolarising at a rate of roughly seventy beats per minute at rest.';
const REFS = 'Guyton and Hall, Textbook of Medical Physiology, chapter 9.';
const FILLER = 'An intervening paragraph keeps the two repeated sentences apart.';
const ROUTE_ONE =
  'Route one explains how the baroreceptor reflex buffers short-term changes in arterial pressure.';
const ROUTE_TWO =
  'Route two explains how the renin angiotensin system defends blood pressure over hours to days.';

const originPattern = (origin: string) => `${origin}/*`;

async function readSettings(ext: Page): Promise<Record<string, unknown>> {
  return ext.evaluate(
    async () =>
      ((await chrome.storage.local.get('settings')).settings ?? {}) as Record<string, unknown>,
  );
}

/** Proves the worker was really restarted: new timeOrigin and the planted probe is gone. */
async function expectRestarted(
  context: Session['context'],
  extensionId: string,
  before: { timeOrigin: number },
  what: string,
): Promise<void> {
  await expect
    .poll(() => workerState(context, extensionId), {
      timeout: 15_000,
      message: `${what}: a fresh service worker is running`,
    })
    .toMatchObject({ probe: null });
  const after = await workerState(context, extensionId);
  expect(after!.timeOrigin, `${what}: new worker instance`).toBeGreaterThan(before.timeOrigin);
  console.log(
    `WORKER-RESTART ${what}: timeOrigin ${Math.round(before.timeOrigin)} -> ${Math.round(after!.timeOrigin)} (+${Math.round(after!.timeOrigin - before.timeOrigin)} ms), planted probe gone`,
  );
}

// -----------------------------------------------------------------------------------------------
// Restart / reload persistence
// -----------------------------------------------------------------------------------------------

test.describe('persistence across restart and extension reload', () => {
  test('a full browser restart on the same profile keeps data, settings and registration', async ({
    fixtureServer,
  }) => {
    test.setTimeout(240_000);
    const dir = newUserDataDir();
    const url = `${fixtureServer.origin}/article.html`;
    let first: Session | null = null;
    let second: Session | null = null;
    try {
      first = await launchSession(dir);
      const ext1 = await openExtensionPage(first.context, first.extensionId);
      const page = await first.context.newPage();
      await page.goto(url);
      await activate(ext1, page);
      await page.bringToFront();
      expect(await selectAndSave(page, { triple: '#quote' }, QUOTE)).toBe('Saved to Inbox');
      // The page has no text field (ADR-005): the bank is named in the side panel, then picked in
      // the page's "More options" together with kind and priority.
      const panel1 = await openExtensionPage(first.context, first.extensionId, 'sidepanel.html');
      await panel1.getByRole('tab', { name: 'Banks' }).click();
      await panel1.getByLabel('New bank').fill('Cardiology');
      await panel1.getByRole('button', { name: 'Create bank' }).click();
      await expect(panel1.getByText('Bank "Cardiology" created.')).toBeVisible();

      await page.bringToFront();
      await tripleClick(page, '#p-multiline');
      await expect(toolbarOf(page)).toBeVisible();
      await page.getByRole('button', { name: 'More options', exact: true }).click();
      const composer = page.getByRole('dialog', { name: 'Save with details' });
      await expect(composer).toBeVisible();
      await expect(composer.getByRole('textbox')).toHaveCount(0);
      await composer.getByLabel('Bank', { exact: true }).selectOption({ label: 'Cardiology' });
      await composer.getByLabel('Type').selectOption({ label: 'ƒ Formula' });
      await composer.getByLabel('Priority').selectOption('5');
      await composer.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(savedToast(page)).toHaveText('Saved to Cardiology');
      await expectPaintedExactly(page, [QUOTE, MULTILINE]);

      // Notes are typed in the side panel too. "Recent" lists every highlight whatever the active
      // tab is, so both notes are written there (real keyboard input into the card's note field).
      await panel1.getByRole('tab', { name: /Recent/ }).click();
      const noteOf = (text: string) =>
        panel1.locator('article.hl-card', { hasText: text }).getByLabel('Your note');
      await noteOf('Depolarisation spreads').fill('composer note');
      await noteOf('Cardiac output equals').fill('remember: CO = HR x SV');
      await expect
        .poll(
          async () =>
            liveHighlights(await readDb(ext1))
              .map((h) => h.userComment)
              .sort(),
          { message: 'both notes were autosaved by the panel' },
        )
        .toEqual(['composer note', 'remember: CO = HR x SV']);
      await patchSettings(ext1, { theme: 'dark', density: 'compact' });
      // ...and persistent access for this origin (a registered content script).
      await patchSettings(ext1, { persistentOrigins: [originPattern(fixtureServer.origin)] });
      const sync = await rpc(ext1, 'site.sync');
      expect(sync).toMatchObject({ ok: true });

      const db = await readDb(ext1);
      expect(liveHighlights(db)).toHaveLength(2);
      const savedIds = liveHighlights(db)
        .map((h) => h.id)
        .sort();
      expect(liveHighlights(db).find((h) => h.exactQuote === QUOTE)?.userComment).toBe(
        'remember: CO = HR x SV',
      );
      const cardiology = db.banks.find((b) => b.name === 'Cardiology');
      expect(cardiology, 'bank created through the composer').toBeDefined();
      const multiline = liveHighlights(db).find((h) => norm(h.exactQuote) === MULTILINE);
      expect(multiline).toMatchObject({ kind: 'formula', userComment: 'composer note' });
      expect(db.highlightBanks).toContainEqual({
        highlightId: multiline!.id,
        bankId: cardiology!.id,
        folderId: null,
        addedAt: expect.any(String),
      });
      expect((await readSettings(ext1)).lastBankId, 'last-used bank is remembered').toBe(
        cardiology!.id,
      );
      await first.context.close();
      first = null;

      // ---- the same profile, a new browser process -------------------------------------------
      second = await launchSession(dir);
      const ext2 = await openExtensionPage(second.context, second.extensionId);
      const reopened = await readDb(ext2);
      expect(
        liveHighlights(reopened)
          .map((h) => h.id)
          .sort(),
      ).toEqual(savedIds);
      expect(liveHighlights(reopened).find((h) => h.exactQuote === QUOTE)?.userComment).toBe(
        'remember: CO = HR x SV',
      );
      expect(reopened.banks.map((b) => b.name).sort()).toEqual(['Cardiology', 'Inbox']);
      expect(reopened.highlightBanks).toHaveLength(2);
      expect(liveHighlights(reopened).find((h) => norm(h.exactQuote) === MULTILINE)).toMatchObject({
        kind: 'formula',
        userComment: 'composer note',
      });
      expect(await readSettings(ext2)).toMatchObject({
        theme: 'dark',
        density: 'compact',
        lastBankId: cardiology!.id,
      });
      expect((await registeredScripts(ext2)).map((s) => s.id)).toContain('sv-persistent');

      // The registered script injects with no activation and rehydrates from the old data.
      const back = await second.context.newPage();
      await back.goto(url);
      await expect(back.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
      await expectPaintedExactly(back, [QUOTE, MULTILINE]);

      // The side panel lists both, with the note.
      const panel = await openExtensionPage(second.context, second.extensionId, 'sidepanel.html');
      await panel.getByRole('tab', { name: /Recent/ }).click();
      await expect(panel.locator('article.hl-card')).toHaveCount(2);
    } finally {
      await first?.context.close().catch(() => undefined);
      await second?.context.close().catch(() => undefined);
      removeDir(dir);
    }
  });

  test('chrome.runtime.reload() keeps data; the old page recovers on re-activation', async ({
    context,
    extensionId,
    serviceWorker,
    fixtureServer,
  }) => {
    test.setTimeout(180_000);
    const url = `${fixtureServer.origin}/article.html`;
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(url);
    await activate(ext, page);
    await page.bringToFront();
    await selectAndSave(page, { triple: '#quote' }, QUOTE);
    await patchSettings(ext, { theme: 'dark' });
    const marker = await markWorker(context, extensionId, 'before-reload');
    const idsBefore = liveHighlights(await readDb(ext)).map((h) => h.id);
    expect(idsBefore).toHaveLength(1);

    // Real extension reload (the extension is torn down and loaded again from disk).
    await enableDeveloperMode(context);
    await serviceWorker.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await expectRestarted(context, extensionId, marker, 'after chrome.runtime.reload()');

    const ext2 = await openExtensionPage(context, extensionId);
    const db = await readDb(ext2);
    expect(liveHighlights(db).map((h) => h.id)).toEqual(idsBefore);
    expect(await readSettings(ext2)).toMatchObject({ theme: 'dark' });

    // The orphaned content script of the previous extension instance must not throw when the
    // user keeps working in the page.
    await tripleClick(page, '#p-intro');
    await page.keyboard.press('Escape');
    await page.locator('#p-refs').click();

    // Re-activation brings the new instance in: one overlay, one paint, a working toolbar.
    await activate(ext2, page);
    await expectPaintedExactly(page, [QUOTE]);
    await expect.poll(() => overlayHostCount(page), { timeout: 10_000 }).toBe(1);
    expect(await selectAndSave(page, { triple: '#p-multiline' }, 'maximises stroke')).toBe(
      'Saved to Inbox',
    );
    await expectPaintedExactly(page, [QUOTE, MULTILINE]);
    expect(liveHighlights(await readDb(ext2))).toHaveLength(2);
    expect(pageErrors, 'no uncaught errors from the stale script').toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// Service worker suspension
// -----------------------------------------------------------------------------------------------

test.describe('service worker suspension (CDP ServiceWorker.stopWorker)', () => {
  test('capture, undo, delete+restore and a retry-free toolbar survive a stopped worker', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(240_000);
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/article.html`);
    await activate(ext, page);
    await page.bringToFront();
    const evidence: string[] = [];
    // Every save makes the page re-fetch its highlights ~250 ms later (data-change refresh,
    // 250 ms debounce + one RPC). That fetch would restart a stopped worker by itself, so it is
    // allowed to land before each deliberate stop.
    const quiet = () => page.waitForTimeout(700);

    expect(await selectAndSave(page, { triple: '#quote' }, QUOTE)).toBe('Saved to Inbox');

    // ---- (1) a capture while the worker is stopped -------------------------------------------
    await quiet();
    let marker = await markWorker(context, extensionId, 'gen-1');
    let stopMs = await stopWorker(context, extensionId, page);
    expect(await selectAndSave(page, { triple: '#p-multiline' }, 'maximises stroke')).toBe(
      'Saved to Inbox',
    );
    await expectRestarted(context, extensionId, marker, 'capture on a stopped worker');
    evidence.push(`capture-after-stop: stopped in ${stopMs} ms, restarted on demand`);
    await expectPaintedExactly(page, [QUOTE, MULTILINE]);
    expect(liveHighlights(await readDb(ext))).toHaveLength(2);

    // ---- (2) the worker stops BETWEEN selecting and clicking Save ----------------------------
    await quiet();
    marker = await markWorker(context, extensionId, 'gen-2');
    await tripleClick(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
    stopMs = await stopWorker(context, extensionId, page);
    expect(await saveSelection(page)).toBe('Saved to Inbox');
    await expectRestarted(context, extensionId, marker, 'worker stopped between select and save');
    evidence.push(`stop-between-select-and-save: stopped in ${stopMs} ms, save succeeded`);
    await expectPaintedExactly(page, [QUOTE, MULTILINE, INTRO]);
    expect(liveHighlights(await readDb(ext))).toHaveLength(3);

    // Again, with a different toolbar action (a kind button), to rule out a one-off.
    await quiet();
    marker = await markWorker(context, extensionId, 'gen-3');
    await tripleClick(page, '#p-refs');
    await expect(toolbarOf(page)).toBeVisible();
    await stopWorker(context, extensionId, page);
    expect(await saveSelection(page, 'Save as Formula')).toBe('Saved to Inbox');
    await expectRestarted(context, extensionId, marker, 'second suspension before save');
    await expectPaintedExactly(page, [QUOTE, MULTILINE, INTRO, REFS]);
    const kinds = liveHighlights(await readDb(ext)).map((h) => `${h.kind}`);
    expect(kinds.filter((k) => k === 'formula')).toHaveLength(1);

    // ---- (3) Undo after the worker was stopped ------------------------------------------------
    await quiet();
    marker = await markWorker(context, extensionId, 'gen-4');
    await stopWorker(context, extensionId, page);
    await toastAction(page, 'Saved to Inbox').first().click();
    await expect(page.getByText('Save undone')).toBeVisible();
    await expectRestarted(context, extensionId, marker, 'undo on a stopped worker');
    await expectPaintedExactly(page, [QUOTE, MULTILINE, INTRO]);
    await expect.poll(async () => liveHighlights(await readDb(ext)).length).toBe(3);

    // ---- (4) delete, stop the worker, Undo (restore authorised by the durable ledger) ---------
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.locator('#quote').click({ position: { x: 24, y: 8 } });
    await expect(page.getByRole('dialog', { name: 'Highlight details' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Highlight deleted')).toBeVisible();
    await expectPaintedExactly(page, [MULTILINE, INTRO]);
    await quiet();
    marker = await markWorker(context, extensionId, 'gen-5');
    await stopWorker(context, extensionId, page);
    await toastAction(page, 'Highlight deleted').click();
    await expect(page.getByText('Highlight restored')).toBeVisible();
    await expectRestarted(context, extensionId, marker, 'restore on a stopped worker');
    await expectPaintedExactly(page, [QUOTE, MULTILINE, INTRO]);
    expect(liveHighlights(await readDb(ext))).toHaveLength(3);

    // ---- (5) nothing is stuck: the toolbar still works and no error was ever shown ------------
    expect(await selectAndSave(page, { triple: '#list li:first-child' }, 'Preload is')).toBe(
      'Saved to Inbox',
    );
    await expect(page.locator('.sv-toast-error')).toHaveCount(0);
    console.log(`SW-SUSPENSION ${JSON.stringify(evidence)}`);
  });

  test('SPA route changes and a cold page load rehydrate through a stopped worker', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(240_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${origin}/spa/one`);
    await expect(page.locator('#view h1')).toHaveText('Route One');
    await activate(ext, page);
    await page.bringToFront();
    await selectAndSave(page, { triple: '#view p:nth-of-type(1)' }, 'baroreceptor');
    await page.locator('#nav-two').click();
    await expect(page.locator('#view h1')).toHaveText('Route Two');
    await selectAndSave(page, { triple: '#view p:nth-of-type(1)' }, 'renin');
    await expectPaintedExactly(page, [ROUTE_TWO]);

    // Route change while the worker is stopped: page.highlights wakes it.
    await page.waitForTimeout(700); // let the data-change refresh of the last save land
    let marker = await markWorker(context, extensionId, 'spa-1');
    await stopWorker(context, extensionId, page);
    await page.goBack();
    await expect(page.locator('#view h1')).toHaveText('Route One');
    await expectPaintedExactly(page, [ROUTE_ONE]);
    await expectRestarted(context, extensionId, marker, 'route change on a stopped worker');

    await page.waitForTimeout(700);
    marker = await markWorker(context, extensionId, 'spa-2');
    await stopWorker(context, extensionId, page);
    await page.locator('#nav-two').click();
    await expect(page.locator('#view h1')).toHaveText('Route Two');
    await expectPaintedExactly(page, [ROUTE_TWO]);
    await expectRestarted(context, extensionId, marker, 'second route change');

    // Cold page load: registered script + stopped worker (what a browser restart looks like).
    await patchSettings(ext, { persistentOrigins: [originPattern(origin)] });
    // (The e2e build is also granted its loopback hosts at install, so the registration holds those
    // too: this test is about the cold load, not about the exact set.)
    expect(await rpc(ext, 'site.sync')).toMatchObject({
      ok: true,
      data: { registeredMatches: expect.arrayContaining([originPattern(origin)]) },
    });
    await page.waitForTimeout(700);
    marker = await markWorker(context, extensionId, 'spa-3');
    await stopWorker(context, extensionId, page);
    const cold = await context.newPage();
    await cold.goto(`${origin}/spa/two`);
    await expect(cold.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    await expectPaintedExactly(cold, [ROUTE_TWO]);
    await expectRestarted(context, extensionId, marker, 'cold page load');
    expect(liveHighlights(await readDb(ext))).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------------------------
// Offline
// -----------------------------------------------------------------------------------------------

test.describe('offline', () => {
  test('capture, undo, restore and rehydrate work offline; no request leaves loopback or the extension', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(240_000);
    const origin = fixtureServer.origin;
    const requests = recordRequests(context);
    const ext = await openExtensionPage(context, extensionId);
    try {
      // Online: seed one highlight on the article, one on the dark page, one on /spa/one.
      const article = await context.newPage();
      await article.goto(`${origin}/article.html`);
      await activate(ext, article);
      await article.bringToFront();
      await selectAndSave(article, { triple: '#quote' }, QUOTE);

      const darkSeed = await context.newPage();
      await darkSeed.goto(`${origin}/dark.html`);
      await activate(ext, darkSeed);
      await darkSeed.bringToFront();
      await selectAndSave(darkSeed, { triple: '#d' }, 'Furosemide');
      await darkSeed.close();

      const spa = await context.newPage();
      await spa.goto(`${origin}/spa/one`);
      await expect(spa.locator('#view h1')).toHaveText('Route One');
      await activate(ext, spa);
      await spa.bringToFront();
      await selectAndSave(spa, { triple: '#view p:nth-of-type(1)' }, 'baroreceptor');

      // A page loaded while online but NOT activated yet: rehydration will happen offline.
      const dark = await context.newPage();
      await dark.goto(`${origin}/dark.html`);
      await expect(dark.locator('#d')).toBeVisible();

      // ---- go offline ----------------------------------------------------------------------
      await context.setOffline(true);
      const offlineStart = requests.urls.length;
      const probe = await article.evaluate(() =>
        fetch('http://example.invalid/ping').then(
          () => 'reachable',
          () => 'offline',
        ),
      );
      expect(probe, 'the browser is really offline').toBe('offline');

      // Capture offline.
      await article.bringToFront();
      expect(await selectAndSave(article, { triple: '#p-multiline' }, 'maximises stroke')).toBe(
        'Saved to Inbox',
      );
      await expectPaintedExactly(article, [QUOTE, MULTILINE]);
      // Undo offline.
      await toastAction(article, 'Saved to Inbox').click();
      await expect(article.getByText('Save undone')).toBeVisible();
      await expectPaintedExactly(article, [QUOTE]);
      // Save again offline: the soft-deleted row is restored.
      expect(await selectAndSave(article, { triple: '#p-multiline' }, 'maximises stroke')).toBe(
        'Restored in Inbox',
      );
      await expectPaintedExactly(article, [QUOTE, MULTILINE]);

      // Rehydrate offline: a page that never had the content script gets it now.
      await dark.bringToFront();
      await activate(ext, dark);
      await expectPaintedExactly(dark, [
        'Furosemide inhibits the sodium potassium chloride cotransporter in the thick ascending limb.',
      ]);

      // Rehydrate offline on route changes.
      await spa.bringToFront();
      await spa.locator('#nav-two').click();
      await expect(spa.locator('#view h1')).toHaveText('Route Two');
      await expectPaintedExactly(spa, []);
      await spa.goBack();
      await expect(spa.locator('#view h1')).toHaveText('Route One');
      await expectPaintedExactly(spa, [ROUTE_ONE]);

      // Data and the side panel work offline.
      const panel = await openExtensionPage(context, extensionId, 'sidepanel.html');
      await panel.getByRole('tab', { name: /Recent/ }).click();
      await expect(panel.locator('article.hl-card')).toHaveCount(4);
      expect(liveHighlights(await readDb(ext))).toHaveLength(4);

      // ---- network evidence --------------------------------------------------------------
      const allowed = [origin, fixtureServer.altOrigin, `chrome-extension://${extensionId}`];
      const external = requests.urls.filter(
        (u) =>
          !/^(data|blob|about):/.test(u) && !allowed.some((a) => u === a || u.startsWith(`${a}/`)),
      );
      const byOrigin: Record<string, number> = {};
      for (const u of requests.urls) {
        let key: string;
        try {
          key = new URL(u).origin;
          if (key === 'null') key = u.split(':')[0]!;
        } catch {
          key = 'unparsable';
        }
        byOrigin[key] = (byOrigin[key] ?? 0) + 1;
      }
      console.log(
        `NETWORK ${JSON.stringify({ total: requests.urls.length, afterOffline: requests.urls.length - offlineStart, byOrigin })}`,
      );
      // The deliberate offline probe above is the only request to a non-local origin.
      expect(external.filter((u) => !u.startsWith('http://example.invalid/'))).toEqual([]);
    } finally {
      await context.setOffline(false);
      requests.stop();
    }
  });
});

// -----------------------------------------------------------------------------------------------
// Persistent registration and the deny list
// -----------------------------------------------------------------------------------------------

test.describe('persistent registration (registered content script) and deny list', () => {
  test('a registered origin injects new tabs without activation; the registration follows the stored sites', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(180_000);
    const origin = fixtureServer.origin;
    const alt = fixtureServer.altOrigin;
    const ext = await openExtensionPage(context, extensionId);

    // Nothing registered at first (the harness drops the install-time registration, fixtures.ts).
    expect(await registeredScripts(ext)).toEqual([]);

    // What is registered is what Chrome grants plus the stored sites Chrome still covers. The e2e
    // build holds loopback grants from install, so "contains" and "no longer contains" are the
    // invariants; the literal per-port patterns below are the user's own entries.
    const matchesOf = (reply: unknown) =>
      (reply as { data: { registeredMatches: string[] } }).data.registeredMatches;

    await patchSettings(ext, { persistentOrigins: [originPattern(origin), originPattern(alt)] });
    const sync = await rpc(ext, 'site.sync');
    expect(sync).toMatchObject({ ok: true });
    expect(matchesOf(sync)).toEqual(
      expect.arrayContaining([originPattern(origin), originPattern(alt)]),
    );
    const scripts = await registeredScripts(ext);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({ id: 'sv-persistent' });
    expect(scripts[0]?.matches).toEqual(expect.arrayContaining(matchesOf(sync)));
    expect(scripts[0]?.excludeMatches ?? []).toContain('*://*.accounts.google.com/*');

    // A NEW tab, no tab.activate: the registered script runs, the toolbar works, data persists.
    const first = await context.newPage();
    await first.goto(`${origin}/article.html`);
    await expect(first.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    await first.bringToFront();
    expect(await selectAndSave(first, { triple: '#quote' }, QUOTE)).toBe('Saved to Inbox');
    await expectPaintedExactly(first, [QUOTE]);

    const second = await context.newPage();
    await second.goto(`${origin}/article.html`);
    await expect(second.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    await expectPaintedExactly(second, [QUOTE]);
    await second.reload();
    await expectPaintedExactly(second, [QUOTE]);
    await first.close();
    await second.close();

    // Remove only the 127.0.0.1 entry; keep localhost: the registration follows.
    await patchSettings(ext, { persistentOrigins: [originPattern(alt)] });
    const resync = await rpc(ext, 'site.sync');
    expect(resync).toMatchObject({ ok: true });
    expect(matchesOf(resync)).toContain(originPattern(alt));
    expect(matchesOf(resync)).not.toContain(originPattern(origin));
    expect([...((await registeredScripts(ext))[0]?.matches ?? [])].sort()).toEqual(
      [...matchesOf(resync)].sort(),
    );

    // Clearing every stored site leaves no per-site pattern behind; the script exists exactly when
    // something (a Chrome grant) is still registered.
    await patchSettings(ext, { persistentOrigins: [] });
    const cleared = await rpc(ext, 'site.sync');
    expect(cleared).toMatchObject({ ok: true });
    expect(matchesOf(cleared)).not.toContain(originPattern(alt));
    expect(matchesOf(cleared)).not.toContain(originPattern(origin));
    expect((await registeredScripts(ext)).length).toBe(matchesOf(cleared).length > 0 ? 1 : 0);
  });

  test('removing a stored site stops injection on it, and clearing all unregisters the script', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(180_000);
    const origin = fixtureServer.origin;
    const alt = fixtureServer.altOrigin;
    const ext = await openExtensionPage(context, extensionId);

    const matchesOf = (reply: unknown) =>
      (reply as { data: { registeredMatches: string[] } }).data.registeredMatches;

    // Both stored sites are covered: a new tab on either is injected without activation.
    await patchSettings(ext, { persistentOrigins: [originPattern(origin), originPattern(alt)] });
    const both = await rpc(ext, 'site.sync');
    expect(both).toMatchObject({ ok: true });
    expect(matchesOf(both)).toEqual(
      expect.arrayContaining([originPattern(origin), originPattern(alt)]),
    );
    const injected = await context.newPage();
    await injected.goto(`${origin}/article.html`);
    await expect(injected.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    await injected.close();

    // Remove 127.0.0.1 and keep localhost. The e2e build's install-time loopback host permissions
    // are NOT the user's always-on sites, so the registration must follow the stored list exactly.
    await patchSettings(ext, { persistentOrigins: [originPattern(alt)] });
    const onlyAlt = await rpc(ext, 'site.sync');
    expect(onlyAlt).toMatchObject({ ok: true });
    expect(matchesOf(onlyAlt)).toEqual([originPattern(alt)]);
    expect((await registeredScripts(ext))[0]?.matches).toEqual([originPattern(alt)]);

    const removed = await context.newPage();
    await removed.goto(`${origin}/article.html`);
    await expect(removed.locator('article')).toBeVisible();
    await removed.waitForTimeout(1_500); // a late injection would show up well inside this window
    await expect(removed.locator('studyvault-overlay')).toHaveCount(0);
    await removed.close();

    const kept = await context.newPage();
    await kept.goto(`${alt}/article.html`);
    await expect(kept.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    await kept.close();

    // Clearing everything leaves no script behind.
    await patchSettings(ext, { persistentOrigins: [] });
    const cleared = await rpc(ext, 'site.sync');
    expect(cleared).toMatchObject({ ok: true });
    expect(matchesOf(cleared)).toEqual([]);
    expect(await registeredScripts(ext)).toEqual([]);
  });

  test('a denied host gets no toolbar, no painting and a refused capture.save', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(180_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${origin}/article.html`);
    await activate(ext, page);
    await page.bringToFront();
    await selectAndSave(page, { triple: '#quote' }, QUOTE);
    await expectPaintedExactly(page, [QUOTE]);
    const tabId = await tabIdOf(ext, page);

    // A valid capture.save as the page's own content script (real sender.tab/sender.url).
    const payload = (exact: string, start: number) =>
      JSON.stringify({
        v: 1,
        type: 'capture.save',
        payload: {
          page: {
            url: `${origin}/article.html`,
            canonicalUrl: null,
            title: 'Cardiac Physiology Primer',
          },
          exactQuote: exact,
          anchorSet: {
            type: 'html',
            textAlgorithm: 'sv-text-v1',
            textQuote: { exact, prefix: '', suffix: '' },
            textPosition: { start, end: start + exact.length },
            structuralPath: null,
            contentSignature: 'e2e',
            documentTextLength: 2000,
          },
          headingContext: null,
          kind: 'essential',
          color: 'amber',
          bankId: null,
          userComment: '',
          priority: 3,
          captureMethod: 'toolbar',
        },
      });
    const send = (exact: string, start: number) =>
      evalInContentScript<{ ok: boolean; error?: { code: string; message: string } }>(
        context,
        page,
        extensionId,
        `chrome.runtime.sendMessage(${payload(exact, start)})`,
      );

    // Positive control: the same call is accepted while the host is allowed.
    const accepted = await send(FILLER, 900);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    const countBefore = (await readDb(ext)).highlights.length;
    expect(countBefore).toBe(2);

    // Show the toolbar, then deny the host: it must go away.
    await tripleClick(page, '#p-multiline');
    await expect(toolbarOf(page)).toBeVisible();
    await patchSettings(ext, { denyList: ['127.0.0.1'] });
    expect(await rpc(ext, 'site.sync')).toMatchObject({ ok: true });
    await expect(toolbarOf(page)).toHaveCount(0);
    await expect.poll(() => overlayHostCount(page), { message: 'overlay removed' }).toBe(0);
    await expect.poll(() => paintedDetail(page), { message: 'highlights unpainted' }).toEqual([]);

    // A new selection offers nothing (300 ms = five times the product's 60 ms debounce).
    await dragSelect(page, { selector: '#p-intro', phrase: 'It initiates each heartbeat' });
    await page.waitForTimeout(300);
    await expect(toolbarOf(page)).toHaveCount(0);

    // Shortcut / context-menu path: refused by the content script.
    expect(
      await tabRpc(ext, tabId, 'content.captureSelection', { method: 'shortcut', bankId: null }),
    ).toMatchObject({ ok: true, data: { status: 'blocked' } });
    expect(await tabRpc(ext, tabId, 'content.pageStatus')).toMatchObject({
      ok: true,
      data: { blocked: 'denied-site' },
    });

    // The service worker refuses a capture.save that arrives from a denied host anyway.
    const refused = await send('A quote that must never be stored from a denied host.', 1800);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('forbidden');
    expect((await readDb(ext)).highlights).toHaveLength(countBefore);

    // Activation of a tab on a denied host is refused with the reason.
    const act = await rpc(ext, 'tab.activate', { tabId });
    expect(act).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    // Removing the host from the deny list brings everything back.
    await patchSettings(ext, { denyList: [] });
    await expect.poll(() => overlayHostCount(page), { timeout: 10_000 }).toBe(1);
    await expectPaintedExactly(page, [QUOTE, FILLER]);
  });

  test('a registered script on a denied host is excluded at registration (not merely unmounted)', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    await patchSettings(ext, {
      persistentOrigins: [originPattern(origin), originPattern(fixtureServer.altOrigin)],
      denyList: ['127.0.0.1'],
    });
    expect(await rpc(ext, 'site.sync')).toMatchObject({ ok: true });
    const [script] = await registeredScripts(ext);
    expect(script?.excludeMatches).toContain('*://*.127.0.0.1/*');

    const denied = await context.newPage();
    await denied.goto(`${origin}/article.html`);
    const control = await context.newPage();
    await control.goto(`${fixtureServer.altOrigin}/article.html`);
    await expect(control.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    // The control (same registration, other host) was injected; the denied host was not touched.
    const tabId = await tabIdOf(ext, denied);
    expect(await tabRpc(ext, tabId, 'content.ping')).toMatchObject({
      ok: false,
      error: { code: 'no_receiver' },
    });
    expect(await overlayHostCount(denied)).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// Crash safety, races, double injection, history navigation
// -----------------------------------------------------------------------------------------------

test.describe('crash safety and races', () => {
  test('a hard-killed browser loses nothing that was already confirmed to the user', async ({
    fixtureServer,
  }) => {
    test.setTimeout(240_000);
    const dir = newUserDataDir();
    const url = `${fixtureServer.origin}/article.html`;
    let session: Session | null = null;
    try {
      session = await launchSession(dir);
      const ext = await openExtensionPage(session.context, session.extensionId);
      const page = await session.context.newPage();
      await page.goto(url);
      await activate(ext, page);
      await page.bringToFront();
      // Every save below was confirmed with a "Saved" toast before the process is killed.
      await selectAndSave(page, { triple: '#quote' }, QUOTE);
      await selectAndSave(page, { triple: '#p-multiline' }, 'maximises stroke');
      await selectAndSave(page, { triple: '#p-intro' }, 'primary pacemaker');
      // A note typed in the side panel (the page has no text field) and confirmed with "Saved".
      const panel = await openExtensionPage(session.context, session.extensionId, 'sidepanel.html');
      await panel.getByRole('tab', { name: /Recent/ }).click();
      const card = panel.locator('article.hl-card', { hasText: 'Cardiac output equals' });
      await card.getByLabel('Your note').fill('written just before the crash');
      await expect(card.getByText('Saved', { exact: true })).toBeVisible();

      // Kill the browser process itself (not a graceful close): no flush, no shutdown hooks.
      await hardKill(session);
      session = null;

      session = await launchSession(dir);
      const ext2 = await openExtensionPage(session.context, session.extensionId);
      const db = await readDb(ext2);
      expect(liveHighlights(db), 'confirmed highlights survive a kill').toHaveLength(3);
      expect(liveHighlights(db).find((h) => h.exactQuote === QUOTE)?.userComment).toBe(
        'written just before the crash',
      );
      const again = await session.context.newPage();
      await again.goto(url);
      await activate(ext2, again);
      await expectPaintedExactly(again, [QUOTE, MULTILINE, INTRO]);
    } finally {
      await session?.context.close().catch(() => undefined);
      removeDir(dir);
    }
  });

  test('stopping the worker at the instant of the Save click never loses or duplicates a save', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(240_000);
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/article.html`);
    await activate(ext, page);
    await page.bringToFront();

    const targets = [
      { sel: '#p-intro', text: INTRO },
      { sel: '#p-multiline', text: MULTILINE },
      { sel: '#quote', text: QUOTE },
      { sel: '#p-refs', text: REFS },
      { sel: '#list li:first-child', text: 'Preload is the ventricular stretch at end diastole.' },
      { sel: '#p-filler', text: FILLER },
    ];
    const outcomes: string[] = [];
    const expectedPaint: string[] = [];
    for (const [i, t] of targets.entries()) {
      await tripleClick(page, t.sel);
      await expect(toolbarOf(page)).toBeVisible();
      // Fire the click and the worker stop together.
      const stop = stopWorker(context, extensionId, page).catch((e: unknown) => String(e));
      await page.getByRole('button', { name: 'Save selection', exact: true }).click();
      await stop;
      // Ground truth is the database: either the row is there, or the user was told and offered
      // Retry. Nothing is silent.
      const failed = page.locator('.sv-toast-error');
      await expect
        .poll(
          async () => {
            if ((await failed.count()) > 0) return 'error';
            return liveHighlights(await readDb(ext)).length === i + 1 ? 'saved' : 'pending';
          },
          { timeout: 15_000, message: `save ${i} resolved to saved-or-reported` },
        )
        .not.toBe('pending');
      if ((await failed.count()) > 0) {
        outcomes.push('error+retry');
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect
          .poll(async () => liveHighlights(await readDb(ext)).length, { timeout: 15_000 })
          .toBe(i + 1);
      } else {
        outcomes.push('saved');
      }
      expectedPaint.push(t.text);
      await expectPaintedExactly(page, expectedPaint);
      // A successful save closes the toolbar; wait for that so the next selection is not made
      // while this save is still finishing.
      if (outcomes[outcomes.length - 1] === 'saved') {
        await expect(toolbarOf(page)).toHaveCount(0);
      }
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
    }
    console.log(`STOP-AT-SAVE outcomes ${JSON.stringify(outcomes)}`);
    const db = await readDb(ext);
    expect(
      liveHighlights(db),
      'one row per passage: nothing lost, nothing duplicated',
    ).toHaveLength(targets.length);
    expect(new Set(liveHighlights(db).map((h) => h.exactQuote)).size).toBe(targets.length);
    expect(db.highlightBanks).toHaveLength(targets.length);
  });

  test('a save that is still in flight when the tab navigates away or closes is stored anyway', async ({
    context,
    extensionId,
    serviceWorker,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const cases = [
      { how: 'navigates away', sel: '#quote', text: QUOTE },
      { how: 'closes', sel: '#p-multiline', text: MULTILINE },
    ] as const;
    for (const [i, c] of cases.entries()) {
      const page = await context.newPage();
      await page.goto(`${origin}/article.html?utm_campaign=case${i}`);
      await activate(ext, page);
      await page.bringToFront();
      await tripleClick(page, c.sel);
      await expect(toolbarOf(page)).toBeVisible();
      // The worker is held for 1.5 s, so the save is certainly still pending when the page goes.
      const held = serviceWorker
        .evaluate(() => {
          const end = Date.now() + 1_500;
          while (Date.now() < end) {
            /* busy */
          }
        })
        .catch(() => undefined);
      await page.getByRole('button', { name: 'Save selection', exact: true }).click();
      if (c.how === 'closes') await page.close();
      else await page.goto(`${origin}/dark.html`);
      await held;
      await expect
        .poll(async () => liveHighlights(await readDb(ext)).map((h) => norm(h.exactQuote)), {
          timeout: 10_000,
          message: `save is stored when the tab ${c.how}`,
        })
        .toContain(c.text);
    }
    expect(liveHighlights(await readDb(ext))).toHaveLength(2);
  });

  test('injecting the content script again (registered + executeScript + activate) never doubles the UI', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    await patchSettings(ext, { persistentOrigins: [originPattern(origin)] });
    await rpc(ext, 'site.sync');
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/article.html`);
    await expect(page.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    const tabId = await tabIdOf(ext, page);

    // Two explicit injections of the same bundle, then the product's own activation.
    for (let i = 0; i < 2; i++) {
      await ext.evaluate(
        (id) =>
          chrome.scripting.executeScript({
            target: { tabId: id },
            files: ['/content-scripts/highlighter.js'],
          }),
        tabId,
      );
    }
    expect(await rpc(ext, 'tab.activate', { tabId })).toMatchObject({ ok: true });
    await page.bringToFront();

    await expect.poll(() => overlayHostCount(page)).toBe(1);
    // One toolbar, one save, one row, one paint.
    await tripleClick(page, '#quote');
    await expect(toolbarOf(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(toolbarOf(page)).toHaveCount(0);
    await expect(savedToast(page)).toHaveCount(1);
    await expectPaintedExactly(page, [QUOTE]);
    expect(liveHighlights(await readDb(ext))).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  });

  test('history back/forward across documents restores the painted page (registered script)', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    await patchSettings(ext, { persistentOrigins: [originPattern(origin)] });
    await rpc(ext, 'site.sync');
    const page = await context.newPage();
    await page.goto(`${origin}/lifecycle-links.html`);
    await expect(page.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    await page.bringToFront();
    const para =
      'Review the dark article for contrast, or jump to the end of this page for the summary of the topic.';
    await selectAndSave(page, { triple: '#para' }, 'summary of the topic');
    await expectPaintedExactly(page, [para]);

    await page.locator('#go').click();
    await expect(page).toHaveURL(`${origin}/dark.html`);
    await expect(page.locator('studyvault-overlay')).toHaveCount(1, { timeout: 15_000 });
    expect(await paintedDetail(page)).toEqual([]);

    await page.goBack();
    await expect(page).toHaveURL(`${origin}/lifecycle-links.html`);
    await expectPaintedExactly(page, [para]);
    await expect.poll(() => overlayHostCount(page)).toBe(1);
    await page.goForward();
    await expect(page).toHaveURL(`${origin}/dark.html`);
    await page.goBack();
    await expectPaintedExactly(page, [para]);
    // And it is still fully usable after the round trip.
    expect(await selectAndSave(page, { triple: '#second' }, 'glomerular filtration')).toBe(
      'Saved to Inbox',
    );
  });
});
