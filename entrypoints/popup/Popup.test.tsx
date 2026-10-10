import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { StudyVaultError, defaultSettings, type PageStatus, type Settings } from '@shared';
import { getSettings } from '@runtime';
import {
  makeChromeFakes,
  makeItem,
  rpc,
  siteStatus,
  store,
  BIOLOGY,
  INBOX,
} from '@ui/testing/fakes';
import { Popup } from './Popup';

vi.mock('@storage', async () => (await import('@ui/testing/fakes')).store.module);
vi.mock('@runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { rpc: fake } = await import('@ui/testing/fakes');
  return { ...actual, callBackground: fake.callBackground, callTab: fake.callTab } as never;
});

const TAB_ID = 7;
const WINDOW_ID = 3;
let chrome: ReturnType<typeof makeChromeFakes>;

function pageStatus(over: Partial<PageStatus['counts']> = {}): PageStatus {
  return {
    url: 'https://example.com/notes',
    canonicalUrl: null,
    title: 'Notes',
    counts: { total: 3, resolved: 2, changed: 0, ambiguous: 1, orphaned: 0, pending: 0, ...over },
    paintingSupported: true,
    hasSelection: false,
    blocked: null,
  };
}

async function openOn(url: string | undefined, settings: Partial<Settings> = {}) {
  await browser.storage.local.set({ settings: { ...defaultSettings(), ...settings } });
  vi.spyOn(browser.tabs, 'query').mockImplementation(
    async () =>
      [{ id: TAB_ID, windowId: WINDOW_ID, url, title: 'Tab', active: true, index: 0 }] as never,
  );
  return render(<Popup />);
}

beforeEach(() => {
  fakeBrowser.reset();
  store.reset();
  rpc.reset();
  chrome = makeChromeFakes();
  Object.assign(browser, chrome);
  Object.assign(browser.runtime, { openOptionsPage: vi.fn(async () => undefined) });
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
});
afterEach(cleanup);

