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
 *   'searchIndexState'  { v, since, purgeMark, checksum } bookkeeping for that exact text
 *   'searchIndexStale'  written by a backup restore: rows were replaced or removed without moving
 *                       any `updatedAt` this cache could see. Present = rebuild, then remove it.
 *
 * Opening: restore the cache; when it is missing, corrupt, from another analyzer/version, bound to
 * other bookkeeping, older than the last purge (a purge leaves no row to report) or marked stale by
 * a restore, rebuild from the vault with real progress. Otherwise catch up through
 * `listSearchDocumentsChangedSince`. The same two checks (purge, restore) run before every catch-up.
 */

export const INDEX_KEY = 'searchIndex';
export const INDEX_STATE_KEY = 'searchIndexState';
export const INDEX_STALE_KEY = 'searchIndexStale';
const PAGE = 500;
/** Writes land a little before a reconcile starts; look this far back so none is missed. */
export const SKEW_MS = 5_000;
export const PERSIST_DELAY_MS = 3_000;
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

export interface SearchHostPorts {
  listAll(options: { afterId?: string; limit?: number }): Promise<SearchDocument[]>;
  listChangedSince(options: {
    since: string;
    afterId?: string;
    limit?: number;
  }): Promise<SearchDocument[]>;
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
}

const isState = (value: unknown): value is PersistedState => {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.v === 1 &&
    typeof s.since === 'string' &&
    typeof s.checksum === 'string' &&
    (s.purgeMark === null || typeof s.purgeMark === 'string')
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

/** Any value other than absent/null: `delete` may be missing from a port, which then writes null. */
const isMarked = (value: unknown): boolean => value !== undefined && value !== null;

export class SearchHost {
  private readonly ports: SearchHostPorts;
  private current: SearchIndex | null = null;
  private status: SearchHostState = { phase: 'idle' };
  private readonly listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;
  private since = '';
  private purgeMark: string | null = null;
  private rejected = 0;
  private rev = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
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
    const [text, state, purgeAt, stale] = await Promise.all([
      this.ports.meta.get(INDEX_KEY),
      this.ports.meta.get(INDEX_STATE_KEY),
      this.ports.getLastPurgeAt(),
      this.ports.meta.get(INDEX_STALE_KEY),
    ]);
    if (isMarked(stale)) return this.build('restore');
    if (typeof text !== 'string' || text === '') return this.build('missing');
    if (!isState(state) || state.checksum !== checksumOf(text)) return this.build('corrupt');
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
    this.dirty = false;
    await this.catchUp();
  }

  private async build(reason: RebuildReason): Promise<void> {
    const startedAt = this.now();
    const purgeAt = await this.ports.getLastPurgeAt();
    // Read before the vault is: a restore that lands during the build leaves a different value.
    const staleSeen = await this.ports.meta.get(INDEX_STALE_KEY);
    const total = (await this.ports.countDocuments?.()) ?? null;
    this.current = null;
    this.set({ phase: 'building', reason, done: 0, total });
    const fresh = (this.ports.createIndex ?? createSearchIndex)();
    let afterId: string | undefined;
    let done = 0;
    let rejected = 0;
    for (;;) {
      const docs = await this.ports.listAll({ afterId, limit: PAGE });
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
    this.dirty = true;
    this.rev++;
    this.set({ phase: 'ready', documents: fresh.stats().documents, rejected });
    if (!isMarked(staleSeen)) {
      this.persistSoon();
      return;
    }
    // The old cache is wrong: write the new one before the marker goes, so a crash in between
    // rebuilds again instead of bringing the old cache back.
    await this.persist();
    if (!this.dirty) await this.clearStale(staleSeen);
  }

  private async clearStale(seen: unknown): Promise<void> {
    const { meta } = this.ports;
    // Another restore finished while this build read the vault: leave its marker for the next pass.
    if ((await meta.get(INDEX_STALE_KEY)) !== seen) return;
    if (meta.delete) await meta.delete(INDEX_STALE_KEY);
    else await meta.put(INDEX_STALE_KEY, null);
  }

  private async catchUp(): Promise<void> {
    const index = this.current;
    if (!index) return;
    const startedAt = this.now();
    const purgeAt = await this.ports.getLastPurgeAt();
    if (purgeAt !== null && (this.purgeMark === null || this.purgeMark < purgeAt)) {
      return this.build('purge');
    }
    if (isMarked(await this.ports.meta.get(INDEX_STALE_KEY))) return this.build('restore');
    this.set({ phase: 'updating', documents: index.stats().documents });
    let afterId: string | undefined;
    let changed = false;
    for (;;) {
      const docs = await this.ports.listChangedSince({ since: this.since, afterId, limit: PAGE });
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
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DELAY_MS);
  }

  private async persist(): Promise<void> {
    const index = this.current;
    if (!index || !this.dirty) return;
    const text = index.serialize();
    const checksum = checksumOf(text);
    if (checksum === null) return; // not our format: never write bookkeeping for it
    const state: PersistedState = {
      v: 1,
      since: this.since,
      purgeMark: this.purgeMark,
      checksum,
    };
    const entries = [
      { key: INDEX_KEY, value: text },
      { key: INDEX_STATE_KEY, value: state },
    ];
    if (this.ports.meta.putMany) await this.ports.meta.putMany(entries);
    else for (const e of entries) await this.ports.meta.put(e.key, e.value);
    this.dirty = false;
  }
}
