import { browser } from 'wxt/browser';
import { z } from 'zod';
import { StudyVaultError, type Settings } from '@shared';
import { getSettings, serveRpc, updateSettings, watchSettings } from '@runtime';
import {
  createSyncRuntime,
  countSyncAttention,
  notifyDataChanged,
  wipeAllData,
  type SyncRuntime,
} from '@storage';
import {
  AuthError,
  AuthSession,
  CodecLockedError,
  SyncOperation,
  TransportError,
  WeakPassphraseError,
  WrongPassphraseError,
  assertSecureEndpoint,
  buildRotation,
  createHttpTransport,
  createKey,
  createPayloadCodec,
  discoverOidc,
  normaliseBaseUrl,
  unlockKey,
  type CryptoLike,
  type HttpSyncClient,
  type IdentityPort,
  type KeyedCodec,
  type KeyProfile,
  type OidcClientConfig,
  type OidcEndpoints,
  type PayloadCodec,
  type SyncReport,
  type TokenSet,
  type TokenStore,
} from '@sync';
import {
  SyncRpc,
  type ConflictDecision,
  type SyncConfigInput,
  type SyncStatusView,
} from '@ui/sync/protocol';

/**
 * The optional sync feature in the service worker. Everything is a function of persisted state (the
 * flag, the config, the database, session-scoped tokens), so a worker that was suspended and
 * restarted behaves like one that never stopped. The only things held in memory are the E2EE key
 * (deliberately: it must not reach disk) and the discovery document (a cache).
 *
 * Nothing in here runs, fetches or schedules while `Settings.features.sync` is off: the entry
 * points check the flag first, `disable()` removes the alarms, and the capture interceptor lives
 * in @storage behind the same flag.
 */

// ---------------------------------------------------------------------------------------------
// Names, limits
// ---------------------------------------------------------------------------------------------

export const ALARM_PERIODIC = 'sv-sync-periodic';
export const ALARM_SOON = 'sv-sync-soon';
export const PERIODIC_MINUTES = 15;
/** Chrome's minimum alarm granularity is 30 s. */
export const SOON_MINUTES = 0.5;
export const KEY_LOCK_MS = 15 * 60 * 1000;
const DEBOUNCE_MS = 3_000;
const MAX_PAGES = 20;
const SYNC_LOCK = 'studyvault-sync';

const forbidden = (m: string) => new StudyVaultError('forbidden', m);
const invalid = (m: string) => new StudyVaultError('invalid_request', m);

// ---------------------------------------------------------------------------------------------
// Persisted configuration (no secrets)
// ---------------------------------------------------------------------------------------------

export const StoredSyncConfig = z.object({
  v: z.literal(1),
  serverUrl: z.string().max(300),
  issuer: z.string().max(300),
  clientId: z.string().min(1).max(200),
  /** Known once this device has seen the account's key profile (E2EE). */
  e2ee: z.object({ kid: z.string().max(64), version: z.number().int().min(1) }).nullable(),
});
export type StoredSyncConfig = z.infer<typeof StoredSyncConfig>;

const StoredTokens = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresAt: z.number(),
  refreshToken: z.string().nullable(),
  idToken: z.string().nullable(),
  scope: z.string().nullable(),
  subject: z.string().nullable(),
});

const StoredDiscovery = z.object({
  issuer: z.string(),
  authorizationEndpoint: z.string(),
  tokenEndpoint: z.string(),
  revocationEndpoint: z.string().optional(),
});

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

