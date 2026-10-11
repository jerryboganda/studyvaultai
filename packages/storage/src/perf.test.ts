// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { HIGHLIGHT_KINDS } from '@shared';
import { closeDb, getDb, resetDbForTests } from './db';
import { findDuplicateClusters, getCounts, listHighlights } from './query';
import { checkIntegrity } from './registry';
import { listBanksWithCounts, saveCapture } from './repo';
import { listSearchDocuments, listSearchDocumentsChangedSince } from './search';
import { seedVault, type SeedSummary } from './seed';
import { listTags } from './tags';
import { cap } from './test-fixtures';
import type { HighlightQuery } from './types';

/**
 * Phase 2 workload: 10 000 seeded highlights on fake-indexeddb in Node (TEST_PLAN "Performance
 * targets", ROADMAP Phase 2 gate). Heavy, so it only runs when SV_PERF is set (CI does):
 *   SV_PERF=1 pnpm exec vitest run packages/storage/src/perf.test.ts
 *
 * fake-indexeddb is far slower than a real browser engine, so these are regression budgets for the
 * read paths, not claims about Chrome. Budgets are asserted on the p95 of the CPU time a call used
 * (process.cpuUsage): a busy machine inflates wall-clock time but not CPU time. Both are printed.
 */

const HIGHLIGHTS = Number(process.env.SV_PERF_HIGHLIGHTS ?? 10_000);
/** milliseconds, p95. `facets` is the all-in-one dashboard facet call. */
const BUDGET = { list: 300, counts: 100, save: 50, facets: 400 };

interface Samples {
  wall: number[];
  cpu: number[];
}

const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

async function measure(runs: number, fn: (i: number) => Promise<unknown>): Promise<Samples> {
  const out: Samples = { wall: [], cpu: [] };
  for (let i = 0; i < runs; i++) {
    const cpu = process.cpuUsage();
    const t = performance.now();
    await fn(i);
    out.wall.push(performance.now() - t);
    const used = process.cpuUsage(cpu);
    out.cpu.push((used.user + used.system) / 1000);
  }
  return out;
}

const report: string[] = [];
/** Print one line; returns the CPU p95 the budget is asserted on. */
const note = (label: string, s: Samples, budget?: number) => {
  const f = (n: number) => n.toFixed(1).padStart(7);
  report.push(
    `${label.padEnd(34)} n=${String(s.wall.length).padStart(3)}  wall p50 ${f(percentile(s.wall, 50))} p95 ${f(
      percentile(s.wall, 95),
    )} max ${f(Math.max(...s.wall))} | cpu p50 ${f(percentile(s.cpu, 50))} p95 ${f(
      percentile(s.cpu, 95),
    )} ms${budget ? `  (budget ${budget} ms p95)` : ''}`,
  );
  return percentile(s.cpu, 95);
};

