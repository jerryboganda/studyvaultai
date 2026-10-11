// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COVERAGE_THRESHOLDS,
  backlog,
  countsByBank,
  countsByDeck,
  coverageState,
  dueForecast,
  estimatedRetention,
  normalizeThresholds,
  streak,
  studyLog,
  syllabusCoverage,
  syllabusTopicCoverage,
  trueRetention,
  type CoverageCard,
  type CoverageHighlight,
  type CoverageTopic,
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

describe('syllabusTopicCoverage', () => {
  // 2026-01-05 09:00 UTC; the study day ends at 00:00 UTC on the 6th.
  const NOW = T0;
  const opts = { now: NOW, boundary: UTC };
  const none = { highlights: [], cards: [], logs: [] };

  const topic = (id: string, over: Partial<CoverageTopic> = {}): CoverageTopic => ({
    id,
    title: `Topic ${id}`,
    depth: 1,
    parentId: null,
    bankIds: [],
    tagIds: [],
    ...over,
  });
  const child = (id: string, parentId: string, over: Partial<CoverageTopic> = {}) =>
    topic(id, { parentId, depth: 2, ...over });
  const hl = (
    id: string,
    bankIds: string[] = [],
    tagIds: string[] = [],
    deletedAt: string | null = null,
  ): CoverageHighlight => ({ id, bankIds, tagIds, deletedAt });
  const card = (
    id: string,
    bankIds: string[],
    spec: Parameters<typeof makeCard>[1] & { tagIds?: string[] } = {},
  ): CoverageCard => {
    const c = makeCard(id, spec);
    return {
      id,
      deletedAt: c.deletedAt,
      suspended: c.suspended,
      fsrs: c.fsrs,
      bankIds,
      tagIds: spec.tagIds ?? [],
    };
  };
  const row = (r: ReturnType<typeof syllabusTopicCoverage>, id: string) => {
    const found = r.topics.find((t) => t.id === id);
    if (!found) throw new Error(`no topic ${id}`);
    return found;
  };

  it('counts every highlight and card once, however many mappings match', () => {
    const r = syllabusTopicCoverage(
      [
        topic('p', { bankIds: ['b1'] }),
        child('c', 'p', { bankIds: ['b1'], tagIds: ['t1'] }),
        topic('other', { tagIds: ['t9'] }),
      ],
      {
        highlights: [
          hl('h1', ['b1'], ['t1']), // matches c twice (bank and tag), and p through both
          hl('h2', ['b1']),
          hl('h3', [], ['t1']),
          hl('h4', ['b7'], ['t7']), // matches nothing
        ],
        cards: [card('k1', ['b1'], { tagIds: ['t1'] }), card('k2', [], { tagIds: ['t1'] })],
        logs: [],
      },
      opts,
    );
    expect(row(r, 'c')).toMatchObject({ highlights: 3, cards: 2 });
    // The parent counts its own bank and its subtopic's tag, h1 once.
    expect(row(r, 'p')).toMatchObject({ highlights: 3, cards: 2 });
    expect(row(r, 'other')).toMatchObject({ highlights: 0, cards: 0, mapped: true });
  });

  it('leaves out deleted highlights and deleted or suspended cards', () => {
    const r = syllabusTopicCoverage(
      [topic('a', { bankIds: ['b1'] })],
      {
        highlights: [hl('h1', ['b1']), hl('h2', ['b1'], [], '2026-01-01T00:00:00.000Z')],
        cards: [
          card('k1', ['b1']),
          card('k2', ['b1'], { suspended: true }),
          card('k3', ['b1'], { deleted: true }),
        ],
        logs: [],
      },
      opts,
    );
    expect(row(r, 'a')).toMatchObject({ highlights: 1, cards: 1 });
  });

  it('ignores the same highlight or card listed twice', () => {
    const r = syllabusTopicCoverage(
      [topic('a', { bankIds: ['b1'] })],
      { highlights: [hl('h1', ['b1']), hl('h1', ['b1'])], cards: [], logs: [] },
      opts,
    );
    expect(row(r, 'a').highlights).toBe(1);
  });

  it('weights top-level topics relative to each other and says what is covered and started', () => {
    const topics = [
      topic('big', { weight: 3, bankIds: ['b1'] }),
      topic('small', { weight: 1, bankIds: ['b2'] }),
    ];
    const facts = {
      highlights: [hl('h1', ['b1']), hl('h2', ['b1']), hl('h3', ['b1']), hl('h4', ['b2'])],
      cards: [card('k1', ['b1'])],
      logs: [],
    };
    const r = syllabusTopicCoverage(topics, facts, opts);
    expect(row(r, 'big')).toMatchObject({ state: 'covered', share: 0.75 });
    expect(row(r, 'small')).toMatchObject({ state: 'thin', share: 0.25 }); // 1 highlight, no card
    expect(r.covered).toBeCloseTo(0.75, 10);
    expect(r.started).toBeCloseTo(1, 10);
    expect(r.unmapped).toBe(0);

    const swapped = syllabusTopicCoverage(
      [
        { ...(topics[0] as CoverageTopic), weight: 1 },
        { ...(topics[1] as CoverageTopic), weight: 3 },
      ],
      facts,
      opts,
    );
    expect(swapped.covered).toBeCloseTo(0.25, 10);
  });

  it('gives topics without a weight an equal share', () => {
    const r = syllabusTopicCoverage(
      [topic('a', { bankIds: ['b1'] }), topic('b'), topic('c'), topic('d')],
      { highlights: [hl('h1', ['b1'])], cards: [card('k1', ['b1'])], logs: [] },
      { ...opts, thresholds: { minHighlights: 1, minCards: 1 } },
    );
    expect(r.topics.map((t) => t.share)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(r.covered).toBeCloseTo(0.25, 10);
    expect(r.unmapped).toBe(3);
  });

  it('judges a topic with mapped subtopics from them, by their weights', () => {
    const topics = [
      topic('ch', { weight: 2 }),
      child('heavy', 'ch', { weight: 3, bankIds: ['b1'] }),
      child('light', 'ch', { weight: 1, bankIds: ['b2'] }),
      topic('q', { weight: 1, bankIds: ['b3'] }),
    ];
    const r = syllabusTopicCoverage(
      topics,
      {
        highlights: [hl('a', ['b1']), hl('b', ['b1']), hl('c', ['b1'])],
        cards: [card('k1', ['b1'])],
        logs: [],
      },
      opts,
    );
    expect(row(r, 'heavy').state).toBe('covered');
    expect(row(r, 'light')).toMatchObject({ state: 'none', mapped: true });
    expect(row(r, 'ch')).toMatchObject({
      scoredFrom: 'subtopics',
      state: 'thin',
      covered: 0.75,
      started: 0.75,
      share: 2 / 3,
    });
    expect(row(r, 'heavy').share).toBeCloseTo(0.5, 10); // 2/3 of the syllabus, 3/4 of that
    expect(r.covered).toBeCloseTo((2 / 3) * 0.75, 10);
  });

  it('judges a topic by its own mapping when no subtopic points anywhere', () => {
    const r = syllabusTopicCoverage(
      [topic('bank-topic', { bankIds: ['b1'] }), child('folder-like', 'bank-topic')],
      {
        highlights: [hl('a', ['b1']), hl('b', ['b1']), hl('c', ['b1'])],
        cards: [card('k1', ['b1'])],
        logs: [],
      },
      opts,
    );
    expect(row(r, 'bank-topic')).toMatchObject({ scoredFrom: 'own', state: 'covered' });
    expect(row(r, 'folder-like')).toMatchObject({
      state: 'none',
      mapped: false,
      subtreeMapped: false,
      // It sits under a mapped topic, so it counts what the parent counts only through its own mapping.
      highlights: 0,
    });
    expect(r.covered).toBeCloseTo(1, 10);
    expect(r.unmapped).toBe(1);
  });

  it('is honest about empty topics and an empty syllabus', () => {
    const r = syllabusTopicCoverage([topic('a'), topic('b')], none, opts);
    expect(r.status).toBe('ok');
    expect(r.topics.every((t) => t.state === 'none' && !t.mapped && t.highlights === 0)).toBe(true);
    expect(r.covered).toBe(0);
    expect(r.started).toBe(0);
    expect(r.topics[0]).toMatchObject({
      cards: 0,
      due: 0,
      lastStudiedAt: null,
      retention: { value: null, reviews: 0 },
    });
    expect(r.unmapped).toBe(2);

    expect(syllabusTopicCoverage([], none, opts)).toMatchObject({
      status: 'empty',
      covered: null,
      started: null,
      topics: [],
    });
  });

  it('uses the thresholds the person set, and falls back for invalid ones', () => {
    const topics = [topic('a', { bankIds: ['b1'] })];
    const facts = {
      highlights: [hl('a', ['b1']), hl('b', ['b1'])],
      cards: [card('k1', ['b1'])],
      logs: [],
    };
    expect(row(syllabusTopicCoverage(topics, facts, opts), 'a').state).toBe('thin'); // 2 < 3
    expect(
      row(syllabusTopicCoverage(topics, facts, { ...opts, thresholds: { minHighlights: 2 } }), 'a')
        .state,
    ).toBe('covered');
    expect(
      row(
        syllabusTopicCoverage(topics, facts, {
          ...opts,
          thresholds: { minHighlights: 2, minCards: 2 },
        }),
        'a',
      ).state,
    ).toBe('thin');
    expect(
      row(
        syllabusTopicCoverage(
          topics,
          { ...facts, cards: [] },
          {
            ...opts,
            thresholds: { minHighlights: 0, minCards: 0 },
          },
        ),
        'a',
      ).state,
    ).toBe('covered');

    expect(normalizeThresholds({ minHighlights: -1, minCards: 1.5 })).toEqual(
      DEFAULT_COVERAGE_THRESHOLDS,
    );
    expect(normalizeThresholds({ minHighlights: 1000, minCards: Number.NaN })).toEqual(
      DEFAULT_COVERAGE_THRESHOLDS,
    );
    expect(normalizeThresholds(null)).toEqual(DEFAULT_COVERAGE_THRESHOLDS);
    expect(normalizeThresholds({ minHighlights: 0, minCards: 999 })).toEqual({
      minHighlights: 0,
      minCards: 999,
    });
    expect(coverageState(0, 0, { minHighlights: 0, minCards: 0 })).toBe('none');
  });

  it('counts due cards by study day, last studied, and keeps new cards out of due', () => {
    const r = syllabusTopicCoverage(
      [topic('a', { bankIds: ['b1'] })],
      {
        highlights: [],
        cards: [
          card('k1', ['b1'], {
            state: 'review',
            due: '2026-01-05T23:59:00.000Z',
            lastReview: '2026-01-02T00:00:00.000Z',
          }),
          card('k2', ['b1'], {
            state: 'review',
            due: '2026-01-06T00:00:00.000Z',
            lastReview: '2026-01-04T10:00:00.000Z',
          }), // tomorrow
          card('k3', ['b1'], {
            state: 'learning',
            due: '2026-01-05T08:59:00.000Z',
            lastReview: '2026-01-05T08:00:00.000Z',
          }),
          card('k4', ['b1'], {
            state: 'learning',
            due: '2026-01-05T09:30:00.000Z',
            lastReview: '2026-01-05T08:00:00.000Z',
          }), // later today, not yet
          card('k5', ['b1']), // new
        ],
        logs: [],
      },
      opts,
    );
    expect(row(r, 'a')).toMatchObject({
      cards: 5,
      due: 2,
      lastStudiedAt: '2026-01-05T08:00:00.000Z',
    });
  });

  it('measures retention of mature reviews per topic and withholds it below the minimum', () => {
    const topics = [topic('a', { bankIds: ['b1'] }), topic('b', { bankIds: ['b2'] })];
    const cards = [
      card('k1', ['b1'], { state: 'review' }),
      card('k2', ['b2'], { state: 'review' }),
    ];
    const day = (n: number) => iso(T0MS - n * DAY);
    const logs = [
      // topic a: 5 mature reviews, one forgotten, plus an undone one and a first (new) review.
      log(day(1), 3, { cardId: 'k1' }),
      log(day(2), 3, { cardId: 'k1' }),
      log(day(3), 1, { cardId: 'k1' }),
      log(day(4), 4, { cardId: 'k1' }),
      log(day(5), 2, { cardId: 'k1' }),
      log(day(6), 1, { cardId: 'k1', undone: true }),
      log(day(7), 3, { cardId: 'k1', prev: 'new' }),
      // topic b: 4 mature reviews, below the minimum of 5.
      ...[1, 2, 3, 4].map((n) => log(day(n), 3, { cardId: 'k2' })),
      // a card nobody maps does not leak into a topic
      log(day(1), 1, { cardId: 'stranger' }),
    ];
    const r = syllabusTopicCoverage(topics, { highlights: [], cards, logs }, opts);
    expect(row(r, 'a').retention.reviews).toBe(5);
    expect(row(r, 'a').retention.value).toBeCloseTo(4 / 5, 10);
    expect(row(r, 'b').retention).toEqual({ value: null, reviews: 4 });
    expect(
      row(
        syllabusTopicCoverage(
          topics,
          { highlights: [], cards, logs },
          { ...opts, minRetentionReviews: 4 },
        ),
        'b',
      ).retention.value,
    ).toBe(1);
  });

  it('survives a malformed tree: a parent listed after its child, unknown parents, repeated ids', () => {
    const r = syllabusTopicCoverage(
      [
        child('kid', 'late'),
        topic('late', { bankIds: ['b1'] }),
        child('orphan', 'nobody', { bankIds: ['b1'] }),
        topic('late'),
      ],
      { highlights: [hl('h', ['b1'])], cards: [], logs: [] },
      opts,
    );
    expect(r.topics).toHaveLength(4);
    expect(r.topics.every((t) => Number.isFinite(t.share))).toBe(true);
    expect(
      r.topics.reduce((sum, t) => sum + (t.parentId === null || t.id === 'kid' ? 0 : t.share), 0),
    ).toBeGreaterThan(0);
  });

  it('handles a full-size syllabus over a large vault quickly', () => {
    const topics: CoverageTopic[] = [];
    for (let i = 0; i < 20; i += 1) {
      topics.push(topic(`c${i}`, { bankIds: [`b${i}`] }));
      for (let j = 0; j < 24; j += 1) {
        topics.push(child(`c${i}-${j}`, `c${i}`, { tagIds: [`t${i}-${j}`], weight: 1 + (j % 3) }));
      }
    }
    expect(topics).toHaveLength(500);
    const highlights = Array.from({ length: 20_000 }, (_, i) =>
      hl(idOf('h', i), [`b${i % 20}`], [`t${i % 20}-${i % 24}`]),
    );
    const cards = Array.from({ length: 20_000 }, (_, i) =>
      card(idOf('k', i), [`b${i % 20}`], { state: 'review', tagIds: [`t${i % 20}-${i % 24}`] }),
    );
    const logs = Array.from({ length: 60_000 }, (_, i) =>
      log(iso(T0MS - (i % 300) * DAY), 3, { cardId: idOf('k', i % 20_000) }),
    );
    const t0 = performance.now();
    const r = syllabusTopicCoverage(topics, { highlights, cards, logs }, opts);
    const ms = performance.now() - t0;
    expect(r.topics).toHaveLength(500);
    expect(r.topics[0]?.highlights).toBe(1000);
    expect(ms).toBeLessThan(3000);
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
