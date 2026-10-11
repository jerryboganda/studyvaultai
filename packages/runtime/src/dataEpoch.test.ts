// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  bumpDataEpoch,
  bumpResolutionEpoch,
  revokeAllSiteAccess,
  watchDataEpoch,
  watchResolutionEpoch,
} from './index';

beforeEach(() => fakeBrowser.reset());

describe('change epochs', () => {
  it('keeps data and resolution notifications on separate channels', async () => {
    const data = vi.fn();
    const resolution = vi.fn();
    const stopData = watchDataEpoch(data);
    const stopResolution = watchResolutionEpoch(resolution);

    await bumpDataEpoch();
    expect([data.mock.calls.length, resolution.mock.calls.length]).toEqual([1, 0]);

    await bumpResolutionEpoch();
    expect([data.mock.calls.length, resolution.mock.calls.length]).toEqual([1, 1]);

    stopData();
    stopResolution();
    await bumpDataEpoch();
    await bumpResolutionEpoch();
    expect([data.mock.calls.length, resolution.mock.calls.length]).toEqual([1, 1]);
  });

  it('writes a fresh token every time, so storage.onChanged always fires', async () => {
    const seen: unknown[] = [];
    fakeBrowser.storage.onChanged.addListener((changes) => {
      if (changes.resolutionEpoch) seen.push(changes.resolutionEpoch.newValue);
    });
    await Promise.all([bumpResolutionEpoch(), bumpResolutionEpoch(), bumpResolutionEpoch()]);
    expect(new Set(seen).size).toBe(3);
  });

  it('ignores other storage areas and keys', async () => {
    const data = vi.fn();
    watchDataEpoch(data);
    await fakeBrowser.storage.session.set({ dataEpoch: 'x' });
    await fakeBrowser.storage.local.set({ resolutionEpoch: 'y', settings: {} });
    expect(data).not.toHaveBeenCalled();
  });
});

describe('revokeAllSiteAccess', () => {
  afterEach(() => {
    delete (browser as { permissions?: unknown }).permissions;
  });

  it('removes every granted origin and returns them', async () => {
    const remove = vi.fn(async (_p: { origins?: string[] }) => true);
    Object.assign(browser, {
      permissions: {
        getAll: vi.fn(async () => ({ origins: ['https://a.example/*', 'http://*/*'] })),
        remove,
      },
    });
    expect(await revokeAllSiteAccess()).toEqual(['https://a.example/*', 'http://*/*']);
    expect(remove).toHaveBeenCalledWith({ origins: ['https://a.example/*', 'http://*/*'] });
  });

  it('does nothing when nothing is granted or the API is missing', async () => {
    const remove = vi.fn(async (_p: { origins?: string[] }) => true);
    Object.assign(browser, { permissions: { getAll: vi.fn(async () => ({})), remove } });
    expect(await revokeAllSiteAccess()).toEqual([]);
    expect(remove).not.toHaveBeenCalled();

    delete (browser as { permissions?: unknown }).permissions;
    expect(await revokeAllSiteAccess()).toEqual([]);
  });
});
