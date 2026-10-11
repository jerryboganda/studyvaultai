// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  AuthSession,
  beginAuthorization,
  createMemoryTokenStore,
  createPkcePair,
  discoverOidc,
  exchangeCode,
  parseCallback,
} from './auth.ts';
import type { OidcClientConfig, PendingAuth } from './auth.ts';
import { b64urlEncode } from './crypto.ts';

const crypto = webcrypto as unknown as Parameters<typeof createPkcePair>[0];
const ISSUER = 'https://id.example.test';
const config: OidcClientConfig = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  revocationEndpoint: `${ISSUER}/revoke`,
  clientId: 'studyvault-extension',
  redirectUri: 'https://abcdefghijklmnop.chromiumapp.org/oidc',
  scopes: ['openid', 'offline_access'],
};
const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.signature`;
}

function idToken(over: Record<string, unknown> = {}): string {
  return jwt({
    iss: ISSUER,
    sub: 'user-123',
    aud: config.clientId,
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000),
    ...over,
  });
}

interface Call {
  url: string;
  body: URLSearchParams;
  init: RequestInit;
}

/** A tiny identity provider: records form posts and answers from a queue. */
function provider(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body ?? '')), init });
    const next = responses.shift() ?? { status: 500, json: {} };
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const tokenJson = (over: Record<string, unknown> = {}) => ({
  access_token: 'access-1',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'refresh-1',
  id_token: idToken({ nonce: 'NONCE' }),
  ...over,
});

describe('PKCE and authorisation request', () => {
  it('S256 challenge is the hash of a 43-char verifier; state and nonce are random', async () => {
    const a = await createPkcePair(crypto);
    expect(a.verifier).toHaveLength(43);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a.verifier));
    expect(a.challenge).toBe(b64urlEncode(new Uint8Array(digest)));

    const r1 = await beginAuthorization({ config, crypto, now: NOW });
    const r2 = await beginAuthorization({ config, crypto, now: NOW });
    const u = new URL(r1.url);
    expect(u.origin + u.pathname).toBe(config.authorizationEndpoint);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(r1.pending.state);
    expect(u.searchParams.get('nonce')).toBe(r1.pending.nonce);
    expect(u.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(r1.pending.state).not.toBe(r2.pending.state);
    expect(r1.url).not.toContain(r1.pending.codeVerifier); // the verifier never travels on the URL
  });

  it('refuses insecure endpoints', async () => {
    await expect(
      beginAuthorization({
        config: { ...config, authorizationEndpoint: 'http://id.example.test/authorize' },
        crypto,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });
});

describe('callback validation', () => {
  const pending: PendingAuth = {
    state: 'STATE',
    nonce: 'NONCE',
    codeVerifier: 'v'.repeat(43),
    redirectUri: config.redirectUri,
    createdAt: NOW,
  };
  const ok = `${config.redirectUri}?code=abc&state=STATE`;
  const check = (url: string, at = NOW + 1000) =>
    parseCallback({ callbackUrl: url, pending, config, now: at });

  it('accepts a matching response', () => {
    expect(check(ok)).toEqual({ code: 'abc' });
    expect(check(`${ok}&iss=${encodeURIComponent(ISSUER)}`)).toEqual({ code: 'abc' });
  });

  it.each([
    ['wrong state', `${config.redirectUri}?code=abc&state=OTHER`, 'state_mismatch'],
    ['no state', `${config.redirectUri}?code=abc`, 'state_mismatch'],
    ['provider error', `${config.redirectUri}?error=access_denied&state=STATE`, 'provider_error'],
    ['other issuer', `${ok}&iss=https%3A%2F%2Fevil.test`, 'issuer_mismatch'],
    ['no code', `${config.redirectUri}?state=STATE`, 'missing_code'],
    ['other redirect', 'https://evil.test/oidc?code=abc&state=STATE', 'wrong_redirect'],
    [
      'other path',
      'https://abcdefghijklmnop.chromiumapp.org/other?code=a&state=STATE',
      'wrong_redirect',
    ],
  ])('rejects %s', (_name, url, code) => {
    expect(() => check(url)).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects an expired request', () => {
    expect(() => check(ok, NOW + 11 * 60 * 1000)).toThrowError(
      expect.objectContaining({ code: 'expired_request' }),
    );
  });
});

describe('token exchange and session', () => {
  const pending: PendingAuth = {
    state: 'STATE',
    nonce: 'NONCE',
    codeVerifier: 'v'.repeat(43),
    redirectUri: config.redirectUri,
    createdAt: NOW,
  };

  it('exchanges the code with the verifier, no secret, no cookies, and validates the ID token', async () => {
    const { calls, fetchFn } = provider([{ json: tokenJson() }]);
    const tokens = await exchangeCode({ config, code: 'abc', pending, fetch: fetchFn, now: NOW });
    expect(tokens.subject).toBe('user-123');
    expect(tokens.expiresAt).toBe(NOW + 3_600_000);
    const call = calls[0]!;
    expect(call.body.get('grant_type')).toBe('authorization_code');
    expect(call.body.get('code_verifier')).toBe(pending.codeVerifier);
    expect(call.body.has('client_secret')).toBe(false);
    expect(call.init.credentials).toBe('omit');
    expect(call.init.redirect).toBe('error');
  });

  it.each([
    ['nonce', { nonce: 'WRONG' }],
    ['audience', { nonce: 'NONCE', aud: 'another-client' }],
    ['issuer', { nonce: 'NONCE', iss: 'https://evil.test' }],
    ['expiry', { nonce: 'NONCE', exp: Math.floor(NOW / 1000) - 3600 }],
  ])('rejects an ID token with the wrong %s', async (_n, claims) => {
    const { fetchFn } = provider([{ json: tokenJson({ id_token: idToken(claims) }) }]);
    await expect(
      exchangeCode({ config, code: 'abc', pending, fetch: fetchFn, now: NOW }),
    ).rejects.toMatchObject({ code: 'invalid_id_token' });
  });

  it('signs in through the identity port and keeps tokens only in the supplied store', async () => {
    const idp = provider([]);
    const store = createMemoryTokenStore();
    let nonce = '';
    const fetchFn = (async (url: string, init: RequestInit) => {
      idp.calls.push({ url, body: new URLSearchParams(String(init.body)), init });
      return new Response(JSON.stringify(tokenJson({ id_token: idToken({ nonce }) })), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const session = new AuthSession({ config, store, fetch: fetchFn, crypto, now: () => NOW });
    const tokens = await session.signIn({
      launchWebAuthFlow: async ({ url }) => {
        const u = new URL(url);
        nonce = u.searchParams.get('nonce')!;
        return `${config.redirectUri}?code=abc&state=${u.searchParams.get('state')}`;
      },
    });
    expect(store.peek()).toEqual(tokens);
    expect(await session.accountId()).toBe('user-123');
    expect(await session.getAccessToken()).toBe('access-1');
  });

  it('refreshes shortly before expiry, once even for concurrent callers', async () => {
    const now = { t: NOW };
    const store = createMemoryTokenStore();
    store.save({
      accessToken: 'old',
      tokenType: 'Bearer',
      expiresAt: NOW + 30_000,
      refreshToken: 'refresh-1',
      idToken: null,
      scope: null,
      subject: 'user-123',
    });
    const idp = provider([
      {
        json: { access_token: 'new', token_type: 'Bearer', expires_in: 3600, id_token: idToken() },
      },
    ]);
    const session = new AuthSession({
      config,
      store,
      fetch: idp.fetchFn,
      crypto,
      now: () => now.t,
    });
    const [a, b] = await Promise.all([session.getAccessToken(), session.getAccessToken()]);
    expect([a, b]).toEqual(['new', 'new']);
    expect(idp.calls).toHaveLength(1);
    expect(idp.calls[0]!.body.get('grant_type')).toBe('refresh_token');
    expect(store.peek()!.refreshToken).toBe('refresh-1'); // kept when the provider omits it
  });

  it('a dead refresh token ends the session instead of looping', async () => {
    const store = createMemoryTokenStore();
    store.save({
      accessToken: 'old',
      tokenType: 'Bearer',
      expiresAt: NOW - 1,
      refreshToken: 'dead',
      idToken: null,
      scope: null,
      subject: 'user-123',
    });
    const idp = provider([{ status: 400, json: { error: 'invalid_grant' } }]);
    const session = new AuthSession({ config, store, fetch: idp.fetchFn, crypto, now: () => NOW });
    expect(await session.getAccessToken()).toBeNull();
    expect(store.peek()).toBeNull();
  });

  it('refuses a refreshed token that belongs to another account', async () => {
    const store = createMemoryTokenStore();
    store.save({
      accessToken: 'old',
      tokenType: 'Bearer',
      expiresAt: NOW - 1,
      refreshToken: 'r',
      idToken: null,
      scope: null,
      subject: 'user-123',
    });
    const idp = provider([
      {
        json: {
          access_token: 'x',
          token_type: 'Bearer',
          expires_in: 60,
          id_token: idToken({ sub: 'someone-else' }),
        },
      },
    ]);
    const session = new AuthSession({ config, store, fetch: idp.fetchFn, crypto, now: () => NOW });
    expect(await session.getAccessToken()).toBeNull(); // AuthError -> session cleared
    expect(store.peek()).toBeNull();
  });

  it('sign-out clears the tokens whatever else fails, and wipes local data only when asked', async () => {
    const store = createMemoryTokenStore();
    const seed = {
      accessToken: 'access-9',
      tokenType: 'Bearer' as const,
      expiresAt: NOW + 3_600_000,
      refreshToken: 'refresh-9',
      idToken: null,
      scope: null,
      subject: 'user-123',
    };
    store.save(seed);
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const session = new AuthSession({ config, store, fetch: failing, crypto, now: () => NOW });
    let wiped = 0;
    const result = await session.signOut({ revoke: true });
    expect(result).toEqual({ tokensCleared: true, revoked: false, localDataCleared: false });
    expect(store.peek()).toBeNull();
    expect(await session.getAccessToken()).toBeNull();
    expect(await session.isSignedIn()).toBe(false);

    store.save(seed);
    const idp = provider([{ json: {} }, { json: {} }]);
    const s2 = new AuthSession({ config, store, fetch: idp.fetchFn, crypto, now: () => NOW });
    const r2 = await s2.signOut({ revoke: true, wipeLocalData: async () => void wiped++ });
    expect(r2).toEqual({ tokensCleared: true, revoked: true, localDataCleared: true });
    expect(wiped).toBe(1);
    expect(idp.calls.map((c) => c.body.get('token_type_hint'))).toEqual([
      'refresh_token',
      'access_token',
    ]);
    expect(store.peek()).toBeNull();
  });
});

describe('discovery', () => {
  it('requires the document to name the issuer that was asked for', async () => {
    const doc = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      code_challenge_methods_supported: ['S256'],
    };
    const good = provider([{ json: doc }]);
    expect((await discoverOidc(ISSUER, good.fetchFn)).tokenEndpoint).toBe(`${ISSUER}/token`);
    const mixed = provider([{ json: { ...doc, issuer: 'https://evil.test' } }]);
    await expect(discoverOidc(ISSUER, mixed.fetchFn)).rejects.toBeInstanceOf(AuthError);
    const noPkce = provider([{ json: { ...doc, code_challenge_methods_supported: ['plain'] } }]);
    await expect(discoverOidc(ISSUER, noPkce.fetchFn)).rejects.toBeInstanceOf(AuthError);
    await expect(discoverOidc('http://id.example.test', good.fetchFn)).rejects.toMatchObject({
      code: 'insecure_endpoint',
    });
  });
});