export interface AlarmsPort {
  create(name: string, info: { delayInMinutes: number; periodInMinutes?: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
  get(name: string): Promise<{ name: string } | undefined>;
}

export interface SyncServiceDeps {
  now(): number;
  fetch: typeof fetch;
  crypto: CryptoLike;
  getSettings(): Promise<Settings>;
  setFlag(enabled: boolean): Promise<void>;
  config: {
    load(): Promise<StoredSyncConfig | null>;
    save(config: StoredSyncConfig | null): Promise<void>;
  };
  /** Session-scoped: gone when the browser closes. Never local storage. */
  tokens: TokenStore;
  /** Cached provider endpoints; session-scoped too. */
  discoveryCache: {
    load(): Promise<OidcEndpoints | null>;
    save(endpoints: OidcEndpoints | null): Promise<void>;
  };
  identity: IdentityPort | null;
  redirectUrl(): string;
  hasOrigins(origins: readonly string[]): Promise<boolean>;
  hasPermission(permission: 'identity' | 'alarms'): Promise<boolean>;
  /** Looked up per call: the optional "alarms" permission may be granted while the worker runs. */
  alarms(): AlarmsPort | null;
  publish(view: SyncStatusView): Promise<void>;
  /** Single flight across contexts. Resolves null when another run holds the lock. */
  exclusive<T>(fn: () => Promise<T>): Promise<T | null>;
  wipeLocalData(): Promise<void>;
  notifyDataChanged(): Promise<void>;
  /** The Dexie side. Replaceable in tests. */
  createRuntime: typeof createSyncRuntime;
  attention(): Promise<{ conflicts: number; quarantined: number }>;
  keyLockMs?: number;
  setTimer?(fn: () => void, ms: number): () => void;
}

const plaintextCodec: PayloadCodec = {
  required: false,
  isUnlocked: () => true,
  async encrypt() {
    throw new Error('plaintext codec cannot encrypt');
  },
  async decrypt() {
    throw new Error('plaintext codec cannot decrypt');
  },
};

function originPattern(url: string): string {
  return `${new URL(url).origin}/*`;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export function createSyncService(deps: SyncServiceDeps) {
  // ---- memory (rebuilt after a worker restart) ----
  const keyLockMs = deps.keyLockMs ?? KEY_LOCK_MS;
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });
  let codec: KeyedCodec | null = null;
  let unlockedUntil: number | null = null;
  let cancelLock: (() => void) | null = null;
  let flag: boolean | null = null;
  let running = false;
  let lastRunError: string | null = null;
  let problem: string | null = null;
  let runtime: { key: string; value: Promise<SyncRuntime> } | null = null;
  let client: { key: string; value: HttpSyncClient } | null = null;
  let session: { key: string; value: AuthSession } | null = null;
  let cancelDebounce: (() => void) | null = null;

  const isOn = async (): Promise<boolean> => {
    if (flag === null) flag = (await deps.getSettings()).features.sync;
    return flag;
  };

  // ---- E2EE key ----
  const keyed = (): KeyedCodec => (codec ??= createPayloadCodec(deps.crypto));
  const lockKey = () => {
    cancelLock?.();
    cancelLock = null;
    unlockedUntil = null;
    codec?.lock();
  };
  const installKey = (target: KeyedCodec, key: CryptoKey, kid: string) => {
    target.unlock(key, kid);
    if (target === codec) {
      cancelLock?.();
      unlockedUntil = deps.now() + keyLockMs;
      cancelLock = setTimer(() => {
        lockKey();
        void publishStatus();
      }, keyLockMs);
    }
  };

  // ---- config / auth / client / runtime ----
  const requireConfig = async (): Promise<StoredSyncConfig> => {
    const config = await deps.config.load();
    if (!config) throw invalid('Set the sync server first.');
    return config;
  };

  const oidc = async (config: StoredSyncConfig): Promise<OidcClientConfig> => {
    let endpoints = await deps.discoveryCache.load();
    if (!endpoints || endpoints.issuer !== config.issuer) {
      endpoints = await discoverOidc(config.issuer, deps.fetch);
      await deps.discoveryCache.save(endpoints);
    }
    return {
      ...endpoints,
      clientId: config.clientId,
      redirectUri: deps.redirectUrl(),
      scopes: ['openid', 'offline_access'],
    };
  };

  const authSession = async (config: StoredSyncConfig): Promise<AuthSession> => {
    const key = `${config.issuer}|${config.clientId}`;
    if (session?.key === key) return session.value;
    const value = new AuthSession({
      config: await oidc(config),
      store: deps.tokens,
      fetch: deps.fetch,
      crypto: deps.crypto,
      now: deps.now,
      isEnabled: isOn,
    });
    session = { key, value };
    return value;
  };

  /** Token access that turns "not signed in" and provider outages into the engine's vocabulary. */
  const accessToken = async (
    config: StoredSyncConfig,
    options?: { forceRefresh?: boolean },
  ): Promise<string | null> => {
    try {
      return await (await authSession(config)).getAccessToken(options);
    } catch (e) {
      if (e instanceof AuthError && e.code === 'discovery_failed') {
        throw new TransportError('network', e.message);
      }
      if (e instanceof AuthError) return null; // reauth_required and friends: sign in again
      throw e;
    }
  };

  const configKey = (c: StoredSyncConfig) =>
    `${c.serverUrl}|${c.issuer}|${c.clientId}|${c.e2ee?.kid ?? ''}`;

  const httpClient = (config: StoredSyncConfig): HttpSyncClient => {
    const key = configKey(config);
    if (client?.key === key) return client.value;
    const value = createHttpTransport({
      baseUrl: config.serverUrl,
      fetch: deps.fetch,
      getAccessToken: (o) => accessToken(config, o),
      isEnabled: isOn,
    });
    client = { key, value };
    return value;
  };

  const getRuntime = async (config: StoredSyncConfig): Promise<SyncRuntime> => {
    const key = configKey(config);
    if (runtime?.key === key) {
      const cached = runtime;
      const kept = await cached.value;
      // A restore gave the database a new sync identity behind this worker's back (see ADR-010).
      if (await kept.isCurrent()) return kept;
      if (runtime === cached) runtime = null;
    }
    const value = deps.createRuntime({
      isEnabled: isOn,
      transport: httpClient(config),
      accountId: async () => (await deps.tokens.load())?.subject ?? null,
      ...(config.e2ee ? { codec: keyed() } : {}),
    });
    runtime = { key, value };
    value.catch(() => {
      if (runtime?.value === value) runtime = null;
    });
    return value;
  };

  const invalidate = () => {
    runtime = null;
    client = null;
    session = null;
  };

  // ---- status ----
  const status = async (): Promise<SyncStatusView> => {
    const settings = await deps.getSettings();
    flag = settings.features.sync;
    const config = await deps.config.load();
    const tokens = await deps.tokens.load();
    const origins = config
      ? [originPattern(config.serverUrl), originPattern(config.issuer)].filter(
          (o, i, all) => all.indexOf(o) === i,
        )
      : [];
    const missing: string[] = [];
    for (const o of origins) if (!(await deps.hasOrigins([o]))) missing.push(o);

    const view: SyncStatusView = {
      enabled: settings.features.sync,
      config: config
        ? { serverUrl: config.serverUrl, issuer: config.issuer, clientId: config.clientId }
        : null,
      redirectUrl: deps.redirectUrl(),
      permissions: {
        identity: await deps.hasPermission('identity'),
        alarms: await deps.hasPermission('alarms'),
        missingOrigins: missing,
      },
      signedIn: tokens !== null,
      account: tokens?.subject ?? null,
      status: settings.features.sync ? 'idle' : 'disabled',
      lastSyncAt: null,
      pending: 0,
      lastError: lastRunError ? { code: 'run', message: lastRunError } : null,
      retryAt: null,
      running,
      e2ee: {
        mode: !config?.e2ee ? 'none' : codec?.isUnlocked() ? 'unlocked' : 'locked',
        version: config?.e2ee?.version ?? null,
        lockInSeconds:
          unlockedUntil === null
            ? null
            : Math.max(0, Math.round((unlockedUntil - deps.now()) / 1000)),
      },
      attention: { conflicts: 0, quarantined: 0 },
      notSynced: [],
      problem,
      scheduling: deps.alarms() ? 'alarms' : 'while-awake',
    };
    if (!settings.features.sync) return view;
    if (!config) return { ...view, problem: problem ?? 'No sync server is configured yet.' };

    try {
      const rt = await getRuntime(config);
      const state = await rt.engine.getState();
      view.status = tokens === null && state.status === 'idle' ? 'auth_required' : state.status;
      view.lastSyncAt = state.lastSyncAt;
      view.pending = state.pending;
      view.retryAt = state.backoff.nextAttemptAt;
      if (state.lastError)
        view.lastError = { code: state.lastError.code, message: state.lastError.message };
      view.notSynced = [...rt.active.notSynced];
      view.attention = await deps.attention();
      if (config.e2ee && !codec?.isUnlocked() && view.status === 'idle') view.status = 'locked';
    } catch (e) {
      view.problem = problem = e instanceof Error ? e.message : String(e);
      view.status = 'error';
    }
    return view;
  };

  const publishStatus = async (): Promise<void> => {
    try {
      await deps.publish(await status());
    } catch {
      /* status is a convenience: it must never break a sync run */
    }
  };

  // ---- scheduling ----
  const schedule = async (): Promise<void> => {
    const alarms = deps.alarms();
    if (!alarms) return;
    if (!(await alarms.get(ALARM_PERIODIC))) {
      await alarms.create(ALARM_PERIODIC, {
        delayInMinutes: PERIODIC_MINUTES,
        periodInMinutes: PERIODIC_MINUTES,
      });
    }
  };
  const unschedule = async (): Promise<void> => {
    cancelDebounce?.();
    cancelDebounce = null;
    const alarms = deps.alarms();
    if (!alarms) return;
    await alarms.clear(ALARM_PERIODIC);
    await alarms.clear(ALARM_SOON);
  };
  /** At most one extra alarm; an awake worker also syncs after a short quiet period. */
  const syncSoon = async (): Promise<void> => {
    if (!(await isOn())) return;
    const alarms = deps.alarms();
    if (alarms && !(await alarms.get(ALARM_SOON))) {
      await alarms.create(ALARM_SOON, { delayInMinutes: SOON_MINUTES });
    }
    cancelDebounce?.();
    cancelDebounce = setTimer(() => {
      cancelDebounce = null;
      background('local-change');
    }, DEBOUNCE_MS);
  };

  // ---- the run ----
  /** Runs started by events (not awaited by their caller); `settled()` lets tests wait for them. */
  const tasks = new Set<Promise<unknown>>();
  const background = (reason: string, o: { force?: boolean } = {}) => {
    const task = service.runSync(reason, o).catch(() => undefined);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };

  const reportToError = (report: SyncReport): string | null =>
    report.error ? report.error.message : null;

  async function learnKeyProfile(config: StoredSyncConfig): Promise<StoredSyncConfig> {
    if (config.e2ee || (await deps.tokens.load()) === null) return config;
    let profile: KeyProfile | null;
    try {
      profile = await httpClient(config).getKeyProfile();
    } catch {
      return config; // the run itself will report connectivity or sign-in problems
    }
    if (!profile) return config;
    const next: StoredSyncConfig = {
      ...config,
      e2ee: { kid: profile.kid, version: profile.version },
    };
    await deps.config.save(next);
    invalidate();
    return next;
  }

  const service = {
    status,

    /** Resolves when no event-started run is in flight (tests, orderly shutdown). */
    async settled(): Promise<void> {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },

    /** Store the server and provider. Changing either forgets the tokens issued for the old one. */
    async configure(input: SyncConfigInput): Promise<SyncStatusView> {
      let serverUrl: string;
      try {
        serverUrl = normaliseBaseUrl(input.serverUrl);
        assertSecureEndpoint(input.issuer, 'Issuer');
      } catch (e) {
        throw invalid(e instanceof Error ? e.message : 'The address is not valid.');
      }
      const issuer = input.issuer.replace(/\/+$/, '');
      const previous = await deps.config.load();
      const same =
        previous?.serverUrl === serverUrl &&
        previous.issuer === issuer &&
        previous.clientId === input.clientId;
      await deps.config.save({
        v: 1,
        serverUrl,
        issuer,
        clientId: input.clientId,
        e2ee: same ? previous.e2ee : null,
      });
      if (!same) {
        await deps.tokens.clear();
        await deps.discoveryCache.save(null);
        lockKey();
        invalidate();
        problem = null;
      }
      await publishStatus();
      return status();
    },

    /** Turn the feature on: the flag, the schedule, and a record of everything already stored. */
    async enable(): Promise<SyncStatusView> {
      await requireConfig();
      await deps.setFlag(true);
      flag = true;
      problem = null;
      try {
        const rt = await getRuntime((await deps.config.load())!);
        rt.startCapture();
        await rt.reconcile();
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e);
      }
      await schedule();
      await publishStatus();
      background('enable');
      return status();
    },

    async disable(): Promise<SyncStatusView> {
      await deps.setFlag(false);
      flag = false;
      await unschedule();
      lockKey();
      await deps.tokens.clear();
      try {
        const config = await deps.config.load();
        if (config && runtime) (await runtime.value).stopCapture();
      } catch {
        /* the capture of other contexts follows the flag by itself */
      }
      invalidate();
      await publishStatus();
      return status();
    },

    async signIn(): Promise<{ status: SyncStatusView; needsOrigins: string[] }> {
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const config = await requireConfig();
      const wanted = [originPattern(config.serverUrl), originPattern(config.issuer)];
      const missing: string[] = [];
      for (const o of new Set(wanted)) if (!(await deps.hasOrigins([o]))) missing.push(o);
      if (missing.length > 0) return { status: await status(), needsOrigins: missing };
      if (!deps.identity) {
        throw forbidden('Sign-in needs the "identity" permission, which has not been granted.');
      }
      let endpoints: OidcClientConfig;
      try {
        endpoints = await oidc(config);
      } catch (e) {
        throw new StudyVaultError(
          'internal',
          e instanceof AuthError ? e.message : 'The identity provider could not be reached.',
        );
      }
      // The token and revocation endpoints may live on another origin than the issuer.
      const more = [endpoints.tokenEndpoint, endpoints.revocationEndpoint]
        .filter((u): u is string => typeof u === 'string')
        .map(originPattern);
      const extra: string[] = [];
      for (const o of new Set(more)) {
        if (wanted.includes(o)) continue;
        if (!(await deps.hasOrigins([o]))) extra.push(o);
      }
      if (extra.length > 0) return { status: await status(), needsOrigins: extra };

      try {
        await (await authSession(config)).signIn(deps.identity);
      } catch (e) {
        if (e instanceof AuthError) throw new StudyVaultError('forbidden', e.message);
        throw new StudyVaultError(
          'forbidden',
          e instanceof Error && e.message
            ? `Sign-in did not complete: ${e.message}`
            : 'Sign-in did not complete.',
        );
      }
      await schedule();
      await publishStatus();
      background('sign-in');
      return { status: await status(), needsOrigins: [] };
    },

    async signOut(o: {
      wipeLocalData: boolean;
      revokeAtProvider: boolean;
    }): Promise<SyncStatusView> {
      const config = await deps.config.load();
      lockKey();
      let signed: AuthSession | null;
      try {
        signed = config ? await authSession(config) : null;
      } catch {
        signed = null; // discovery unreachable: tokens are still cleared below
      }
      if (signed) {
        await signed.signOut({
          revoke: o.revokeAtProvider,
          ...(o.wipeLocalData ? { wipeLocalData: () => deps.wipeLocalData() } : {}),
        });
      } else {
        await deps.tokens.clear();
        if (o.wipeLocalData) await deps.wipeLocalData();
      }
      invalidate();
      if (o.wipeLocalData) {
        flag = false;
        await unschedule();
      }
      await publishStatus();
      return status();
    },

    /** One run: record what was missed, pull, push. Never throws; the view says what happened. */
    async runSync(reason: string, o: { force?: boolean } = {}): Promise<SyncStatusView> {
      void reason;
      if (!(await isOn())) return status();
      const config = await deps.config.load();
      if (!config) return status();
      await deps.exclusive(async () => {
        running = true;
        lastRunError = null;
        problem = null;
        await publishStatus();
        try {
          let current = await learnKeyProfile(config);
          const rt = await getRuntime(current);
          if (await rt.isDirty()) await rt.reconcile();
          let report = await rt.engine.sync(o.force ? { force: true } : {});
          for (let i = 1; report.more && i < MAX_PAGES; i++) report = await rt.engine.sync(o);
          lastRunError = reportToError(report);
          if (report.applied > 0) await deps.notifyDataChanged();
          if (report.status === 'idle') {
            await rt.engine.prune();
            // Changes that did not fit in the outbox are found by fingerprint now that it drained.
            if (await rt.isDirty()) background('continue');
          }
          current = (await deps.config.load()) ?? current;
          const alarms = deps.alarms();
          if (report.retryAt !== null && alarms) {
            const minutes = Math.max(SOON_MINUTES, (report.retryAt - deps.now()) / 60_000);
            await alarms.create(ALARM_SOON, { delayInMinutes: minutes });
          }
        } catch (e) {
          // Only runtime creation and storage failures get here (the engine reports the rest).
          lastRunError = problem = e instanceof Error ? e.message : String(e);
        } finally {
          running = false;
          await publishStatus();
        }
      });
      return status();
    },

    // ---- end-to-end encryption ----

    async e2eeSetup(passphrase: string): Promise<SyncStatusView> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const net = httpClient(config);
      if (await net.getKeyProfile()) {
        throw invalid('Encryption is already set up for this account. Unlock it instead.');
      }
      let created;
      try {
        created = await createKey({ crypto: deps.crypto, passphrase, now: deps.now(), version: 1 });
      } catch (e) {
        if (e instanceof WeakPassphraseError) throw invalid(e.message);
        throw e;
      }
      const next = createPayloadCodec(deps.crypto);
      next.unlock(created.key, created.profile.kid);
      // Existing plaintext history is re-encrypted in place by the same call that installs the key.
      await rotateServerLog(net, plaintextCodec, next, created.profile);
      const updated: StoredSyncConfig = {
        ...config,
        e2ee: { kid: created.profile.kid, version: created.profile.version },
      };
      await deps.config.save(updated);
      invalidate();
      codec = createPayloadCodec(deps.crypto);
      installKey(codec, created.key, created.profile.kid);
      await publishStatus();
      background('e2ee-setup');
      return status();
    },

