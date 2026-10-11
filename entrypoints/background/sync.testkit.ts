/**
 * Test doubles for the sync service (never imported by production code): a stand-in OIDC provider
 * that issues real-looking tokens through the real PKCE flow, and in-memory ports. The sync
 * SERVER is not faked: tests start the reference server from server/src/testing.ts.
 */
import { createMemoryTokenStore, type IdentityPort, type OidcEndpoints } from '@sync';
import type { Settings } from '@shared';
import { defaultSettings } from '@shared';
import type {
  AlarmsPort,
  StoredEncryption,
  StoredKey,
  StoredSyncConfig,
  SyncServiceDeps,
} from './sync';

const b64url = (text: string) =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export interface FakeProvider {
  issuer: string;
  clientId: string;
  redirectUrl: string;
  /** Requests the provider received, "METHOD path". */
  requests: string[];
  /** Number of interactive sign-ins. */
  signIns: number;
  /** Change it to simulate a provider that rejects the refresh token. */
  refreshFails: boolean;
  fetch: typeof fetch;
  identity: IdentityPort;
}

/** `passthrough` receives every request that is not for the provider (the sync server). */
export function fakeProvider(o: {
  issuer: string;
  clientId: string;
  accessToken: string;
  subject: string;
  redirectUrl: string;
  now(): number;
  passthrough: typeof fetch;
  expiresInSeconds?: number;
}): FakeProvider {
  const nonces = new Map<string, string>();
  let codes = 0;
  const provider: FakeProvider = {
    issuer: o.issuer,
    clientId: o.clientId,
    redirectUrl: o.redirectUrl,
    requests: [],
    signIns: 0,
    refreshFails: false,
    fetch: undefined as never,
    identity: undefined as never,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const idToken = (nonce: string | null) => {
    const iat = Math.floor(o.now() / 1000);
    const claims = {
      iss: o.issuer,
      sub: o.subject,
      aud: o.clientId,
      iat,
      exp: iat + 3600,
      ...(nonce ? { nonce } : {}),
    };
    return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.${b64url('sig')}`;
  };

  provider.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(o.issuer)) return o.passthrough(input, init);
    const path = url.slice(o.issuer.length);
    provider.requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/.well-known/openid-configuration') {
      return json({
        issuer: o.issuer,
        authorization_endpoint: `${o.issuer}/authorize`,
        token_endpoint: `${o.issuer}/token`,
        revocation_endpoint: `${o.issuer}/revoke`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (path === '/revoke') return new Response(null, { status: 200 });
    if (path === '/token') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (form.get('grant_type') === 'authorization_code') {
        const nonce = nonces.get(form.get('code') ?? '') ?? null;
        if (nonce === null || !form.get('code_verifier'))
          return json({ error: 'invalid_grant' }, 400);
        return json({
          access_token: o.accessToken,
          token_type: 'Bearer',
          expires_in: o.expiresInSeconds ?? 3600,
          refresh_token: 'refresh-token-1',
          id_token: idToken(nonce),
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (provider.refreshFails) return json({ error: 'invalid_grant' }, 400);
        return json({
          access_token: o.accessToken,
          token_type: 'Bearer',
          expires_in: o.expiresInSeconds ?? 3600,
          id_token: idToken(null),
        });
      }
    }
    return json({ error: 'not_found' }, 404);
  };

  provider.identity = {
    async launchWebAuthFlow({ url }) {
      const authorize = new URL(url);
      if (authorize.origin + authorize.pathname !== `${o.issuer}/authorize`) {
        throw new Error('unexpected authorization endpoint');
      }
      if (authorize.searchParams.get('code_challenge_method') !== 'S256') {
        throw new Error('PKCE is required');
      }
      provider.signIns++;
      const code = `code-${++codes}`;
      nonces.set(code, authorize.searchParams.get('nonce') ?? '');
      const back = new URL(o.redirectUrl);
      back.searchParams.set('code', code);
      back.searchParams.set('state', authorize.searchParams.get('state') ?? '');
      return back.toString();
    },
  };
  return provider;
}

type AlarmInfo = { delayInMinutes?: number; when?: number; periodInMinutes?: number };

export interface FakeAlarms extends AlarmsPort {
  names(): string[];
  scheduled: Map<string, AlarmInfo>;
}

export function fakeAlarms(): FakeAlarms {
  const scheduled = new Map<string, AlarmInfo>();
  return {
    scheduled,
    names: () => [...scheduled.keys()],
    async create(name, info) {
      scheduled.set(name, info);
    },
    async clear(name) {
      return scheduled.delete(name);
    },
    async get(name) {
      return scheduled.has(name) ? { name } : undefined;
    },
  };
}

/**
 * Everything a service needs except the database runtime. `settings` is plain state the test can
 * read; `granted` holds the origins and permissions "Chrome" has granted.
 */
export function memoryDeps(o: {
  issuer: string;
  provider: FakeProvider;
  redirectUrl: string;
  alarms?: AlarmsPort | null;
  now?: () => number;
  initial?: Partial<Settings['features']>;
}) {
  let settings: Settings = {
    ...defaultSettings(),
    features: { ...defaultSettings().features, ...o.initial },
  };
  let config: StoredSyncConfig | null = null;
  /** The copy a content script could plant in chrome.storage.local (never trusted by the service). */
  let legacy: StoredSyncConfig | null = null;
  let encryption: StoredEncryption | null = null;
  let binding: string | null = null;
  let key: StoredKey | null = null;
  let discovery: OidcEndpoints | null = null;
  const tokens = createMemoryTokenStore();
  const published: unknown[] = [];
  const granted = {
    origins: new Set<string>(),
    permissions: new Set<'identity' | 'alarms'>(['identity', 'alarms']),
  };
  let wipes = 0;
  const base: Omit<
    SyncServiceDeps,
    'createRuntime' | 'attention' | 'notifyDataChanged' | 'crypto' | 'fetch'
  > = {
    now: o.now ?? (() => Date.now()),
    getSettings: async () => structuredClone(settings),
    setFlag: async (enabled) => {
      settings = { ...settings, features: { ...settings.features, sync: enabled } };
    },
    config: {
      load: async () => (config ? structuredClone(config) : null),
      save: async (c) => {
        config = c ? structuredClone(c) : null;
      },
    },
    legacyConfig: {
      load: async () => (legacy ? structuredClone(legacy) : null),
      clear: async () => {
        legacy = null;
      },
    },
    encryption: {
      load: async () => (encryption ? structuredClone(encryption) : null),
      save: async (e) => {
        encryption = e ? structuredClone(e) : null;
      },
    },
    tokens,
    tokenBinding: {
      load: async () => binding,
      save: async (b) => {
        binding = b;
      },
    },
    keyVault: {
      load: async () => (key ? structuredClone(key) : null),
      save: async (k) => {
        key = k ? structuredClone(k) : null;
      },
    },
    discoveryCache: {
      load: async () => discovery,
      save: async (e) => {
        discovery = e;
      },
    },
    identity: o.provider.identity,
    redirectUrl: () => o.redirectUrl,
    hasOrigins: async (origins) => origins.every((x) => granted.origins.has(x)),
    hasPermission: async (p) => granted.permissions.has(p),
    alarms: () => (o.alarms === undefined ? null : o.alarms),
    publish: async (view) => {
      published.push(view);
    },
    exclusive: async (fn) => fn(),
    wipeLocalData: async () => {
      wipes++;
    },
    keyLockMs: 60_000,
    setTimer: () => () => undefined,
  };
  return {
    base,
    tokens,
    granted,
    published,
    get settings() {
      return settings;
    },
    get config() {
      return config;
    },
    get legacyConfig() {
      return legacy;
    },
    /** What a content script could write into chrome.storage.local. */
    plantLegacyConfig(c: StoredSyncConfig | null) {
      legacy = c;
    },
    get encryption() {
      return encryption;
    },
    get key() {
      return key;
    },
    get binding() {
      return binding;
    },
    /** Pretend tokens exist that were issued for another configuration. */
    setBinding(b: string | null) {
      binding = b;
    },
    get wipes() {
      return wipes;
    },
  };
}