describe.skipIf(!process.env.SV_PERF)('10k seeded vault (SV_PERF)', () => {
  let seeded: SeedSummary;

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resetDbForTests();
    fakeBrowser.reset();
    const db = getDb();
    await db.open();
    const t = performance.now();
    seeded = await seedVault(db, {
      highlights: HIGHLIGHTS,
      banks: 12,
      foldersPerBank: 20,
      folderDepth: 4,
      tags: 40,
      noteEvery: 10,
      trashEvery: 100,
      seed: 20261011,
    });
    report.push(`seeded ${HIGHLIGHTS} highlights in ${(performance.now() - t).toFixed(0)} ms`);
    // Restart: a fresh connection, like a service worker waking up.
    closeDb();
  }, 600_000);

  afterAll(() => {
    console.log(`\n--- storage performance (SV_PERF) ---\n${report.join('\n')}\n`);
  });

  it('filtered dashboard lists: p95 under budget', async () => {
    const queries: HighlightQuery[] = [];
    for (const bankId of seeded.bankIds.slice(1, 5)) {
      queries.push({ bankId, limit: 50 });
      queries.push({ bankId, kinds: ['essential', 'formula'], limit: 50 });
      queries.push({ bankId, sort: { by: 'priority', dir: 'desc' }, limit: 50 });
    }
    for (const tagId of seeded.tagIds.slice(0, 4)) {
      queries.push({ tagIds: [tagId], limit: 50 });
      queries.push({ tagIds: [tagId], priorities: [4, 5], limit: 50 });
    }
    queries.push(
      { kinds: ['essential'], limit: 50 },
      { priorities: [5], resolveStatuses: ['resolved', 'changed'], limit: 50 },
      { folderId: seeded.folderIds[3]!, limit: 50 },
      { hasNote: true, limit: 50 },
      { sourceId: seeded.sourceIds[10]!, limit: 50 },
      {
        dateRange: { from: '2026-01-02T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' },
        limit: 50,
      },
      { kinds: [...HIGHLIGHT_KINDS], sort: { by: 'updatedAt', dir: 'asc' }, limit: 50 },
      { limit: 50 },
    );
    // The first call also opens the database after the "restart".
    const opened = performance.now();
    await listHighlights({ limit: 1 });
    report.push(`first read after a restart: ${(performance.now() - opened).toFixed(0)} ms`);

    const samples = await measure(queries.length * 2, (i) =>
      listHighlights(queries[i % queries.length]!),
    );
    expect(note('listHighlights (filtered, 50/page)', samples, BUDGET.list)).toBeLessThan(
      BUDGET.list,
    );

    // A later page resumes from a cursor.
    const first = await listHighlights({ limit: 50 });
    const paged = await measure(10, () => listHighlights({ limit: 50, cursor: first.nextCursor }));
    expect(note('listHighlights (page 2 by cursor)', paged, BUDGET.list)).toBeLessThan(BUDGET.list);
  }, 300_000);

  it('bank and tag counts: p95 under budget', async () => {
    await listBanksWithCounts(); // warm
    const banks = await measure(15, () => listBanksWithCounts());
    const tags = await measure(15, () => listTags());
    expect(note('listBanksWithCounts', banks, BUDGET.counts)).toBeLessThan(BUDGET.counts);
    expect(note('listTags (with counts)', tags, BUDGET.counts)).toBeLessThan(BUDGET.counts);

    const all = await getCounts();
    expect(all.total).toBe(seeded.liveHighlights);
    const facets = await measure(5, () => getCounts());
    expect(note('getCounts (all facets)', facets, BUDGET.facets)).toBeLessThan(BUDGET.facets);
  }, 300_000);

  it('save: p95 under budget on a loaded vault', async () => {
    // The first write after a restart checks once per connection for rows from a newer build.
    const first = performance.now();
    await saveCapture(cap('Warm-up capture on the loaded vault', 1));
    report.push(`first write after a restart: ${(performance.now() - first).toFixed(0)} ms`);

    const samples = await measure(30, (i) =>
      saveCapture(cap(`Perf capture number ${i} on the loaded vault`, 100 + i * 50)),
    );
    expect(note('saveCapture', samples, BUDGET.save)).toBeLessThan(BUDGET.save);
  }, 300_000);

  it('reports (no budget): search feed, duplicate hints, integrity check', async () => {
    note(
      'listSearchDocuments (500/page)',
      await measure(5, () => listSearchDocuments({ limit: 500 })),
    );
    note(
      'searchDocuments changedSince',
      await measure(3, () =>
        listSearchDocumentsChangedSince({ since: '2026-01-07T00:00:00.000Z', limit: 500 }),
      ),
    );
    note('findDuplicateClusters', await measure(2, () => findDuplicateClusters()));
    const t = performance.now();
    const integrity = await checkIntegrity();
    report.push(`checkIntegrity: ${(performance.now() - t).toFixed(0)} ms, ok=${integrity.ok}`);
    expect(integrity.tables.highlights!.rows).toBeGreaterThanOrEqual(HIGHLIGHTS);
  }, 300_000);
});