describe('popup state matrix', () => {
  it('unsupported scheme explains Chrome blocks it, offers no activation', async () => {
    await openOn('chrome://extensions');
    expect(await screen.findByText('StudyVault cannot run on this page')).toBeTruthy();
    expect(screen.getByText(/"chrome:" address type/)).toBeTruthy();
    expect(screen.getByText(/file:\/\/\) are off by default/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /activate/i })).toBeNull();
    expect(rpc.called('site.status')).toHaveLength(1);
  });

  it('hidden address (browser page) is reported without calling the worker', async () => {
    await openOn(undefined);
    expect(await screen.findByText(/did not share this tab/)).toBeTruthy();
    expect(rpc.called('site.status')).toHaveLength(0);
  });

  it('the built-in PDF viewer is explained and cannot be activated', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/paper.pdf');
    expect(await screen.findByText(/PDFs open in Chrome's built-in viewer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /activate/i })).toBeNull();
  });

  it('denied site: removing the deny entry updates settings, syncs, and re-checks', async () => {
    let denied = true;
    rpc.background['site.status'] = () => siteStatus({ denied, pattern: 'https://paypal.com/*' });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] });
    await openOn('https://paypal.com/pay');
    expect(await screen.findByText('StudyVault is off on paypal.com')).toBeTruthy();

    denied = false;
    await userEvent.click(screen.getByRole('button', { name: 'Allow StudyVault on paypal.com' }));

    await waitFor(async () => {
      expect((await getSettings()).denyList).not.toContain('paypal.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(await screen.findByText('StudyVault is not running on this tab')).toBeTruthy();
  });

  it('not active: Activate on this tab injects, then shows the active state', async () => {
    let active = false;
    rpc.background['site.status'] = () => siteStatus({ active });
    rpc.background['tab.activate'] = () => {
      active = true;
      return { ok: true };
    };
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes');
    expect(await screen.findByText('StudyVault is not running on this tab')).toBeTruthy();
    expect(screen.getByText(/until you navigate away or reload/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Activate on this tab' }));

    expect(rpc.called('tab.activate')[0]?.payload).toEqual({ tabId: TAB_ID });
    expect(await screen.findByText('3 highlights')).toBeTruthy();
    expect(screen.getByText(/1 needs attention/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
  });

  it('Always enable: requests the origin inside the click, then persists, syncs, activates', async () => {
    let active = false;
    rpc.background['site.status'] = () =>
      siteStatus({ active, access: active ? 'persistent' : 'none' });
    rpc.background['site.sync'] = () => ({ registeredMatches: ['https://example.com/*'] });
    rpc.background['tab.activate'] = () => {
      active = true;
      return { ok: true };
    };
    rpc.tab['content.pageStatus'] = () => pageStatus();
    let rpcCallsAtRequest = -1;
    chrome.permissions.request.mockImplementation(async () => {
      rpcCallsAtRequest = rpc.calls.filter((c) => c.type !== 'site.status').length;
      return true;
    });
    await openOn('https://example.com/notes');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Always enable on example.com' }),
    );

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    expect(rpcCallsAtRequest).toBe(0); // nothing awaited before the permission prompt
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(['https://example.com/*']);
    });
    const order = rpc.calls.map((c) => c.type).filter((t) => t !== 'site.status');
    expect(order.slice(0, 2)).toEqual(['site.sync', 'tab.activate']);
    expect(await screen.findByText(/Always on/)).toBeTruthy();
  });

  it('calls permissions.request synchronously inside the click (user gesture)', async () => {
    rpc.background['site.status'] = () => siteStatus();
    chrome.permissions.request.mockReturnValue(new Promise(() => undefined)); // never settles
    await openOn('https://example.com/notes');
    const button = await screen.findByRole('button', { name: 'Always enable on example.com' });

    fireEvent.click(button); // no awaiting: React runs the handler inside this call

    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
  });

  it('Always enable declined: explains, changes nothing', async () => {
    rpc.background['site.status'] = () => siteStatus();
    chrome.permissions.request.mockResolvedValue(false);
    await openOn('https://example.com/notes');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Always enable on example.com' }),
    );

    expect(
      await screen.findByText(/Chrome did not give StudyVault access to example.com/),
    ).toBeTruthy();
    expect((await getSettings()).persistentOrigins).toEqual([]);
    expect(rpc.called('site.sync')).toHaveLength(0);
    expect(rpc.called('tab.activate')).toHaveLength(0);
  });

  it('calls sidePanel.open synchronously inside the click (user gesture)', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    chrome.sidePanel.open.mockReturnValue(new Promise(() => undefined));
    await openOn('https://example.com/notes');
    const button = await screen.findByRole('button', { name: 'Open side panel' });

    fireEvent.click(button);

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: WINDOW_ID });
  });

  it('active: shows counts, last-used bank, recent saves, and opens the side panel', async () => {
    store.reset([makeItem({ highlight: { exactQuote: 'ATP synthase spins.' } })]);
    store.banks = [INBOX, BIOLOGY];
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus({ ambiguous: 0, orphaned: 2 });
    await openOn('https://example.com/notes', { lastBankId: BIOLOGY.id });

    expect(await screen.findByText('3 highlights')).toBeTruthy();
    expect(screen.getByText(/2 need attention/)).toBeTruthy();
    expect(await screen.findByText('Biology')).toBeTruthy();
    expect(await screen.findByText('ATP synthase spins.')).toBeTruthy();
    expect(screen.getByText(/Cell biology notes · example.com/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Open side panel' }));

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: WINDOW_ID });
    await waitFor(() => expect(window.close).toHaveBeenCalled());
  });

  it('active + persistent: disabling always-on revokes, updates settings and syncs', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true, access: 'persistent' });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes', {
      persistentOrigins: ['https://example.com/*', 'https://other.org/*'],
    });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Disable always-on for this site' }),
    );

    expect(chrome.permissions.remove).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(['https://other.org/*']);
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
  });

  it('shows the real error and recovers on Retry', async () => {
    let calls = 0;
    rpc.background['site.status'] = () => {
      calls += 1;
      if (calls === 1) throw new StudyVaultError('internal', 'Worker exploded: code 42');
      return siteStatus();
    };
    await openOn('https://example.com/notes');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Worker exploded: code 42');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('StudyVault is not running on this tab')).toBeTruthy();
  });

  it('activation failure shows the real error and Retry repeats the action', async () => {
    let attempts = 0;
    rpc.background['site.status'] = () => siteStatus();
    rpc.background['tab.activate'] = () => {
      attempts += 1;
      if (attempts === 1) throw new StudyVaultError('forbidden', 'No access to this tab yet.');
      return { ok: true };
    };
    await openOn('https://example.com/notes');

    await userEvent.click(await screen.findByRole('button', { name: 'Activate on this tab' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No access to this tab yet.');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('opens the options page from the footer', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    await userEvent.click(await screen.findByRole('button', { name: /Settings and privacy/ }));
    expect(browser.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it('renders page-derived strings as text, never as markup', async () => {
    const evilTitle = '<img src=x onerror="window.__pwned=1"> Title';
    const evilQuote = '<script>window.__pwned=1</script><b>bold</b>';
    store.reset([
      makeItem({
        highlight: { exactQuote: evilQuote },
        source: { title: evilTitle, host: '<i>host</i>' },
      }),
    ]);
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    const { container } = await openOn('https://example.com/notes');

    expect(await screen.findByText(evilQuote)).toBeTruthy();
    expect(container.textContent).toContain(evilTitle);
    expect(container.querySelector('img, script, b, i')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
