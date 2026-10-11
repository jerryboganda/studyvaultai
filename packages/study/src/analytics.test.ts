// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  backlog,
  countsByBank,
  countsByDeck,
  dueForecast,
  estimatedRetention,
  streak,
  studyLog,
  syllabusCoverage,
  trueRetention,
} from './analytics';
import type { Rating, ReviewLog } from './schema';
import { DAY, T0, idOf, makeCard } from './testUtils';
import type { DayBoundary } from './time';

const UTC: DayBoundary = { timeZone: 'UTC', rolloverHour: 0 };
const LA: DayBoundary = { timeZone: 'America/Los_Angeles', rolloverHour: 0 };
const T0MS = Date.parse(T0);
const iso = (ms: number): string => new Date(ms).toISOString();

type LogRow = Pick<
  ReviewLog,
  'cardId' | 'reviewedAt' | 'rating' | 'durationMs' | 'previousState' | 'userCorrection'
>;
const log = (
  at: string,
  rating: Rating = 3,
  over: {
    prev?: 'new' | 'learning' | 'review';
    duration?: number;
    undone?: boolean;
    cardId?: string;
  } = {},
): LogRow => ({
  cardId: over.cardId ?? 'card-00001',
  reviewedAt: at,
  rating,
  durationMs: over.duration ?? 5000,
  previousState: makeCard('x-0000001', { state: over.prev ?? 'review' }).fsrs,
  ...(over.undone ? { userCorrection: { kind: 'undone' as const, at } } : {}),
});

describe('dueForecast', () => {
  it('buckets cards into the next 30 study days, with overdue and beyond kept apart', () => {
    const now = '2026-03-08T20:00:00.000Z'; // 13:00 PDT, the 23h DST day in Los Angeles
    const cards = [
      makeCard('c-0000001', { state: 'review', due: '2026-03-05T12:00:00.000Z' }), // overdue
      makeCard('c-0000002', { state: 'review', due: '2026-03-08T08:00:00.000Z' }), // today, first instant
      makeCard('c-0000003', { state: 'review', due: '2026-03-09T06:59:59.000Z' }), // today, last second
      makeCard('c-0000004', { state: 'review', due: '2026-03-09T07:00:00.000Z' }), // tomorrow
      makeCard('c-0000005', { state: 'learning', due: '2026-03-08T21:00:00.000Z' }), // today (learning)
      makeCard('c-0000006', { state: 'review', due: '2026-04-07T06:59:00.000Z' }), // day 29, last minute
      makeCard('c-0000007', { state: 'review', due: '2026-04-07T07:00:00.000Z' }), // day 30 starts here -> beyond
      makeCard('c-0000008', { state: 'review', due: '2026-03-10T10:00:00.000Z', suspended: true }),
      makeCard('c-0000009', { state: 'review', due: '2026-03-10T10:00:00.000Z', deleted: true }),
      makeCard('c-0000010'), // new, available
      makeCard('c-0000011', { due: '2026-03-20T00:00:00.000Z' }), // new, postponed
    ];
    const f = dueForecast(cards, now, LA);
    expect(f.days).toHaveLength(30);
    expect(f.days[0]).toMatchObject({
      dayOffset: 0,
      dayKey: '2026-03-08',
      due: 3,
      review: 2,
      learning: 1,
    });
    expect(f.days[1]).toMatchObject({ dayOffset: 1, dayKey: '2026-03-09', due: 1 });
    expect(f.days[29]).toMatchObject({ dayOffset: 29, dayKey: '2026-04-06', due: 1 });
    expect(f.overdue).toBe(1);
    expect(f.beyond).toBe(1);
    expect(f.newAvailable).toBe(1);
    expect(f.days.reduce((n, d) => n + d.due, 0) + f.overdue + f.beyond).toBe(7);
  });

  it('reports a flat zero forecast for no cards, not invented numbers', () => {
    const f = dueForecast([], T0, UTC);
    expect(f.totalCards).toBe(0);
    expect(f.days.every((d) => d.due === 0)).toBe(true);
  });
});

