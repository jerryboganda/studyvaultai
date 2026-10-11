import {
  createSearchIndex,
  deserializeSearchIndex,
  type ApplyResult,
  type LoadResult,
  type SearchIndex,
  type SearchOptions,
  type SearchResult,
} from '@search';
import type { SearchDocument } from '@shared';
import type { MetaPort } from './meta';

/**
 * Hosts the full-text index in this page (the dashboard is an extension page; ADR-005 keeps
 * private text out of web pages, and the index lives next to the data it indexes).
 *
 * Persistence contract with the `meta` table:
 *   'searchIndex'       the text of `SearchIndex.serialize()` (a derived cache, never authoritative)
 *   'searchIndexState'  { v, since, purgeMark, checksum, generation } bookkeeping for that exact text
 *   'searchIndexStale'  the GENERATION of the vault: an opaque token a backup restore (or "delete all
 *                       data") replaces. Rows were replaced or removed without moving any
 *                       `updatedAt` this cache could see, so every cache and every open host built for
 *                       another generation is wrong. It is never removed: each host remembers the value
 *                       it indexed (and persists it in `searchIndexState.generation`) and rebuilds when
 *                       the vault's value differs. Absent and null both mean "never replaced".
 *
 * Opening: restore the cache; when it is missing, corrupt, from another analyzer/version, bound to
 * other bookkeeping, older than the last purge (a purge leaves no row to report) or built for another
 * generation, rebuild from the vault with real progress. Otherwise catch up through
 * `listSearchDocumentsChangedSince`. The same two checks (purge, generation) run before every
 * catch-up, and a write of the cache first checks the generation again (see `persist`).
 */

export const INDEX_KEY = 'searchIndex';
export const INDEX_STATE_KEY = 'searchIndexState';
export const INDEX_STALE_KEY = 'searchIndexStale';
const PAGE = 500;
/**
 * A catch-up asks for rows changed since (its start - this). Writers stamp a row once their
 * transaction holds its lock, so this only has to cover how long one transaction runs. (A lookback
 * wider than this re-reads, and re-counts as rejected, every unreadable row inside it.)
 */
export const SKEW_MS = 5_000;
export const PERSIST_DELAY_MS = 3_000;
/**
 * Writing the cache serialises the whole index on the page's main thread (about 1 s for 10,000
 * documents on a shared dev machine, docs/PERF_REVIEW.md), so a quiet 3 s is not enough on a large
 * vault: the next timed write waits this many times as long as the last one took, which bounds the
 * share of the page's time the cache can take to about 1 / (1 + factor). Hiding the page still
 * writes at once.
 */
export const PERSIST_COST_FACTOR = 20;
const PERSIST_DELAY_MAX_MS = 120_000;
export const RECONCILE_DELAY_MS = 250;

export type RebuildReason =
  'missing' | 'corrupt' | 'version' | 'analyzer' | 'purge' | 'restore' | 'requested';

export type SearchHostState =
  | { phase: 'idle' }
  | { phase: 'restoring' }
  | { phase: 'building'; reason: RebuildReason; done: number; total: number | null }
  | { phase: 'updating'; documents: number }
  | { phase: 'ready'; documents: number; rejected: number }
  | { phase: 'error'; message: string };

/**
 * The feed contract: a page holds `limit` documents unless the feed ended, so a page shorter than
 * `limit` is the last one. Rows the feed passes over because they exist but cannot be read are
 * reported through `onSkipped` (called at most once per page); they count as rejected.
 */
export interface FeedPageOptions {
  afterId?: string;
  limit?: number;
  onSkipped?: (count: number) => void;
}

export interface SearchHostPorts {
  listAll(options: FeedPageOptions): Promise<SearchDocument[]>;
  listChangedSince(options: FeedPageOptions & { since: string }): Promise<SearchDocument[]>;
  getLastPurgeAt(): Promise<string | null>;
  /** How many documents a rebuild will read (for a real progress bar); null when unknown. */
  countDocuments?(): Promise<number | null>;
  meta: MetaPort;
  now?(): Date;
  createIndex?(): SearchIndex;
  deserialize?(text: unknown): LoadResult;
}

interface PersistedState {
  v: 1;
  since: string;
  purgeMark: string | null;
  checksum: string;
  /** The vault generation this cache was built for; absent in caches written before generations. */
  generation?: string | null;
}

const isState = (value: unknown): value is PersistedState => {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.v === 1 &&
    typeof s.since === 'string' &&
    typeof s.checksum === 'string' &&
    (s.purgeMark === null || typeof s.purgeMark === 'string') &&
    (s.generation === undefined || s.generation === null || typeof s.generation === 'string')
  );
};

