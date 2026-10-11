import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConflictRecord, QuarantinedOp } from '@sync';
import { ConflictsPanel } from './ConflictsPanel';
import { SyncApiProvider, type SyncApi } from './api';
import { assessPassphrase } from './passphrase';
import type { SyncStatusView } from './protocol';
import { QuarantinePanel } from './QuarantinePanel';
import { SyncSection, validateSyncInput } from './SyncSection';

afterEach(cleanup);

// The few matchers of @testing-library/jest-dom these tests use (not a dependency of the project).
expect.extend({
  toHaveTextContent(received: Element, expected: string | RegExp) {
    const text = (received.textContent ?? '').replace(/\s+/g, ' ').trim();
    const pass = typeof expected === 'string' ? text.includes(expected) : expected.test(text);
    return {
      pass,
      message: () =>
        `expected text ${JSON.stringify(text)} ${pass ? 'not ' : ''}to match ${String(expected)}`,
    };
  },
  toBeInTheDocument(received: Element | null) {
    const pass = received !== null && received.isConnected;
    return { pass, message: () => `expected element ${pass ? 'not ' : ''}to be in the document` };
  },
  toHaveValue(received: HTMLInputElement, expected: string) {
    return {
      pass: received.value === expected,
      message: () =>
        `expected value ${JSON.stringify(received.value)} to be ${JSON.stringify(expected)}`,
    };
  },
});
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toHaveTextContent(expected: string | RegExp): R;
    toBeInTheDocument(): R;
    toHaveValue(expected: string): R;
    /** Present so the type parameter is used. */
    readonly __domMatchers?: T;
  }
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

function view(over: Partial<SyncStatusView> = {}): SyncStatusView {
  return {
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
    ...over,
  };
}

const ON = {
  enabled: true,
  config: {
    serverUrl: 'https://sync.example.org',
    issuer: 'https://id.example.org',
    clientId: 'studyvault',
  },
  status: 'idle' as const,
};