    async e2eeUnlock(
      passphrase: string,
    ): Promise<{ ok: boolean; reason: 'wrong_passphrase' | 'no_key' | null }> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const profile = await httpClient(config).getKeyProfile();
      if (!profile) return { ok: false, reason: 'no_key' };
      let key: CryptoKey;
      try {
        key = await unlockKey({ crypto: deps.crypto, passphrase, profile });
      } catch (e) {
        if (e instanceof WrongPassphraseError) return { ok: false, reason: 'wrong_passphrase' };
        throw e;
      }
      const updated: StoredSyncConfig = {
        ...config,
        e2ee: { kid: profile.kid, version: profile.version },
      };
      await deps.config.save(updated);
      invalidate();
      installKey(keyed(), key, profile.kid);
      const rt = await getRuntime(updated);
      await rt.engine.retryQuarantined();
      await publishStatus();
      background('e2ee-unlock');
      return { ok: true, reason: null };
    },

    async e2eeLock(): Promise<SyncStatusView> {
      lockKey();
      await publishStatus();
      return status();
    },

    async e2eeRotate(
      current: string,
      next: string,
    ): Promise<{ ok: boolean; reason: 'wrong_passphrase' | 'no_key' | null }> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const net = httpClient(config);
      const profile = await net.getKeyProfile();
      if (!profile) return { ok: false, reason: 'no_key' };
      let oldKey: CryptoKey;
      try {
        oldKey = await unlockKey({ crypto: deps.crypto, passphrase: current, profile });
      } catch (e) {
        if (e instanceof WrongPassphraseError) return { ok: false, reason: 'wrong_passphrase' };
        throw e;
      }
      let created;
      try {
        created = await createKey({
          crypto: deps.crypto,
          passphrase: next,
          now: deps.now(),
          version: profile.version + 1,
        });
      } catch (e) {
        if (e instanceof WeakPassphraseError) throw invalid(e.message);
        throw e;
      }
      const oldCodec = createPayloadCodec(deps.crypto);
      oldCodec.unlock(oldKey, profile.kid);
      const newCodec = createPayloadCodec(deps.crypto);
      newCodec.unlock(created.key, created.profile.kid);

      await rotateServerLog(net, oldCodec, newCodec, created.profile);

      // Operations already encrypted for sending with the old key go back to plaintext in the
      // outbox; the push re-encrypts them with the new key.
      const rt = await getRuntime(config);
      for (const p of await rt.log.pending(100_000)) {
        if (!p.op.payloadEncrypted) continue;
        const aad = {
          id: p.op.id,
          clientId: p.op.clientId,
          entityType: p.op.entityType,
          entityId: p.op.entityId,
          opType: p.op.opType,
          revision: p.op.revision,
          hlc: p.op.hlc,
        };
        const plain = await oldCodec.decrypt(p.op.payload as never, aad);
        await rt.log.replace(
          [p.op.id],
          SyncOperation.parse({ ...p.op, payload: plain, payloadEncrypted: false }),
        );
      }
      const updated: StoredSyncConfig = {
        ...config,
        e2ee: { kid: created.profile.kid, version: created.profile.version },
      };
      await deps.config.save(updated);
      invalidate();
      codec = createPayloadCodec(deps.crypto);
      installKey(codec, created.key, created.profile.kid);
      await publishStatus();
      background('e2ee-rotate');
      return { ok: true, reason: null };
    },

    // ---- conflicts, quarantine ----

    async resolveConflict(id: string, decision: ConflictDecision): Promise<void> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const rt = await getRuntime(config);
      try {
        await rt.engine.resolveConflict(id, decision);
      } catch (e) {
        throw invalid(e instanceof Error ? e.message : 'The conflict could not be resolved.');
      }
      await deps.notifyDataChanged();
      await publishStatus();
      void syncSoon();
    },

    async retryQuarantine(): Promise<{ retried: number; remaining: number }> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const rt = await getRuntime(config);
      const before = (await rt.store.listQuarantined()).length;
      const report = await rt.engine.retryQuarantined();
      const remaining = (await rt.store.listQuarantined()).length;
      if (report.applied > 0) await deps.notifyDataChanged();
      await publishStatus();
      return { retried: Math.max(0, before - remaining), remaining };
    },

    async discardQuarantined(id: string): Promise<void> {
      const config = await requireConfig();
      const rt = await getRuntime(config);
      await rt.store.deleteQuarantined(id);
      await publishStatus();
    },

    // ---- recovery ----

    async deleteServerData(): Promise<SyncStatusView> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      await httpClient(config).deleteAllData();
      // The key profile went with it; this device's data is untouched.
      lockKey();
      await deps.config.save({ ...config, e2ee: null });
      invalidate();
      const rt = await getRuntime((await deps.config.load())!);
      await rt.engine.acknowledgeServerReset();
      await publishStatus();
      return status();
    },

    async reupload(): Promise<SyncStatusView> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const rt = await getRuntime(config);
      await rt.resendAll();
      await publishStatus();
      background('reupload', { force: true });
      return status();
    },

    async rebind(): Promise<SyncStatusView> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const rt = await getRuntime(config);
      await rt.rebind();
      await publishStatus();
      background('rebind', { force: true });
      return status();
    },

    // ---- events ----

    async onAlarm(name: string): Promise<void> {
      if (name !== ALARM_PERIODIC && name !== ALARM_SOON) return;
      if (!(await isOn())) {
        await unschedule(); // a leftover alarm of a build or session that had sync on
        return;
      }
      await service.runSync(name);
    },
    onLocalChange: syncSoon,
    /** The flag changed from another context (or storage was cleared). */
    async onSettings(settings: Settings): Promise<void> {
      const was = flag;
      flag = settings.features.sync;
      if (was !== null && was !== flag && !flag) {
        await unschedule();
        lockKey();
        invalidate();
      }
    },
    async onStartup(): Promise<void> {
      if (!(await isOn())) return;
      await schedule();
      await service.runSync('startup');
    },
  };

  async function rotateServerLog(
    net: HttpSyncClient,
    oldCodec: PayloadCodec,
    newCodec: PayloadCodec,
    profile: KeyProfile,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const ops: SyncOperation[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await net.pull({ since: cursor, limit: 500 });
        for (const entry of page.ops) {
          const parsed = SyncOperation.safeParse(entry.op);
          if (!parsed.success) {
            throw invalid(
              'The server holds an operation this version cannot read, so encryption cannot be changed safely.',
            );
          }
          ops.push(parsed.data);
        }
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      const request = await buildRotation({ ops, oldCodec, newCodec, newProfile: profile });
      try {
        await net.rotate(request);
        return;
      } catch (e) {
        // Another device pushed between our read and the swap: read again (bounded).
        if (e instanceof TransportError && e.kind === 'client' && attempt < 2) continue;
        if (e instanceof CodecLockedError) throw forbidden('The encryption key is locked.');
        throw e;
      }
    }
  }

  return service;
}