const CHECKSUM = /"checksum":"([0-9a-f]+)"/;
/** The integrity tag `serialize()` writes near the start of its text; ties bookkeeping to one text. */
export function checksumOf(text: string): string | null {
  return CHECKSUM.exec(text.slice(0, 600))?.[1] ?? null;
}

/**
 * Kept for callers that still map documents before indexing. The index accepts the vault's
 * documents as they are (a note with no highlight has a null kind, priority and status; @search
 * holds them as '' and 0), so there is nothing left to convert.
 */
export const toIndexDocument = (doc: SearchDocument): SearchDocument => doc;

/** The generation marker as a comparable value: absent and null (a cleared marker) are one. */
const generationOf = (value: unknown): string | null =>
  value === undefined || value === null
    ? null
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

export class SearchHost {
  private readonly ports: SearchHostPorts;
  private current: SearchIndex | null = null;
  private status: SearchHostState = { phase: 'idle' };
  private readonly listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;
  private since = '';
  private purgeMark: string | null = null;
  /** The vault generation (`searchIndexStale`) the in-memory index was built or restored for. */
  private generation: string | null = null;
  private rejected = 0;
  private rev = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long the last write of the cache took (serialise + put); 0 before the first one. */
  private persistCostMs = 0;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(ports: SearchHostPorts) {
    this.ports = ports;
  }

  get state(): SearchHostState {
    return this.status;
  }

  /** The index while it is usable (ready or catching up); null while restoring or rebuilding. */
  get index(): SearchIndex | null {
    return this.status.phase === 'ready' || this.status.phase === 'updating' ? this.current : null;
  }

