import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { DEFAULT_DENY_HOSTS } from '@shared';
import {
  OVERLAY_HOST,
  activate,
  bg,
  bgData,
  closedPort,
  dataEpoch,
  errorsOf,
  expect,
  highlightsOf,
  minimalPdf,
  openExt,
  openFixture,
  openRealPopup,
  paintedByColor,
  patchSettings,
  prodTest,
  saveBlock,
  sendFromContentWorld,
  storedSettings,
  tabIdOf,
  test,
  toolbarOf,
  tripleClickBlock,
  viewing,
  type Envelope,
} from './helpers.pages';

/**
 * Permissions, messaging security and restricted contexts in real Chromium.
 *
 * Harness limits that shape these tests (each was tried and observed, not assumed):
 *  - chrome.permissions.request opens a NATIVE prompt. Playwright cannot click it and in headless
 *    Chromium it never resolves; the e2e build therefore holds loopback host permissions up front.
 *  - chrome.action.openPopup() does NOT grant activeTab, and CDP key events do not reach browser
 *    accelerators (commands). So on the PRODUCTION build (no host permission) a tab can never be
 *    activated here; prod coverage is manifest, page rendering, error paths and static bundle checks.
 */

const err = (reply: Envelope | { thrown: string } | undefined) =>
  reply && 'ok' in reply && !reply.ok ? reply.error : undefined;

/** A valid capture.save payload with minimal anchors (the schema is checked by the worker). */
function captureInput(
  url: string,
  quote = 'Injected quote from a hostile page.',
  canonicalUrl: string | null = null,
) {
  return {
    page: { url, canonicalUrl, title: 'Injected' },
    exactQuote: quote,
    anchorSet: {
      type: 'html',
      textAlgorithm: 'sv-text-v1',
      textQuote: { exact: quote, prefix: '', suffix: '' },
      textPosition: { start: 0, end: quote.length },
      structuralPath: null,
      contentSignature: 'x',
      documentTextLength: quote.length,
    },
    headingContext: null,
    kind: 'essential',
    color: 'amber',
    bankId: null,
    userComment: '',
    priority: 3,
    captureMethod: 'toolbar',
  };
}

/** tab.activate with a bound on the wait, so a hang is a failed assertion and not a stuck suite. */
async function activateWithin(ext: Page, tabId: number, ms: number): Promise<Envelope | 'timeout'> {
  return ext.evaluate(
    async ({ tabId, ms }) => {
      const reply = chrome.runtime.sendMessage({
        v: 1,
        type: 'tab.activate',
        payload: { tabId },
      }) as Promise<Envelope>;
      return Promise.race([
        reply,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
      ]);
    },
    { tabId, ms },
  );
}

// =============================================================================================
// SITE ACCESS: persistent registration, deny list, all-sites flow
// =============================================================================================