export type SyncService = ReturnType<typeof createSyncService>;

// ---------------------------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------------------------

/**
 * Serve the sync UI protocol. Extension pages only: a content script runs next to untrusted page
 * script and may never start sign-in, read status or touch keys.
 */
export function registerSyncRpc(service: SyncService, extensionBaseUrl: string): () => void {
  const guard = (sender: { tab?: unknown; url?: string }) => {
    if (sender.tab !== undefined && !sender.url?.startsWith(extensionBaseUrl)) {
      throw forbidden('Sync can only be managed from StudyVault pages.');
    }
  };
  return serveRpc(
    SyncRpc,
    {
      'sync.status': async (_p, s) => (guard(s), service.status()),
      'sync.configure': async (p, s) => (guard(s), service.configure(p)),
      'sync.enable': async (_p, s) => (guard(s), service.enable()),
      'sync.disable': async (_p, s) => (guard(s), service.disable()),
      'sync.signIn': async (_p, s) => (guard(s), service.signIn()),
      'sync.signOut': async (p, s) => (guard(s), service.signOut(p)),
      'sync.now': async (_p, s) => (guard(s), service.runSync('manual', { force: true })),
      'sync.e2ee.setup': async (p, s) => (guard(s), service.e2eeSetup(p.passphrase)),
      'sync.e2ee.unlock': async (p, s) => (guard(s), service.e2eeUnlock(p.passphrase)),
      'sync.e2ee.lock': async (_p, s) => (guard(s), service.e2eeLock()),
      'sync.e2ee.rotate': async (p, s) => (guard(s), service.e2eeRotate(p.current, p.next)),
      'sync.conflict.resolve': async (p, s) => {
        guard(s);
        await service.resolveConflict(p.id, p.decision);
        return { resolved: true };
      },
      'sync.quarantine.retry': async (_p, s) => (guard(s), service.retryQuarantine()),
      'sync.quarantine.discard': async (p, s) => {
        guard(s);
        await service.discardQuarantined(p.id);
        return {};
      },
      'sync.serverData.delete': async (_p, s) => (guard(s), service.deleteServerData()),
      'sync.reupload': async (_p, s) => (guard(s), service.reupload()),
      'sync.rebind': async (_p, s) => (guard(s), service.rebind()),
    },
    // A first encryption setup pulls and re-encrypts the whole log: allow it more than the default.
    { timeoutMs: 120_000 },
  );
}

