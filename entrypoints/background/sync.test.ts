// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { webcrypto } from 'node:crypto';
import type { SyncRuntime } from '@storage';
import type { SyncReport } from '@sync';
import {
  ALARM_LOCK,
  ALARM_PERIODIC,
  ALARM_SOON,
  PERIODIC_MINUTES,
  browserSyncDeps,
  createSessionBinding,
  createSessionKeyVault,
  createSessionTokenStore,
  createSyncService,
  registerSync,
  registerSyncRpc,
  type SyncService,
  type SyncServiceDeps,
} from './sync';
import {
  fakeAlarms,
  fakeProvider,
  memoryDeps,
  type FakeAlarms,
  type FakeProvider,
} from './sync.testkit';

const ISSUER = 'https://id.example.org';
const SERVER = 'https://sync.example.org';
const CLIENT = 'studyvault-extension';
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/sync';

/** A runtime that records what the service asked of it. */
function stubRuntime() {
  const calls: string[] = [];
  const state = {
    v: 1 as const,
    clientId: 'client-stub-0001',
    accountId: null,
    cursor: null,
    epoch: null,
    pending: 3,
    lastSyncAt: null as number | null,
    status: 'idle' as const,
    lastError: null,
    backoff: { attempt: 0, nextAttemptAt: null as number | null },
    hlc: { wall: 0, counter: 0 },
    needsResync: false,
  };
  const report: SyncReport = {
    status: 'idle',
    pulled: 0,
    applied: 0,
    conflicts: 0,
    quarantined: 0,
    pushed: 0,
    pending: 0,
    more: false,
    error: null,
    retryAt: null,
  };
  const runtime = {
    clientId: state.clientId,
    active: { notSynced: ['cards'], tables: [], policy: {} },
    startCapture: () => calls.push('startCapture'),
    stopCapture: () => calls.push('stopCapture'),
    reconcile: async () => {
      calls.push('reconcile');
      return { created: 1, changed: 0, deleted: 0, incomplete: false };
    },
    isDirty: async () => false,
    isCurrent: async () => true,
    resendAll: vi.fn(async () => ({ queued: 0 })),
    rebind: async () => ({ created: 0, changed: 0, deleted: 0, incomplete: false }),
    log: { pending: async () => [], replace: async () => undefined },
    store: {
      listQuarantined: async () => [],
      deleteQuarantined: async () => undefined,
      putQuarantined: vi.fn(async () => undefined),
      listTombstones: async () => [],
    },
    engine: {
      auditHistory: vi.fn(async () => ({ ops: [], accepted: new Set<string>(), unreadable: 0 })),
      recordLocalChange: vi.fn(async () => null),
      getState: async () => state,
      sync: vi.fn(async () => {
        calls.push('sync');
        return { ...report };
      }),
      prune: async () => ({ tombstones: 0, sentOps: 0, conflicts: 0, orphans: 0 }),
      retryQuarantined: async () => ({ ...report }),
      resolveConflict: vi.fn(async () => undefined),
      acknowledgeServerReset: async () => undefined,
    },
  };
  return {
    runtime: runtime as unknown as SyncRuntime,
    calls,
    state,
    report,
    engine: runtime.engine,
  };
}

interface Harness {
  service: SyncService;
  deps: SyncServiceDeps;
  mem: ReturnType<typeof memoryDeps>;
  provider: FakeProvider;
  alarms: FakeAlarms;
  stub: ReturnType<typeof stubRuntime>;
  fetched: string[];
  createRuntime: ReturnType<typeof vi.fn>;
  timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
}