function fakeApi(initial: SyncStatusView, extra: Partial<SyncApi> = {}) {
  const calls: string[] = [];
  let current = initial;
  let listener: ((v: SyncStatusView) => void) | null = null;
  const set = (patch: Partial<SyncStatusView>) => {
    current = { ...current, ...patch };
    return current;
  };
  const conflicts: ConflictRecord[] = [];
  const quarantine: QuarantinedOp[] = [];
  const api: SyncApi = {
    status: async () => current,
    onStatusChanged(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    configure: vi.fn(async (input) => {
      calls.push('configure');
      return set({ config: input });
    }),
    enable: vi.fn(async () => {
      calls.push('enable');
      return set({ enabled: true, status: 'auth_required' });
    }),
    disable: vi.fn(async () => {
      calls.push('disable');
      return set({ enabled: false, status: 'disabled', signedIn: false });
    }),
    signIn: vi.fn(async () => {
      calls.push('signIn');
      return {
        status: set({ signedIn: true, account: 'user-1', status: 'idle' }),
        needsOrigins: [],
      };
    }),
    signOut: vi.fn(async () => {
      calls.push('signOut');
      return set({ signedIn: false, account: null, status: 'auth_required' });
    }),
    syncNow: vi.fn(async () => {
      calls.push('syncNow');
      return set({ lastSyncAt: 1_700_000_000_000, pending: 0 });
    }),
    uploadPlain: vi.fn(async () => {
      calls.push('uploadPlain');
      return set({ encryptionChoice: 'plaintext', status: 'idle' });
    }),
    e2eeSetup: vi.fn(async () => {
      calls.push('e2eeSetup');
      return set({ e2ee: { mode: 'unlocked', version: 1, lockInSeconds: 900 } });
    }),
    e2eeUnlock: vi.fn(async () => ({ ok: true, reason: null })),
    e2eeLock: vi.fn(async () => set({ e2ee: { mode: 'locked', version: 1, lockInSeconds: null } })),
    e2eeRotate: vi.fn(async () => ({ ok: true, reason: null })),
    resolveConflict: vi.fn(async (id) => {
      calls.push('resolve');
      const at = conflicts.findIndex((c) => c.id === id);
      if (at >= 0) conflicts.splice(at, 1);
    }),
    retryQuarantine: vi.fn(async () => ({ retried: 1, remaining: quarantine.length })),
    discardQuarantined: vi.fn(async (id) => {
      const at = quarantine.findIndex((q) => q.id === id);
      if (at >= 0) quarantine.splice(at, 1);
    }),
    deleteServerData: vi.fn(async () => {
      calls.push('deleteServerData');
      return current;
    }),
    reupload: vi.fn(async () => {
      calls.push('reupload');
      return set({ status: 'idle' });
    }),
    rebind: vi.fn(async () => {
      calls.push('rebind');
      return set({ status: 'idle' });
    }),
    listConflicts: async () => [...conflicts],
    listQuarantine: async () => [...quarantine],
    requestPermissions: vi.fn(async () => {
      calls.push('requestPermissions');
      return true;
    }),
    ...extra,
  };
  return {
    api,
    calls,
    conflicts,
    quarantine,
    publish: (patch: Partial<SyncStatusView>) => listener?.(set(patch)),
  };
}

function mount(fake: ReturnType<typeof fakeApi>) {
  return render(
    <SyncApiProvider value={fake.api}>
      <SyncSection />
    </SyncApiProvider>,
  );
}

const byId = (id: string) => screen.getByTestId(id);

function conflict(over: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: 'notes:note-1:body:text_edit:000000001.0000.client-b',
    entityType: 'notes',
    entityId: 'note-1',
    field: 'body',
    kind: 'text_edit',
    local: { value: 'Mine: the original plus my sentence', hlc: '000000001.0000.client-a' },
    remote: { value: 'Theirs: the original plus another', hlc: '000000002.0000.client-b' },
    base: 'The original',
    detectedAt: 1_700_000_000_000,
    resolution: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------

describe('passphrase strength', () => {
  it('rejects short, common and repetitive passphrases and accepts long unrelated words', () => {
    expect(assessPassphrase('short')).toMatchObject({ score: 0, acceptable: false });
    expect(assessPassphrase('password1234!!')).toMatchObject({ acceptable: false });
    expect(assessPassphrase('aaaaaaaaaaaaaaaa').acceptable).toBe(false);
    expect(assessPassphrase('qwertyuiopasdfgh').acceptable).toBe(false);
    const words = assessPassphrase('correct horse battery staple');
    expect(words.acceptable).toBe(true);
    expect(words.score).toBeGreaterThanOrEqual(3);
    expect(assessPassphrase('Tr0ub4dor&3 purple Giraffe lamp 91!').label).toBe('Strong');
  });

  it('is deterministic and never throws on odd input', () => {
    expect(assessPassphrase('\u{1F600}'.repeat(14))).toEqual(
      assessPassphrase('\u{1F600}'.repeat(14)),
    );
    expect(() => assessPassphrase('\u0000'.repeat(20))).not.toThrow();
  });
});

describe('address validation', () => {
  it('accepts https and loopback http, and says what is wrong otherwise', () => {
    expect(
      validateSyncInput({
        serverUrl: 'https://s.example.org',
        issuer: 'https://i.example.org',
        clientId: 'c',
      }),
    ).toMatchObject({ ok: true, origins: ['https://s.example.org/*', 'https://i.example.org/*'] });
    expect(
      validateSyncInput({
        serverUrl: 'http://localhost:8787',
        issuer: 'https://i.example.org',
        clientId: 'c',
      }),
    ).toMatchObject({ ok: true });
    const bad = validateSyncInput({
      serverUrl: 'http://s.example.org',
      issuer: 'ftp://x',
      clientId: ' ',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(['clientId', 'issuer', 'serverUrl']);
      expect(bad.errors.serverUrl).toMatch(/https/);
    }
  });
});

describe('turning sync on', () => {
  it('explains where the data goes, honestly, before anything else', async () => {
    const fake = fakeApi(view());
    mount(fake);
    const text = (await screen.findByTestId('sync-explanation')).textContent ?? '';
    expect(text).toMatch(/off by default/);
    expect(text).toMatch(/no StudyVault server/i);
    expect(text).toMatch(/operator of that server can read/i);
    expect(text).toMatch(/not end-to-end\s+encryption/i);
    expect(text).toMatch(/never sent/i);
    expect(byId('sync-redirect-url').textContent).toMatch(/chromiumapp\.org/);
  });

  it('lists what is uploaded from the sync policy, including what used to be left out', async () => {
    const fake = fakeApi(view());
    mount(fake);
    const list = (await screen.findByTestId('sync-data-list')).textContent ?? '';
    for (const wanted of [
      /Highlights/,
      /address and title of the page/i,
      /Banks, folders and tags/,
      /Notes/,
      /Flashcards/,
      /Review history/,
      /every answer you gave/i,
      /PDF details/,
      /web address it was opened from/i,
      /Text recognised in scanned PDF pages/,
      /position of every word/i,
    ]) {
      expect(list).toMatch(wanted);
    }
    // and says what stays here, what the server still sees under encryption, and the provider
    expect(byId('sync-never-sent').textContent).toMatch(/PDF files themselves/);
    expect(byId('sync-server-sees').textContent).toMatch(/kinds of items/);
    expect(byId('sync-server-sees').textContent).toMatch(/fingerprint and the page number/);
    expect(byId('sync-provider-learns').textContent).toMatch(/learns that this extension signs in/);
  });

  it('cannot be turned on without the acknowledgement, and says why', async () => {
    const fake = fakeApi(view());
    mount(fake);
    const button = await screen.findByTestId('sync-enable');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toMatch(/understand where your data will go/);
    await userEvent.click(button);
    expect(fake.api.requestPermissions).not.toHaveBeenCalled();
  });

  it('validates the addresses before Chrome is asked for anything', async () => {
    const fake = fakeApi(view());
    mount(fake);
    await userEvent.type(await screen.findByTestId('sync-server-url'), 'http://remote.example.org');
    await userEvent.type(byId('sync-issuer'), 'https://id.example.org');
    await userEvent.type(byId('sync-client-id'), 'studyvault');
    await userEvent.click(byId('sync-ack'));
    await userEvent.click(byId('sync-enable'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/https/);
    expect(fake.api.requestPermissions).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('asks Chrome first (from the click), then saves the settings and turns sync on', async () => {
    const fake = fakeApi(view());
    mount(fake);
    await userEvent.type(await screen.findByTestId('sync-server-url'), 'https://sync.example.org');
    await userEvent.type(byId('sync-issuer'), 'https://id.example.org');
    await userEvent.type(byId('sync-client-id'), 'studyvault');
    await userEvent.click(byId('sync-ack'));
    await userEvent.click(byId('sync-enable'));
    await waitFor(() => expect(fake.calls).toEqual(['requestPermissions', 'configure', 'enable']));
    expect(fake.api.requestPermissions).toHaveBeenCalledWith({
      permissions: ['identity', 'alarms'],
      origins: ['https://sync.example.org/*', 'https://id.example.org/*'],
    });
    // and the page now shows the connected view
    expect(await screen.findByTestId('sync-connected')).toBeInTheDocument();
  });

  it('says it is waiting while the Chrome prompt is open and does not ask twice', async () => {
    let answer!: (granted: boolean) => void;
    const prompt = new Promise<boolean>((resolve) => (answer = resolve));
    const requestPermissions = vi.fn(() => prompt);
    const fake = fakeApi(view(), { requestPermissions });
    mount(fake);
    await userEvent.type(await screen.findByTestId('sync-server-url'), 'https://sync.example.org');
    await userEvent.type(byId('sync-issuer'), 'https://id.example.org');
    await userEvent.type(byId('sync-client-id'), 'studyvault');
    await userEvent.click(byId('sync-ack'));
    const enable = byId('sync-enable');
    expect(screen.queryByTestId('sync-enable-status')).toBeNull();
    await userEvent.click(enable);

    expect(enable.getAttribute('aria-busy')).toBe('true');
    expect(byId('sync-enable-status').textContent).toMatch(/Turning on sync/);
    await userEvent.click(enable); // busy: ignored
    expect(requestPermissions).toHaveBeenCalledTimes(1);

    answer(false);
    await waitFor(() => expect(enable.getAttribute('aria-busy')).toBeNull());
    expect(screen.queryByTestId('sync-enable-status')).toBeNull();
    expect(await screen.findByText(/did not grant the permissions/)).toBeInTheDocument();
  });

  it('a declined prompt changes nothing', async () => {
    const fake = fakeApi(view(), { requestPermissions: vi.fn(async () => false) });
    mount(fake);
    await userEvent.type(await screen.findByTestId('sync-server-url'), 'https://sync.example.org');
    await userEvent.type(byId('sync-issuer'), 'https://id.example.org');
    await userEvent.type(byId('sync-client-id'), 'studyvault');
    await userEvent.click(byId('sync-ack'));
    await userEvent.click(byId('sync-enable'));
    expect(await screen.findByText(/did not grant the permissions/)).toBeInTheDocument();
    expect(fake.api.configure).not.toHaveBeenCalled();
    expect(fake.api.enable).not.toHaveBeenCalled();
  });
});

describe('connected', () => {
  it('signs in, asking Chrome for origins from a click when the worker needs them', async () => {
    const fake = fakeApi(view(ON));
    let first = true;
    fake.api.signIn = vi.fn(async () => {
      fake.calls.push('signIn');
      if (first) {
        first = false;
        return { status: view(ON), needsOrigins: ['https://id.example.org/*'] };
      }
      return {
        status: view({ ...ON, signedIn: true, account: 'user-1' }),
        needsOrigins: [],
      };
    });
    mount(fake);
    await userEvent.click(await screen.findByTestId('sync-sign-in'));
    const allow = await screen.findByTestId('sync-allow-origins');
    expect(allow).toHaveTextContent('https://id.example.org/*');
    await userEvent.click(allow);
    await waitFor(() => expect(fake.calls).toEqual(['signIn', 'requestPermissions', 'signIn']));
    expect(fake.api.requestPermissions).toHaveBeenCalledWith({
      origins: ['https://id.example.org/*'],
    });
    expect(await screen.findByTestId('sync-account')).toHaveTextContent('Signed in as user-1');
  });

  it('shows what happened, syncs on request and reports the waiting changes', async () => {
    const fake = fakeApi(
      view({ ...ON, signedIn: true, account: 'user-1', pending: 3, lastSyncAt: null }),
    );
    mount(fake);
    expect(await screen.findByTestId('sync-status')).toHaveTextContent('Up to date.');
    expect(byId('sync-pending')).toHaveTextContent('3 changes waiting to upload');
    expect(byId('sync-last-sync')).toHaveTextContent('never');
    await userEvent.click(byId('sync-now'));
    await waitFor(() => expect(fake.calls).toContain('syncNow'));
    await waitFor(() => expect(byId('sync-pending')).toHaveTextContent('nothing waiting'));
  });

  it('follows status snapshots published by the worker', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true, account: 'user-1' }));
    mount(fake);
    await screen.findByTestId('sync-status');
    fake.publish({ status: 'offline' });
    await waitFor(() => expect(byId('sync-status')).toHaveTextContent(/cannot be reached/));
    fake.publish({ running: true });
    await waitFor(() => expect(byId('sync-status')).toHaveTextContent('Syncing'));
  });

  it('disables Sync now with its reason while locked', async () => {
    const fake = fakeApi(
      view({
        ...ON,
        signedIn: true,
        account: 'user-1',
        status: 'locked',
        e2ee: { mode: 'locked', version: 1, lockInSeconds: null },
      }),
    );
    mount(fake);
    const button = await screen.findByTestId('sync-now');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toMatch(/Unlock encryption/);
  });

  it('says when there is no background timer and which data types are not synchronised yet', async () => {
    const fake = fakeApi(
      view({ ...ON, signedIn: true, scheduling: 'while-awake', notSynced: ['cards', 'decks'] }),
    );
    mount(fake);
    expect(await screen.findByTestId('sync-scheduling-note')).toHaveTextContent(/timer permission/);
    expect(byId('sync-not-synced')).toHaveTextContent('cards, decks');
  });

  it('shows a start-up problem instead of pretending everything is fine', async () => {
    const fake = fakeApi(
      view({
        ...ON,
        signedIn: true,
        problem: 'The sync policy no longer matches the table schemas',
      }),
    );
    mount(fake);
    expect(await screen.findByText(/Sync cannot start/)).toBeInTheDocument();
    expect(screen.getByText(/no longer matches/)).toBeInTheDocument();
  });

  it('sign-out keeps local data by default and needs a typed confirmation to remove it', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true, account: 'user-1' }));
    mount(fake);
    await userEvent.click(await screen.findByTestId('sync-sign-out'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(fake.api.signOut).toHaveBeenCalledWith({
        wipeLocalData: false,
        revokeAtProvider: true,
      }),
    );
    await waitFor(() => expect(byId('sync-note')).toHaveTextContent(/stays on this device/));

    // the destructive choice
    fake.publish({ signedIn: true, account: 'user-1', status: 'idle' });
    await userEvent.click(await screen.findByTestId('sync-sign-out'));
    const again = await screen.findByRole('dialog');
    await userEvent.click(within(again).getByTestId('sync-signout-wipe'));
    await userEvent.click(within(again).getByRole('button', { name: 'Sign out and remove data' }));
    expect(await within(again).findByRole('alert')).toHaveTextContent(/Type the word delete/);
    expect(fake.api.signOut).toHaveBeenCalledTimes(1);
    await userEvent.type(within(again).getByTestId('sync-signout-typed'), 'delete');
    await userEvent.click(within(again).getByRole('button', { name: 'Sign out and remove data' }));
    await waitFor(() =>
      expect(fake.api.signOut).toHaveBeenLastCalledWith({
        wipeLocalData: true,
        revokeAtProvider: true,
      }),
    );
  });

  it('deleting the server data needs a typed confirmation, and says what it does not touch', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true, account: 'user-1' }));
    mount(fake);
    await userEvent.click(await screen.findByTestId('sync-delete-server-data'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Data on this device is not\s+touched/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete from the server' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(fake.api.deleteServerData).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByTestId('sync-delete-confirm-input'), 'delete');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete from the server' }));
    await waitFor(() => expect(fake.api.deleteServerData).toHaveBeenCalledTimes(1));
  });

  it('offers recovery when the server lost the data, and when the account differs', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true, status: 'resync_required' }));
    mount(fake);
    await userEvent.click(await screen.findByTestId('sync-reupload'));
    await waitFor(() => expect(fake.calls).toContain('reupload'));
    cleanup();

    const other = fakeApi(view({ ...ON, signedIn: true, status: 'account_mismatch' }));
    mount(other);
    await userEvent.click(await screen.findByTestId('sync-rebind'));
    const dialog = await screen.findByRole('dialog');
    expect(other.api.rebind).not.toHaveBeenCalled(); // asked first
    await userEvent.click(within(dialog).getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(other.calls).toContain('rebind'));
  });

  it('turning sync off goes back to the setup view', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true }));
    mount(fake);
    await userEvent.click(await screen.findByTestId('sync-disable'));
    expect(await screen.findByTestId('sync-setup')).toBeInTheDocument();
    expect(fake.calls).toContain('disable');
  });
});

