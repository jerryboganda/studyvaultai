// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ImmutableFieldError, SyncQueueFullError } from './engine.ts';
import { STUDYVAULT_SYNC_POLICY } from './policy.ts';
import { FakeServer, SimDevice, highlightRow } from './testing/harness.ts';
import type { SimClock } from './testing/harness.ts';

const H = 'highlights';

function setup(names = ['A', 'B']) {
  const server = new FakeServer();
  const clock: SimClock = { t: Date.UTC(2026, 9, 11) };
  const devices = names.map(
    (name) => new SimDevice({ name, server, policy: STUDYVAULT_SYNC_POLICY, clock }),
  );
  return { server, clock, devices };
}

async function converge(devices: SimDevice[], rounds = 3) {
  for (let i = 0; i < rounds; i++) for (const d of devices) await d.sync();
}

describe('sync engine: basics', () => {
  it('does nothing at all while the feature flag is off', async () => {
    const { server, devices } = setup(['A']);
    const [a] = devices as [SimDevice];
    a.enabled = false;
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    expect(await a.log.countPending()).toBe(0);
    const report = await a.sync();
    expect(report.status).toBe('disabled');
    expect(server.pushCount + server.pullCount).toBe(0);
    expect((await a.engine.getState()).status).toBe('disabled');
  });

  it('replicates a created entity and keeps device-local fields local', async () => {
    const { devices } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: 'hello' }));
    await a.sync();
    const report = await b.sync();
    expect(report.applied).toBe(1);
    const row = b.row(H, 'hl-000001')!;
    expect(row['exactQuote']).toBe('The exact quote of hl-000001');
    expect(row['userComment']).toBe('hello');
    // resolveStatus is device-local: B got its own default, not A's value.
    expect(row['resolveStatus']).toBe('unchecked');
    expect(a.row(H, 'hl-000001')!['resolveStatus']).toBe('resolved');
  });

  it('is replay-safe: re-pushing and re-pulling the same operations changes nothing', async () => {
    const { server, devices } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await a.update(H, 'hl-000001', { color: 'blue' });
    await a.sync();
    const logLength = server.log.length;
    // The same batch again (lost acknowledgement): the server answers duplicate for every key.
    const replay = server.push({
      v: 1,
      clientId: a.clientId,
      ops: server.log.map((e) => e.op),
    });
    expect(replay.results.every((r) => r.status === 'duplicate')).toBe(true);
    expect(server.log.length).toBe(logLength);

    await b.sync();
    const before = JSON.stringify(b.row(H, 'hl-000001'));
    // Re-deliver the entire log from the beginning.
    await b.engine.markNeedsResync();
    const report = await b.sync();
    expect(report.conflicts).toBe(0);
    expect(JSON.stringify(b.row(H, 'hl-000001'))).toBe(before);
  });

  it('coalesces unsent edits of one entity into a single operation', async () => {
    const { server, devices } = setup();
    const [a] = devices as [SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await a.update(H, 'hl-000001', { color: 'blue' });
    await a.update(H, 'hl-000001', { priority: 5 });
    await a.update(H, 'hl-000001', { color: 'red' });
    expect(await a.log.countPending()).toBe(1);
    await a.sync();
    expect(server.log).toHaveLength(1);
    const payload = (server.log[0]!.op as { payload: { set: Record<string, unknown> } }).payload;
    expect(payload.set['color']).toBe('red');
    expect(payload.set['priority']).toBe(5);
  });

  it('bounds the outbox and says so instead of dropping data', async () => {
    const server = new FakeServer();
    const clock: SimClock = { t: 1_800_000_000_000 };
    const a = new SimDevice({
      name: 'A',
      server,
      policy: STUDYVAULT_SYNC_POLICY,
      clock,
      options: { maxPendingOps: 2, coalesce: false },
    });
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await a.create(H, 'hl-000002', highlightRow('hl-000002'));
    await expect(a.create(H, 'hl-000003', highlightRow('hl-000003'))).rejects.toBeInstanceOf(
      SyncQueueFullError,
    );
  });
});

