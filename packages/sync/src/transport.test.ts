// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TransportError } from './ports.ts';
import { createHttpTransport, normaliseBaseUrl } from './transport.ts';

const BASE = 'https://sync.example.test';

function client(
  respond: (url: string, init: RequestInit, n: number) => Response | Promise<Response> | Error,
  token: (forced: boolean | undefined) => string | null = () => 'token-1',
  isEnabled?: () => boolean,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const out = await respond(url, init, calls.length);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  const transport = createHttpTransport({
    baseUrl: BASE,
    fetch: fetchFn,
    getAccessToken: async (o) => token(o?.forceRefresh),
    isEnabled,
  });
  return { transport, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const pullBody = {
  v: 1,
  ops: [],
  nextCursor: '0',
  hasMore: false,
  epoch: 'epoch-0000001',
  head: '0',
  serverTime: new Date(0).toISOString(),
};

describe('HTTP transport', () => {
  it('only talks https (or loopback), without credentials in the address', () => {
    expect(normaliseBaseUrl('https://sync.example.test/')).toBe('https://sync.example.test');
    expect(normaliseBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => normaliseBaseUrl('http://sync.example.test')).toThrow(/https/);
    expect(() => normaliseBaseUrl('https://user:pw@sync.example.test')).toThrow();
    expect(() => normaliseBaseUrl('https://sync.example.test/?token=abc')).toThrow();
  });

  it('sends a bearer token, never cookies or referrers, and refuses redirects', async () => {
    const { transport, calls } = client(() => json(pullBody));
    await transport.pull({ since: '12', limit: 50 });
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/v1/ops?limit=50&since=12`);
    expect((call.init.headers as Record<string, string>)['authorization']).toBe('Bearer token-1');
    expect(call.init.credentials).toBe('omit');
    expect(call.init.redirect).toBe('error');
    expect(call.init.referrerPolicy).toBe('no-referrer');
    expect(call.init.cache).toBe('no-store');
  });

  it('retries once on 401 with a refreshed token, then reports auth', async () => {
    const forced: Array<boolean | undefined> = [];
    const { transport, calls } = client(
      (_u, init, n) =>
        n === 1
          ? json({ error: { code: 'unauthorized', message: 'no' } }, 401)
          : (init.headers as Record<string, string>)['authorization'] === 'Bearer fresh'
            ? json(pullBody)
            : json({ error: { code: 'unauthorized', message: 'no' } }, 401),
      (f) => {
        forced.push(f);
        return f ? 'fresh' : 'stale';
      },
    );
    await transport.pull({ since: null, limit: 10 });
    expect(calls).toHaveLength(2);
    expect(forced).toEqual([undefined, true]);

    const dead = client(() => json({ error: { code: 'unauthorized', message: 'no' } }, 401));
    await expect(dead.transport.pull({ since: null, limit: 10 })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(dead.calls).toHaveLength(2); // exactly one retry
  });

  it.each([
    [
      '429 with Retry-After',
      () => json({ error: { code: 'rate_limited', message: 'x' } }, 429, { 'retry-after': '7' }),
      'rate_limited',
    ],
    ['503', () => json({ error: { code: 'x', message: 'x' } }, 503), 'server'],
    ['410', () => json({ error: { code: 'cursor_expired', message: 'x' } }, 410), 'cursor_expired'],
    ['400', () => json({ error: { code: 'invalid_request', message: 'x' } }, 400), 'client'],
    ['network failure', () => new Error('ECONNRESET'), 'network'],
    ['not JSON', () => new Response('<html>', { status: 200 }), 'protocol'],
    ['wrong shape', () => json({ v: 1, nope: true }), 'protocol'],
  ])('classifies %s', async (_n, respond, kind) => {
    const { transport } = client(respond as never);
    const error = await transport.pull({ since: null, limit: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe(kind);
  });

  it('carries Retry-After into the error', async () => {
    const { transport } = client(() =>
      json({ error: { code: 'rate_limited', message: 'x' } }, 429, { 'retry-after': '7' }),
    );
    const error = (await transport
      .pull({ since: null, limit: 10 })
      .catch((e: unknown) => e)) as TransportError;
    expect(error.retryAfterMs).toBe(7000);
  });

  it('sends nothing while the feature flag is off, and nothing when signed out', async () => {
    const off = client(
      () => json(pullBody),
      () => 'token-1',
      () => false,
    );
    await expect(off.transport.pull({ since: null, limit: 1 })).rejects.toMatchObject({
      kind: 'client',
    });
    expect(off.calls).toHaveLength(0);
    const out = client(
      () => json(pullBody),
      () => null,
    );
    await expect(out.transport.pull({ since: null, limit: 1 })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(out.calls).toHaveLength(0);
  });

  it('treats a missing key profile as absent, not as an error', async () => {
    const { transport } = client(() => json({ error: { code: 'not_found', message: 'x' } }, 404));
    expect(await transport.getKeyProfile()).toBeNull();
  });
});
