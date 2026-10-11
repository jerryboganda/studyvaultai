import { stableStringify } from '../json.ts';
import type { JsonValue } from '../json.ts';
import type { Row } from '../merge.ts';
import { STUDYVAULT_SYNC_POLICY } from '../policy.ts';
import type { ConflictRecord } from '../schema.ts';
import { OpPayload } from '../schema.ts';
import type { Faults } from './harness.ts';
import { FakeServer, NO_FAULTS, SimDevice, highlightRow, mulberry32 } from './harness.ts';
import type { SimClock } from './harness.ts';

/**
 * Seeded multi-device simulation. N devices make random edits (creates, text and scalar edits, set
 * changes, memberships, deletes, re-creations, conflict resolutions) while going offline and online
 * and while the network loses, duplicates and reorders messages. Afterwards every device is
 * connected, faults are switched off, and the invariants of the Phase 6 gate are checked:
 *
 *  1. convergence: every device holds the same rows and the same merge metadata;
 *  2. no lost data: every user-authored text that no later edit replaced is either the final
 *     value, or retained in a conflict record, or was seen by the delete that removed its entity;
 *  3. immutability: exactQuote, anchorSet and quoteHash of every highlight never change anywhere;
 *  4. delivery: every operation any device created reached the server; nothing is left pending or
 *     quarantined.
 */

export interface SimConfig {
  seed: number;
  devices?: number;
  steps?: number;
  faults?: Faults;
  /** Maximum absolute device clock error, ms. */
  maxSkewMs?: number;
  /** Probability per step that a device restarts its engine (service-worker suspension). */
  restartRate?: number;
}

export interface SimStats {
  ops: number;
  conflicts: number;
  resolutions: number;
  deletes: number;
  resurrections: number;
  syncs: number;
  forged: number;
}

export interface SimOutcome {
  violations: string[];
  stats: SimStats;
  devices: SimDevice[];
  server: FakeServer;
}

const H = 'highlights';
const T = 'tags';
const HT = 'highlightTags';
const N = 'notes';
const TEXT_FIELDS: Record<string, string[]> = {
  [H]: ['userComment'],
  [N]: ['title', 'body'],
};
const LOCAL_FIELDS = new Set([
  'resolveStatus',
  'resolveConfidence',
  'lastResolvedAt',
  'schemaVersion',
]);

const iso = (ms: number) => new Date(ms).toISOString();

