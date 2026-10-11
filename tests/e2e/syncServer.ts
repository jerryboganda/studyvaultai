import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSyncServer, type LogEvent } from '../../server/src/app';
import { createJwtVerifier } from '../../server/src/auth';
import { DEFAULT_CONFIG } from '../../server/src/config';
import { JsonFileStore, type OpStore, type StoredOp } from '../../server/src/store';

/**
 * The two network peers of the sync e2e specs (tests/e2e/sync.spec.ts), both real HTTP servers on
 * 127.0.0.1 so the extension's service worker reaches them with its own `fetch`:
 *
 *  - `startFakeOidc`: an OpenID Connect provider with discovery, an authorisation endpoint that
 *    answers with the redirect to `https://<extension id>.chromiumapp.org/...` (which is what
 *    `chrome.identity.launchWebAuthFlow` waits for), PKCE (S256) checks, a token endpoint with
 *    authorisation-code and refresh-token grants, revocation, and a JWKS. Access tokens are ES256 JWTs.
 *  - `startSyncHarness`: the repository's reference server (`server/src`, the same code
 *    `server/src/main.ts` runs) over a JSON-file store, verifying those JWTs against that JWKS with
 *    `createJwtVerifier`: the production verification path, not the static development tokens the
 *    Node integration tests use.
 *
 * No Chrome API is faked anywhere: the extension calls the real chrome.identity and
 * chrome.permissions. What is not real is only the identity provider (a hosted one cannot be driven
 * from CI) and TLS (https is required for every non-loopback address).
 */

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url');

export interface FakeOidc {
  /** `http://127.0.0.1:PORT/idp`: exactly what a person types as the sign-in provider. */
  readonly issuer: string;
  readonly audience: string;
  readonly clientId: string;
  readonly subject: string;
  readonly jwksUri: string;
  /** Every request, "METHOD /path", in arrival order. */
  readonly requests: string[];
  /** Number of authorisation requests (interactive sign-ins). */
  signIns(): number;
  /** Token types the provider was asked to revoke ("refresh_token", "access_token"). */
  readonly revoked: string[];
  /** Make the refresh grant fail like a provider that ended the session. */
  failRefresh: boolean;
  close(): Promise<void>;
}

