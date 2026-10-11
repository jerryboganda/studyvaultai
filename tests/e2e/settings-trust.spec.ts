import {
  bg,
  expect,
  openExt,
  openFixture,
  patchSettings,
  tabIdOf,
  test,
  type Envelope,
} from './helpers.pages';

/**
 * What the service worker enforces comes from its authoritative settings copy (the extension's
 * IndexedDB), not from chrome.storage.local, which a content script can write
 * (docs/adr/010-module-seams.md, "Privileged configuration"). The "planted" writes below are exactly
 * what such a script could do; `patchSettings` is the legitimate path (the worker's updateSettings).
 */

const err = (reply: Envelope | 'timeout') =>
  typeof reply === 'object' && !reply.ok ? reply.error : undefined;

test.describe('settings the worker trusts', () => {
  test('a deny list emptied directly in chrome.storage.local does not lift a denial at the worker', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html', {
      activate: false,
      origin: env.altOrigin,
    });
    await patchSettings(ext, { denyList: ['localhost'] });
    const tabId = await tabIdOf(ext, page);
    expect(err(await bg(ext, 'tab.activate', { tabId }))).toMatchObject({ code: 'forbidden' });

    // The planted write: the display copy now says "nothing is denied".
    await ext.evaluate(() => chrome.storage.local.set({ settings: { denyList: [] } }));
    const shown = await ext.evaluate(
      async () =>
        ((await chrome.storage.local.get('settings')).settings as { denyList: string[] }).denyList,
    );
    expect(shown).toEqual([]);
    expect(err(await bg(ext, 'tab.activate', { tabId }))).toMatchObject({ code: 'forbidden' });

    // The person removing the entry through the settings path is honoured.
    await patchSettings(ext, { denyList: [] });
    expect(await bg(ext, 'tab.activate', { tabId })).toMatchObject({ ok: true });
  });

  test('a feature flag written directly in chrome.storage.local does not turn sync on in the worker', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    expect(await bg(ext, 'sync.status')).toMatchObject({ ok: true, data: { enabled: false } });
    await ext.evaluate(() =>
      chrome.storage.local.set({ settings: { features: { ai: false, sync: true } } }),
    );
    expect(await bg(ext, 'sync.status')).toMatchObject({ ok: true, data: { enabled: false } });
  });

  test('a fresh profile enforces the starter list without any write', async ({ env }) => {
    const ext = await openExt(env, 'options');
    // Nothing was ever stored, yet the worker's own copy already holds the starter list.
    const stored = await ext.evaluate(
      async () => (await chrome.storage.local.get('settings')).settings,
    );
    expect(stored).toBeUndefined();
    const status = await bg(ext, 'site.status', {
      tabId: 0,
      url: 'https://accounts.google.com/signin',
    });
    expect(status).toMatchObject({ ok: true, data: { supported: true, denied: true } });
    const other = await bg(ext, 'site.status', { tabId: 0, url: 'https://example.org/article' });
    expect(other).toMatchObject({ ok: true, data: { supported: true, denied: false } });
  });
});