test.describe('site access', () => {
  test('a stored per-site grant is registered, listed in settings, and auto-injects on a fresh visit', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    await patchSettings(ext, { persistentOrigins: ['http://127.0.0.1/*'] });
    // Chrome's grants are what is registered: the hint under test plus whatever the e2e build was
    // granted at install (its loopback host permissions). So "contains", not "equals".
    const synced = await bgData<{ registeredMatches: string[] }>(ext, 'site.sync');
    expect(synced.registeredMatches).toEqual(expect.arrayContaining(['http://127.0.0.1/*']));

    const scripts = await ext.evaluate(async () => {
      const found = await chrome.scripting.getRegisteredContentScripts();
      return found.map((s) => ({
        id: s.id,
        matches: s.matches,
        excludeMatches: s.excludeMatches,
        runAt: s.runAt,
        persistAcrossSessions: s.persistAcrossSessions,
        allFrames: s.allFrames,
        js: s.js,
      }));
    });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      id: 'sv-persistent',
      matches: expect.arrayContaining(['http://127.0.0.1/*']),
      runAt: 'document_idle',
      persistAcrossSessions: true,
      allFrames: false,
      js: ['content-scripts/highlighter.js'],
    });
    expect(scripts[0]?.excludeMatches).toContain('*://*.accounts.google.com/*');

    // The Settings page shows the site with Chrome's grant state.
    await ext.reload();
    const sites = ext
      .locator('#site-access')
      .getByRole('listitem')
      .filter({ hasText: '127.0.0.1' });
    await expect(sites).toHaveCount(1);
    await expect(sites.getByText('Allowed', { exact: true })).toBeVisible();

    // A brand-new tab is injected by the registration alone: no tab.activate, no toolbar click.
    const page = await env.context.newPage();
    await page.goto(`${env.origin}/article.html`);
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();

    const tabId = await tabIdOf(ext, page);
    const status = await bgData<{ access: string; active: boolean; supported: boolean }>(
      ext,
      'site.status',
      { tabId, url: page.url() },
    );
    expect(status).toMatchObject({ supported: true, access: 'persistent', active: true });

    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText('Always on', { exact: false }).first()).toBeVisible();
    await expect(
      popup.getByRole('button', { name: 'Disable always-on for this site' }),
    ).toBeVisible();
  });

  test('a deny-list entry is excluded from the persistent registration and from injection', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    await patchSettings(ext, { persistentOrigins: ['http://127.0.0.1/*'] });
    await bgData(ext, 'site.sync');

    // Through the real Settings UI: this is the path that must re-register the script.
    const field = ext.getByRole('textbox', { name: 'Add a site' });
    await field.fill('127.0.0.1');
    await ext.getByRole('button', { name: 'Add to deny list' }).click();
    await expect(ext.getByRole('alert')).toHaveCount(0);
    await expect
      .poll(async () => (await storedSettings(ext))?.denyList)
      .toEqual(expect.arrayContaining(['127.0.0.1']));
    await expect
      .poll(async () =>
        ext.evaluate(async () => {
          const [s] = await chrome.scripting.getRegisteredContentScripts({
            ids: ['sv-persistent'],
          });
          return s?.excludeMatches ?? null;
        }),
      )
      .toEqual(expect.arrayContaining(['*://*.127.0.0.1/*']));

    const page = await env.context.newPage();
    await page.goto(`${env.origin}/article.html`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(1500); // document_idle injection happens right after load
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);

    // And the worker refuses a manual activation too, with the reason.
    const tabId = await tabIdOf(ext, page);
    const reply = await bg(ext, 'tab.activate', { tabId });
    expect(err(reply)).toMatchObject({ code: 'forbidden' });
    expect(err(reply)?.message).toContain('turned off on 127.0.0.1');
  });

  test("revoking a granted site reports Chrome's answer instead of silently doing nothing", async ({
    env,
  }) => {
    // In the e2e build 127.0.0.1 is a REQUIRED host permission, which Chrome refuses to remove;
    // the point is that the refusal is shown and the list is left consistent.
    const ext = await openExt(env, 'options');
    await patchSettings(ext, { persistentOrigins: ['http://127.0.0.1/*'] });
    await ext.reload();
    const row = ext.locator('#site-access').getByRole('listitem').filter({ hasText: '127.0.0.1' });
    await row.getByRole('button', { name: 'Revoke access for 127.0.0.1' }).click();

    const alert = ext.locator('#site-access').getByRole('alert');
    await expect(alert).toContainText('That did not work');
    await expect(alert).toContainText(/required permissions|cannot remove|permission/i);
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
    // Not half-applied: the origin is still listed in settings.
    expect((await storedSettings(ext))?.persistentOrigins).toEqual(['http://127.0.0.1/*']);
  });

  test('"Enable on all sites" stays busy while Chrome\'s native prompt is pending and changes nothing', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const settingsBefore = await storedSettings(ext);
    const enable = ext.getByRole('button', { name: 'Enable on all sites' });
    await expect(ext.getByText('StudyVault runs only where you enabled it.')).toBeVisible();
    await expect(ext.getByRole('button', { name: 'Revoke all-sites access' })).toHaveCount(0);

    // Step one is StudyVault's own modal: it lists the sites that stay off, starts on Cancel and
    // asks Chrome for nothing yet.
    await enable.click();
    const dialog = ext.getByRole('dialog', { name: 'Turn StudyVault on for all sites?' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(`StudyVault will stay off on these ${DEFAULT_DENY_HOSTS.length} sites`),
    ).toBeVisible();
    const listed = dialog
      .getByRole('region', { name: 'Sites on your deny list' })
      .getByRole('listitem');
    await expect(listed).toHaveCount(DEFAULT_DENY_HOSTS.length);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await ext.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(enable, 'focus returns to the control that opened the dialog').toBeFocused();
    expect(await storedSettings(ext), 'Cancel changed nothing').toEqual(settingsBefore);

    // Step two: "Continue" is the user gesture that fires Chrome's native prompt.
    await enable.click();
    await dialog.getByRole('button', { name: "Continue to Chrome's prompt" }).click();
    await expect(enable).toHaveAttribute('aria-busy', 'true');
    await expect(enable).toHaveAttribute('aria-disabled', 'true');
    // The page stays alive and explains what is going on while the (native) prompt is open.
    await expect(ext.getByText(/shows Chrome's permission prompt/)).toBeVisible();
    await ext.waitForTimeout(1500);
    await expect(enable).toHaveAttribute('aria-busy', 'true'); // still waiting on the user
    // Nothing was granted or stored without the user's answer.
    expect(
      await ext.evaluate(() =>
        chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }),
      ),
    ).toBe(false);
    expect((await storedSettings(ext))?.persistentOrigins ?? []).not.toContain('https://*/*');
    expect(errorsOf(ext)).toEqual([]);
  });

  test('"Revoke all-sites access" converges when Settings lists it but Chrome holds no grant', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    await patchSettings(ext, { persistentOrigins: ['https://*/*', 'http://*/*'] });
    await ext.reload();
    const revoke = ext.getByRole('button', { name: 'Revoke all-sites access' });
    await expect(revoke).toBeVisible();
    await revoke.click();
    await expect(revoke).toHaveCount(0);
    await expect(ext.locator('#site-access').getByRole('alert')).toHaveCount(0);
    await expect.poll(async () => (await storedSettings(ext))?.persistentOrigins).toEqual([]);
    expect(
      await ext.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length),
    ).toBe(0);
  });
});

