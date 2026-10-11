// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createKey, createPayloadCodec, buildRotation } from './crypto.ts';
import { STUDYVAULT_SYNC_POLICY } from './policy.ts';
import { aadOf } from './engine.ts';
import { FakeServer, SimDevice, highlightRow } from './testing/harness.ts';
import type { SimClock } from './testing/harness.ts';
import { SyncOperation } from './schema.ts';

vi.setConfig({ testTimeout: 60_000 });

const crypto = webcrypto as unknown as Parameters<typeof createKey>[0]['crypto'];
let sharedKey: ReturnType<typeof createKey> | undefined;
const H = 'highlights';
const SECRET_COMMENT = 'my private clinical note about patient zero';

async function world() {
  const server = new FakeServer();
  const clock: SimClock = { t: Date.UTC(2026, 9, 11) };
  const { profile, key } = await (sharedKey ??= createKey({
    crypto,
    passphrase: 'a long enough passphrase',
    now: clock.t,
  }));
  const codec = () => {
    const c = createPayloadCodec(crypto);
    c.unlock(key, profile.kid);
    return c;
  };
  const device = (name: string, c = codec()) =>
    new SimDevice({ name, server, policy: STUDYVAULT_SYNC_POLICY, clock, codec: c });
  return { server, clock, profile, key, codec, device };
}

describe('end-to-end encrypted sync', () => {
  it('the server never holds a readable payload, yet devices converge', async () => {
    const { server, device } = await world();
    const a = device('A');
    const b = device('B');
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: SECRET_COMMENT }));
    await a.sync();

    const stored = JSON.stringify(server.log);
    expect(stored).not.toContain(SECRET_COMMENT);
    expect(stored).not.toContain('The exact quote of hl-000001');
    expect(server.log.every((e) => (e.op as { payloadEncrypted: boolean }).payloadEncrypted)).toBe(
      true,
    );

    await b.sync();
    expect(b.row(H, 'hl-000001')!['userComment']).toBe(SECRET_COMMENT);
  });

  it('retries a push with the identical ciphertext (no server-side idempotency conflict)', async () => {
    const { server, device } = await world();
    const a = device('A');
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    a.online = true;
    await a.sync();
    const first = JSON.stringify(server.log[0]);
    // The log keeps the encrypted op; a re-push after a lost ack reuses it byte for byte.
    const kept = a.log.all()[0]!.op;
    expect(kept.payloadEncrypted).toBe(true);
    expect(JSON.stringify({ cursor: 1, op: kept })).toBe(first);
  });

  it('a locked device touches neither the network nor the data', async () => {
    const { server, device } = await world();
    const locked = createPayloadCodec(crypto);
    const c = device('C', locked);
    await c.create(H, 'hl-000009', highlightRow('hl-000009'));
    const before = server.pushCount + server.pullCount;
    const report = await c.sync();
    expect(report.status).toBe('locked');
    expect(report.pending).toBe(1);
    expect(server.pushCount + server.pullCount).toBe(before);
  });

  it('refuses plaintext operations in E2EE mode (a server cannot inject data)', async () => {
    const { server, device, clock } = await world();
    const b = device('B');
    server.inject({
      id: 'op-evil-000001',
      clientId: 'client-evil',
      entityType: H,
      entityId: 'hl-000001',
      opType: 'upsert',
      revision: 1,
      hlc: `${(clock.t + 1_000).toString(36).padStart(9, '0')}.0000.client-evil`,
      baseRevision: 0,
      payload: {
        v: 1,
        full: true,
        set: { id: 'hl-000001', exactQuote: 'planted by the server' },
        prev: {},
        base: {},
        sets: {},
        observed: null,
      },
      payloadEncrypted: false,
      tombstone: false,
      idempotencyKey: 'client-evil:op-evil-000001',
      createdAt: new Date(clock.t).toISOString(),
    });
    const report = await b.sync();
    expect(report.quarantined).toBe(1);
    expect((await b.engine.listQuarantined())[0]!.reason).toBe('plaintext_in_e2ee');
    expect(b.row(H, 'hl-000001')).toBeUndefined();
  });

  it('rejects an envelope the server moved to another entity or revision', async () => {
    const { server, device } = await world();
    const a = device('A');
    const b = device('B');
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await a.sync();
    const op = structuredClone(server.log[0]!.op) as SyncOperation;
    server.log.length = 0;
    // Same valid ciphertext, presented as a different entity.
    server.inject({
      ...op,
      entityId: 'hl-000777',
      id: 'op-moved-000001',
      idempotencyKey: 'k-moved-000001',
    });
    const report = await b.sync();
    expect(report.quarantined).toBe(1);
    expect((await b.engine.listQuarantined())[0]!.reason).toBe('decrypt_failed');
    expect(b.row(H, 'hl-000777')).toBeUndefined();
  });

  it('after a rotation elsewhere, ops under the old key wait as locked and apply after re-pull', async () => {
    const { server, device, key, profile, clock } = await world();
    const a = device('A');
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: SECRET_COMMENT }));
    await a.sync();

    const newKey = await createKey({
      crypto,
      passphrase: 'second long passphrase value',
      now: clock.t,
      version: 2,
    });
    const oldCodec = createPayloadCodec(crypto);
    oldCodec.unlock(key, profile.kid);
    const newCodec = createPayloadCodec(crypto);
    newCodec.unlock(newKey.key, newKey.profile.kid);

    // A device that already holds the NEW key sees ops still encrypted under the old one.
    const b = device('B', newCodec);
    const report = await b.sync();
    expect(report.quarantined).toBe(1);
    expect((await b.engine.listQuarantined())[0]!.reason).toBe('locked');

    // The server completes the rotation (what POST /v1/e2ee/rotate does), the device re-pulls.
    const rotation = await buildRotation({
      ops: server.log.map((e) => SyncOperation.parse(e.op)),
      oldCodec,
      newCodec,
      newProfile: newKey.profile,
    });
    for (const r of rotation.replacements) {
      const entry = server.log.find((e) => (e.op as { id: string }).id === r.id)!;
      (entry.op as { payload: unknown }).payload = r.payload;
    }
    await b.engine.markNeedsResync();
    await b.sync();
    expect(b.row(H, 'hl-000001')!['userComment']).toBe(SECRET_COMMENT);
    // AAD helper is stable: same operation, same authenticated data.
    const op = SyncOperation.parse(server.log[0]!.op);
    expect(aadOf(op)).toEqual(aadOf({ ...op }));
  });
});
