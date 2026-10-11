import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
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
import { KIND_DECORATION } from '@highlights';
import {
  DEFAULT_DENY_HOSTS,
  DENY_LIST_SCOPE_NOTE,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  StudyVaultError,
  defaultSettings,
  type Settings,
} from '@shared';
import { getSettings } from '@runtime';
import {
  cacheDocumentBytes,
  createDeck,
  createManualCards,
  listDocuments,
  upsertDocument,
} from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { SyncApiProvider, type SyncApi, type SyncStatusView } from '@ui/sync';
import { COMMANDS, makeChromeFakes, rpc, store } from '@ui/testing/fakes';
import { Options } from './Options';

// The page's own writes (delete all data) go through the in-memory fake, which records them; what
// the review, AI, backup and storage sections read is real code over fake-indexeddb.
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

// The page mounts the review, AI, sync, backup and storage sections as well, which makes every
// role query in jsdom a second or so; a loaded CI shard must not turn that into a failure.
// `defaultHidden` skips the per-element visibility walk (jsdom has no layout to consult anyway).
vi.setConfig({ testTimeout: 90_000 });
configure({ asyncUtilTimeout: 45_000, defaultHidden: true });

const ALL = ['https://*/*', 'http://*/*'];
let chrome: ReturnType<typeof makeChromeFakes>;
let granted: Set<string>;

/** Stateful permission fake: request/remove/contains agree with each other like Chrome does. */
function wirePermissions() {
  granted = new Set();
  chrome.permissions.request.mockImplementation(async (p) => {
    p.origins?.forEach((o) => granted.add(o));
    return true;
  });
  chrome.permissions.remove.mockImplementation(async (p) => {
    p.origins?.forEach((o) => granted.delete(o));
    return true;
  });
  chrome.permissions.contains.mockImplementation(async (p) =>
    (p.origins ?? []).every(
      (o) => granted.has(o) || (!o.includes('*://') && granted.has('https://*/*')),
    ),
  );
}

/**
 * Tests that are not about the deny list run with a short one: the starter list has dozens of
 * entries and every role query in jsdom walks all of them. `withStarterList` is the real default.
 */
const SHORT_DENY = ['paypal.com'];
const withStarterList = { denyList: [...DEFAULT_DENY_HOSTS] };

/** Sync is off and not configured; the worker is not involved. */
const syncStatus: SyncStatusView = {
  enabled: false,
  config: null,
  redirectUrl: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/sync',
  permissions: { identity: true, alarms: true, missingOrigins: [] },
  signedIn: false,
  account: null,
  status: 'disabled',
  lastSyncAt: null,
  pending: 0,
  lastError: null,
  retryAt: null,
  running: false,
  e2ee: { mode: 'none', version: null, lockInSeconds: null },
  attention: { conflicts: 0, quarantined: 0 },
  notSynced: [],
  problem: null,
  scheduling: 'alarms',
};
const syncApi = {
  status: async () => syncStatus,
  onStatusChanged: () => () => undefined,
  listConflicts: async () => [],
  listQuarantine: async () => [],
} as unknown as SyncApi;

async function open(settings: Partial<Settings> = {}) {
  await browser.storage.local.set({
    settings: { ...defaultSettings(), denyList: SHORT_DENY, ...settings },
  });
  const view = render(
    <SyncApiProvider value={syncApi}>
      <Options />
    </SyncApiProvider>,
  );
  // The sections that read the database mount one task after the settings-only ones. Tests that
  // arm a one-shot failure must not have it consumed by that mount.
  await screen.findByTestId('storage-section');
  return view;
}

/** "Enable on all sites" is a two-step flow: the question, then Chrome's own prompt. */
async function enableAll() {
  await userEvent.click(await screen.findByRole('button', { name: 'Enable on all sites' }));
  await userEvent.click(await screen.findByRole('button', { name: "Continue to Chrome's prompt" }));
}

/**
 * What the surface's polite status region (the toast provider's) holds right now. The backup
 * importer keeps a second, private announcer that is empty until an import runs.
 */
const spoken = () => document.querySelector('.sv-toasts__polite')?.textContent ?? '';

beforeEach(async () => {
  await freshDatabase(); // also resets fakeBrowser
  store.reset();
  rpc.reset();
  rpc.background['site.sync'] = () => ({ registeredMatches: [] });
  chrome = makeChromeFakes();
  Object.assign(browser, chrome);
  wirePermissions();
  vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({
    name: 'StudyVault AI',
    version: '0.1.0',
    permissions: ['storage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting'],
  } as never);
});
afterEach(cleanup);

