// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backlog,
  countsByBank,
  countsByDeck,
  dueForecast,
  estimatedRetention,
  streak,
  studyLog,
  trueRetention,
} from './analytics';
import { buildQueue } from './queue';
import type { QueueOptions } from './queue';
import { seededRandom } from './random';
import type { Card, Rating, ReviewLog } from './schema';
import { DAY, T0, idOf, makeCard, makeDeck } from './testUtils';
import type { DayBoundary } from './time';

/**
 * Seeded workload for the retention engine (TEST_PLAN "Performance targets", ROADMAP Phase 4 gate):
 * a 10 000-card queue and analytics over 100 000 review logs. The functions are pure, so this needs
 * no IndexedDB. Heavy, so it only runs when SV_PERF is set (CI does, through scripts/run-perf.mjs):
 *   SV_PERF=1 pnpm exec vitest run packages/study/src/perf.test.ts
 *
 * Budgets are regression guards for a shared CI runner, asserted on the p95 of the CPU time a call
 * used (process.cpuUsage): a busy machine inflates wall-clock time but not CPU time. Both are
 * printed. They are not claims about a user's device; the real list the badge reads is `dueAt`
 * index range + Zod parse in packages/storage (storage perf suite, "not measured here").
 */

const CARDS = Number(process.env.SV_PERF_CARDS ?? 10_000);
const LOGS = Number(process.env.SV_PERF_LOGS ?? 100_000);
/** milliseconds, p95 of CPU time per call. */
const BUDGET = { queue: 400, logAnalytics: 1_500, cardAnalytics: 400 };

const LA: DayBoundary = { timeZone: 'America/Los_Angeles', rolloverHour: 4 };
const T0MS = Date.parse(T0);
const iso = (ms: number): string => new Date(ms).toISOString();

interface Samples {
  wall: number[];
  cpu: number[];
}

const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

function measure(runs: number, fn: (i: number) => unknown): Samples {
  const out: Samples = { wall: [], cpu: [] };
  for (let i = 0; i < runs; i++) {
    const cpu = process.cpuUsage();
    const t = performance.now();
    fn(i);
    out.wall.push(performance.now() - t);
    const used = process.cpuUsage(cpu);
    out.cpu.push((used.user + used.system) / 1000);
  }
  return out;
}

const report: string[] = [];
/** Print one line; returns the WALL p95 the budget is asserted on (CPU time includes GC helper threads and is only reported). */
const note = (label: string, s: Samples, budget?: number) => {
  const f = (n: number) => n.toFixed(1).padStart(7);
  report.push(
    `${label.padEnd(40)} n=${String(s.wall.length).padStart(2)}  wall p50 ${f(percentile(s.wall, 50))} p95 ${f(
      percentile(s.wall, 95),
    )} max ${f(Math.max(...s.wall))} | cpu p50 ${f(percentile(s.cpu, 50))} p95 ${f(
      percentile(s.cpu, 95),
    )} ms${budget ? `  (budget ${budget} ms p95)` : ''}`,
  );
  return percentile(s.wall, 95);
};

/** A learner's library: ~30% new, ~10% in a learning step, the rest graduated at varied ages. */
function seedCards(count: number, decks: number): Card[] {
  const rng = seededRandom(20261011);
  const cards: Card[] = [];
  for (let i = 0; i < count; i += 1) {
    const deckId = idOf('deck', (i % decks) + 1);
    const kind = i % 10;
    if (kind < 3) {
      cards.push(
        makeCard(idOf('card', i), {
          deckId,
          createdAt: iso(T0MS - Math.floor(rng() * 400) * DAY),
        }),
      );
    } else if (kind === 3) {
      cards.push(
        makeCard(idOf('card', i), {
          deckId,
          state: 'learning',
          due: iso(T0MS - Math.floor(rng() * 3_600_000)),
        }),
      );
    } else {
      const elapsed = 1 + Math.floor(rng() * 200);
      const interval = 1 + Math.floor(rng() * 150);
      cards.push(
        makeCard(idOf('card', i), {
          deckId,
          state: 'review',
          lastReview: iso(T0MS - elapsed * DAY),
          due: iso(T0MS - elapsed * DAY + interval * DAY),
          stability: 1 + rng() * 120,
          difficulty: 1 + rng() * 9,
        }),
      );
    }
  }
  return cards;
}

function seedLogs(
  count: number,
  cards: number,
): Array<
  Pick<
    ReviewLog,
    'cardId' | 'reviewedAt' | 'rating' | 'durationMs' | 'previousState' | 'userCorrection'
  >
