import { browser } from 'wxt/browser';
import { z } from 'zod';
import { StudyVaultError, type Settings } from '@shared';
import { getTrustedSettings, serveRpc, updateSettings } from '@runtime';
import {
  createSyncRuntime,
  countSyncAttention,
  notifyDataChanged,
  readSyncPrivate,
  wipeAllData,
  writeSyncPrivate,
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
  exportKeyJwk,
  importKeyJwk,
  isAlive,
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
  type SetAsideReason,
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
 * flag, the config, the database, session-scoped tokens and key), so a worker that was suspended and
 * restarted behaves like one that never stopped. The only things held in memory are caches: the
 * unwrapped E2EE key (rebuilt from the session store until its expiry), the discovery document and
 * the runtime.
 *
 * Nothing in here runs, fetches or schedules while `Settings.features.sync` is off: the entry
 * points check the flag first, `disable()` removes the alarms, and the capture interceptor lives
 * in @storage behind the same flag.
 *
 * Where things live (docs/adr/010-module-seams.md, amendment "Privileged configuration"):
 *  - IndexedDB `meta` (unreachable for content scripts): server/issuer/client id, the person's
 *    encryption decision and the "end-to-end encryption was enabled" marker.
 *  - chrome.storage.session (memory only, trusted contexts only): tokens and the tokens' binding,
 *    the provider's endpoints, and the E2EE data key until its expiry.
 *  - Never in chrome.storage.local, which a content script can write.
 */

// ---------------------------------------------------------------------------------------------
// Names, limits
// ---------------------------------------------------------------------------------------------

export const ALARM_PERIODIC = 'sv-sync-periodic';
export const ALARM_SOON = 'sv-sync-soon';
/** Fires at the key's absolute expiry so a suspended worker still drops the key from session storage. */
export const ALARM_LOCK = 'sv-sync-lock';
export const PERIODIC_MINUTES = 15;
/** Chrome's minimum alarm granularity is 30 s. */
export const SOON_MINUTES = 0.5;
/** How long an unlocked key is usable, counted from the unlock: absolute, not extended by use. */
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

/**
 * The person's decision about how uploads are protected. No record = not decided: nothing is
 * uploaded (pulling is fine). `plaintext` = they chose to upload without end-to-end encryption.
 * `e2ee` = encryption was enabled (or unlocked) on this device; `profile` is the key profile it
 * was enabled with, and a server that later presents none, an older or a different one is refused.
 */
export const StoredEncryption = z.object({
  v: z.literal(1),
  mode: z.enum(['plaintext', 'e2ee']),
  profile: z.object({ kid: z.string().max(64), version: z.number().int().min(1) }).nullable(),
  at: z.number(),
  /** The last re-keying done from this device: what it could not vouch for. */
  rekey: z
    .object({
      kind: z.enum(['setup', 'rotate']),
      at: z.number(),
      setAside: z.number().int().min(0),
    })
    .nullable(),
  /** Why uploads are refused (downgrade protection), until the server presents the right profile. */
  warning: z.string().max(500).nullable(),
  /**
   * Set when this device emptied its own history on the server (setup) and has not re-sent its
   * state yet: the next unlocked run does it, so an interrupted set-up cannot lose that history.
   */
  resend: z.boolean().optional(),
});
export type StoredEncryption = z.infer<typeof StoredEncryption>;

/** The unwrapped data key, in memory-only session storage, until `expiresAt` (epoch ms). */
export const StoredKey = z.object({
  jwk: z.object({ kty: z.string(), k: z.string() }).passthrough(),
  kid: z.string().max(64),
  expiresAt: z.number(),
});
export type StoredKey = z.infer<typeof StoredKey>;

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
  create(
    name: string,
    info: { delayInMinutes?: number; when?: number; periodInMinutes?: number },
  ): Promise<void>;
  clear(name: string): Promise<boolean>;
  get(name: string): Promise<{ name: string } | undefined>;
}