// =============================================================================================
// MESSAGING SECURITY
// =============================================================================================

test.describe('messaging security: what a web page can and cannot reach', () => {
  test('page scripts get no extension messaging surface (main world)', async ({ env }) => {
    const page = await openFixture(env, '/article.html'); // activated: the content script is running
    const surface = await page.evaluate(async (extensionId) => {
      const w = window as unknown as { chrome?: Record<string, unknown> };
      const c = w.chrome as
        { runtime?: { id?: string; sendMessage?: unknown; connect?: unknown } } | undefined;
      let external: string;
      try {
        const r = (c?.runtime as { sendMessage?: (...a: unknown[]) => unknown } | undefined)
          ?.sendMessage;
        external =
          typeof r === 'function'
            ? String(await r(extensionId, { v: 1, type: 'banks.list', payload: {} }))
            : 'sendMessage is not exposed';
      } catch (e) {
        external = `threw: ${(e as Error).message}`;
      }
      return {
        chromeKeys: c ? Object.keys(c).sort() : null,
        runtimeId: c?.runtime?.id ?? null,
        sendMessage: typeof c?.runtime?.sendMessage,
        connect: typeof c?.runtime?.connect,
        storage: typeof (c as Record<string, unknown> | undefined)?.storage,
        tabs: typeof (c as Record<string, unknown> | undefined)?.tabs,
        external,
      };
    }, env.extensionId);
    expect(surface.runtimeId).toBeNull();
    expect(surface.sendMessage).toBe('undefined');
    expect(surface.connect).toBe('undefined');
    expect(surface.storage).toBe('undefined');
    expect(surface.tabs).toBe('undefined');
    expect(surface.external).toBe('sendMessage is not exposed');
  });

  test('forged DOM events and messages cannot capture, change data or open UI', async ({ env }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });
    const before = {
      rows: await highlightsOf(ext, page.url()),
      epoch: await dataEpoch(ext),
    };
    await page.bringToFront();
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.evaluate(
      ({ x, y }) => {
        // The generic WXT start announcement, as a hostile script would guess it.
        window.postMessage(
          { type: 'wxt:content-script-started', contentScriptName: 'highlighter', messageId: 'x' },
          '*',
        );
        document.dispatchEvent(
          new CustomEvent('wxt:content-script-started', {
            detail: { contentScriptName: 'highlighter', messageId: 'x' },
          }),
        );
        // Synthetic selection / pointer / keyboard events (isTrusted === false).
        document.dispatchEvent(new Event('selectionchange'));
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        document.dispatchEvent(
          new KeyboardEvent('keyup', { key: 'H', altKey: true, shiftKey: true }),
        );
        document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        // A synthetic click exactly on the painted highlight.
        const target = document.elementFromPoint(x, y);
        target?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }),
        );
      },
      await page.evaluate(() => {
        // Registries are `sv-hl-<color>[-<kind>]`: take the first range of any amber one.
        const name = Array.from(CSS.highlights.keys()).find((n) => n.startsWith('sv-hl-amber'));
        const hl = name ? CSS.highlights.get(name) : undefined;
        const range = hl ? (Array.from(hl as unknown as Iterable<Range>)[0] as Range) : null;
        const r = range?.getClientRects()[0];
        return { x: Math.round((r?.left ?? 0) + 5), y: Math.round((r?.top ?? 0) + 5) };
      }),
    );
    await page.waitForTimeout(500); // longer than every documented debounce in the controller

    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await expect(toolbarOf(page)).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Highlight details' })).toHaveCount(0);
    expect(await paintedByColor(page)).toEqual({ amber: [expect.any(String)] });
    expect(await highlightsOf(ext, page.url())).toEqual(before.rows);
    expect(await dataEpoch(ext)).toBe(before.epoch); // no database mutation happened anywhere

    // Positive control: a REAL click on the same spot does open the highlight details.
    const spot = await page.evaluate(() => {
      const name = Array.from(CSS.highlights.keys()).find((n) => n.startsWith('sv-hl-amber'));
      const hl = CSS.highlights.get(name ?? '');
      const range = Array.from(hl as unknown as Iterable<Range>)[0] as Range;
      const r = range.getClientRects()[0] as DOMRect;
      return { x: r.left + 5, y: r.top + r.height / 2 };
    });
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByRole('dialog', { name: 'Highlight details' })).toBeVisible();
  });

  // ACCEPTED RISK (decision recorded here; not a product defect):
  // WXT's ContentScriptContext retires an older copy of a content script when a "newer copy
  // started" announcement arrives. That announcement is a CustomEvent on `document` named
  // `<extension id>:<entrypoint>:wxt:content-script-started` whose detail.contentScriptName matches.
  // Both parts are public for a published extension and a page can dispatch DOM events, so a page
  // CAN make StudyVault stand down on THAT page (observed on Windows and Linux with wxt 0.21.4).
  // This is not a privilege boundary: the page already controls its own DOM (it can remove
  // <studyvault-overlay>, rewrite or hide the text, or call preventDefault on everything), the event
  // carries no data and triggers no extension action, and the only victim is the user's own tool on
  // a page that wanted it off. What would be a defect, and what this test therefore asserts, is
  // that the forged event (a) causes no capture or change of any stored data, (b) gives the page no
  // way to reach the worker or the stored data, and (c) leaves nothing broken: after a reload the
  // extension works again with every highlight intact. Whether the overlay survives the event is
  // deliberately NOT asserted; it is recorded as an annotation so a WXT change shows up in reports.
  test('a forged "content script started" event cannot capture, reach the worker or read data, and a reload restores StudyVault', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });
    // Let the page's resolution report land so the data snapshot below is stable.
    await expect
      .poll(async () => (await highlightsOf(ext, page.url()))[0]?.resolveStatus)
      .toBe('resolved');

    const snapshot = async () => ({
      highlights: (await highlightsOf(ext, page.url())).map((h) => ({ ...h })),
      epoch: await dataEpoch(ext),
      banks: await bgData(ext, 'banks.list'),
      settings: await storedSettings(ext),
    });
    const before = await snapshot();

    // A live selection with the toolbar up makes the probe meaningful: if the forged event could
    // trigger a save, there is something to save.
    await tripleClickBlock(page, '#p-multiline');
    await expect(toolbarOf(page)).toBeVisible();

    await page.evaluate((id) => {
      document.dispatchEvent(
        new CustomEvent(`${id}:highlighter:wxt:content-script-started`, {
          detail: { contentScriptName: 'highlighter', messageId: 'forged-by-page' },
        }),
      );
    }, env.extensionId);
    await page.waitForTimeout(500); // longer than every documented debounce in the controller

    // (a) No capture, no edit, no new bank, no settings write: the worker's data is untouched.
    expect(await snapshot()).toEqual(before);

    // (b) The page still has no route to the worker, and none of the stored data lives in its origin.
    const reach = await page.evaluate(async () => {
      const c = (
        window as unknown as { chrome?: { runtime?: { id?: string; sendMessage?: unknown } } }
      ).chrome;
      return {
        runtimeId: c?.runtime?.id ?? null,
        sendMessage: typeof c?.runtime?.sendMessage,
        databases: (await indexedDB.databases()).map((d) => d.name),
      };
    });
    expect(reach).toEqual({ runtimeId: null, sendMessage: 'undefined', databases: [] });

    const overlaysAfter = await page.locator(OVERLAY_HOST).count();
    test.info().annotations.push({
      type: 'accepted-risk',
      description: `forged content-script-started event: overlay ${
        overlaysAfter === 0 ? 'was removed (older copy retired)' : 'stayed mounted'
      } on that page; stored data unchanged`,
    });

    // (c) A reload gives a fresh content script: highlights come back and capture works again.
    await page.reload();
    await activate(env, page);
    await expect.poll(() => paintedByColor(page)).toEqual({ amber: [expect.any(String)] });
    await saveBlock(ext, page, '#p-multiline');
    expect(await highlightsOf(ext, page.url())).toHaveLength(2);
  });

  test('the worker enforces the sender policy against a content-script sender', async ({ env }) => {
    const ext = await openExt(env, 'options');
    // A on 127.0.0.1, B on localhost: different origins, different sites.
    const a = await openFixture(env, '/article.html');
    await saveBlock(ext, a, '#p-intro');
    const b = await openFixture(env, '/article.html', { origin: env.altOrigin });
    await saveBlock(ext, b, '#p-multiline');
    const aUrl = a.url();
    const bUrl = b.url();
    const [hA] = await highlightsOf(ext, aUrl);
    const [hB] = await highlightsOf(ext, bUrl);
    if (!hA || !hB) throw new Error('setup: both highlights must exist');
    const tabA = await tabIdOf(ext, a);
    const send = (type: string, payload: unknown) =>
      sendFromContentWorld(ext, tabA, { v: 1, type, payload });

    // Positive controls: a content script may touch its own site.
    expect(await send('banks.list', {})).toMatchObject({ ok: true });
    expect(await send('page.highlights', { url: aUrl, canonicalUrl: null })).toMatchObject({
      ok: true,
    });
    expect(
      await send('highlight.update', { id: hA.id, patch: { userComment: 'own site edit' } }),
    ).toMatchObject({ ok: true });
    expect(await send('capture.save', captureInput(`${env.origin}/article.html`))).toMatchObject({
      ok: true,
    });

    // Everything aimed at the other site is refused with `forbidden`.
    const foreign: Array<[string, unknown]> = [
      ['highlight.update', { id: hB.id, patch: { userComment: 'pwned' } }],
      ['highlight.delete', { id: hB.id }],
      ['highlight.restore', { id: hB.id }],
      ['highlight.reportResolution', { items: [{ id: hB.id, status: 'orphaned', confidence: 0 }] }],
      ['page.highlights', { url: bUrl, canonicalUrl: null }],
      ['capture.save', captureInput(`${env.altOrigin}/article.html`)],
      // Extension-only actions.
      ['site.status', { tabId: tabA, url: aUrl }],
      ['site.sync', {}],
      ['tab.activate', { tabId: tabA }],
    ];
    for (const [type, payload] of foreign) {
      const reply = await send(type, payload);
      expect(err(reply), `${type}: ${JSON.stringify(reply)}`).toMatchObject({ code: 'forbidden' });
    }

    // Nothing of the other site changed; the own-site edit did.
    const [hBAfter] = await highlightsOf(ext, bUrl);
    expect(await highlightsOf(ext, bUrl)).toHaveLength(1);
    expect(hBAfter).toMatchObject({ id: hB.id, userComment: '', exactQuote: hB.exactQuote });
    const own = await highlightsOf(ext, aUrl);
    expect(own.find((h) => h.id === hA.id)?.userComment).toBe('own site edit');
    // The forged-canonical case: a same-origin save that names another site's canonical URL must
    // not make the highlight appear on that site.
    const forgedCanonical = captureInput(
      `${env.origin}/article.html`,
      'Second injected quote.',
      bUrl,
    );
    await send('capture.save', forgedCanonical);
    expect(
      (await highlightsOf(ext, bUrl)).some((h) => h.exactQuote === 'Second injected quote.'),
    ).toBe(false);
  });

  // Ownership is the site of the highlight's source, deleted or not: a deleted row still belongs to
  // its page, so Undo needs no per-tab memory. Unknown ids are "not found", not "forbidden".
  test('Undo is authorised by same-site ownership: another same-site tab may restore, another site may not, an unknown id is not_found', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const a1 = await openFixture(env, '/article.html');
    const a2 = await openFixture(env, '/pages-b.html'); // same site, another tab and another page
    const b = await openFixture(env, '/article.html', { origin: env.altOrigin });
    await saveBlock(ext, a1, '#p-intro');
    const [h] = await highlightsOf(ext, a1.url());
    if (!h) throw new Error('setup: the highlight must exist');
    const tabA1 = await tabIdOf(ext, a1);
    const tabA2 = await tabIdOf(ext, a2);
    const tabB = await tabIdOf(ext, b);
    const send = (tab: number, type: string, payload: unknown) =>
      sendFromContentWorld(ext, tab, { v: 1, type, payload });

    expect(await send(tabA1, 'highlight.delete', { id: h.id })).toMatchObject({ ok: true });
    expect(await highlightsOf(ext, a1.url())).toHaveLength(0);
    // A repeated delete is idempotent.
    expect(await send(tabA1, 'highlight.delete', { id: h.id })).toMatchObject({ ok: true });

    // Another site cannot bring it back (and learns nothing more than "forbidden").
    expect(err(await send(tabB, 'highlight.restore', { id: h.id }))).toMatchObject({
      code: 'forbidden',
    });
    expect(await highlightsOf(ext, a1.url())).toHaveLength(0);

    // A different tab of the same site can: the Undo that was started in a1 may finish in a2.
    expect(await send(tabA2, 'highlight.restore', { id: h.id })).toMatchObject({ ok: true });
    expect(await highlightsOf(ext, a1.url())).toHaveLength(1);

    // Ids that never existed are not found, whichever action names them.
    const unknown = 'sv_never_existed_0000';
    for (const [type, payload] of [
      ['highlight.restore', { id: unknown }],
      ['highlight.delete', { id: unknown }],
      ['highlight.update', { id: unknown, patch: { priority: 2 } }],
    ] as const) {
      const reply = await send(tabA1, type, payload);
      expect(err(reply), `${type}: ${JSON.stringify(reply)}`).toMatchObject({ code: 'not_found' });
    }
  });

  test('a deny-listed site is refused at the worker even when the content script is not mounted', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const b = await openFixture(env, '/article.html', { origin: env.altOrigin });
    await patchSettings(ext, { denyList: ['localhost'] });
    const tabB = await tabIdOf(ext, b);
    const reply = await sendFromContentWorld(ext, tabB, {
      v: 1,
      type: 'capture.save',
      payload: captureInput(`${env.altOrigin}/article.html`),
    });
    expect(err(reply)).toMatchObject({ code: 'forbidden' });
    expect(err(reply)?.message).toContain('turned off on localhost');
    expect(await highlightsOf(ext, `${env.altOrigin}/article.html`)).toHaveLength(0);
  });

  test('malformed, mis-versioned and unknown messages are rejected or ignored without side effects', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const epoch = await dataEpoch(ext);
    const probe = (message: unknown) =>
      ext.evaluate(async (m) => {
        try {
          const r: unknown = await Promise.race([
            chrome.runtime.sendMessage(m),
            new Promise((resolve) => setTimeout(() => resolve('NO-REPLY-1.5s'), 1500)),
          ]);
          return { reply: r };
        } catch (e) {
          return { thrown: String((e as Error).message) };
        }
      }, message);

    // Valid envelope, invalid payload: a typed validation error, not a crash.
    const bad = await probe({ v: 1, type: 'capture.save', payload: { exactQuote: 'x' } });
    expect(bad).toMatchObject({ reply: { ok: false, error: { code: 'invalid_request' } } });
    const badId = await probe({ v: 1, type: 'highlight.delete', payload: { id: '../../x' } });
    expect(badId).toMatchObject({ reply: { ok: false, error: { code: 'invalid_request' } } });
    // Wrong protocol version / unknown type / prototype keys: never handled.
    for (const m of [
      { v: 2, type: 'banks.list', payload: {} },
      { v: 1, type: 'definitely.not.a.type', payload: {} },
      { v: 1, type: '__proto__', payload: {} },
      { v: 1, type: 'constructor', payload: {} },
      'banks.list',
      null,
    ]) {
      const r = await probe(m);
      const handled = 'reply' in r && typeof r.reply === 'object' && r.reply !== null;
      expect(handled, `${JSON.stringify(m)} must not be handled: ${JSON.stringify(r)}`).toBe(false);
    }
    expect(await dataEpoch(ext)).toBe(epoch);
  });
});

