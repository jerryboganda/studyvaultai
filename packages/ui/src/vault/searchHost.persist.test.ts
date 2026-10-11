import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchDocument } from '@shared';
import {
  PERSIST_COST_FACTOR,
  PERSIST_DELAY_MS,
  RECONCILE_DELAY_MS,
  SearchHost,
  type SearchHostPorts,
} from './searchHost';

const T0 = '2026-10-11T10:00:00.000Z';

const doc = (id: string, updatedAt = T0): SearchDocument => ({
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
  updatedAt,
  deletedAt: null,
});

/** A vault whose clock only moves when a cache write "takes" `writeMs`, so the cost is exact. */
function fixture(writeMs: number) {
  const docs = new Map<string, SearchDocument>();
  const meta = new Map<string, unknown>();
  let clock = Date.parse('2026-10-11T12:00:00.000Z');
  const state = { writes: 0 };
  const ports: SearchHostPorts = {
    listAll: async ({ afterId, limit = 500 } = {}) =>
      [...docs.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .filter((d) => afterId === undefined || d.id > afterId)
        .slice(0, limit),
    listChangedSince: async ({ since, afterId, limit = 500 }) =>
      [...docs.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .filter((d) => d.updatedAt >= since && (afterId === undefined || d.id > afterId))
        .slice(0, limit),
    getLastPurgeAt: async () => null,
    countDocuments: async () => docs.size,
    meta: {
      get: async (key) => meta.get(key),
      put: async (key, value) => void meta.set(key, value),
      putMany: async (entries) => {
        state.writes++;
        clock += writeMs;
        for (const e of entries) meta.set(e.key, e.value);
      },
      delete: async (key) => void meta.delete(key),
    },
    now: () => new Date(clock),
  };
  return { docs, ports, state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SearchHost: timed writes of the cache', () => {
  it('waits longer after a write that was slow, so a large index is not re-serialised every few seconds', async () => {
    vi.useFakeTimers();
    const slow = 500;
    const { docs, ports, state } = fixture(slow);
    docs.set('a', doc('a'));
    const host = new SearchHost(ports);
    try {
      await host.start();
      // First write: nothing is known about its cost, so the plain quiet period applies.
      await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS - 1);
      expect(state.writes).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(state.writes).toBe(1);

      // A change arrives; its write is due slow * factor later, not PERSIST_DELAY_MS.
      docs.set('b', doc('b', '2026-10-11T12:00:30.000Z'));
      host.reconcileSoon();
      await vi.advanceTimersByTimeAsync(RECONCILE_DELAY_MS + 5);
      const due = slow * PERSIST_COST_FACTOR;
      expect(due).toBeGreaterThan(PERSIST_DELAY_MS);
      await vi.advanceTimersByTimeAsync(due - 100);
      expect(state.writes).toBe(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(state.writes).toBe(2);
    } finally {
      host.dispose();
    }
  });

  it('keeps the plain quiet period while writes are cheap', async () => {
    vi.useFakeTimers();
    const { docs, ports, state } = fixture(0);
    docs.set('a', doc('a'));
    const host = new SearchHost(ports);
    try {
      await host.start();
      await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS + 5);
      expect(state.writes).toBe(1);

      docs.set('b', doc('b', '2026-10-11T12:00:30.000Z'));
      host.reconcileSoon();
      await vi.advanceTimersByTimeAsync(RECONCILE_DELAY_MS + PERSIST_DELAY_MS + 10);
      expect(state.writes).toBe(2);
    } finally {
      host.dispose();
    }
  });

  it('hiding the page still writes at once, whatever the last write cost', async () => {
    vi.useFakeTimers();
    const { docs, ports, state } = fixture(2_000);
    docs.set('a', doc('a'));
    const host = new SearchHost(ports);
    try {
      await host.start();
      await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS + 5);
      expect(state.writes).toBe(1);

      docs.set('b', doc('b', '2026-10-11T12:00:30.000Z'));
      host.reconcileSoon();
      await vi.advanceTimersByTimeAsync(RECONCILE_DELAY_MS + 5);
      await host.flush();
      expect(state.writes).toBe(2);
    } finally {
      host.dispose();
    }
  });
});
