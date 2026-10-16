// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { review } from './scheduler';
import { ReviewSession as ReviewSessionSchema } from './schema';
import type { Card, Rating, ReviewLog } from './schema';
import {
  answerInSession,
  applyBacklogPlan,
  buildQueue,
  countToday,
  nextInSession,
  parseSession,
  planBacklogRecovery,
  resumeSession,
  startSession,
  undoInSession,
} from './queue';
import type { QueueOptions } from './queue';
import { seededRandom } from './random';
import { DAY, T0, idOf, makeCard, makeDeck } from './testUtils';
import type { DayBoundary } from './time';

const UTC: DayBoundary = { timeZone: 'UTC', rolloverHour: 0 };
const LA: DayBoundary = { timeZone: 'America/Los_Angeles', rolloverHour: 0 };
const iso = (ms: number): string => new Date(ms).toISOString();
const T0MS = Date.parse(T0);
const D1 = makeDeck('deck-0001');

const opts = (over: Partial<QueueOptions> = {}): QueueOptions => ({
  now: T0,
  boundary: UTC,
  decks: [D1],
  ...over,
});

const review$ = (id: string, over: Parameters<typeof makeCard>[1] = {}): Card =>
  makeCard(id, {
    state: 'review',
    due: iso(T0MS - DAY),
    lastReview: iso(T0MS - 6 * DAY),
    stability: 5,
    ...over,
  });

describe('ordering', () => {
  it('learning first, then reviews by lowest recall probability, then new cards oldest first', () => {
    const cards = [
      makeCard('new-00002', { createdAt: '2026-01-03T00:00:00.000Z' }),
      makeCard('new-00001', { createdAt: '2026-01-01T00:00:00.000Z' }),
      review$('rev-urgent', {
        stability: 10,
        lastReview: iso(T0MS - 20 * DAY),
        due: iso(T0MS - 10 * DAY),
      }),
      review$('rev-mild', {
        stability: 10,
        lastReview: iso(T0MS - 11 * DAY),
        due: iso(T0MS - DAY),
      }),
      review$('rev-today', {
        stability: 10,
        lastReview: iso(T0MS - 9 * DAY),
        due: iso(T0MS + 3_600_000),
      }),
      makeCard('lrn-00002', { state: 'learning', due: iso(T0MS - 60_000) }),
      makeCard('lrn-00001', { state: 'relearning', due: iso(T0MS - 300_000) }),
    ];
    const q = buildQueue(cards, opts());
    expect(q.ids).toEqual([
      'lrn-00001',
      'lrn-00002',
      'rev-urgent',
      'rev-mild',
      'rev-today',
      'new-00001',
      'new-00002',
    ]);
    expect(q.counts).toEqual({ learning: 2, review: 3, new: 2, total: 7 });
    expect(q.entries.find((e) => e.cardId === 'rev-urgent')?.overdueDays).toBe(10);
    expect(q.entries.find((e) => e.cardId === 'rev-today')?.overdueDays).toBe(0);
    expect(q.entries.find((e) => e.cardId === 'new-00001')?.retrievability).toBeNull();
  });

  it('order "due" puts the oldest due date first instead', () => {
    const cards = [
      review$('rev-a', {
        stability: 100,
        lastReview: iso(T0MS - 30 * DAY),
        due: iso(T0MS - 20 * DAY),
      }),
      review$('rev-b', { stability: 2, lastReview: iso(T0MS - 4 * DAY), due: iso(T0MS - 2 * DAY) }),
    ];
    expect(buildQueue(cards, opts({ order: 'retrievability' })).ids).toEqual(['rev-b', 'rev-a']);
    expect(buildQueue(cards, opts({ order: 'due' })).ids).toEqual(['rev-a', 'rev-b']);
  });

  it('is deterministic for ties and does not depend on input order', () => {
    const cards = Array.from({ length: 30 }, (_, i) => review$(idOf('rev', i)));
    const forward = buildQueue(cards, opts()).ids;
    const backward = buildQueue([...cards].reverse(), opts()).ids;
    expect(backward).toEqual(forward);
  });

  it('shuffles new cards only with an injected random, reproducibly', () => {
    const cards = Array.from({ length: 12 }, (_, i) =>
      makeCard(idOf('new', i), { createdAt: iso(T0MS - (100 - i) * DAY) }),
    );
    const a = buildQueue(cards, opts({ newOrder: 'random', random: seededRandom(4) })).ids;
    const b = buildQueue(cards, opts({ newOrder: 'random', random: seededRandom(4) })).ids;
    const created = buildQueue(cards, opts()).ids;
    expect(a).toEqual(b);
    expect(a).not.toEqual(created);
    expect([...a].sort()).toEqual([...created].sort());
    expect(() => buildQueue(cards, opts({ newOrder: 'random' }))).toThrow(TypeError);
  });
});

