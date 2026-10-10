import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_DENY_HOSTS, defaultSettings, type Settings } from '@shared';
import { getSettings } from '@runtime';
import { makeChromeFakes, rpc, store } from '@ui/testing/fakes';
import { Options } from './Options';

vi.mock('@storage', async () => (await import('@ui/testing/fakes')).store.module);
vi.mock('@runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { rpc: fake } = await import('@ui/testing/fakes');
  return { ...actual, callBackground: fake.callBackground, callTab: fake.callTab } as never;
});

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

async function open(settings: Partial<Settings> = {}) {
  await browser.storage.local.set({ settings: { ...defaultSettings(), ...settings } });
  return render(<Options />);
}

beforeEach(() => {
  fakeBrowser.reset();
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
});

describe('site access', () => {
  it('enables all sites: asks Chrome, stores both patterns, syncs, and reflects the state', async () => {
    let rpcCallsAtRequest = -1;
    chrome.permissions.request.mockImplementation(async (p) => {
      rpcCallsAtRequest = rpc.calls.length;
      p.origins?.forEach((o) => granted.add(o));
      return true;
    });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Enable on all sites' }));

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ALL });
    expect(rpcCallsAtRequest).toBe(0);
    await waitFor(async () => {
      expect((await getSettings()).persistentOrigins).toEqual(ALL);
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Revoke all-sites access' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable on all sites' })).toBeNull();
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('calls permissions.request synchronously inside the click (user gesture)', async () => {
    chrome.permissions.request.mockReturnValue(new Promise(() => undefined));
    await open();
    const button = await screen.findByRole('button', { name: 'Enable on all sites' });

    fireEvent.click(button);

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ALL });
  });

  it('declined: explains and changes nothing', async () => {
    chrome.permissions.request.mockResolvedValue(false);
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Enable on all sites' }));

    expect(await screen.findByText(/Chrome did not grant access to all sites/)).toBeTruthy();
    expect((await getSettings()).persistentOrigins).toEqual([]);
    expect(rpc.called('site.sync')).toHaveLength(0);
  });

  it('a Chrome error is shown with its real text and a retry', async () => {
    chrome.permissions.request.mockRejectedValueOnce(
      new Error('Permissions request must be made from a user gesture'),
    );
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Enable on all sites' }));
    expect((await screen.findByRole('alert')).textContent).toContain('user gesture');

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
  });

  it('shows a helpful empty state when no site is enabled', async () => {
    await open();
    expect(await screen.findByText(/None yet\./)).toBeTruthy();
  });
});

describe('deny list', () => {
  it('shows defaults, adds a normalised host and syncs', async () => {
    await open();
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
  });

  it('rejects invalid and duplicate input without changing anything', async () => {
    await open();
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

  it('removes an entry and restores the defaults', async () => {
    await open();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove paypal.com from the deny list' }),
    );
    await waitFor(async () => {
      expect((await getSettings()).denyList).not.toContain('paypal.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(1);
    expect(await screen.findByText(/Missing: paypal.com\./)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Restore default sites' }));
    await waitFor(async () => {
      expect((await getSettings()).denyList).toContain('paypal.com');
    });
    expect(rpc.called('site.sync')).toHaveLength(2);
  });

  it('disables restore with an explanation when nothing is missing', async () => {
    await open();
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

  it('keeps a failed write visible with Retry, then succeeds', async () => {
    await open();
    const radio = await screen.findByRole('radio', { name: /^Light/ });
    vi.spyOn(browser.storage.local, 'set').mockRejectedValueOnce(new Error('Quota exceeded'));
    await userEvent.click(radio);

    expect((await screen.findByRole('alert')).textContent).toContain('Quota exceeded');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(async () => expect((await getSettings()).theme).toBe('light'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
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