describe('backlog', () => {
  it('measures overdue reviews in study days', () => {
    const cards = [
      makeCard('c-0000001', { state: 'review', due: iso(T0MS - 10 * DAY) }),
      makeCard('c-0000002', { state: 'review', due: iso(T0MS - 3 * DAY) }),
      makeCard('c-0000003', { state: 'review', due: iso(T0MS - DAY), deckId: 'deck-0002' }),
      makeCard('c-0000004', { state: 'review', due: iso(T0MS + 3_600_000) }), // later today
      makeCard('c-0000005', { state: 'learning', due: iso(T0MS - 60_000) }),
      makeCard('c-0000006', { state: 'review', due: iso(T0MS - 4 * DAY), suspended: true }),
    ];
    const b = backlog(cards, T0, UTC);
    expect(b).toMatchObject({
      overdue: 3,
      dueToday: 1,
      learningDue: 1,
      oldestOverdueDays: 10,
      medianOverdueDays: 3,
      overdueByDeck: { 'deck-0001': 2, 'deck-0002': 1 },
    });
  });

  it('has null statistics when nothing is overdue', () => {
    const b = backlog([makeCard('c-0000001')], T0, UTC);
    expect(b).toMatchObject({ overdue: 0, oldestOverdueDays: null, medianOverdueDays: null });
  });
});

describe('trueRetention', () => {
  it('says "insufficient data" instead of a percentage below the sample floor', () => {
    const r = trueRetention([log(T0), log(T0, 1)]);
    expect(r.status).toBe('insufficient_data');
    expect(r.trueRetention).toBeNull();
    expect(r.matureReviews).toBe(2);
    expect(trueRetention([]).byRating[3].share).toBeNull();
  });

  it('measures recall of graduated cards by rating, ignoring learning steps and undone reviews', () => {
    const logs: LogRow[] = [];
    const plan: Rating[] = [
      ...Array<Rating>(5).fill(1),
      ...Array<Rating>(5).fill(2),
      ...Array<Rating>(20).fill(3),
      ...Array<Rating>(10).fill(4),
    ];
    plan.forEach((rating, i) => logs.push(log(iso(T0MS + i * 1000), rating)));
    logs.push(
      log(T0, 1, { prev: 'new' }),
      log(T0, 1, { prev: 'learning' }),
      log(T0, 1, { undone: true }),
    );
    const r = trueRetention(logs);
    expect(r.status).toBe('ok');
    expect(r.totalReviews).toBe(42);
    expect(r.matureReviews).toBe(40);
    expect(r.recalled).toBe(35);
    expect(r.trueRetention).toBeCloseTo(35 / 40, 10);
    expect(r.byRating[1]).toEqual({ count: 5, share: 5 / 40 });
    expect(r.byRating[3]).toEqual({ count: 20, share: 0.5 });
    expect(trueRetention(logs, { sinceMs: T0MS + 30_000 }).matureReviews).toBe(10);
    expect(trueRetention(logs, { minSamples: 50 }).trueRetention).toBeNull();
  });
});

describe('estimatedRetention', () => {
  it('is null without graduated cards, otherwise a probability', () => {
    expect(estimatedRetention([makeCard('c-0000001')], T0).value).toBeNull();
    const cards = [
      makeCard('c-0000001', { state: 'review', stability: 10, lastReview: iso(T0MS - 10 * DAY) }),
      makeCard('c-0000002', { state: 'review', stability: 30, lastReview: iso(T0MS - 5 * DAY) }),
    ];
    const e = estimatedRetention(cards, T0);
    expect(e.cards).toBe(2);
    expect(e.value).toBeGreaterThan(0.8);
    expect(e.value).toBeLessThan(1);
  });
});

