import type { LocalChange, SyncDeps, SyncOptions } from '../engine.ts';
import { SyncEngine } from '../engine.ts';
import type { Row } from '../merge.ts';
import { createMemoryApplier, createMemoryOpLog, createMemoryStateStore } from '../memory.ts';
import type { PayloadCodec, Transport } from '../ports.ts';
import { TransportError } from '../ports.ts';
import type { SyncPolicy } from '../policy.ts';
import type { PullResponse, PushRequest, PushResponse, PushResult } from '../schema.ts';
import { SyncOperation } from '../schema.ts';

/**
 * Test harness: an in-memory protocol server with the semantics of the reference server, and
 * simulated devices behind a transport that can lose, duplicate, delay and reorder messages.
 * Everything is seeded (mulberry32) so a failing seed reproduces exactly.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export class FakeServer {
  readonly log: { cursor: number; op: unknown }[] = [];
  private readonly keys = new Map<string, number>();
  /** Change it to simulate an erased or restored server. */
  epoch = 'fake-epoch-0001';
  pushCount = 0;
  pullCount = 0;

  push(req: PushRequest): PushResponse {
    this.pushCount++;
    const results: PushResult[] = req.ops.map((raw) => {
      const parsed = SyncOperation.safeParse(raw);
      if (!parsed.success) {
        return {
          id: null,
          idempotencyKey: null,
          status: 'rejected',
          cursor: null,
          code: 'invalid_op',
          message: 'invalid',
        };
      }
      const op = parsed.data;
      const known = this.keys.get(op.idempotencyKey);
      if (known !== undefined) {
        return {
          id: op.id,
          idempotencyKey: op.idempotencyKey,
          status: 'duplicate',
          cursor: String(known),
          code: null,
          message: null,
        };
      }
      const cursor = this.log.length + 1;
      this.log.push({ cursor, op });
      this.keys.set(op.idempotencyKey, cursor);
      return {
        id: op.id,
        idempotencyKey: op.idempotencyKey,
        status: 'accepted',
        cursor: String(cursor),
        code: null,
        message: null,
      };
    });
    return {
      v: 1,
      results,
      epoch: this.epoch,
      head: String(this.log.length),
      serverTime: new Date().toISOString(),
    };
  }

  pull(since: string | null, limit: number): PullResponse {
    this.pullCount++;
    const from = since === null ? 0 : Number(since);
    const page = this.log.filter((e) => e.cursor > from).slice(0, limit);
    const last = page.at(-1)?.cursor ?? from;
    return {
      v: 1,
      ops: page.map((e) => ({ cursor: String(e.cursor), op: structuredClone(e.op) })),
      nextCursor: String(last),
      hasMore: last < this.log.length,
      epoch: this.epoch,
      head: String(this.log.length),
      serverTime: new Date().toISOString(),
    };
  }

  /** Append an arbitrary (possibly hostile) operation exactly as a malicious server could. */
  inject(op: unknown): void {
    const cursor = this.log.length + 1;
    this.log.push({ cursor, op });
  }
}

export interface Faults {
  dropRequest: number;
  dropResponse: number;
  duplicate: number;
  /** Shuffle (and sometimes repeat) the operations inside each pulled page. */
  scramble: boolean;
}

export const NO_FAULTS: Faults = { dropRequest: 0, dropResponse: 0, duplicate: 0, scramble: false };

export interface SimClock {
  t: number;
}

export interface DeviceOptions {
  name: string;
  server: FakeServer;
  /** Replace the in-process fake network (for example with the real HTTP transport). */
  transport?: Transport;
  policy: SyncPolicy;
  clock: SimClock;
  skewMs?: number;
  rng?: () => number;
  faults?: Faults;
  codec?: PayloadCodec;
  options?: Partial<SyncOptions>;
  isEnabled?: () => boolean;
  accountId?: () => string | null;
}

export class SimDevice {
  readonly name: string;
  readonly clientId: string;
  readonly applier = createMemoryApplier({
    defaults: () => ({ schemaVersion: 1, resolveStatus: 'unchecked' }),
  });
  readonly log = createMemoryOpLog();
  readonly store = createMemoryStateStore();
  engine!: SyncEngine;
  online = true;
  enabled = true;
  readonly known = new Set<string>();
  private counter = 0;
  faults: Faults;
  private readonly rng: () => number;
  private deps!: SyncDeps;

