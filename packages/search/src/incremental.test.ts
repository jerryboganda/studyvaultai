/**
 * Property-style check: an index maintained incrementally (add / replace / remove / soft-delete /
 * batch / snapshot) must answer every query exactly like an index rebuilt from the final document set,
 * and so must one restored from its own serialisation. Deterministic: seeds are fixed.
 */
import { describe, expect, it } from 'vitest';
import { createSearchIndex, deserializeSearchIndex } from './searchIndex';
import type { SearchIndex, SearchResult } from './searchIndex';
import type { SearchDocument } from './schema';
import { CORPUS_BANKS, CORPUS_KINDS, CORPUS_TAGS, generateCorpus, prng } from './testUtils';

function mutate(d: SearchDocument, rand: () => number, step: number): SearchDocument {
  const words = d.quote.split(' ');
  const next: SearchDocument = {
    ...d,
    tags: [...d.tags],
    banks: [...d.banks],
    updatedAt: `2026-12-${String(1 + (step % 28)).padStart(2, '0')}T00:00:00.000Z`,
  };
  const r = rand();
  if (r < 0.3) {
    words[Math.floor(rand() * words.length)] = 'mutated' + Math.floor(rand() * 5);
    next.quote = words.join(' ');
  } else if (r < 0.5) {
    next.tags = [CORPUS_TAGS[Math.floor(rand() * CORPUS_TAGS.length)]!];
  } else if (r < 0.65) {
    next.banks = [CORPUS_BANKS[Math.floor(rand() * CORPUS_BANKS.length)]!];
  } else if (r < 0.8) {
    next.comment = rand() < 0.5 ? '' : `added comment ${words[0]} ${words[1] ?? ''}`;
  } else if (r < 0.9) {
    next.kind = CORPUS_KINDS[Math.floor(rand() * CORPUS_KINDS.length)]!;
  } else {
    next.deletedAt = next.deletedAt ? null : '2026-12-30T00:00:00.000Z';
  }
  return next;
}