describe('counts by deck and bank', () => {
  const decks = [
    { id: 'deck-0001', bankId: 'bank-0001', name: 'Anatomy', deletedAt: null },
    { id: 'deck-0002', bankId: 'bank-0001', name: 'Physiology', deletedAt: null },
    { id: 'deck-0003', bankId: null, name: 'Loose', deletedAt: null },
    { id: 'deck-0004', bankId: 'bank-0002', name: 'Old', deletedAt: T0 },
  ];
  const cards = [
    makeCard('c-0000001'),
    makeCard('c-0000002', { state: 'learning', due: iso(T0MS - 1000) }),
    makeCard('c-0000003', { state: 'review', due: iso(T0MS - 2 * DAY) }),
    makeCard('c-0000004', { state: 'review', due: iso(T0MS + 5 * DAY) }),
    makeCard('c-0000005', { state: 'review', suspended: true }),
    makeCard('c-0000006', { state: 'relearning', due: iso(T0MS + 3_600_000), deckId: 'deck-0002' }),
    makeCard('c-0000007', { deckId: 'deck-0003' }),
    makeCard('c-0000008', { deckId: 'deck-0004' }),
    makeCard('c-0000009', { deckId: 'deck-9999' }),
    makeCard('c-0000010', { deleted: true }),
  ];

  it('counts states, due and overdue per deck; deleted decks and cards do not count', () => {
    const { decks: rows, orphanCards } = countsByDeck(cards, decks, T0, UTC);
    expect(rows.map((r) => r.name)).toEqual(['Anatomy', 'Loose', 'Physiology']);
    expect(rows[0]).toMatchObject({
      total: 5,
      new: 1,
      learning: 1,
      review: 2,
      suspended: 1,
      due: 2, // the learning step due now and the overdue review
      overdue: 1,
    });
    expect(rows[2]).toMatchObject({ total: 1, relearning: 1, due: 0 });
    expect(orphanCards).toBe(2); // deck-0004 is deleted, deck-9999 never existed
  });

  it('rolls decks up into banks, keeping unfiled decks together', () => {
    const { decks: rows } = countsByDeck(cards, decks, T0, UTC);
    const banks = countsByBank(rows);
    const b1 = banks.find((b) => b.bankId === 'bank-0001');
    expect(b1).toMatchObject({ decks: 2, total: 6, learning: 1, relearning: 1 });
    expect(banks.find((b) => b.bankId === null)).toMatchObject({ decks: 1, total: 1, new: 1 });
  });
});

describe('studyLog', () => {
  it("returns one row per day including empty days, in the user's time zone", () => {
    // 2026-03-08T07:30Z is 23:30 on Mar 7 in LA; 08:30Z is 00:30 on Mar 8.
    const logs = [
      log('2026-03-08T07:30:00.000Z', 3, { prev: 'new', duration: 4000 }),
      log('2026-03-08T08:30:00.000Z', 1, { duration: 10 * 60_000 }),
      log('2026-03-08T09:00:00.000Z', 4, { duration: 2000 }),
      log('2026-03-08T09:05:00.000Z', 3, { undone: true }),
      log('2026-03-01T00:00:00.000Z', 3), // outside the 7-day window
    ];
    const rows = studyLog(logs, '2026-03-08T20:00:00.000Z', LA, { days: 7 });
    expect(rows.map((r) => r.dayKey)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
    ]);
    expect(rows[5]).toMatchObject({
      reviews: 1,
      newCards: 1,
      durationMs: 4000,
      passed: 1,
      accuracy: 1,
    });
    expect(rows[6]).toMatchObject({ reviews: 2, newCards: 0, passed: 1, accuracy: 0.5 });
    expect(rows[6]?.durationMs).toBe(5 * 60_000 + 2000); // idle time capped at 5 minutes per answer
    expect(rows[0]).toMatchObject({ reviews: 0, accuracy: null, durationMs: 0 });
  });
});

