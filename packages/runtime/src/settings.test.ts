// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Settings } from '@shared';
import { getSettings, getTrustedSettings, setTrustedSettingsStore, updateSettings } from './index';

/**
 * updateSettings keeps two copies: the trusted one (IndexedDB `meta` in production, in memory here)
 * and the display copy in chrome.storage.local. A write that fails half way must not leave them apart:
 * the caller is told the save failed, so a later, unrelated change must not carry the unsaved value.
 */

let trustedRow: Settings | null = null;
let failTrustedSave = false;

beforeEach(() => {
  fakeBrowser.reset();
  trustedRow = null;
  failTrustedSave = false;
  setTrustedSettingsStore({
    load: async () => trustedRow && structuredClone(trustedRow),
    save: async (settings) => {
      if (failTrustedSave) throw new Error('IndexedDB write failed');
      trustedRow = structuredClone(settings);
    },
  });
});

afterEach(() => setTrustedSettingsStore(null));

async function bothCopies() {
  return { trusted: await getTrustedSettings(), shown: await getSettings() };
}

describe('updateSettings when one of the two writes fails', () => {
  it('a failed chrome.storage.local write persists nothing, and a later change does not apply it', async () => {
    vi.spyOn(browser.storage.local, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES exceeded'));
    await expect(updateSettings((s) => ({ ...s, density: 'compact' }))).rejects.toThrow('QUOTA');

    const failed = await bothCopies();
    expect(failed.trusted.density).toBe('comfortable');
    expect(failed.shown.density).toBe('comfortable');

    await updateSettings((s) => ({ ...s, theme: 'dark' }));
    const after = await bothCopies();
    expect(after.trusted).toMatchObject({ theme: 'dark', density: 'comfortable' });
    expect(after.shown).toMatchObject({ theme: 'dark', density: 'comfortable' });
  });

  it('a failed trusted write persists nothing, and a later change does not apply it', async () => {
    await updateSettings((s) => ({ ...s, denyList: ['bank.example'] }));
    failTrustedSave = true;
    await expect(updateSettings((s) => ({ ...s, density: 'compact' }))).rejects.toThrow(
      'IndexedDB',
    );

    const failed = await bothCopies();
    expect(failed.trusted).toMatchObject({ density: 'comfortable', denyList: ['bank.example'] });
    expect(failed.shown).toMatchObject({ density: 'comfortable', denyList: ['bank.example'] });

    failTrustedSave = false;
    await updateSettings((s) => ({ ...s, theme: 'dark' }));
    const after = await bothCopies();
    expect(after.trusted).toMatchObject({ theme: 'dark', density: 'comfortable' });
    expect(after.shown).toMatchObject({ theme: 'dark', density: 'comfortable' });
  });

  it('the trusted copy is current when the chrome.storage.local change event fires', async () => {
    // The worker (reminders, sync) re-reads the trusted copy on that event.
    const seen: Settings[] = [];
    fakeBrowser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'settings' in changes)
        void getTrustedSettings().then((s) => seen.push(s));
    });
    await updateSettings((s) => ({ ...s, density: 'compact' }));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.density).toBe('compact');
  });

  it('still ignores a direct chrome.storage.local write when deciding the next value', async () => {
    await updateSettings((s) => ({ ...s, denyList: ['bank.example'] }));
    await browser.storage.local.set({ settings: { denyList: [], allowIncognitoCapture: true } });

    const next = await updateSettings((s) => ({ ...s, theme: 'dark' }));
    expect(next).toMatchObject({ denyList: ['bank.example'], allowIncognitoCapture: false });
    expect(await getSettings()).toMatchObject({
      denyList: ['bank.example'],
      allowIncognitoCapture: false,
    });
  });
});
