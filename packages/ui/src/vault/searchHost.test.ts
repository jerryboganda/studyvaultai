import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchDocument } from '@shared';
import type { MetaPort } from './meta';
import {
  INDEX_KEY,
  INDEX_STALE_KEY,
  INDEX_STATE_KEY,
  RECONCILE_DELAY_MS,
  SKEW_MS,
  SearchHost,
  checksumOf,
  type SearchHostPorts,
  type SearchHostState,
} from './searchHost';

const T0 = '2026-10-11T10:00:00.000Z';

function doc(id: string, over: Partial<SearchDocument> = {}): SearchDocument {
  return {
    id,
    docType: 'highlight',
    highlightId: id,
    title: 'Cell biology',
    url: 'https://example.com/cells',
    host: 'example.com',
    quote: `Mitochondria produce ATP (${id}).`,
    comment: '',
    headingContext: null,
    tags: [],
    banks: ['Biology'],
    folderPath: [],
    kind: 'essential',
    priority: 3,
    resolveStatus: 'resolved',
    updatedAt: T0,
    deletedAt: null,
    ...over,
  };
}

class Store {
  docs = new Map<string, SearchDocument>();
  purgeAt: string | null = null;
  listAllCalls = 0;
  changedCalls: Array<{ since: string; afterId?: string }> = [];
  failListAll: Error | null = null;
  /** The port of a surface that never added `delete` (the null-write fallback). */
  withoutDelete = false;
  /** Runs inside the next full read, between its pages (a restore landing during a build). */
  duringList: (() => void) | null = null;
  meta = new Map<string, unknown>();
  now = new Date('2026-10-11T12:00:00.000Z');

  put(...docs: SearchDocument[]) {
    for (const d of docs) this.docs.set(d.id, d);
  }

