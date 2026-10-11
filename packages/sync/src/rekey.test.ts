// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildRotation, createKey, createPayloadCodec } from './crypto.ts';
import { aadOf } from './engine.ts';
import { STUDYVAULT_SYNC_POLICY } from './policy.ts';
import { SyncOperation } from './schema.ts';
import { FakeServer, SimDevice, highlightRow } from './testing/harness.ts';
import type { SimClock } from './testing/harness.ts';

vi.setConfig({ testTimeout: 60_000 });

const crypto = webcrypto as unknown as Parameters<typeof createKey>[0]['crypto'];
const H = 'highlights';
let shared: ReturnType<typeof createKey> | undefined;
const key = () =>
  (shared ??= createKey({ crypto, passphrase: 'a long enough passphrase', now: 1 }));

function world() {
  const server = new FakeServer();
  const clock: SimClock = { t: Date.UTC(2026, 9, 11) };
  const device = (name: string, codec?: ReturnType<typeof createPayloadCodec>) =>
    new SimDevice({ name, server, policy: STUDYVAULT_SYNC_POLICY, clock, codec });
  return { server, clock, device };
}

/** A plaintext operation as a hostile server would plant it. */
function forged(id: string, wall: number, set: Record<string, unknown>, entityId = 'hl-000001') {
  return {
    id,
    clientId: 'client-evil',
    entityType: H,
    entityId,
    opType: 'upsert',
    revision: 50,
    hlc: `${wall.toString(36).padStart(9, '0')}.0000.client-evil`,
    baseRevision: 49,
    payload: { v: 1, full: false, set, prev: {}, base: {}, sets: {}, observed: null },
    payloadEncrypted: false,
    tombstone: false,
    idempotencyKey: `client-evil:${id}`,
    createdAt: new Date(wall).toISOString(),
  };
}

describe('pull-only runs', () => {
  it('never push, however much is waiting, and leave everything queued', async () => {
    const { server, device } = world();
    const a = device('A');
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await a.create(H, 'hl-000002', highlightRow('hl-000002'));

    const report = await a.engine.sync({ force: true, push: false });
    expect(report.status).toBe('idle');
    expect(report.pushed).toBe(0);
    expect(report.pending).toBe(2);
    expect(server.pushCount).toBe(0);
    expect(server.pullCount).toBeGreaterThan(0); // pulling is fine
    expect(server.log).toHaveLength(0);

    // The same engine pushes as soon as it is allowed to.
    expect((await a.engine.sync({ force: true })).pushed).toBe(2);
    expect(server.pushCount).toBe(1);
  });

  it('still apply what the server holds', async () => {
    const { device } = world();
    const a = device('A');
    const b = device('B');
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: 'from A' }));
    await a.sync();
    await b.engine.sync({ force: true, push: false });
    expect(b.row(H, 'hl-000001')!['userComment']).toBe('from A');
  });
});

describe('auditHistory (what a re-keying may vouch for)', () => {
  it('accepts operations of other devices it validated, never a forged one, never its own', async () => {
    const { server, clock, device } = world();
    const a = device('A');
    const b = device('B');
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: 'from A' }));
    await b.create(H, 'hl-000002', highlightRow('hl-000002'));
    await a.sync();
    await b.sync();
    // A forged operation that tries to rewrite protected provenance of A's highlight.
    server.inject(
      forged('op-forged-000001', clock.t + 5_000, { id: 'hl-000001', exactQuote: 'FORGED' }),
    );
    // And an operation of an entity type nobody knows.
    server.inject({
      ...forged('op-forged-000002', clock.t + 6_000, { x: 1 }),
      entityType: 'secretTable',
    });

    const audit = await b.engine.auditHistory();
    const ids = new Map(audit.ops.map((op) => [op.id, op]));
    const fromA = audit.ops.find((op) => op.clientId === a.clientId)!;
    const fromB = audit.ops.find((op) => op.clientId === b.clientId)!;
    expect(audit.accepted.has(fromA.id)).toBe(true); // another device, validated and merged
    expect(audit.accepted.has(fromB.id)).toBe(false); // its own: it re-sends its state instead
    expect(audit.accepted.has('op-forged-000001')).toBe(false);
    expect(audit.accepted.has('op-forged-000002')).toBe(false);
    expect(ids.has('op-forged-000001')).toBe(true);
    // The refusals are on record, in the quarantine, with their reasons.
    const reasons = Object.fromEntries(
      (await b.engine.listQuarantined()).map((q) => [q.id, q.reason]),
    );
    expect(reasons['op-forged-000001']).toBe('immutable_field');
    expect(reasons['op-forged-000002']).toBe('unknown_entity_type');
    expect(b.row(H, 'hl-000001')!['exactQuote']).toBe('The exact quote of hl-000001');
  });

  it('counts entries that are not operations at all', async () => {
    const { server, device } = world();
    const b = device('B');
    server.inject({ not: 'an operation' });
    const audit = await b.engine.auditHistory();
    expect(audit.unreadable).toBe(1);
    expect(audit.ops).toHaveLength(0);
  });
});

