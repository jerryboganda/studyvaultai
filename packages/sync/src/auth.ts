import './zodConfig.ts';
import { z } from 'zod';
import { b64urlDecode, b64urlEncode } from './crypto.ts';
import type { CryptoLike } from './crypto.ts';
import { TransportError } from './ports.ts';

/**
 * OIDC authorization-code flow with PKCE, as plain functions over injected `fetch` and `crypto`. No
 * vendor SDK, no storage of its own: tokens live only in the TokenStore the caller provides, which
 * must be memory or session-scoped (chrome.storage.session), never chrome.storage.sync/local.
 *
 * Extension integration (out of scope here, specified by IdentityPort): `launchWebAuthFlow` is
 * `chrome.identity.launchWebAuthFlow({ url, interactive: true })` and the redirect URI is
 * `chrome.identity.getRedirectURL()`. Both need the "identity" permission, requested only when the
 * user turns sync on. The provider must allow that exact redirect URI for a public (no secret) client.
 *
 * ID token note: the token is received straight from the token endpoint over TLS, so per OIDC Core
 * 3.1.3.7(6) the issuer is authenticated by TLS and its signature is not re-verified here; every claim
 * (iss, aud, azp, exp, iat, nonce, sub) is. The sync server verifies the access token independently.
 */

export type AuthErrorCode =
  | 'insecure_endpoint'
  | 'discovery_failed'
  | 'provider_error'
  | 'state_mismatch'
  | 'issuer_mismatch'
  | 'missing_code'
  | 'wrong_redirect'
  | 'expired_request'
  | 'token_exchange_failed'
  | 'invalid_token_response'
  | 'invalid_id_token'
  | 'reauth_required'
  | 'subject_changed';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

export interface OidcClientConfig extends OidcEndpoints {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
}