describe('end-to-end encryption card', () => {
  it('needs a strong, repeated passphrase and the "lost means lost" acknowledgement', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true, account: 'user-1' }));
    mount(fake);
    const setup = await screen.findByTestId('e2ee-setup');
    expect(byId('e2ee-mode')).toHaveTextContent(/not end-to-end encryption/i);
    expect(screen.getByText(/lost passphrase means lost synced data/i)).toBeInTheDocument();
    expect(setup.getAttribute('title')).toMatch(/stronger passphrase/);

    await userEvent.type(byId('e2ee-passphrase'), 'correct horse battery staple');
    expect(byId('e2ee-strength')).toHaveTextContent(/Good|Strong|Fair/);
    expect(setup.getAttribute('title')).toMatch(/not the same/);
    await userEvent.type(byId('e2ee-confirm'), 'correct horse battery staple');
    expect(setup.getAttribute('title')).toMatch(/lost passphrase cannot be recovered/);
    await userEvent.click(byId('e2ee-lost-ack'));
    expect(setup.getAttribute('title')).toBeNull();

    await userEvent.click(setup);
    await waitFor(() =>
      expect(fake.api.e2eeSetup).toHaveBeenCalledWith('correct horse battery staple'),
    );
    expect(await screen.findByTestId('e2ee-lock')).toBeInTheDocument();
  });

  it('refuses a weak passphrase before sending anything', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true }));
    mount(fake);
    await userEvent.type(await screen.findByTestId('e2ee-passphrase'), 'password1234');
    await userEvent.type(byId('e2ee-confirm'), 'password1234');
    await userEvent.click(byId('e2ee-lost-ack'));
    await userEvent.click(byId('e2ee-setup'));
    expect(fake.api.e2eeSetup).not.toHaveBeenCalled();
  });

  it('unlocks with the passphrase and reports a wrong one without changing anything', async () => {
    const fake = fakeApi(
      view({
        ...ON,
        signedIn: true,
        status: 'locked',
        e2ee: { mode: 'locked', version: 2, lockInSeconds: null },
      }),
      { e2eeUnlock: vi.fn(async () => ({ ok: false, reason: 'wrong_passphrase' as const })) },
    );
    mount(fake);
    await userEvent.type(
      await screen.findByTestId('e2ee-unlock-passphrase'),
      'nope nope nope nope',
    );
    await userEvent.click(byId('e2ee-unlock'));
    expect(await screen.findByTestId('e2ee-message')).toHaveTextContent(/does not match/);
    // the passphrase field keeps what was typed so a typo can be fixed
    expect(byId('e2ee-unlock-passphrase')).toHaveValue('nope nope nope nope');
  });

  it('the unlocked state shows the time left and can lock now', async () => {
    const fake = fakeApi(
      view({
        ...ON,
        signedIn: true,
        e2ee: { mode: 'unlocked', version: 1, lockInSeconds: 600 },
      }),
    );
    mount(fake);
    expect(await screen.findByTestId('e2ee-mode')).toHaveTextContent(/about 10 minute/);
    await userEvent.click(byId('e2ee-lock'));
    await waitFor(() => expect(fake.api.e2eeLock).toHaveBeenCalled());
    expect(await screen.findByTestId('e2ee-unlock')).toBeInTheDocument();
  });
});