export interface SyncServiceDeps {
  now(): number;
  fetch: typeof fetch;
  crypto: CryptoLike;
  /** The AUTHORITATIVE settings (never the content-script-writable copy). */
  getSettings(): Promise<Settings>;
  setFlag(enabled: boolean): Promise<void>;
  /** Server, provider and client id. Lives in IndexedDB `meta`: content scripts cannot write it. */
  config: {
    load(): Promise<StoredSyncConfig | null>;
    save(config: StoredSyncConfig | null): Promise<void>;
  };
  /**
   * Where this configuration used to live (chrome.storage.local, writable by content scripts). It is
   * moved once, and only when Chrome already holds the person's grant for both origins; afterwards
   * it is never read again.
   */
  legacyConfig?: {
    load(): Promise<StoredSyncConfig | null>;
    clear(): Promise<void>;
  };
  /** The encryption decision and the "E2EE was enabled" marker. IndexedDB `meta`. */
  encryption: {
    load(): Promise<StoredEncryption | null>;
    save(value: StoredEncryption | null): Promise<void>;
  };
  /** Session-scoped: gone when the browser closes. Never local storage. */
  tokens: TokenStore;
  /** The (server, issuer, client id) the stored tokens were issued for. Session-scoped too. */
  tokenBinding: {
    load(): Promise<string | null>;
    save(binding: string | null): Promise<void>;
  };
  /** The unwrapped E2EE key until its expiry. Memory-only session storage, trusted contexts only. */
  keyVault: {
    load(): Promise<StoredKey | null>;
    save(key: StoredKey | null): Promise<void>;
  };
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

const bindingOf = (c: Pick<StoredSyncConfig, 'serverUrl' | 'issuer' | 'clientId'>) =>
  JSON.stringify([c.serverUrl, c.issuer, c.clientId]);

const WARNING_ABSENT =
  'End-to-end encryption was turned on for this account from this device, but the server now reports no encryption key. Nothing was uploaded. The server may have been reset or tampered with: your data on this device is untouched.';
const WARNING_DIFFERENT =
  'End-to-end encryption was turned on for this account from this device, but the server now presents an older or different encryption key. Nothing was uploaded. The server may have been reset or tampered with: your data on this device is untouched.';

/** `null` = the profile is what this device expects (or one rotated forward by another device). */
function downgradeWarning(enc: StoredEncryption | null, profile: KeyProfile | null): string | null {
  if (enc?.mode !== 'e2ee' || !enc.profile) return null;
  if (profile === null) return WARNING_ABSENT;
  const older = profile.version < enc.profile.version;
  const other = profile.version === enc.profile.version && profile.kid !== enc.profile.kid;
  return older || other ? WARNING_DIFFERENT : null;
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
  let loadedKid: string | null = null;
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
  let legacyChecked = false;

  const isOn = async (): Promise<boolean> => {
    if (flag === null) flag = (await deps.getSettings()).features.sync;
    return flag;
  };

  // ---- configuration ----
  /**
   * The configuration, from `meta`. The pre-amendment copy in chrome.storage.local is read only when
   * `meta` has none, and then only if Chrome already holds both origins' grants (a copy planted by a
   * content script points at origins the person never allowed). Either way it is removed.
   */
  const loadConfig = async (): Promise<StoredSyncConfig | null> => {
    const stored = await deps.config.load();
    const legacy = deps.legacyConfig;
    if (stored) {
      if (legacy && !legacyChecked) {
        legacyChecked = true;
        await legacy.clear().catch(() => undefined);
      }
      return stored;
    }
    if (!legacy) return null;
    const found = await legacy.load().catch(() => null);
    if (!found) return null;
    const origins = [...new Set([originPattern(found.serverUrl), originPattern(found.issuer)])];
    let granted = true;
    for (const o of origins) if (!(await deps.hasOrigins([o]))) granted = false;
    if (granted) await deps.config.save(found);
    await legacy.clear().catch(() => undefined);
    return granted ? found : null;
  };

  const requireConfig = async (): Promise<StoredSyncConfig> => {
    const config = await loadConfig();
    if (!config) throw invalid('Set the sync server first.');
    return config;
  };

  // ---- tokens, bound to the configuration they were issued for ----
  const clearTokens = async () => {
    await deps.tokens.clear();
    await deps.tokenBinding.save(null);
  };
  /**
   * Tokens are only ever used for the (server, issuer, client id) they were issued for. A
   * configuration that changed behind this worker's back finds no tokens: they are forgotten, so
   * nothing is sent to an address the person never signed in to. `peek` reports without forgetting.
   */
  const tokensFor = (config: StoredSyncConfig, peek = false): TokenStore => ({
    load: async () => {
      const tokens = await deps.tokens.load();
      if (!tokens) return null;
      if ((await deps.tokenBinding.load()) === bindingOf(config)) return tokens;
      if (!peek) await clearTokens();
      return null;
    },
    save: async (tokens) => {
      await deps.tokens.save(tokens);
      await deps.tokenBinding.save(bindingOf(config));
    },
    clear: clearTokens,
  });

  // ---- E2EE key: persisted in session storage until an absolute expiry ----
  const keyed = (): KeyedCodec => (codec ??= createPayloadCodec(deps.crypto));

  /** Forget the key everywhere: memory, session storage, the expiry timer and alarm. */
  const lockKey = async (): Promise<void> => {
    cancelLock?.();
    cancelLock = null;
    unlockedUntil = null;
    loadedKid = null;
    codec?.lock();
    await deps.keyVault.save(null).catch(() => undefined);
    await deps
      .alarms()
      ?.clear(ALARM_LOCK)
      .catch(() => false);
  };

  const armLock = (expiresAt: number) => {
    cancelLock?.();
    unlockedUntil = expiresAt;
    cancelLock = setTimer(
      () => {
        void lockKey().then(publishStatus);
      },
      Math.max(0, expiresAt - deps.now()),
    );
    void deps
      .alarms()
      ?.create(ALARM_LOCK, { when: expiresAt })
      .catch(() => undefined);
  };

  /** Install a key the person just proved they know. It is usable for `keyLockMs`, from now. */
  const unlockWith = async (key: CryptoKey, profile: { kid: string; version: number }) => {
    const expiresAt = deps.now() + keyLockMs;
    // The session store is authoritative: a key that could not be stored is not unlocked.
    await deps.keyVault.save({
      jwk: (await exportKeyJwk(deps.crypto, key)) as StoredKey['jwk'],
      kid: profile.kid,
      expiresAt,
    });
    keyed().unlock(key, profile.kid);
    loadedKid = profile.kid;
    armLock(expiresAt);
  };

  /**
   * Make the in-memory codec agree with the session store, which is authoritative: a restarted
   * worker picks the key up again, an expired or foreign one is dropped. True when usable.
   */
  const ensureKey = async (config: StoredSyncConfig | null): Promise<boolean> => {
    if (!config?.e2ee) {
      if (codec?.isUnlocked()) await lockKey();
      return false;
    }
    const record = await deps.keyVault.load();
    const usable =
      record !== null && record.expiresAt > deps.now() && record.kid === config.e2ee.kid;
    if (!usable) {
      if (record !== null || codec?.isUnlocked()) await lockKey();
      return false;
    }
    const target = keyed();
    if (!target.isUnlocked() || loadedKid !== record.kid) {
      try {
        target.unlock(await importKeyJwk(deps.crypto, record.jwk as JsonWebKey), record.kid);
        loadedKid = record.kid;
      } catch {
        await lockKey();
        return false;
      }
    }
    if (unlockedUntil !== record.expiresAt) armLock(record.expiresAt);
    return true;
  };

  // ---- auth / client / runtime ----
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
    const key = bindingOf(config);
    if (session?.key === key) return session.value;
    const value = new AuthSession({
      config: await oidc(config),
      store: tokensFor(config),
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

  const configKey = (c: StoredSyncConfig) => `${bindingOf(c)}|${c.e2ee?.kid ?? ''}`;

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
      if (await kept.isCurrent()) return kept;
      // A restore gave the database a new sync identity behind this worker's back (see ADR-010):
      // what was restored is not what the unlocked key was unlocked for. Lock until it is entered again.
      await lockKey();
      if (runtime === cached) runtime = null;
    }
    const value = deps.createRuntime({
      isEnabled: isOn,
      transport: httpClient(config),
      accountId: async () => (await tokensFor(config).load())?.subject ?? null,
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
    const config = await loadConfig();
    const tokens = config ? await tokensFor(config, true).load() : null;
    const enc = await deps.encryption.load();
    const origins = config
      ? [originPattern(config.serverUrl), originPattern(config.issuer)].filter(
          (o, i, all) => all.indexOf(o) === i,
        )
      : [];
    const missing: string[] = [];
    for (const o of origins) if (!(await deps.hasOrigins([o]))) missing.push(o);

    // A runtime that notices a restore locks the key: look at the key after it.
    if (settings.features.sync && config) await getRuntime(config).catch(() => undefined);
    const unlocked = config?.e2ee ? await ensureKey(config) : false;
    const choice: 'undecided' | 'plaintext' | 'e2ee' =
      config?.e2ee || enc?.mode === 'e2ee'
        ? 'e2ee'
        : enc?.mode === 'plaintext'
          ? 'plaintext'
          : 'undecided';

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
        mode: !config?.e2ee ? 'none' : unlocked ? 'unlocked' : 'locked',
        version: config?.e2ee?.version ?? null,
        lockInSeconds:
          unlocked && unlockedUntil !== null
            ? Math.max(0, Math.round((unlockedUntil - deps.now()) / 1000))
            : null,
        warning: enc?.warning ?? null,
        setAside: enc?.rekey?.setAside ?? 0,
      },
      encryptionChoice: choice,
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
      if (config.e2ee && !unlocked && view.status === 'idle') view.status = 'locked';
      if (tokens !== null && choice === 'undecided' && view.status === 'idle') {
        view.status = 'awaiting_encryption_choice';
      }
      if (enc?.warning) {
        view.status = 'error';
        view.lastError = { code: 'e2ee_downgrade', message: enc.warning };
      }
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

  const setWarning = async (enc: StoredEncryption | null, warning: string | null) => {
    if (enc && (enc.warning ?? null) !== warning) await deps.encryption.save({ ...enc, warning });
    return warning;
  };

  /**
   * Compare the server's key profile with what this device knows. Learns the profile of an account
   * that another device encrypted (so the codec takes over and plaintext can never be pushed), and
   * refuses to continue when a device that enabled E2EE is shown no profile, an older or another one.
   */
  async function checkProfile(
    config: StoredSyncConfig,
  ): Promise<{ config: StoredSyncConfig; warning: string | null }> {
    const enc = await deps.encryption.load();
    if (config.e2ee && enc?.mode !== 'e2ee') return { config, warning: null };
    if ((await tokensFor(config, true).load()) === null) {
      return { config, warning: enc?.warning ?? null };
    }
    let profile: KeyProfile | null;
    try {
      profile = await httpClient(config).getKeyProfile();
    } catch {
      return { config, warning: enc?.warning ?? null }; // the run itself reports connectivity
    }
    const warning = await setWarning(enc, downgradeWarning(enc, profile));
    if (warning || !profile || config.e2ee) return { config, warning };
    const next: StoredSyncConfig = {
      ...config,
      e2ee: { kid: profile.kid, version: profile.version },
    };
    await deps.config.save(next);
    invalidate();
    return { config: next, warning: null };
  }

  /**
   * The server's copy of this device's own history was emptied (set-up): send what this device
   * holds, under the new key. Rows, and the deletions that other devices must still learn about.
   */
  async function resendOwnState(rt: SyncRuntime): Promise<void> {
    await rt.resendAll();
    for (const m of await rt.store.listTombstones(deps.now() + 1, 50_000)) {
      if (isAlive(m)) continue;
      await rt.engine.recordLocalChange({
        kind: 'delete',
        entityType: m.entityType,
        entityId: m.entityId,
        before: null,
      });
    }
    const enc = await deps.encryption.load();
    if (enc?.resend) await deps.encryption.save({ ...enc, resend: false });
  }

  /** Read the server's whole log (all of it, page by page) and parse it. */
  async function readLog(net: HttpSyncClient): Promise<SyncOperation[]> {
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
      if (!page.hasMore) return ops;
    }
  }

  /**
   * Replace every stored payload under the new key, atomically (the server insists on full coverage).
   *
   *  - Rotation (`migrating` false): what authenticates under the old key is re-encrypted; anything
   *    else is replaced by an undecryptable envelope. Nothing unauthenticated becomes authentic.
   *  - Setup (`migrating` true): the log is plaintext and nobody can authenticate it. This device
   *    first applies it like any pull (validating every operation) and then keeps only operations
   *    from OTHER devices that it validated and merged. Its own history is replaced by an
   *    authenticated "ignore" marker: the caller re-sends this device's state instead of trusting
   *    the server's copy of it. Everything else is replaced by an undecryptable envelope.
   * Returns how many stored operations could not be vouched for (they are also put in the
   * quarantine list, so the person can see what they were).
   */
  async function rekeyLog(o: {
    rt: SyncRuntime;
    net: HttpSyncClient;
    oldCodec: PayloadCodec;
    newCodec: PayloadCodec;
    profile: KeyProfile;
    migrating: boolean;
  }): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      let ops: SyncOperation[];
      let accepted = new Set<string>();
      if (o.migrating) {
        const audit = await o.rt.engine.auditHistory();
        if (audit.unreadable > 0) {
          throw invalid(
            'The server holds an operation this version cannot read, so encryption cannot be changed safely.',
          );
        }
        ops = audit.ops;
        accepted = audit.accepted;
      } else {
        ops = await readLog(o.net);
      }
      const byId = new Map(ops.map((op) => [op.id, op] as const));
      const aside: Array<{ op: SyncOperation; reason: SetAsideReason }> = [];
      const request = await buildRotation({
        ops,
        oldCodec: o.oldCodec,
        newCodec: o.newCodec,
        newProfile: o.profile,
        crypto: deps.crypto,
        plaintext: (op) =>
          !o.migrating
            ? 'reject'
            : op.clientId === o.rt.clientId
              ? 'void'
              : accepted.has(op.id)
                ? 'keep'
                : 'reject',
        onSetAside: (op, reason) => {
          const full = byId.get(op.id);
          if (full) aside.push({ op: full, reason });
        },
      }).catch((e: unknown) => {
        if (e instanceof CodecLockedError) throw forbidden('The encryption key is locked.');
        throw e;
      });
      try {
        await o.net.rotate(request);
      } catch (e) {
        // Another device pushed between our read and the swap: read again (bounded).
        if (e instanceof TransportError && e.kind === 'client' && attempt < 2) continue;
        throw e;
      }
      const known = new Set((await o.rt.store.listQuarantined()).map((q) => q.id));
      for (const { op, reason } of aside) {
        if (known.has(op.id)) continue; // this device already refused it and said why
        await o.rt.store.putQuarantined({
          id: op.id,
          entityType: op.entityType,
          entityId: op.entityId,
          reason: reason === 'unencrypted' ? 'plaintext_in_e2ee' : 'decrypt_failed',
          detail:
            'Stored on the server, but not proven to come from one of your devices. It was not carried into your encrypted history.',
          at: deps.now(),
          op,
        });
      }
      return aside.length;
    }
  }

