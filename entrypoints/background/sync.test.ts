// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { webcrypto } from 'node:crypto';
import type { SyncRuntime } from '@storage';
import type { SyncReport } from '@sync';
import {
  ALARM_PERIODIC,
  ALARM_SOON,
  PERIODIC_MINUTES,
  createSessionTokenStore,
  createSyncService,
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
    resendAll: async () => ({ queued: 0 }),
    rebind: async () => ({ created: 0, changed: 0, deleted: 0, incomplete: false }),
    log: { pending: async () => [], replace: async () => undefined },
    store: { listQuarantined: async () => [], deleteQuarantined: async () => undefined },
    engine: {
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
  over: { initial?: { sync?: boolean }; alarms?: FakeAlarms | null; identity?: boolean } = {},
) {
  const fetched: string[] = [];
  const passthrough: typeof fetch = async (input) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('{}', { status: 200 });
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