export async function runSimulation(cfg: SimConfig): Promise<SimOutcome> {
  const rng = mulberry32(cfg.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
  const chance = (p: number) => rng() < p;
  const server = new FakeServer();
  const clock: SimClock = { t: Date.UTC(2026, 9, 11, 8, 0, 0) };
  const faults: Faults = cfg.faults ?? {
    dropRequest: 0.12,
    dropResponse: 0.1,
    duplicate: 0.1,
    scramble: true,
  };
  const maxSkew = cfg.maxSkewMs ?? 2 * 60 * 60 * 1000;
  const deviceCount = cfg.devices ?? 3;
  const devices = Array.from({ length: deviceCount }, (_, i) => {
    const name = String.fromCharCode(65 + i);
    return new SimDevice({
      name,
      server,
      policy: STUDYVAULT_SYNC_POLICY,
      clock,
      skewMs: Math.round((rng() * 2 - 1) * maxSkew),
      rng,
      faults: { ...faults },
      options: {
        coalesce: chance(0.7),
        pullLimit: 1 + Math.floor(rng() * 20),
        batchOps: 1 + Math.floor(rng() * 10),
      },
    });
  });

  const stats: SimStats = {
    ops: 0,
    conflicts: 0,
    resolutions: 0,
    deletes: 0,
    resurrections: 0,
    syncs: 0,
    forged: 0,
  };
  const created = new Map<
    string,
    { exactQuote: JsonValue; anchorSet: JsonValue; quoteHash: JsonValue }
  >();
  const everDeleted = new Map<string, Row>(); // for re-creation: id -> last row shape
  let seq = 0;
  const text = (d: SimDevice) => `txt-${d.name}-${++seq}`;
  const ids = (d: SimDevice, type: string) => [...(d.applier.tables.get(type)?.keys() ?? [])];

  const actions: Array<[number, (d: SimDevice) => Promise<void>]> = [
    [
      6,
      async (d) => {
        const id = `hl-${d.name}-${++seq}`;
        const row = highlightRow(id, { userComment: text(d), exactQuote: `quote of ${id}` });
        created.set(id, {
          exactQuote: row['exactQuote']!,
          anchorSet: row['anchorSet']!,
          quoteHash: row['quoteHash']!,
        });
        await d.create(H, id, row);
      },
    ],
    [
      3,
      async (d) => {
        const id = `note-${d.name}-${++seq}`;
        await d.create(N, id, {
          id,
          schemaVersion: 1,
          highlightId: null,
          sourceId: null,
          title: text(d),
          body: text(d),
          pinned: false,
          createdAt: iso(clock.t),
          updatedAt: iso(clock.t),
          deletedAt: null,
        });
      },
    ],
    [
      2,
      async (d) => {
        const id = `tag-${d.name}-${++seq}`;
        await d.create(T, id, {
          id,
          schemaVersion: 1,
          name: `tag ${seq}`,
          nameKey: `tag ${seq}`,
          color: null,
          aliases: [`a${seq}`],
          createdAt: iso(clock.t),
          updatedAt: iso(clock.t),
          deletedAt: null,
        });
      },
    ],
    [
      14,
      async (d) => {
        const type = pick([H, H, N]);
        const id = pick(ids(d, type));
        if (!id) return;
        const field = pick(TEXT_FIELDS[type]!);
        await d.update(type, id, { [field]: text(d), updatedAt: iso(clock.t) });
      },
    ],
    [
      8,
      async (d) => {
        const id = pick(ids(d, H));
        if (!id) return;
        await d.update(H, id, {
          color: pick(['amber', 'blue', 'red', 'green']),
          priority: 1 + Math.floor(rng() * 5),
          kind: pick(['essential', 'formula', 'question']),
          updatedAt: iso(clock.t),
        });
      },
    ],
    [
      3,
      async (d) => {
        const id = pick(ids(d, H));
        if (!id) return;
        const row = d.row(H, id)!;
        await d.update(H, id, {
          deletedAt: row['deletedAt'] === null ? iso(clock.t) : null,
          updatedAt: iso(clock.t),
        });
      },
    ],
    [
      6,
      async (d) => {
        const id = pick(ids(d, T));
        if (!id) return;
        const current = (d.row(T, id)!['aliases'] as string[]).slice();
        const next =
          chance(0.4) && current.length > 0
            ? current.filter((_, i) => i !== 0)
            : [...current, `al${++seq}`];
        await d.update(T, id, { aliases: next });
        if (chance(0.2)) await d.update(T, id, { name: `tag ${++seq}` });
      },
    ],
    [
      5,
      async (d) => {
        const hl = pick(ids(d, H));
        const tag = pick(ids(d, T));
        if (!hl || !tag) return;
        const id = `${hl}|${tag}`;
        if (d.row(HT, id)) return;
        await d.create(HT, id, { highlightId: hl, tagId: tag, addedAt: iso(clock.t) });
      },
    ],
    [
      4,
      async (d) => {
        const type = pick([HT, HT, N, H]);
        const id = pick(ids(d, type));
        if (!id) return;
        everDeleted.set(`${type}\u0000${id}`, structuredClone(d.row(type, id)!));
        await d.remove(type, id);
        stats.deletes++;
      },
    ],
    [
      3,
      async (d) => {
        // Re-create something this device deleted (it has seen its own tombstone).
        const entries = [...everDeleted.entries()].filter(([k]) => {
          const [type, id] = k.split('\u0000') as [string, string];
          return !d.row(type, id);
        });
        const hit = entries.length ? pick(entries) : null;
        if (!hit) return;
        const [type, id] = hit[0].split('\u0000') as [string, string];
        const row = { ...hit[1] } as Row;
        for (const f of TEXT_FIELDS[type] ?? []) row[f] = text(d);
        await d.create(type, id, row);
        stats.resurrections++;
      },
    ],
    [
      1,
      async () => {
        // A hostile peer writes through the server: it tries to rewrite a quote and recolour.
        const target = pick(devices.flatMap((x) => ids(x, H)));
        if (!target) return;
        const id = `op-evil-${++seq}`;
        server.inject({
          id,
          clientId: 'client-evil',
          entityType: H,
          entityId: target,
          opType: 'upsert',
          revision: 1,
          hlc: `${(clock.t + 500).toString(36).padStart(9, '0')}.0000.client-evil`,
          baseRevision: 0,
          payload: {
            v: 1,
            full: false,
            set: { exactQuote: 'FORGED QUOTE', color: 'FORGED-COLOR' },
            prev: {},
            base: {},
            sets: {},
            observed: null,
          },
          payloadEncrypted: false,
          tombstone: false,
          idempotencyKey: `client-evil:${id}`,
          createdAt: iso(clock.t),
        });
        stats.forged++;
      },
    ],
    [
      14,
      async (d) => {
        stats.syncs++;
        await d.sync(true);
      },
    ],
    [
      3,
      async (d) => {
        d.online = !d.online;
      },
    ],
    [
      3,
      async (d) => {
        const open = await d.engine.listConflicts({ unresolvedOnly: true });
        const c = open.length ? pick(open) : null;
        if (!c) return;
        try {
          if (c.kind === 'text_edit') {
            const choice = pick(['local', 'remote', 'custom'] as const);
            await d.engine.resolveConflict(
              c.id,
              choice === 'custom' ? { choice, value: text(d) } : { choice },
            );
          } else if (c.kind === 'deleted_remotely' && chance(0.5)) {
            await d.engine.resolveConflict(c.id, { choice: 'restore' });
          } else {
            await d.engine.resolveConflict(c.id, { choice: 'discard' });
          }
          stats.resolutions++;
        } catch (e) {
          // Resolving can legitimately fail (the entity is gone); anything else is a finding.
          if (!/does not apply|cannot be restored/.test(String(e))) throw e;
        }
      },
    ],
  ];
  const total = actions.reduce((n, [w]) => n + w, 0);
  const chooseAction = () => {
    let r = rng() * total;
    for (const [w, fn] of actions) {
      r -= w;
      if (r <= 0) return fn;
    }
    return actions[0]![1];
  };

  // Seed data so early steps have something to edit.
  for (const d of devices) await actions[0]![1](d);
  const steps = cfg.steps ?? 150;
  for (let i = 0; i < steps; i++) {
    clock.t += 100 + Math.floor(rng() * 4_000);
    const d = pick(devices);
    if (chance(cfg.restartRate ?? 0.03)) d.restart();
    await chooseAction()(d);
  }

  // ----- settle: everybody online, no faults, sync until nothing moves -----
  for (const d of devices) {
    d.online = true;
    d.faults = NO_FAULTS;
    d.restart();
  }
  clock.t += 7 * 24 * 60 * 60 * 1000; // outlast every backoff
  for (let round = 0; round < 8; round++) {
    const before = server.log.length;
    for (const d of devices) await d.sync(true);
    let pending = 0;
    for (const d of devices) pending += await d.log.countPending();
    if (round > 1 && pending === 0 && server.log.length === before) break;
  }

  const violations = await checkInvariants(devices, server, created, stats);
  return { violations, stats, devices, server };
}

function syncable(row: Row): string {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (LOCAL_FIELDS.has(k)) continue;
    out[k] = Array.isArray(v) && v.every((m) => typeof m === 'string') ? [...v].sort() : v;
  }
  return stableStringify(out);
}