  const service = {
    status,

    /** Resolves when no event-started run is in flight (tests, orderly shutdown). */
    async settled(): Promise<void> {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },

    /**
     * Store the server and provider. Changing either forgets the tokens issued for the old one, and
     * the encryption decision that was made for it.
     */
    async configure(input: SyncConfigInput): Promise<SyncStatusView> {
      let serverUrl: string;
      try {
        serverUrl = normaliseBaseUrl(input.serverUrl);
        assertSecureEndpoint(input.issuer, 'Issuer');
      } catch (e) {
        throw invalid(e instanceof Error ? e.message : 'The address is not valid.');
      }
      const issuer = input.issuer.replace(/\/+$/, '');
      const previous = await loadConfig();
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
        await clearTokens();
        await deps.discoveryCache.save(null);
        await deps.encryption.save(null);
        await lockKey();
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
        const rt = await getRuntime((await loadConfig())!);
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
      await lockKey();
      await clearTokens();
      try {
        const config = await loadConfig();
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
      // Pull-only until the person has chosen how uploads are protected (see runSync).
      background('sign-in');
      return { status: await status(), needsOrigins: [] };
    },

    async signOut(o: {
      wipeLocalData: boolean;
      revokeAtProvider: boolean;
    }): Promise<SyncStatusView> {
      const config = await loadConfig();
      await lockKey();
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
      await deps.tokenBinding.save(null);
      invalidate();
      if (o.wipeLocalData) {
        flag = false;
        await unschedule();
      }
      await publishStatus();
      return status();
    },

    /**
     * One run: record what was missed, pull, push. Never throws; the view says what happened.
     * Until the person has chosen how uploads are protected (a passphrase, or an explicit "upload
     * without end-to-end encryption") the run only pulls: nothing leaves the device.
     */
    async runSync(reason: string, o: { force?: boolean } = {}): Promise<SyncStatusView> {
      void reason;
      if (!(await isOn())) return status();
      const config = await loadConfig();
      if (!config) return status();
      await deps.exclusive(async () => {
        running = true;
        lastRunError = null;
        problem = null;
        await publishStatus();
        try {
          // A locked device touches neither the network nor the data: nothing to compare then.
          const unlocked = await ensureKey(config);
          const checked =
            config.e2ee && !unlocked ? { config, warning: null } : await checkProfile(config);
          if (checked.warning) {
            lastRunError = checked.warning;
            return;
          }
          const current = checked.config;
          const usable = current !== config ? await ensureKey(current) : unlocked;
          const rt = await getRuntime(current);
          if (await rt.isDirty()) await rt.reconcile();
          const enc = await deps.encryption.load();
          if (enc?.resend && usable) await resendOwnState(rt); // an interrupted set-up
          const mayPush = current.e2ee !== null || enc?.mode === 'plaintext';
          const options = {
            ...(o.force ? { force: true } : {}),
            ...(mayPush ? {} : { push: false }),
          };
          let report = await rt.engine.sync(options);
          for (let i = 1; report.more && i < MAX_PAGES; i++) report = await rt.engine.sync(options);
          lastRunError = reportToError(report);
          if (report.applied > 0) await deps.notifyDataChanged();
          if (report.status === 'idle') {
            await rt.engine.prune();
            // Changes that did not fit in the outbox are found by fingerprint now that it drained.
            if (await rt.isDirty()) background('continue');
          }
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

    // ---- how uploads are protected ----

    /**
     * The person's explicit choice to upload WITHOUT end-to-end encryption: the operator of the
     * server can read everything that is uploaded. Without this (or a passphrase) nothing is sent.
     */
    async uploadWithoutEncryption(): Promise<SyncStatusView> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      if (config.e2ee) {
        throw invalid('This account is end-to-end encrypted: unlock it with the passphrase.');
      }
      const enc = await deps.encryption.load();
      if (enc?.mode === 'e2ee') {
        throw invalid('End-to-end encryption was turned on for this account from this device.');
      }
      await deps.encryption.save({
        v: 1,
        mode: 'plaintext',
        profile: null,
        at: deps.now(),
        rekey: null,
        warning: null,
      });
      await publishStatus();
      background('encryption-choice');
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
      const before = await deps.encryption.load();
      if (before?.mode === 'e2ee') {
        throw invalid(
          'End-to-end encryption was turned on for this account from this device, but the server no longer has the key. Nothing was uploaded.',
        );
      }
      let created;
      try {
        created = await createKey({
          crypto: deps.crypto,
          passphrase,
          now: deps.now(),
          version: 1,
          extractable: true,
        });
      } catch (e) {
        if (e instanceof WeakPassphraseError) throw invalid(e.message);
        throw e;
      }
      const next = createPayloadCodec(deps.crypto);
      next.unlock(created.key, created.profile.kid);
      const rekeyed = await deps.exclusive(async () => {
        const rt = await getRuntime(config);
        return rekeyLog({
          rt,
          net,
          oldCodec: plaintextCodec,
          newCodec: next,
          profile: created.profile,
          migrating: true,
        });
      });
      if (rekeyed === null) throw invalid('Sync is busy right now. Try again in a moment.');
      const updated: StoredSyncConfig = {
        ...config,
        e2ee: { kid: created.profile.kid, version: created.profile.version },
      };
      await deps.config.save(updated);
      await deps.encryption.save({
        v: 1,
        mode: 'e2ee',
        profile: updated.e2ee,
        at: deps.now(),
        rekey: { kind: 'setup', at: deps.now(), setAside: rekeyed },
        warning: null,
        resend: true,
      });
      invalidate();
      await unlockWith(created.key, created.profile);
      await resendOwnState(await getRuntime(updated));
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
      const enc = await deps.encryption.load();
      if (!profile) {
        await setWarning(enc, downgradeWarning(enc, null));
        await publishStatus();
        return { ok: false, reason: 'no_key' };
      }
      const warning = await setWarning(enc, downgradeWarning(enc, profile));
      if (warning) {
        await publishStatus();
        return { ok: false, reason: 'no_key' };
      }
      let key: CryptoKey;
      try {
        key = await unlockKey({ crypto: deps.crypto, passphrase, profile, extractable: true });
      } catch (e) {
        if (e instanceof WrongPassphraseError) return { ok: false, reason: 'wrong_passphrase' };
        throw e;
      }
      const updated: StoredSyncConfig = {
        ...config,
        e2ee: { kid: profile.kid, version: profile.version },
      };
      await deps.config.save(updated);
      await deps.encryption.save({
        v: 1,
        mode: 'e2ee',
        profile: updated.e2ee,
        at: deps.now(),
        rekey: enc?.rekey ?? null,
        warning: null,
        ...(enc?.resend ? { resend: true } : {}),
      });
      invalidate();
      await unlockWith(key, profile);
      const rt = await getRuntime(updated);
      await rt.engine.retryQuarantined();
      await publishStatus();
      background('e2ee-unlock');
      return { ok: true, reason: null };
    },

    async e2eeLock(): Promise<SyncStatusView> {
      await lockKey();
      await publishStatus();
      return status();
    },

    async e2eeRotate(
      current: string,
      next: string,
    ): Promise<{
      ok: boolean;
      reason: 'wrong_passphrase' | 'no_key' | null;
      setAside?: number;
    }> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      const net = httpClient(config);
      const profile = await net.getKeyProfile();
      const enc = await deps.encryption.load();
      if (!profile) {
        await setWarning(enc, downgradeWarning(enc, null));
        await publishStatus();
        return { ok: false, reason: 'no_key' };
      }
      if (await setWarning(enc, downgradeWarning(enc, profile))) {
        await publishStatus();
        return { ok: false, reason: 'no_key' };
      }
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
          extractable: true,
        });
      } catch (e) {
        if (e instanceof WeakPassphraseError) throw invalid(e.message);
        throw e;
      }
      const oldCodec = createPayloadCodec(deps.crypto);
      oldCodec.unlock(oldKey, profile.kid);
      const newCodec = createPayloadCodec(deps.crypto);
      newCodec.unlock(created.key, created.profile.kid);

      const rekeyed = await deps.exclusive(async () => {
        const rt = await getRuntime(config);
        // Operations already encrypted for sending with the old key go back to plaintext in the
        // outbox; the push re-encrypts them with the new key. Before the swap, so a failure
        // leaves everything as it was.
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
        return rekeyLog({
          rt,
          net,
          oldCodec,
          newCodec,
          profile: created.profile,
          migrating: false,
        });
      });
      if (rekeyed === null) throw invalid('Sync is busy right now. Try again in a moment.');
      const updated: StoredSyncConfig = {
        ...config,
        e2ee: { kid: created.profile.kid, version: created.profile.version },
      };
      await deps.config.save(updated);
      await deps.encryption.save({
        v: 1,
        mode: 'e2ee',
        profile: updated.e2ee,
        at: deps.now(),
        rekey: { kind: 'rotate', at: deps.now(), setAside: rekeyed },
        warning: null,
        ...(enc?.resend ? { resend: true } : {}),
      });
      invalidate();
      await unlockWith(created.key, created.profile);
      await publishStatus();
      background('e2ee-rotate');
      return { ok: true, reason: null, setAside: rekeyed };
    },

    // ---- conflicts, quarantine ----

    async resolveConflict(id: string, decision: ConflictDecision): Promise<void> {
      const config = await requireConfig();
      if (!(await isOn())) throw invalid('Turn sync on first.');
      await ensureKey(config);
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
      await ensureKey(config);
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
      // The key profile went with it; this device's data is untouched. Starting over is the
      // person's explicit act, so the "encryption was enabled" marker and the decision go too.
      await lockKey();
      await deps.config.save({ ...config, e2ee: null });
      await deps.encryption.save(null);
      invalidate();
      const rt = await getRuntime((await loadConfig())!);
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
      if (name === ALARM_LOCK) {
        await lockKey();
        await publishStatus();
        return;
      }
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
        await lockKey();
        invalidate();
      }
    },
    async onStartup(): Promise<void> {
      if (!(await isOn())) return;
      await schedule();
      await service.runSync('startup');
    },
  };

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
      'sync.uploadPlain': async (_p, s) => (guard(s), service.uploadWithoutEncryption()),
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

