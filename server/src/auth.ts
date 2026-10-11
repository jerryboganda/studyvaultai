import { createPublicKey, timingSafeEqual, verify as cryptoVerify, createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Token verification is an injected function: the protocol layer only ever sees `{ userId }`.
 * Two implementations ship:
 *  - `staticTokenVerifier`: development only (tokens from the environment).
 *  - `createJwtVerifier`: OIDC access tokens (JWT, RS256 or ES256) against the provider's JWKS.
 * Anything else (opaque tokens + introspection, API gateway headers...) is another small function.
 */

export interface Principal {
  /** Stable, provider-scoped account id (OIDC `sub`). Every row is keyed by it. */
  userId: string;
}

export type TokenVerifier = (token: string) => Promise<Principal | null>;

const USER_ID = /^[\x21-\x7e]{1,255}$/;

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID.test(value);
}

/** DEV ONLY. `entries` maps bearer token -> user id. Compared in constant time. */
export function staticTokenVerifier(entries: ReadonlyMap<string, string>): TokenVerifier {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const table = [...entries].map(([token, userId]) => ({ hash: digest(token), userId }));
  return async (token) => {
    const probe = digest(token);
    let found: string | null = null;
    for (const e of table) if (timingSafeEqual(e.hash, probe)) found = e.userId;
    return found && isValidUserId(found) ? { userId: found } : null;
  };
}

const b64url = (s: string) => Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64');

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  crv?: string;
  [k: string]: unknown;
}

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  fetch: typeof fetch;
  /** Epoch ms. */
  now?: () => number;
  clockSkewSec?: number;
  /** How long a fetched key set is trusted. */
  jwksTtlMs?: number;
  /** Minimum gap between re-fetches triggered by unknown key ids (flood protection). */
  minRefetchMs?: number;
}

const ALGS = {
  RS256: { kty: 'RSA' },
  ES256: { kty: 'EC', crv: 'P-256' },
} as const;

/**
 * Verifies a signed JWT access token: algorithm allow-list (RS256/ES256; "none" and every HMAC
 * algorithm are refused, which closes the key-confusion attack), signature against the provider's
 * published key for the token's `kid`, then iss, aud, exp, nbf and sub.
 */
export function createJwtVerifier(o: JwtVerifierOptions): TokenVerifier {
  const now = o.now ?? Date.now;
  const skew = (o.clockSkewSec ?? 60) * 1000;
  const ttl = o.jwksTtlMs ?? 10 * 60 * 1000;
  const minGap = o.minRefetchMs ?? 60 * 1000;
  let keys = new Map<string, { jwk: Jwk; key: KeyObject }>();
  let fetchedAt = 0;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    inFlight ??= (async () => {
      try {
        const res = await o.fetch(o.jwksUri, {
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
        if (!res.ok) return;
        const body = (await res.json()) as { keys?: Jwk[] };
        const next = new Map<string, { jwk: Jwk; key: KeyObject }>();
        for (const jwk of body.keys ?? []) {
          if (typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
          if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') continue;
          try {
            next.set(jwk.kid, { jwk, key: createPublicKey({ key: jwk as never, format: 'jwk' }) });
          } catch {
            /* unusable key: skip */
          }
        }
        if (next.size > 0) keys = next;
      } finally {
        fetchedAt = now();
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function keyFor(kid: string) {
    if (now() - fetchedAt > ttl) await refresh();
    let hit = keys.get(kid);
    if (!hit && now() - fetchedAt > minGap) {
      await refresh();
      hit = keys.get(kid);
    }
    return hit ?? null;
  }

  return async (token) => {
    if (token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    try {
      const header = JSON.parse(b64url(h).toString('utf8')) as { alg?: unknown; kid?: unknown };
      if (header.alg !== 'RS256' && header.alg !== 'ES256') return null;
      if (typeof header.kid !== 'string') return null;
      const entry = await keyFor(header.kid);
      if (!entry) return null;
      const want = ALGS[header.alg];
      if (entry.jwk.kty !== want.kty) return null;
      if ('crv' in want && entry.jwk.crv !== want.crv) return null;
      if (entry.jwk.alg !== undefined && entry.jwk.alg !== header.alg) return null;

      const ok = cryptoVerify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        header.alg === 'ES256' ? { key: entry.key, dsaEncoding: 'ieee-p1363' } : entry.key,
        b64url(s),
      );
      if (!ok) return null;

      const claims = JSON.parse(b64url(p).toString('utf8')) as {
        iss?: unknown;
        aud?: unknown;
        exp?: unknown;
        nbf?: unknown;
        sub?: unknown;
      };
      if (claims.iss !== o.issuer) return null;
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(o.audience)) return null;
      if (typeof claims.exp !== 'number' || claims.exp * 1000 < now() - skew) return null;
      if (
        claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' || claims.nbf * 1000 > now() + skew)
      ) {
        return null;
      }
      return isValidUserId(claims.sub) ? { userId: claims.sub } : null;
    } catch {
      return null;
    }
  };
}