// =============================================================================================
// RESTRICTED PAGES
// =============================================================================================

test.describe('restricted pages: tab.activate answers with a specific error and the UI renders it', () => {
  const CHROME_BLOCKED = /Chrome does not let extensions run on this page/;
  const cases: Array<{ label: string; url: () => string; expectCode: string; message: RegExp }> = [
    {
      label: 'chrome://version',
      url: () => 'chrome://version/',
      expectCode: 'unsupported_page',
      message: CHROME_BLOCKED,
    },
    {
      label: 'chrome://extensions',
      url: () => 'chrome://extensions/',
      expectCode: 'unsupported_page',
      message: CHROME_BLOCKED,
    },
    {
      label: 'the Chrome Web Store (needs network; an offline error page is blocked the same way)',
      url: () => 'https://chromewebstore.google.com/',
      expectCode: 'unsupported_page',
      message: CHROME_BLOCKED,
    },
  ];

  for (const c of cases) {
    test(`${c.label}`, async ({ env }) => {
      const ext = await openExt(env, 'options');
      const page = await env.context.newPage();
      await page.goto(c.url(), { waitUntil: 'commit' }).catch(() => undefined);
      const tabId = await tabIdOf(ext, page);
      const reply = await activateWithin(ext, tabId, 10_000);
      expect(reply).not.toBe('timeout');
      expect(reply).toMatchObject({ ok: false, error: { code: c.expectCode } });
      expect((reply as { error: { message: string } }).error.message).toMatch(c.message);

      // The popup explains it instead of offering a dead Activate button.
      const popup = await viewing(env, 'popup', page);
      await expect(popup.getByText('StudyVault cannot run on this page')).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Activate on this tab' })).toHaveCount(0);

      // The side panel still offers Activate (the address is hidden) and shows the same error.
      const side = await viewing(env, 'sidepanel', page);
      await side.getByRole('button', { name: 'Activate on this tab' }).click();
      const alert = side.getByRole('alert').filter({ hasText: 'Could not activate StudyVault' });
      await expect(alert).toContainText(c.message);
      await expect(alert.getByRole('button', { name: 'Retry' })).toBeEnabled();
    });
  }

  test('file:// without the "Allow access to file URLs" opt-in is refused with guidance, not silence', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await env.context.newPage();
    await page.goto(pathToFileURL(path.resolve('tests/fixtures/html/article.html')).href);
    const tabId = await tabIdOf(ext, page);
    const reply = await activateWithin(ext, tabId, 10_000);
    expect(reply).not.toBe('timeout');
    const error = err(reply as Envelope);
    expect(['forbidden', 'unsupported_page']).toContain(error?.code);
    expect(error?.message.length ?? 0).toBeGreaterThan(30);
    expect(error?.message).toMatch(/toolbar icon|cannot run|does not let extensions/i);
    expect(error?.message).not.toMatch(/undefined|\[object/);

    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText('StudyVault cannot run on this page')).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Activate on this tab' })).toHaveCount(0);
  });

  test('about:blank and data: pages are refused with an actionable message', async ({ env }) => {
    const ext = await openExt(env, 'options');
    for (const url of ['about:blank', 'data:text/html,<p>hello</p>']) {
      const page = await env.context.newPage();
      if (url !== 'about:blank') await page.goto(url);
      const tabId = await tabIdOf(ext, page);
      const reply = await activateWithin(ext, tabId, 10_000);
      expect(reply, url).not.toBe('timeout');
      const error = err(reply as Envelope);
      expect(['forbidden', 'unsupported_page'], url).toContain(error?.code);
      expect(error?.message, url).toMatch(/toolbar icon|cannot run|does not let extensions/i);
    }
  });

  test("a real browser error page (connection refused) gets Chrome's own reason, not a generic failure", async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const port = await closedPort();
    const page = await env.context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`).catch(() => undefined);
    const tabId = await tabIdOf(ext, page);
    const reply = await activateWithin(ext, tabId, 10_000);
    expect(reply).toMatchObject({ ok: false, error: { code: 'unsupported_page' } });
    expect((reply as { error: { message: string } }).error.message).toMatch(/error page/);
  });

  test("Chrome's built-in PDF viewer: the popup says what is and is not possible", async ({
    env,
  }) => {
    const page = await env.context.newPage();
    await page.route(`${env.origin}/sample.pdf`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/pdf', body: minimalPdf('Hello PDF') }),
    );
    await page.goto(`${env.origin}/sample.pdf`);
    // The built-in viewer is an extension frame embedded in the tab.
    await expect
      .poll(() => page.frames().some((f) => f.url().startsWith('chrome-extension://')))
      .toBe(true);

    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText("PDFs open in Chrome's built-in viewer")).toBeVisible();
    await expect(popup.getByText(/cannot highlight here/)).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Activate on this tab' })).toHaveCount(0);
    // The side panel works without the page (saved highlights from every page), so it is offered here
    // too; what is not possible on this page is said above.
    await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();

    const side = await viewing(env, 'sidepanel', page);
    await expect(side.getByText("PDFs open in Chrome's built-in viewer")).toBeVisible();
    await expect(side.getByRole('button', { name: 'Activate on this tab' })).toHaveCount(0);
  });

  test('view-source: tab: Activate gives an answer in bounded time', async ({ env }) => {
    await openExt(env, 'options');
    const page = await env.context.newPage();
    await page.goto(`view-source:${env.origin}/article.html`);
    const side = await viewing(env, 'sidepanel', page);
    const activate = side.getByRole('button', { name: 'Activate on this tab' });
    await activate.click();
    // Either an error explanation or success: an endless busy state is neither.
    const answered = side
      .getByRole('alert')
      .or(side.getByText('No highlights on this page yet'))
      .first();
    await expect(
      answered,
      'Activate on a view-source: tab never completes (scripting.executeScript never settles)',
    ).toBeVisible({ timeout: 15_000 });
  });

  test('view-source: tab: the worker RPC answers within 15 seconds', async ({ env }) => {
    const ext = await openExt(env, 'options');
    const page = await env.context.newPage();
    await page.goto(`view-source:${env.origin}/article.html`);
    const tabId = await tabIdOf(ext, page);
    const reply = await activateWithin(ext, tabId, 15_000);
    expect(reply, 'tab.activate on a view-source: tab never answers').not.toBe('timeout');
    expect(reply).toMatchObject({ ok: false });
  });
});

// =============================================================================================
// PRODUCTION BUILD
// =============================================================================================

prodTest.describe('production build', () => {
  prodTest('ships exactly the documented least-privilege manifest', async ({ env }) => {
    const manifest = await env.serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.manifest_version).toBe(3);
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      ['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage'].sort(),
    );
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.action).toMatchObject({ default_popup: 'popup.html' });
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
    expect(manifest.options_ui).toEqual({ open_in_tab: true, page: 'options.html' });
    expect(manifest.background).toEqual({ service_worker: 'background.js' });
    // Extension pages may only talk to themselves (SECURITY_PRIVACY: "nothing leaves the device").
    expect(manifest.content_security_policy).toEqual({
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'; connect-src 'self'; frame-src 'none'; form-action 'none'",
    });
    expect(Object.keys(manifest.commands ?? {}).sort()).toEqual([
      'focus-toolbar',
      'next-highlight',
      'open-side-panel',
      'previous-highlight',
      'quick-save',
    ]);
    expect(manifest.minimum_chrome_version).toBe('120');
  });

  prodTest('popup, side panel and options render without console errors', async ({ env }) => {
    for (const name of ['popup', 'sidepanel', 'options'] as const) {
      const page = await openExt(env, name);
      await expect(page.getByRole('heading').first()).toBeVisible();
      // Let the first data load and any effect-time warnings settle.
      await page.waitForLoadState('networkidle');
      expect(errorsOf(page), `${name}.html`).toEqual([]);
    }
    const options = await openExt(env, 'options');
    const privacy = options.locator('#privacy');
    for (const p of ['storage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting']) {
      await expect(privacy.getByText(p, { exact: true })).toBeVisible();
    }
    await expect(privacy.getByText(/Access to websites is not among them/)).toBeVisible();
    expect(errorsOf(options)).toEqual([]);
  });

  prodTest(
    'without a grant, activation is refused with guidance and no page is touched',
    async ({ env }) => {
      const ext = await openExt(env, 'options');
      const page = await env.context.newPage();
      await page.goto(`${env.origin}/article.html`);
      const tabId = await tabIdOf(ext, page);
      const reply = await bg(ext, 'tab.activate', { tabId });
      expect(err(reply)).toMatchObject({ code: 'forbidden' });
      expect(err(reply)?.message).toMatch(/has not been given access to this tab yet/);
      await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
      expect(
        await ext.evaluate(() => chrome.permissions.contains({ origins: [`http://127.0.0.1/*`] })),
      ).toBe(false);

      // The genuine popup, with activeTab not granted, says Chrome did not share the address.
      const popup = await openRealPopup(env);
      const text = await popup.waitForText(/StudyVault cannot run on this page/);
      expect(text).toContain("Chrome did not share this tab's address");
      expect(await popup.hasButton('Activate on this tab')).toBe(false);
      await popup.close();
    },
  );

  prodTest('the overlay is built with a CLOSED shadow root (static bundle check)', async () => {
    // Runtime verification would need a content script running on a page, which this harness cannot
    // obtain on the production build (see the header comment). The e2e build is the same code with
    // mode "open"; the shipped bundle must carry mode "closed" and no "open" for the overlay.
    const prod = fs.readFileSync(
      path.resolve('.output/chrome-mv3/content-scripts/highlighter.js'),
      'utf8',
    );
    const e2e = fs.readFileSync(
      path.resolve('.output/chrome-mv3-e2e/content-scripts/highlighter.js'),
      'utf8',
    );
    const mode = (src: string) => /position:`inline`,[^}]*?mode:`(open|closed)`/.exec(src)?.[1];
    expect(mode(prod)).toBe('closed');
    expect(mode(e2e)).toBe('open'); // proves the pattern really finds the overlay's setting
  });
});
