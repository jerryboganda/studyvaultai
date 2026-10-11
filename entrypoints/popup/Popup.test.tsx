import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import {
  DEFAULT_DENY_HOSTS,
  StudyVaultError,
  defaultSettings,
  type PageStatus,
  type Settings,
} from '@shared';
import { getSettings } from '@runtime';
import { createDeck, createManualCards } from '@storage';
import { freshDatabase } from '@storage/test-vault';
import {
  COMMANDS,
  makeChromeFakes,
  makeItem,
  rpc,
  siteStatus,
  store,
  BIOLOGY,
  INBOX,
} from '@ui/testing/fakes';
import { Popup } from './Popup';

// The pages' highlight and bank reads go through the in-memory fake; the review counts and the
// bank presets are real code over fake-indexeddb.
vi.mock('@storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { store: fake } = await import('@ui/testing/fakes');
  return { ...actual, ...fake.module } as never;
});
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

const tabAt = (url: string | undefined) =>
  [{ id: TAB_ID, windowId: WINDOW_ID, url, title: 'Tab', active: true, index: 0 }] as never;

async function openOn(url: string | undefined, settings: Partial<Settings> = {}) {
  await browser.storage.local.set({ settings: { ...defaultSettings(), ...settings } });
  // A query with a url filter is "is this extension page already open?": nothing is.
  vi.spyOn(browser.tabs, 'query').mockImplementation((async (q?: { url?: unknown }) =>
    q && 'url' in q ? [] : tabAt(url)) as never);
  return render(<Popup />);
}

/** The popup's content, without the visually hidden status region that repeats what is said. */
const main = () => within(screen.getByRole('main'));
/** What the surface's one polite status region holds right now. */
const spoken = () => screen.getByRole('status').textContent ?? '';

