// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { uuidv7 } from 'uuidv7';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSettings, getTrustedSettings, updateSettings } from '@runtime';
import { getDb, readSyncPrivate, resetDbForTests, wipeAllData, writeSyncPrivate } from './index';

/**
 * chrome.storage.local is writable by content scripts, which run next to untrusted page script.
 * What the service worker enforces (deny list, private-window capture, feature flags) and where it
 * sends tokens must not be decided by what that area holds.
 */

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the authoritative settings copy', () => {
  it('is registered by importing the storage barrel and written by updateSettings', async () => {
    await updateSettings((s) => ({ ...s, denyList: ['bank.example'] }));
    const row = await getDb().meta.get('settings.trusted');
    expect(row?.value).toMatchObject({ denyList: ['bank.example'] });
  });

  it('adopts what chrome.storage.local held once (an upgrade), then ignores direct writes', async () => {
    await browser.storage.local.set({
      settings: { denyList: ['bank.example'], allowIncognitoCapture: false },
    });
    const first = await getTrustedSettings();
    expect(first.denyList).toEqual(['bank.example']);

    // What a compromised content script can do: write the area directly.
    await browser.storage.local.set({
      settings: { denyList: [], allowIncognitoCapture: true, features: { sync: true } },
    });
    const after = await getTrustedSettings();
    expect(after.denyList).toEqual(['bank.example']);
    expect(after.allowIncognitoCapture).toBe(false);
    expect(after.features.sync).toBe(false);
    // The page-side copy shows what was written: display data, nothing is decided from it.
    expect((await getSettings()).allowIncognitoCapture).toBe(true);
  });

  it('updateSettings starts from the authoritative copy: a planted value is corrected, not adopted', async () => {
    await updateSettings((s) => ({ ...s, denyList: ['bank.example'] }));
    await browser.storage.local.set({
      settings: { denyList: [], allowIncognitoCapture: true, features: { sync: true } },
    });

    const bankId = uuidv7();
    const next = await updateSettings((s) => ({ ...s, lastBankId: bankId }));
    expect(next.denyList).toEqual(['bank.example']);
    expect(next.allowIncognitoCapture).toBe(false);
    expect(next.features.sync).toBe(false);
    expect(next.lastBankId).toBe(bankId);
    // and the display copy is repaired by the same write
    const shown = await getSettings();
    expect(shown.denyList).toEqual(['bank.example']);
    expect(shown.allowIncognitoCapture).toBe(false);
  });

  it('goes with the database when everything is deleted', async () => {
    await updateSettings((s) => ({ ...s, denyList: ['mine.example'] }));
    await wipeAllData();
    const after = await getTrustedSettings();
    expect(after.denyList).not.toContain('mine.example');
    expect((await getSettings()).denyList).not.toContain('mine.example');
  });
});

describe('private sync configuration', () => {
  it('lives in the database, not in chrome.storage.local, and goes with the database', async () => {
    await writeSyncPrivate('sync.config', {
      v: 1,
      serverUrl: 'https://sync.example.org',
      issuer: 'https://id.example.org',
      clientId: 'studyvault',
      e2ee: null,
    });
    expect(await readSyncPrivate('sync.config')).toMatchObject({
      serverUrl: 'https://sync.example.org',
    });
    expect(JSON.stringify(await browser.storage.local.get(null))).not.toContain('sync.example.org');

    await writeSyncPrivate('sync.encryption', { mode: 'plaintext' });
    await writeSyncPrivate('sync.encryption', null);
    expect(await readSyncPrivate('sync.encryption')).toBeNull();

    await wipeAllData();
    expect(await readSyncPrivate('sync.config')).toBeNull();
  });
});