function harness(
  over: {
    initial?: { sync?: boolean };
    alarms?: FakeAlarms | null;
    identity?: boolean;
    /** The sync server: everything that is not the identity provider. */
    server?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const fetched: string[] = [];
  const passthrough: typeof fetch = async (input, init) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return over.server ? over.server(input, init) : new Response('{}', { status: 200 });
  };
  const provider = fakeProvider({
    issuer: ISSUER,
    clientId: CLIENT,
    accessToken: 'access-token-0123456789abcdef',
    subject: 'user-1',
    redirectUrl: REDIRECT,
    now: () => Date.now(),
    passthrough,
  });
  const alarms = over.alarms === undefined ? fakeAlarms() : over.alarms;
  const mem = memoryDeps({
    issuer: ISSUER,
    provider,
    redirectUrl: REDIRECT,
    alarms,
    initial: { sync: over.initial?.sync ?? false },
    ...(over.now ? { now: over.now } : {}),
  });
  const stub = stubRuntime();
  const createRuntime = vi.fn(async () => stub.runtime);
  const timers: Harness['timers'] = [];
  const deps: SyncServiceDeps = {
    ...mem.base,
    ...(over.identity === false ? { identity: null } : {}),
    fetch: provider.fetch,
    crypto: webcrypto as unknown as Crypto,
    notifyDataChanged: vi.fn(async () => undefined),
    attention: async () => ({ conflicts: 0, quarantined: 0 }),
    createRuntime: createRuntime as never,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  return {
    service: createSyncService(deps),
    deps,
    mem,
    provider,
    alarms: alarms as FakeAlarms,
    stub,
    fetched,
    createRuntime,
    timers,
  } satisfies Harness;
}

const grantAll = (h: Harness) => {
  h.mem.granted.origins.add(`${SERVER}/*`);
  h.mem.granted.origins.add(`${ISSUER}/*`);
};
const configure = (h: Harness) =>
  h.service.configure({ serverUrl: SERVER, issuer: ISSUER, clientId: CLIENT });

beforeEach(() => {
  fakeBrowser.reset();
});

// ---------------------------------------------------------------------------------------------

describe('with the flag off', () => {
  it('reads nothing from the database, fetches nothing, schedules nothing', async () => {
    const h = harness({ initial: { sync: false } });
    await configure(h); // the user may prepare settings; that is local storage only
    h.createRuntime.mockClear();
    h.alarms.scheduled.clear();

    await h.service.onStartup();
    await h.service.onLocalChange();
    await h.service.onAlarm(ALARM_PERIODIC);
    await h.service.onAlarm(ALARM_SOON);
    const view = await h.service.runSync('test');
    await h.service.settled();

    expect(h.createRuntime).not.toHaveBeenCalled();
    expect(h.fetched).toEqual([]);
    expect(h.provider.requests).toEqual([]);
    expect(h.alarms.scheduled.size).toBe(0);
    expect(h.timers).toEqual([]);
    expect(view).toMatchObject({ enabled: false, status: 'disabled' });
  });

  it('removes a leftover alarm instead of running', async () => {
    const h = harness({ initial: { sync: false } });
    await h.alarms.create(ALARM_PERIODIC, { delayInMinutes: 1, periodInMinutes: 1 });
    await h.service.onAlarm(ALARM_PERIODIC);
    expect(h.alarms.names()).toEqual([]);
    expect(h.createRuntime).not.toHaveBeenCalled();
  });
});

describe('configuration', () => {
  it('stores a normalised server and issuer and nothing secret', async () => {
    const h = harness();
    const view = await h.service.configure({
      serverUrl: ` ${SERVER}/ `,
      issuer: `${ISSUER}/`,
      clientId: CLIENT,
    });
    expect(view.config).toEqual({ serverUrl: SERVER, issuer: ISSUER, clientId: CLIENT });
    expect(JSON.stringify(h.mem.config)).not.toMatch(/token|secret|password/i);
  });

  it.each([
    ['plain http to a remote host', 'http://sync.example.org', ISSUER],
    ['credentials in the address', 'https://user:pw@sync.example.org', ISSUER],
    ['a query string', 'https://sync.example.org/?token=1', ISSUER],
    ['a javascript: address', 'javascript:alert(1)', ISSUER],
    ['an insecure issuer', SERVER, 'http://id.example.org'],
  ])('refuses %s', async (_label, serverUrl, issuer) => {
    const h = harness();
    await expect(
      h.service.configure({ serverUrl, issuer, clientId: CLIENT }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(h.mem.config).toBeNull();
  });

  it('accepts plain http for localhost only (development)', async () => {
    const h = harness();
    const view = await h.service.configure({
      serverUrl: 'http://localhost:8787',
      issuer: ISSUER,
      clientId: CLIENT,
    });
    expect(view.config?.serverUrl).toBe('http://localhost:8787');
  });

  it('changing the server forgets the tokens issued for the old one', async () => {
    const h = harness({ initial: { sync: true } });
    await configure(h);
    await h.mem.tokens.save({
      accessToken: 'old-token-0123456789',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 1000,
      refreshToken: null,
      idToken: null,
      scope: null,
      subject: 'user-1',
    });
    await configure(h); // identical: tokens stay
    expect(await h.mem.tokens.load()).not.toBeNull();
    await h.service.configure({
      serverUrl: 'https://other.example.org',
      issuer: ISSUER,
      clientId: CLIENT,
    });
    expect(await h.mem.tokens.load()).toBeNull();
  });

  it('reports which origins Chrome has not been asked for yet', async () => {
    const h = harness();
    const view = await configure(h);
    expect(view.permissions.missingOrigins.sort()).toEqual([`${ISSUER}/*`, `${SERVER}/*`].sort());
    grantAll(h);
    expect((await h.service.status()).permissions.missingOrigins).toEqual([]);
  });
});

describe('enabling', () => {
  it('needs a server first', async () => {
    const h = harness();
    await expect(h.service.enable()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(h.mem.settings.features.sync).toBe(false);
  });

  it('turns the flag on, starts recording, records what exists, and schedules the periodic run', async () => {
    const h = harness();
    await configure(h);
    const view = await h.service.enable();
    await h.service.settled();
    expect(h.mem.settings.features.sync).toBe(true);
    expect(view.enabled).toBe(true);
    expect(h.stub.calls.slice(0, 2)).toEqual(['startCapture', 'reconcile']);
    expect(h.alarms.scheduled.get(ALARM_PERIODIC)).toEqual({
      delayInMinutes: PERIODIC_MINUTES,
      periodInMinutes: PERIODIC_MINUTES,
    });
    // not signed in yet: nothing was sent anywhere
    expect(h.fetched).toEqual([]);
    expect(view.status).toBe('auth_required');
    expect(view.scheduling).toBe('alarms');
  });

  it('says so when there is no alarms permission: runs happen while the worker is awake', async () => {
    const h = harness({ alarms: null });
    await configure(h);
    const view = await h.service.enable();
    expect(view.scheduling).toBe('while-awake');
  });

  it('disabling removes the schedule, the tokens and the key, and stops recording', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    await h.mem.tokens.save({
      accessToken: 'token-0123456789abcdef',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 1000,
      refreshToken: null,
      idToken: null,
      scope: null,
      subject: 'user-1',
    });
    const view = await h.service.disable();
    expect(view.enabled).toBe(false);
    expect(h.alarms.names()).toEqual([]);
    expect(await h.mem.tokens.load()).toBeNull();
    expect(h.stub.calls).toContain('stopCapture');
  });
});

describe('signing in', () => {
  it('asks for the missing origins first, then completes the PKCE flow and keeps tokens in the session store only', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    const first = await h.service.signIn();
    expect(first.needsOrigins.sort()).toEqual([`${ISSUER}/*`, `${SERVER}/*`].sort());
    expect(h.provider.signIns).toBe(0);

    grantAll(h);
    const done = await h.service.signIn();
    await h.service.settled();
    expect(done.needsOrigins).toEqual([]);
    expect(done.status.signedIn).toBe(true);
    expect(done.status.account).toBe('user-1');
    expect(h.provider.signIns).toBe(1);
    // discovery, then the code exchange with the verifier
    expect(h.provider.requests).toEqual(
      expect.arrayContaining(['GET /.well-known/openid-configuration', 'POST /token']),
    );
    expect((await h.mem.tokens.load())?.subject).toBe('user-1');
    // and the first run was started for the user
    expect(h.stub.engine.sync).toHaveBeenCalled();
  });

  it('refuses without the identity permission instead of failing obscurely', async () => {
    const h = harness({ identity: false });
    await configure(h);
    await h.service.enable();
    grantAll(h);
    await expect(h.service.signIn()).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringMatching(/identity/),
    });
  });

  it('a window the user closed is an error with a message, and no tokens', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    grantAll(h);
    vi.spyOn(h.provider.identity, 'launchWebAuthFlow').mockRejectedValue(
      new Error('The user did not approve access.'),
    );
    await expect(h.service.signIn()).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringMatching(/did not approve/),
    });
    expect(await h.mem.tokens.load()).toBeNull();
  });

  it('rejects a response that belongs to another request', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    grantAll(h);
    vi.spyOn(h.provider.identity, 'launchWebAuthFlow').mockImplementation(async () => {
      return `${REDIRECT}?code=stolen&state=not-the-state`;
    });
    await expect(h.service.signIn()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await h.mem.tokens.load()).toBeNull();
  });

  it('sign-out clears the tokens, asks the provider to revoke, and keeps local data by default', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    grantAll(h);
    await h.service.signIn();
    await h.service.settled();

    const view = await h.service.signOut({ wipeLocalData: false, revokeAtProvider: true });
    expect(view.signedIn).toBe(false);
    expect(await h.mem.tokens.load()).toBeNull();
    expect(h.provider.requests).toContain('POST /revoke');
    expect(h.mem.wipes).toBe(0);

    await h.service.signIn();
    await h.service.settled();
    await h.service.signOut({ wipeLocalData: true, revokeAtProvider: false });
    expect(h.mem.wipes).toBe(1);
    expect(await h.mem.tokens.load()).toBeNull();
  });
});