export async function startFakeOidc(
  o: { subject?: string; clientId?: string; audience?: string; accessTokenSeconds?: number } = {},
): Promise<FakeOidc> {
  const subject = o.subject ?? 'e2e-user-1';
  const clientId = o.clientId ?? 'studyvault-e2e-client';
  const audience = o.audience ?? 'studyvault-sync';
  const lifetime = o.accessTokenSeconds ?? 3600;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = 'e2e-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' };
  const jwt = (claims: Record<string, unknown>) => {
    const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(claims));
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${head}.${body}.${b64url(sig)}`;
  };

  const requests: string[] = [];
  const revoked: string[] = [];
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const state = { failRefresh: false };
  let signIns = 0;
  let issuer = '';

  const tokens = (nonce: string | null) => {
    const iat = Math.floor(Date.now() / 1000);
    return {
      access_token: jwt({
        iss: issuer,
        aud: audience,
        sub: subject,
        client_id: clientId,
        iat,
        exp: iat + lifetime,
      }),
      token_type: 'Bearer',
      expires_in: lifetime,
      id_token: jwt({
        iss: issuer,
        aud: clientId,
        sub: subject,
        iat,
        exp: iat + 3600,
        ...(nonce ? { nonce } : {}),
      }),
    };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://idp.invalid');
    requests.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const route = url.pathname.slice('/idp'.length);

    if (req.method === 'GET' && route === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        revocation_endpoint: `${issuer}/revoke`,
        jwks_uri: `${issuer}/jwks`,
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'],
      });
    }
    if (req.method === 'GET' && route === '/jwks') return json(200, { keys: [jwk] });

    if (req.method === 'GET' && route === '/authorize') {
      const q = url.searchParams;
      const redirect = q.get('redirect_uri') ?? '';
      const valid =
        q.get('response_type') === 'code' &&
        q.get('client_id') === clientId &&
        q.get('code_challenge_method') === 'S256' &&
        (q.get('code_challenge') ?? '') !== '' &&
        /^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(redirect);
      if (!valid) return json(400, { error: 'invalid_request' });
      signIns++;
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        nonce: q.get('nonce') ?? '',
        challenge: q.get('code_challenge') ?? '',
        redirectUri: redirect,
      });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (req.method === 'POST' && (route === '/token' || route === '/revoke')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        if (route === '/revoke') {
          revoked.push(form.get('token_type_hint') ?? '');
          refreshTokens.delete(form.get('token') ?? '');
          res.writeHead(200);
          return res.end();
        }
        if (form.get('grant_type') === 'authorization_code') {
          const issued = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          if (
            !issued ||
            form.get('client_id') !== clientId ||
            form.get('redirect_uri') !== issued.redirectUri ||
            sha256b64url(form.get('code_verifier') ?? '') !== issued.challenge
          ) {
            return json(400, { error: 'invalid_grant' });
          }
          const refresh = randomBytes(24).toString('hex');
          refreshTokens.add(refresh);
          return json(200, { ...tokens(issued.nonce), refresh_token: refresh });
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (state.failRefresh || !refreshTokens.has(form.get('refresh_token') ?? '')) {
            return json(400, { error: 'invalid_grant' });
          }
          return json(200, tokens(null));
        }
        return json(400, { error: 'unsupported_grant_type' });
      });
      return undefined;
    }
    return json(404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/idp`;

  return {
    issuer,
    audience,
    clientId,
    subject,
    jwksUri: `${issuer}/jwks`,
    requests,
    signIns: () => signIns,
    revoked,
    get failRefresh() {
      return state.failRefresh;
    },
    set failRefresh(value: boolean) {
      state.failRefresh = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface SyncHarness {
  /** `http://127.0.0.1:PORT`: what a person types as the sync server address. */
  readonly base: string;
  /** The directory the server keeps its log and key profile in. */
  readonly dataDir: string;
  /** What the server logged for each request (no tokens, no bodies). */
  readonly events: LogEvent[];
  /** Requests whose route is `route` ("POST /v1/ops"). */
  count(route: string): number;
  /** Operations the server holds for the test account, in server order. */
  stored(): Promise<StoredOp[]>;
  /** True when the account has a key profile on the server. */
  hasProfile(): Promise<boolean>;
  /** Stop answering (connections refused): the extension sees an unreachable server. */
  setOnline(online: boolean): Promise<void>;
  /**
   * Restart the server over the same data with the key profile file moved away (a server that was
   * reset, restored from an older copy or tampered with), or put back.
   */
  restart(o: { profile: 'removed' | 'present' }): Promise<void>;
  close(): Promise<void>;
}

export async function startSyncHarness(o: {
  idp: FakeOidc;
  /** `chrome-extension://<id>` of the extension under test. */
  extensionOrigin: string;
}): Promise<SyncHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyvault-sync-server-'));
  const events: LogEvent[] = [];
  const verifier = createJwtVerifier({
    issuer: o.idp.issuer,
    audience: o.idp.audience,
    jwksUri: o.idp.jwksUri,
    fetch,
  });
  const userDir = path.join(dataDir, createHash('sha256').update(o.idp.subject).digest('hex'));
  const profileFile = path.join(userDir, 'profile.json');
  const hidden = `${profileFile}.moved-away`;

  let store: OpStore = new JsonFileStore(dataDir);
  let server: http.Server | null = null;
  let port = 0;

  const listen = async () => {
    store = new JsonFileStore(dataDir); // a fresh process: nothing cached
    server = createSyncServer({
      config: {
        ...DEFAULT_CONFIG,
        port,
        corsOrigins: [o.extensionOrigin],
        // A test run is many requests in a short minute; the limiter is not what is under test.
        userRatePerMinute: 100_000,
        ipRatePerMinute: 100_000,
      },
      store,
      verifier,
      log: (e) => events.push(e),
    });
    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(port, '127.0.0.1', resolve);
    });
    port = (listening.address() as AddressInfo).port;
  };
  const stop = async () => {
    const closing = server;
    server = null;
    if (!closing) return;
    await new Promise<void>((resolve) => {
      closing.close(() => resolve());
      closing.closeAllConnections();
    });
  };

  await listen();
  const harness: SyncHarness = {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    events,
    count: (route) => events.filter((e) => e.event === 'request' && e.route === route).length,
    async stored() {
      const { ops } = await store.list(o.idp.subject, 0, 100_000, Number.MAX_SAFE_INTEGER);
      return ops;
    },
    async hasProfile() {
      return (await store.getProfile(o.idp.subject)) !== null;
    },
    async setOnline(online) {
      if (online && !server) await listen();
      if (!online) await stop();
    },
    async restart({ profile }) {
      await stop();
      if (profile === 'removed' && fs.existsSync(profileFile)) fs.renameSync(profileFile, hidden);
      if (profile === 'present' && fs.existsSync(hidden)) fs.renameSync(hidden, profileFile);
      await listen();
    },
    async close() {
      await stop();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  return harness;
}