  constructor(private readonly o: DeviceOptions) {
    this.name = o.name;
    this.clientId = `client-${o.name}`;
    this.faults = o.faults ?? NO_FAULTS;
    this.rng = o.rng ?? (() => 0.5);
    const transport: Transport = o.transport ?? {
      push: async (req) => {
        if (!this.online) throw new TransportError('network', 'offline');
        if (this.rng() < this.faults.dropRequest)
          throw new TransportError('network', 'lost request');
        const res = o.server.push(req);
        if (this.rng() < this.faults.duplicate) o.server.push(req);
        if (this.rng() < this.faults.dropResponse)
          throw new TransportError('network', 'lost response');
        return res;
      },
      pull: async ({ since, limit }) => {
        if (!this.online) throw new TransportError('network', 'offline');
        if (this.rng() < this.faults.dropRequest)
          throw new TransportError('network', 'lost request');
        const page = o.server.pull(since, limit);
        if (this.faults.scramble) {
          const ops = shuffle(page.ops, this.rng);
          if (ops.length > 0 && this.rng() < 0.3) ops.push(structuredClone(ops[0]!));
          page.ops = ops;
        }
        return page;
      },
    };
    this.deps = {
      clientId: this.clientId,
      policy: o.policy,
      isEnabled: () => (o.isEnabled ? o.isEnabled() : this.enabled),
      log: this.log,
      store: this.store,
      transport,
      applier: this.applier,
      clock: { now: () => o.clock.t + (o.skewMs ?? 0) },
      newId: () => `op-${o.name}-${String(++this.counter).padStart(6, '0')}`,
      codec: o.codec,
      accountId: o.accountId,
      random: () => 0.5,
      options: o.options,
    };
    this.engine = new SyncEngine(this.deps);
  }

  /** Simulates a service-worker restart: a fresh engine over the same persisted state. */
  restart(): void {
    this.engine = new SyncEngine(this.deps);
  }

  row(entityType: string, id: string): Row | undefined {
    return this.applier.get(entityType, id);
  }

  async create(entityType: string, id: string, row: Row): Promise<void> {
    this.known.add(`${entityType}\u0000${id}`);
    this.applier.put(entityType, id, row);
    await this.engine.recordLocalChange({
      kind: 'upsert',
      entityType,
      entityId: id,
      before: null,
      after: row,
    });
  }

  async update(entityType: string, id: string, patch: Row): Promise<void> {
    const before = this.applier.get(entityType, id);
    if (!before) throw new Error(`${this.name}: no ${entityType}/${id}`);
    const after = { ...before, ...patch };
    this.applier.put(entityType, id, after);
    await this.engine.recordLocalChange({
      kind: 'upsert',
      entityType,
      entityId: id,
      before,
      after,
    });
  }

  async remove(entityType: string, id: string): Promise<void> {
    const before = this.applier.get(entityType, id) ?? null;
    this.applier.tables.get(entityType)?.delete(id);
    const change: LocalChange = { kind: 'delete', entityType, entityId: id, before };
    await this.engine.recordLocalChange(change);
  }

  sync(force = true) {
    return this.engine.sync({ force });
  }
}

export function highlightRow(id: string, over: Row = {}): Row {
  return {
    id,
    schemaVersion: 1,
    sourceId: 'source-0001',
    exactQuote: `The exact quote of ${id}`,
    normalizedQuote: `the exact quote of ${id}`,
    quoteHash: 'a'.repeat(64),
    anchorSet: { type: 'html', textQuote: { exact: 'x', prefix: '', suffix: '' }, start: 1 },
    kind: 'essential',
    color: 'amber',
    priority: 3,
    userComment: '',
    headingContext: null,
    captureMethod: 'toolbar',
    capturedAt: '2026-10-11T00:00:00.000Z',
    resolveStatus: 'resolved',
    resolveConfidence: 1,
    lastResolvedAt: null,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}