describe('scheduling and single flight', () => {
  it('local changes ask for at most one extra alarm, however many arrive', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    await h.service.settled();
    h.alarms.scheduled.delete(ALARM_SOON);
    h.timers.length = 0;
    for (let i = 0; i < 25; i++) await h.service.onLocalChange();
    expect(h.alarms.names().filter((n) => n === ALARM_SOON)).toHaveLength(1);
    // each change restarts the short quiet-period timer; only the last one is live
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it('a timer firing runs one sync; an alarm of the right name runs one sync', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    await h.service.settled();
    const before = h.stub.engine.sync.mock.calls.length;
    await h.service.onAlarm(ALARM_PERIODIC);
    expect(h.stub.engine.sync.mock.calls.length).toBe(before + 1);
    await h.service.onAlarm('someone-elses-alarm');
    expect(h.stub.engine.sync.mock.calls.length).toBe(before + 1);
  });

  it('creates a new runtime when a restore gave the database a new sync identity', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    await h.service.settled();
    expect(h.createRuntime).toHaveBeenCalledTimes(1);

    // the database now holds another client id than the cached runtime was created with
    vi.spyOn(h.stub.runtime, 'isCurrent').mockResolvedValueOnce(false);
    await h.service.onAlarm(ALARM_PERIODIC);

    expect(h.createRuntime).toHaveBeenCalledTimes(2);
    await h.service.onAlarm(ALARM_PERIODIC); // current again: no further runtime
    expect(h.createRuntime).toHaveBeenCalledTimes(2);
  });

  it('does not start a second run while one holds the lock', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    await h.service.settled();
    let held = false;
    const calls: number[] = [];
    h.deps.exclusive = async (fn) => {
      if (held) return null;
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
      }
    };
    const service = createSyncService(h.deps);
    let release!: () => void;
    h.stub.engine.sync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          calls.push(1);
          release = () =>
            resolve({
              status: 'idle',
              pulled: 0,
              applied: 0,
              conflicts: 0,
              quarantined: 0,
              pushed: 0,
              pending: 0,
              more: false,
              error: null,
              retryAt: null,
            });
        }),
    );
    const first = service.runSync('a');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await service.runSync('b'); // returns immediately, does not queue a second engine run
    expect(h.stub.engine.sync.mock.calls.length).toBeGreaterThan(0);
    release();
    await first;
    expect(calls).toHaveLength(1);
  });

  it('a backoff asks for a wake-up at the retry time instead of spinning', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    await h.service.settled();
    h.alarms.scheduled.delete(ALARM_SOON);
    h.stub.engine.sync.mockResolvedValueOnce({
      status: 'offline',
      pulled: 0,
      applied: 0,
      conflicts: 0,
      quarantined: 0,
      pushed: 0,
      pending: 4,
      more: false,
      error: { code: 'network', message: 'offline' },
      retryAt: Date.now() + 5 * 60_000,
    });
    await h.service.runSync('test');
    const alarm = h.alarms.scheduled.get(ALARM_SOON);
    expect(alarm?.delayInMinutes).toBeGreaterThan(4);
    expect(alarm?.delayInMinutes).toBeLessThan(6);
  });

  it('applied remote changes are announced to the open pages once', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    await h.service.settled();
    h.stub.engine.sync.mockResolvedValueOnce({
      status: 'idle',
      pulled: 3,
      applied: 3,
      conflicts: 0,
      quarantined: 0,
      pushed: 0,
      pending: 0,
      more: false,
      error: null,
      retryAt: null,
    });
    await h.service.runSync('test');
    expect(h.deps.notifyDataChanged).toHaveBeenCalledTimes(1);
  });
});