describe('daily caps and deferral', () => {
  it('caps new cards per deck, reports the rest as deferred, and loses nothing', () => {
    const deck = makeDeck('deck-0001', { settings: { newPerDay: 3 } });
    const cards = Array.from({ length: 8 }, (_, i) =>
      makeCard(idOf('new', i), { createdAt: iso(T0MS - (50 - i) * DAY) }),
    );
    const snapshot = JSON.stringify(cards);
    const q = buildQueue(cards, opts({ decks: [deck] }));
    expect(q.ids).toEqual(['new-000000', 'new-000001', 'new-000002']);
    expect(q.deferred).toEqual({
      review: 0,
      new: 5,
      byDeck: { 'deck-0001': { review: 0, new: 5 } },
    });
    expect(JSON.stringify(cards)).toBe(snapshot); // inputs untouched: deferral never rewrites due dates
    // Tomorrow's budget picks up exactly where today's stopped.
    const done = { 'deck-0001': { newDone: 3, reviewsDone: 0 } };
    const later = buildQueue(
      cards.filter((c) => !q.ids.includes(c.id)),
      opts({ decks: [deck], done }),
    );
    expect(later.counts.new).toBe(0); // still today: budget used up
    const tomorrow = buildQueue(
      cards.filter((c) => !q.ids.includes(c.id)),
      opts({ decks: [deck], now: iso(T0MS + DAY) }),
    );
    expect(tomorrow.ids).toEqual(['new-000003', 'new-000004', 'new-000005']);
  });

  it('caps reviews per deck keeping the most forgotten, and counts work already done today', () => {
    const deck = makeDeck('deck-0001', { settings: { reviewsPerDay: 5 } });
    const cards = Array.from({ length: 9 }, (_, i) =>
      review$(idOf('rev', i), {
        stability: 10,
        lastReview: iso(T0MS - (10 + i) * DAY),
        due: iso(T0MS - (1 + i) * DAY),
      }),
    );
    const q = buildQueue(
      cards,
      opts({ decks: [deck], done: { 'deck-0001': { newDone: 0, reviewsDone: 2 } } }),
    );
    expect(q.ids).toEqual(['rev-000008', 'rev-000007', 'rev-000006']); // 5 - 2 = 3 left, longest overdue first
    expect(q.deferred.review).toBe(6);
    const none = buildQueue(
      cards,
      opts({ decks: [deck], done: { 'deck-0001': { newDone: 0, reviewsDone: 5 } } }),
    );
    expect(none.ids).toEqual([]);
    expect(none.deferred.review).toBe(9);
  });

  it('caps are per deck: a busy deck cannot starve another', () => {
    const decks = [
      makeDeck('deck-0001', { settings: { newPerDay: 2 } }),
      makeDeck('deck-0002', { settings: { newPerDay: 2 } }),
    ];
    const cards = [
      ...Array.from({ length: 6 }, (_, i) => makeCard(idOf('a', i), { deckId: 'deck-0001' })),
      ...Array.from({ length: 6 }, (_, i) => makeCard(idOf('b', i), { deckId: 'deck-0002' })),
    ];
    const q = buildQueue(cards, opts({ decks }));
    expect(q.entries.filter((e) => e.deckId === 'deck-0001')).toHaveLength(2);
    expect(q.entries.filter((e) => e.deckId === 'deck-0002')).toHaveLength(2);
    expect(q.deferred.new).toBe(8);
  });
});

describe('interleaving', () => {
  const cards = [
    ...Array.from({ length: 4 }, (_, i) =>
      review$(idOf('a', i), {
        deckId: 'deck-0001',
        stability: 10,
        lastReview: iso(T0MS - (30 - i) * DAY),
        due: iso(T0MS - DAY),
      }),
    ),
    ...Array.from({ length: 2 }, (_, i) =>
      review$(idOf('b', i), {
        deckId: 'deck-0002',
        stability: 10,
        lastReview: iso(T0MS - (25 - i) * DAY),
        due: iso(T0MS - DAY),
      }),
    ),
  ];
  const decks = [
    makeDeck('deck-0001', { bankId: 'bank-0001' }),
    makeDeck('deck-0002', { bankId: 'bank-0002' }),
  ];

  it('spreads decks proportionally instead of one deck after the other', () => {
    const q = buildQueue(cards, opts({ decks }));
    expect(q.entries.map((e) => e.deckId)).toEqual([
      'deck-0001',
      'deck-0002',
      'deck-0001',
      'deck-0001',
      'deck-0002',
      'deck-0001',
    ]);
    // Within a deck the order is still most-forgotten first.
    expect(q.entries.filter((e) => e.deckId === 'deck-0001').map((e) => e.cardId)).toEqual([
      'a-000000',
      'a-000001',
      'a-000002',
      'a-000003',
    ]);
  });

  it('interleave "none" is pure urgency order; "bank" merges decks of one bank', () => {
    const none = buildQueue(cards, opts({ decks, interleave: 'none' }));
    expect(none.ids).toEqual([
      'a-000000',
      'a-000001',
      'a-000002',
      'a-000003',
      'b-000000',
      'b-000001',
    ]);
    const sameBank = [
      makeDeck('deck-0001', { bankId: 'bank-0001' }),
      makeDeck('deck-0002', { bankId: 'bank-0001' }),
    ];
    const merged = buildQueue(cards, opts({ decks: sameBank, interleave: 'bank' }));
    expect(merged.ids).toEqual(none.ids);
    const split = buildQueue(cards, opts({ decks, interleave: 'bank' }));
    expect(split.entries.map((e) => e.deckId)).toEqual(
      buildQueue(cards, opts({ decks, interleave: 'deck' })).entries.map((e) => e.deckId),
    );
  });
});