describe('the encryption decision', () => {
  const WAITING = {
    ...ON,
    signedIn: true,
    account: 'user-1',
    status: 'awaiting_encryption_choice' as const,
    encryptionChoice: 'undecided' as const,
    pending: 12,
  };

  it('says nothing was uploaded, and what each choice means, before anything else', async () => {
    const fake = fakeApi(view(WAITING));
    mount(fake);
    expect(await screen.findByTestId('sync-awaiting-choice')).toHaveTextContent(
      /has not sent anything yet/,
    );
    expect(byId('sync-status')).toHaveTextContent(/Nothing has been uploaded yet/);
    const note = byId('e2ee-choice-note');
    expect(note).toHaveTextContent(/does not send anything until you choose/);
    expect(note).toHaveTextContent(/operator of the sync server/);
    expect(note).toHaveTextContent(/not end-to-end encryption/);
    expect(note).toHaveTextContent(/review history/);
    expect(note).toHaveTextContent(/page addresses and titles/);
    expect(note).toHaveTextContent(/scanned-page text/);
  });

  it('"Sync now" is disabled with its reason, so it cannot look like an upload', async () => {
    const fake = fakeApi(view(WAITING));
    mount(fake);
    const button = await screen.findByTestId('sync-now');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toMatch(/Choose how your data is protected first/);
  });

  it('uploading without encryption needs the acknowledgement, and then does exactly that', async () => {
    const fake = fakeApi(view(WAITING));
    mount(fake);
    const upload = await screen.findByTestId('e2ee-upload-plain');
    expect(upload).toHaveTextContent('Upload without end-to-end encryption');
    expect(upload.getAttribute('aria-disabled')).toBe('true');
    expect(upload.getAttribute('title')).toMatch(/operator of the server can read/);
    await userEvent.click(upload);
    expect(fake.api.uploadPlain).not.toHaveBeenCalled();

    await userEvent.click(byId('e2ee-plain-ack'));
    await userEvent.click(upload);
    await waitFor(() => expect(fake.api.uploadPlain).toHaveBeenCalledTimes(1));
    // decided: the choice block is gone and the mode line states the consequence
    await waitFor(() => expect(screen.queryByTestId('e2ee-plain-choice')).toBeNull());
    await waitFor(() =>
      expect(byId('e2ee-mode')).toHaveTextContent(/chose to upload without end-to-end encryption/),
    );
  });

  it('setting a passphrase is the other way out, and is offered right there', async () => {
    const fake = fakeApi(view(WAITING));
    mount(fake);
    await userEvent.type(
      await screen.findByTestId('e2ee-passphrase'),
      'correct horse battery staple',
    );
    await userEvent.type(byId('e2ee-confirm'), 'correct horse battery staple');
    await userEvent.click(byId('e2ee-lost-ack'));
    await userEvent.click(byId('e2ee-setup'));
    await waitFor(() =>
      expect(fake.api.e2eeSetup).toHaveBeenCalledWith('correct horse battery staple'),
    );
    expect(fake.api.uploadPlain).not.toHaveBeenCalled();
  });

  it('is not offered once decided, and is never offered on an encrypted account', async () => {
    const decided = fakeApi(view({ ...WAITING, status: 'idle', encryptionChoice: 'plaintext' }));
    mount(decided);
    await screen.findByTestId('e2ee-section');
    expect(screen.queryByTestId('e2ee-plain-choice')).toBeNull();
    expect(screen.queryByTestId('sync-awaiting-choice')).toBeNull();
    cleanup();

    const encrypted = fakeApi(
      view({
        ...WAITING,
        status: 'locked',
        encryptionChoice: 'e2ee',
        e2ee: { mode: 'locked', version: 1, lockInSeconds: null },
      }),
    );
    mount(encrypted);
    await screen.findByTestId('e2ee-unlock');
    expect(screen.queryByTestId('e2ee-upload-plain')).toBeNull();
  });
});