describe('the passphrase', () => {
  it('a short passphrase is refused before anything is sent', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    await expect(h.service.e2eeSetup('too short')).rejects.toBeDefined();
    expect(h.fetched).toEqual([]);
  });
});

describe('the session token store', () => {
  it('ignores a damaged value instead of using it', async () => {
    const area = {
      data: { syncTokens: { accessToken: 42 } } as Record<string, unknown>,
      get: async (k: string) => ({ [k]: area.data[k] }),
      set: async (items: Record<string, unknown>) => void Object.assign(area.data, items),
      remove: async (k: string) => void delete area.data[k],
    };
    const store = createSessionTokenStore(area);
    expect(await store.load()).toBeNull();
    await store.save({
      accessToken: 'a-token-0123456789',
      tokenType: 'Bearer',
      expiresAt: 1,
      refreshToken: null,
      idToken: null,
      scope: null,
      subject: 's',
    });
    expect((await store.load())?.accessToken).toBe('a-token-0123456789');
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe('who may call the service', () => {
  const BASE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';

  async function deliver(type: string, sender: Record<string, unknown>) {
    const replies: Array<{ ok: boolean; error?: { code: string; message: string } }> = [];
    await fakeBrowser.runtime.onMessage.trigger({ v: 1, type, payload: {} }, sender, (r: unknown) =>
      replies.push(r as never),
    );
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    return replies;
  }

  it('answers StudyVault pages and refuses content scripts', async () => {
    const h = harness();
    registerSyncRpc(h.service, BASE);
    const id = browser.runtime.id;
    const page = await deliver('sync.status', { id, url: `${BASE}options.html`, tab: { id: 3 } });
    expect(page[0]?.ok).toBe(true);
    const popup = await deliver('sync.status', { id });
    expect(popup[0]?.ok).toBe(true);
    const script = await deliver('sync.status', {
      id,
      url: 'https://evil.example/',
      tab: { id: 4 },
    });
    expect(script[0]).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    // and every state-changing message is behind the same guard
    for (const type of ['sync.enable', 'sync.signIn', 'sync.now', 'sync.e2ee.lock']) {
      const r = await deliver(type, { id, url: 'https://evil.example/', tab: { id: 4 } });
      expect(r[0], type).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(h.createRuntime).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload at the boundary', async () => {
    const h = harness();
    registerSyncRpc(h.service, BASE);
    const replies: Array<{ ok: boolean; error?: { code: string } }> = [];
    await fakeBrowser.runtime.onMessage.trigger(
      { v: 1, type: 'sync.configure', payload: { serverUrl: 42 } },
      { id: browser.runtime.id },
      (r: unknown) => replies.push(r as never),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(replies[0]).toMatchObject({ ok: false });
    expect(h.mem.config).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The first upload waits for an explicit encryption decision
// ---------------------------------------------------------------------------------------------

describe('the first upload', () => {
  const calledWith = (h: Harness) =>
    h.stub.engine.sync.mock.calls.map((c) => (c as unknown as [Record<string, unknown>?])[0] ?? {});

  async function signedIn(h: Harness) {
    await configure(h);
    await h.service.enable();
    grantAll(h);
    await h.service.signIn();
    await h.service.settled();
  }

  it('is a pull-only run after sign-in, and the view says nothing was sent', async () => {
    const h = harness();
    await signedIn(h);
    expect(calledWith(h).length).toBeGreaterThan(0);
    for (const options of calledWith(h)) expect(options).toMatchObject({ push: false });

    const view = await h.service.status();
    expect(view.signedIn).toBe(true);
    expect(view.encryptionChoice).toBe('undecided');
    expect(view.status).toBe('awaiting_encryption_choice');
    expect(h.mem.encryption).toBeNull();
  });

  it('is also pull-only for the timer and for "Sync now"', async () => {
    const h = harness();
    await signedIn(h);
    h.stub.engine.sync.mockClear();
    await h.service.onAlarm(ALARM_PERIODIC);
    await h.service.onAlarm(ALARM_SOON);
    await h.service.runSync('manual', { force: true });
    expect(calledWith(h)).toHaveLength(3);
    for (const options of calledWith(h)) expect(options).toMatchObject({ push: false });
  });

  it('opens only on the explicit choice to upload without end-to-end encryption, and remembers it', async () => {
    const h = harness();
    await signedIn(h);
    h.stub.engine.sync.mockClear();

    const view = await h.service.uploadWithoutEncryption();
    await h.service.settled();
    expect(view.encryptionChoice).toBe('plaintext');
    expect(h.mem.encryption).toMatchObject({ mode: 'plaintext' });
    expect(calledWith(h).length).toBeGreaterThan(0);
    for (const options of calledWith(h)) expect(options).not.toHaveProperty('push');

    // A restarted worker (a new service over the same persisted state) still knows.
    const restarted = createSyncService(h.deps);
    h.stub.engine.sync.mockClear();
    await restarted.runSync('startup');
    expect(calledWith(h)[0]).not.toHaveProperty('push');
    expect((await restarted.status()).status).toBe('idle');
  });

  it('is forgotten when the server or the provider changes', async () => {
    const h = harness();
    await signedIn(h);
    await h.service.uploadWithoutEncryption();
    await h.service.settled();
    expect(h.mem.encryption).not.toBeNull();
    await h.service.configure({
      serverUrl: 'https://elsewhere.example.org',
      issuer: ISSUER,
      clientId: CLIENT,
    });
    expect(h.mem.encryption).toBeNull();
  });

  it('needs sync to be on and a server', async () => {
    const h = harness();
    await expect(h.service.uploadWithoutEncryption()).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(h.mem.encryption).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Privileged configuration is not read from chrome.storage.local
// ---------------------------------------------------------------------------------------------

describe('where the configuration comes from', () => {
  const planted = {
    v: 1 as const,
    serverUrl: 'https://attacker.example',
    issuer: 'https://attacker.example',
    clientId: 'evil',
    e2ee: null,
  };

  it('ignores a copy a content script wrote into chrome.storage.local, and removes it', async () => {
    const h = harness({ initial: { sync: true } });
    await configure(h);
    h.mem.plantLegacyConfig(planted);
    const restarted = createSyncService(h.deps); // the planted copy is there when a worker starts
    const view = await restarted.status();
    expect(view.config).toEqual({ serverUrl: SERVER, issuer: ISSUER, clientId: CLIENT });
    expect(h.mem.legacyConfig).toBeNull();
    expect(h.mem.config?.serverUrl).toBe(SERVER);
  });

  it('moves a copy from before the move once, when Chrome already holds both origins', async () => {
    const h = harness({ initial: { sync: true } });
    h.mem.plantLegacyConfig({ ...planted, serverUrl: SERVER, issuer: ISSUER, clientId: CLIENT });
    grantAll(h);
    const view = await h.service.status();
    expect(view.config?.serverUrl).toBe(SERVER);
    expect(h.mem.config?.serverUrl).toBe(SERVER);
    expect(h.mem.legacyConfig).toBeNull();
  });

  it('drops a copy that points at origins the person never allowed', async () => {
    const h = harness({ initial: { sync: true } });
    h.mem.plantLegacyConfig(planted);
    const view = await h.service.status();
    expect(view.config).toBeNull();
    expect(h.mem.config).toBeNull();
    expect(h.mem.legacyConfig).toBeNull();
    // and nothing can be signed in to: there is no configuration
    await expect(h.service.signIn()).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('tokens belong to one configuration', () => {
  it('are forgotten, and never sent, when they were issued for another server', async () => {
    const h = harness();
    await configure(h);
    await h.service.enable();
    grantAll(h);
    await h.service.signIn();
    await h.service.settled();
    expect(h.mem.binding).toBe(JSON.stringify([SERVER, ISSUER, CLIENT]));
    expect((await h.service.status()).signedIn).toBe(true);

    // The tokens were issued for a different (server, issuer, client id): they must not be used.
    h.mem.setBinding(JSON.stringify(['https://other.example.org', ISSUER, CLIENT]));
    h.fetched.length = 0;
    const view = await h.service.runSync('test');
    expect(view.signedIn).toBe(false);
    // Anything that would use them finds none: the request is not made, and they are forgotten.
    await expect(h.service.e2eeUnlock('a long enough passphrase')).rejects.toBeDefined();
    expect(await h.mem.tokens.load()).toBeNull();
    expect(h.fetched).toEqual([]);
  });

  it('a status read reports them as absent without destroying them', async () => {
    const h = harness();
    await configure(h);
    await h.mem.tokens.save({
      accessToken: 'token-0123456789abcdef',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 60_000,
      refreshToken: null,
      idToken: null,
      scope: null,
      subject: 'user-1',
    });
    expect((await h.service.status()).signedIn).toBe(false); // no binding recorded
    expect(await h.mem.tokens.load()).not.toBeNull(); // looking is not forgetting
  });
});

// ---------------------------------------------------------------------------------------------
// The key outlives a suspended worker, until an absolute expiry
// ---------------------------------------------------------------------------------------------

describe('the unlocked key', () => {
  const KID = 'k1-testkid';

  async function withKey(clock: { t: number }) {
    const h = harness({ initial: { sync: true }, now: () => clock.t });
    await configure(h);
    const cfg = h.mem.config!;
    await h.deps.config.save({ ...cfg, e2ee: { kid: KID, version: 1 } });
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const jwk = await webcrypto.subtle.exportKey('jwk', key);
    await h.deps.keyVault.save({ jwk: jwk as never, kid: KID, expiresAt: clock.t + 900_000 });
    return h;
  }

  it('is picked up again by a restarted worker', async () => {
    const clock = { t: 1_000_000 };
    const h = await withKey(clock);
    const restarted = createSyncService(h.deps); // a new closure: nothing in memory
    const view = await restarted.status();
    expect(view.e2ee).toMatchObject({ mode: 'unlocked', lockInSeconds: 900 });
    clock.t += 300_000;
    expect((await restarted.status()).e2ee.lockInSeconds).toBe(600);
  });

  it('is gone after the expiry, from memory and from session storage', async () => {
    const clock = { t: 1_000_000 };
    const h = await withKey(clock);
    const restarted = createSyncService(h.deps);
    expect((await restarted.status()).e2ee.mode).toBe('unlocked');
    clock.t += 900_001;
    const view = await restarted.status();
    expect(view.e2ee.mode).toBe('locked');
    expect(h.mem.key).toBeNull();
  });

  it('is dropped by the lock alarm even when the worker was asleep', async () => {
    const clock = { t: 1_000_000 };
    const h = await withKey(clock);
    const restarted = createSyncService(h.deps);
    await restarted.onAlarm(ALARM_LOCK);
    expect(h.mem.key).toBeNull();
    expect((await restarted.status()).e2ee.mode).toBe('locked');
  });

  it('is not used for another key version', async () => {
    const clock = { t: 1_000_000 };
    const h = await withKey(clock);
    const cfg = (await h.deps.config.load())!;
    await h.deps.config.save({ ...cfg, e2ee: { kid: 'k2-other', version: 2 } });
    expect((await createSyncService(h.deps).status()).e2ee.mode).toBe('locked');
    expect(h.mem.key).toBeNull();
  });

  it('is dropped by sign-out, by turning sync off, and by the explicit lock', async () => {
    for (const how of ['signOut', 'disable', 'lock'] as const) {
      const clock = { t: 1_000_000 };
      const h = await withKey(clock);
      const s = createSyncService(h.deps);
      expect((await s.status()).e2ee.mode).toBe('unlocked');
      if (how === 'signOut') await s.signOut({ wipeLocalData: false, revokeAtProvider: false });
      else if (how === 'disable') await s.disable();
      else await s.e2eeLock();
      expect(h.mem.key, how).toBeNull();
    }
  });

  it('is dropped when a restore replaced the database behind the worker', async () => {
    const clock = { t: 1_000_000 };
    const h = await withKey(clock);
    const s = createSyncService(h.deps);
    expect((await s.status()).e2ee.mode).toBe('unlocked');
    vi.spyOn(h.stub.runtime, 'isCurrent').mockResolvedValue(false);
    await s.status();
    expect(h.mem.key).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Downgrade protection
// ---------------------------------------------------------------------------------------------

describe('a server that stops showing the encryption key', () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: 600_000,
    salt: 'A'.repeat(22),
    kid: 'k1-aaaaaa',
    version: 1,
    keyCheck: 'A'.repeat(43),
    createdAt: '2026-10-11T00:00:00.000Z',
    ...over,
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const none = () => json({ error: { code: 'not_found', message: 'none' } }, 404);

  async function enabledAccount(show: () => Response) {
    const h = harness({
      server: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/v1/e2ee/profile')) return show();
        return json({ ok: true });
      },
    });
    await configure(h);
    await h.service.enable();
    grantAll(h);
    await h.service.signIn();
    await h.service.settled();
    // This device turned end-to-end encryption on, with key version 2.
    const cfg = (await h.deps.config.load())!;
    await h.deps.config.save({ ...cfg, e2ee: { kid: 'k2-bbbbbb', version: 2 } });
    await h.deps.encryption.save({
      v: 1,
      mode: 'e2ee',
      profile: { kid: 'k2-bbbbbb', version: 2 },
      at: 1,
      rekey: null,
      warning: null,
    });
    // ... and it is unlocked: a locked device touches neither the network nor the data.
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    await h.deps.keyVault.save({
      jwk: (await webcrypto.subtle.exportKey('jwk', key)) as never,
      kid: 'k2-bbbbbb',
      expiresAt: Date.now() + 900_000,
    });
    h.stub.engine.sync.mockClear();
    return h;
  }

  it.each([
    ['none at all', none],
    ['an older one', () => json(profile({ version: 1, kid: 'k1-aaaaaa' }))],
    ['another one of the same version', () => json(profile({ version: 2, kid: 'k2-cccccc' }))],
  ])('is refused when it presents %s', async (_label, show) => {
    const h = await enabledAccount(show);
    const view = await h.service.runSync('test');
    expect(h.stub.engine.sync).not.toHaveBeenCalled(); // nothing pulled, nothing pushed
    expect(view.status).toBe('error');
    expect(view.e2ee.warning).toMatch(/Nothing was uploaded/);
    // the warning is remembered: a restarted worker shows it without asking the server again
    expect((await createSyncService(h.deps).status()).e2ee.warning).toMatch(/Nothing was uploaded/);
  });

  it('is accepted when another device rotated the key forward, or when nothing changed', async () => {
    for (const show of [
      () => json(profile({ version: 3, kid: 'k3-dddddd' })),
      () => json(profile({ version: 2, kid: 'k2-bbbbbb' })),
    ]) {
      const h = await enabledAccount(show);
      const view = await h.service.runSync('test');
      expect(h.stub.engine.sync).toHaveBeenCalled();
      expect(view.e2ee.warning ?? null).toBeNull();
    }
  });

  it('cannot be answered by turning encryption on again from here', async () => {
    const h = await enabledAccount(none);
    await h.deps.config.save({ ...(await h.deps.config.load())!, e2ee: null });
    await expect(h.service.e2eeSetup('a long enough passphrase')).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/no longer has the key/),
    });
    expect(h.stub.engine.auditHistory).not.toHaveBeenCalled();
  });

  it('is cleared by the person deleting what the server holds', async () => {
    const h = await enabledAccount(none);
    await h.service.runSync('test');
    expect(h.mem.encryption?.warning).toMatch(/Nothing was uploaded/);
    await h.service.deleteServerData();
    expect(h.mem.encryption).toBeNull();
    expect((await h.deps.config.load())?.e2ee).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// An interrupted set-up, and the real session-storage adapters
// ---------------------------------------------------------------------------------------------

describe('an interrupted encryption set-up', () => {
  it('re-sends this device’s own state as soon as the key is available again, once', async () => {
    const clock = { t: 1_000_000 };
    const h = harness({ initial: { sync: true }, now: () => clock.t });
    await configure(h);
    await h.deps.config.save({ ...h.mem.config!, e2ee: { kid: 'k1-testkid', version: 1 } });
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    await h.deps.keyVault.save({
      jwk: (await webcrypto.subtle.exportKey('jwk', key)) as never,
      kid: 'k1-testkid',
      expiresAt: clock.t + 900_000,
    });
    // The server's copy of this device's history was emptied, and the worker died before it was re-sent.
    await h.deps.encryption.save({
      v: 1,
      mode: 'e2ee',
      profile: { kid: 'k1-testkid', version: 1 },
      at: 1,
      rekey: { kind: 'setup', at: 1, setAside: 0 },
      warning: null,
      resend: true,
    });
    const resend = vi.spyOn(h.stub.runtime, 'resendAll');

    const restarted = createSyncService(h.deps);
    await restarted.runSync('startup');
    expect(resend).toHaveBeenCalledTimes(1);
    expect(h.mem.encryption?.resend).toBe(false);
    await restarted.runSync('startup');
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('waits for the passphrase when the key is gone, and does it after the unlock', async () => {
    const h = harness({ initial: { sync: true } });
    await configure(h);
    await h.deps.config.save({ ...h.mem.config!, e2ee: { kid: 'k1-testkid', version: 1 } });
    await h.deps.encryption.save({
      v: 1,
      mode: 'e2ee',
      profile: { kid: 'k1-testkid', version: 1 },
      at: 1,
      rekey: null,
      warning: null,
      resend: true,
    });
    const resend = vi.spyOn(h.stub.runtime, 'resendAll');
    await createSyncService(h.deps).runSync('startup');
    expect(resend).not.toHaveBeenCalled(); // locked: nothing is pushed, nothing is sent
    expect(h.mem.encryption?.resend).toBe(true);
  });
});

describe('the session-storage adapters', () => {
  const area = (initial: Record<string, unknown> = {}) => {
    const data = { ...initial };
    return {
      data,
      get: async (k: string) => ({ [k]: data[k] }),
      set: async (items: Record<string, unknown>) => void Object.assign(data, items),
      remove: async (k: string) => void delete data[k],
    };
  };

  it('keeps the key under syncKey, ignores a damaged value, and removes it on null', async () => {
    const a = area({ syncKey: { jwk: 'not a key', kid: 1 } });
    const vault = createSessionKeyVault(a);
    expect(await vault.load()).toBeNull();
    const record = { jwk: { kty: 'oct', k: 'x'.repeat(43) }, kid: 'k1-abc', expiresAt: 5 };
    await vault.save(record);
    expect(Object.keys(a.data)).toEqual(['syncKey']);
    expect(await vault.load()).toMatchObject({ kid: 'k1-abc', expiresAt: 5 });
    await vault.save(null);
    expect(await vault.load()).toBeNull();
  });

  it('keeps the token binding as a plain string', async () => {
    const a = area();
    const binding = createSessionBinding(a);
    expect(await binding.load()).toBeNull();
    await binding.save('["https://s","https://i","c"]');
    expect(await binding.load()).toBe('["https://s","https://i","c"]');
    await binding.save(null);
    expect(await binding.load()).toBeNull();
  });
});

describe('registerSync', () => {
  it('closes the session area to content scripts explicitly, and survives a browser without the call', () => {
    const setAccessLevel = vi.fn(async () => undefined);
    Object.assign(browser.storage.session, { setAccessLevel });
    const h = harness();
    void h;
    registerSync('chrome-extension://abcdefghijklmnopabcdefghijklmnop/');
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });

    Object.assign(browser.storage.session, {
      setAccessLevel: () => {
        throw new Error('not implemented');
      },
    });
    expect(() =>
      registerSync('chrome-extension://abcdefghijklmnopabcdefghijklmnop/'),
    ).not.toThrow();
  });
});

describe('browserSyncDeps', () => {
  it('sees the identity API Chrome adds to the running worker once the optional permission is granted', async () => {
    const api = browser as unknown as { identity?: unknown };
    delete api.identity; // the worker started before the person turned sync on
    const deps = browserSyncDeps();
    expect(deps.identity).toBeNull();

    const url = `${ISSUER}/authorize`;
    const back = `${REDIRECT}?code=c1`;
    const launchWebAuthFlow = vi.fn(async () => back);
    api.identity = { launchWebAuthFlow }; // granted from the click: same worker, no restart
    try {
      expect(deps.identity).not.toBeNull();
      await expect(deps.identity!.launchWebAuthFlow({ url, interactive: true })).resolves.toBe(
        back,
      );
      expect(launchWebAuthFlow).toHaveBeenCalledWith({ url, interactive: true });
    } finally {
      delete api.identity;
    }
  });
});