describe('what is excluded, and why', () => {
  it('suspended, buried, deleted, unknown/deleted deck, out of scope, postponed, duplicates', () => {
    const decks = [D1, makeDeck('deck-0002'), { ...makeDeck('deck-0003'), deletedAt: T0 }];
    const cards = [
      review$('ok-000001'),
      review$('susp-0001', { suspended: true }),
      review$('bury-0001', { buriedUntil: iso(T0MS + 3_600_000) }),
      review$('bury-0002', { buriedUntil: iso(T0MS - 3_600_000) }), // burial over: due again
      review$('del-00001', { deleted: true }),
      review$('unk-00001', { deckId: 'deck-9999' }),
      review$('ddel-0001', { deckId: 'deck-0003' }),
      review$('scope-001', { deckId: 'deck-0002' }),
      makeCard('post-0001', { due: iso(T0MS + 2 * DAY) }),
      review$('dup-00001'),
      review$('dup-00001', { updatedAt: '2026-01-04T00:00:00.000Z', stability: 1 }),
      review$('far-00001', { due: iso(T0MS + 5 * DAY) }),
    ];
    const q = buildQueue(cards, opts({ decks, deckIds: ['deck-0001'] }));
    expect(q.ids.sort()).toEqual(['bury-0002', 'dup-00001', 'ok-000001']);
    expect(q.excluded).toEqual({
      deleted: 1,
      suspended: 1,
      buried: 1,
      duplicate: 1,
      unknownDeck: 2,
      outOfScope: 1,
      postponed: 1,
    });
  });

  it('never lists a card twice even when the input repeats ids many times', () => {
    const base = Array.from({ length: 50 }, (_, i) => review$(idOf('rev', i)));
    const noisy = [...base, ...base, ...base.slice(10)];
    const q = buildQueue(noisy, opts());
    expect(new Set(q.ids).size).toBe(q.ids.length);
    expect(q.ids).toHaveLength(50);
    expect(q.excluded.duplicate).toBe(noisy.length - 50);
  });
});

describe('learning cards', () => {
  it('shows steps due within the learn-ahead window and reports when the next one is due', () => {
    const cards = [
      makeCard('lrn-00001', { state: 'learning', due: iso(T0MS + 10 * 60_000) }),
      makeCard('lrn-00002', { state: 'learning', due: iso(T0MS + 40 * 60_000) }),
    ];
    const q = buildQueue(cards, opts()); // default learn-ahead 20 min
    expect(q.ids).toEqual(['lrn-00001']);
    expect(q.nextLearningAt).toBe(iso(T0MS + 40 * 60_000));
    // A step that is merely inside the window is offered after reviews and new cards, not before.
    const mixed = buildQueue([...cards, review$('rev-00001'), makeCard('new-00001')], opts());
    expect(mixed.ids).toEqual(['rev-00001', 'new-00001', 'lrn-00001']);
    const strict = buildQueue(cards, opts({ learnAheadMs: 0 }));
    expect(strict.ids).toEqual([]);
    expect(strict.nextLearningAt).toBe(iso(T0MS + 10 * 60_000));
  });
});

