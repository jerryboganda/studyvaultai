import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
import { gameState, readyGame, type GameFake } from './testGame';
import { Popup } from './Popup';

// The pages' highlight and bank reads go through the in-memory fake; the review counts and the
// bank presets are real code over fake-indexeddb.
const setGameMode = vi.hoisted(() => vi.fn(async (_on: boolean) => undefined));
vi.mock('@storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { store: fake } = await import('@ui/testing/fakes');
  return { ...actual, ...fake.module, setGameMode } as never;
});
// The game ledger has its own tests (packages/ui/src/game); here its answer is set per test.
const game = vi.hoisted(() => ({ current: null as unknown as GameFake }));
vi.mock('@ui/game', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGame: () => game.current,
}));
// The Sunny popup draws more on each render; jsdom on a busy machine needs longer than 1 s.
configure({ asyncUtilTimeout: 10_000 });

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
const alwaysOn = () => screen.getByRole('switch', { name: 'Always on' });
const turnOn = () => screen.getByRole('button', { name: 'Turn on' });

beforeEach(async () => {
  game.current = gameState();
  setGameMode.mockClear();
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
  it('unsupported scheme says why in one line, offers no way to turn on', async () => {
    rpc.background['site.status'] = () => siteStatus({ supported: false, pattern: null });
    await openOn('chrome://extensions');
    expect(await screen.findByRole('heading', { name: "Can't run here" })).toBeTruthy();
    expect(screen.getByText('Not a website')).toBeTruthy();
    // The (i) holds the detail. StudyVault supports http(s) only: no hint at a file:// opt-in.
    expect(screen.getByText(/This is a chrome: page/)).toBeTruthy();
    expect(screen.getByText(/local files \(file:\/\/\) are not supported/)).toBeTruthy();
    expect(screen.getByText(/Open a regular website to save/)).toBeTruthy();
    expect(screen.queryByText(/separate opt-in|off by default/)).toBeNull();
    expect(screen.queryByRole('button', { name: /turn on|always on/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
    // The worker is asked once (its effect may run just after the first paint).
    await waitFor(() => expect(rpc.called('site.status')).toHaveLength(1));
  });

  it('hidden address (browser page) is reported without calling the worker', async () => {
    await openOn(undefined);
    expect(await screen.findByText('Browser page')).toBeTruthy();
    expect(screen.getByText(/did not share this tab/)).toBeTruthy();
    expect(rpc.called('site.status')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
  });

  it('no active tab: says so, and Open side panel says why it cannot act', async () => {
    await browser.storage.local.set({ settings: defaultSettings() });
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    render(<Popup />);
    expect(await screen.findByRole('heading', { name: 'No tab open' })).toBeTruthy();
    const panel = screen.getByRole('button', { name: 'Open side panel' });
    expect(panel.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(panel);
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
  });

  it('the built-in PDF viewer is explained and cannot be turned on', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/paper.pdf');
    expect(await screen.findByText(/PDFs open in Chrome's built-in viewer/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'paper.pdf' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /turn on/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
  });

  it('denied site on the starter list: Allow is secondary, asks to confirm, then re-checks', async () => {
    let denied = true;
    rpc.background['site.status'] = () => siteStatus({ denied, pattern: 'https://paypal.com/*' });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] });
    await openOn('https://paypal.com/pay');
    expect(await screen.findByText('Not allowed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'paypal.com' })).toBeTruthy();
    expect(screen.getByText('On your deny list')).toBeTruthy();
    const allow = screen.getByRole('button', { name: 'Allow this site' });
    expect(allow.className).not.toContain('sv-chunky--primary');
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
    // The detail is behind (i): which entry, the subdomains, and the scoped starter-list note.
    expect(main().getByText(/paypal.com is on your deny list.*subdomains/)).toBeTruthy();
    expect(main().getByText(/starter list/i)).toBeTruthy();
    expect(main().queryByText(/blocked by default/)).toBeNull();

    // The first click only asks: nothing changes until the second, deliberate click.
    await userEvent.click(allow);
    expect(await screen.findByText('Allow paypal.com?')).toBeTruthy();
    expect(screen.getByText(/scripts could see what you mark/)).toBeTruthy();
    expect((await getSettings()).denyList).toContain('paypal.com');
    expect(rpc.called('site.sync')).toHaveLength(0);

    denied = false;
    await userEvent.click(screen.getByRole('button', { name: 'Yes, allow' }));

    await waitFor(async () => {
      expect((await getSettings()).denyList).not.toContain('paypal.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeTruthy();
    expect(spoken()).toContain('Allowed StudyVault on paypal.com.');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('denied site: "Keep it off" cancels the question and changes nothing', async () => {
    rpc.background['site.status'] = () => siteStatus({ denied: true });
    await openOn('https://paypal.com/pay');
    await userEvent.click(await screen.findByRole('button', { name: 'Allow this site' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it off' }));

    await userEvent.click(screen.getByRole('button', { name: 'Keep it off' }));

    expect(screen.queryByText('Allow paypal.com?')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Allow this site' }));
    expect((await getSettings()).denyList).toContain('paypal.com');
    expect(rpc.called('site.sync')).toHaveLength(0);
  });

  it('denied site the user added themselves: one click, no confirmation', async () => {
    rpc.background['site.status'] = () => siteStatus({ denied: true });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] });
    await openOn('https://my-school.example/portal', {
      denyList: [...DEFAULT_DENY_HOSTS, 'my-school.example'],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Allow this site' }));
    await waitFor(async () => {
      expect((await getSettings()).denyList).not.toContain('my-school.example');
    });
    expect(screen.queryByText(/Allow my-school.example\?/)).toBeNull();
  });

  it('denied by the worker with no local entry: "Check again" re-checks and shows progress', async () => {
    let release: (s: ReturnType<typeof siteStatus>) => void = () => undefined;
    let calls = 0;
    rpc.background['site.status'] = () => {
      calls += 1;
      return calls === 1
        ? siteStatus({ denied: true })
        : new Promise((resolve) => {
            release = resolve as never;
          });
    };
    await openOn('https://example.com/notes');
    const again = await screen.findByRole('button', { name: 'Check again' });
    await userEvent.click(again);
    await waitFor(() => expect(again.getAttribute('aria-busy')).toBe('true'));
    release(siteStatus());
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeTruthy();
  });

  it('not active: Turn on injects, then shows the active state', async () => {
    let active = false;
    rpc.background['site.status'] = () => siteStatus({ active });
    rpc.background['tab.activate'] = () => {
      active = true;
      return { ok: true };
    };
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes');
    expect(await screen.findByText('Off')).toBeTruthy();
    expect(screen.getByText(/this tab only, until you reload/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();

    await userEvent.click(turnOn());

    expect(rpc.called('tab.activate')[0]?.payload).toEqual({ tabId: TAB_ID });
    const count = await screen.findByTestId('popup-page-count');
    expect(count.textContent).toBe('3 highlights on this page');
    expect(screen.getByTestId('popup-attention').textContent).toBe('1 needs a look');
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
    // The clicked button is gone: focus is on a stable element and the result is announced.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    expect(spoken()).toContain('Turned on for this tab.');
  });

  it('only the clicked site button shows progress', async () => {
    rpc.background['site.status'] = () => siteStatus();
    rpc.background['tab.activate'] = () => new Promise(() => undefined); // never answers
    await openOn('https://example.com/notes');
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    expect(turnOn().getAttribute('aria-busy')).toBe('true');
    const always = screen.getByRole('button', { name: 'Always on for example.com' });
    expect(always.getAttribute('aria-busy')).toBeNull();
    // A second site action waits for the first.
    await userEvent.click(always);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
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
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));

    // The new answer has not arrived: the old view is still there, not "Checking this tab…".
    await waitFor(() => expect(rpc.called('site.status')).toHaveLength(2));
    expect(screen.queryByText('Checking this tab…')).toBeNull();
    expect(turnOn()).toBeTruthy();
    release(siteStatus({ active: true }));
    expect(await screen.findByRole('switch', { name: 'Always on' })).toBeTruthy();
    expect(alwaysOn().getAttribute('aria-checked')).toBe('false');
  });

  it('Always on: requests the origin inside the click, then persists, syncs, activates', async () => {
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

    await userEvent.click(await screen.findByRole('button', { name: 'Always on for example.com' }));

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    expect(rpcCallsAtRequest).toBe(0); // nothing awaited before the permission prompt
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(['https://example.com/*']);
    });
    const order = rpc.calls.map((c) => c.type).filter((t) => t !== 'site.status');
    expect(order.slice(0, 2)).toEqual(['site.sync', 'tab.activate']);
    const sw = await main().findByRole('switch', { name: 'Always on' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(spoken()).toContain('Always on for example.com.');
  });

  it('calls permissions.request synchronously inside the click (user gesture)', async () => {
    rpc.background['site.status'] = () => siteStatus();
    chrome.permissions.request.mockReturnValue(new Promise(() => undefined)); // never settles
    await openOn('https://example.com/notes');
    const button = await screen.findByRole('button', { name: 'Always on for example.com' });

    fireEvent.click(button); // no awaiting: React runs the handler inside this call

    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
  });

  it('the Always on switch also asks Chrome synchronously inside the click', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    chrome.permissions.request.mockReturnValue(new Promise(() => undefined));
    await openOn('https://example.com/notes');
    const sw = await screen.findByRole('switch', { name: 'Always on' });

    fireEvent.click(sw);

    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    // Shows the requested position while Chrome asks.
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-busy')).toBe('true');
  });

  it('Always on declined: explains, changes nothing', async () => {
    rpc.background['site.status'] = () => siteStatus();
    chrome.permissions.request.mockResolvedValue(false);
    await openOn('https://example.com/notes');

    await userEvent.click(await screen.findByRole('button', { name: 'Always on for example.com' }));

    expect(await main().findByText(/Chrome said no, so nothing changed/)).toBeTruthy();
    // Inactive state: the Turn on button exists, so the copy may point at it.
    expect(main().getByText(/Turn on still works for this tab/)).toBeTruthy();
    expect(spoken()).toContain('Chrome said no');
    expect((await getSettings()).persistentOrigins).toEqual([]);
    expect(rpc.called('site.sync')).toHaveLength(0);
    expect(rpc.called('tab.activate')).toHaveLength(0);
  });

  it('declined from the active state never points at a button that is not there, and rolls back', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    chrome.permissions.request.mockResolvedValue(false);
    await openOn('https://example.com/notes');

    await userEvent.click(await screen.findByRole('switch', { name: 'Always on' }));

    const text = (await main().findByText(/Chrome said no/)).textContent;
    expect(text).toContain('stays on for this tab only');
    expect(text).not.toContain('Turn on');
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
    await waitFor(() => expect(alwaysOn().getAttribute('aria-checked')).toBe('false'));
  });

  it('Always on: warns when the worker did not register the site, and still activates the tab', async () => {
    let active = false;
    rpc.background['site.status'] = () => siteStatus({ active });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] }); // pattern was discarded
    rpc.background['tab.activate'] = () => {
      active = true;
      return { ok: true };
    };
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes');

    await userEvent.click(await screen.findByRole('button', { name: 'Always on for example.com' }));

    expect(await main().findByText(/Always on did not stick on example.com/)).toBeTruthy();
    expect(rpc.called('tab.activate')).toHaveLength(1);
    expect(await screen.findByRole('switch', { name: 'Always on' })).toBeTruthy();
  });

  it('Always on for an address that cannot be registered: explains, asks Chrome for nothing', async () => {
    rpc.background['site.status'] = () => siteStatus({ pattern: 'https://exa$mple.com/*' });
    await openOn('https://exa$mple.com/notes');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Always on for exa$mple.com' }),
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
    expect(await screen.findByRole('switch', { name: 'Always on' })).toBeTruthy();
    expect(screen.queryByText('All sites')).toBeNull();
    cleanup();

    // The reverse: nothing stored, but Chrome and the worker say all-sites is on.
    rpc.background['site.status'] = () => siteStatus({ active: true, allSites: true });
    await openOn('https://example.com/notes', { persistentOrigins: [] });
    expect(await screen.findByText('All sites')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Always on' })).toBeNull();
  });

  it('inactive with real all-sites access: explains the reload, hides the per-site button', async () => {
    rpc.background['site.status'] = () => siteStatus({ allSites: true });
    await openOn('https://example.com/notes', { persistentOrigins: [] });
    expect(await screen.findByText(/All-sites access is on/)).toBeTruthy();
    expect(turnOn()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Always on for example.com' })).toBeNull();
  });

  it('calls sidePanel.open synchronously inside the click (user gesture)', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    chrome.sidePanel.open.mockReturnValue(new Promise(() => undefined));
    await openOn('https://example.com/notes');
    await screen.findByRole('switch', { name: 'Always on' }); // the tab is known
    const button = screen.getByRole('button', { name: 'Open side panel' });

    fireEvent.click(button);

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: WINDOW_ID });
  });

  it('opens the side panel from a state where the page cannot be used', async () => {
    rpc.background['site.status'] = () => siteStatus({ supported: false, pattern: null });
    await openOn('chrome://extensions');
    await screen.findByRole('heading', { name: "Can't run here" });
    await userEvent.click(screen.getByRole('button', { name: 'Open side panel' }));
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: WINDOW_ID });
    await waitFor(() => expect(window.close).toHaveBeenCalled());
  });

  it('active: shows counts, last-used bank, recent saves, and opens the side panel', async () => {
    store.reset([makeItem({ highlight: { exactQuote: 'ATP synthase spins.' } })]);
    store.banks = [INBOX, BIOLOGY];
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus({ ambiguous: 0, orphaned: 2 });
    await openOn('https://example.com/notes', { lastBankId: BIOLOGY.id });

    expect((await screen.findByTestId('popup-page-count')).textContent).toBe(
      '3 highlights on this page',
    );
    expect(screen.getByTestId('popup-attention').textContent).toBe('2 need a look');
    expect(await screen.findByText('Biology')).toBeTruthy();
    expect(screen.getByText('Last used bank:', { exact: false })).toBeTruthy();
    expect(await screen.findByText('ATP synthase spins.')).toBeTruthy();
    expect(screen.getByText(/Cell biology notes · example.com/)).toBeTruthy();
    const recent = screen.getByRole('region', { name: 'Recent saves' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Open side panel' }));

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: WINDOW_ID });
    await waitFor(() => expect(window.close).toHaveBeenCalled());
  });

  it('nothing saved yet: the sleeping mascot and one line, not a zero', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes');
    expect(await screen.findByText('Nothing saved yet')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('a page that cannot be read says so inline, with a Retry that asks again', async () => {
    let calls = 0;
    rpc.background['site.status'] = () => siteStatus({ active: true });
    rpc.tab['content.pageStatus'] = () => {
      calls += 1;
      if (calls === 1) throw new StudyVaultError('internal', 'Receiving end does not exist.');
      return pageStatus();
    };
    await openOn('https://example.com/notes');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Can't read page");
    expect(alert.textContent).toContain('Receiving end does not exist.');
    // The switch keeps its place next to the problem.
    expect(alwaysOn()).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('popup-page-count')).toBeTruthy();
  });

  it('names the real keys from commands.getAll, and shows nothing for a cleared one', async () => {
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

    const key = await screen.findByText('Ctrl+Shift+9');
    expect(key.closest('.pp-keys')?.textContent).toContain('Save');
    expect(screen.queryByText('Alt+Shift+H')).toBeNull(); // not hard-coded
    const panel = screen.getByRole('button', { name: 'Open side panel' });
    expect(panel.getAttribute('aria-keyshortcuts')).toBeNull();
    expect(panel.querySelector('kbd')).toBeNull();
  });

  it('shows the side panel key on its button, and says "Not set" for a cleared save key', async () => {
    rpc.background['site.status'] = () => siteStatus();
    chrome.commands.getAll.mockResolvedValue(
      COMMANDS.map((c) => (c.name === 'quick-save' ? { ...c, shortcut: '' } : c)),
    );
    await openOn('https://example.com/notes');
    // Ask again each time: the button is re-created once the tab is known.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Open side panel' }).getAttribute('aria-keyshortcuts'),
      ).toBe('Alt+Shift+S'),
    );
    expect(screen.getByText('Not set').closest('.pp-keys')?.textContent).toContain('Save');
  });

  it('active + persistent: switching always-on off revokes, updates settings and syncs', async () => {
    rpc.background['site.status'] = () => siteStatus({ active: true, access: 'persistent' });
    rpc.background['site.sync'] = () => ({ registeredMatches: [] });
    rpc.tab['content.pageStatus'] = () => pageStatus();
    await openOn('https://example.com/notes', {
      persistentOrigins: ['https://example.com/*', 'https://other.org/*'],
    });
    const sw = await screen.findByRole('switch', { name: 'Always on' });
    expect(sw.getAttribute('aria-checked')).toBe('true');

    await userEvent.click(sw);

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
    expect(alert.textContent).toContain("Can't check tab");
    expect(within(alert).getByText('Something went wrong.')).toBeTruthy();
    // The raw message is behind (i), not a second line.
    expect(within(alert).getByRole('button', { name: "About: Can't check tab" })).toBeTruthy();
    expect(alert.textContent).toContain('Worker exploded: code 42');

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeTruthy();
  });

  it('a storage_unavailable answer is shown as it is: no blind Retry, a Reload instead', async () => {
    rpc.background['site.status'] = () => {
      throw new StudyVaultError(
        'storage_unavailable',
        'Your data was saved by a newer version of StudyVault.',
      );
    };
    await openOn('https://example.com/notes');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Your data can't be opened.")).toBeTruthy();
    expect(alert.textContent).toContain('saved by a newer version of StudyVault');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('a failed tab check does not leave the card count waiting forever', async () => {
    rpc.background['site.status'] = () => {
      throw new StudyVaultError('storage_unavailable', 'IndexedDB is broken.');
    };
    await openOn('https://example.com/notes');
    await screen.findByRole('alert');
    // The count settles (here: no cards) instead of "Counting…" for good.
    expect((await screen.findByTestId('popup-due')).textContent).toBe('No flashcards yet');
    expect(screen.queryByText('Counting…')).toBeNull();
  });

  it('Retry also repeats a failed settings read', async () => {
    rpc.background['site.status'] = () => siteStatus();
    vi.spyOn(browser.storage.local, 'get').mockRejectedValueOnce(new Error('Disk unavailable'));
    await openOn('https://example.com/notes');

    expect((await screen.findByRole('alert')).textContent).toContain('Disk unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeTruthy();
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

    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeTruthy();
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

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('That did not work');
    expect(alert.textContent).toContain('No access to this tab yet.');

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('opens the options page from the header', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    await userEvent.click(await screen.findByRole('button', { name: 'Settings and privacy' }));
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

describe('site access in Settings', () => {
  it('the (i) next to Always on opens the Site access section of Settings', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openOn('https://example.com/notes');
    await userEvent.click(await screen.findByRole('button', { name: 'About turning on' }));
    await userEvent.click(screen.getByRole('button', { name: 'Site access' }));
    const url = new URL((create.mock.calls[0]![0] as { url: string }).url);
    expect(url.pathname).toBe('/options.html');
    expect(url.hash).toBe('#site-access');
    await waitFor(() => expect(window.close).toHaveBeenCalled());
  });
});

describe('quick toggles', () => {
  it('Highlights and Toolbar write the setting at once and show it pressed or not', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    const group = await screen.findByRole('group', { name: 'Quick toggles' });
    const paint = within(group).getByRole('button', { name: 'Highlights' });
    const toolbar = within(group).getByRole('button', { name: 'Toolbar' });
    expect(paint.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(paint);
    await waitFor(async () => expect((await getSettings()).paintHighlights).toBe(false));
    await waitFor(() => expect(paint.getAttribute('aria-pressed')).toBe('false'));

    await userEvent.click(toolbar);
    await waitFor(async () => expect((await getSettings()).toolbarEnabled).toBe(false));
    expect((await getSettings()).paintHighlights).toBe(false);
  });

  it('a failed write rolls the chip back and says why', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    const paint = await screen.findByRole('button', { name: 'Highlights' });
    vi.spyOn(browser.storage.local, 'set').mockRejectedValueOnce(new Error('Quota exceeded'));

    await userEvent.click(paint);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not saved');
    expect(alert.textContent).toContain('Quota exceeded');
    await waitFor(() => expect(paint.getAttribute('aria-pressed')).toBe('true'));
    expect((await getSettings()).paintHighlights).toBe(true);
  });
});

describe('today in the header (game layer)', () => {
  const header = () => within(screen.getByRole('banner'));

  it('Game mode on: the goal ring, the streak and the level, all named', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    expect(await header().findByRole('img', { name: 'Daily goal: 18 of 30 XP' })).toBeTruthy();
    expect(header().getByText('12 XP to goal.')).toBeTruthy(); // the ring's description
    expect(header().getByText(/12/, { selector: '.sv-stat__value' })).toBeTruthy();
    expect(header().getByText('day streak')).toBeTruthy();
    expect(header().getByRole('img', { name: 'Level 3' })).toBeTruthy();
  });

  it('Game mode off: plain counts, no XP, no streak, no level', async () => {
    game.current = gameState({ data: readyGame({ mode: false }) });
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    const today = await header().findByRole('group', { name: 'Today' });
    expect(today.textContent).toContain('8 reviewed');
    expect(today.textContent).toContain('3 saved');
    expect(header().queryByRole('img', { name: /Daily goal|Level/ })).toBeNull();
    expect(header().queryByText('day streak')).toBeNull();
  });

  it('while the ledger is built: real progress only, never a number of XP', async () => {
    game.current = gameState({
      data: {
        ready: false,
        mode: true,
        backfill: { status: 'running', done: 4, total: 10, error: null },
      },
    });
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    const bar = await header().findByRole('progressbar', { name: 'Counting your XP' });
    expect(bar.getAttribute('aria-valuenow')).toBe('4');
    expect(bar.getAttribute('aria-valuemax')).toBe('10');
    expect(header().queryByRole('img', { name: /Daily goal/ })).toBeNull();
  });

  it('a failed count says so and can run again; a read error says so', async () => {
    game.current = gameState({
      data: {
        ready: false,
        mode: true,
        backfill: { status: 'failed', done: 2, total: 10, error: 'Disk full' },
      },
    });
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    expect(await header().findByText(/Your XP could not be counted: Disk full/)).toBeTruthy();
    await userEvent.click(header().getByRole('button', { name: 'Count XP again' }));
    expect(game.current.retryBackfill).toHaveBeenCalledTimes(1);
    cleanup();

    game.current = gameState({ data: undefined, error: 'Stats store is closed' });
    await openOn('https://example.com/notes');
    expect(await header().findByText(/could not be read: Stats store is closed/)).toBeTruthy();
    await userEvent.click(header().getByRole('button', { name: 'Retry stats' }));
    expect(game.current.refresh).toHaveBeenCalledTimes(1);
  });

  it('the Game mode chip writes the mode and waits for the stored answer', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    const chip = await screen.findByRole('button', { name: 'Game mode' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(chip);
    expect(setGameMode).toHaveBeenCalledWith(false);
    // Saved, but the ledger has not answered yet: the chip shows the requested state.
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it('the Game mode chip says why it cannot act before the mode is known', async () => {
    game.current = gameState({ data: undefined });
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    const chip = await screen.findByRole('button', { name: 'Game mode' });
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    const wrap = chip.parentElement!;
    expect(within(wrap).getByRole('tooltip').textContent).toBe('Loading…');
    await userEvent.click(chip);
    expect(setGameMode).not.toHaveBeenCalled();
    // Escape hides the reason until focus or the pointer comes back (WCAG 1.4.13).
    await userEvent.keyboard('{Escape}');
    expect(wrap.hasAttribute('data-tip-off')).toBe(true);
    fireEvent.focusIn(chip);
    expect(wrap.hasAttribute('data-tip-off')).toBe(false);
  });
});

describe('status region', () => {
  it('uses one polite status region, present before anything is announced', async () => {
    rpc.background['site.status'] = () => siteStatus();
    await openOn('https://example.com/notes');
    await screen.findByRole('button', { name: 'Turn on' });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });
});

describe('PDF tabs: the StudyVault reader', () => {
  it('offers the reader with the tab address, explains the built-in viewer once, and closes', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openOn('https://example.com/papers/cell.pdf#page=3');

    expect(await screen.findByText(/PDFs open in Chrome's built-in viewer/)).toBeTruthy();
    expect(screen.getAllByText(/cannot mark up/)).toHaveLength(1);
    expect(screen.getByText('PDF')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /turn on/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Open in StudyVault' }));

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
    expect(await screen.findByRole('button', { name: 'Open in StudyVault' })).toBeTruthy();
  });

  it('a plain-http PDF is not offered as a web address: says so, still lets a file be chosen', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openOn('http://example.com/papers/cell.pdf');

    expect(await screen.findByText(/Only https addresses can be opened from the web/)).toBeTruthy();
    expect(screen.getByText('Choose the file in the reader.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in StudyVault' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open reader' }));

    const url = new URL((create.mock.calls[0]![0] as { url: string }).url);
    expect(url.pathname).toBe('/pdf-reader.html');
    expect(url.search).toBe('');
  });

  it('a local PDF file says it is not a web address', async () => {
    await openOn('file:///C:/study/cell.pdf');
    expect(await screen.findByText(/This PDF is not on the web/)).toBeTruthy();
    expect(screen.getByText(/choose the file from your computer/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open reader' })).toBeTruthy();
    // Not a PDF: the ordinary "cannot run here" card, no reader.
    cleanup();
    await openOn('file:///C:/study/notes.html');
    expect(await screen.findByRole('heading', { name: "Can't run here" })).toBeTruthy();
    expect(screen.getByText('Local file')).toBeTruthy();
    expect(screen.getByText(/local files \(file:\/\/\) are not supported/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /reader/i })).toBeNull();
  });

  it('is not offered while the PDF reader is turned off, and opens the right settings section', async () => {
    rpc.background['site.status'] = () => siteStatus();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await openOn('https://example.com/papers/cell.pdf', {
      features: { ...defaultSettings().features, pdfReader: false },
    });
    expect(await screen.findByText('PDF reader is off.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open in StudyVault|Open reader/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    const url = new URL((create.mock.calls[0]![0] as { url: string }).url);
    expect(url.pathname).toBe('/options.html');
    expect(url.hash).toBe('#capture');
  });

  it('a PDF on a denied site stays denied: no reader button', async () => {
    rpc.background['site.status'] = () => siteStatus({ denied: true });
    await openOn('https://paypal.com/statement.pdf');
    expect(await screen.findByText('Not allowed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'paypal.com' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open in StudyVault|Open reader/ })).toBeNull();
  });
});

describe('study: review and dashboard', () => {
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
    await waitFor(() => expect(badge.textContent).toBe('3 cards due'));
    expect(screen.getByText(/3 new · 0 learning · 0 review/)).toBeTruthy();

    // Live: a card made in another window raises the count without a reload.
    await createManualCards([basic(4)], { deckId: deck.id });
    await waitFor(() => expect(badge.textContent).toBe('4 cards due'));

    const start = screen.getByRole('button', { name: /^Start review/ });
    expect(start.className).toContain('sv-chunky--sun');
    await userEvent.click(start);
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
    expect(screen.queryByRole('button', { name: /^Start review/ })).toBeNull();
    const open = screen.getByRole('button', { name: /^Open review/ });
    expect(open.className).not.toContain('sv-chunky--sun');
    expect(screen.getByText(/Make a card from a saved highlight/)).toBeTruthy();
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
    await screen.findByTestId('popup-due');
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
    await screen.findByTestId('popup-due');
    await userEvent.click(await screen.findByRole('button', { name: 'Open dashboard' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Tabs are locked');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
