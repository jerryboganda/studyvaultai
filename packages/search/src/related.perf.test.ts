/**
 * Budget: `related()` p95 under 50 ms over a seeded 10k-document vault for what the interactive
 * Related section asks (10 hits, 16 terms, with or without the same source); the widest request the
 * API allows (50 hits, 32 terms) gets twice that. Heavy, so it runs only when SV_PERF is set (CI's
 * `stress` job does, through scripts/run-perf.mjs):
 *   SV_PERF=1 pnpm exec vitest run packages/search/src/related.perf.test.ts --environment node
 *
 * The corpus is perf.test.ts's, shaped like a real vault: every highlight document carries its own
 * id as `highlightId`, and the note documents repeat the quote and facets of the highlight they
 * belong to. Sources are spread evenly over the highlights, so some have notes and some have none.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createSearchIndex } from './searchIndex';
import type { SearchIndex } from './searchIndex';
import type { SearchDocument } from './schema';
import { generateCorpus } from './testUtils';

const N = 10_000;
// Same switch as perf.test.ts: 3 relaxes the budget threefold on an oversubscribed dev box.
const SLACK = Math.max(1, Number(process.env.SEARCH_PERF_SLACK ?? 1) || 1);
const P95_BUDGET_MS = 50 * SLACK;
const WIDEST_BUDGET_MS = 2 * P95_BUDGET_MS;
const SOURCES = 200;
const RUNS = 3;

function vaultLike(raw: SearchDocument[]): SearchDocument[] {
  const highlights: SearchDocument[] = [];
  const out: SearchDocument[] = [];
  for (const d of raw) {
    if (d.docType === 'highlight' || highlights.length === 0) {
      const h: SearchDocument = { ...d, docType: 'highlight', highlightId: d.id };
      highlights.push(h);
      out.push(h);
      continue;
    }
    const h = highlights[(Math.imul(out.length, 2654435761) >>> 0) % highlights.length]!;
    out.push({
      ...d,
      highlightId: h.id,
      title: h.title,
      url: h.url,
      host: h.host,
      quote: h.quote,
      headingContext: h.headingContext,
      tags: h.tags,
      banks: h.banks,
      folderPath: h.folderPath,
      kind: h.kind,
      priority: h.priority,
      resolveStatus: h.resolveStatus,
    });
  }
  return out;
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

describe.skipIf(!process.env.SV_PERF)(`related highlights over ${N} documents (SV_PERF)`, () => {
  let index: SearchIndex;
  let sources: string[] = [];

  beforeAll(() => {
    const docs = vaultLike(generateCorpus(N));
    index = createSearchIndex();
    expect(index.applyChanges(docs).rejected).toEqual([]);
    const live = docs.filter((d) => d.docType === 'highlight' && d.deletedAt === null);
    const step = Math.floor(live.length / SOURCES);
    sources = Array.from({ length: SOURCES }, (_, i) => live[i * step]!.id);
  }, 180_000);

  it(`answers with p95 under ${P95_BUDGET_MS} ms`, () => {
    for (const id of sources.slice(0, 20)) index.related(id); // warm the JIT like a long-lived page
    const variants = [
      { name: 'default (10 hits, 16 terms)', options: {}, budget: P95_BUDGET_MS },
      { name: 'same source excluded', options: { excludeSameSource: true }, budget: P95_BUDGET_MS },
      {
        name: 'widest (50 hits, 32 terms)',
        options: { limit: 50, maxTerms: 32 },
        budget: WIDEST_BUDGET_MS,
      },
    ];
    const lines: string[] = [];
    const over: string[] = [];
    for (const { name, options, budget } of variants) {
      const times: number[] = [];
      let withHits = 0;
      let terms = 0;
      for (const id of sources) {
        for (let run = 0; run < RUNS; run++) {
          const t0 = performance.now();
          const r = index.related(id, options);
          times.push(performance.now() - t0);
          if (run === 0) {
            if (r.hits.length > 0) withHits++;
            terms += r.terms.length;
          }
        }
      }
      times.sort((a, b) => a - b);
      const p95 = percentile(times, 0.95);
      if (p95 >= budget) over.push(`${name}: p95 ${p95.toFixed(1)} ms, budget ${budget} ms`);
      lines.push(
        `  ${name.padEnd(30)} p50=${percentile(times, 0.5).toFixed(1).padStart(5)} ms  p95=${p95.toFixed(1).padStart(5)} ms  max=${times[times.length - 1]!.toFixed(1).padStart(5)} ms  sources with hits=${withHits}/${SOURCES}  mean terms=${(terms / SOURCES).toFixed(1)}`,
      );
      // the benchmark must be meaningful: most sources find something to relate to
      expect(withHits).toBeGreaterThan(SOURCES * 0.5);
    }
    console.log(
      `[related perf] ${SOURCES} sources x ${RUNS} runs over ${N} documents (${index.stats().terms} terms)\n${lines.join('\n')}`,
    );
    expect(over).toEqual([]);
  }, 120_000);
});
