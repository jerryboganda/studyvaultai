// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createKey,
  createPayloadCodec,
  buildRotation,
  unlockKey,
} from '../../packages/sync/src/crypto.ts';
import { STUDYVAULT_SYNC_POLICY } from '../../packages/sync/src/policy.ts';
import { createHttpTransport } from '../../packages/sync/src/transport.ts';
import type { HttpSyncClient } from '../../packages/sync/src/transport.ts';
import { SyncOperation } from '../../packages/sync/src/schema.ts';
import { FakeServer, SimDevice, highlightRow } from '../../packages/sync/src/testing/harness.ts';
import type { SimClock } from '../../packages/sync/src/testing/harness.ts';
import { TOKEN_A, TOKEN_B, api, start } from './testing.ts';
import type { Running } from './testing.ts';

vi.setConfig({ testTimeout: 60_000 });

const crypto = webcrypto as unknown as Parameters<typeof createKey>[0]['crypto'];
const H = 'highlights';

let server: Running | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

/**
 * The whole stack: engine -> HTTP transport -> reference server over a real socket. This is the
 * integration the extension will have, minus chrome.identity.
 */
async function world(token: string | (() => string | null) = TOKEN_A, over = {}) {
  server = await start(over);
  const clock: SimClock = server.clock;
  const tokenCalls: Array<boolean | undefined> = [];
  const getToken = typeof token === 'function' ? token : () => token;
  const client = (): HttpSyncClient =>
    createHttpTransport({
      baseUrl: server!.base,
      fetch,
      getAccessToken: async (o) => {
        tokenCalls.push(o?.forceRefresh);
        return getToken();
      },
    });
  const device = (
    name: string,
    opts: { codec?: ReturnType<typeof createPayloadCodec>; client?: HttpSyncClient } = {},
  ) => {
    const transport = opts.client ?? client();
    return {
      d: new SimDevice({
        name,
        server: new FakeServer(), // unused: the transport below replaces it
        transport,
        policy: STUDYVAULT_SYNC_POLICY,
        clock,
        codec: opts.codec,
        options: { pullLimit: 2, batchOps: 2 },
      }),
      transport,
    };
  };
  return { clock, client, device, tokenCalls };
}

describe('engine <-> HTTP transport <-> reference server', () => {
  it('two devices converge through the real wire format, across pages and batches', async () => {
    const { device, clock } = await world();
    const { d: a } = device('A');
    const { d: b } = device('B');
    for (const n of [1, 2, 3, 4, 5]) {
      await a.create(H, `hl-00000${n}`, highlightRow(`hl-00000${n}`, { userComment: `c${n}` }));
    }
    expect((await a.sync()).status).toBe('idle');
    expect((await b.sync()).status).toBe('idle'); // 5 ops over pages of 2
    for (const n of [1, 2, 3, 4, 5]) expect(b.row(H, `hl-00000${n}`)!['userComment']).toBe(`c${n}`);

    clock.t += 5_000;
    await a.update(H, 'hl-000001', { userComment: 'A edit' });
    clock.t += 1_000;
    await b.update(H, 'hl-000001', { userComment: 'B edit' });
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.row(H, 'hl-000001')!['userComment']).toBe('B edit');
    expect((await a.engine.listConflicts({ unresolvedOnly: true }))[0]!.local.value).toBe('A edit');
    expect(await a.log.countPending()).toBe(0);
  });

  it('a second user on the same server sees none of it', async () => {
    const { device } = await world();
    const { d: a } = device('A');
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: 'mine' }));
    await a.sync();
    const stranger = await api(server!.base, 'GET', '/v1/ops', { token: TOKEN_B });
    expect(stranger.json.ops).toEqual([]);
  });

  it('a 401 triggers exactly one token refresh and then asks for sign-in', async () => {
    let token: string | null = 'rejected-token-0123456789';
    const { device, tokenCalls } = await world(() => token);
    const { d } = device('A');
    await d.create(H, 'hl-000001', highlightRow('hl-000001'));
    const report = await d.sync();
    expect(report.status).toBe('auth_required');
    expect(tokenCalls.slice(0, 2)).toEqual([undefined, true]); // second call asked for a refresh
    expect(await d.log.countPending()).toBe(1); // nothing was dropped

    token = TOKEN_A; // the user signs in again
    expect((await d.sync()).status).toBe('idle');
    expect(await d.log.countPending()).toBe(0);
  });

  it('signed out: no request leaves the device at all', async () => {
    const { device } = await world(() => null);
    const { d } = device('A');
    await d.create(H, 'hl-000001', highlightRow('hl-000001'));
    const before = server!.events.length;
    const report = await d.sync();
    expect(report.status).toBe('auth_required');
    expect(server!.events.length).toBe(before);
  });

  it('server rate limiting becomes backoff, then recovers', async () => {
    const { device, clock } = await world(TOKEN_A, { userRatePerMinute: 2 });
    const { d } = device('A');
    await d.create(H, 'hl-000001', highlightRow('hl-000001'));
    await api(server!.base, 'GET', '/v1/ops'); // the account's allowance for this minute
    await api(server!.base, 'GET', '/v1/ops');
    const limited = await d.sync();
    expect(limited.status).toBe('backoff');
    expect(limited.retryAt).toBeGreaterThan(clock.t);
    expect(limited.pending).toBe(1);
    clock.t += 5 * 60 * 1000;
    expect((await d.sync()).status).toBe('idle');
    expect(await d.log.countPending()).toBe(0);
  });

  it('a wiped or restored server is reported (cursor ahead) and recovery re-uploads from the device', async () => {
    const { device } = await world();
    const { d: a } = device('A');
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: 'kept locally' }));
    await a.sync();
    await a.sync(); // pins the server's data generation
    await api(server!.base, 'DELETE', '/v1/data', { body: { confirm: 'delete-all-my-data' } });

    const report = await a.sync();
    expect(report.status).toBe('resync_required');
    expect(report.error?.code).toBe('cursor_expired');

    // The user confirms: adopt the new generation and send what only this device holds.
    await a.engine.acknowledgeServerReset();
    const rows = [...(a.applier.tables.get(H)?.values() ?? [])];
    await a.engine.backfill(
      rows.map((row) => ({
        kind: 'upsert' as const,
        entityType: H,
        entityId: row['id'] as string,
        before: null,
        after: row,
      })),
      { force: true },
    );
    expect((await a.sync()).status).toBe('idle');
    const { d: fresh } = device('C');
    await fresh.sync();
    expect(fresh.row(H, 'hl-000001')!['userComment']).toBe('kept locally');
  });
});