describe("study day in the user's time zone", () => {
  const dueAt = (isoDue: string) =>
    review$('rev-edge-1', { due: isoDue, lastReview: '2026-01-01T00:00:00.000Z', stability: 3 });
  const inQueue = (card: Card, now: string, boundary: DayBoundary) =>
    buildQueue([card], opts({ now, boundary })).ids.length === 1;

  it('Los Angeles spring-forward: the day ends at 00:00 PDT = 07:00Z (a 23h day)', () => {
    const now = '2026-03-08T20:00:00.000Z'; // 13:00 PDT
    expect(buildQueue([], opts({ now, boundary: LA })).dayEndsAt).toBe('2026-03-09T07:00:00.000Z');
    expect(inQueue(dueAt('2026-03-09T06:59:00.000Z'), now, LA)).toBe(true);
    expect(inQueue(dueAt('2026-03-09T07:00:00.000Z'), now, LA)).toBe(false);
  });

  it('Los Angeles fall-back: the 25-hour day ends at 08:00Z', () => {
    const now = '2026-11-01T20:00:00.000Z';
    expect(buildQueue([], opts({ now, boundary: LA })).dayEndsAt).toBe('2026-11-02T08:00:00.000Z');
    expect(inQueue(dueAt('2026-11-02T07:59:00.000Z'), now, LA)).toBe(true);
    expect(inQueue(dueAt('2026-11-02T08:00:00.000Z'), now, LA)).toBe(false);
  });

  it('Kolkata (UTC+5:30): the day ends at 18:30Z', () => {
    const boundary: DayBoundary = { timeZone: 'Asia/Kolkata', rolloverHour: 0 };
    const now = '2026-06-01T10:00:00.000Z'; // 15:30 IST
    const q = buildQueue([], opts({ now, boundary }));
    expect(q.dayEndsAt).toBe('2026-06-01T18:30:00.000Z');
    expect(q.dayKey).toBe('2026-06-01');
    expect(inQueue(dueAt('2026-06-01T18:29:00.000Z'), now, boundary)).toBe(true);
    expect(inQueue(dueAt('2026-06-01T18:30:00.000Z'), now, boundary)).toBe(false);
  });

  it('Auckland across both DST changes', () => {
    const boundary: DayBoundary = { timeZone: 'Pacific/Auckland', rolloverHour: 0 };
    const spring = '2026-09-26T20:00:00.000Z'; // 08:00 NZST, Sep 27
    expect(buildQueue([], opts({ now: spring, boundary })).dayEndsAt).toBe(
      '2026-09-27T11:00:00.000Z',
    );
    expect(buildQueue([], opts({ now: spring, boundary })).dayKey).toBe('2026-09-27');
    const autumn = '2027-04-03T20:00:00.000Z'; // 09:00 NZDT, Apr 4
    expect(buildQueue([], opts({ now: autumn, boundary })).dayEndsAt).toBe(
      '2027-04-04T12:00:00.000Z',
    );
  });

  it('rollover hour: at 03:30 local the previous study day is still open', () => {
    const boundary: DayBoundary = { timeZone: 'America/Los_Angeles', rolloverHour: 4 };
    const q = buildQueue([], opts({ now: '2026-01-10T11:30:00.000Z', boundary })); // 03:30 PST
    expect(q.dayKey).toBe('2026-01-09');
    expect(q.dayEndsAt).toBe('2026-01-10T12:00:00.000Z');
    const after = buildQueue([], opts({ now: '2026-01-10T12:00:00.000Z', boundary }));
    expect(after.dayKey).toBe('2026-01-10');
    // A card due at 02:00 local tonight belongs to the study day that is still open.
    const card = dueAt('2026-01-10T10:00:00.000Z');
    expect(inQueue(card, '2026-01-10T06:00:00.000Z', boundary)).toBe(true);
  });

  it("overdue days are whole study days in the user's frame", () => {
    const now = '2026-03-10T20:00:00.000Z';
    const q = buildQueue([dueAt('2026-03-07T08:30:00.000Z')], opts({ now, boundary: LA }));
    expect(q.entries[0]?.overdueDays).toBe(3); // Mar 7 00:30 PST -> Mar 10 in LA
  });
});

describe('clock changes', () => {
  it('a clock that jumped back makes later-due cards simply not due; nothing throws', () => {
    const cards = [
      review$('rev-00001', { due: iso(T0MS - DAY), lastReview: iso(T0MS - 2 * DAY) }),
      review$('rev-00002', { due: iso(T0MS + 3 * DAY), lastReview: iso(T0MS - 2 * DAY) }),
      makeCard('lrn-00001', {
        state: 'learning',
        due: iso(T0MS + 60_000),
        lastReview: iso(T0MS + 30_000),
      }),
    ];
    const normal = buildQueue(cards, opts({ now: iso(T0MS + 4 * DAY) }));
    expect(normal.ids).toContain('rev-00002');
    const back = buildQueue(cards, opts({ now: iso(T0MS - 10 * DAY) }));
    expect(back.ids).toEqual([]); // nothing due yet; the learning step is in the future
    expect(
      back.entries.every(
        (e) => e.retrievability === null || (e.retrievability <= 1 && e.retrievability >= 0),
      ),
    ).toBe(true);
  });

  it('a review card with a last review in the future ranks as fully remembered, not NaN', () => {
    const odd = review$('rev-00003', { lastReview: iso(T0MS + DAY), due: iso(T0MS - 1000) });
    const q = buildQueue([odd], opts());
    expect(q.entries[0]?.retrievability).toBe(1);
  });
});