// ---------------------------------------------------------------------------------------------
// Chrome adapters
// ---------------------------------------------------------------------------------------------

const CONFIG_KEY = 'syncConfig';
const TOKENS_KEY = 'syncTokens';
const DISCOVERY_KEY = 'syncOidc';
const STATUS_KEY = 'syncStatus';

export function createSessionTokenStore(area: {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}): TokenStore {
  return {
    async load(): Promise<TokenSet | null> {
      const parsed = StoredTokens.safeParse((await area.get(TOKENS_KEY))[TOKENS_KEY]);
      return parsed.success ? parsed.data : null;
    },
    async save(tokens) {
      await area.set({ [TOKENS_KEY]: tokens });
    },
    async clear() {
      await area.remove(TOKENS_KEY);
    },
  };
}

/** The real service-worker wiring. Thin on purpose: the logic above is what the tests cover. */
export function browserSyncDeps(): SyncServiceDeps {
  const local = browser.storage.local;
  const session = browser.storage.session;
  return {
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
    crypto: globalThis.crypto,
    getSettings,
    setFlag: async (enabled) => {
      await updateSettings((s) => ({ ...s, features: { ...s.features, sync: enabled } }));
    },
    config: {
      async load() {
        const parsed = StoredSyncConfig.safeParse((await local.get(CONFIG_KEY))[CONFIG_KEY]);
        return parsed.success ? parsed.data : null;
      },
      async save(config) {
        if (config) await local.set({ [CONFIG_KEY]: config });
        else await local.remove(CONFIG_KEY);
      },
    },
    tokens: createSessionTokenStore(session),
    discoveryCache: {
      async load() {
        const parsed = StoredDiscovery.safeParse((await session.get(DISCOVERY_KEY))[DISCOVERY_KEY]);
        return parsed.success ? parsed.data : null;
      },
      async save(endpoints) {
        if (endpoints) await session.set({ [DISCOVERY_KEY]: endpoints });
        else await session.remove(DISCOVERY_KEY);
      },
    },
    identity: browser.identity
      ? {
          launchWebAuthFlow: async (request) => {
            const url = await browser.identity.launchWebAuthFlow(request);
            if (!url) throw new Error('The sign-in window returned no address.');
            return url;
          },
        }
      : null,
    redirectUrl: () => `https://${browser.runtime.id}.chromiumapp.org/sync`,
    hasOrigins: (origins) =>
      browser.permissions.contains({ origins: [...origins] }).catch(() => false),
    hasPermission: (permission) =>
      browser.permissions.contains({ permissions: [permission] }).catch(() => false),
    alarms: () => {
      const api = browser.alarms as typeof browser.alarms | undefined;
      if (!api) return null;
      return {
        create: async (name, info) => {
          await api.create(name, info as Parameters<typeof api.create>[1] & object);
        },
        clear: (name) => api.clear(name),
        get: async (name) => (await api.get(name)) ?? undefined,
      };
    },
    publish: async (view) => {
      await session.set({ [STATUS_KEY]: view });
    },
    exclusive: async (fn) => {
      if (!navigator.locks) return fn();
      return navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) =>
        lock ? fn() : null,
      );
    },
    wipeLocalData: wipeAllData,
    notifyDataChanged,
    createRuntime: createSyncRuntime,
    attention: countSyncAttention,
  };
}

/**
 * Top-level listener registration (call synchronously from the background entry point). The
 * service is created lazily per event batch; nothing is read from storage until an event arrives.
 */
export function registerSync(extensionBaseUrl: string): SyncService {
  const service = createSyncService(browserSyncDeps());
  const report = (err: unknown) => console.error('[StudyVault] sync', err);

  registerSyncRpc(service, extensionBaseUrl);

  // Alarms exist only once the optional permission was granted; the API object may be absent.
  const onAlarm = (alarm: { name: string }) => {
    service.onAlarm(alarm.name).catch(report);
  };
  browser.alarms?.onAlarm.addListener(onAlarm);

  // The flag changing in another context (options page, wipe) and local data changing.
  watchSettings((settings) => {
    service.onSettings(settings).catch(report);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'dataEpoch' in changes) service.onLocalChange().catch(report);
  });

  browser.runtime.onStartup.addListener(() => {
    service.onStartup().catch(report);
  });
  // Alarms do not survive an extension update or reload: put the schedule back.
  browser.runtime.onInstalled.addListener(() => {
    service.onStartup().catch(report);
  });

  return service;
}