describe('streak', () => {
  const dayLog = (offsetDays: number, hour = 12) =>
    log(iso(Date.UTC(2026, 0, 20 + offsetDays, hour)));
  const now = '2026-01-20T15:00:00.000Z';

  it('counts consecutive study days ending today', () => {
    const s = streak(
      [dayLog(0), dayLog(-1), dayLog(-2), dayLog(-4), dayLog(-5), dayLog(-6), dayLog(-7)],
      now,
      UTC,
    );
    expect(s).toEqual({
      current: 3,
      longest: 4,
      studiedToday: true,
      lastStudyDayKey: '2026-01-20',
    });
  });

  it('keeps the streak alive while today is still open, and breaks it after a missed day', () => {
    const yesterdayOnly = streak([dayLog(-1), dayLog(-2)], now, UTC);
    expect(yesterdayOnly).toMatchObject({ current: 2, studiedToday: false });
    const missed = streak([dayLog(-2), dayLog(-3)], now, UTC);
    expect(missed).toMatchObject({ current: 0, longest: 2 });
  });

  it('is zero (not invented) without logs, and ignores undone and future logs', () => {
    expect(streak([], now, UTC)).toEqual({
      current: 0,
      longest: 0,
      studiedToday: false,
      lastStudyDayKey: null,
    });
    const s = streak(
      [{ ...dayLog(0), userCorrection: { kind: 'undone', at: now } }, dayLog(3), dayLog(4)],
      now,
      UTC,
    );
    expect(s).toMatchObject({ current: 0, longest: 0, lastStudyDayKey: null });
  });

  it('uses the rollover hour: a 02:00 review belongs to the previous day', () => {
    const boundary: DayBoundary = { timeZone: 'America/Los_Angeles', rolloverHour: 4 };
    // 2026-01-21T10:00Z = 02:00 PST Jan 21 -> study day Jan 20
    const s = streak(
      [log('2026-01-21T10:00:00.000Z'), log('2026-01-19T20:00:00.000Z')],
      '2026-01-21T11:00:00.000Z',
      boundary,
    );
    expect(s).toMatchObject({ current: 2, studiedToday: true, lastStudyDayKey: '2026-01-20' });
  });
});

describe('syllabusCoverage', () => {
  const cards = [
    makeCard('c-0000001', { state: 'review' }),
    makeCard('c-0000002', { state: 'review' }),
    makeCard('c-0000003', { state: 'learning' }),
    makeCard('c-0000004'),
    makeCard('c-0000005', { state: 'review', suspended: true }),
  ];
  it('classifies nodes by the state of their active cards', () => {
    const r = syllabusCoverage(
      ['n-heart', 'n-lung', 'n-renal', 'n-liver', 'n-gut', 'n-heart'],
      [
        { nodeId: 'n-heart', cardId: 'c-0000001' },
        { nodeId: 'n-heart', cardId: 'c-0000002' },
        { nodeId: 'n-lung', cardId: 'c-0000002' },
        { nodeId: 'n-lung', cardId: 'c-0000003' },
        { nodeId: 'n-renal', cardId: 'c-0000004' },
        { nodeId: 'n-liver', cardId: 'c-0000005' }, // suspended: covers nothing
        { nodeId: 'n-elsewhere', cardId: 'c-0000001' }, // not in the syllabus
      ],
      cards,
    );
    expect(r.status).toBe('ok');
    expect(r.total).toBe(5);
    expect(Object.fromEntries(r.nodes.map((n) => [n.nodeId, n.status]))).toEqual({
      'n-heart': 'learned',
      'n-lung': 'learning',
      'n-renal': 'new',
      'n-liver': 'uncovered',
      'n-gut': 'uncovered',
    });
    expect(r.covered).toBe(3);
    expect(r.ratio).toBeCloseTo(0.6, 10);
    expect(r.learned).toBe(1);
  });

  it('has no ratio when there is no syllabus', () => {
    expect(syllabusCoverage([], [], cards)).toMatchObject({
      status: 'no_syllabus',
      ratio: null,
      learnedRatio: null,
      total: 0,
    });
  });
});

describe('performance of log analytics', () => {
  it('processes 100,000 logs in a reasonable time', () => {
    const logs: LogRow[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      logs.push(
        log(iso(T0MS - (i % 400) * DAY - (i % 86_400) * 1000), ((i % 4) + 1) as Rating, {
          cardId: idOf('card', i % 5000),
        }),
      );
    }
    const t0 = performance.now();
    streak(logs, T0, LA);
    studyLog(logs, T0, LA, { days: 90 });
    trueRetention(logs);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
