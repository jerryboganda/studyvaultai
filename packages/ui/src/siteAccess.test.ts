import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultSettings } from '@shared';
import { getSettings } from '@runtime';
import { makeChromeFakes, rpc } from './testing/fakes';
import { editDenyList, grantSiteAccess, revokeSiteAccess } from './siteAccess';

vi.mock('@runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { rpc: fake } = await import('./testing/fakes');
  return { ...actual, callBackground: fake.callBackground } as never;
});

let chrome: ReturnType<typeof makeChromeFakes>;

beforeEach(() => {
  fakeBrowser.reset();
  rpc.reset();
  rpc.background['site.sync'] = () => ({ registeredMatches: [] });
  chrome = makeChromeFakes();
  Object.assign(browser, chrome);
});

describe('grantSiteAccess', () => {
  it('requests first, then stores (deduplicated) and syncs', async () => {
    await browser.storage.local.set({
      settings: { ...defaultSettings(), persistentOrigins: ['https://a.org/*'] },
    });
    const order: string[] = [];
    chrome.permissions.request.mockImplementation(async () => {
      order.push('request');
      return true;
    });
    rpc.background['site.sync'] = () => {
      order.push('sync');
      return { registeredMatches: [] };
    };

    expect(await grantSiteAccess(['https://a.org/*', 'https://b.org/*'])).toBe(true);

    expect(order).toEqual(['request', 'sync']);
    expect((await getSettings()).persistentOrigins).toEqual(['https://a.org/*', 'https://b.org/*']);
  });

  it('does nothing when the user declines', async () => {
    chrome.permissions.request.mockResolvedValue(false);
    expect(await grantSiteAccess(['https://a.org/*'])).toBe(false);
    expect((await getSettings()).persistentOrigins).toEqual([]);
    expect(rpc.calls).toHaveLength(0);
  });

  it('refuses to exceed the settings limit instead of silently losing the list', async () => {
    const full = Array.from({ length: 500 }, (_, i) => `https://s${i}.org/*`);
    await browser.storage.local.set({
      settings: { ...defaultSettings(), persistentOrigins: full },
    });
    await expect(grantSiteAccess(['https://new.org/*'])).rejects.toThrow(/limit of 500/);
    expect((await getSettings()).persistentOrigins).toEqual(full);
  });
});

describe('revokeSiteAccess', () => {
  it('converges settings even when Chrome had nothing to remove', async () => {
    await browser.storage.local.set({
      settings: { ...defaultSettings(), persistentOrigins: ['https://a.org/*', 'https://b.org/*'] },
    });
    chrome.permissions.remove.mockResolvedValue(false);
    await revokeSiteAccess(['https://a.org/*']);
    expect((await getSettings()).persistentOrigins).toEqual(['https://b.org/*']);
    expect(rpc.called('site.sync')).toHaveLength(1);
  });
});

describe('editDenyList', () => {
  it('applies the edit and syncs; a failing edit changes nothing', async () => {
    await editDenyList((list) => [...list, 'example.org']);
    expect((await getSettings()).denyList).toContain('example.org');
    expect(rpc.called('site.sync')).toHaveLength(1);

    await expect(
      editDenyList(() => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(rpc.called('site.sync')).toHaveLength(1);
  });
});