function queriesFor(docs: SearchDocument[], rand: () => number): string[] {
  const pick = <T>(l: T[]): T => l[Math.floor(rand() * l.length)]!;
  const wordsOf = (d: SearchDocument): string[] => d.quote.split(' ').filter((w) => w.length > 3);
  const out = [
    '',
    'mutated0',
    'mutated1 OR mutated2',
    'has:note',
    'priority:>=4',
    'type:note',
    '"added comment"',
  ];
  for (let i = 0; i < 18 && docs.length > 0; i++) {
    const d = pick(docs);
    const w = wordsOf(d);
    if (w.length < 2) continue;
    const a = pick(w);
    const b = pick(w);
    out.push(a, `${a} ${b}`, `${a} OR ${b}`, `${a} -${b}`, `"${a} ${b}"`, a.slice(0, -1) + 'x');
    out.push(`${a} bank:${d.banks[0] ?? 'Cardiology'}`);
    if (d.tags[0]) out.push(`tag:${d.tags[0]}`, `${a} tag:${d.tags[0]}*`);
    out.push(`kind:${d.kind} priority:<=${d.priority}`, `host:${d.host ?? 'example.com'}`);
  }
  return out;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function view(r: SearchResult): unknown {
  return {
    total: r.total,
    hits: r.hits.map((h) => [h.id, round(h.score), h.matchedFields]),
    facets: r.facets,
    dym: r.didYouMean,
  };
}

function expectSame(a: SearchIndex, b: SearchIndex, queries: string[], label: string): void {
  expect(a.size, label).toBe(b.size);
  expect(a.stats(), label).toEqual(b.stats());
  for (const q of queries) {
    for (const includeDeleted of [false, true]) {
      const opts = { includeDeleted, limit: 25 };
      expect(
        view(a.search(q, opts)),
        `${label}: ${JSON.stringify(q)} del=${includeDeleted}`,
      ).toEqual(view(b.search(q, opts)));
    }
  }
}

describe('incremental updates equal a rebuild', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, () => {
      const rand = prng(seed * 7919);
      const pool = generateCorpus(90, seed);
      const truth = new Map<string, SearchDocument>();
      const index = createSearchIndex();

      for (let step = 0; step < 160; step++) {
        const r = rand();
        const d = pool[Math.floor(rand() * pool.length)]!;
        if (r < 0.3) {
          const cur = truth.get(d.id) ?? d;
          const next = rand() < 0.5 ? cur : mutate(cur, rand, step);
          truth.set(next.id, next);
          index.upsert(next);
        } else if (r < 0.45) {
          const ids = [...truth.keys()];
          if (ids.length > 0) {
            const id = ids[Math.floor(rand() * ids.length)]!;
            truth.delete(id);
            expect(index.remove(id)).toBe(true);
          }
        } else if (r < 0.6) {
          const cur = truth.get(d.id);
          if (cur) {
            const toggled: SearchDocument = {
              ...cur,
              deletedAt: cur.deletedAt ? null : '2026-11-11T00:00:00.000Z',
              updatedAt: '2026-11-11T00:00:00.000Z',
            };
            truth.set(toggled.id, toggled);
            index.upsert(toggled);
          }
        } else if (r < 0.9) {
          const batch: SearchDocument[] = [];
          for (let k = 0; k < 10; k++) {
            const b = pool[Math.floor(rand() * pool.length)]!;
            const cur = truth.get(b.id) ?? b;
            const next = rand() < 0.4 ? mutate(cur, rand, step + k) : cur;
            batch.push(next);
            truth.set(next.id, next);
          }
          index.applyChanges(batch);
        } else {
          // full snapshot: the index must drop everything not listed
          const keep = [...truth.values()].filter(() => rand() < 0.85);
          truth.clear();
          for (const k of keep) truth.set(k.id, k);
          index.applyChanges(keep, { snapshot: true });
        }
      }

      const final = [...truth.values()];
      const rebuilt = createSearchIndex();
      rebuilt.applyChanges(final);
      const queries = queriesFor(final, rand);
      expectSame(index, rebuilt, queries, `seed ${seed} incremental`);

      const restored = deserializeSearchIndex(index.serialize());
      expect(restored.ok).toBe(true);
      if (restored.ok) {
        expectSame(restored.index, rebuilt, queries, `seed ${seed} restored`);
        // the restored index must keep updating correctly (removal re-tokenizes the stored text)
        const extra = mutate(final[0] ?? pool[0]!, rand, 99);
        restored.index.upsert(extra);
        rebuilt.upsert(extra);
        if (final[1]) {
          restored.index.remove(final[1].id);
          rebuilt.remove(final[1].id);
        }
        expectSame(restored.index, rebuilt, queries, `seed ${seed} restored+updated`);
      }
    });
  }

  it('applyChanges is idempotent and reports unchanged documents', () => {
    const docs = generateCorpus(200, 11);
    const index = createSearchIndex();
    const first = index.applyChanges(docs);
    expect(first).toMatchObject({ added: 200, replaced: 0, unchanged: 0, removed: 0 });
    const before = index.serialize();
    const second = index.applyChanges(docs);
    expect(second).toMatchObject({ added: 0, replaced: 0, unchanged: 200, removed: 0 });
    expect(index.serialize()).toBe(before);
    const snap = index.applyChanges(docs, { snapshot: true });
    expect(snap.removed).toBe(0);
  });

  it('a snapshot removes documents that vanished and keeps rejected ones', () => {
    const docs = generateCorpus(10, 12);
    const index = createSearchIndex();
    index.applyChanges(docs);
    const r = index.applyChanges([...docs.slice(0, 5), { id: docs[5]!.id, quote: 'broken' }], {
      snapshot: true,
    });
    expect(r.removed).toBe(4);
    expect(r.rejected).toHaveLength(1);
    expect(index.has(docs[5]!.id)).toBe(true); // the failed update did not delete the old version
    expect(index.size).toBe(6);
  });

  it('applyChangesAsync gives the same result, in chunks, with real progress', async () => {
    const docs = generateCorpus(500, 21);
    const sync = createSearchIndex();
    const expected = sync.applyChanges(docs);
    const index = createSearchIndex();
    const seen: Array<[number, number]> = [];
    const result = await index.applyChangesAsync(docs, {
      chunkSize: 120,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(result).toEqual(expected);
    expect(seen).toEqual([
      [120, 500],
      [240, 500],
      [360, 500],
      [480, 500],
      [500, 500],
    ]);
    expectSame(index, sync, ['', 'aortic', 'priority:>=4'], 'async');
  });

  it('an aborted async build is consistent and converges when repeated', async () => {
    const docs = generateCorpus(400, 22);
    const index = createSearchIndex();
    const controller = new AbortController();
    await expect(
      index.applyChangesAsync(docs, {
        chunkSize: 50,
        signal: controller.signal,
        onProgress: (done) => {
          if (done >= 150) controller.abort(new Error('cancelled'));
        },
      }),
    ).rejects.toThrow('cancelled');
    expect(index.size).toBe(150);
    expect(index.search('').total).toBeGreaterThan(0); // still queryable
    await index.applyChangesAsync(docs, { chunkSize: 100 });
    const fresh = createSearchIndex();
    fresh.applyChanges(docs);
    expectSame(index, fresh, ['', 'aortic', 'bank:Cardiology'], 'after retry');
  });

  it('an async snapshot removes documents that vanished', async () => {
    const docs = generateCorpus(60, 23);
    const index = createSearchIndex();
    await index.applyChangesAsync(docs);
    const r = await index.applyChangesAsync(docs.slice(0, 40), { snapshot: true, chunkSize: 7 });
    expect(r.removed).toBe(20);
    expect(index.size).toBe(40);
  });
});