describe('sync engine: conflicts', () => {
  async function twoWithHighlight() {
    const ctx = setup();
    const [a, b] = ctx.devices as [SimDevice, SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: 'original' }));
    await converge([a, b]);
    ctx.clock.t += 60_000;
    return { ...ctx, a, b };
  }

  it('resolves scalar fields last-writer-wins by clock, per field', async () => {
    const { a, b, clock } = await twoWithHighlight();
    await a.update(H, 'hl-000001', { color: 'blue', priority: 1 });
    clock.t += 1_000;
    await b.update(H, 'hl-000001', { color: 'red' });
    await converge([a, b]);
    // B wrote colour later; A's priority is a different field and survives.
    for (const d of [a, b]) {
      expect(d.row(H, 'hl-000001')!['color']).toBe('red');
      expect(d.row(H, 'hl-000001')!['priority']).toBe(1);
    }
    expect(await a.engine.listConflicts()).toHaveLength(0);
  });

  it('keeps both versions when free text changed on both sides', async () => {
    const { a, b, clock } = await twoWithHighlight();
    await a.update(H, 'hl-000001', { userComment: 'my version on A' });
    clock.t += 1_000;
    await b.update(H, 'hl-000001', { userComment: 'my version on B' });
    await converge([a, b]);

    // Value converges (B is later) ...
    expect(a.row(H, 'hl-000001')!['userComment']).toBe('my version on B');
    expect(b.row(H, 'hl-000001')!['userComment']).toBe('my version on B');
    // ... and the other version is still in the user's hands on both devices.
    for (const d of [a, b]) {
      const conflicts = await d.engine.listConflicts({ unresolvedOnly: true });
      expect(conflicts).toHaveLength(1);
      const c = conflicts[0]!;
      expect(c.field).toBe('userComment');
      expect(c.base).toBe('original');
      const texts = [c.local.value, c.remote.value].sort();
      expect(texts).toEqual(['my version on A', 'my version on B']);
    }
  });

  it('a resolution is an ordinary operation that closes the record everywhere', async () => {
    const { a, b, clock } = await twoWithHighlight();
    await a.update(H, 'hl-000001', { userComment: 'on A' });
    clock.t += 1_000;
    await b.update(H, 'hl-000001', { userComment: 'on B' });
    await converge([a, b]);

    const [conflict] = await a.engine.listConflicts({ unresolvedOnly: true });
    clock.t += 1_000;
    await a.engine.resolveConflict(conflict!.id, { choice: 'custom', value: 'merged by hand' });
    expect(a.row(H, 'hl-000001')!['userComment']).toBe('merged by hand');
    await converge([a, b]);

    expect(b.row(H, 'hl-000001')!['userComment']).toBe('merged by hand');
    expect(await b.engine.listConflicts({ unresolvedOnly: true })).toHaveLength(0);
  });

  it('a later edit that saw the earlier one is a fast-forward, not a conflict', async () => {
    const { a, b, clock } = await twoWithHighlight();
    await a.update(H, 'hl-000001', { userComment: 'first' });
    await converge([a, b]);
    clock.t += 1_000;
    await b.update(H, 'hl-000001', { userComment: 'second' });
    await converge([a, b]);
    expect(a.row(H, 'hl-000001')!['userComment']).toBe('second');
    expect(await a.engine.listConflicts()).toHaveLength(0);
    expect(await b.engine.listConflicts()).toHaveLength(0);
  });
});