describe('countToday', () => {
  const log = (
    cardId: string,
    at: string,
    prev: 'new' | 'review' | 'learning',
    corrected = false,
  ) =>
    ({
      cardId,
      reviewedAt: at,
      previousState: { ...makeCard(cardId, { state: prev === 'new' ? 'new' : prev }).fsrs },
      ...(corrected ? { userCorrection: { kind: 'undone' as const, at } } : {}),
    }) as Pick<ReviewLog, 'cardId' | 'reviewedAt' | 'previousState' | 'userCorrection'>;
  const deckOf = (id: string) => (id.startsWith('b') ? 'deck-0002' : 'deck-0001');

  it("counts new introductions and graduated reviews inside today's study day only", () => {
    // LA day of Mar 8 (23h): 08:00Z .. Mar 9 07:00Z
    const now = '2026-03-08T20:00:00.000Z';
    const logs = [
      log('a-000001', '2026-03-08T08:00:00.000Z', 'new'), // first instant of the day
      log('a-000002', '2026-03-08T12:00:00.000Z', 'review'),
      log('a-000003', '2026-03-08T12:05:00.000Z', 'learning'), // learning steps are not capped
      log('a-000004', '2026-03-09T06:59:59.999Z', 'review'),
      log('a-000005', '2026-03-09T07:00:00.000Z', 'review'), // tomorrow
      log('a-000006', '2026-03-08T07:59:59.999Z', 'new'), // yesterday
      log('a-000007', '2026-03-08T13:00:00.000Z', 'new', true), // undone
      log('b-000001', '2026-03-08T15:00:00.000Z', 'new'),
      log('zzzzzzzz', '2026-03-08T15:00:00.000Z', 'new'),
    ];
    const out = countToday(logs, (id) => (id.startsWith('z') ? undefined : deckOf(id)), now, LA);
    expect(out).toEqual({
      'deck-0001': { newDone: 1, reviewsDone: 2 },
      'deck-0002': { newDone: 1, reviewsDone: 0 },
    });
  });

  it('feeds the queue so caps survive a restart', () => {
    const deck = makeDeck('deck-0001', { settings: { newPerDay: 5 } });
    const cards = Array.from({ length: 10 }, (_, i) => makeCard(idOf('new', i)));
    const logs = [0, 1, 2].map((i) => log(idOf('done', i), '2026-01-05T07:00:00.000Z', 'new'));
    const done = countToday(logs, () => 'deck-0001', T0, UTC);
    expect(buildQueue(cards, opts({ decks: [deck], done })).counts.new).toBe(2);
  });
});

