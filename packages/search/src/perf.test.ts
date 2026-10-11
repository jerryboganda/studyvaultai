/**
 * Budgets from TEST_PLAN.md: p95 < 300 ms for typical filtered queries over a seeded 10k-document
 * corpus; index build < 3 s. The corpus is deterministic; queries are derived from the corpus' own
 * statistics (most frequent words, most frequent bigram) so that they are heavy rather than lucky.
 * Measured numbers are printed. They are Node/jsdom numbers on whatever machine runs this suite.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_STOP_WORDS } from './analyzer';
import { createSearchIndex, deserializeSearchIndex } from './searchIndex';
import type { SearchIndex } from './searchIndex';
import { generateCorpus } from './testUtils';
import type { SearchDocument } from './schema';

const N = 10_000;
// SEARCH_PERF_SLACK=3 relaxes every budget threefold for a dev box that is oversubscribed (several
// agents / test files at once). CI runs with the default of 1: the budgets below are the TEST_PLAN ones.
const SLACK = Math.max(1, Number(process.env.SEARCH_PERF_SLACK ?? 1) || 1);
const BUILD_BUDGET_MS = 3000 * SLACK;
const QUERY_P95_BUDGET_MS = 300 * SLACK;
const RUNS = 8;

let docs: SearchDocument[] = [];
let index: SearchIndex;
let firstBuildMs = 0;
let bestBuildMs = 0;
let queries: string[] = [];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

/** Most frequent content words (by document frequency) and the most frequent adjacent pair. */
function corpusStats(list: SearchDocument[]): { words: string[]; bigram: string } {
  const stop = new Set(DEFAULT_STOP_WORDS);
  const df = new Map<string, number>();
  const bi = new Map<string, number>();
  for (const d of list) {
    const toks = d.quote.split(' ');
    const seen = new Set<string>();
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i]!;
      if (stop.has(w)) continue;
      seen.add(w);
      const next = toks[i + 1];
      if (next !== undefined && !stop.has(next)) {
        const k = `${w} ${next}`;
        bi.set(k, (bi.get(k) ?? 0) + 1);
      }
    }
    for (const w of seen) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const rank = (m: Map<string, number>): string[] =>
    [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
  return { words: rank(df), bigram: rank(bi)[0]! };
}

beforeAll(() => {
  docs = generateCorpus(N);
  const builds: number[] = [];
  // best of 3: the first build also pays JIT warm-up, and shared CI machines add scheduling noise
  for (let i = 0; i < 3; i++) {
    index = undefined as unknown as SearchIndex; // let the previous build be collected
    const t0 = performance.now();
    const fresh = createSearchIndex();
    const r = fresh.applyChanges(docs);
    builds.push(performance.now() - t0);
    expect(r.added).toBe(N);
    expect(r.rejected).toEqual([]);
    index = fresh;
  }
  firstBuildMs = builds[0]!;
  bestBuildMs = Math.min(...builds);

  const { words, bigram } = corpusStats(docs);
  const [w1, w2, w3, w4] = [words[0]!, words[1]!, words[4]!, words[20]!];
  queries = [
    w1,
    `${w1} ${w2}`,
    `"${bigram}"`,
    `"${bigram}" priority:>=3`,
    `${w1} bank:Cardiology`,
    `${w2} ${w3} tag:tag-7*`,
    `(${w1} OR ${w2}) -${w3} kind:formula`,
    `${w2.slice(0, -1)}${w2.endsWith('a') ? 'e' : 'a'}`, // one substituted letter: fuzzy path
    `${w3} ${w4} status:resolved has:note`,
    'bank:Neurology kind:formula priority:>=4',
    `host:wikipedia.org ${w4}`,
    'has:tag folder:Valves',
    `type:note ${w1}`,
    '5 mg',
  ];
}, 180_000);

describe(`${N} documents`, () => {
  it(`builds the index in under ${BUILD_BUDGET_MS} ms`, () => {
    const s = index.stats();
    console.log(
      `[search perf] build ${N} docs: first ${firstBuildMs.toFixed(0)} ms, best of 3 ${bestBuildMs.toFixed(0)} ms (${s.terms} terms)`,
    );
    expect(index.size).toBe(N);
    expect(bestBuildMs).toBeLessThan(BUILD_BUDGET_MS);
  });

  it(`answers typical filtered queries with p95 under ${QUERY_P95_BUDGET_MS} ms`, () => {
    // warm up the JIT the way a long-lived side panel would be
    for (const q of queries) index.search(q);

    const all: number[] = [];
    const lines: string[] = [];
    let heavyHits = 0;
    for (const [n, q] of queries.entries()) {
      const times: number[] = [];
      let total = 0;
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        const res = index.search(q, { limit: 50 });
        times.push(performance.now() - t0);
        total = res.total;
      }
      if (n === 0) heavyHits = total;
      times.sort((a, b) => a - b);
      all.push(...times);
      lines.push(
        `  ${q.padEnd(46)} hits=${String(total).padStart(5)}  p50=${percentile(times, 0.5).toFixed(1).padStart(5)} ms  max=${times[times.length - 1]!.toFixed(1).padStart(5)} ms`,
      );
    }
    all.sort((a, b) => a - b);
    const p95 = percentile(all, 0.95);
    console.log(
      `[search perf] ${queries.length} queries x ${RUNS} runs over ${N} docs (limit 50, facets + suggestions on)\n${lines.join('\n')}\n  overall p50=${percentile(all, 0.5).toFixed(1)} ms  p95=${p95.toFixed(1)} ms  max=${all[all.length - 1]!.toFixed(1)} ms`,
    );
    expect(heavyHits).toBeGreaterThan(300); // the benchmark must actually be heavy
    expect(p95).toBeLessThan(QUERY_P95_BUDGET_MS);
  }, 120_000);

  it('incremental single-document update is cheap', () => {
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const d = docs[i * 37]!;
      const t0 = performance.now();
      index.upsert({ ...d, comment: `edited ${i}`, updatedAt: '2026-12-01T00:00:00.000Z' });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(
      `[search perf] upsert p50=${percentile(times, 0.5).toFixed(2)} ms p95=${percentile(times, 0.95).toFixed(2)} ms`,
    );
    expect(percentile(times, 0.95)).toBeLessThan(50);
  });

  it('reconciling an unchanged corpus (startup path) is cheap', () => {
    const t0 = performance.now();
    const r = index.applyChanges(docs, { snapshot: true });
    const ms = performance.now() - t0;
    console.log(
      `[search perf] reconcile ${N} docs (${r.unchanged} unchanged): ${ms.toFixed(0)} ms`,
    );
    expect(r.rejected).toEqual([]);
    expect(r.removed).toBe(0);
    expect(ms).toBeLessThan(BUILD_BUDGET_MS);
  });

  it('serialise and restore', () => {
    const t0 = performance.now();
    const text = index.serialize();
    const ser = performance.now() - t0;
    const t1 = performance.now();
    const restored = deserializeSearchIndex(text);
    const load = performance.now() - t1;
    console.log(
      `[search perf] serialize ${(text.length / 1e6).toFixed(1)} MB in ${ser.toFixed(0)} ms; restore in ${load.toFixed(0)} ms`,
    );
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.index.size).toBe(index.size);
      const q = queries[1]!;
      expect(restored.index.search(q).total).toBe(index.search(q).total);
      expect(load).toBeLessThan(BUILD_BUDGET_MS * 2);
    }
  }, 120_000);
});