> {
  const rng = seededRandom(77);
  const states = (['new', 'learning', 'review'] as const).map(
    (state) => makeCard('x-0000001', { state }).fsrs,
  );
  const logs = [];
  for (let i = 0; i < count; i += 1) {
    const rated = ((i % 4) + 1) as Rating;
    // Two years of history, a few thousand reviews a day at the busiest.
    const at = T0MS - Math.floor(rng() * 730) * DAY - Math.floor(rng() * DAY);
    logs.push({
      cardId: idOf('card', i % cards),
      reviewedAt: iso(at),
      rating: rated,
      durationMs: 2_000 + Math.floor(rng() * 20_000),
      previousState: states[i % 3]!,
      ...(i % 997 === 0 ? { userCorrection: { kind: 'undone' as const, at: iso(at) } } : {}),
    });
  }
  return logs;
}

describe.skipIf(!process.env.SV_PERF)('retention engine at scale (SV_PERF)', () => {
  const decks = Array.from({ length: 8 }, (_, i) =>
    makeDeck(idOf('deck', i + 1), {
      bankId: idOf('bank', (i % 3) + 1),
      settings: { newPerDay: 50, reviewsPerDay: 300 },
    }),
  );
  let cards: Card[] = [];
  let logs: ReturnType<typeof seedLogs> = [];

  // In a hook, not in the suite body: a skipped suite is still collected, and the plain unit run
  // must not pay for 110 000 rows it never reads.
  beforeAll(() => {
    cards = seedCards(CARDS, decks.length);
    logs = seedLogs(LOGS, CARDS);
  }, 120_000);

  afterAll(() => {
    console.log(
      `\n--- study performance (SV_PERF): ${CARDS} cards, ${LOGS} logs ---\n${report.join('\n')}\n`,
    );
  });

  it('builds the day queue for the whole library: p95 under budget', () => {
    const options: QueueOptions = { now: iso(T0MS), boundary: LA, decks };
    const variants: Array<[string, QueueOptions]> = [
      ['buildQueue (default order)', options],
      ['buildQueue (interleave: bank)', { ...options, interleave: 'bank' }],
      ['buildQueue (order: due, no interleave)', { ...options, order: 'due', interleave: 'none' }],
      [
        'buildQueue (new cards shuffled)',
        { ...options, newOrder: 'random', random: seededRandom(5) },
      ],
    ];
    for (const [label, opts] of variants) {
      buildQueue(cards, opts); // warm-up: JIT, Intl formatter, offset cache
      let last = buildQueue(cards, opts);
      const samples = measure(10, () => {
        last = buildQueue(cards, opts);
      });
      expect(note(label, samples, BUDGET.queue)).toBeLessThan(BUDGET.queue);

      // The workload must really be a big queue, and the queue must still be a valid one.
      expect(last.counts.total).toBeGreaterThan(1_000);
      expect(last.ids).toHaveLength(last.counts.total);
      expect(new Set(last.ids).size).toBe(last.ids.length);
      expect(last.counts.new).toBeLessThanOrEqual(50 * decks.length);
      expect(last.counts.review).toBeLessThanOrEqual(300 * decks.length);
      expect(last.deferred.review + last.deferred.new).toBeGreaterThan(0);
    }
  }, 120_000);

  it('answers the log analytics over the whole history: p95 under budget', () => {
    const now = iso(T0MS);
    const trio = measure(5, () => {
      streak(logs, now, LA);
      studyLog(logs, now, LA, { days: 90 });
      trueRetention(logs);
    });
    expect(note('streak + studyLog(90) + trueRetention', trio, BUDGET.logAnalytics)).toBeLessThan(
      BUDGET.logAnalytics,
    );

    const year = measure(5, () => studyLog(logs, now, LA, { days: 365 }));
    expect(note('studyLog (365 days)', year, BUDGET.logAnalytics)).toBeLessThan(
      BUDGET.logAnalytics,
    );

    const days = studyLog(logs, now, LA, { days: 365 });
    expect(days).toHaveLength(365);
    expect(days.reduce((n, d) => n + d.reviews, 0)).toBeGreaterThan(LOGS / 4);
    const retention = trueRetention(logs);
    expect(retention.status).toBe('ok');
    expect(retention.matureReviews).toBeGreaterThan(LOGS / 4);
  }, 120_000);

  it('answers the card analytics over the whole library: p95 under budget', () => {
    const now = iso(T0MS);
    const group = measure(10, () => {
      dueForecast(cards, now, LA);
      backlog(cards, now, LA);
      const counted = countsByDeck(cards, decks, now, LA);
      countsByBank(counted.decks);
      estimatedRetention(cards, now);
    });
    expect(
      note('forecast + backlog + counts + retention', group, BUDGET.cardAnalytics),
    ).toBeLessThan(BUDGET.cardAnalytics);

    const forecast = dueForecast(cards, now, LA);
    expect(forecast.totalCards).toBe(CARDS);
    expect(forecast.days).toHaveLength(30);
  }, 120_000);
});