describe('what the card says about the lock and about AI', () => {
  it('says that AI use of decrypted text needs a separate consent', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true }));
    mount(fake);
    const note = await screen.findByTestId('e2ee-ai-note');
    expect(note).toHaveTextContent(/decrypted on this device/);
    expect(note).toHaveTextContent(/separate consent/);
    expect(note).toHaveTextContent(/does not cover what you choose to send to an AI provider/);
  });

  it('explains what locked means and what happens at the lock time', async () => {
    const unlocked = fakeApi(
      view({
        ...ON,
        signedIn: true,
        encryptionChoice: 'e2ee',
        e2ee: { mode: 'unlocked', version: 1, lockInSeconds: 900 },
      }),
    );
    mount(unlocked);
    const text = (await screen.findByTestId('e2ee-mode')).textContent ?? '';
    expect(text).toMatch(/about 15 minute/);
    expect(text).toMatch(/background syncing pauses/);
    expect(text).toMatch(/dropped when the browser or the extension restarts/);
    cleanup();

    const locked = fakeApi(
      view({
        ...ON,
        signedIn: true,
        encryptionChoice: 'e2ee',
        status: 'locked',
        e2ee: { mode: 'locked', version: 1, lockInSeconds: null },
      }),
    );
    mount(locked);
    expect(await screen.findByTestId('e2ee-mode')).toHaveTextContent(
      /key is not held here right now/,
    );
  });

  it('shows the downgrade warning and what was set aside', async () => {
    const fake = fakeApi(
      view({
        ...ON,
        signedIn: true,
        status: 'error',
        encryptionChoice: 'e2ee',
        e2ee: {
          mode: 'unlocked',
          version: 2,
          lockInSeconds: 120,
          warning: 'The server now reports no encryption key. Nothing was uploaded.',
          setAside: 3,
        },
      }),
    );
    mount(fake);
    expect(await screen.findByTestId('e2ee-warning')).toHaveTextContent(/Nothing was uploaded/);
    expect(byId('e2ee-set-aside')).toHaveTextContent(
      /3 stored items on the server could not be proven/,
    );
  });

  it('tells the person what setting up encryption could not vouch for', async () => {
    const fake = fakeApi(view({ ...ON, signedIn: true, account: 'user-1' }), {
      e2eeSetup: vi.fn(async () =>
        view({
          ...ON,
          signedIn: true,
          e2ee: { mode: 'unlocked', version: 1, lockInSeconds: 900, setAside: 2 },
        }),
      ),
    });
    mount(fake);
    await userEvent.type(
      await screen.findByTestId('e2ee-passphrase'),
      'correct horse battery staple',
    );
    await userEvent.type(byId('e2ee-confirm'), 'correct horse battery staple');
    await userEvent.click(byId('e2ee-lost-ack'));
    await userEvent.click(byId('e2ee-setup'));
    expect(await screen.findByTestId('e2ee-message')).toHaveTextContent(
      /2 stored items on the server could not be proven to come from your devices/,
    );
  });
});