describe('content', () => {
  it('shows the privacy statement, real permissions and the manifest version', async () => {
    await open();
    expect(await screen.findByText(/Everything stays on this device/)).toBeTruthy();
    expect(screen.getByText(/version 0.1.0/)).toBeTruthy();
    const perms = screen.getByText('Permissions this extension holds').parentElement!;
    for (const p of ['storage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting']) {
      expect(within(perms).getByText(p)).toBeTruthy();
    }
    expect(screen.getByRole('heading', { name: 'Site access' })).toBeTruthy();
    expect(screen.getByText('This tab')).toBeTruthy();
    expect(screen.getByText('This site')).toBeTruthy();
    expect(screen.getAllByText('All sites').length).toBeGreaterThan(0);
  });

  it('discloses everything that is stored, including the page context and soft delete', async () => {
    await open();
    const stored = (await screen.findByText('What is stored on this device')).parentElement!;
    const text = stored.textContent ?? '';
    expect(text).toMatch(/up to 64\s+characters of the page text just before it and just after it/);
    expect(text).toMatch(/nearest heading/);
    expect(text).toMatch(/hash and the length of the whole\s+page text/);
    expect(text).toMatch(/where it sits in the\s+page structure/);
    expect(text).toMatch(/without a user name or password/);
    expect(text).toMatch(/page title/);
    expect(text).toMatch(/Deleted highlights stay in the trash on this device/);
    const seen = (await screen.findByText('What a website can see')).parentElement!;
    expect(seen.textContent).toMatch(/colour and kind/);
    expect(seen.textContent).toMatch(/sv-hl-amber-formula/);
  });

  it('has one toast status region; the only other live region is the importer’s, empty at rest', async () => {
    await open();
    await screen.findByText(/Everything stays on this device/);
    const regions = screen.getAllByRole('status');
    expect(document.querySelectorAll('.sv-toasts__polite')).toHaveLength(1);
    const others = regions.filter((r) => !r.classList.contains('sv-toasts__polite'));
    expect(others.map((r) => r.getAttribute('data-testid'))).toEqual(['backup-import-announce']);
    expect(others[0]!.textContent).toBe('');
  });
});

describe('site access', () => {
  it('enables all sites: shows the effective deny list first, then asks Chrome, stores both patterns, syncs', async () => {
    rpc.background['site.sync'] = () => ({ registeredMatches: ALL });
    let rpcCallsAtRequest = -1;
    chrome.permissions.request.mockImplementation(async (p) => {
      rpcCallsAtRequest = rpc.calls.length;
      p.origins?.forEach((o) => granted.add(o));
      return true;
    });
    // A short list: every role query in jsdom walks all rows, and the dialog's job is the same.
    const stayOff = ['paypal.com', 'accounts.google.com', 'mail.google.com'];
    await open({ denyList: stayOff });
    await userEvent.click(await screen.findByRole('button', { name: 'Enable on all sites' }));

    // Nothing is requested by the first click; the question shows what stays off.
    const dialog = await screen.findByRole('dialog', { name: 'Turn StudyVault on for all sites?' });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(within(dialog).getByText(DENY_LIST_SCOPE_NOTE)).toBeTruthy();
    const list = within(dialog).getByRole('region', { name: 'Sites on your deny list' });
    for (const host of stayOff) expect(within(list).getByText(host)).toBeTruthy();
    expect(within(dialog).getByText(/these 3 sites/)).toBeTruthy();

    await userEvent.click(
      within(dialog).getByRole('button', { name: "Continue to Chrome's prompt" }),
    );

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ALL });
    expect(rpcCallsAtRequest).toBe(0);
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(ALL);
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Revoke all-sites access' })).toBeTruthy();
    // Chrome's grant is read again after the change: the old button goes away with that answer.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Enable on all sites' })).toBeNull(),
    );
    expect(screen.getByText('On')).toBeTruthy();
    expect(spoken()).toContain('StudyVault is now on for all sites.');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'All sites' }));
  });

  it('says so when the deny list is empty, before asking', async () => {
    await open({ denyList: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Enable on all sites' }));
    expect(await screen.findByText(/Your deny list is empty/)).toBeTruthy();
  });

  it('cancelling the question asks Chrome for nothing and returns focus to the button', async () => {
    await open();
    const enable = await screen.findByRole('button', { name: 'Enable on all sites' });
    await userEvent.click(enable);
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(enable);
  });

  it('calls permissions.request synchronously inside the confirming click (user gesture)', async () => {
    chrome.permissions.request.mockReturnValue(new Promise(() => undefined));
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Enable on all sites' }));
    const confirm = await screen.findByRole('button', { name: "Continue to Chrome's prompt" });

    fireEvent.click(confirm);

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ALL });
  });

  it('declined: explains next to the control and changes nothing', async () => {
    chrome.permissions.request.mockResolvedValue(false);
    await open();
    await enableAll();

    const card = (await screen.findByRole('heading', { name: 'All sites' })).parentElement!;
    expect(await within(card).findByText(/Chrome did not grant access to all sites/)).toBeTruthy();
    expect((await getSettings()).persistentOrigins).toEqual([]);
    expect(rpc.called('site.sync')).toHaveLength(0);
  });

  it('a Chrome error is shown next to the button with its real text and a retry', async () => {
    chrome.permissions.request.mockRejectedValueOnce(
      new Error('Permissions request must be made from a user gesture'),
    );
    await open();
    await enableAll();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('user gesture');
    expect(alert.closest('.opt-card')?.querySelector('h3')?.textContent).toBe('All sites');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Revoke all-sites access' })).toBeTruthy();
  });

  it('revokes all-sites access and keeps individually enabled sites', async () => {
    ALL.forEach((o) => granted.add(o));
    await open({ persistentOrigins: [...ALL, 'https://example.com/*'] });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke all-sites access' }));

    expect(chrome.permissions.remove).toHaveBeenCalledWith({ origins: ALL });
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(['https://example.com/*']);
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Enable on all sites' })).toBeTruthy();
    expect(spoken()).toContain('All-sites access revoked.');
  });

  it('lists enabled sites with their real Chrome state and revokes one', async () => {
    granted.add('https://example.com/*');
    await open({ persistentOrigins: ['https://example.com/*', 'https://stale.org/*'] });

    const example = (await screen.findByText('example.com')).closest('li')!;
    // The per-site state arrives after the list renders: it comes from permissions.contains.
    expect(await within(example).findByText('Allowed')).toBeTruthy();
    const stale = screen.getByText('stale.org').closest('li')!;
    expect(await within(stale).findByText('Not allowed in Chrome')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Revoke access for example.com' }));

    expect(chrome.permissions.remove).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(['https://stale.org/*']);
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(spoken()).toContain('Revoked access for example.com.');
    // The row and its button are gone: focus moved to the list's heading, not <body>.
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Sites enabled one by one' }),
    );
  });

  it('shows a helpful empty state when no site is enabled', async () => {
    await open();
    expect(await screen.findByText(/None yet\./)).toBeTruthy();
  });
});