describe('review session value', () => {
  const answer = (card: Card, rating: Rating, at: string, n: number) =>
    review(card, rating, at, D1.settings, {
      logId: idOf('log', n),
      sessionId: 'session-0001',
      durationMs: 2000,
    });

  const world = () => {
    const cards = [
      review$('rev-00001', {
        stability: 10,
        lastReview: iso(T0MS - 20 * DAY),
        due: iso(T0MS - 5 * DAY),
      }),
      review$('rev-00002', {
        stability: 10,
        lastReview: iso(T0MS - 15 * DAY),
        due: iso(T0MS - 2 * DAY),
      }),
      makeCard('new-00001'),
      makeCard('lrn-00001', { state: 'learning', due: iso(T0MS - 60_000) }),
    ];
    return new Map(cards.map((c) => [c.id, c]));
  };

  it('serves due learning first, re-serves a failed card after its step, and never twice at once', () => {
    const byId = world();
    const q = buildQueue([...byId.values()], opts());
    let session = startSession(q, { id: 'session-0001', boundary: UTC });
    expect(session.learning.map((l) => l.cardId)).toEqual(['lrn-00001']);
    expect(session.pending).toEqual(['rev-00001', 'rev-00002', 'new-00001']);

    let nowMs = T0MS;
    const served: string[] = [];
    let failedOnce = false;
    for (let guard = 0; guard < 30; guard += 1) {
      const next = nextInSession(session, iso(nowMs));
      if (next.kind === 'done') break;
      if (next.kind === 'wait') {
        nowMs = Date.parse(next.until);
        continue;
      }
      served.push(next.cardId);
      const card = byId.get(next.cardId) as Card;
      const rating: Rating = next.cardId === 'rev-00002' && !failedOnce ? 1 : 3;
      if (rating === 1) failedOnce = true;
      nowMs += 5000;
      const r = answer(card, rating, iso(nowMs), served.length);
      byId.set(card.id, r.card);
      session = answerInSession(session, r.card, { logId: r.log.id, rating });
      // The persisted value always validates: no card is ever queued twice.
      expect(ReviewSessionSchema.safeParse(JSON.parse(JSON.stringify(session))).success).toBe(true);
    }
    expect(served[0]).toBe('lrn-00001');
    const times = (id: string) => served.filter((x) => x === id).length;
    // Learning/new cards need two Good answers (1m, 10m steps); a failed review is re-served once.
    expect([
      times('lrn-00001'),
      times('new-00001'),
      times('rev-00001'),
      times('rev-00002'),
    ]).toEqual([2, 2, 1, 2]);
    expect(served.some((id, i) => id === served[i - 1])).toBe(false);
    expect([...byId.values()].every((c) => c.fsrs.state === 'review')).toBe(true);
    expect(session.answered).toBe(served.length);
    expect(nextInSession(session, iso(nowMs))).toEqual({ kind: 'done' });
  });

  it('waits when only a future learning step remains', () => {
    const byId = world();
    const q = buildQueue([byId.get('rev-00001') as Card], opts());
    let session = startSession(q, { id: 'session-0001', boundary: UTC });
    const r = answer(byId.get('rev-00001') as Card, 1, T0, 1);
    session = answerInSession(session, r.card, { logId: r.log.id, rating: 1 });
    const next = nextInSession(session, T0, 0);
    expect(next).toEqual({ kind: 'wait', until: r.card.dueAt });
    expect(nextInSession(session, r.card.dueAt, 0)).toMatchObject({
      kind: 'card',
      from: 'learning',
    });
  });

  it('a learning step that lands after the rollover belongs to tomorrow, not to this session', () => {
    // At 23:55 a Good on a new card schedules its 10-minute step for 00:05: tomorrow's study day.
    // The session is pinned to its day (resume rebuilds a stale one), so the card leaves it and
    // tomorrow's queue serves it. At midday the same step stays in the session.
    const at = (t: string) => {
      const card = makeCard('new-00001');
      const session = startSession(buildQueue([card], opts({ now: t })), {
        id: 'session-0001',
        boundary: UTC,
      });
      const r = answer(card, 3, t, 1);
      return {
        card: r.card,
        session: answerInSession(session, r.card, { logId: r.log.id, rating: 3 }),
      };
    };
    const late = at('2026-01-05T23:55:00.000Z');
    expect(late.card.fsrs.due).toBe('2026-01-06T00:05:00.000Z');
    expect(late.session.learning).toEqual([]);
    expect(nextInSession(late.session, '2026-01-05T23:56:00.000Z')).toEqual({ kind: 'done' });
    const tomorrow = buildQueue([late.card], opts({ now: '2026-01-06T00:05:00.000Z' }));
    expect(tomorrow.entries).toMatchObject([{ cardId: 'new-00001', kind: 'learning' }]);

    const midday = at('2026-01-05T12:00:00.000Z');
    expect(midday.session.learning).toEqual([
      { cardId: 'new-00001', dueAt: '2026-01-05T12:10:00.000Z' },
    ]);
  });

  it('survives JSON persistence and a restart', () => {
    const byId = world();
    const q = buildQueue([...byId.values()], opts());
    const session = startSession(q, { id: 'session-0001', boundary: UTC, deckIds: ['deck-0001'] });
    const restored = parseSession(JSON.parse(JSON.stringify(session)));
    expect(restored).toEqual(session);
    expect(parseSession({ ...session, pending: ['x-0000001', 'x-0000001'] })).toBeNull();
    expect(parseSession({ nonsense: true })).toBeNull();
  });

  it('resume drops cards answered, suspended or deleted since, without showing anything twice', () => {
    const byId = world();
    const q = buildQueue([...byId.values()], opts());
    const session = startSession(q, { id: 'session-0001', boundary: UTC });
    // The database moved on after the session was last saved:
    const good = answer(byId.get('rev-00001') as Card, 3, T0, 1).card; // answered Good -> due in days
    const again = answer(byId.get('rev-00002') as Card, 1, T0, 2).card; // answered Again -> relearning step
    const gone = { ...(byId.get('new-00001') as Card), deletedAt: T0 };
    const susp = { ...(byId.get('lrn-00001') as Card), suspended: true };
    const res = resumeSession(session, [good, again, gone, susp], T0);
    expect(res.stale).toBe(false);
    expect(res.session.pending).toEqual([]);
    expect(res.session.learning).toEqual([{ cardId: 'rev-00002', dueAt: again.dueAt }]);
    expect(res.dropped).toEqual(
      expect.arrayContaining([
        { cardId: 'rev-00001', reason: 'not_due' },
        { cardId: 'new-00001', reason: 'deleted' },
        { cardId: 'lrn-00001', reason: 'suspended' },
      ]),
    );
    expect(ReviewSessionSchema.safeParse(res.session).success).toBe(true);
  });

  it('resume keeps order for untouched cards, flags missing ones, and handles a stale day', () => {
    const byId = world();
    const q = buildQueue([...byId.values()], opts());
    const session = startSession(q, { id: 'session-0001', boundary: UTC });
    const same = resumeSession(session, [...byId.values()], iso(T0MS + 60_000));
    expect(same.session).toEqual(session);
    expect(same.dropped).toEqual([]);
    const missing = resumeSession(session, [byId.get('rev-00001') as Card], T0);
    expect(missing.dropped.map((d) => d.reason)).toEqual(['missing', 'missing', 'missing']);
    const nextDay = resumeSession(session, [...byId.values()], iso(T0MS + DAY));
    expect(nextDay.stale).toBe(true);
    expect(nextDay.session.pending).toEqual([]);
    expect(nextDay.dropped.every((d) => d.reason === 'stale_day')).toBe(true);
  });

  it('a device clock that went back before the session start is reported, and the session kept', () => {
    const byId = world();
    const session = startSession(buildQueue([...byId.values()], opts()), {
      id: 'session-0001',
      boundary: UTC,
    });
    const res = resumeSession(session, [...byId.values()], iso(T0MS - 2 * 3_600_000));
    expect(res.clockWentBack).toBe(true);
    expect(res.stale).toBe(false);
    // Cards that are not due at the earlier time (the learning step) are dropped, not shown early.
    expect(res.session.pending).toEqual(['rev-00001', 'rev-00002']);
  });

  it('undo puts the restored card back at the front', () => {
    const byId = world();
    let session = startSession(buildQueue([...byId.values()], opts()), {
      id: 'session-0001',
      boundary: UTC,
    });
    const card = byId.get('rev-00001') as Card;
    const r = answer(card, 3, T0, 1);
    session = answerInSession(session, r.card, { logId: r.log.id, rating: 3 });
    expect(session.pending[0]).toBe('rev-00002');
    const undone = undoInSession(session, card);
    expect(undone.pending[0]).toBe('rev-00001');
    expect(undone.answered).toBe(0);
    expect(undone.lastAnswer).toBeNull();
    expect(undoInSession(undone, card)).toBe(undone); // nothing to undo twice
  });
});