  /** Changes whenever the indexed content changed (a build or a catch-up that applied something). */
  get revision(): number {
    return this.rev;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  search(query: string, options?: SearchOptions): SearchResult {
    const index = this.index;
    if (!index) throw new Error('The search index is not ready yet.');
    return index.search(query, options);
  }

  /** Restore (or build) the index. Safe to call again after an error. */
  start(): Promise<void> {
    this.disposed = false;
    return this.enqueue(() => this.load());
  }

  /** Throw the cache away and read everything again (palette command, recovery from a bad index). */
  rebuild(): Promise<void> {
    return this.enqueue(() => this.build('requested'));
  }

  /** The vault changed: catch up soon. Many calls within the delay become one pass. */
  reconcileSoon(): void {
    if (this.disposed || this.status.phase === 'idle') return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.enqueue(() => this.catchUp());
    }, RECONCILE_DELAY_MS);
  }

  /** Write the cache now (page hidden, closing). */
  flush(): Promise<void> {
    return this.enqueue(() => this.persist());
  }

  dispose(): void {
    this.disposed = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.listeners.clear();
  }

  // --- internals --------------------------------------------------------------------------

  private set(next: SearchHostState): void {
    this.status = next;
    for (const listener of [...this.listeners]) listener();
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.chain.then(job, job);
    // Keep the chain alive after a failure; callers still see the rejection on `run`.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((err: unknown) => {
      this.set({
        phase: 'error',
        message: err instanceof Error && err.message ? err.message : 'The search index failed.',
      });
    });
  }

  private now(): Date {
    return this.ports.now?.() ?? new Date();
  }

  private sinceFor(startedAt: Date): string {
    return new Date(startedAt.getTime() - SKEW_MS).toISOString();
  }

  private async load(): Promise<void> {
    this.set({ phase: 'restoring' });
    const [text, state, purgeAt, marker] = await Promise.all([
      this.ports.meta.get(INDEX_KEY),
      this.ports.meta.get(INDEX_STATE_KEY),
      this.ports.getLastPurgeAt(),
      this.ports.meta.get(INDEX_STALE_KEY),
    ]);
    const generation = generationOf(marker);
    if (typeof text !== 'string' || text === '') return this.build('missing');
    if (!isState(state) || state.checksum !== checksumOf(text)) return this.build('corrupt');
    if ((state.generation ?? null) !== generation) return this.build('restore');
    if (purgeAt !== null && (state.purgeMark === null || state.purgeMark < purgeAt)) {
      return this.build('purge');
    }
    const loaded = (this.ports.deserialize ?? deserializeSearchIndex)(text);
    if (!loaded.ok) {
      return this.build(
        loaded.reason === 'version' || loaded.reason === 'analyzer' ? loaded.reason : 'corrupt',
      );
    }
    this.current = loaded.index;
    this.since = state.since;
    this.purgeMark = state.purgeMark;
    this.generation = generation;
    this.dirty = false;
    await this.catchUp();
  }

  private async build(reason: RebuildReason): Promise<void> {
    const startedAt = this.now();
    const purgeAt = await this.ports.getLastPurgeAt();
    // Read before the vault is: a restore that lands during the build leaves a different value, and
    // the next catch-up (or write of the cache) sees that this index is for the previous one.
    const generation = generationOf(await this.ports.meta.get(INDEX_STALE_KEY));
    const total = (await this.ports.countDocuments?.()) ?? null;
    this.current = null;
    this.set({ phase: 'building', reason, done: 0, total });
    const fresh = (this.ports.createIndex ?? createSearchIndex)();
    let afterId: string | undefined;
    let done = 0;
    let rejected = 0;
    for (;;) {
      let skipped = 0;
      const docs = await this.ports.listAll({
        afterId,
        limit: PAGE,
        onSkipped: (n) => {
          skipped += n;
        },
      });
      rejected += skipped;
      done += skipped;
      if (docs.length === 0) break;
      const result = await fresh.applyChangesAsync(docs);
      rejected += result.rejected.length;
      done += docs.length;
      afterId = docs[docs.length - 1]!.id;
      this.set({ phase: 'building', reason, done, total });
      if (docs.length < PAGE) break;
    }
    this.current = fresh;
    this.rejected = rejected;
    this.since = this.sinceFor(startedAt);
    this.purgeMark = purgeAt;
    this.generation = generation;
    this.dirty = true;
    this.rev++;
    this.set({ phase: 'ready', documents: fresh.stats().documents, rejected });
    this.persistSoon();
  }

  private async catchUp(): Promise<void> {
    const index = this.current;
    if (!index) return;
    const startedAt = this.now();
    const purgeAt = await this.ports.getLastPurgeAt();
    if (purgeAt !== null && (this.purgeMark === null || this.purgeMark < purgeAt)) {
      return this.build('purge');
    }
    // Compared, never consumed: every host that holds an index must see the same change.
    if (generationOf(await this.ports.meta.get(INDEX_STALE_KEY)) !== this.generation) {
      return this.build('restore');
    }
    this.set({ phase: 'updating', documents: index.stats().documents });
    let afterId: string | undefined;
    let changed = false;
    for (;;) {
      let skipped = 0;
      const docs = await this.ports.listChangedSince({
        since: this.since,
        afterId,
        limit: PAGE,
        onSkipped: (n) => {
          skipped += n;
        },
      });
      this.rejected += skipped;
      if (docs.length === 0) break;
      const result: ApplyResult = await index.applyChangesAsync(docs);
      this.rejected += result.rejected.length;
      if (result.added + result.replaced + result.removed > 0) changed = true;
      afterId = docs[docs.length - 1]!.id;
      if (docs.length < PAGE) break;
    }
    this.since = this.sinceFor(startedAt);
    if (changed) {
      this.dirty = true;
      this.rev++;
    }
    this.set({ phase: 'ready', documents: index.stats().documents, rejected: this.rejected });
    if (this.dirty) this.persistSoon();
  }

  private persistSoon(): void {
    if (this.disposed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    const wait = Math.min(
      PERSIST_DELAY_MAX_MS,
      Math.max(PERSIST_DELAY_MS, this.persistCostMs * PERSIST_COST_FACTOR),
    );
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, wait);
  }

  private async persist(): Promise<void> {
    const index = this.current;
    if (!index || !this.dirty) return;
    const startedAt = this.now().getTime();
    // The vault was restored or wiped since this index was built (another page did it): writing
    // this index, with its `since`, would put rows that are gone over a cache that is right. Drop
    // the write and let the next catch-up rebuild. (A write that still slips in between this read
    // and the put carries the old generation, so every loader rejects it.)
    if (generationOf(await this.ports.meta.get(INDEX_STALE_KEY)) !== this.generation) {
      this.dirty = false;
      this.reconcileSoon();
      return;
    }
    const text = index.serialize();
    const checksum = checksumOf(text);
    if (checksum === null) return; // not our format: never write bookkeeping for it
    const state: PersistedState = {
      v: 1,
      since: this.since,
      purgeMark: this.purgeMark,
      checksum,
      generation: this.generation,
    };
    const entries = [
      { key: INDEX_KEY, value: text },
      { key: INDEX_STATE_KEY, value: state },
    ];
    if (this.ports.meta.putMany) await this.ports.meta.putMany(entries);
    else for (const e of entries) await this.ports.meta.put(e.key, e.value);
    this.dirty = false;
    this.persistCostMs = Math.max(0, this.now().getTime() - startedAt);
  }
}