// The starter list has ~80 rows and every role query in jsdom walks them: give a loaded CI/dev box room.
describe('deny list', { timeout: 30_000 }, () => {
  it('shows defaults, adds a normalised host and syncs', async () => {
    await open(withStarterList);
    const first = DEFAULT_DENY_HOSTS[0]!;
    const row = (await screen.findByText(first)).closest('li')!;
    expect(within(row).getByText('Default')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Add a site'), 'HTTPS://Bank.Example.com/login');
    await userEvent.click(screen.getByRole('button', { name: 'Add to deny list' }));

    await waitFor(async () => {
      expect((await getSettings()).denyList).toContain('bank.example.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    const added = (await screen.findByText('bank.example.com')).closest('li')!;
    expect(within(added).queryByText('Default')).toBeNull();
    expect((screen.getByLabelText('Add a site') as HTMLInputElement).value).toBe('');
    expect(spoken()).toContain('Added bank.example.com to the deny list.');
  });

  it('states what the starter list covers instead of claiming banks and mail are covered', async () => {
    await open(withStarterList);
    await screen.findByText('Deny list');
    expect(screen.getByText(DENY_LIST_SCOPE_NOTE)).toBeTruthy();
    expect(screen.queryByText(/listed by default/)).toBeNull();
  });

  it('rejects invalid and duplicate input without changing anything', async () => {
    await open(withStarterList);
    const input = await screen.findByLabelText('Add a site');
    const add = screen.getByRole('button', { name: 'Add to deny list' });

    await userEvent.type(input, 'not a host');
    await userEvent.click(add);
    expect((await screen.findByRole('alert')).textContent).toMatch(/only the site name/);
    expect(input.getAttribute('aria-invalid')).toBe('true');

    await userEvent.clear(input);
    await userEvent.type(input, DEFAULT_DENY_HOSTS[0]!.toUpperCase());
    await userEvent.click(add);
    expect((await screen.findByRole('alert')).textContent).toMatch(/already on the deny list/);

    expect((await getSettings()).denyList).toEqual(DEFAULT_DENY_HOSTS);
    expect(rpc.called('site.sync')).toHaveLength(0);
  });

  it("after an upgrade the stored list is short: says how many starter sites are missing and keeps the user's own", async () => {
    await open({ denyList: ['paypal.com', 'my-school.example'] });
    const missing = DEFAULT_DENY_HOSTS.length - 1;
    expect(
      await screen.findByText(
        new RegExp(`${missing} of the ${DEFAULT_DENY_HOSTS.length} starter sites`),
      ),
    ).toBeTruthy();
    expect(screen.getByText(/the sites you added yourself stay/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Restore default sites' }));

    await waitFor(async () => {
      const list = (await getSettings()).denyList;
      expect(list).toContain('my-school.example');
      for (const host of DEFAULT_DENY_HOSTS) expect(list).toContain(host);
    });
  });

  it('removes an entry and restores the defaults', async () => {
    await open(withStarterList);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove paypal.com from the deny list' }),
    );
    await waitFor(async () => {
      expect((await getSettings()).denyList).not.toContain('paypal.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(spoken()).toContain('Removed paypal.com from the deny list.');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Deny list' }));
    expect(await screen.findByText(/Missing: paypal.com\./)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Restore default sites' }));
    await waitFor(async () => {
      expect((await getSettings()).denyList).toContain('paypal.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(2);
  });

  it('disables restore with an explanation when nothing is missing', async () => {
    await open(withStarterList);
    const button = await screen.findByRole('button', { name: 'Restore default sites' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toMatch(/already on the list/);
    await userEvent.click(button);
    expect(rpc.called('site.sync')).toHaveLength(0);
  });
});

describe('appearance and capture', () => {
  it('applies the theme immediately and persists it', async () => {
    await open();
    await userEvent.click(await screen.findByRole('radio', { name: /^Dark/ }));
    await waitFor(async () => expect((await getSettings()).theme).toBe('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');

    await userEvent.click(screen.getByRole('radio', { name: /^Match my system/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
    expect((await getSettings()).theme).toBe('system');
  });

  it('persists the default kind and a palette colour with a live preview', async () => {
    await open();
    await userEvent.selectOptions(
      await screen.findByLabelText('Default highlight kind'),
      'formula',
    );
    await waitFor(async () => expect((await getSettings()).defaultKind).toBe('formula'));

    const select = screen.getByLabelText(/Exception/);
    await userEvent.selectOptions(select, 'teal');
    await waitFor(async () => expect((await getSettings()).palette.exception).toBe('teal'));
    const sample = within(select.closest('li')!).getByText('Sample text');
    expect(sample.style.background).toContain('rgba(45, 212, 191');
  });

  it('toggles the floating toolbar', async () => {
    await open();
    const box = await screen.findByRole('checkbox', { name: /Show the floating toolbar/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    await userEvent.click(box);
    await waitFor(async () => expect((await getSettings()).toolbarEnabled).toBe(false));
  });

  it('toggles painting, explaining that page scripts can read what is painted', async () => {
    await open();
    const box = await screen.findByRole('checkbox', { name: 'Show highlights on pages' });
    expect((box as HTMLInputElement).checked).toBe(true);
    const hint = document.getElementById(box.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toMatch(/scripts that a site itself runs can read/);
    expect(hint.textContent).toMatch(/deny list/);

    await userEvent.click(box);
    await waitFor(async () => expect((await getSettings()).paintHighlights).toBe(false));
    // The style choices explain why they are off instead of silently doing nothing.
    const normal = screen.getByRole('radio', { name: /^Normal/ });
    expect(normal.matches(':disabled')).toBe(true);
    expect(screen.getByText(/no effect while highlights are not shown/)).toBeTruthy();
  });

  it('offers automatic, normal and strong highlight style and persists the choice', async () => {
    await open();
    const auto = await screen.findByRole('radio', { name: /^Automatic/ });
    expect((auto as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /^Normal/ })).toBeTruthy();

    await userEvent.click(screen.getByRole('radio', { name: /^Strong/ }));
    await waitFor(async () => expect((await getSettings()).highlightStyle).toBe('strong'));
  });

  it('draws a legend from KIND_DECORATION: every kind, its name and its underline', async () => {
    await open();
    const legend = await screen.findByRole('list', { name: 'Underline for each highlight kind' });
    const rows = within(legend).getAllByRole('listitem');
    expect(rows).toHaveLength(HIGHLIGHT_KINDS.length);
    HIGHLIGHT_KINDS.forEach((kind, i) => {
      const row = rows[i]!;
      const deco = KIND_DECORATION[kind];
      expect(within(row).getByText(KIND_LABELS[kind].label, { exact: false })).toBeTruthy();
      expect(within(row).getByText(deco.label)).toBeTruthy();
      const sample = within(row).getByText('Sample text');
      expect(sample.style.textDecorationStyle).toBe(deco.style);
      expect(sample.style.textDecorationThickness).toBe(`${deco.thickness}px`);
    });

    await userEvent.click(screen.getByRole('radio', { name: /^Strong/ }));
    await waitFor(() => {
      const sample = within(within(legend).getAllByRole('listitem')[0]!).getByText('Sample text');
      expect(sample.style.textDecorationThickness).toBe(
        `${KIND_DECORATION[HIGHLIGHT_KINDS[0]!].thickness + 1}px`,
      );
    });
  });

  it('allows private-window capture only after warning where it is stored', async () => {
    await open();
    const box = await screen.findByRole('checkbox', { name: 'Save from private windows' });
    expect((box as HTMLInputElement).checked).toBe(false);
    const hint = document.getElementById(box.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toMatch(/stored in your normal Chrome profile/);

    await userEvent.click(box);
    await waitFor(async () => expect((await getSettings()).allowIncognitoCapture).toBe(true));
  });

  it('keeps a failed write visible next to its control with Retry, then succeeds', async () => {
    await open();
    const radio = await screen.findByRole('radio', { name: /^Light/ });
    vi.spyOn(browser.storage.local, 'set').mockRejectedValueOnce(new Error('Quota exceeded'));
    await userEvent.click(radio);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Quota exceeded');
    // In the Appearance section that owns the control, not at the top of the page.
    expect(alert.closest('section')?.contains(radio)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(async () => expect((await getSettings()).theme).toBe('light'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('keyboard shortcuts', () => {
  it('lists the real bindings from Chrome, shows "Not set", and the in-page keys', async () => {
    await open();
    const section = (await screen.findByRole('heading', { name: 'Keyboard shortcuts' }))
      .parentElement!;
    const commands = await within(section).findByRole('list', { name: 'Browser shortcuts' });
    const rows = within(commands).getAllByRole('listitem');
    expect(rows).toHaveLength(COMMANDS.length);
    for (const c of COMMANDS) {
      const row = within(commands).getByText(c.description).closest('li')!;
      expect(row.textContent).toContain(c.shortcut || 'Not set');
    }
    const inPage = within(section).getByRole('list', { name: 'In-page shortcuts' });
    expect(within(inPage).getByText('Alt+Shift+]')).toBeTruthy();
    expect(within(inPage).getByText('Alt+Shift+[')).toBeTruthy();
  });

  it('reflects what the user changed in Chrome when the page regains focus', async () => {
    await open();
    expect(await screen.findByText('Alt+Shift+H')).toBeTruthy();
    chrome.commands.getAll.mockResolvedValue(
      COMMANDS.map((c) => (c.name === 'quick-save' ? { ...c, shortcut: '' } : c)),
    );

    fireEvent.focus(window);

    await waitFor(() => expect(screen.queryByText('Alt+Shift+H')).toBeNull());
  });

  it("opens Chrome's shortcut page in a new tab", async () => {
    const create = vi.spyOn(browser.tabs, 'create');
    await open();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Change shortcuts in Chrome' }),
    );
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
  });

  it('reports a failure to open the page, and a failure to read the commands, with Retry', async () => {
    vi.spyOn(browser.tabs, 'create').mockRejectedValueOnce(new Error('Tabs API unavailable'));
    chrome.commands.getAll.mockRejectedValueOnce(new Error('commands unavailable'));
    await open();

    expect(await screen.findByText('commands unavailable')).toBeTruthy();
    await userEvent.click(
      within(
        screen.getByText('commands unavailable').closest('[role="alert"]') as HTMLElement,
      ).getByRole('button', { name: 'Retry' }),
    );
    expect(await screen.findByText('Alt+Shift+S')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Change shortcuts in Chrome' }));
    expect(await screen.findByText('Tabs API unavailable')).toBeTruthy();
  });
});

describe('delete all data', () => {
  const openDialog = async () => {
    await userEvent.click(
      await screen.findByRole('button', { name: /Delete all StudyVault data/ }),
    );
    return screen.findByRole('dialog', { name: 'Delete all StudyVault data?' });
  };

  it('says what is deleted, is accessible, and defaults to Cancel', async () => {
    await open();
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/including the ones in the trash/);
    expect(dialog.textContent).toMatch(/cannot be undone/);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(store.calls.some((c) => c.fn === 'wipeAllData')).toBe(false);
  });

  it('wipes the data, then syncs the worker, then reports and moves focus', async () => {
    await open({ persistentOrigins: ['https://example.com/*'], theme: 'dark' });
    const dialog = await openDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }));

    await waitFor(() => expect(store.calls.some((c) => c.fn === 'wipeAllData')).toBe(true));
    await waitFor(() => expect(rpc.called('site.sync')).toHaveLength(1));
    expect(
      await screen.findByText(/All StudyVault data was deleted from this device/),
    ).toBeTruthy();
    expect(spoken()).toContain('All StudyVault data was deleted.');
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Delete all StudyVault data' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a storage_unavailable refusal shows its message and no blind Retry', async () => {
    store.failNext.wipeAllData = new StudyVaultError(
      'storage_unavailable',
      'Another StudyVault window is using the data. Close it and try again.',
    );
    await open();
    await userEvent.click(
      within(await openDialog()).getByRole('button', { name: 'Delete everything' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Another StudyVault window is using the data');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('lists everything it removes, and what it does not', async () => {
    await open();
    const text = (await openDialog()).textContent ?? '';
    for (const part of [
      /highlight with its note, including the ones in the trash/,
      /banks,\s+folders and tags/,
      /kept PDF copies/,
      /flashcards and review history/,
      /AI drafts, your provider settings and your API key/,
      /sync settings, the sign-in[\s\S]*before its last update/,
      /theme, colours, deny list/,
      /access Chrome gave StudyVault to\s+websites/,
    ]) {
      expect(text).toMatch(part);
    }
    expect(text).toMatch(
      /does not remove files you exported or backed\s+up, anything on your other devices/,
    );
    // Never "no server, nothing to get back": there may be a server copy, and it is separate.
    expect(text).not.toMatch(/no server|no copy to get back/);
    expect(text).toMatch(/a copy on a sync server, if you ever used sync: that is separate/);
  });

  it('with sync on, says the server copy stays and how to remove it first', async () => {
    await open({ features: { ...defaultSettings().features, sync: true } });
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/the copy on your sync server/);
    expect(dialog.textContent).toMatch(/Delete my data from the server/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }));
    expect(await screen.findByText(/The copy on your sync server was not touched/)).toBeTruthy();
  });

  it('shows the real error and repeats every step on Retry', async () => {
    store.failNext.wipeAllData = new Error('Database is locked by another window');
    await open();
    await userEvent.click(
      within(await openDialog()).getByRole('button', { name: 'Delete everything' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Database is locked by another window');
    expect(rpc.called('site.sync')).toHaveLength(0); // nothing after the failed step ran

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rpc.called('site.sync')).toHaveLength(1));
    expect(await screen.findByText(/deleted from this device/)).toBeTruthy();
  });
});

describe('delete all data: waiting for another window', () => {
  const openDialog = async () => {
    await userEvent.click(
      await screen.findByRole('button', { name: /Delete all StudyVault data/ }),
    );
    return screen.findByRole('dialog', { name: 'Delete all StudyVault data?' });
  };

  /** A `wipeAllData` the test drives: states in, finish or fail from outside, stop honoured. */
  async function controlledWipe() {
    const storage = await import('@storage');
    const wipe: {
      state(s: 'deleting' | 'blocked' | 'cleaning'): void;
      finish(): void;
      fail(e: Error): void;
      calls: number;
    } = { state: () => undefined, finish: () => undefined, fail: () => undefined, calls: 0 };
    vi.spyOn(storage, 'wipeAllData').mockImplementation(
      (options = {}) =>
        new Promise<void>((resolve, reject) => {
          wipe.calls += 1;
          wipe.state = (st) => options.onState?.(st);
          wipe.finish = resolve;
          wipe.fail = reject;
          options.signal?.addEventListener('abort', () =>
            reject(
              new storage.WipePendingError('Deleting is not finished. It cannot be cancelled.'),
            ),
          );
          options.onState?.('deleting');
        }),
    );
    return wipe;
  }

  const confirm = async () =>
    userEvent.click(within(await openDialog()).getByRole('button', { name: 'Delete everything' }));

  it('blocked: names what to do, says it needs no second click, and finishes by itself', async () => {
    const wipe = await controlledWipe();
    await open();
    await confirm();
    expect(await screen.findByText('Deleting…')).toBeTruthy();

    wipe.state('blocked');
    expect(await screen.findByText('Waiting for another StudyVault window')).toBeTruthy();
    expect(
      screen.getByText(
        "Close every other StudyVault tab, dashboard and side panel. Your data is deleted the moment they are closed; you don't need to click again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull(); // waiting is not an error
    expect(rpc.called('site.sync')).toHaveLength(0);

    // The other window closes: the same call finishes, the worker is told, the page reports it.
    wipe.state('cleaning');
    expect(await screen.findByText(/Removing the pre-update copy/)).toBeTruthy();
    wipe.finish();
    expect(
      await screen.findByText(/All StudyVault data was deleted from this device/),
    ).toBeTruthy();
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(screen.queryByText('Waiting for another StudyVault window')).toBeNull();
    expect(wipe.calls).toBe(1);
  });

  it('Stop waiting is a warning, not a failure, and does not claim the deletion was cancelled', async () => {
    const wipe = await controlledWipe();
    await open();
    await confirm();
    wipe.state('blocked');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop waiting' }));

    expect(await screen.findByText('Deleting is not finished')).toBeTruthy();
    expect(
      screen.getByText(
        "Stopping does not cancel the deletion: it still finishes when that window closes, and StudyVault here can't read or save until then.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Deleting your data did not finish')).toBeNull();
    expect(rpc.called('site.sync')).toHaveLength(0);
    // Not offered again while it is pending.
    expect(
      screen
        .getByRole('button', { name: /Delete all StudyVault data/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('Check again, once the deletion is over, reads the data and finishes the report without deleting again', async () => {
    const wipe = await controlledWipe();
    await open();
    await confirm();
    wipe.state('blocked');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop waiting' }));
    await screen.findByText('Deleting is not finished');

    // The other window closed and the deletion ended; this page was no longer listening. The
    // database is empty again, so the check can say so. It must not start another wipe.
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(
      await screen.findByText(/All StudyVault data was deleted from this device/),
    ).toBeTruthy();
    expect(wipe.calls).toBe(1);
    expect(rpc.called('site.sync')).toHaveLength(1);
  });

  it('Check again says so when data is still there, instead of reporting success', async () => {
    const wipe = await controlledWipe();
    await open();
    await confirm();
    wipe.state('blocked');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop waiting' }));
    await screen.findByText('Deleting is not finished');

    await createDeck({ name: 'Left behind' });
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no longer running, but \d+ items are still stored/);
    expect(screen.queryByText(/All StudyVault data was deleted/)).toBeNull();
    expect(wipe.calls).toBe(1);
  });

  it('a pending-delete refusal from the start is a warning with Check again, not an error', async () => {
    const storage = await import('@storage');
    vi.spyOn(storage, 'wipeAllData').mockRejectedValue(
      new storage.WipePendingError('All StudyVault data is being deleted. Try again in a moment.'),
    );
    await open();
    await confirm();
    expect(await screen.findByText('Deleting is not finished')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('a real failure while blocked is still an error with Retry', async () => {
    const wipe = await controlledWipe();
    await open();
    await confirm();
    wipe.state('blocked');
    wipe.fail(new Error('Disk is read-only'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Disk is read-only');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('Waiting for another StudyVault window')).toBeNull();
  });
});

describe('safety', () => {
  it('renders stored host strings as text', async () => {
    const evil = 'https://<img src=x onerror=window.__pwned=1>/*';
    const { container } = await open({
      persistentOrigins: [evil],
      denyList: ['<b>bold</b>.example.com'],
    });
    expect(await screen.findByText('<img src=x onerror=window.__pwned=1>')).toBeTruthy();
    expect(screen.getByText('<b>bold</b>.example.com')).toBeTruthy();
    expect(container.querySelector('img, script, b')).toBeNull();
  });
});

// =============================================================================================
// Navigation, sections and flags
// =============================================================================================

const SECTION_IDS = [
  'site-access',
  'appearance',
  'capture',
  'review',
  'ai',
  'sync',
  'backup',
  'storage',
  'shortcuts',
  'privacy',
  'data',
];

describe('section navigation', () => {
  afterEach(() => window.history.replaceState(null, '', window.location.pathname));

  it('is a named navigation landmark whose links match the sections, in page order', async () => {
    await open();
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(SECTION_IDS.map((id) => `#${id}`));
    // Every link has a target on the page, and each target holds its section's heading.
    for (const id of SECTION_IDS) {
      const target = document.getElementById(id);
      expect(target, `#${id}`).not.toBeNull();
      // A section may still be reading its own data; its heading arrives with it.
      expect((await within(target!).findAllByRole('heading', { level: 2 })).length).toBeGreaterThan(
        0,
      );
    }
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('has one tab stop; arrows, Home and End move focus and the tab stop follows', async () => {
    await open();
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const links = within(nav).getAllByRole('link');
    const stops = () => links.filter((a) => a.getAttribute('tabindex') === '0');
    expect(stops()).toEqual([links[0]]);

    links[0]!.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(links[1]);
    expect(stops()).toEqual([links[1]]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(links.at(-1));
    await userEvent.keyboard('{ArrowDown}'); // wraps
    expect(document.activeElement).toBe(links[0]);
    await userEvent.keyboard('{ArrowUp}'); // wraps back
    expect(document.activeElement).toBe(links.at(-1));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(links[0]);
    expect(stops()).toEqual([links[0]]);
  });

  it('marks the section the address names and scrolls to it once the sections exist', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, '', '#storage');
    await open();
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const current = within(nav)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'location');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['#storage']);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect((scroll.mock.contexts[0] as HTMLElement).id).toBe('storage');
    // The tab stop starts on the current section, not on the first link.
    expect(current[0]!.getAttribute('tabindex')).toBe('0');
  });

  it('ignores a hash that is not a section', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, '', '#javascript:alert(1)');
    await open();
    await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('optional features explain themselves first and run nothing until enabled', () => {
  it('AI: explanation and an unticked box; no provider form, no request, no permission prompt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await open();
    const section = (await screen.findByRole('heading', { name: /AI assistance/ })).closest(
      'section',
    )!;
    expect(section.textContent).toMatch(/While this is off, StudyVault sends nothing anywhere/);
    expect(section.textContent).toMatch(/only the highlights you selected/);
    const box = within(section).getByRole('checkbox', { name: 'Turn on AI features' });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(within(section).queryByLabelText('Provider address')).toBeNull();
    expect(within(section).queryByLabelText('API key')).toBeNull();

    // Turning it on shows the setup but still sends nothing: a request needs Test or Send.
    await userEvent.click(box);
    expect(await within(section).findByLabelText('Provider address')).toBeTruthy();
    expect((await getSettings()).features.ai).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('sync: explanation and sign-in only after the server is named; nothing is asked of Chrome', async () => {
    await open();
    const section = (await screen.findByTestId('sync-section')) as HTMLElement;
    const text = (await within(section).findByTestId('sync-explanation')).textContent ?? '';
    expect(text).toMatch(/off by default/);
    expect(text).toMatch(/There is no StudyVault server/);
    const turnOn = within(section).getByRole('button', { name: /Turn on sync/ });
    expect(turnOn.getAttribute('aria-disabled')).toBe('true'); // needs the acknowledgement first
    expect(within(section).queryByRole('button', { name: /Sign in/ })).toBeNull();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect((await getSettings()).features.sync).toBe(false);
  });
});

describe('review section', () => {
  it('is on by default with the study day settings; off hides them and the quick action', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'Review and study day' })).toBeTruthy();
    const openReview = screen.getByRole('button', { name: 'Open review' });
    expect(openReview.getAttribute('aria-disabled')).toBeNull();

    const toggle = screen.getByRole('checkbox', { name: 'Show review in StudyVault' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);

    await waitFor(async () => expect((await getSettings()).features.review).toBe(false));
    expect(screen.queryByRole('heading', { name: 'Review and study day' })).toBeNull();
    expect(screen.getByText(/Review is off/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open review' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(spoken()).toBe(''); // a switch is not an announcement; nothing leaks into the region
  });

  it('Open review and Open dashboard open their pages in tabs', async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Open review' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const urls = create.mock.calls.map((c) => (c[0] as { url: string }).url);
    expect(urls[0]).toMatch(/\/review\.html\?view=study$/);
    expect(urls[1]).toMatch(/\/dashboard\.html$/);
  });
});

describe('capture and appearance additions', () => {
  it('density and the PDF reader switch persist', async () => {
    await open();
    await userEvent.click(await screen.findByRole('radio', { name: /^Compact/ }));
    await waitFor(async () => expect((await getSettings()).density).toBe('compact'));

    const reader = screen.getByRole('checkbox', { name: 'Use the StudyVault PDF reader' });
    expect((reader as HTMLInputElement).checked).toBe(true);
    expect(reader.getAttribute('aria-describedby')).toBeTruthy();
    await userEvent.click(reader);
    await waitFor(async () => expect((await getSettings()).features.pdfReader).toBe(false));
    // Other flags are left alone by the write.
    expect((await getSettings()).features).toMatchObject({ review: true, ai: false, sync: false });
  });
});

describe('welcome tour', () => {
  it('opens the tour page, and offers to resume one that was left part-way', async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Show the welcome tour' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect((create.mock.calls[0]![0] as { url: string }).url).toMatch(/\/onboarding\.html$/);

    await browser.storage.local.set({
      onboarding: {
        schemaVersion: 1,
        status: 'pending',
        step: 'banks',
        preset: { id: 'blank', excluded: [] },
        applied: null,
        updatedAt: '2026-10-11T10:00:00.000Z',
      },
    });
    expect(await screen.findByRole('button', { name: 'Resume the welcome tour' })).toBeTruthy();
  });
});

// =============================================================================================
// Storage
// =============================================================================================

describe('storage section', () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  const ID_A = 'a'.repeat(64);
  const ID_B = 'b'.repeat(64);

  async function seedPdf(id: string, title: string, bytes: number) {
    await upsertDocument({
      id,
      title,
      pageCount: 3,
      byteLength: bytes,
      originalUrl: null,
      textStatus: 'text',
    });
    await cacheDocumentBytes(id, new Blob([new Uint8Array(bytes).fill(7)]));
  }

  it('shows real counts from the database, and what is stored', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards(
      [1, 2, 3].map((n) => ({
        template: 'basic' as const,
        question: `Q${n}?`,
        answer: `A${n}`,
      })),
      { deckId: deck.id },
    );
    await open();
    const section = (await screen.findByTestId('storage-section')) as HTMLElement;
    const table = await within(section).findByTestId('storage-table');
    const rows = within(table)
      .getAllByRole('row')
      .map((r) => r.textContent ?? '');
    expect(rows.some((r) => /Flashcards\s*3$/.test(r))).toBe(true);
    expect(rows.some((r) => /Flashcard decks\s*1$/.test(r))).toBe(true);
    const total = Number(
      (within(section).getByTestId('storage-total-rows').textContent ?? '').replace(/,/g, ''),
    );
    expect(total).toBeGreaterThanOrEqual(4);
    expect(within(section).getByTestId('no-cached-pdfs').textContent).toBe(
      'No PDF copies are stored.',
    );
  });

  it('lists stored PDF copies with sizes, removes one, then all, and keeps focus somewhere real', async () => {
    await seedPdf(ID_A, 'Cardiac physiology', 2048);
    await seedPdf(ID_B, 'Renal handbook', 4096);
    await open();
    const section = (await screen.findByTestId('storage-section')) as HTMLElement;
    const list = await within(section).findByTestId('cached-pdfs');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.textContent).toContain('Cardiac physiology');
    expect(list.textContent).toContain('2.0 KB');
    await waitFor(() =>
      expect(within(section).getByTestId('storage-pdf-bytes').textContent).toBe('6.0 KB'),
    );

    await userEvent.click(
      within(section).getByRole('button', { name: 'Remove the stored copy of Cardiac physiology' }),
    );
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    await waitFor(() =>
      expect(within(section).getByTestId('storage-pdf-bytes').textContent).toBe('4.0 KB'),
    );
    expect(spoken()).toContain('Removed 1 stored copy of Cardiac physiology.');
    expect(document.activeElement?.tagName).toBe('H3');

    // The PDF record itself (highlights hang off it) is still there.
    expect((await listDocuments()).map((d) => d.document.title).sort()).toEqual([
      'Cardiac physiology',
      'Renal handbook',
    ]);

    await userEvent.click(within(section).getByTestId('clear-all-cache'));
    const dialog = await screen.findByRole('dialog', { name: 'Remove every stored PDF copy?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove the copies' }));
    expect(await within(section).findByTestId('no-cached-pdfs')).toBeTruthy();
    await waitFor(() =>
      expect(within(section).getByTestId('storage-pdf-bytes').textContent).toBe('0 B'),
    );
  });
});

describe('privacy and your data', () => {
  it('lists the optional permissions the manifest declares, apart from the held ones', async () => {
    vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({
      name: 'StudyVault AI',
      version: '0.1.0',
      permissions: ['storage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting'],
      optional_permissions: ['identity', 'alarms'],
    } as never);
    await open();
    const privacy = (await screen.findByText('Permissions this extension holds')).closest(
      'section',
    )!;
    expect(within(privacy).getByText('identity')).toBeTruthy();
    expect(within(privacy).getByText('alarms')).toBeTruthy();
    expect(privacy.textContent).toMatch(/Asked for later, only from a button/);
    expect(privacy.textContent).toMatch(/Access to websites is not among them/);
  });

  it('delete-all lives under Your data, not inside Privacy', async () => {
    await open();
    await screen.findByText(/Everything stays on this device/);
    const data = document.getElementById('data')!;
    expect(within(data).getByRole('button', { name: /^Delete all StudyVault data/ })).toBeTruthy();
    expect(
      within(document.getElementById('privacy')!).queryByRole('button', {
        name: /^Delete all StudyVault data/,
      }),
    ).toBeNull();
  });
});