beforeEach(async () => {
  await freshDatabase(); // also resets fakeBrowser
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
    rpc.background['site.status'] = () => siteStatus({ supported: false, pattern: null });
    await openOn('chrome://extensions');
    expect(await screen.findByText('StudyVault cannot run on this page')).toBeTruthy();
    expect(screen.getByText(/"chrome:" address type/)).toBeTruthy();
    // StudyVault supports http(s) only: it must not hint at a file:// opt-in that does not exist.
    expect(screen.getByText(/local files \(file:\/\/\) are not supported/)).toBeTruthy();
    expect(screen.queryByText(/separate opt-in|off by default/)).toBeNull();
    expect(screen.queryByRole('button', { name: /activate/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
    // The worker is asked once (its effect may run just after the first paint).
    await waitFor(() => expect(rpc.called('site.status')).toHaveLength(1));
  });

  it('hidden address (browser page) is reported without calling the worker', async () => {
    await openOn(undefined);
    expect(await screen.findByText(/did not share this tab/)).toBeTruthy();
    expect(rpc.called('site.status')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
  });

  it('the built-in PDF viewer is explained and cannot be activated', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/paper.pdf');
    expect(await screen.findByText(/PDFs open in Chrome's built-in viewer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /activate/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
  });

  it('denied site on the starter list: Allow is secondary, asks to confirm, then re-checks', async () => {
    let denied = true;
    rpc.background['site.status'] = () => siteStatus({ denied, pattern: 'https://paypal.com/*' });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] });
    await openOn('https://paypal.com/pay');
    expect(await screen.findByText('StudyVault is off on paypal.com')).toBeTruthy();
    const allow = screen.getByRole('button', { name: 'Allow StudyVault on paypal.com' });
    expect(allow.className).not.toContain('sv-btn--primary');
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
    // The reason is normal text (not muted small print), and coverage is the scoped note.
    const reason = main().getByText(/Allowing it removes paypal.com from your deny list/);
    expect(reason.className).not.toMatch(/sv-muted|sv-small/);
    expect(main().getByText(/starter list/i)).toBeTruthy();
    expect(main().queryByText(/blocked by default/)).toBeNull();

    // The first click only asks: nothing changes until the second, deliberate click.
    await userEvent.click(allow);
    expect(await screen.findByText('Allow StudyVault on paypal.com?')).toBeTruthy();
    expect((await getSettings()).denyList).toContain('paypal.com');
    expect(rpc.called('site.sync')).toHaveLength(0);

    denied = false;
    await userEvent.click(
      screen.getByRole('button', { name: 'Yes, allow StudyVault on paypal.com' }),
    );

    await waitFor(async () => {
      expect((await getSettings()).denyList).not.toContain('paypal.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(await screen.findByText('StudyVault is not running on this tab')).toBeTruthy();
    expect(spoken()).toContain('Allowed StudyVault on paypal.com.');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('denied site: "Keep it off" cancels the question and changes nothing', async () => {
    rpc.background['site.status'] = () => siteStatus({ denied: true });
    await openOn('https://paypal.com/pay');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Allow StudyVault on paypal.com' }),
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it off' }));

    await userEvent.click(screen.getByRole('button', { name: 'Keep it off' }));

    expect(screen.queryByText('Allow StudyVault on paypal.com?')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Allow StudyVault on paypal.com' }),
    );
    expect((await getSettings()).denyList).toContain('paypal.com');
    expect(rpc.called('site.sync')).toHaveLength(0);
  });

  it('denied site the user added themselves: one click, no confirmation', async () => {
    rpc.background['site.status'] = () => siteStatus({ denied: true });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] });
    await openOn('https://my-school.example/portal', {
      denyList: [...DEFAULT_DENY_HOSTS, 'my-school.example'],
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Allow StudyVault on my-school.example' }),
    );
    await waitFor(async () => {
      expect((await getSettings()).denyList).not.toContain('my-school.example');
    });
    expect(screen.queryByText(/Allow StudyVault on my-school.example\?/)).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Activate on this tab' }));

    expect(rpc.called('tab.activate')[0]?.payload).toEqual({ tabId: TAB_ID });
    expect(await screen.findByText('3 highlights')).toBeTruthy();
    expect(screen.getByText(/1 needs attention/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
    // The clicked button is gone: focus is on a stable element and the result is announced.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    expect(spoken()).toContain('Activated on this tab.');
  });

  it('keeps the view in place while re-checking after an action (no blank screen)', async () => {
    let active = false;
    let release: (s: ReturnType<typeof siteStatus>) => void = () => undefined;
    rpc.background['site.status'] = () =>
      active
        ? new Promise((resolve) => {
            release = resolve as never;
          })
        : siteStatus();
    rpc.background['tab.activate'] = () => {
      active = true;
      return { ok: true };
    };
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes');
    await userEvent.click(await screen.findByRole('button', { name: 'Activate on this tab' }));

    // The new answer has not arrived: the old view is still there, not "Checking this tab…".
    await waitFor(() => expect(rpc.called('site.status')).toHaveLength(2));
    expect(screen.queryByText('Checking this tab…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Activate on this tab' })).toBeTruthy();
    release(siteStatus({ active: true }));
    expect(await screen.findByText(/Active on this tab only/)).toBeTruthy();
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
    expect(await main().findByText(/Always on/)).toBeTruthy();
    expect(spoken()).toContain('Always on for example.com.');
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
      await main().findByText(/Chrome did not give StudyVault access to example.com/),
    ).toBeTruthy();
    // Inactive state: the Activate button exists, so the copy may point at it.
    expect(main().getByText(/You can still use "Activate on this tab"/)).toBeTruthy();
    expect(spoken()).toContain('Chrome did not give StudyVault access');
    expect((await getSettings()).persistentOrigins).toEqual([]);
    expect(rpc.called('site.sync')).toHaveLength(0);
    expect(rpc.called('tab.activate')).toHaveLength(0);
  });

  it('declined from the active state never points at a button that is not there', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    chrome.permissions.request.mockResolvedValue(false);
    await openOn('https://example.com/notes');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Always enable on example.com' }),
    );

    const text = (await main().findByText(/Chrome did not give StudyVault access/)).textContent;
    expect(text).toContain('stays on for this tab only');
    expect(text).not.toContain('Activate on this tab');
    expect(screen.queryByRole('button', { name: 'Activate on this tab' })).toBeNull();
  });

  it('Always enable: warns when the worker did not register the site, and still activates the tab', async () => {
    let active = false;
    rpc.background['site.status'] = () => siteStatus({ active });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] }); // pattern was discarded
    rpc.background['tab.activate'] = () => {
      active = true;
      return { ok: true };
    };
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Always enable on example.com' }),
    );

    expect(
      await main().findByText(/could not set it to start by itself on every visit/),
    ).toBeTruthy();
    expect(rpc.called('tab.activate')).toHaveLength(1);
    expect(await screen.findByText(/Active on this tab only/)).toBeTruthy();
  });

  it('Always enable on an address that cannot be registered: explains, asks Chrome for nothing', async () => {
    rpc.background['site.status'] = () => siteStatus({ pattern: 'https://exa$mple.com/*' });
    await openOn('https://exa$mple.com/notes');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Always enable on exa$mple.com' }),
    );

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /cannot keep itself switched on/,
    );
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect((await getSettings()).persistentOrigins).toEqual([]);
  });

  it('all-sites comes from the worker, not from a stored list Chrome may have revoked', async () => {
    // Settings still list all-sites; Chrome no longer grants it (site.status.allSites is false).
    rpc.background['site.status'] = () => siteStatus({ active: true, allSites: false });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes', { persistentOrigins: ['https://*/*', 'http://*/*'] });
    expect(
      await screen.findByRole('button', { name: 'Always enable on example.com' }),
    ).toBeTruthy();
    expect(screen.queryByText(/for all sites/)).toBeNull();
    cleanup();

    // The reverse: nothing stored, but Chrome and the worker say all-sites is on.
    rpc.background['site.status'] = () => siteStatus({ active: true, allSites: true });
    await openOn('https://example.com/notes', { persistentOrigins: [] });
    expect(await screen.findByText(/for all sites/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Always enable on example.com' })).toBeNull();
  });

  it('inactive with real all-sites access: explains the reload, hides the per-site button', async () => {
    rpc.background['site.status'] = () => siteStatus({ allSites: true });
    await openOn('https://example.com/notes', { persistentOrigins: [] });
    expect(await screen.findByText(/All-sites access is on/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Always enable on example.com' })).toBeNull();
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

  it('opens the side panel from a state where the page cannot be used', async () => {
    rpc.background['site.status'] = () => siteStatus({ supported: false, pattern: null });
    await openOn('chrome://extensions');
    await userEvent.click(await screen.findByRole('button', { name: 'Open side panel' }));
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: WINDOW_ID });
    await waitFor(() => expect(window.close).toHaveBeenCalled());
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

  it('names the real keys from commands.getAll, and says "Not set" for a cleared one', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    chrome.commands.getAll.mockResolvedValue(
      COMMANDS.map((c) =>
        c.name === 'quick-save'
          ? { ...c, shortcut: 'Ctrl+Shift+9' }
          : c.name === 'open-side-panel'
            ? { ...c, shortcut: '' }
            : c,
      ),
    );
    await openOn('https://example.com/notes');

    const key = await main().findByText('Ctrl+Shift+9');
    expect(key.closest('li')?.textContent).toContain('Quick-save the current selection');
    expect(main().queryByText('Alt+Shift+H')).toBeNull(); // not hard-coded
    const panel = main().getByText('Open the StudyVault side panel').closest('li')!;
    expect(panel.textContent).toContain('Not set');
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
    expect(spoken()).toContain('Always-on turned off for example.com.');
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

  it('a storage_unavailable answer is shown as it is, without a blind Retry', async () => {
    rpc.background['site.status'] = () => {
      throw new StudyVaultError(
        'storage_unavailable',
        'Your data was saved by a newer version of StudyVault.',
      );
    };
    await openOn('https://example.com/notes');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('saved by a newer version of StudyVault');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('Retry also repeats a failed settings read', async () => {
    rpc.background['site.status'] = () => siteStatus();
    vi.spyOn(browser.storage.local, 'get').mockRejectedValueOnce(new Error('Disk unavailable'));
    await openOn('https://example.com/notes');

    expect((await screen.findByRole('alert')).textContent).toContain('Disk unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('StudyVault is not running on this tab')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Retry also repeats a failed tab query', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await browser.storage.local.set({ settings: defaultSettings() });
    vi.spyOn(browser.tabs, 'query')
      .mockRejectedValueOnce(new Error('No current window'))
      .mockImplementation(async () => tabAt('https://example.com/notes'));
    render(<Popup />);

    expect((await screen.findByRole('alert')).textContent).toContain('No current window');
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

  it('renders page-derived strings as text, never as markup, and lets the browser pick direction', async () => {
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

    const quote = await screen.findByText(evilQuote);
    expect(quote.getAttribute('dir')).toBe('auto');
    expect(container.textContent).toContain(evilTitle);
    expect(container.querySelector('img, script, b, i')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByText(/Title · <i>host<\/i>/).getAttribute('dir')).toBe('auto');
  });
});

describe('status region', () => {
  it('uses one polite status region, present before anything is announced', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    await screen.findByText('StudyVault is not running on this tab');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });
});

describe('PDF tabs: the StudyVault reader', () => {
  it('offers the reader with the tab address, explains the built-in viewer once, and closes', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openOn('https://example.com/papers/cell.pdf#page=3');

    expect(await screen.findByText("PDFs open in Chrome's built-in viewer")).toBeTruthy();
    expect(screen.getAllByText(/cannot highlight here/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /activate/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Open in StudyVault reader' }));

    expect(create).toHaveBeenCalledTimes(1);
    const url = new URL((create.mock.calls[0]![0] as { url: string }).url);
    expect(url.pathname).toBe('/pdf-reader.html');
    // The fragment is dropped: the reader fetches the document, not a place in it.
    expect(url.searchParams.get('src')).toBe('https://example.com/papers/cell.pdf');
    await waitFor(() => expect(window.close).toHaveBeenCalled());
  });

  it('is shown without waiting for the worker', async () => {
    rpc.background['site.status'] = () => new Promise(() => undefined); // never answers
    await openOn('https://example.com/papers/cell.pdf');
    expect(await screen.findByRole('button', { name: 'Open in StudyVault reader' })).toBeTruthy();
  });

  it('a plain-http PDF is not offered as a web address: says so, still lets a file be chosen', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openOn('http://example.com/papers/cell.pdf');

    expect(await screen.findByText(/Only https addresses can be opened from the web/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in StudyVault reader' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open the StudyVault reader' }));

    const url = new URL((create.mock.calls[0]![0] as { url: string }).url);
    expect(url.pathname).toBe('/pdf-reader.html');
    expect(url.search).toBe('');
  });

  it('a local PDF file says it is not a web address', async () => {
    await openOn('file:///C:/study/cell.pdf');
    expect(await screen.findByText(/This PDF is not on the web/)).toBeTruthy();
    expect(screen.getByText(/choose the file from your computer/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the StudyVault reader' })).toBeTruthy();
    // Not a PDF: the ordinary "cannot run here" note, no reader.
    cleanup();
    await openOn('file:///C:/study/notes.html');
    expect(await screen.findByText('StudyVault cannot run on this page')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /reader/i })).toBeNull();
  });

  it('is not offered while the PDF reader is turned off, and says where to turn it on', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/papers/cell.pdf', {
      features: { ...defaultSettings().features, pdfReader: false },
    });
    expect(await screen.findByText(/PDF reader is turned off/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /StudyVault reader/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
  });

  it('a PDF on a denied site stays denied: no reader button', async () => {
    rpc.background['site.status'] = () => siteStatus({ denied: true });
    await openOn('https://paypal.com/statement.pdf');
    expect(await screen.findByText('StudyVault is off on paypal.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /StudyVault reader/ })).toBeNull();
  });
});

describe('study bar: review and dashboard', () => {
  const basic = (n: number) => ({
    template: 'basic' as const,
    question: `Question ${n}?`,
    answer: `Answer ${n}`,
  });

  it('shows the real number of cards due, live, and Start review opens the review page', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1), basic(2), basic(3)], { deckId: deck.id });
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openOn('https://example.com/notes');

    const badge = await screen.findByTestId('popup-due');
    await waitFor(() => expect(badge.textContent).toContain('3 cards due'));
    expect(screen.getByText(/3 new · 0 learning · 0 review/)).toBeTruthy();

    // Live: a card made in another window raises the count without a reload.
    await createManualCards([basic(4)], { deckId: deck.id });
    await waitFor(() => expect(badge.textContent).toContain('4 cards due'));

    await userEvent.click(screen.getByRole('button', { name: 'Start review' }));
    const url = new URL((create.mock.calls[0]![0] as { url: string }).url);
    expect(url.pathname).toBe('/review.html');
    expect(url.searchParams.get('start')).toBe('1');
    await waitFor(() => expect(window.close).toHaveBeenCalled());
  });

  it('is there in every state, next to Open side panel', async () => {
    await openOn('chrome://extensions');
    expect(await screen.findByRole('button', { name: 'Open dashboard' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
    expect(await screen.findByTestId('popup-due')).toBeTruthy();
  });

  it('says there are no flashcards instead of showing a zero, and does not promise to "start"', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    expect((await screen.findByTestId('popup-due')).textContent).toBe('No flashcards yet');
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open review' })).toBeTruthy();
  });

  it('review turned off: no count, no review button, nothing queried, dashboard still there', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1)], { deckId: deck.id });
    await openOn('https://example.com/notes', {
      features: { ...defaultSettings().features, review: false },
    });
    expect(await screen.findByRole('button', { name: 'Open dashboard' })).toBeTruthy();
    expect(screen.queryByTestId('popup-due')).toBeNull();
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull();
    expect(screen.queryByText(/cards? due/)).toBeNull();
  });

  it('Open dashboard opens dashboard.html in a tab', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openOn('https://example.com/notes');
    await userEvent.click(await screen.findByRole('button', { name: 'Open dashboard' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect((create.mock.calls[0]![0] as { url: string }).url).toMatch(/\/dashboard\.html$/);
    await waitFor(() => expect(window.close).toHaveBeenCalled());
  });

  it('a failure to open the page is shown with a Retry, not swallowed', async () => {
    rpc.background['site.status'] = () => siteStatus();
    vi.spyOn(browser.tabs, 'create')
      .mockRejectedValueOnce(new Error('Tabs are locked'))
      .mockResolvedValue({} as never);
    await openOn('https://example.com/notes');
    await userEvent.click(await screen.findByRole('button', { name: 'Open dashboard' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Tabs are locked');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