/** Where the configuration lived before it moved to IndexedDB (chrome.storage.local). */
const LEGACY_CONFIG_KEY = 'syncConfig';
const TOKENS_KEY = 'syncTokens';
const BINDING_KEY = 'syncBinding';
const DISCOVERY_KEY = 'syncOidc';
const KEY_KEY = 'syncKey';
const STATUS_KEY = 'syncStatus';

interface KeyValueArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createSessionTokenStore(area: KeyValueArea): TokenStore {
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

/** The key vault over session storage: memory only, and (by default) trusted contexts only. */
export function createSessionKeyVault(area: KeyValueArea): SyncServiceDeps['keyVault'] {
  return {
    async load() {
      const parsed = StoredKey.safeParse((await area.get(KEY_KEY))[KEY_KEY]);
      return parsed.success ? parsed.data : null;
    },
    async save(key) {
      if (key) await area.set({ [KEY_KEY]: key });
      else await area.remove(KEY_KEY);
    },
  };
}

export function createSessionBinding(area: KeyValueArea): SyncServiceDeps['tokenBinding'] {
  return {
    async load() {
      const value = (await area.get(BINDING_KEY))[BINDING_KEY];
      return typeof value === 'string' ? value : null;
    },
    async save(binding) {
      if (binding !== null) await area.set({ [BINDING_KEY]: binding });
      else await area.remove(BINDING_KEY);
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
    // The authoritative copy, not the one a content script can write (see @runtime/settings).
    getSettings: getTrustedSettings,
    setFlag: async (enabled) => {
      await updateSettings((s) => ({ ...s, features: { ...s.features, sync: enabled } }));
    },
    config: {
      async load() {
        const parsed = StoredSyncConfig.safeParse(await readSyncPrivate('sync.config'));
        return parsed.success ? parsed.data : null;
      },
      async save(config) {
        await writeSyncPrivate('sync.config', config);
      },
    },
    legacyConfig: {
      async load() {
        const parsed = StoredSyncConfig.safeParse(
          (await local.get(LEGACY_CONFIG_KEY))[LEGACY_CONFIG_KEY],
        );
        return parsed.success ? parsed.data : null;
      },
      async clear() {
        await local.remove(LEGACY_CONFIG_KEY);
      },
    },
    encryption: {
      async load() {
        const parsed = StoredEncryption.safeParse(await readSyncPrivate('sync.encryption'));
        return parsed.success ? parsed.data : null;
      },
      async save(value) {
        await writeSyncPrivate('sync.encryption', value);
      },
    },
    tokens: createSessionTokenStore(session),
    tokenBinding: createSessionBinding(session),
    keyVault: createSessionKeyVault(session),
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
    // Nobody watches a sign-out: stop waiting after the time the old delete allowed. A blocked wipe
    // still finishes by itself (and says so); only this call gives up waiting for it.
    wipeLocalData: () => wipeAllData({ signal: AbortSignal.timeout(10_000) }),
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

  // Session storage holds tokens and the unwrapped key: keep it closed to content scripts (it is
  // by default; stated here so a later change of the default cannot expose it).
  const session = browser.storage.session as {
    setAccessLevel?: (o: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void>;
  };
  try {
    void Promise.resolve(session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(
      report,
    );
  } catch {
    /* no such call here: the default of this area is trusted contexts only */
  }

  registerSyncRpc(service, extensionBaseUrl);

  // Alarms exist only once the optional permission was granted; the API object may be absent.
  const onAlarm = (alarm: { name: string }) => {
    service.onAlarm(alarm.name).catch(report);
  };
  browser.alarms?.onAlarm.addListener(onAlarm);

  // The flag changing in another context (options page, wipe) and local data changing. The
  // payload of a storage event is writable by content scripts: re-read the authoritative copy.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('settings' in changes) {
      getTrustedSettings()
        .then((settings) => service.onSettings(settings))
        .catch(report);
    }
    if ('dataEpoch' in changes) service.onLocalChange().catch(report);
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
