import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
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
  defaultAiSettings,
  listDocuments,
  setAiSettings,
  upsertDocument,
} from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { LOCAL_PREF_KEYS } from '@ui';
import { SETTINGS_SECTIONS } from '@ui/shell/paths';
import { SyncApiProvider, type SyncApi, type SyncStatusView } from '@ui/sync';
import { COMMANDS, makeChromeFakes, rpc, store } from '@ui/testing/fakes';
import { OPTION_SECTIONS } from './model';
import { Options } from './Options';

// The page's own writes (delete all data) go through the in-memory fake, which records them; what
// the review, AI, backup, game and storage sections read is real code over fake-indexeddb.
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

// Every role query in jsdom takes a while on a loaded CI shard; that must not turn into a failure.
// `defaultHidden` skips the per-element visibility walk (jsdom has no layout to consult anyway), and
// lets queries reach the detail behind (i) and closed disclosures, which are in the page.
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

/** Where the address points before the page mounts: a section id, or null for the home. */
const goTo = (section: string | null) =>
  window.history.replaceState(null, '', section ? `#${section}` : window.location.pathname);

/** Open the settings page on one view (each section is its own view: `options.html#<id>`). */
async function open(
  settings: Partial<Settings> = {},
  section: string | null = 'site-access',
  api: SyncApi = syncApi,
) {
  goTo(section);
  await browser.storage.local.set({
    settings: { ...defaultSettings(), denyList: SHORT_DENY, ...settings },
  });
  const view = render(
    <SyncApiProvider value={api}>
      <Options />
    </SyncApiProvider>,
  );
  // The views and the section list render once the settings are read (the loading state has
  // a heading too, but no section list).
  await screen.findByRole('navigation', { name: 'Settings sections' });
  return view;
}