async function checkInvariants(
  devices: SimDevice[],
  server: FakeServer,
  created: Map<string, { exactQuote: JsonValue; anchorSet: JsonValue; quoteHash: JsonValue }>,
  stats: SimStats,
): Promise<string[]> {
  const v: string[] = [];
  const entities = new Map<string, [string, string]>();
  for (const d of devices) {
    for (const [type, rows] of d.applier.tables) {
      for (const id of rows.keys()) entities.set(`${type}\u0000${id}`, [type, id]);
    }
  }
  for (const e of server.log) {
    const op = e.op as { entityType: string; entityId: string };
    entities.set(`${op.entityType}\u0000${op.entityId}`, [op.entityType, op.entityId]);
  }

  // 1. convergence of rows and metadata
  for (const [type, id] of entities.values()) {
    const rows = devices.map((d) => d.row(type, id));
    const dumps = rows.map((r) => (r ? syncable(r) : 'ABSENT'));
    if (new Set(dumps).size > 1) {
      v.push(
        `diverged rows ${type}/${id}: ${devices.map((d, i) => `${d.name}=${dumps[i]}`).join(' | ')}`,
      );
    }
    const metas = await Promise.all(devices.map((d) => d.store.getMeta(type, id)));
    const alive = rows[0] !== undefined;
    const view = metas.map((m) => {
      if (!m) return 'none';
      // A rejected forged operation leaves no trace on some devices and a vector entry on others.
      const vector = Object.fromEntries(
        Object.entries(m.vector).filter(([c]) => c !== 'client-evil'),
      );
      const base = { born: m.born, rm: m.rm, ao: m.ao, revision: m.revision, vector };
      if (!alive) return stableStringify(base as unknown as JsonValue);
      const fields = Object.fromEntries(Object.entries(m.fields).map(([f, c]) => [f, c.c]));
      const sets = Object.fromEntries(
        Object.entries(m.sets).map(([f, members]) => [
          f,
          Object.fromEntries(Object.entries(members).map(([k, s]) => [k, [s.has, s.rm, s.ao]])),
        ]),
      );
      return stableStringify({ ...base, fields, sets } as unknown as JsonValue);
    });
    if (new Set(view).size > 1) {
      v.push(
        `diverged metadata ${type}/${id}: ${devices.map((d, i) => `${d.name}=${view[i]}`).join(' | ')}`,
      );
    }
  }

  // 3. immutability
  for (const [id, original] of created) {
    for (const d of devices) {
      const row = d.row(H, id);
      if (!row) continue;
      for (const f of ['exactQuote', 'anchorSet', 'quoteHash'] as const) {
        if (stableStringify(row[f]!) !== stableStringify(original[f])) {
          v.push(`immutable field ${f} of ${id} changed on ${d.name}`);
        }
      }
    }
  }

  // 4. delivery
  const serverKeys = new Set(
    server.log.map((e) => (e.op as { idempotencyKey: string }).idempotencyKey),
  );
  let all: { op: ReturnType<typeof parseOp> }[] = [];
  for (const d of devices) {
    for (const entry of d.log.all()) {
      if (!serverKeys.has(entry.op.idempotencyKey)) {
        v.push(`operation ${entry.op.id} of ${d.name} never reached the server`);
      }
      all.push({ op: parseOp(entry.op) });
    }
    if ((await d.log.countPending()) !== 0) v.push(`${d.name} still has pending operations`);
    const q = await d.engine.listQuarantined();
    const unexpected = q.filter((x) => x.reason !== 'immutable_field');
    if (unexpected.length) {
      v.push(
        `${d.name} quarantined ${unexpected.length}: ${unexpected.map((x) => x.reason).join(',')}`,
      );
    }
    for (const rows of d.applier.tables.values()) {
      for (const row of rows.values()) {
        if (row['color'] === 'FORGED-COLOR') v.push(`forged operation partly applied on ${d.name}`);
      }
    }
  }
  all = all.filter((x) => x.op.payload !== null);
  stats.ops = server.log.length;

  // 2. no lost text
  const conflicts: ConflictRecord[] = [];
  for (const d of devices) conflicts.push(...(await d.engine.listConflicts()));
  stats.conflicts = conflicts.length;
  const retained = JSON.stringify(conflicts);
  const key = (type: string, id: string, f: string) => `${type}\u0000${id}\u0000${f}`;
  const writes = new Map<string, { clock: string; value: string }[]>();
  const superseded = new Set<string>();
  const deleteContext = new Map<string, Set<string>>();
  for (const { op } of all) {
    if (!op.payload) continue;
    if (op.opType === 'delete') {
      for (const [f, clocks] of Object.entries(op.payload.prev)) {
        const set = deleteContext.get(key(op.entityType, op.entityId, f)) ?? new Set<string>();
        for (const c of clocks) set.add(c);
        deleteContext.set(key(op.entityType, op.entityId, f), set);
      }
      continue;
    }
    for (const f of TEXT_FIELDS[op.entityType] ?? []) {
      const value = op.payload.set[f];
      if (typeof value !== 'string' || value === '') continue;
      const k = key(op.entityType, op.entityId, f);
      writes.set(k, [...(writes.get(k) ?? []), { clock: op.hlc, value }]);
      for (const c of op.payload.prev[f] ?? []) superseded.add(`${k}\u0000${c}`);
    }
  }
  for (const [k, list] of writes) {
    const [type, id, field] = k.split('\u0000') as [string, string, string];
    const finals = devices.map((d) => d.row(type, id)?.[field]);
    for (const w of list) {
      if (superseded.has(`${k}\u0000${w.clock}`)) continue; // a later edit that saw it replaced it
      if (finals.includes(w.value)) continue; // it is the converged value
      if (retained.includes(w.value)) continue; // it is in a conflict record
      if (deleteContext.get(k)?.has(w.clock)) continue; // the deleter had seen it
      v.push(`lost text ${w.value} (${type}/${id}.${field} @${w.clock})`);
    }
  }
  return v;
}

function parseOp(op: unknown) {
  const o = op as {
    id: string;
    entityType: string;
    entityId: string;
    opType: 'upsert' | 'delete';
    hlc: string;
    payload: unknown;
    payloadEncrypted: boolean;
  };
  const payload = o.payloadEncrypted ? null : OpPayload.safeParse(o.payload);
  return {
    id: o.id,
    entityType: o.entityType,
    entityId: o.entityId,
    opType: o.opType,
    hlc: o.hlc,
    payload: payload?.success ? payload.data : null,
  };
}
