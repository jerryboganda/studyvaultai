import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { dashboardPath, dashboardUrl, openDashboard } from './dashboardLink';

beforeEach(() => fakeBrowser.reset());
afterEach(() => vi.restoreAllMocks());

describe('dashboard links', () => {
  it('builds the path other surfaces use', () => {
    expect(dashboardPath()).toBe('dashboard.html');
    expect(dashboardPath({ highlight: '0192abcd-ef01', bank: null, q: 'a b' })).toBe(
      'dashboard.html?highlight=0192abcd-ef01&q=a+b',
    );
  });

  it('resolves to an extension address', () => {
    expect(dashboardUrl({ bank: 'inbox-default' })).toMatch(/dashboard\.html\?bank=inbox-default$/);
  });

  it('opens a new tab when no dashboard is open', async () => {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openDashboard({ q: 'golgi' });
    expect(create).toHaveBeenCalledWith({ url: dashboardUrl({ q: 'golgi' }) });
  });

  it('reuses and focuses an open dashboard tab', async () => {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => [
      { id: 7, windowId: 3 },
    ]) as never);
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    const win = vi.spyOn(browser.windows, 'update').mockResolvedValue({} as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openDashboard({ highlight: '0192abcd-ef01' });
    expect(update).toHaveBeenCalledWith(7, {
      url: dashboardUrl({ highlight: '0192abcd-ef01' }),
      active: true,
    });
    expect(win).toHaveBeenCalledWith(3, { focused: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to a new tab when the lookup fails', async () => {
    vi.spyOn(browser.tabs, 'query').mockRejectedValue(new Error('no'));
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openDashboard();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