describe('the markers a re-keying leaves', () => {
  async function marked(kind: 'void' | 'garbage') {
    const { server, clock, device } = world();
    const { key: k, profile } = await key();
    const writer = createPayloadCodec(crypto);
    writer.unlock(k, profile.kid);
    const base = SyncOperation.parse({
      ...forged('op-marked-00001', clock.t + 1_000, {}),
      clientId: 'client-A',
      hlc: `${(clock.t + 1_000).toString(36).padStart(9, '0')}.0000.client-A`,
      payload: { v: 1, full: false, set: {}, prev: {}, base: {}, sets: {}, observed: null },
      idempotencyKey: 'client-A:op-marked-00001',
    });
    const request = await buildRotation({
      ops: [base],
      oldCodec: writer,
      newCodec: writer,
      newProfile: profile,
      crypto,
      // `base` is plaintext here: 'void' replaces it with the authenticated marker, anything else
      // with an envelope that no key opens.
      plaintext: () => (kind === 'void' ? 'void' : 'reject'),
    });
    server.inject({
      ...base,
      payload: request.replacements[0]!.payload,
      payloadEncrypted: true,
    });
    const reader = device('R', writer);
    return { reader, base, server };
  }

  it('an authenticated void is skipped silently', async () => {
    const { reader } = await marked('void');
    const report = await reader.sync();
    expect(report.status).toBe('idle');
    expect(report.quarantined).toBe(0);
    expect(report.applied).toBe(0);
    expect(await reader.engine.listQuarantined()).toEqual([]);
  });

  it('an envelope nothing can open is reported as not authentic, on every device', async () => {
    const { reader } = await marked('garbage');
    const report = await reader.sync();
    expect(report.quarantined).toBe(1);
    const [item] = await reader.engine.listQuarantined();
    expect(item!.reason).toBe('decrypt_failed');
  });

  it('a void clears the earlier quarantine entry of the operation it replaced', async () => {
    const { server, reader, base } = await marked('garbage');
    await reader.sync();
    expect(await reader.engine.listQuarantined()).toHaveLength(1);
    // The same id, now a void (a later re-keying emptied it): the stale refusal goes away.
    const { key: k, profile } = await key();
    const writer = createPayloadCodec(crypto);
    writer.unlock(k, profile.kid);
    const envelope = await writer.encrypt({ v: 1, void: true }, aadOf(base));
    (server.log[0]!.op as { payload: unknown }).payload = envelope;
    await reader.engine.markNeedsResync();
    await reader.sync();
    expect(await reader.engine.listQuarantined()).toEqual([]);
  });

  it('a plaintext void is just an empty patch: only the key can make one', async () => {
    const { server, clock, device } = world();
    server.inject(forged('op-plainvoid-01', clock.t + 1_000, {}));
    (server.log[0]!.op as { payload: unknown }).payload = { v: 1, void: true };
    const r = device('R');
    const report = await r.sync();
    // Not skipped as a void: it is judged like any other plaintext payload (and fails the schema).
    expect(report.quarantined).toBe(1);
  });
});
