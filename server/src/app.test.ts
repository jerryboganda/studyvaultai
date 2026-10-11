// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../packages/sync/src/schema.ts';
import { TOKEN_A, TOKEN_B, api, makeOp, start } from './testing.ts';
import type { Running } from './testing.ts';

let server: Running | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const push = (s: Running, ops: unknown[], token = TOKEN_A, clientId = 'client-A') =>
  api(s.base, 'POST', '/v1/ops', { token, body: { v: 1, clientId, ops } });

describe('reference server: protocol', () => {
  it('health needs no auth and reveals nothing about stored data', async () => {
    server = await start();
    const r = await api(server.base, 'GET', '/v1/health', { token: null });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'ok', protocol: 1 });
    expect(Object.keys(r.json).sort()).toEqual(['protocol', 'status', 'time']);
  });

  it('pushes idempotently and pulls with cursor pagination', async () => {
    server = await start();
    const now = server.clock.t;
    const ops = [1, 2, 3, 4, 5].map((i) => makeOp({ id: `op-A-00000${i}` }, now));
    const first = await push(server, ops);
    expect(first.status).toBe(200);
    expect(first.json.results.map((r: { status: string }) => r.status)).toEqual(
      Array(5).fill('accepted'),
    );
    expect(first.json.results.map((r: { cursor: string }) => r.cursor)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(first.json.head).toBe('5');

    // The same batch again (lost acknowledgement): duplicates, same cursors, nothing appended.
    const replay = await push(server, ops);
    expect(replay.json.results.map((r: { status: string }) => r.status)).toEqual(
      Array(5).fill('duplicate'),
    );
    expect(replay.json.results.map((r: { cursor: string }) => r.cursor)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(replay.json.head).toBe('5');

    const page1 = await api(server.base, 'GET', '/v1/ops?limit=2');
    expect(page1.json.ops.map((o: { cursor: string }) => o.cursor)).toEqual(['1', '2']);
    expect(page1.json).toMatchObject({ nextCursor: '2', hasMore: true, head: '5' });
    const page2 = await api(server.base, 'GET', `/v1/ops?since=${page1.json.nextCursor}&limit=2`);
    expect(page2.json.ops.map((o: { cursor: string }) => o.cursor)).toEqual(['3', '4']);
    const page3 = await api(server.base, 'GET', `/v1/ops?since=${page2.json.nextCursor}&limit=2`);
    expect(page3.json).toMatchObject({ nextCursor: '5', hasMore: false });
    const empty = await api(server.base, 'GET', '/v1/ops?since=5');
    expect(empty.json).toMatchObject({ ops: [], nextCursor: '5', hasMore: false });
  });

  it('refuses reuse of an idempotency key for different content', async () => {
    server = await start();
    const now = server.clock.t;
    await push(server, [makeOp({ id: 'op-A-000001', key: 'client-A:shared-key' }, now)]);
    const clash = await push(server, [
      makeOp({ id: 'op-A-000002', key: 'client-A:shared-key', set: { title: 'different' } }, now),
    ]);
    expect(clash.json.results[0]).toMatchObject({
      status: 'rejected',
      code: 'idempotency_conflict',
    });
    expect((await api(server.base, 'GET', '/v1/ops')).json.ops).toHaveLength(1);
  });

  it('validates per operation: one bad operation does not block the good ones', async () => {
    server = await start({ maxFutureSkewMs: 60_000 });
    const now = server.clock.t;
    const r = await push(server, [
      makeOp({ id: 'op-A-000001' }, now),
      { id: 'not-an-op' },
      makeOp({ id: 'op-A-000003', clientId: 'client-other' }, now),
      makeOp({ id: 'op-A-000004', wall: now + 3_600_000 }, now),
      makeOp({ id: 'op-A-000005', set: { blob: 'x'.repeat(LIMITS.maxOpBytes) } }, now),
      makeOp({ id: 'op-A-000006' }, now),
    ]);
    expect(r.status).toBe(200);
    const codes = r.json.results.map(
      (x: { status: string; code: string | null }) => x.code ?? x.status,
    );
    expect(codes).toEqual([
      'accepted',
      'invalid_op',
      'client_mismatch',
      'hlc_in_future',
      'payload_too_large',
      'accepted',
    ]);
  });

  it('enforces a per-user storage quota', async () => {
    server = await start({ quotaBytesPerUser: 1500 });
    const now = server.clock.t;
    const r = await push(
      server,
      [1, 2, 3, 4].map((i) => makeOp({ id: `op-A-00000${i}` }, now)),
    );
    const statuses = r.json.results.map((x: { status: string }) => x.status);
    expect(statuses[0]).toBe('accepted');
    expect(statuses).toContain('rejected');
    expect(r.json.results.find((x: { status: string }) => x.status === 'rejected').code).toBe(
      'quota_exceeded',
    );
  });

  it('a cursor ahead of the server is reported, not served', async () => {
    server = await start();
    const r = await api(server.base, 'GET', '/v1/ops?since=99');
    expect(r.status).toBe(410);
    expect(r.json.error.code).toBe('cursor_expired');
  });
});