describe('conflicts', () => {
  function mountPanel(fake: ReturnType<typeof fakeApi>) {
    return render(
      <SyncApiProvider value={fake.api}>
        <ConflictsPanel />
      </SyncApiProvider>,
    );
  }

  it('shows both versions and the original side by side, as text', async () => {
    const fake = fakeApi(view(ON));
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    fake.conflicts.push(conflict({ remote: { value: hostile, hlc: '000000002.0000.client-b' } }));
    mountPanel(fake);
    const item = await screen.findByTestId(`conflict-${fake.conflicts[0]!.id}`);
    expect(within(item).getByTestId('conflict-local-text')).toHaveTextContent(
      'Mine: the original plus my sentence',
    );
    expect(within(item).getByTestId('conflict-remote-text').textContent).toBe(hostile);
    expect(within(item).getByTestId('conflict-base-text')).toHaveTextContent('The original');
    expect(item.querySelector('img, script')).toBeNull(); // text, never markup
    expect(item).toHaveTextContent(/nothing has been thrown away/);
    expect(item).toHaveTextContent(/currently shows the other device/);
  });

  it('keep mine / keep theirs / merge by hand each resolve with the right decision', async () => {
    const fake = fakeApi(view(ON));
    for (const n of [1, 2, 3]) {
      fake.conflicts.push(conflict({ id: `c-${n}`, entityId: `note-${n}` }));
    }
    mountPanel(fake);
    const first = await screen.findByTestId('conflict-c-1');
    await userEvent.click(within(first).getByTestId('conflict-keep-local'));
    await waitFor(() =>
      expect(fake.api.resolveConflict).toHaveBeenCalledWith('c-1', { choice: 'local' }),
    );
    await waitFor(() => expect(screen.queryByTestId('conflict-c-1')).toBeNull());

    const second = screen.getByTestId('conflict-c-2');
    await userEvent.click(within(second).getByTestId('conflict-keep-remote'));
    await waitFor(() =>
      expect(fake.api.resolveConflict).toHaveBeenCalledWith('c-2', { choice: 'remote' }),
    );

    const third = await screen.findByTestId('conflict-c-3');
    await userEvent.click(within(third).getByTestId('conflict-edit'));
    const box = within(third).getByTestId('conflict-merge-text');
    await userEvent.clear(box);
    await userEvent.type(box, 'Both sentences together');
    await userEvent.click(within(third).getByTestId('conflict-save-merge'));
    await waitFor(() =>
      expect(fake.api.resolveConflict).toHaveBeenCalledWith('c-3', {
        choice: 'custom',
        value: 'Both sentences together',
      }),
    );
    expect(await screen.findByText('No conflicts')).toBeInTheDocument();
  });

  it('a deletion against an edit offers restore or leave deleted, keeping the snapshot visible', async () => {
    const fake = fakeApi(view(ON));
    fake.conflicts.push(
      conflict({
        id: 'del-1',
        field: null,
        kind: 'deleted_remotely',
        local: { value: { id: 'note-1', title: 'My title', body: 'My unsent edit' }, hlc: null },
        remote: { value: null, hlc: '000000009.0000.client-b' },
        base: null,
      }),
    );
    mountPanel(fake);
    const item = await screen.findByTestId('conflict-del-1');
    expect(within(item).getByTestId('conflict-local-text')).toHaveTextContent('My unsent edit');
    await userEvent.click(within(item).getByTestId('conflict-restore'));
    await waitFor(() =>
      expect(fake.api.resolveConflict).toHaveBeenCalledWith('del-1', { choice: 'restore' }),
    );
  });

  it('only text can be merged by hand: the option is disabled with its reason for other values', async () => {
    const fake = fakeApi(view(ON));
    fake.conflicts.push(
      conflict({
        id: 'obj-1',
        field: 'settings',
        entityType: 'decks',
        local: { value: { newPerDay: 10 }, hlc: '000000001.0000.client-a' },
        remote: { value: { newPerDay: 30 }, hlc: '000000002.0000.client-b' },
        base: null,
      }),
    );
    mountPanel(fake);
    const edit = await within(await screen.findByTestId('conflict-obj-1')).findByTestId(
      'conflict-edit',
    );
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    expect(edit.getAttribute('title')).toMatch(/Only text can be merged/);
  });

  it('reports a failed decision and keeps the conflict', async () => {
    const fake = fakeApi(view(ON), {
      resolveConflict: vi.fn(async () => {
        throw new Error('The conflict could not be resolved.');
      }),
    });
    fake.conflicts.push(conflict({ id: 'bad-1' }));
    mountPanel(fake);
    const item = await screen.findByTestId('conflict-bad-1');
    await userEvent.click(within(item).getByTestId('conflict-keep-local'));
    expect(await within(item).findByRole('alert')).toHaveTextContent(/could not be resolved/);
    expect(screen.getByTestId('conflict-bad-1')).toBeInTheDocument();
  });
});

