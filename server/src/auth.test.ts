// @vitest-environment node
import { createHmac, createSign, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createJwtVerifier, staticTokenVerifier } from './auth.ts';

const ISS = 'https://id.example.test';
const AUD = 'studyvault-sync';
const NOW = Date.UTC(2026, 9, 11, 12);
const b64 = (v: Buffer | string) =>
  Buffer.from(v).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwks = {
  keys: [
    { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', use: 'sig', alg: 'RS256' },
    { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', use: 'sig', alg: 'ES256' },
  ],
};

function token(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  signer: (data: string) => Buffer,
): string {
  const data = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  return `${data}.${b64(signer(data))}`;
}
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: AUD,
  sub: 'user-42',
  exp: Math.floor(NOW / 1000) + 600,
  nbf: Math.floor(NOW / 1000) - 5,
  ...over,
});
const rs256 = (data: string) => createSign('sha256').update(data).sign(rsa.privateKey);
const es256 = (data: string) =>
  cryptoSign('sha256', Buffer.from(data), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' });

function verifier(over: { fetchCount?: { n: number }; keys?: unknown } = {}) {
  const fetchFn = (async () => {
    if (over.fetchCount) over.fetchCount.n++;
    return new Response(JSON.stringify(over.keys ?? jwks), { status: 200 });
  }) as unknown as typeof fetch;
  return createJwtVerifier({
    issuer: ISS,
    audience: AUD,
    jwksUri: `${ISS}/jwks`,
    fetch: fetchFn,
    now: () => NOW,
  });
}

describe('JWT access token verification', () => {
  it('accepts valid RS256 and ES256 tokens and returns the subject', async () => {
    const v = verifier();
    expect(await v(token({ alg: 'RS256', kid: 'rsa-1' }, claims(), rs256))).toEqual({
      userId: 'user-42',
    });
    expect(await v(token({ alg: 'ES256', kid: 'ec-1' }, claims(), es256))).toEqual({
      userId: 'user-42',
    });
    expect(
      await v(token({ alg: 'RS256', kid: 'rsa-1' }, claims({ aud: ['other', AUD] }), rs256)),
    ).toEqual({
      userId: 'user-42',
    });
  });

  it.each([
    ['alg none', { alg: 'none', kid: 'rsa-1' }, claims(), () => Buffer.alloc(0)],
    [
      'HMAC with the public key as secret (key confusion)',
      { alg: 'HS256', kid: 'rsa-1' },
      claims(),
      (d: string) => createHmac('sha256', JSON.stringify(jwks.keys[0])).update(d).digest(),
    ],
    ['wrong audience', { alg: 'RS256', kid: 'rsa-1' }, claims({ aud: 'someone-else' }), rs256],
    ['wrong issuer', { alg: 'RS256', kid: 'rsa-1' }, claims({ iss: 'https://evil.test' }), rs256],
    [
      'expired',
      { alg: 'RS256', kid: 'rsa-1' },
      claims({ exp: Math.floor(NOW / 1000) - 3600 }),
      rs256,
    ],
    [
      'not yet valid',
      { alg: 'RS256', kid: 'rsa-1' },
      claims({ nbf: Math.floor(NOW / 1000) + 3600 }),
      rs256,
    ],
    ['no subject', { alg: 'RS256', kid: 'rsa-1' }, claims({ sub: undefined }), rs256],
    ['subject with control chars', { alg: 'RS256', kid: 'rsa-1' }, claims({ sub: 'a\nb' }), rs256],
    ['unknown key id', { alg: 'RS256', kid: 'nope' }, claims(), rs256],
    ['algorithm does not match the key type', { alg: 'ES256', kid: 'rsa-1' }, claims(), es256],
    [
      'signature by another key',
      { alg: 'RS256', kid: 'rsa-1' },
      claims(),
      () => Buffer.alloc(256, 7),
    ],
  ])('rejects %s', async (_name, header, c, signer) => {
    expect(await verifier()(token(header, c, signer))).toBeNull();
  });

  it('rejects structurally broken tokens', async () => {
    const v = verifier();
    for (const t of ['', 'a.b', 'a.b.c.d', 'x'.repeat(9000), '..', 'e30.e30.e30']) {
      expect(await v(t)).toBeNull();
    }
  });

  it('caches the key set and does not let unknown key ids flood the provider', async () => {
    const counter = { n: 0 };
    const v = verifier({ fetchCount: counter });
    for (let i = 0; i < 5; i++) await v(token({ alg: 'RS256', kid: 'rsa-1' }, claims(), rs256));
    for (let i = 0; i < 5; i++)
      await v(token({ alg: 'RS256', kid: `unknown-${i}` }, claims(), rs256));
    expect(counter.n).toBeLessThanOrEqual(2);
  });
});

describe('static development tokens', () => {
  it('matches exactly and nothing else', async () => {
    const v = staticTokenVerifier(new Map([['dev-token-0123456789', 'dev-user']]));
    expect(await v('dev-token-0123456789')).toEqual({ userId: 'dev-user' });
    expect(await v('dev-token-0123456788')).toBeNull();
    expect(await v('')).toBeNull();
  });
});