describe('backlog recovery', () => {
  const overdue = (n: number, deckId = 'deck-0001') =>
    Array.from({ length: n }, (_, i) =>
      review$(idOf(deckId === 'deck-0001' ? 'rev' : 'oth', i), {
        deckId,
        stability: 10,
        lastReview: iso(T0MS - (60 + i) * DAY),
        due: iso(T0MS - (30 + i) * DAY),
      }),
    );

  it('spreads overdue reviews over N days within the daily budget, most forgotten first', () => {
    const deck = makeDeck('deck-0001', { settings: { reviewsPerDay: 20 } });
    const cards = overdue(100);
    const plan = planBacklogRecovery(cards, { now: T0, boundary: UTC, decks: [deck], days: 5 });
    expect(plan.overdueTotal).toBe(100);
    expect(plan.keptToday).toBe(20);
    expect(plan.moves).toHaveLength(80);
    expect(plan.unassigned).toEqual([]);
    const perDay = new Map<number, number>();
    for (const m of plan.moves) perDay.set(m.dayOffset, (perDay.get(m.dayOffset) ?? 0) + 1);
    expect([...perDay.entries()].sort()).toEqual([
      [1, 20],
      [2, 20],
      [3, 20],
      [4, 20],
    ]);
    // The first moved card (day 1) is the 21st most forgotten; due at the start of tomorrow.
    expect(plan.moves[0]).toMatchObject({
      cardId: 'rev-000079',
      toDueAt: '2026-01-06T00:00:00.000Z',
      dayOffset: 1,
    });
  });

  it('lists what does not fit instead of skipping it silently', () => {
    const deck = makeDeck('deck-0001', { settings: { reviewsPerDay: 20 } });
    const plan = planBacklogRecovery(overdue(100), {
      now: T0,
      boundary: UTC,
      decks: [deck],
      days: 3,
    });
    expect(plan.keptToday + plan.moves.length + plan.unassigned.length).toBe(100);
    expect(plan.unassigned).toHaveLength(40);
    const none = planBacklogRecovery(overdue(10), {
      now: T0,
      boundary: UTC,
      decks: [makeDeck('deck-0001', { settings: { reviewsPerDay: 0 } })],
      days: 7,
    });
    expect(none.unassigned).toHaveLength(10);
    expect(none.moves).toEqual([]);
  });

  it('respects reviews already due on later days and work already done today', () => {
    const deck = makeDeck('deck-0001', { settings: { reviewsPerDay: 10 } });
    const future = Array.from({ length: 10 }, (_, i) =>
      review$(idOf('fut', i), { due: iso(T0MS + DAY + 3600_000 + i), lastReview: T0 }),
    ); // tomorrow is already full
    const plan = planBacklogRecovery([...overdue(15), ...future], {
      now: T0,
      boundary: UTC,
      decks: [deck],
      days: 3,
      done: { 'deck-0001': { newDone: 0, reviewsDone: 4 } },
    });
    expect(plan.keptToday).toBe(6); // 10 - 4 already reviewed
    const days = plan.moves.map((m) => m.dayOffset);
    expect(days.filter((d) => d === 1)).toHaveLength(0); // tomorrow is full
    expect(days.filter((d) => d === 2)).toHaveLength(9);
  });

  it('only moves due dates: memory state is untouched, and applying twice changes nothing more', () => {
    const deck = makeDeck('deck-0001', { settings: { reviewsPerDay: 5 } });
    const cards = overdue(12);
    const plan = planBacklogRecovery(cards, { now: T0, boundary: LA, decks: [deck], days: 4 });
    const moved = applyBacklogPlan(cards, plan, T0);
    expect(moved).toHaveLength(plan.moves.length);
    for (const m of moved) {
      const before = cards.find((c) => c.id === m.id) as Card;
      expect(m.fsrs.stability).toBe(before.fsrs.stability);
      expect(m.fsrs.difficulty).toBe(before.fsrs.difficulty);
      expect(m.fsrs.lastReview).toBe(before.fsrs.lastReview);
      expect(m.fsrs.state).toBe('review');
      expect(Date.parse(m.dueAt)).toBeGreaterThan(T0MS);
    }
    // After applying, a fresh queue never offers more than the daily budget per day.
    const after = cards.map((c) => moved.find((m) => m.id === c.id) ?? c);
    const today = buildQueue(after, opts({ decks: [deck], boundary: LA }));
    expect(today.counts.review).toBe(5);
    expect(today.deferred.review).toBe(0);
  });
});