describe('sync engine: immutability', () => {
  it('refuses a local change to provenance', async () => {
    const { devices } = setup(['A']);
    const [a] = devices as [SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await expect(a.update(H, 'hl-000001', { exactQuote: 'forged' })).rejects.toBeInstanceOf(
      ImmutableFieldError,
    );
  });

  it('rejects, reports and ignores a remote operation that rewrites exactQuote', async () => {
    const { server, devices, clock } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await converge([a, b]);

    // A hostile or buggy peer: a well-formed operation that tries to rewrite the quote.
    server.inject({
      id: 'op-evil-000001',
      clientId: 'client-evil',
      entityType: H,
      entityId: 'hl-000001',
      opType: 'upsert',
      revision: 9,
      hlc: `${(clock.t + 5_000).toString(36).padStart(9, '0')}.0000.client-evil`,
      baseRevision: 8,
      payload: {
        v: 1,
        full: false,
        set: { exactQuote: 'FORGED QUOTE', color: 'red' },
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
    const [q] = await b.engine.listQuarantined();
    expect(q!.reason).toBe('immutable_field');
    // Nothing of that operation was applied, not even the harmless colour change.
    expect(b.row(H, 'hl-000001')!['exactQuote']).toBe('The exact quote of hl-000001');
    expect(b.row(H, 'hl-000001')!['color']).toBe('amber');
  });

  it('rejects a payload id that differs from the entity id', async () => {
    const { server, devices, clock } = setup();
    const [b] = [devices[1]] as [SimDevice];
    server.inject({
      id: 'op-evil-000002',
      clientId: 'client-evil',
      entityType: H,
      entityId: 'hl-000009',
      opType: 'upsert',
      revision: 1,
      hlc: `${clock.t.toString(36).padStart(9, '0')}.0000.client-evil`,
      baseRevision: 0,
      payload: {
        v: 1,
        full: true,
        set: { id: 'hl-000001' },
        prev: {},
        base: {},
        sets: {},
        observed: null,
      },
      payloadEncrypted: false,
      tombstone: false,
      idempotencyKey: 'client-evil:op-evil-000002',
      createdAt: new Date(clock.t).toISOString(),
    });
    const report = await b.sync();
    expect(report.quarantined).toBe(1);
    expect(b.row(H, 'hl-000009')).toBeUndefined();
  });
});

describe('sync engine: provenance stays frozen across delete and re-create', () => {
  it('refuses to re-create an id with different provenance, locally and remotely', async () => {
    const { server, devices, clock } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await converge([a, b]);
    clock.t += 1_000;
    await a.remove(H, 'hl-000001');
    await converge([a, b]);
    expect(b.row(H, 'hl-000001')).toBeUndefined();

    // Locally: same id, different quote.
    await expect(
      a.create(H, 'hl-000001', highlightRow('hl-000001', { exactQuote: 'a different quote' })),
    ).rejects.toBeInstanceOf(ImmutableFieldError);

    // Remotely: a peer sends the delete-and-recreate trick as a full snapshot.
    clock.t += 1_000;
    const row = highlightRow('hl-000001', { exactQuote: 'REWRITTEN PROVENANCE' });
    const fields = Object.fromEntries(
      Object.entries(row).filter(
        ([k]) =>
          !['resolveStatus', 'resolveConfidence', 'lastResolvedAt', 'schemaVersion'].includes(k),
      ),
    );
    const meta = await b.store.getMeta(H, 'hl-000001');
    server.inject({
      id: 'op-evil-200001',
      clientId: 'client-evil',
      entityType: H,
      entityId: 'hl-000001',
      opType: 'upsert',
      revision: 9,
      hlc: `${(clock.t + 9_000).toString(36).padStart(9, '0')}.0000.client-evil`,
      baseRevision: 8,
      payload: { v: 1, full: true, set: fields, prev: {}, base: {}, sets: {}, observed: meta!.rm },
      payloadEncrypted: false,
      tombstone: false,
      idempotencyKey: 'client-evil:op-evil-200001',
      createdAt: new Date(clock.t).toISOString(),
    });
    const report = await b.sync();
    expect(report.quarantined).toBe(1);
    expect((await b.engine.listQuarantined())[0]!.reason).toBe('immutable_field');
    expect(b.row(H, 'hl-000001')).toBeUndefined();

    // The same provenance is a legitimate re-creation.
    clock.t += 1_000;
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { color: 'green' }));
    await converge([a, b]);
    expect(b.row(H, 'hl-000001')!['exactQuote']).toBe('The exact quote of hl-000001');
  });

  it('append-only rows (review logs) can be created once and never changed', async () => {
    const { server, devices, clock } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    const log = {
      id: 'rev-000001',
      cardId: 'card-0001',
      rating: 3,
      reviewedAt: '2026-10-11T00:00:00.000Z',
    };
    await a.create('reviewLogs', 'rev-000001', log);
    await converge([a, b]);
    expect(b.row('reviewLogs', 'rev-000001')!['rating']).toBe(3);

    await expect(a.update('reviewLogs', 'rev-000001', { rating: 1 })).rejects.toBeInstanceOf(
      ImmutableFieldError,
    );

    server.inject({
      id: 'op-evil-300001',
      clientId: 'client-evil',
      entityType: 'reviewLogs',
      entityId: 'rev-000001',
      opType: 'upsert',
      revision: 5,
      hlc: `${(clock.t + 5_000).toString(36).padStart(9, '0')}.0000.client-evil`,
      baseRevision: 4,
      payload: {
        v: 1,
        full: false,
        set: { rating: 1 },
        prev: {},
        base: {},
        sets: {},
        observed: null,
      },
      payloadEncrypted: false,
      tombstone: false,
      idempotencyKey: 'client-evil:op-evil-300001',
      createdAt: new Date(clock.t).toISOString(),
    });
    const report = await b.sync();
    expect(report.quarantined).toBe(1);
    expect(b.row('reviewLogs', 'rev-000001')!['rating']).toBe(3);
    // A re-delivery of the original, identical snapshot is harmless.
    await b.engine.markNeedsResync();
    expect((await b.sync()).status).toBe('idle');
    expect(b.row('reviewLogs', 'rev-000001')!['rating']).toBe(3);
  });
});

describe('sync engine: deletes and sets', () => {
  it('a delete wins over a concurrent edit and the edited text is retained', async () => {
    const { devices, clock } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: 'v0' }));
    await converge([a, b]);
    clock.t += 10_000;

    await a.remove(H, 'hl-000001');
    clock.t += 1_000;
    await b.update(H, 'hl-000001', { userComment: 'precious late note' });
    await converge([a, b]);

    expect(a.row(H, 'hl-000001')).toBeUndefined();
    expect(b.row(H, 'hl-000001')).toBeUndefined();
    const all = [...(await a.engine.listConflicts()), ...(await b.engine.listConflicts())];
    const retained = JSON.stringify(all);
    expect(retained).toContain('precious late note');
  });

  it('a re-creation that has seen the delete wins back', async () => {
    const { devices, clock } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await converge([a, b]);
    clock.t += 1_000;
    await a.remove(H, 'hl-000001');
    await converge([a, b]);
    expect(b.row(H, 'hl-000001')).toBeUndefined();

    clock.t += 1_000;
    await b.create(H, 'hl-000001', highlightRow('hl-000001', { color: 'green' }));
    await converge([a, b]);
    expect(a.row(H, 'hl-000001')!['color']).toBe('green');
    expect(b.row(H, 'hl-000001')!['color']).toBe('green');
  });

  it('set fields union, and a removal beats a concurrent add but not a later one', async () => {
    const { devices, clock } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    const row = (aliases: string[]) => ({
      id: 'tag-000001',
      schemaVersion: 1,
      name: 'Physics',
      nameKey: 'physics',
      color: null,
      aliases,
      createdAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:00:00.000Z',
      deletedAt: null,
    });
    await a.create('tags', 'tag-000001', row(['phys', 'ph']));
    await converge([a, b]);
    clock.t += 1_000;

    // Concurrently: A adds "p", B adds "pys" (union), A removes "ph" while B re-adds... nothing.
    await a.update('tags', 'tag-000001', { aliases: ['phys', 'p'] }); // +p, -ph
    await b.update('tags', 'tag-000001', { aliases: ['phys', 'ph', 'pys'] }); // +pys
    await converge([a, b]);
    for (const d of [a, b]) {
      expect(d.row('tags', 'tag-000001')!['aliases']).toEqual(['p', 'phys', 'pys']);
    }

    // B adds "ph" back knowing it was removed: that add has seen the removal, so it wins.
    clock.t += 1_000;
    await b.update('tags', 'tag-000001', { aliases: ['p', 'phys', 'pys', 'ph'] });
    await converge([a, b]);
    for (const d of [a, b]) {
      const aliases = d.row('tags', 'tag-000001')!['aliases'] as string[];
      expect([...aliases].sort()).toEqual(['p', 'ph', 'phys', 'pys']);
    }
  });

  it('prunes tombstones after the retention window and not before', async () => {
    const { devices, clock } = setup(['A']);
    const [a] = devices as [SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await a.remove(H, 'hl-000001');
    expect((await a.engine.prune()).tombstones).toBe(0);
    clock.t += 91 * 24 * 60 * 60 * 1000;
    expect((await a.engine.prune()).tombstones).toBe(1);
    expect(await a.store.getMeta(H, 'hl-000001')).toBeNull();
  });
});