describe('end-to-end encryption over the real server', () => {
  const PASSPHRASE = 'a passphrase that is long enough';
  const SECRET = 'confidential: exam question bank for the board';

  it('the server holds only ciphertext; a second device unlocks with the passphrase from the stored profile', async () => {
    const { device, client } = await world();
    const net = client();
    const created = await createKey({ crypto, passphrase: PASSPHRASE, now: server!.clock.t });
    await net.putKeyProfile(created.profile);
    const codecA = createPayloadCodec(crypto);
    codecA.unlock(created.key, created.profile.kid);
    const { d: a } = device('A', { codec: codecA });
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: SECRET }));
    await a.sync();

    const raw = await api(server!.base, 'GET', '/v1/ops');
    expect(JSON.stringify(raw.json)).not.toContain(SECRET);
    expect(JSON.stringify(raw.json)).not.toContain('The exact quote of hl-000001');
    expect(raw.json.ops[0].op.payloadEncrypted).toBe(true);

    // A new device: fetches the public profile, derives the key locally.
    const profile = (await net.getKeyProfile())!;
    expect(JSON.stringify(profile)).not.toContain(PASSPHRASE);
    await expect(
      unlockKey({ crypto, passphrase: 'not the passphrase at all', profile }),
    ).rejects.toThrow(/wrong/i);
    const key = await unlockKey({ crypto, passphrase: PASSPHRASE, profile });
    const codecB = createPayloadCodec(crypto);
    codecB.unlock(key, profile.kid);
    const { d: b } = device('B', { codec: codecB });
    await b.sync();
    expect(b.row(H, 'hl-000001')!['userComment']).toBe(SECRET);
  });

  it('rotation through the real endpoint: new key decrypts, old key no longer does', async () => {
    const { device, client } = await world();
    const net = client();
    const one = await createKey({ crypto, passphrase: PASSPHRASE, now: server!.clock.t });
    await net.putKeyProfile(one.profile);
    const oldCodec = createPayloadCodec(crypto);
    oldCodec.unlock(one.key, one.profile.kid);
    const { d: a } = device('A', { codec: oldCodec });
    for (const n of [1, 2, 3])
      await a.create(H, `hl-00000${n}`, highlightRow(`hl-00000${n}`, { userComment: SECRET }));
    await a.sync();

    // Pull the whole log, re-encrypt under a new passphrase, and swap it atomically.
    const all: SyncOperation[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await net.pull({ since: cursor, limit: 100 });
      all.push(...page.ops.map((o) => SyncOperation.parse(o.op)));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    const two = await createKey({
      crypto,
      passphrase: 'a brand new long passphrase',
      now: server!.clock.t,
      version: 2,
    });
    const newCodec = createPayloadCodec(crypto);
    newCodec.unlock(two.key, two.profile.kid);
    const request = await buildRotation({ ops: all, oldCodec, newCodec, newProfile: two.profile });
    await net.rotate(request);

    const profile = (await net.getKeyProfile())!;
    expect(profile.version).toBe(2);
    const fresh = createPayloadCodec(crypto);
    fresh.unlock(
      await unlockKey({ crypto, passphrase: 'a brand new long passphrase', profile }),
      profile.kid,
    );
    const { d: b } = device('B', { codec: fresh });
    await b.sync();
    for (const n of [1, 2, 3]) expect(b.row(H, `hl-00000${n}`)!['userComment']).toBe(SECRET);

    // A device that still holds the old key cannot read anything any more.
    const stale = createPayloadCodec(crypto);
    stale.unlock(one.key, one.profile.kid);
    const { d: c } = device('C', { codec: stale });
    const report = await c.sync();
    expect(report.quarantined).toBe(3);
    expect(c.row(H, 'hl-000001')).toBeUndefined();
  });
});