describe('reference server: authentication and tenant isolation', () => {
  it.each([
    ['no header', null],
    ['wrong token', 'token-for-nobody-0123456789'],
    ['malformed', 'bad token with spaces'],
    ['empty', ''],
  ])('rejects %s with 401 and a structured error', async (_name, token) => {
    server = await start();
    const r = await api(server.base, 'GET', '/v1/ops', { token });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('user A can never read or write user B', async () => {
    server = await start();
    const now = server.clock.t;
    await push(
      server,
      [makeOp({ id: 'op-A-000001', set: { title: 'secret of A' } }, now)],
      TOKEN_A,
      'client-A',
    );

    // B sees an empty log, not A's.
    const seen = await api(server.base, 'GET', '/v1/ops', { token: TOKEN_B });
    expect(seen.json.ops).toEqual([]);
    expect(seen.json.head).toBe('0');
    expect(JSON.stringify(seen.json)).not.toContain('secret of A');

    // B reusing A's idempotency key is a fresh, independent key space...
    const same = await push(
      server,
      [
        makeOp(
          {
            id: 'op-B-000001',
            clientId: 'client-B',
            key: 'client-A:op-A-000001',
            set: { title: 'B' },
          },
          now,
        ),
      ],
      TOKEN_B,
      'client-B',
    );
    expect(same.json.results[0].status).toBe('accepted');
    // ... and it does not appear in A's log, nor does it deduplicate against A's.
    const a = await api(server.base, 'GET', '/v1/ops', { token: TOKEN_A });
    expect(a.json.ops).toHaveLength(1);
    expect(a.json.ops[0].op.payload.set.title).toBe('secret of A');

    // Key profile and deletion are per user too.
    const profileBody = await profile('k1-aaaaaaaa');
    expect(
      (await api(server.base, 'PUT', '/v1/e2ee/profile', { token: TOKEN_A, body: profileBody }))
        .status,
    ).toBe(201);
    expect((await api(server.base, 'GET', '/v1/e2ee/profile', { token: TOKEN_B })).status).toBe(
      404,
    );
    await api(server.base, 'DELETE', '/v1/data', {
      token: TOKEN_B,
      body: { confirm: 'delete-all-my-data' },
    });
    expect((await api(server.base, 'GET', '/v1/ops', { token: TOKEN_A })).json.ops).toHaveLength(1);
    expect((await api(server.base, 'GET', '/v1/e2ee/profile', { token: TOKEN_A })).status).toBe(
      200,
    );
  });

  it('a user id with path or control characters is never accepted from a token', async () => {
    const { staticTokenVerifier } = await import('./auth.ts');
    const verifier = staticTokenVerifier(
      new Map([['token-with-bad-user-0123456', '../../etc/passwd\n']]),
    );
    server = await start({}, { verifier });
    const r = await api(server.base, 'GET', '/v1/ops', { token: 'token-with-bad-user-0123456' });
    expect(r.status).toBe(401);
  });
});

describe('reference server: hostile input and limits', () => {
  it('rejects malformed JSON, wrong content type and wrong shapes', async () => {
    server = await start();
    expect((await api(server.base, 'POST', '/v1/ops', { raw: '{"v":1,' })).json.error.code).toBe(
      'invalid_json',
    );
    const wrongType = await api(server.base, 'POST', '/v1/ops', {
      raw: '{}',
      headers: { 'content-type': 'text/plain' },
    });
    expect(wrongType.status).toBe(415);
    const shape = await api(server.base, 'POST', '/v1/ops', {
      body: { v: 1, clientId: 'client-A' },
    });
    expect(shape.status).toBe(400);
    const tooMany = await push(
      server,
      Array.from({ length: LIMITS.maxBatchOps + 1 }, (_, i) =>
        makeOp({ id: `op-A-${i}x00000` }, 1),
      ),
    );
    expect(tooMany.status).toBe(400);
    for (const q of ['since=abc', 'since=-1', 'limit=abc', 'limit=99999']) {
      const r = await api(server.base, 'GET', `/v1/ops?${q}`);
      expect(r.status).toBe(400);
    }
  });

  it('caps request bodies while streaming and answers 413', async () => {
    server = await start({ maxBodyBytes: 4096 });
    const big = JSON.stringify({ v: 1, clientId: 'client-A', ops: ['x'.repeat(10_000)] });
    const r = await api(server.base, 'POST', '/v1/ops', { raw: big });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('payload_too_large');
    // Still healthy afterwards.
    expect((await api(server.base, 'GET', '/v1/ops')).status).toBe(200);
  });

  it('rate limits per user with Retry-After', async () => {
    server = await start({ userRatePerMinute: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api(server.base, 'GET', '/v1/ops')).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await api(server.base, 'GET', '/v1/ops');
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    // Another user is unaffected.
    expect((await api(server.base, 'GET', '/v1/ops', { token: TOKEN_B })).status).toBe(200);
    // The window passes.
    server.clock.t += 61_000;
    expect((await api(server.base, 'GET', '/v1/ops')).status).toBe(200);
  });

  it('limits unauthenticated floods per address before any token work', async () => {
    server = await start({ ipRatePerMinute: 4 });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await api(server.base, 'GET', '/v1/ops', { token: 'x'.repeat(20) })).status);
    expect(codes).toEqual([401, 401, 401, 401, 429, 429]);
  });

  it('unknown routes and wrong methods are structured errors', async () => {
    server = await start();
    expect((await api(server.base, 'GET', '/v1/nope')).status).toBe(404);
    const m = await api(server.base, 'DELETE', '/v1/ops');
    expect(m.status).toBe(405);
    expect(m.headers.get('allow')).toBe('GET, POST');
  });

  it('sets no wildcard CORS, honours the allow-list, and refuses other browser origins', async () => {
    server = await start({ corsOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'] });
    const ok = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const pre = await api(server.base, 'OPTIONS', '/v1/ops', {
      token: null,
      headers: { origin: ok },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ok);
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');

    const real = await api(server.base, 'GET', '/v1/ops', { headers: { origin: ok } });
    expect(real.status).toBe(200);
    expect(real.headers.get('access-control-allow-origin')).toBe(ok);

    const evil = await api(server.base, 'GET', '/v1/ops', {
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    // Cookies are not part of this API: a request carrying one but no bearer token gets nothing.
    const cookie = await api(server.base, 'GET', '/v1/ops', {
      token: null,
      headers: { cookie: 'session=abc' },
    });
    expect(cookie.status).toBe(401);
  });

  it('never logs tokens or operation content', async () => {
    server = await start();
    await push(server, [
      makeOp({ id: 'op-A-000001', set: { title: 'PRIVATE-TEXT' } }, server.clock.t),
    ]);
    await api(server.base, 'GET', '/v1/ops', { token: 'wrong-wrong-wrong-wrong' });
    const logged = JSON.stringify(server.events);
    expect(logged).not.toContain(TOKEN_A);
    expect(logged).not.toContain('wrong-wrong-wrong-wrong');
    expect(logged).not.toContain('PRIVATE-TEXT');
    expect(logged).not.toContain('user-a');
    expect(server.events.some((e) => e.event === 'auth_failure')).toBe(true);
  });
});

async function profile(kid: string, version = 1) {
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: 600_000,
    salt: 'A'.repeat(22),
    kid,
    version,
    keyCheck: 'B'.repeat(43),
    createdAt: new Date(0).toISOString(),
  };
}

describe('reference server: E2EE key profile and rotation', () => {
  it('stores the profile once, refuses weak parameters, and rotates only at version + 1 with full coverage', async () => {
    server = await start();
    const now = server.clock.t;
    expect((await api(server.base, 'GET', '/v1/e2ee/profile')).status).toBe(404);
    const weak = { ...(await profile('k1-aaaaaaaa')), iterations: 1000 };
    expect((await api(server.base, 'PUT', '/v1/e2ee/profile', { body: weak })).status).toBe(400);

    expect(
      (await api(server.base, 'PUT', '/v1/e2ee/profile', { body: await profile('k1-aaaaaaaa') }))
        .status,
    ).toBe(201);
    expect(
      (await api(server.base, 'PUT', '/v1/e2ee/profile', { body: await profile('k1-aaaaaaaa') }))
        .status,
    ).toBe(409);
    expect((await api(server.base, 'GET', '/v1/e2ee/profile')).json.kid).toBe('k1-aaaaaaaa');

    await push(server, [makeOp({ id: 'op-A-000001' }, now), makeOp({ id: 'op-A-000002' }, now)]);
    const envelope = (n: string) => ({
      v: 1,
      alg: 'A256GCM',
      kid: 'k2-bbbbbbbb',
      iv: 'C'.repeat(16),
      ct: n.repeat(30),
    });

    const wrongVersion = await api(server.base, 'POST', '/v1/e2ee/rotate', {
      body: { profile: await profile('k3', 3), replacements: [] },
    });
    expect(wrongVersion.json.error.code).toBe('version_conflict');

    const partial = await api(server.base, 'POST', '/v1/e2ee/rotate', {
      body: {
        profile: await profile('k2-bbbbbbbb', 2),
        replacements: [{ id: 'op-A-000001', payload: envelope('D') }],
      },
    });
    expect(partial.json.error.code).toBe('incomplete_rotation');

    const ok = await api(server.base, 'POST', '/v1/e2ee/rotate', {
      body: {
        profile: await profile('k2-bbbbbbbb', 2),
        replacements: [
          { id: 'op-A-000001', payload: envelope('D') },
          { id: 'op-A-000002', payload: envelope('E') },
        ],
      },
    });
    expect(ok.status).toBe(200);
    const pulled = await api(server.base, 'GET', '/v1/ops');
    expect(pulled.json.ops.map((o: { cursor: string }) => o.cursor)).toEqual(['1', '2']); // positions kept
    expect(
      pulled.json.ops.every((o: { op: { payloadEncrypted: boolean } }) => o.op.payloadEncrypted),
    ).toBe(true);
    expect((await api(server.base, 'GET', '/v1/e2ee/profile')).json.version).toBe(2);
  });

  it('erases everything on request, and only with the confirmation', async () => {
    server = await start();
    await push(server, [makeOp({ id: 'op-A-000001' }, server.clock.t)]);
    expect((await api(server.base, 'DELETE', '/v1/data', { body: {} })).status).toBe(400);
    expect((await api(server.base, 'GET', '/v1/ops')).json.ops).toHaveLength(1);
    expect(
      (await api(server.base, 'DELETE', '/v1/data', { body: { confirm: 'delete-all-my-data' } }))
        .status,
    ).toBe(200);
    const after = await api(server.base, 'GET', '/v1/ops');
    expect(after.json).toMatchObject({ ops: [], head: '0' });
  });
});