describe('sync engine: failure handling', () => {
  it('goes offline with exponential backoff and resumes without losing the queue', async () => {
    const { server, devices, clock } = setup(['A']);
    const [a] = devices as [SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    a.online = false;

    const first = await a.engine.sync();
    expect(first.status).toBe('offline');
    expect(first.pending).toBe(1);
    expect(first.retryAt).toBeGreaterThan(clock.t);

    const pulls = server.pullCount;
    const second = await a.engine.sync(); // inside the backoff window: no network at all
    expect(second.status).toBe('backoff');
    expect(server.pullCount).toBe(pulls);

    clock.t += 60 * 60 * 1000;
    a.online = true;
    const third = await a.engine.sync();
    expect(third.status).toBe('idle');
    expect(third.pending).toBe(0);
    expect(server.log).toHaveLength(1);
  });

  it('re-applies a page after a crash in the middle of it, without duplicates', async () => {
    const { server, devices } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    for (const id of ['hl-000001', 'hl-000002', 'hl-000003']) {
      await a.create(H, id, highlightRow(id));
      await a.sync();
    }
    // The host's storage dies on the second row of the page.
    let calls = 0;
    const realApply = b.applier.apply.bind(b.applier);
    b.applier.apply = async (change) => {
      if (++calls === 2) throw new Error('storage went away');
      return realApply(change);
    };
    const crashed = await b.sync();
    expect(crashed.status).toBe('error');
    expect((await b.engine.getState()).cursor).toBeNull(); // cursor did not move past the page

    b.applier.apply = realApply;
    const resumed = await b.sync();
    expect(resumed.status).toBe('idle');
    for (const id of ['hl-000001', 'hl-000002', 'hl-000003']) expect(b.row(H, id)).toBeDefined();
    expect(server.log).toHaveLength(3);
  });

  it('parks an update that arrives before its creation, then applies it', async () => {
    const { server, devices, clock } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await a.sync();
    clock.t += 1_000;
    await a.update(H, 'hl-000001', { color: 'blue' });
    await a.sync();
    // Deliver the update first (a transport that reorders across pages).
    const [create, update] = server.log;
    server.log.length = 0;
    server.log.push({ cursor: 1, op: update!.op }, { cursor: 2, op: create!.op });
    const r1 = await b.sync();
    expect(r1.applied).toBe(2);
    expect(b.row(H, 'hl-000001')!['color']).toBe('blue');
    expect(await b.engine.listQuarantined()).toHaveLength(0);
  });

  it('quarantines an operation stamped far in the future (poisoned clock)', async () => {
    const { server, devices, clock } = setup();
    const [b] = [devices[1]] as [SimDevice];
    server.inject({
      id: 'op-future-0001',
      clientId: 'client-evil',
      entityType: H,
      entityId: 'hl-000001',
      opType: 'upsert',
      revision: 1,
      hlc: `${(clock.t + 400 * 24 * 60 * 60 * 1000).toString(36).padStart(9, '0')}.0000.client-evil`,
      baseRevision: 0,
      payload: {
        v: 1,
        full: true,
        set: { id: 'hl-000001' },
        prev: {},
        base: {},
        sets: {},
        observed: null,
      },
      payloadEncrypted: false,
      tombstone: false,
      idempotencyKey: 'client-evil:op-future-0001',
      createdAt: new Date(clock.t).toISOString(),
    });
    const report = await b.sync();
    expect(report.quarantined).toBe(1);
    expect((await b.engine.listQuarantined())[0]!.reason).toBe('clock_skew');
  });

  it('notices a replaced server, stops, and recovers only after the user confirms', async () => {
    const { server, devices } = setup(['A']);
    const [a] = devices as [SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001', { userComment: 'only here now' }));
    await a.sync();
    expect((await a.sync()).status).toBe('idle');

    server.log.length = 0; // the server lost everything...
    server.epoch = 'another-generation'; // ...and says so
    await a.update(H, 'hl-000001', { color: 'blue' });
    const pushes = server.pushCount;
    const stopped = await a.sync();
    expect(stopped.status).toBe('resync_required');
    expect(server.pushCount).toBe(pushes); // nothing was uploaded into the unknown server
    expect(await a.log.countPending()).toBe(1);

    await a.engine.acknowledgeServerReset();
    await a.engine.backfill(
      [
        {
          kind: 'upsert',
          entityType: H,
          entityId: 'hl-000001',
          before: null,
          after: a.row(H, 'hl-000001')!,
        },
      ],
      { force: true },
    );
    expect((await a.sync()).status).toBe('idle');
    expect(server.log.length).toBeGreaterThan(0);
    const [b] = [
      new SimDevice({
        name: 'B',
        server,
        policy: STUDYVAULT_SYNC_POLICY,
        clock: { t: Date.UTC(2026, 9, 11) },
      }),
    ];
    await b.sync();
    expect(b.row(H, 'hl-000001')!['userComment']).toBe('only here now');
  });

  it('survives operations whose names collide with Object.prototype and carries on', async () => {
    const { server, devices, clock } = setup();
    const [a, b] = devices as [SimDevice, SimDevice];
    const evil = (id: string, entityId: string, set: Record<string, unknown>) => ({
      id,
      clientId: 'client-evil',
      entityType: H,
      entityId,
      opType: 'upsert',
      revision: 1,
      hlc: `${clock.t.toString(36).padStart(9, '0')}.0000.client-evil`,
      baseRevision: 0,
      payload: { v: 1, full: true, set, prev: {}, base: {}, sets: {}, observed: null },
      payloadEncrypted: false,
      tombstone: false,
      idempotencyKey: `client-evil:${id}`,
      createdAt: new Date(clock.t).toISOString(),
    });
    server.inject(evil('op-evil-100001', 'hl-000050', { constructor: 'x', toString: 'y' }));
    server.inject(
      evil('op-evil-100002', 'hl-000051', JSON.parse('{"__proto__": {"polluted": true}}')),
    );
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    await a.sync();
    const report = await b.sync();
    expect(report.quarantined).toBe(1); // the prototype-colliding field names are not valid
    expect(report.status).toBe('idle');
    expect(b.row(H, 'hl-000050')).toBeUndefined();
    expect(b.row(H, 'hl-000001')).toBeDefined(); // the good operation still applied
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('never persists "syncing": a killed worker cannot leave the device looking busy', async () => {
    const { devices } = setup(['A']);
    const [a] = devices as [SimDevice];
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    let seen: string | undefined;
    const real = a.store.saveState.bind(a.store);
    a.store.saveState = async (s) => {
      seen ??= s.status === 'syncing' ? 'syncing' : undefined;
      return real(s);
    };
    await a.sync();
    expect(seen).toBeUndefined();
    expect((await a.engine.getState()).status).toBe('idle');
  });

  it('refuses to merge data with a different account', async () => {
    const server = new FakeServer();
    const clock: SimClock = { t: 1_800_000_000_000 };
    let account: string | null = 'user-one';
    const a = new SimDevice({
      name: 'A',
      server,
      policy: STUDYVAULT_SYNC_POLICY,
      clock,
      accountId: () => account,
    });
    await a.create(H, 'hl-000001', highlightRow('hl-000001'));
    expect((await a.sync()).status).toBe('idle');
    account = 'user-two';
    const before = server.pushCount + server.pullCount;
    const report = await a.sync();
    expect(report.status).toBe('account_mismatch');
    expect(server.pushCount + server.pullCount).toBe(before);
    account = null;
    expect((await a.sync()).status).toBe('auth_required');
  });
});