describe('simulated study sessions', () => {
  /** Runs a whole session with random answers; optionally restarts (JSON + resume) every few cards. */
  function simulate(seed: number, restartEvery: number | null) {
    const rng = seededRandom(seed);
    const decks = [
      makeDeck('deck-0001', { settings: { newPerDay: 500, reviewsPerDay: 500 } }),
      makeDeck('deck-0002', { settings: { newPerDay: 500, reviewsPerDay: 500 } }),
    ];
    const cards: Card[] = [];
    for (let i = 0; i < 90; i += 1) {
      const deckId = i % 2 ? 'deck-0001' : 'deck-0002';
      const id = idOf('card', i);
      if (i % 3 === 0) cards.push(makeCard(id, { deckId, createdAt: iso(T0MS - i * DAY) }));
      else if (i % 7 === 0)
        cards.push(makeCard(id, { deckId, state: 'learning', due: iso(T0MS - 60_000) }));
      else
        cards.push(
          makeCard(id, {
            deckId,
            state: 'review',
            stability: 2 + rng() * 40,
            lastReview: iso(T0MS - (3 + Math.floor(rng() * 60)) * DAY),
            due: iso(T0MS - Math.floor(rng() * 20) * DAY),
          }),
        );
    }
    const byId = new Map(cards.map((c) => [c.id, c]));
    const boundary: DayBoundary = { timeZone: 'America/Los_Angeles', rolloverHour: 4 };
    const initial = buildQueue(cards, { now: T0, boundary, decks });
    let session = startSession(initial, { id: 'session-0001', boundary });
    const answers = seededRandom(seed + 1000);
    const served: string[] = [];
    const ratings: Rating[] = [];
    let nowMs = T0MS;
    for (let guard = 0; guard < 3000; guard += 1) {
      if (restartEvery && served.length > 0 && served.length % restartEvery === 0) {
        session = parseSession(JSON.parse(JSON.stringify(session))) as typeof session;
        const rows = [...byId.values()].map((c) => JSON.parse(JSON.stringify(c)) as Card);
        const res = resumeSession(session, rows, iso(nowMs));
        expect(res.dropped).toEqual([]);
        session = res.session;
      }
      const next = nextInSession(session, iso(nowMs));
      if (next.kind === 'done') break;
      if (next.kind === 'wait') {
        nowMs = Math.max(nowMs, Date.parse(next.until));
        continue;
      }
      expect(ReviewSessionSchema.safeParse(session).success).toBe(true);
      const card = byId.get(next.cardId) as Card;
      const roll = answers();
      const rating: Rating = roll < 0.2 ? 1 : roll < 0.5 ? 3 : roll < 0.8 ? 4 : 2;
      nowMs += 3000;
      const r = review(card, rating, iso(nowMs), (decks[0] as (typeof decks)[0]).settings, {
        logId: idOf('log', served.length),
        sessionId: 'session-0001',
        durationMs: 3000,
        boundary,
      });
      byId.set(card.id, r.card);
      served.push(card.id);
      ratings.push(rating);
      session = answerInSession(session, r.card, { logId: r.log.id, rating });
    }
    return { served, ratings, byId, initial, session, nowMs };
  }

  it('serves every due card at least once, never lists a card twice, and ends cleanly', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { served, byId, initial, session } = simulate(seed, null);
      expect(new Set(served)).toEqual(new Set(initial.ids));
      expect(session.pending).toEqual([]);
      expect(session.learning).toEqual([]);
      expect(session.answered).toBe(served.length);
      // Every learning step was completed: nothing is left mid-step.
      for (const c of byId.values()) expect(['learning', 'relearning']).not.toContain(c.fsrs.state);
    }
  });

  it('a restart (persist, reload, resume) after every few cards changes nothing', () => {
    for (const seed of [11, 12, 13]) {
      const straight = simulate(seed, null);
      for (const every of [1, 2, 7]) {
        const restarted = simulate(seed, every);
        expect(restarted.served).toEqual(straight.served);
        expect(restarted.ratings).toEqual(straight.ratings);
        expect([...restarted.byId.values()].map((c) => c.dueAt)).toEqual(
          [...straight.byId.values()].map((c) => c.dueAt),
        );
      }
    }
  });
});

describe('scale', () => {
  it('builds a 5,000-card queue in under 200 ms', () => {
    const decks = Array.from({ length: 5 }, (_, i) =>
      makeDeck(idOf('deck', i + 1), {
        bankId: idOf('bank', (i % 2) + 1),
        settings: { newPerDay: 50, reviewsPerDay: 500 },
      }),
    );
    const rng = seededRandom(2026);
    const cards: Card[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const deckId = idOf('deck', (i % 5) + 1);
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
          }),
        );
      }
    }
    const options = opts({ decks, boundary: LA, now: iso(T0MS) });
    buildQueue(cards, options); // warm-up (JIT, Intl formatter, offset cache)
    const runs: number[] = [];
    let last = buildQueue(cards, options);
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      last = buildQueue(cards, options);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    const median = runs[2] as number;
    expect(median).toBeLessThan(200);
    expect(last.counts.total).toBeGreaterThan(1000);
    expect(new Set(last.ids).size).toBe(last.ids.length);
  });
});