describe('quarantine', () => {
  const op = (over: Partial<QuarantinedOp> = {}): QuarantinedOp => ({
    id: 'q-1',
    entityType: 'highlights',
    entityId: 'hl-1',
    reason: 'immutable_field',
    detail: 'exactQuote differs',
    at: 1_700_000_000_000,
    op: null,
    ...over,
  });

  function mountPanel(fake: ReturnType<typeof fakeApi>) {
    return render(
      <SyncApiProvider value={fake.api}>
        <QuarantinePanel />
      </SyncApiProvider>,
    );
  }

  it('lists what was refused with the reason in plain words', async () => {
    const fake = fakeApi(view(ON));
    fake.quarantine.push(
      op(),
      op({
        id: 'q-2',
        reason: 'unknown_field',
        entityType: 'cards',
        detail: 'Field x is not known',
      }),
      op({ id: 'local:notes:n-1', reason: 'invalid_op', entityType: 'notes' }),
    );
    mountPanel(fake);
    const first = await screen.findByTestId('quarantine-item-q-1');
    expect(first).toHaveTextContent(/protected source text/);
    expect(first).toHaveTextContent('From the server');
    expect(screen.getByTestId('quarantine-item-q-2')).toHaveTextContent(
      /newer|does not understand/,
    );
    expect(screen.getByTestId('quarantine-item-local:notes:n-1')).toHaveTextContent(
      'Kept on this device only',
    );
  });

  it('retries what may work later, and dismisses single items', async () => {
    const fake = fakeApi(view(ON));
    fake.quarantine.push(op({ id: 'q-9', reason: 'locked' }), op({ id: 'q-8' }));
    mountPanel(fake);
    await userEvent.click(await screen.findByTestId('quarantine-retry'));
    await waitFor(() => expect(fake.api.retryQuarantine).toHaveBeenCalled());
    const item = await screen.findByTestId('quarantine-item-q-8');
    await userEvent.click(within(item).getByTestId('quarantine-dismiss'));
    await waitFor(() => expect(fake.api.discardQuarantined).toHaveBeenCalledWith('q-8'));
    await waitFor(() => expect(screen.queryByTestId('quarantine-item-q-8')).toBeNull());
  });

  it('retry is disabled with its reason when nothing can succeed', async () => {
    const fake = fakeApi(view(ON));
    fake.quarantine.push(op());
    mountPanel(fake);
    const retry = await screen.findByTestId('quarantine-retry');
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    expect(retry.getAttribute('title')).toMatch(/None of these can succeed/);
  });

  it('shows an empty state', async () => {
    const fake = fakeApi(view(ON));
    mountPanel(fake);
    expect(await screen.findByText('Nothing was refused')).toBeInTheDocument();
  });
});