/** What must survive between starting the flow and the redirect (session-scoped storage). */
export interface PendingAuth {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

export interface TokenSet {
  accessToken: string;
  tokenType: 'Bearer';
  /** Epoch ms. */
  expiresAt: number;
  refreshToken: string | null;
  idToken: string | null;
  scope: string | null;
  /** OIDC `sub`: the account these tokens (and the synced data) belong to. */
  subject: string | null;
}

export interface TokenStore {
  load(): Promise<TokenSet | null> | TokenSet | null;
  save(tokens: TokenSet): Promise<void> | void;
  clear(): Promise<void> | void;
}

/** The part of the extension platform the flow needs (chrome.identity). */
export interface IdentityPort {
  /** Resolve with the final redirect URL the provider sent the user to. */
  launchWebAuthFlow(request: { url: string; interactive: boolean }): Promise<string>;
}

export function createMemoryTokenStore(): TokenStore & { peek(): TokenSet | null } {
  let tokens: TokenSet | null = null;
  return {
    peek: () => tokens,
    load: () => tokens,
    save: (t) => {
      tokens = t;
    },
    clear: () => {
      tokens = null;
    },
  };
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

export function assertSecureEndpoint(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthError('insecure_endpoint', `${label} is not a valid URL.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new AuthError('insecure_endpoint', `${label} must use https.`);
  }
  if (url.username || url.password || url.hash) {
    throw new AuthError(
      'insecure_endpoint',
      `${label} must not contain credentials or a fragment.`,
    );
  }
  return url;
}

const Discovery = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

/** Read the provider's endpoints. The returned issuer must equal the one asked for (mix-up defence). */
export async function discoverOidc(issuer: string, fetchFn: typeof fetch): Promise<OidcEndpoints> {
  assertSecureEndpoint(issuer, 'Issuer');
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetchFn(url, { credentials: 'omit', redirect: 'error', cache: 'no-store' });
  } catch {
    throw new AuthError('discovery_failed', 'The identity provider could not be reached.');
  }
  if (!res.ok) throw new AuthError('discovery_failed', `Discovery failed (HTTP ${res.status}).`);
  const doc = Discovery.safeParse(await res.json().catch(() => null));
  if (!doc.success || doc.data.issuer !== issuer) {
    throw new AuthError(
      'discovery_failed',
      'Discovery document is invalid or names another issuer.',
    );
  }
  const d = doc.data;
  if (d.code_challenge_methods_supported && !d.code_challenge_methods_supported.includes('S256')) {
    throw new AuthError('discovery_failed', 'The provider does not support PKCE S256.');
  }
  assertSecureEndpoint(d.authorization_endpoint, 'Authorization endpoint');
  assertSecureEndpoint(d.token_endpoint, 'Token endpoint');
  if (d.revocation_endpoint) assertSecureEndpoint(d.revocation_endpoint, 'Revocation endpoint');
  return {
    issuer: d.issuer,
    authorizationEndpoint: d.authorization_endpoint,
    tokenEndpoint: d.token_endpoint,
    revocationEndpoint: d.revocation_endpoint,
  };
}

function randomToken(crypto: CryptoLike, bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function createPkcePair(
  crypto: CryptoLike,
): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(crypto); // 43 chars of base64url, within RFC 7636 (43..128)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64urlEncode(new Uint8Array(digest)) };
}

/** Build the authorisation URL. Persist `pending` (session storage) until the redirect comes back. */
export async function beginAuthorization(o: {
  config: OidcClientConfig;
  crypto: CryptoLike;
  now: number;
}): Promise<{ url: string; pending: PendingAuth }> {
  const { config } = o;
  const endpoint = assertSecureEndpoint(config.authorizationEndpoint, 'Authorization endpoint');
  assertSecureEndpoint(config.redirectUri, 'Redirect URI');
  const { verifier, challenge } = await createPkcePair(o.crypto);
  const pending: PendingAuth = {
    state: randomToken(o.crypto),
    nonce: randomToken(o.crypto),
    codeVerifier: verifier,
    redirectUri: config.redirectUri,
    createdAt: o.now,
  };
  endpoint.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url: endpoint.toString(), pending };
}

function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Validate the redirect the provider sent back and return the authorisation code. */
export function parseCallback(o: {
  callbackUrl: string;
  pending: PendingAuth;
  config: OidcClientConfig;
  now: number;
}): { code: string } {
  const { pending, config } = o;
  if (o.now - pending.createdAt > PENDING_TTL_MS || o.now < pending.createdAt) {
    throw new AuthError('expired_request', 'The sign-in request expired. Start again.');
  }
  let url: URL;
  try {
    url = new URL(o.callbackUrl);
  } catch {
    throw new AuthError('wrong_redirect', 'The redirect is not a URL.');
  }
  const expected = new URL(pending.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new AuthError(
      'wrong_redirect',
      'The redirect does not match the registered redirect URI.',
    );
  }
  const p = url.searchParams;
  const state = p.get('state');
  if (state === null || !equalConstantTime(state, pending.state)) {
    throw new AuthError('state_mismatch', 'The sign-in response does not belong to this request.');
  }
  const error = p.get('error');
  if (error) {
    // Provider text is untrusted: length-limited, never rendered as markup by callers.
    throw new AuthError(
      'provider_error',
      `The identity provider refused sign-in (${error.slice(0, 64)}).`,
    );
  }
  const iss = p.get('iss');
  if (iss !== null && iss !== config.issuer) {
    throw new AuthError('issuer_mismatch', 'The response came from a different issuer.');
  }
  const code = p.get('code');
  if (!code) throw new AuthError('missing_code', 'The sign-in response has no authorisation code.');
  return { code };
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((t) => t.toLowerCase() === 'bearer', 'unsupported token type'),
  expires_in: z
    .number()
    .positive()
    .max(24 * 60 * 60)
    .optional(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const IdClaims = z.object({
  iss: z.string(),
  sub: z.string().min(1).max(256),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number().optional(),
  nonce: z.string().optional(),
  azp: z.string().optional(),
});

function idTokenClaims(
  idToken: string,
  config: OidcClientConfig,
  now: number,
  expectedNonce: string | null,
): z.infer<typeof IdClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new AuthError('invalid_id_token', 'The ID token is malformed.');
  let claims;
  try {
    claims = IdClaims.parse(JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]!))));
  } catch {
    throw new AuthError('invalid_id_token', 'The ID token claims are malformed.');
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer)
    throw new AuthError('invalid_id_token', 'ID token issuer mismatch.');
  if (!aud.includes(config.clientId))
    throw new AuthError('invalid_id_token', 'ID token audience mismatch.');
  if (aud.length > 1 && claims.azp !== config.clientId) {
    throw new AuthError('invalid_id_token', 'ID token authorised party mismatch.');
  }
  if (claims.exp * 1000 < now - CLOCK_SKEW_MS)
    throw new AuthError('invalid_id_token', 'ID token expired.');
  if (claims.iat !== undefined && claims.iat * 1000 > now + CLOCK_SKEW_MS) {
    throw new AuthError('invalid_id_token', 'ID token issued in the future.');
  }
  if (
    expectedNonce !== null &&
    (claims.nonce === undefined || !equalConstantTime(claims.nonce, expectedNonce))
  ) {
    throw new AuthError('invalid_id_token', 'ID token nonce mismatch.');
  }
  return claims;
}

async function postForm(
  endpoint: string,
  fields: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new TransportError('network', 'The identity provider could not be reached.');
  }
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

function toTokenSet(
  response: z.infer<typeof TokenResponse>,
  config: OidcClientConfig,
  now: number,
  nonce: string | null,
  previous: TokenSet | null,
): TokenSet {
  let subject = previous?.subject ?? null;
  if (response.id_token) {
    const claims = idTokenClaims(response.id_token, config, now, nonce);
    if (previous?.subject && previous.subject !== claims.sub) {
      throw new AuthError('subject_changed', 'The refreshed token belongs to a different account.');
    }
    subject = claims.sub;
  } else if (nonce !== null && config.scopes.includes('openid')) {
    throw new AuthError('invalid_id_token', 'The provider returned no ID token.');
  }
  return {
    accessToken: response.access_token,
    tokenType: 'Bearer',
    expiresAt: now + (response.expires_in ?? 300) * 1000,
    // Providers may omit the refresh token on refresh: keep the one we have.
    refreshToken: response.refresh_token ?? previous?.refreshToken ?? null,
    idToken: response.id_token ?? previous?.idToken ?? null,
    scope: response.scope ?? previous?.scope ?? null,
    subject,
  };
}

/** Exchange the authorisation code (with the PKCE verifier) for tokens. */
export async function exchangeCode(o: {
  config: OidcClientConfig;
  code: string;
  pending: PendingAuth;
  fetch: typeof fetch;
  now: number;
}): Promise<TokenSet> {
  assertSecureEndpoint(o.config.tokenEndpoint, 'Token endpoint');
  const res = await postForm(
    o.config.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: o.code,
      redirect_uri: o.pending.redirectUri,
      client_id: o.config.clientId,
      code_verifier: o.pending.codeVerifier,
    },
    o.fetch,
  );
  if (!res.ok)
    throw new AuthError('token_exchange_failed', `Token exchange failed (HTTP ${res.status}).`);
  const parsed = TokenResponse.safeParse(res.json);
  if (!parsed.success)
    throw new AuthError('invalid_token_response', 'The token response is invalid.');
  return toTokenSet(parsed.data, o.config, o.now, o.pending.nonce, null);
}

export async function refreshTokens(o: {
  config: OidcClientConfig;
  tokens: TokenSet;
  fetch: typeof fetch;
  now: number;
}): Promise<TokenSet> {
  if (!o.tokens.refreshToken)
    throw new AuthError('reauth_required', 'No refresh token: sign in again.');
  const res = await postForm(
    o.config.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: o.tokens.refreshToken,
      client_id: o.config.clientId,
    },
    o.fetch,
  );
  if (!res.ok) {
    // 400/401 invalid_grant: the refresh token is dead. Anything else may be transient.
    if (res.status === 400 || res.status === 401) {
      throw new AuthError('reauth_required', 'The session ended. Sign in again.');
    }
    throw new TransportError(
      'server',
      `Token refresh failed (HTTP ${res.status}).`,
      undefined,
      res.status,
    );
  }
  const parsed = TokenResponse.safeParse(res.json);
  if (!parsed.success)
    throw new AuthError('invalid_token_response', 'The token response is invalid.');
  return toTokenSet(parsed.data, o.config, o.now, null, o.tokens);
}

export interface SignOutResult {
  tokensCleared: true;
  /** null when no revocation endpoint exists or it was not asked for. */
  revoked: boolean | null;
  localDataCleared: boolean;
}

/**
 * Keeps tokens in the injected store, refreshes them single-flight, and signs out. `getAccessToken`
 * and `accountId` plug straight into createHttpTransport and the engine.
 */
export class AuthSession {
  private refreshing: Promise<TokenSet | null> | null = null;

  constructor(
    private readonly o: {
      config: OidcClientConfig;
      store: TokenStore;
      fetch: typeof fetch;
      crypto: CryptoLike;
      now(): number;
      /** Reads Settings.features.sync: no sign-in and no token use while it is false. */
      isEnabled?: () => boolean | Promise<boolean>;
    },
  ) {}

  private async enabled(): Promise<boolean> {
    return this.o.isEnabled ? Boolean(await this.o.isEnabled()) : true;
  }

  /** Interactive sign-in through the platform identity port; stores the tokens on success. */
  async signIn(identity: IdentityPort): Promise<TokenSet> {
    if (!(await this.enabled())) throw new Error('Sync is turned off.');
    const { config } = this.o;
    const { url, pending } = await beginAuthorization({
      config,
      crypto: this.o.crypto,
      now: this.o.now(),
    });
    const callbackUrl = await identity.launchWebAuthFlow({ url, interactive: true });
    const { code } = parseCallback({ callbackUrl, pending, config, now: this.o.now() });
    const tokens = await exchangeCode({
      config,
      code,
      pending,
      fetch: this.o.fetch,
      now: this.o.now(),
    });
    await this.o.store.save(tokens);
    return tokens;
  }

  async accountId(): Promise<string | null> {
    return (await this.o.store.load())?.subject ?? null;
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.o.store.load()) !== null;
  }

  /** A valid access token, refreshing when it is about to expire; null when signed out. */
  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    if (!(await this.enabled())) return null;
    const tokens = await this.o.store.load();
    if (!tokens) return null;
    const stale = tokens.expiresAt - this.o.now() < REFRESH_MARGIN_MS;
    if (!options.forceRefresh && !stale) return tokens.accessToken;
    if (!tokens.refreshToken) return stale ? null : tokens.accessToken;
    try {
      const fresh = await this.refresh(tokens);
      return fresh?.accessToken ?? null;
    } catch (e) {
      // Transient failure: a token that has not actually expired is still good.
      if (e instanceof TransportError && tokens.expiresAt > this.o.now()) return tokens.accessToken;
      throw e;
    }
  }

  private refresh(tokens: TokenSet): Promise<TokenSet | null> {
    this.refreshing ??= (async () => {
      try {
        const fresh = await refreshTokens({
          config: this.o.config,
          tokens,
          fetch: this.o.fetch,
          now: this.o.now(),
        });
        await this.o.store.save(fresh);
        return fresh;
      } catch (e) {
        if (e instanceof AuthError) {
          await this.o.store.clear(); // dead session: nothing usable remains
          return null;
        }
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /**
   * Tokens are always cleared, whatever else fails. `revoke` asks the provider to invalidate them
   * (best effort). `wipeLocalData` is the user's choice to also erase this device's data; omit it to
   * keep local data (it stays usable offline and re-attaches to the same account on next sign-in).
   */
  async signOut(
    options: { revoke?: boolean; wipeLocalData?: () => Promise<void> } = {},
  ): Promise<SignOutResult> {
    const tokens = await this.o.store.load();
    let revoked: boolean | null = null;
    try {
      const endpoint = this.o.config.revocationEndpoint;
      if (options.revoke && tokens && endpoint) {
        revoked = false;
        const targets: [string, string][] = [];
        if (tokens.refreshToken) targets.push([tokens.refreshToken, 'refresh_token']);
        targets.push([tokens.accessToken, 'access_token']);
        for (const [token, hint] of targets) {
          const res = await postForm(
            endpoint,
            { token, token_type_hint: hint, client_id: this.o.config.clientId },
            this.o.fetch,
          ).catch(() => null);
          if (res?.ok) revoked = true;
        }
      }
    } finally {
      await this.o.store.clear();
    }
    let localDataCleared = false;
    if (options.wipeLocalData) {
      await options.wipeLocalData();
      localDataCleared = true;
    }
    return { tokensCleared: true, revoked, localDataCleared };
  }
}