/** Move to another view the way a link does. */
async function navigate(section: string | null) {
  await act(async () => {
    window.location.hash = section ? `#${section}` : '';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

/**
 * What the surface's polite status region (the toast provider's) holds right now. The backup
 * importer keeps a second, private announcer that is empty until an import runs.
 */
const spoken = () => document.querySelector('.sv-toasts__polite')?.textContent ?? '';

/** The text a disclosure (details/summary) holds, found by its summary. */
const disclosure = (summary: string | RegExp) =>
  screen.getByText(summary, { selector: 'summary' }).closest('details') as HTMLElement;

/** The (i) detail of a control: the popover text that describes its button. */
const infoText = (label: string) => {
  const button = screen.getByRole('button', { name: label });
  return document.getElementById(button.getAttribute('aria-describedby')!)?.textContent ?? '';
};

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
afterEach(() => {
  cleanup();
  goTo(null);
});

describe('content', () => {
  it('shows the privacy statement, real permissions and the manifest version', async () => {
    await open({}, 'privacy');
    expect(await screen.findByText(/Everything stays on this device/)).toBeTruthy();
    const perms = disclosure('Permissions this extension holds');
    for (const p of ['storage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting']) {
      expect(within(perms).getByText(p)).toBeTruthy();
    }
    expect(screen.getByText('5 held, more only when you ask.')).toBeTruthy();

    await navigate('about');
    expect(await screen.findByText(/version 0.1.0/)).toBeTruthy();
    expect(screen.getByText('StudyVault AI')).toBeTruthy();
  });

  it('site access shows the three levels as tiles, with the detail behind (i)', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Site access' })).toBeTruthy();
    const levels = screen.getByRole('list', { name: 'Where StudyVault runs' });
    for (const name of ['This tab', 'Your sites', 'All sites']) {
      expect(within(levels).getByText(name)).toBeTruthy();
    }
    expect(infoText('About where it runs')).toMatch(/This tab: .* One site: .* All sites: /);
  });

  it('discloses everything that is stored, including the page context and soft delete', async () => {
    await open({}, 'privacy');
    const text = disclosure('What is stored on this device').textContent ?? '';
    expect(text).toMatch(/up to 64\s+characters of the page text just before it and just after it/);
    expect(text).toMatch(/nearest heading/);
    expect(text).toMatch(/hash and the\s+length of the whole page text/);
    expect(text).toMatch(/where it sits in the\s+page structure/);
    expect(text).toMatch(/without a user name or password/);
    expect(text).toMatch(/page title/);
    expect(text).toMatch(/Deleted highlights stay in the trash on this device/);
    // The finish-wave data (U-20): rules, syllabi, links, exam history, reminder, folder, fallbacks.
    expect(text).toMatch(/auto-filing rules, syllabi and the links you draw between\s+items/);
    expect(text).toMatch(/an exam\s+in progress and your exam history/);
    expect(text).toMatch(/daily study reminder setting/);
    expect(text).toMatch(/reference to the backup folder you chose/);
    expect(text).toMatch(/each AI provider you set \(the main one and any fallbacks\)/);
    expect(text).toMatch(/your API keys kept in the extension's storage/);
    // The game layer (ADR-022) keeps a ledger too.
    expect(text).toMatch(/XP each review, save, new card and finished\s+session earned/);
    const seen = disclosure('What a website can see').textContent ?? '';
    expect(seen).toMatch(/colour and kind/);
    expect(seen).toMatch(/sv-hl-amber-formula/);
  });

  it('has one toast status region; the only other live region is the importer’s, empty at rest', async () => {
    await open({}, 'backup');
    await screen.findByTestId('backup-import-announce');
    const regions = screen.getAllByRole('status');
    expect(document.querySelectorAll('.sv-toasts__polite')).toHaveLength(1);
    const others = regions.filter((r) => !r.classList.contains('sv-toasts__polite'));
    expect(others.map((r) => r.getAttribute('data-testid'))).toEqual(['backup-import-announce']);
    expect(others[0]!.textContent).toBe('');
  });
});

// =============================================================================================
// Site access
// =============================================================================================

/** "Choose sites" opens the wizard; returns it. */
async function openWizard() {
  await userEvent.click(await screen.findByRole('button', { name: 'Choose sites' }));
  return screen.findByRole('dialog', { name: 'Site access' });
}
const next = (wizard: HTMLElement) =>
  userEvent.click(within(wizard).getByRole('button', { name: 'Next' }));

/** Wizard: All sites -> the deny list -> the last step, where "Ask Chrome" is. */
async function toAllSitesQuestion() {
  const wizard = await openWizard();
  await userEvent.click(within(wizard).getByRole('radio', { name: /^All sites/ }));
  await next(wizard);
  await next(wizard);
  return wizard;
}

describe('site access', () => {
  it('enables all sites: shows the effective deny list first, then asks Chrome, stores both patterns, syncs', async () => {
    rpc.background['site.sync'] = () => ({ registeredMatches: ALL });
    let rpcCallsAtRequest = -1;
    chrome.permissions.request.mockImplementation(async (p) => {
      rpcCallsAtRequest = rpc.calls.length;
      p.origins?.forEach((o) => granted.add(o));
      return true;
    });
    // A short list: every role query in jsdom walks all rows, and the step's job is the same.
    const stayOff = ['paypal.com', 'accounts.google.com', 'mail.google.com'];
    await open({ denyList: stayOff });
    const wizard = await openWizard();
    await userEvent.click(within(wizard).getByRole('radio', { name: /^All sites/ }));
    await next(wizard);

    // Nothing is requested yet; the step shows what stays off.
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(within(wizard).getByRole('heading', { name: 'Stay off on' })).toBeTruthy();
    expect(within(wizard).getByText(DENY_LIST_SCOPE_NOTE)).toBeTruthy();
    const list = within(wizard).getByRole('region', { name: 'Sites on your deny list' });
    for (const host of stayOff) expect(within(list).getByText(host)).toBeTruthy();
    expect(within(wizard).getByText(/these 3 sites/)).toBeTruthy();

    await next(wizard);
    expect(within(wizard).getByText('Except 3 on your deny list.')).toBeTruthy();
    await userEvent.click(within(wizard).getByRole('button', { name: 'Ask Chrome' }));

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ALL });
    expect(rpcCallsAtRequest).toBe(0);
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(ALL);
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Revoke all sites' })).toBeTruthy();
    // Chrome's grant is read again after the change: the badge follows that answer.
    await waitFor(() => expect(screen.getByText('On')).toBeTruthy());
    expect(screen.getByText('All set!')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spoken()).toContain('StudyVault is now on for all sites.');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Where it runs' }));
  });

  it('says so when the deny list is empty, before asking', async () => {
    await open({ denyList: [] });
    const wizard = await openWizard();
    await userEvent.click(within(wizard).getByRole('radio', { name: /^All sites/ }));
    await next(wizard);
    expect(await within(wizard).findByText(/Your deny list is empty/)).toBeTruthy();
  });

  it('asks for a choice first, and moves focus to the choices', async () => {
    await open();
    const wizard = await openWizard();
    await next(wizard);
    expect(within(wizard).getByRole('alert').textContent).toContain('Pick one to go on.');
    expect(document.activeElement).toBe(within(wizard).getByRole('radio', { name: /^One site/ }));
    expect(within(wizard).getByRole('heading', { name: 'Where to run' })).toBeTruthy();
  });

  it('closing asks Chrome for nothing and returns focus to the button; with a choice made it asks first', async () => {
    await open();
    const choose = await screen.findByRole('button', { name: 'Choose sites' });
    let wizard = await openWizard();
    await userEvent.click(within(wizard).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(choose);

    wizard = await openWizard();
    await userEvent.click(within(wizard).getByRole('radio', { name: /^All sites/ }));
    await userEvent.keyboard('{Escape}');
    expect(within(wizard).getByRole('heading', { name: 'Discard changes?' })).toBeTruthy();
    await userEvent.click(within(wizard).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(choose);
  });

  it('calls permissions.request synchronously inside the final click (user gesture)', async () => {
    chrome.permissions.request.mockReturnValue(new Promise(() => undefined));
    await open();
    const wizard = await toAllSitesQuestion();
    const ask = within(wizard).getByRole('button', { name: 'Ask Chrome' });

    fireEvent.click(ask);

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ALL });
  });

  it('declined: explains next to the control and changes nothing', async () => {
    chrome.permissions.request.mockResolvedValue(false);
    await open();
    const wizard = await toAllSitesQuestion();
    await userEvent.click(within(wizard).getByRole('button', { name: 'Ask Chrome' }));

    const card = (await screen.findByRole('heading', { name: 'Where it runs' })).closest(
      'section',
    )!;
    expect(await within(card).findByText(/Chrome did not grant access to all sites/)).toBeTruthy();
    expect((await getSettings()).persistentOrigins).toEqual([]);
    expect(rpc.called('site.sync')).toHaveLength(0);
  });

  it('a Chrome error is shown next to the button with its real text and a retry', async () => {
    chrome.permissions.request.mockRejectedValueOnce(
      new Error('Permissions request must be made from a user gesture'),
    );
    await open();
    const wizard = await toAllSitesQuestion();
    await userEvent.click(within(wizard).getByRole('button', { name: 'Ask Chrome' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('user gesture');
    expect(alert.closest('section')?.querySelector('h2')?.textContent).toBe('Where it runs');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Revoke all sites' })).toBeTruthy();
  });

  it('turns on one typed site: refuses a denied one, normalises the address, asks Chrome for exactly that origin', async () => {
    rpc.background['site.sync'] = () => ({ registeredMatches: ['https://example.org/*'] });
    await open();
    const wizard = await openWizard();
    await userEvent.click(within(wizard).getByRole('radio', { name: /^One site/ }));
    await next(wizard);
    const field = within(wizard).getByLabelText('Site address');
    await userEvent.type(field, 'paypal.com');
    await next(wizard);
    expect(within(wizard).getByRole('alert').textContent).toMatch(/on your deny list/);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');

    await userEvent.clear(field);
    await userEvent.type(field, 'HTTPS://Example.org/some/page');
    await next(wizard);
    const sites = within(wizard).getByRole('list', { name: 'Sites to turn on' });
    expect(within(sites).getByText('example.org')).toBeTruthy();
    await userEvent.click(within(wizard).getByRole('button', { name: 'Ask Chrome' }));

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://example.org/*'] });
    await waitFor(async () =>
      expect((await getSettings()).persistentOrigins).toEqual(['https://example.org/*']),
    );
    expect(rpc.called('site.sync')).toHaveLength(1);
    await waitFor(() => expect(spoken()).toContain('StudyVault is now on for example.org.'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your sites' }));
  });

  it('turns on some sites: adds several, drops one, and needs at least one', async () => {
    await open();
    const wizard = await openWizard();
    await userEvent.click(within(wizard).getByRole('radio', { name: /^Some sites/ }));
    await next(wizard);
    await next(wizard);
    expect(within(wizard).getByRole('alert').textContent).toContain('Add at least one site.');

    const field = within(wizard).getByLabelText('Site address');
    for (const site of ['a.example', 'b.example']) {
      await userEvent.type(field, site);
      await userEvent.click(within(wizard).getByRole('button', { name: 'Add' }));
    }
    await userEvent.click(within(wizard).getByRole('button', { name: 'Remove a.example' }));
    await next(wizard);
    const sites = within(wizard).getByRole('list', { name: 'Sites to turn on' });
    expect(
      within(sites)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['b.example']);
    await userEvent.click(within(wizard).getByRole('button', { name: 'Ask Chrome' }));
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://b.example/*'] });
  });

  it('revokes all-sites access and keeps individually enabled sites', async () => {
    ALL.forEach((o) => granted.add(o));
    await open({ persistentOrigins: [...ALL, 'https://example.com/*'] });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke all sites' }));

    expect(chrome.permissions.remove).toHaveBeenCalledWith({ origins: ALL });
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(['https://example.com/*']);
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Revoke all sites' })).toBeNull(),
    );
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
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your sites' }));
  });

  it('shows a friendly empty state when no site is enabled', async () => {
    await open();
    expect(await screen.findByText('No sites yet')).toBeTruthy();
  });
});

// U-9: access Chrome holds for one address (sync, AI, a PDF's site) that no other card lists.
describe('site access: other access', () => {
  const AI = 'https://api.example-ai.com/*';
  const SYNC_SERVER = 'https://sync.example.org/*';
  const SYNC_ISSUER = 'https://login.example.org/*';
  const OTHER = 'https://files.example.net/*';
  const LIST = 'Other access Chrome holds for StudyVault';

  /** Chrome's own list, kept in step with request/remove by `wirePermissions`. */
  function listGrants(...patterns: string[]) {
    patterns.forEach((p) => granted.add(p));
    chrome.permissions.getAll.mockImplementation(async () => ({
      origins: [...granted],
      permissions: [],
    }));
  }
  const syncWith = (serverUrl: string, issuer: string): SyncApi =>
    ({
      ...syncApi,
      status: async () => ({
        ...syncStatus,
        enabled: true,
        config: { serverUrl, issuer, clientId: 'studyvault' },
      }),
    }) as unknown as SyncApi;
  const card = async () => within(await screen.findByTestId('other-access'));

  it('lists only what no other card shows, with the purpose when it can be told', async () => {
    const manifestHost = 'http://127.0.0.1/*';
    vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({
      name: 'StudyVault AI',
      version: '0.1.0',
      host_permissions: [manifestHost],
    } as never);
    await setAiSettings({
      ...defaultAiSettings(),
      provider: 'openai_compatible',
      baseUrl: 'https://api.example-ai.com/v1',
    });
    listGrants(
      'https://example.com/*', // enabled one by one: listed above
      ...ALL, // all sites: its own card
      manifestHost, // part of the manifest
      AI,
      SYNC_SERVER,
      SYNC_ISSUER,
      OTHER,
    );
    await open(
      { persistentOrigins: ['https://example.com/*'] },
      'site-access',
      syncWith('https://sync.example.org/v1', 'https://login.example.org'),
    );

    const list = within(await (await card()).findByRole('list', { name: LIST }));
    await waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(4));
    const rows = list.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows).toEqual([
      expect.stringMatching(/^https:\/\/api\.example-ai\.com.*AI provider.*Revoke/),
      expect.stringMatching(/^https:\/\/files\.example\.net.*Other.*Revoke/),
      expect.stringMatching(/^https:\/\/login\.example\.org.*Sync sign-in provider.*Revoke/),
      expect.stringMatching(/^https:\/\/sync\.example\.org.*Sync server.*Revoke/),
    ]);
    // Each button names the exact origin it removes.
    for (const origin of [
      'https://api.example-ai.com',
      'https://files.example.net',
      'https://login.example.org',
      'https://sync.example.org',
    ]) {
      expect(list.getByRole('button', { name: `Revoke access for ${origin}` })).toBeTruthy();
    }
  });

  it('says so when nothing else is allowed', async () => {
    listGrants('https://example.com/*', ...ALL);
    await open({ persistentOrigins: ['https://example.com/*'] });
    expect(await (await card()).findByText('Nothing else is allowed.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: LIST })).toBeNull();
  });

  it('revokes exactly that origin, says so, and leaves every other grant and the settings alone', async () => {
    listGrants('https://example.com/*', SYNC_SERVER, OTHER);
    await open({ persistentOrigins: ['https://example.com/*'] });
    const other = await (
      await card()
    ).findByRole('button', {
      name: 'Revoke access for https://files.example.net',
    });

    await userEvent.click(other);

    expect(chrome.permissions.remove).toHaveBeenCalledTimes(1);
    expect(chrome.permissions.remove).toHaveBeenCalledWith({ origins: [OTHER] });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Revoke access for https://files.example.net' }),
      ).toBeNull(),
    );
    expect(
      await (await card()).findByRole('button', { name: /Revoke access for https:\/\/sync/ }),
    ).toBeTruthy();
    expect([...granted].sort()).toEqual(['https://example.com/*', SYNC_SERVER].sort());
    expect(spoken()).toContain('Revoked access for https://files.example.net.');
    expect((await getSettings()).persistentOrigins).toEqual(['https://example.com/*']);
    expect(rpc.called('site.sync')).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Other access' }));
  });

  it('reports a grant Chrome keeps, instead of claiming it was revoked', async () => {
    listGrants(OTHER);
    chrome.permissions.remove.mockResolvedValueOnce(false);
    await open();
    await userEvent.click(
      await (
        await card()
      ).findByRole('button', {
        name: 'Revoke access for https://files.example.net',
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /Chrome still holds access for https:\/\/files\.example\.net/,
    );
    expect(spoken()).not.toContain('Revoked access for https://files.example.net');
    expect(
      screen.getByRole('button', { name: 'Revoke access for https://files.example.net' }),
    ).toBeTruthy();
  });

  it('shows the real error when Chrome refuses, with a retry that works', async () => {
    listGrants(OTHER);
    chrome.permissions.remove.mockRejectedValueOnce(
      new Error('Extension is not allowed to do that'),
    );
    await open();
    await userEvent.click(
      await (
        await card()
      ).findByRole('button', {
        name: 'Revoke access for https://files.example.net',
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Extension is not allowed to do that');

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(spoken()).toContain('Revoked access for https://files.example.net.'),
    );
    expect(granted.has(OTHER)).toBe(false);
  });

  it('still lists addresses as "Other" when the worker cannot say what they are for', async () => {
    listGrants(SYNC_SERVER);
    const unreachable = {
      ...syncApi,
      status: async () => {
        throw new Error('StudyVault did not answer in time.');
      },
    } as unknown as SyncApi;
    await open({}, 'site-access', unreachable);
    const item = (
      await (
        await card()
      ).findByRole('button', {
        name: 'Revoke access for https://sync.example.org',
      })
    ).closest('li')!;
    expect(within(item).getByText('Other')).toBeTruthy();
  });
});

// The starter list has ~80 chips and every role query in jsdom walks them: give a loaded box room.
describe('deny list', { timeout: 30_000 }, () => {
  it('keeps the starter sites one click away, adds a normalised host among yours and syncs', async () => {
    await open(withStarterList);
    const starter = await screen.findByRole('list', { name: 'Starter sites' });
    expect(within(starter).getByText(DEFAULT_DENY_HOSTS[0]!)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Sites you added' })).toBeNull();

    await userEvent.type(screen.getByLabelText('Add a site'), 'HTTPS://Bank.Example.com/login');
    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));

    await waitFor(async () => {
      expect((await getSettings()).denyList).toContain('bank.example.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    const mine = await screen.findByRole('list', { name: 'Sites you added' });
    expect(within(mine).getByText('bank.example.com')).toBeTruthy();
    expect((screen.getByLabelText('Add a site') as HTMLInputElement).value).toBe('');
    expect(spoken()).toContain('Added bank.example.com to the deny list.');
  });

  it('states what the starter list covers instead of claiming banks and mail are covered', async () => {
    await open(withStarterList);
    await screen.findByRole('heading', { name: 'Deny list' });
    expect(infoText('About deny list')).toContain(DENY_LIST_SCOPE_NOTE);
    expect(screen.queryByText(/listed by default/)).toBeNull();
  });

  it('rejects invalid and duplicate input without changing anything', async () => {
    await open(withStarterList);
    const input = await screen.findByLabelText('Add a site');
    const add = screen.getByRole('button', { name: 'Add site' });

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
        new RegExp(`${missing} of the ${DEFAULT_DENY_HOSTS.length} starter sites are missing`),
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Your own sites stay/)).toBeTruthy();

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

  it('the all-sites step can add one more site to the deny list without leaving the wizard', async () => {
    await open();
    const wizard = await openWizard();
    await userEvent.click(within(wizard).getByRole('radio', { name: /^All sites/ }));
    await next(wizard);
    await userEvent.type(within(wizard).getByLabelText('Also keep off'), 'my-bank.example');
    await userEvent.click(within(wizard).getByRole('button', { name: 'Add site' }));
    await waitFor(async () =>
      expect((await getSettings()).denyList).toEqual(['paypal.com', 'my-bank.example']),
    );
    expect(await within(wizard).findByText(/these 2 sites/)).toBeTruthy();
  });
});

// =============================================================================================
// Appearance and capture
// =============================================================================================

describe('appearance and capture', () => {
  it('applies the theme immediately and persists it', async () => {
    await open({}, 'appearance');
    await userEvent.click(await screen.findByRole('radio', { name: /^Dark/ }));
    await waitFor(async () => expect((await getSettings()).theme).toBe('dark'));
    // The attribute follows the stored value through an effect: wait for it, do not assume it.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));

    await userEvent.click(screen.getByRole('radio', { name: /^System/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
    expect((await getSettings()).theme).toBe('system');
  });

  it('persists the default kind and a palette colour with a live preview', async () => {
    await open({}, 'appearance');
    await userEvent.click(await screen.findByRole('radio', { name: 'Formula' }));
    await waitFor(async () => expect((await getSettings()).defaultKind).toBe('formula'));

    const exception = screen.getByRole('group', { name: /Exception/ });
    await userEvent.click(within(exception).getByRole('radio', { name: 'Teal' }));
    await waitFor(async () => expect((await getSettings()).palette.exception).toBe('teal'));
    const sample = within(exception.closest('li')!).getByText('Sample text');
    expect(sample.style.background).toContain('rgba(45, 212, 191');
    expect(
      (within(exception).getByRole('radio', { name: 'Teal' }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('toggles the floating toolbar', async () => {
    await open({}, 'capture');
    const box = await screen.findByRole('checkbox', { name: 'Floating toolbar' });
    expect((box as HTMLInputElement).checked).toBe(true);
    await userEvent.click(box);
    await waitFor(async () => expect((await getSettings()).toolbarEnabled).toBe(false));
  });

  it('toggles painting, saying near the switch that sites can read what is painted', async () => {
    await open({}, 'appearance');
    const box = await screen.findByRole('checkbox', { name: 'Show on pages' });
    expect((box as HTMLInputElement).checked).toBe(true);
    const hint = document.getElementById(box.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toMatch(/Sites can see which passages are painted/);
    const detail = infoText('About show on pages');
    expect(detail).toMatch(/scripts that a site itself runs can read/);
    expect(detail).toMatch(/deny list/);

    await userEvent.click(box);
    await waitFor(async () => expect((await getSettings()).paintHighlights).toBe(false));
    // The style choices explain why they are off instead of silently doing nothing.
    const normal = screen.getByRole('radio', { name: /^Normal/ });
    expect(normal.matches(':disabled')).toBe(true);
    expect(screen.getByText(/No effect while highlights are not shown/)).toBeTruthy();
  });

  it('offers automatic, normal and strong highlight style and persists the choice', async () => {
    await open({}, 'appearance');
    const auto = await screen.findByRole('radio', { name: /^Automatic/ });
    expect((auto as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /^Normal/ })).toBeTruthy();
    // One group name for the style cards (not a fieldset legend plus the cards' own legend).
    expect(screen.getByRole('radiogroup', { name: 'Highlight style' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Highlight style' })).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: /^Strong/ }));
    await waitFor(async () => expect((await getSettings()).highlightStyle).toBe('strong'));
  });

  it('draws each kind from KIND_DECORATION: its name, its underline and its colour swatches', async () => {
    await open({}, 'appearance');
    const legend = await screen.findByRole('list', { name: 'Underline for each highlight kind' });
    const rows = within(legend).getAllByRole('listitem');
    expect(rows).toHaveLength(HIGHLIGHT_KINDS.length);
    HIGHLIGHT_KINDS.forEach((kind, i) => {
      const row = rows[i]!;
      const deco = KIND_DECORATION[kind];
      expect(within(row).getByText(KIND_LABELS[kind].label, { exact: false })).toBeTruthy();
      expect(within(row).getByText(deco.label)).toBeTruthy();
      expect(within(row).getAllByRole('radio')).toHaveLength(7);
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
    await open({}, 'capture');
    const box = await screen.findByRole('checkbox', { name: 'Private windows' });
    expect((box as HTMLInputElement).checked).toBe(false);
    const hint = document.getElementById(box.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toMatch(/Saves stay in your normal profile/);
    expect(infoText('About private windows')).toMatch(/stored in your normal Chrome profile/);

    await userEvent.click(box);
    await waitFor(async () => expect((await getSettings()).allowIncognitoCapture).toBe(true));
  });

  it('has a "Filing rules" switch that writes the setting, and opens the rules manager', async () => {
    await open({}, 'capture');
    const box = await screen.findByRole('checkbox', { name: 'Filing rules' });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(infoText('About filing rules')).toMatch(/never overridden/);
    await userEvent.click(box);
    await waitFor(async () => expect((await getSettings()).useFilingRules).toBe(false));

    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await userEvent.click(screen.getByRole('button', { name: 'Manage rules' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]![0]).toMatchObject({
      url: expect.stringMatching(/\/dashboard\.html\?view=rules$/),
    });
  });

  it('keeps a failed write visible next to its control with Retry, then succeeds', async () => {
    await open({}, 'appearance');
    const radio = await screen.findByRole('radio', { name: /^Light/ });
    vi.spyOn(browser.storage.local, 'set').mockRejectedValueOnce(new Error('Quota exceeded'));
    await userEvent.click(radio);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Quota exceeded');
    // In the card that owns the control, not at the top of the page.
    expect(alert.closest('section')?.contains(radio)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(async () => expect((await getSettings()).theme).toBe('light'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('density and the PDF reader switch persist', async () => {
    await open({}, 'appearance');
    await userEvent.click(await screen.findByRole('radio', { name: /^Compact/ }));
    await waitFor(async () => expect((await getSettings()).density).toBe('compact'));

    await navigate('capture');
    const reader = await screen.findByRole('checkbox', { name: 'PDF reader' });
    expect((reader as HTMLInputElement).checked).toBe(true);
    expect(reader.getAttribute('aria-describedby')).toBeTruthy();
    await userEvent.click(reader);
    await waitFor(async () => expect((await getSettings()).features.pdfReader).toBe(false));
    // Other flags are left alone by the write.
    expect((await getSettings()).features).toMatchObject({ review: true, ai: false, sync: false });
  });
});

// =============================================================================================
// Keyboard shortcuts
// =============================================================================================

describe('keyboard shortcuts', () => {
  const section = () => document.getElementById('shortcuts')!;

  it('lists the real bindings from Chrome as key chips, shows "Not set", and the in-page keys', async () => {
    await open({}, 'shortcuts');
    const commands = await within(section()).findByRole('list', { name: 'Browser shortcuts' });
    const rows = within(commands).getAllByRole('listitem');
    expect(rows).toHaveLength(COMMANDS.length);
    for (const c of COMMANDS) {
      const row = within(commands).getByText(c.description).closest('li')!;
      expect(row.textContent).toContain(c.shortcut || 'Not set');
    }
    // Each key is its own chip; the whole combination is read once.
    const save = within(commands).getByText('Open the StudyVault side panel').closest('li')!;
    expect([...save.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Alt',
      'Shift',
      'S',
    ]);
    const inPage = within(section()).getByRole('list', { name: 'In-page shortcuts' });
    expect(within(inPage).getByText('Alt+Shift+]')).toBeTruthy();
    expect(within(inPage).getByText('Alt+Shift+[')).toBeTruthy();
  });

  it('lists the search command, unset because Chrome allows only four suggested keys, and says so', async () => {
    await open({}, 'shortcuts');
    const commands = await within(section()).findByRole('list', { name: 'Browser shortcuts' });
    const row = within(commands)
      .getByText('Search your highlights: open the side panel on the search box')
      .closest('li')!;
    expect(row.textContent).toContain('Not set');
    expect(within(section()).getByTestId('shortcuts-unset-note').textContent).toMatch(
      /only four keys/,
    );
  });

  it('says nothing about unset keys when every command has one', async () => {
    chrome.commands.getAll.mockResolvedValue(
      COMMANDS.map((c) => ({ ...c, shortcut: c.shortcut || 'Alt+Shift+9' })),
    );
    await open({}, 'shortcuts');
    await screen.findByRole('list', { name: 'Browser shortcuts' });
    expect(screen.queryByTestId('shortcuts-unset-note')).toBeNull();
  });

  it('reflects what the user changed in Chrome when the page regains focus', async () => {
    await open({}, 'shortcuts');
    expect(await screen.findByText('Alt+Shift+H')).toBeTruthy();
    chrome.commands.getAll.mockResolvedValue(
      COMMANDS.map((c) => (c.name === 'quick-save' ? { ...c, shortcut: '' } : c)),
    );

    fireEvent.focus(window);

    await waitFor(() => expect(screen.queryByText('Alt+Shift+H')).toBeNull());
  });

  it("opens Chrome's shortcut page in a new tab", async () => {
    const create = vi.spyOn(browser.tabs, 'create');
    await open({}, 'shortcuts');
    await userEvent.click(await screen.findByRole('button', { name: 'Change in Chrome' }));
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
  });

  it('reports a failure to open the page, and a failure to read the commands, with Retry', async () => {
    vi.spyOn(browser.tabs, 'create').mockRejectedValueOnce(new Error('Tabs API unavailable'));
    chrome.commands.getAll.mockRejectedValueOnce(new Error('commands unavailable'));
    await open({}, 'shortcuts');

    expect(await screen.findByText('commands unavailable')).toBeTruthy();
    await userEvent.click(
      within(
        screen.getByText('commands unavailable').closest('[role="alert"]') as HTMLElement,
      ).getByRole('button', { name: 'Retry' }),
    );
    expect(await screen.findByText('Alt+Shift+S')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Change in Chrome' }));
    expect(await screen.findByText('Tabs API unavailable')).toBeTruthy();
  });
});

// =============================================================================================
// Delete all data: what goes -> type the word -> done
// =============================================================================================

/** "Delete all data" opens the guarded flow on its first step. */
async function openDeleteFlow() {
  await userEvent.click(await screen.findByRole('button', { name: 'Delete all data' }));
  return screen.findByRole('dialog', { name: 'Delete all StudyVault data' });
}
/** Through both guards: Next, the word, "Delete everything". */
async function confirmDelete() {
  const flow = await openDeleteFlow();
  await userEvent.click(within(flow).getByRole('button', { name: 'Next' }));
  await userEvent.type(within(flow).getByLabelText(/^Type “delete”$/), 'delete');
  await userEvent.click(within(flow).getByRole('button', { name: 'Delete everything' }));
  return flow;
}

describe('delete all data', () => {
  it('says what is deleted, starts on the step title, and closes without deleting', async () => {
    await open({}, 'data');
    const flow = await openDeleteFlow();
    expect(flow.textContent).toMatch(/including the ones in the trash/);
    expect(flow.textContent).toMatch(/cannot be undone/);
    expect(within(flow).getByRole('list', { name: 'What is deleted' })).toBeTruthy();
    expect(document.activeElement).toBe(within(flow).getByRole('heading', { name: 'What goes' }));

    await userEvent.click(within(flow).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(store.calls.some((c) => c.fn === 'wipeAllData')).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete all data' }));
  });

  it('needs the typed word: anything else deletes nothing and says what to type', async () => {
    await open({}, 'data');
    const flow = await openDeleteFlow();
    await userEvent.click(within(flow).getByRole('button', { name: 'Next' }));
    const field = within(flow).getByLabelText(/^Type “delete”$/);
    await userEvent.type(field, 'remove');
    await userEvent.click(within(flow).getByRole('button', { name: 'Delete everything' }));

    expect(within(flow).getByRole('alert').textContent).toContain('Type delete to go on.');
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(store.calls.some((c) => c.fn === 'wipeAllData')).toBe(false);

    // Back keeps the flow; Escape closes it.
    await userEvent.click(within(flow).getByRole('button', { name: 'Back' }));
    expect(within(flow).getByRole('heading', { name: 'What goes' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('wipes the data, then syncs the worker, then reports on the done step and moves focus', async () => {
    await open({ persistentOrigins: ['https://example.com/*'], theme: 'dark' }, 'data');
    const flow = await confirmDelete();

    await waitFor(() => expect(store.calls.some((c) => c.fn === 'wipeAllData')).toBe(true));
    await waitFor(() => expect(rpc.called('site.sync')).toHaveLength(1));
    expect(
      await within(flow).findByText(/All StudyVault data was deleted from this device/),
    ).toBeTruthy();
    expect(spoken()).toContain('All StudyVault data was deleted.');
    expect(document.activeElement).toBe(within(flow).getByRole('heading', { name: 'Fresh start' }));

    await userEvent.click(within(flow).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Focus goes back to the opener (never <body>).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete all data' }));
    // The report stays in the card once the flow is closed.
    expect(screen.getByText(/All StudyVault data was deleted from this device/)).toBeTruthy();
  });

  it('a storage_unavailable refusal shows its message and no blind Retry', async () => {
    store.failNext.wipeAllData = new StudyVaultError(
      'storage_unavailable',
      'Another StudyVault window is using the data. Close it and try again.',
    );
    await open({}, 'data');
    await confirmDelete();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Another StudyVault window is using the data');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('lists everything it removes, and what it does not', async () => {
    await open({}, 'data');
    const text = (await openDeleteFlow()).textContent ?? '';
    for (const part of [
      /highlight with its note, including the ones in the trash/,
      /banks,\s+folders and tags/,
      /auto-filing rules, your syllabi with their coverage thresholds, and the links/,
      /kept PDF copies/,
      /flashcards and review history, a review session or exam in progress, and your exam\s+history/,
      /your XP, streak and badges, your daily goal and the Game mode setting/,
      /AI drafts, your provider settings and your API key, with any fallback providers/,
      /sync settings, the sign-in[\s\S]*before its last update/,
      /theme, colours, deny list, study reminder/,
      /access Chrome gave\s+StudyVault to\s+websites/,
      /reference to the backup folder you chose and its last-backup status/,
      /auto-filing suggestions still waiting/,
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
    await open({ features: { ...defaultSettings().features, sync: true } }, 'data');
    const flow = await openDeleteFlow();
    expect(flow.textContent).toMatch(/the copy on your sync server/);
    expect(flow.textContent).toMatch(/Delete my data from the server/);
    await userEvent.click(within(flow).getByRole('button', { name: 'Next' }));
    expect(flow.textContent).toMatch(/Delete my data from the\s+server/);
    await userEvent.type(within(flow).getByLabelText(/^Type “delete”$/), 'DELETE');
    await userEvent.click(within(flow).getByRole('button', { name: 'Delete everything' }));
    expect(await screen.findByText(/The copy on your sync server was not touched/)).toBeTruthy();
  });

  it('says what Chrome keeps afterwards: exported files and the server copy stay, its own data page is clean', async () => {
    await open({}, 'data');
    const text = (await openDeleteFlow()).textContent ?? '';
    expect(text).toMatch(/the optional sign-in and timer permissions \(identity, alarms\)/);
    expect(text).toMatch(/display\s+preferences StudyVault pages keep in this browser/);
    expect(text).toMatch(/does not remove files you exported or backed\s+up/);
    expect(text).toMatch(/a copy on a sync server, if you ever used sync: that is separate/);
    expect(text).toMatch(
      /Chrome's own page for this extension's stored data shows no\s+highlights, notes, settings or preferences/,
    );
    // Not a promise of "nothing at all": the new database holds one marker with no study data.
    expect(text).toMatch(/empty apart\s+from one marker that holds no study data/);
  });

  it('"Back up first" closes the flow and opens the backup section', async () => {
    await open({}, 'data');
    const flow = await openDeleteFlow();
    await userEvent.click(within(flow).getByRole('button', { name: 'Back up first' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'Backup' })).toBeTruthy();
    expect(store.calls.some((c) => c.fn === 'wipeAllData')).toBe(false);
  });

  describe('what lives outside the database (U-16)', () => {
    const done = () => screen.findByText(/All StudyVault data was deleted from this device/);
    const hold = (...permissions: string[]) =>
      chrome.permissions.getAll.mockResolvedValue({ origins: [], permissions });

    beforeEach(() => window.localStorage.clear());

    it('removes the display preferences and the optional identity and alarms permissions', async () => {
      for (const key of Object.values(LOCAL_PREF_KEYS)) window.localStorage.setItem(key, 'x');
      window.localStorage.setItem('sv.from-an-older-build', 'x');
      window.localStorage.setItem('someone.elses.key', 'keep');
      hold('storage', 'sidePanel', 'identity', 'alarms');
      await open({}, 'data');
      await confirmDelete();

      const message = await done();
      expect(chrome.permissions.remove).toHaveBeenCalledTimes(1);
      expect(chrome.permissions.remove).toHaveBeenCalledWith({
        permissions: ['identity', 'alarms'],
      });
      expect(window.localStorage.length).toBe(1);
      expect(window.localStorage.getItem('someone.elses.key')).toBe('keep');
      expect(message.textContent).not.toMatch(/could not|did not let/);
    });

    it('asks Chrome for nothing when the optional permissions were never granted', async () => {
      hold('storage');
      await open({}, 'data');
      await confirmDelete();
      await done();
      expect(chrome.permissions.remove).not.toHaveBeenCalled();
    });

    it('names what could not be removed instead of reporting a clean wipe', async () => {
      window.localStorage.setItem(LOCAL_PREF_KEYS.reviewKeys, 'off');
      hold('identity', 'alarms');
      chrome.permissions.remove.mockRejectedValueOnce(
        new Error('You cannot remove required permissions.'),
      );
      await open({}, 'data');
      await confirmDelete();

      const message = (await done()).textContent ?? '';
      expect(message).toMatch(
        /Chrome did not let StudyVault give up its optional sign-in and timer permissions \(identity, alarms\)/,
      );
      // The data itself was still deleted, and the preferences that could be removed went.
      expect(store.calls.some((c) => c.fn === 'wipeAllData')).toBe(true);
      expect(window.localStorage.getItem(LOCAL_PREF_KEYS.reviewKeys)).toBeNull();
    });

    it('says so when the preferences cannot be cleared (storage blocked)', async () => {
      window.localStorage.setItem(LOCAL_PREF_KEYS.dashboardContrast, 'high');
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('The operation is insecure.');
      });
      await open({}, 'data');
      await confirmDelete();
      expect((await done()).textContent).toMatch(
        /display preferences StudyVault keeps in this browser .* could not be cleared/,
      );
    });

    it('removes them on "Check again" too, when the wipe finished while this page was not waiting', async () => {
      window.localStorage.setItem(LOCAL_PREF_KEYS.dashboardCollapsed, '["a"]');
      hold('identity', 'alarms');
      const storage = await import('@storage');
      vi.spyOn(storage, 'wipeAllData').mockRejectedValue(
        new storage.WipePendingError(
          'All StudyVault data is being deleted. Try again in a moment.',
        ),
      );
      await open({}, 'data');
      await confirmDelete();
      await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
      await done();
      expect(window.localStorage.getItem(LOCAL_PREF_KEYS.dashboardCollapsed)).toBeNull();
      expect(chrome.permissions.remove).toHaveBeenCalledWith({
        permissions: ['identity', 'alarms'],
      });
    });
  });

  it('shows the real error and repeats every step on Retry', async () => {
    store.failNext.wipeAllData = new Error('Database is locked by another window');
    await open({}, 'data');
    await confirmDelete();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Database is locked by another window');
    expect(rpc.called('site.sync')).toHaveLength(0); // nothing after the failed step ran
    expect(screen.getByRole('heading', { name: 'Not finished' })).toBeTruthy();

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rpc.called('site.sync')).toHaveLength(1));
    expect(await screen.findByText(/deleted from this device/)).toBeTruthy();
  });
});

describe('delete all data: waiting for another window', () => {
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

  it('blocked: names what to do, says it needs no second click, and finishes by itself', async () => {
    const wipe = await controlledWipe();
    await open({}, 'data');
    await confirmDelete();
    expect(await screen.findByText('Deleting…')).toBeTruthy();

    act(() => wipe.state('blocked'));
    expect(await screen.findByText('Waiting for another StudyVault window')).toBeTruthy();
    expect(
      screen.getByText('Close other StudyVault tabs and side panels. It then finishes by itself.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull(); // waiting is not an error
    // Said through the one polite region (an effect later than the notice itself).
    await waitFor(() => expect(spoken()).toContain('Deleting is held up'));
    expect(rpc.called('site.sync')).toHaveLength(0);

    // The other window closes: the same call finishes, the worker is told, the page reports it.
    act(() => wipe.state('cleaning'));
    expect(await screen.findByText(/Removing the pre-update copy/)).toBeTruthy();
    act(() => wipe.finish());
    expect(
      await screen.findByText(/All StudyVault data was deleted from this device/),
    ).toBeTruthy();
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(screen.queryByText('Waiting for another StudyVault window')).toBeNull();
    expect(wipe.calls).toBe(1);

    // The opener was drawn again while it waited (busy, then not): the card's title takes focus.
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Start over' }));
  });

  it('closing the flow while it waits keeps the status in the card', async () => {
    const wipe = await controlledWipe();
    await open({}, 'data');
    const flow = await confirmDelete();
    act(() => wipe.state('blocked'));
    await within(flow).findByText('Waiting for another StudyVault window');
    // The dialog's own Close comes first; the (i) popover's Close is hidden (jsdom still lists it).
    await userEvent.click(within(flow).getAllByRole('button', { name: 'Close' })[0]!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Waiting for another StudyVault window')).toBeTruthy();
    act(() => wipe.finish());
    expect(
      await screen.findByText(/All StudyVault data was deleted from this device/),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Start over' }));
  });

  it('Stop waiting is a warning, not a failure, and does not claim the deletion was cancelled', async () => {
    const wipe = await controlledWipe();
    await open({}, 'data');
    await confirmDelete();
    act(() => wipe.state('blocked'));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop waiting' }));

    expect(await screen.findByText('Deleting is not finished')).toBeTruthy();
    expect(
      screen.getByText(
        "Stopping does not cancel the deletion: it still finishes when that window closes, and StudyVault here can't read or save until then.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Deleting your data did not finish')).toBeNull();
    await waitFor(() => expect(spoken()).toContain('Deleting is still queued'));
    expect(rpc.called('site.sync')).toHaveLength(0);
    // Not offered again while it is pending.
    expect(
      screen.getByRole('button', { name: 'Delete all data' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('Check again, once the deletion is over, reads the data and finishes the report without deleting again', async () => {
    const wipe = await controlledWipe();
    await open({}, 'data');
    await confirmDelete();
    act(() => wipe.state('blocked'));
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
    await open({}, 'data');
    await confirmDelete();
    act(() => wipe.state('blocked'));
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
    await open({}, 'data');
    await confirmDelete();
    expect(await screen.findByText('Deleting is not finished')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('a real failure while blocked is still an error with Retry', async () => {
    const wipe = await controlledWipe();
    await open({}, 'data');
    await confirmDelete();
    act(() => wipe.state('blocked'));
    act(() => wipe.fail(new Error('Disk is read-only')));
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
// Home, navigation and views
// =============================================================================================

describe('settings home and section views', () => {
  it('the home greets with the two pages people come for and one tile per section, with real status', async () => {
    await open({ theme: 'dark', features: { ...defaultSettings().features, ai: true } }, null);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open dashboard' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open review' })).toBeTruthy();
    const main = document.querySelector('main')!;
    for (const s of OPTION_SECTIONS) {
      expect(main.querySelector(`a.opt-tile[href="#${s.id}"]`), s.id).not.toBeNull();
    }
    expect(within(main).getByRole('link', { name: 'Appearance, Dark theme' })).toBeTruthy();
    expect(within(main).getByRole('link', { name: 'AI, On' })).toBeTruthy();
    expect(within(main).getByRole('link', { name: 'Sync, Off' })).toBeTruthy();
    // No section is mounted on the home.
    for (const s of OPTION_SECTIONS) expect(document.getElementById(s.id)).toBeNull();
  });

  it('is a named navigation landmark: Home, then every section, the deep-link contract included', async () => {
    await open({}, null);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#', ...OPTION_SECTIONS.map((s) => `#${s.id}`)]);
    // The ids other pages link to (`settingsPath`) all still open a section.
    for (const { id } of SETTINGS_SECTIONS) expect(hrefs).toContain(`#${id}`);
  });

  it('each section is its own view, titled by the page heading, and moving there focuses the title', async () => {
    await open({}, null);
    for (const id of ['capture', 'game', 'reminders', 'about']) {
      await navigate(id);
      const label = OPTION_SECTIONS.find((s) => s.id === id)!.label;
      const title = await screen.findByRole('heading', { level: 1, name: label });
      expect(document.getElementById(id)).not.toBeNull();
      expect(document.activeElement).toBe(title);
      expect(document.title).toBe(`${label} · StudyVault AI settings`);
    }
    expect(document.getElementById('capture')).toBeNull();
    await navigate(null);
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
  });

  it('has one tab stop; arrows, Home and End move focus and the tab stop follows', async () => {
    await open({}, null);
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

  it('marks the section the address names, and starts the tab stop there', async () => {
    await open({}, 'storage');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const current = within(nav)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['#storage']);
    expect(current[0]!.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('heading', { level: 1, name: 'Storage' })).toBeTruthy();
    // Opening the page on a section does not move focus by itself.
    expect(document.activeElement).toBe(document.body);
  });

  it('a hash that is not a section opens the home', async () => {
    await open({}, 'javascript:alert(1)');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['#']);
  });
});

describe('optional features run nothing until enabled', () => {
  // What these sections say is tested with them (packages/ui/src/ai, sync); here: the view mounts
  // them and opening it sends nothing and asks Chrome for nothing.
  it('AI: the view shows the switch off, and opening it makes no request and no permission prompt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await open({}, 'ai');
    const box = await within(document.getElementById('ai')!).findByRole('checkbox', {
      name: 'Turn on AI features',
    });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('heading', { level: 1, name: 'AI' })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('sync: the view shows the sync section, and opening it asks Chrome for nothing', async () => {
    await open({}, 'sync');
    expect(
      await within(document.getElementById('sync')!).findByTestId('sync-section'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Sync' })).toBeTruthy();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect((await getSettings()).features.sync).toBe(false);
  });
});

describe('review section', () => {
  it('is on by default with the study day settings; off hides them and the quick action', async () => {
    await open({}, null);
    const openReview = await screen.findByRole('button', { name: 'Open review' });
    expect(openReview.getAttribute('aria-disabled')).toBeNull();

    await navigate('review');
    expect(await screen.findByTestId('rv-settings-section')).toBeTruthy();
    const toggle = screen.getByRole('checkbox', { name: 'Show review' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);

    await waitFor(async () => expect((await getSettings()).features.review).toBe(false));
    expect(screen.queryByTestId('rv-settings-section')).toBeNull();
    expect(screen.getByText('Review is off')).toBeTruthy();
    expect(spoken()).toBe(''); // a switch is not an announcement; nothing leaks into the region

    await navigate(null);
    expect(
      (await screen.findByRole('button', { name: 'Open review' })).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('Open review and Open dashboard open their pages in tabs', async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    await open({}, null);
    await userEvent.click(await screen.findByRole('button', { name: 'Open review' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const urls = create.mock.calls.map((c) => (c[0] as { url: string }).url);
    expect(urls[0]).toMatch(/\/review\.html\?view=study$/);
    expect(urls[1]).toMatch(/\/dashboard\.html$/);
  });
});

describe('welcome tour', () => {
  it('opens the tour page from About, and offers to resume one that was left part-way', async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    await open({}, 'about');
    await userEvent.click(await screen.findByRole('button', { name: 'Welcome tour' }));
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
    expect(await screen.findByRole('button', { name: 'Resume tour' })).toBeTruthy();
  });
});

// =============================================================================================
// Game (ADR-022)
// =============================================================================================

describe('game section', () => {
  const ring = () => screen.findByRole('img', { name: /^Daily goal: \d+ of \d+ XP/ });

  it('shows today, the streak and the level from the ledger, with the goal as picture cards', async () => {
    await open({}, 'game');
    expect((await ring()).getAttribute('aria-label')).toMatch(/^Daily goal: 0 of 30 XP/);
    expect(screen.getByText('day streak')).toBeTruthy();
    const freezes = screen.getByRole('img', { name: '0 of 2 streak freezes' });
    expect(freezes.textContent).toBe('0/2'); // written, so held vs empty is never colour alone
    expect(screen.getByRole('progressbar', { name: 'Level 1 progress' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: /^Regular/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    const earn = screen.getByRole('list', { name: 'How you earn XP' });
    expect(earn.textContent).toMatch(/Review \+1.*Save \+2.*New card \+3.*Session \+5/);
  });

  it('choosing a goal writes it, the ring follows the ledger, and it is said once', async () => {
    await open({}, 'game');
    await ring();
    await userEvent.click(screen.getByRole('radio', { name: /^Serious/ }));
    await waitFor(async () =>
      expect((await ring()).getAttribute('aria-label')).toMatch(/of 50 XP/),
    );
    expect((screen.getByRole('radio', { name: /^Serious/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    await waitFor(() => expect(spoken()).toContain('Daily goal: 50 XP.'));
  });

  it('a goal that cannot be saved goes back and says why, with Retry', async () => {
    const storage = await import('@storage');
    vi.spyOn(storage, 'setDailyGoal').mockRejectedValueOnce(new Error('The disk is full.'));
    await open({}, 'game');
    await ring();
    await userEvent.click(screen.getByRole('radio', { name: /^Intense/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The disk is full.');
    expect((screen.getByRole('radio', { name: /^Regular/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(async () =>
      expect((await ring()).getAttribute('aria-label')).toMatch(/of 100 XP/),
    );
  });

  it('Game mode off hides XP, the ring, streak and level, keeps plain counts, and the tile says Off', async () => {
    await open({}, 'game');
    await ring();
    const mode = screen.getByRole('checkbox', { name: 'Game mode' });
    expect((mode as HTMLInputElement).checked).toBe(true);
    await userEvent.click(mode);

    await waitFor(() => expect(screen.queryByRole('img', { name: /^Daily goal:/ })).toBeNull());
    expect(screen.queryByText('day streak')).toBeNull();
    expect(screen.queryByRole('progressbar', { name: /^Level/ })).toBeNull();
    // The goal cards and the "Earn XP" chips are XP too.
    expect(screen.queryByRole('radio', { name: /^Regular/ })).toBeNull();
    expect(screen.queryByRole('list', { name: 'How you earn XP' })).toBeNull();
    const today = screen.getByRole('list', { name: 'Today so far' });
    expect(today.textContent).toMatch(/0\s*reviewed/);
    expect((screen.getByRole('checkbox', { name: 'Game mode' }) as HTMLInputElement).checked).toBe(
      false,
    );

    await navigate(null);
    expect(await screen.findByRole('link', { name: 'Game, Off' })).toBeTruthy();
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
    await open({}, 'storage');
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
    await open({}, 'storage');
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
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Stored PDF copies' }));

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
    await open({}, 'privacy');
    const perms = disclosure('Permissions this extension holds');
    expect(within(perms).getByText('identity')).toBeTruthy();
    expect(within(perms).getByText('alarms')).toBeTruthy();
    expect(perms.textContent).toMatch(/Asked for later, only from a button/);
    expect(perms.textContent).toMatch(/Access to websites is not among them/);
  });

  it('delete-all lives under Your data, not inside Privacy', async () => {
    await open({}, 'data');
    const data = document.getElementById('data')!;
    expect(within(data).getByRole('button', { name: 'Delete all data' })).toBeTruthy();
    await navigate('privacy');
    await screen.findByText(/Everything stays on this device/);
    expect(
      within(document.getElementById('privacy')!).queryByRole('button', {
        name: /Delete all/,
      }),
    ).toBeNull();
  });
});