  ports(): SearchHostPorts {
    const sorted = () => [...this.docs.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const page = (list: SearchDocument[], afterId: string | undefined, limit = 500) =>
      list.filter((d) => afterId === undefined || d.id > afterId).slice(0, limit);
    const meta: MetaPort = {
      get: async (key) => this.meta.get(key),
      put: async (key, value) => void this.meta.set(key, value),
      putMany: async (entries) => {
        for (const e of entries) this.meta.set(e.key, e.value);
      },
      ...(this.withoutDelete ? {} : { delete: async (key: string) => void this.meta.delete(key) }),
    };
    return {
      listAll: async ({ afterId, limit } = {}) => {
        this.listAllCalls++;
        if (this.failListAll) throw this.failListAll;
        const rows = page(sorted(), afterId, limit);
        const hook = this.duringList;
        this.duringList = null;
        hook?.();
        return rows;
      },
      listChangedSince: async ({ since, afterId, limit }) => {
        this.changedCalls.push({ since, afterId });
        return page(
          sorted().filter((d) => d.updatedAt >= since),
          afterId,
          limit,
        );
      },
      getLastPurgeAt: async () => this.purgeAt,
      countDocuments: async () => this.docs.size,
      meta,
      now: () => this.now,
    };
  }

  host() {
    return new SearchHost(this.ports());
  }
}

const hosts: SearchHost[] = [];
const make = (store: Store) => {
  const host = store.host();
  hosts.push(host);
  return host;
};
afterEach(() => {
  vi.useRealTimers();
  for (const h of hosts.splice(0)) h.dispose();
});

describe('SearchHost: building', () => {
  it('builds from the vault with real progress, then searches and persists', async () => {
    const store = new Store();
    store.put(...Array.from({ length: 1_200 }, (_, i) => doc(`h${String(i).padStart(5, '0')}`)));
    const host = make(store);
    const seen: SearchHostState[] = [];
    host.subscribe(() => seen.push(host.state));

    await host.start();

    const building = seen.filter((s) => s.phase === 'building');
    expect(building.length).toBeGreaterThan(1);
    expect(building[0]).toMatchObject({ reason: 'missing', total: 1_200 });
    expect(Math.max(...building.map((b) => (b.phase === 'building' ? b.done : 0)))).toBe(1_200);
    expect(host.state).toMatchObject({ phase: 'ready', documents: 1_200, rejected: 0 });
    expect(host.search('mitochondria').total).toBe(1_200);

    await host.flush();
    const text = store.meta.get(INDEX_KEY);
    expect(typeof text).toBe('string');
    expect(store.meta.get(INDEX_STATE_KEY)).toMatchObject({
      v: 1,
      since: new Date(store.now.getTime() - SKEW_MS).toISOString(),
      checksum: checksumOf(text as string),
    });
  });

  it('has no usable index until the build finishes', async () => {
    const store = new Store();
    store.put(doc('a'));
    const host = make(store);
    expect(host.index).toBeNull();
    expect(() => host.search('x')).toThrow(/not ready/);
    await host.start();
    expect(host.index).not.toBeNull();
  });

  it('indexes a note that belongs to no highlight (null kind, priority and status)', async () => {
    const store = new Store();
    store.put(
      doc('n1', {
        docType: 'note',
        highlightId: null,
        quote: '',
        comment: 'Free standing note about ribosomes',
        kind: null,
        priority: null,
        resolveStatus: null,
      }),
    );
    const host = make(store);
    await host.start();
    expect(host.state).toMatchObject({ phase: 'ready', documents: 1, rejected: 0 });
    expect(host.search('ribosomes').total).toBe(1);
    // the index holds the missing values as '' and 0, and says so itself
    expect(host.search('ribosomes').hits[0]!.doc).toMatchObject({
      kind: '',
      priority: 0,
      resolveStatus: '',
    });
    expect(host.search('ribosomes kind:essential').total).toBe(0);
  });
});

describe('SearchHost: restoring', () => {
  async function persisted() {
    const store = new Store();
    store.put(doc('a'), doc('b', { quote: 'Ribosomes make proteins.' }));
    const first = make(store);
    await first.start();
    await first.flush();
    first.dispose();
    store.listAllCalls = 0;
    store.changedCalls = [];
    return store;
  }

  it('restores the cache without reading the whole vault, then catches up incrementally', async () => {
    const store = await persisted();
    store.now = new Date('2026-10-11T13:00:00.000Z');
    store.put(
      doc('c', {
        quote: 'Golgi apparatus packages proteins.',
        updatedAt: '2026-10-11T12:30:00.000Z',
      }),
    );

    const host = make(store);
    await host.start();

    expect(store.listAllCalls).toBe(0);
    expect(store.changedCalls).toHaveLength(1);
    expect(store.changedCalls[0]!.since).toBe(
      new Date(new Date('2026-10-11T12:00:00.000Z').getTime() - SKEW_MS).toISOString(),
    );
    expect(host.state).toMatchObject({ phase: 'ready', documents: 3 });
    expect(host.search('golgi').total).toBe(1);
    expect(host.search('ribosomes').total).toBe(1);
  });

  it('applies a deletion that happened while the page was closed', async () => {
    const store = await persisted();
    store.put(
      doc('a', { updatedAt: '2026-10-11T12:30:00.000Z', deletedAt: '2026-10-11T12:30:00.000Z' }),
    );
    const host = make(store);
    await host.start();
    expect(host.search('mitochondria').total).toBe(0);
    expect(host.search('mitochondria', { includeDeleted: true }).total).toBe(1);
  });

  it.each([
    ['unreadable text', () => 'not json at all', 'corrupt'],
    ['a truncated index', (t: string) => t.slice(0, t.length - 40), 'corrupt'],
  ])('rebuilds when the cache is %s', async (_name, damage, reason) => {
    const store = await persisted();
    store.meta.set(INDEX_KEY, damage(store.meta.get(INDEX_KEY) as string));
    const host = make(store);
    const reasons: string[] = [];
    host.subscribe(() => {
      if (host.state.phase === 'building') reasons.push(host.state.reason);
    });
    await host.start();
    expect(reasons[0]).toBe(reason);
    expect(store.listAllCalls).toBeGreaterThan(0);
    expect(host.state).toMatchObject({ phase: 'ready', documents: 2 });
  });

  it('rebuilds when the bookkeeping belongs to another text', async () => {
    const store = await persisted();
    const state = store.meta.get(INDEX_STATE_KEY) as Record<string, unknown>;
    store.meta.set(INDEX_STATE_KEY, { ...state, checksum: 'deadbeef' });
    const host = make(store);
    await host.start();
    expect(store.listAllCalls).toBeGreaterThan(0);
  });

  it('rebuilds when someone else wrote a raw index without bookkeeping', async () => {
    const store = await persisted();
    store.meta.delete(INDEX_STATE_KEY);
    const host = make(store);
    await host.start();
    expect(store.listAllCalls).toBeGreaterThan(0);
  });

  it('rebuilds when a purge is newer than the cache, so purged rows leave the index', async () => {
    const store = await persisted();
    store.docs.delete('a'); // purged: no row remains to report as changed
    store.purgeAt = '2026-10-11T12:45:00.000Z';
    const host = make(store);
    const reasons: string[] = [];
    host.subscribe(() => {
      if (host.state.phase === 'building') reasons.push(host.state.reason);
    });
    await host.start();
    expect(reasons[0]).toBe('purge');
    expect(host.search('mitochondria').total).toBe(0);
    expect(host.state).toMatchObject({ phase: 'ready', documents: 1 });

    // The new bookkeeping carries the purge mark: the next open is incremental again.
    await host.flush();
    store.listAllCalls = 0;
    const again = make(store);
    await again.start();
    expect(store.listAllCalls).toBe(0);
  });

  it('does not treat an old purge as new', async () => {
    const store = new Store();
    store.purgeAt = '2026-10-01T00:00:00.000Z';
    store.put(doc('a'));
    const first = make(store);
    await first.start();
    await first.flush();
    store.listAllCalls = 0;
    const second = make(store);
    await second.start();
    expect(store.listAllCalls).toBe(0);
  });
});

describe('SearchHost: after a backup restore', () => {
  async function persisted() {
    const store = new Store();
    store.put(doc('a'), doc('b', { quote: 'Ribosomes make proteins.' }));
    const first = make(store);
    await first.start();
    await first.flush();
    first.dispose();
    store.listAllCalls = 0;
    return store;
  }

  /** What a replace-mode restore does: rows come and go without any updatedAt moving forward. */
  function restoreInto(store: Store) {
    store.docs.delete('b');
    store.put(
      doc('c', {
        quote: 'Golgi apparatus packages proteins.',
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    store.meta.set(INDEX_STALE_KEY, '2026-10-11T12:30:00.000Z');
  }

  it('rebuilds on open, writes the new cache, and only then removes the marker', async () => {
    const store = await persisted();
    restoreInto(store);
    const host = make(store);
    const reasons: string[] = [];
    host.subscribe(() => {
      if (host.state.phase === 'building') reasons.push(host.state.reason);
    });

    await host.start();

    expect(reasons[0]).toBe('restore');
    expect(host.search('golgi').total).toBe(1);
    expect(host.search('ribosomes').total).toBe(0);
    expect(store.meta.has(INDEX_STALE_KEY)).toBe(false);
    // the cache on disk is the rebuilt one: the next open is incremental and sees the same rows
    store.listAllCalls = 0;
    const again = make(store);
    await again.start();
    expect(store.listAllCalls).toBe(0);
    expect(again.search('golgi').total).toBe(1);
    expect(again.search('ribosomes').total).toBe(0);
  });

  it('rebuilds a page that is already open when the restore lands', async () => {
    const store = new Store();
    store.put(doc('a'), doc('b', { quote: 'Ribosomes make proteins.' }));
    const host = make(store);
    await host.start();
    expect(host.search('ribosomes').total).toBe(1);

    restoreInto(store);
    vi.useFakeTimers();
    host.reconcileSoon();
    await vi.advanceTimersByTimeAsync(RECONCILE_DELAY_MS + 5);
    vi.useRealTimers();
    await host.flush();

    expect(host.search('ribosomes').total).toBe(0);
    expect(host.search('golgi').total).toBe(1);
    expect(store.meta.has(INDEX_STALE_KEY)).toBe(false);
  });

  it('leaves the marker of a second restore that landed during the build', async () => {
    const store = await persisted();
    restoreInto(store);
    store.duringList = () => store.meta.set(INDEX_STALE_KEY, '2026-10-11T12:45:00.000Z');
    const host = make(store);
    await host.start();
    expect(store.meta.get(INDEX_STALE_KEY)).toBe('2026-10-11T12:45:00.000Z');

    // the next pass sees it and reads the vault again, then clears it
    store.listAllCalls = 0;
    vi.useFakeTimers();
    host.reconcileSoon();
    await vi.advanceTimersByTimeAsync(RECONCILE_DELAY_MS + 5);
    vi.useRealTimers();
    await host.flush();
    expect(store.listAllCalls).toBeGreaterThan(0);
    expect(store.meta.has(INDEX_STALE_KEY)).toBe(false);
  });

  it('clears the marker with a null write when the port has no delete', async () => {
    const store = await persisted();
    store.withoutDelete = true;
    restoreInto(store);
    const host = make(store);
    await host.start();
    expect(store.meta.get(INDEX_STALE_KEY)).toBeNull();

    // null is "absent": opening again does not rebuild
    store.listAllCalls = 0;
    await make(store).start();
    expect(store.listAllCalls).toBe(0);
  });

  it('keeps the marker when the rebuild fails, so the next start tries again', async () => {
    const store = await persisted();
    restoreInto(store);
    store.failListAll = new Error('The database is locked by another window.');
    const host = make(store);
    await host.start();
    expect(host.state.phase).toBe('error');
    expect(store.meta.has(INDEX_STALE_KEY)).toBe(true);

    store.failListAll = null;
    await host.start();
    expect(host.state.phase).toBe('ready');
    expect(store.meta.has(INDEX_STALE_KEY)).toBe(false);
  });
});

describe('SearchHost: staying current', () => {
  it('coalesces bursts of change notices into one catch-up', async () => {
    const store = new Store();
    store.put(doc('a'));
    const host = make(store);
    await host.start();
    store.changedCalls = [];

    vi.useFakeTimers();
    store.now = new Date('2026-10-11T12:10:00.000Z');
    store.put(
      doc('b', { quote: 'Lysosomes digest waste.', updatedAt: '2026-10-11T12:09:00.000Z' }),
    );
    host.reconcileSoon();
    host.reconcileSoon();
    host.reconcileSoon();
    await vi.advanceTimersByTimeAsync(RECONCILE_DELAY_MS + 5);
    vi.useRealTimers();
    await host.flush(); // waits for the queue

    expect(store.changedCalls).toHaveLength(1);
    expect(host.search('lysosomes').total).toBe(1);
  });

  it('keeps serving the previous index while catching up', async () => {
    const store = new Store();
    store.put(doc('a'));
    const host = make(store);
    await host.start();
    const phases: string[] = [];
    host.subscribe(() => {
      phases.push(host.state.phase);
      if (host.state.phase === 'updating') expect(host.index).not.toBeNull();
    });
    host.reconcileSoon();
    await new Promise((r) => setTimeout(r, RECONCILE_DELAY_MS + 50));
    await host.flush();
    expect(phases).toContain('updating');
    expect(host.state.phase).toBe('ready');
  });

  it('does not rewrite the cache when nothing changed', async () => {
    const store = new Store();
    store.put(doc('a'));
    const host = make(store);
    await host.start();
    await host.flush();
    const before = store.meta.get(INDEX_KEY);
    const put = vi.spyOn(store.ports().meta, 'put');
    await host.flush();
    expect(put).not.toHaveBeenCalled();
    expect(store.meta.get(INDEX_KEY)).toBe(before);
  });
});

describe('SearchHost: failure and recovery', () => {
  it('reports a failed build and recovers on the next start', async () => {
    const store = new Store();
    store.put(doc('a'));
    store.failListAll = new Error('The database is locked by another window.');
    const host = make(store);
    await host.start();
    expect(host.state).toEqual({
      phase: 'error',
      message: 'The database is locked by another window.',
    });
    expect(host.index).toBeNull();

    store.failListAll = null;
    await host.start();
    expect(host.state.phase).toBe('ready');
  });

  it('rebuild() replaces the index with a fresh read', async () => {
    const store = new Store();
    store.put(doc('a'));
    const host = make(store);
    await host.start();
    store.put(
      doc('b', { updatedAt: '2000-01-01T00:00:00.000Z', quote: 'Peroxisomes handle fatty acids.' }),
    );
    expect(host.search('peroxisomes').total).toBe(0);
    await host.rebuild();
    expect(host.search('peroxisomes').total).toBe(1);
  });
});
