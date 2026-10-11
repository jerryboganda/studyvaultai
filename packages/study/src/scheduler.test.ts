// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createEmptyCard, fsrs, generatorParameters } from 'ts-fsrs';
import type { Grade } from 'ts-fsrs';
import { buildBasic, createCard } from './cards';
import { seededRandom } from './random';
import {
  ALGORITHM_VERSION,
  buryCard,
  isLeechTrigger,
  newFsrsState,
  preview,
  reschedule,
  resetCard,
  retrievability,
  review,
  setSuspended,
  undoReview,
  unburyCard,
} from './scheduler';
import { Card as CardSchema, DEFAULT_DECK_SETTINGS, ReviewLog as ReviewLogSchema } from './schema';
import type { Card, DeckSettings, Rating, ReviewLog } from './schema';
import { DAY, T0, makeCard } from './testUtils';
import { studyDayStartMs, studyDayNumber } from './time';
import type { DayBoundary } from './time';

const SETTINGS: DeckSettings = { ...DEFAULT_DECK_SETTINGS, enableFuzz: false };

function freshCard(id = 'card-0001', now = T0): Card {
  const built = buildBasic({
    question: 'Q?',
    answer: 'A.',
    source: { highlightId: null, quote: null },
  });
  if (!built.ok) throw new Error('fixture');
  return createCard(built.value, { id, deckId: 'deck-0001' }, now);
}

interface Row {
  at: string;
  rating: Rating;
  state: string;
  due: string;
  stability: number;
  reps: number;
  lapses: number;
  scheduledDays: number;
}

/** Plays `steps` = [rating, delayMs after the card is due]; the first review happens at `T0 + delay`. */
function play(
  steps: readonly (readonly [Rating, number])[],
  settings: DeckSettings = SETTINGS,
  opts: { boundary?: DayBoundary; card?: Card } = {},
) {
  let card = opts.card ?? freshCard();
  const rows: Row[] = [];
  const logs: ReviewLog[] = [];
  let nowMs = Date.parse(T0);
  steps.forEach(([rating, delay], i) => {
    nowMs = Math.max(nowMs, Date.parse(card.dueAt) + delay);
    const at = new Date(nowMs).toISOString();
    const r = review(card, rating, at, settings, {
      logId: `log-${String(i).padStart(6, '0')}`,
      sessionId: 'session-0001',
      durationMs: 4000,
      ...(opts.boundary ? { boundary: opts.boundary } : {}),
    });
    card = r.card;
    logs.push(r.log);
    rows.push({
      at,
      rating,
      state: card.fsrs.state,
      due: card.dueAt,
      stability: Number(card.fsrs.stability.toFixed(6)),
      reps: card.fsrs.reps,
      lapses: card.fsrs.lapses,
      scheduledDays: card.fsrs.scheduledDays,
    });
  });
  return { card, rows, logs };
}

const G = 3 as const;
const AGAIN = 1 as const;

describe('golden fixtures (frozen from ts-fsrs 5.4.2, default FSRS-6 weights, retention 0.9)', () => {
  it('A: eight on-time Good answers', () => {
    const { rows } = play(Array.from({ length: 8 }, () => [G, 0] as const));
    expect(rows.map((r) => [r.at, r.state, r.due, r.stability, r.scheduledDays])).toEqual([
      ['2026-01-05T09:00:00.000Z', 'learning', '2026-01-05T09:10:00.000Z', 2.3065, 0],
      ['2026-01-05T09:10:00.000Z', 'review', '2026-01-07T09:10:00.000Z', 2.3065, 2],
      ['2026-01-07T09:10:00.000Z', 'review', '2026-01-18T09:10:00.000Z', 10.971048, 11],
      ['2026-01-18T09:10:00.000Z', 'review', '2026-03-05T09:10:00.000Z', 46.316857, 46],
      ['2026-03-05T09:10:00.000Z', 'review', '2026-08-15T09:10:00.000Z', 162.999815, 163],
      ['2026-08-15T09:10:00.000Z', 'review', '2027-12-26T09:10:00.000Z', 497.87656, 498],
      ['2027-12-26T09:10:00.000Z', 'review', '2031-09-04T09:10:00.000Z', 1347.918609, 1348],
      ['2031-09-04T09:10:00.000Z', 'review', '2040-09-15T09:10:00.000Z', 3298.645627, 3299],
    ]);
  });

  it('B: a lapse sends the card to relearning and shrinks stability', () => {
    const { rows } = play([
      [G, 0],
      [G, 0],
      [G, 0],
      [G, 0],
      [AGAIN, 0],
      [G, 0],
      [G, 0],
      [G, 0],
    ]);
    expect(rows.slice(3).map((r) => [r.state, r.due, r.stability, r.reps, r.lapses])).toEqual([
      ['review', '2026-03-05T09:10:00.000Z', 46.316857, 4, 0],
      ['relearning', '2026-03-05T09:20:00.000Z', 2.933845, 5, 1],
      ['review', '2026-03-08T09:20:00.000Z', 2.933845, 6, 1],
      ['review', '2026-03-16T09:20:00.000Z', 7.799102, 7, 1],
      ['review', '2026-04-04T09:20:00.000Z', 18.849916, 8, 1],
    ]);
  });

  it('C: Easy skips learning; Hard then Good', () => {
    const { rows } = play([
      [4, 0],
      [2, 0],
      [G, 0],
      [G, 0],
    ]);
    expect(rows.map((r) => [r.state, r.due, r.stability])).toEqual([
      ['review', '2026-01-13T09:00:00.000Z', 8.2956],
      ['review', '2026-02-09T09:00:00.000Z', 26.704183],
      ['review', '2026-05-05T09:00:00.000Z', 85.340202],
      ['review', '2026-12-29T09:00:00.000Z', 238.296202],
    ]);
  });

  it('D: a review answered 10 days late schedules from the actual review time', () => {
    const { rows } = play([
      [G, 0],
      [G, 0],
      [G, 0],
      [G, 0],
      [G, 10 * DAY],
      [G, 0],
    ]);
    expect(rows[4]).toMatchObject({
      at: '2026-03-15T09:10:00.000Z',
      due: '2026-09-11T09:10:00.000Z',
      scheduledDays: 180,
    });
    expect(rows[4]?.stability).toBeCloseTo(180.210022, 5);
    expect(rows[5]?.due).toBe('2028-03-08T09:10:00.000Z');
  });

  it('matches ts-fsrs called directly, for the same sequence, to the last bit', () => {
    const f = fsrs(
      generatorParameters({
        request_retention: 0.9,
        enable_fuzz: false,
        learning_steps: ['1m', '10m'],
        relearning_steps: ['10m'],
      }),
    );
    const rng = seededRandom(7);
    let lib = createEmptyCard(new Date(T0));
    let mine = freshCard();
    let nowMs = Date.parse(T0);
    for (let i = 0; i < 40; i += 1) {
      const rating = (Math.floor(rng() * 4) + 1) as Rating;
      nowMs = Math.max(nowMs, lib.due.getTime()) + Math.floor(rng() * 3 * DAY);
      lib = f.next(lib, new Date(nowMs), rating as Grade).card;
      mine = review(mine, rating, nowMs, SETTINGS, {
        logId: `log-${String(i).padStart(6, '0')}`,
        sessionId: 'session-0001',
        durationMs: 1,
      }).card;
      expect(mine.fsrs.stability).toBe(lib.stability);
      expect(mine.fsrs.difficulty).toBe(lib.difficulty);
      expect(mine.dueAt).toBe(lib.due.toISOString());
      expect(mine.fsrs.reps).toBe(lib.reps);
      expect(mine.fsrs.lapses).toBe(lib.lapses);
      expect(mine.fsrs.scheduledDays).toBe(lib.scheduled_days);
    }
  });
});

describe('invariants over random answer sequences', () => {
  it('never schedules in the past, stability stays positive, Good never lowers stability', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rng = seededRandom(seed);
      let card = freshCard(`card-${String(seed).padStart(4, '0')}`);
      let nowMs = Date.parse(T0);
      for (let i = 0; i < 40; i += 1) {
        // Answer on time or up to a week late; occasionally early.
        const wait = Math.floor(rng() * 7 * DAY);
        nowMs = Math.max(nowMs, Date.parse(card.dueAt) + (rng() < 0.15 ? -wait : wait));
        const rating = (Math.floor(rng() * 4) + 1) as Rating;
        const before = card.fsrs;
        const { card: next, log } = review(card, rating, nowMs, SETTINGS, {
          logId: `log-${seed}-${i}-xx`,
          sessionId: 'session-0001',
          durationMs: 100,
        });
        expect(Date.parse(next.dueAt)).toBeGreaterThanOrEqual(nowMs);
        expect(next.dueAt).toBe(next.fsrs.due);
        expect(next.fsrs.stability).toBeGreaterThan(0);
        expect(Number.isFinite(next.fsrs.difficulty)).toBe(true);
        expect(next.fsrs.reps).toBe(before.reps + 1);
        expect(next.fsrs.lastReview).toBe(log.reviewedAt);
        if (before.state === 'review' && rating >= 2) {
          expect(next.fsrs.stability).toBeGreaterThanOrEqual(before.stability);
          expect(next.fsrs.state).toBe('review');
        }
        if (before.state === 'review' && rating === 1) {
          expect(next.fsrs.lapses).toBe(before.lapses + 1);
          expect(next.fsrs.state).toBe('relearning');
          expect(next.fsrs.stability).toBeLessThanOrEqual(before.stability);
        }
        expect(CardSchema.safeParse(next).success).toBe(true);
        expect(ReviewLogSchema.safeParse(log).success).toBe(true);
        card = next;
      }
    }
  });

  it('stability grows monotonically over consecutive on-time Good answers', () => {
    const { rows } = play(Array.from({ length: 12 }, () => [G, 0] as const));
    const stabilities = rows.map((r) => r.stability);
    for (let i = 1; i < stabilities.length; i += 1) {
      expect(stabilities[i] as number).toBeGreaterThanOrEqual(stabilities[i - 1] as number);
    }
    expect(stabilities.at(-1) as number).toBeGreaterThan(1000);
  });

  it('a higher target retention gives shorter intervals', () => {
    const base = play(
      Array.from({ length: 5 }, () => [G, 0] as const),
      SETTINGS,
    );
    const dueAfter = (targetRetention: number) => {
      const c = play(
        [
          [G, 0],
          [G, 0],
          [G, 0],
        ],
        { ...SETTINGS, targetRetention },
      ).card;
      return Date.parse(c.dueAt) - Date.parse(c.fsrs.lastReview as string);
    };
    expect(dueAfter(0.75)).toBeGreaterThan(dueAfter(0.9));
    expect(dueAfter(0.9)).toBeGreaterThan(dueAfter(0.97));
    expect(base.rows).toHaveLength(5);
  });

  it('maxIntervalDays caps the interval', () => {
    const { card } = play(
      Array.from({ length: 8 }, () => [G, 0] as const),
      {
        ...SETTINGS,
        maxIntervalDays: 30,
      },
    );
    expect(card.fsrs.scheduledDays).toBe(30);
    expect(Date.parse(card.dueAt) - Date.parse(card.fsrs.lastReview as string)).toBe(30 * DAY);
  });
});

describe('preview', () => {
  it('shows the four outcomes of a new card with labels', () => {
    const p = preview(freshCard(), T0, SETTINGS);
    expect(p[1]).toMatchObject({
      dueAt: '2026-01-05T09:01:00.000Z',
      label: '1m',
      state: 'learning',
    });
    expect(p[2]).toMatchObject({
      dueAt: '2026-01-05T09:06:00.000Z',
      label: '6m',
      state: 'learning',
    });
    expect(p[3]).toMatchObject({
      dueAt: '2026-01-05T09:10:00.000Z',
      label: '10m',
      state: 'learning',
    });
    expect(p[4]).toMatchObject({ dueAt: '2026-01-13T09:00:00.000Z', label: '8d', state: 'review' });
  });

  it('agrees exactly with what review() then does, including with fuzz enabled', () => {
    const fuzzy = { ...SETTINGS, enableFuzz: true };
    let card = freshCard('card-fuzz-1');
    let nowMs = Date.parse(T0);
    for (let i = 0; i < 12; i += 1) {
      nowMs = Math.max(nowMs, Date.parse(card.dueAt));
      const p = preview(card, nowMs, fuzzy);
      for (const rating of [1, 2, 3, 4] as const) {
        const r = review(card, rating, nowMs, fuzzy, {
          logId: 'log-000001',
          sessionId: 'session-0001',
          durationMs: 0,
        });
        expect(r.card.dueAt).toBe(p[rating].dueAt);
        expect(r.card.fsrs.state).toBe(p[rating].state);
      }
      card = review(card, 3, nowMs, fuzzy, {
        logId: 'log-000001',
        sessionId: 'session-0001',
        durationMs: 0,
      }).card;
    }
  });

  it('is monotone: Again <= Hard <= Good <= Easy', () => {
    let card = freshCard();
    for (const step of [0, 0, 0] as const) {
      card = review(card, G, Date.parse(card.dueAt) + step, SETTINGS, {
        logId: 'log-000001',
        sessionId: 'session-0001',
        durationMs: 0,
      }).card;
    }
    const p = preview(card, card.dueAt, SETTINGS);
    expect(Date.parse(p[1].dueAt)).toBeLessThan(Date.parse(p[2].dueAt));
    expect(Date.parse(p[2].dueAt)).toBeLessThanOrEqual(Date.parse(p[3].dueAt));
    expect(Date.parse(p[3].dueAt)).toBeLessThan(Date.parse(p[4].dueAt));
  });
});

describe('fuzz', () => {
  const advance = (card: Card, n: number, settings: DeckSettings, seed?: string): Card => {
    let c = card;
    for (let i = 0; i < n; i += 1) {
      c = review(c, G, Date.parse(c.dueAt), settings, {
        logId: 'log-000001',
        sessionId: 'session-0001',
        durationMs: 0,
        ...(seed ? { seed } : {}),
      }).card;
    }
    return c;
  };

  it('off: intervals are exact and independent of the card id', () => {
    const a = advance(freshCard('card-aaaa-01'), 5, SETTINGS);
    const b = advance(freshCard('card-bbbb-01'), 5, SETTINGS);
    expect(a.dueAt).toBe(b.dueAt);
  });

  it('on: deterministic per card and rep count, but different cards spread out', () => {
    const settings = { ...SETTINGS, enableFuzz: true };
    const dues = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const id = `card-fz-${String(i).padStart(4, '0')}`;
      const first = advance(freshCard(id), 6, settings);
      const again = advance(freshCard(id), 6, settings);
      expect(again.dueAt).toBe(first.dueAt);
      dues.add(first.dueAt);
    }
    expect(dues.size).toBeGreaterThan(3);
  });

  it('an injected seed overrides the card-derived one', () => {
    const settings = { ...SETTINGS, enableFuzz: true };
    const a = advance(freshCard('card-aaaa-01'), 6, settings, 'same-seed');
    const b = advance(freshCard('card-bbbb-01'), 6, settings, 'same-seed');
    expect(a.dueAt).toBe(b.dueAt);
  });
});

describe('leeches', () => {
  it('triggers at the threshold, then every half threshold', () => {
    const hits = [] as number[];
    for (let lapses = 1; lapses <= 20; lapses += 1) {
      if (isLeechTrigger(lapses - 1, lapses, 8)) hits.push(lapses);
    }
    expect(hits).toEqual([8, 12, 16, 20]);
    expect(isLeechTrigger(0, 1, 1)).toBe(true);
    expect(isLeechTrigger(5, 5, 5)).toBe(false);
  });

  it('review() tags and suspends the card that hits the threshold', () => {
    const settings = { ...SETTINGS, leechThreshold: 3 };
    const base = makeCard('card-leech-1', {
      state: 'review',
      lapses: 2,
      due: '2026-01-05T09:00:00.000Z',
      lastReview: '2026-01-01T09:00:00.000Z',
      stability: 4,
      difficulty: 6,
      reps: 9,
    });
    const r = review(base, AGAIN, T0, settings, {
      logId: 'log-000001',
      sessionId: 'session-0001',
      durationMs: 1000,
    });
    expect(r.leech).toBe(true);
    expect(r.log.leech).toBe(true);
    expect(r.card.suspended).toBe(true);
    expect(r.card.tags).toContain('leech');

    const tagOnly = review(base, AGAIN, T0, settings, {
      logId: 'log-000001',
      sessionId: 'session-0001',
      durationMs: 1000,
      suspendLeeches: false,
    });
    expect(tagOnly.card.suspended).toBe(false);
    expect(tagOnly.card.tags).toContain('leech');

    const notYet = review({ ...base, fsrs: { ...base.fsrs, lapses: 0 } }, AGAIN, T0, settings, {
      logId: 'log-000001',
      sessionId: 'session-0001',
      durationMs: 1000,
    });
    expect(notYet.leech).toBe(false);
    expect(notYet.card.suspended).toBe(false);
  });
});

describe('undo of the last review', () => {
  const opts = (n: number) => ({
    logId: `log-${String(n).padStart(6, '0')}`,
    sessionId: 'session-0001',
    durationMs: 2500,
  });

  it('restores the exact previous scheduling state and amends the log', () => {
    const before = review(freshCard(), G, T0, SETTINGS, opts(1)).card;
    const at = '2026-01-05T09:10:00.000Z';
    const r = review(before, G, at, SETTINGS, opts(2));
    const undone = undoReview(r.card, r.log, '2026-01-05T09:10:30.000Z');
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.card.fsrs).toEqual(before.fsrs);
    expect(undone.card.dueAt).toBe(before.dueAt);
    expect({ ...undone.card, updatedAt: before.updatedAt }).toEqual(before);
    expect(undone.log.userCorrection).toEqual({ kind: 'undone', at: '2026-01-05T09:10:30.000Z' });
    expect(undone.log.nextState).toEqual(r.log.nextState);
    // The same review can be re-answered differently afterwards.
    const redo = review(undone.card, 4, at, SETTINGS, opts(3));
    expect(redo.card.fsrs.state).toBe('review');
  });

  it('refuses a log that is not the last review, an undone log, and a foreign card', () => {
    const r1 = review(freshCard(), G, T0, SETTINGS, opts(1));
    const r2 = review(r1.card, G, '2026-01-05T09:10:00.000Z', SETTINGS, opts(2));
    expect(undoReview(r2.card, r1.log, T0)).toEqual({ ok: false, reason: 'not_last_review' });
    const ok = undoReview(r2.card, r2.log, T0);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(undoReview(ok.card, ok.log, T0)).toEqual({ ok: false, reason: 'already_undone' });
    expect(undoReview(freshCard('card-other-1'), r2.log, T0)).toEqual({
      ok: false,
      reason: 'card_mismatch',
    });
    // A manual reschedule after the review also makes the log stale.
    const moved = reschedule(r2.card, '2026-02-01T00:00:00.000Z', T0);
    expect(undoReview(moved, r2.log, T0)).toEqual({ ok: false, reason: 'not_last_review' });
  });

  it('undoing a leech answer lifts the suspension', () => {
    const settings = { ...SETTINGS, leechThreshold: 2 };
    const base = makeCard('card-leech-2', {
      state: 'review',
      lapses: 1,
      due: T0,
      lastReview: '2026-01-01T09:00:00.000Z',
      stability: 3,
      difficulty: 6,
    });
    const r = review(base, AGAIN, T0, settings, opts(1));
    expect(r.card.suspended).toBe(true);
    const undone = undoReview(r.card, r.log, T0);
    expect(undone.ok && undone.card.suspended).toBe(false);
    expect(undone.ok && undone.card.tags).not.toContain('leech');
  });
});

describe('manual scheduling operations', () => {
  const reviewCard = () =>
    makeCard('card-manual-1', {
      state: 'review',
      due: '2026-01-04T09:00:00.000Z',
      lastReview: '2025-12-30T09:00:00.000Z',
      stability: 5,
      difficulty: 5,
      reps: 4,
      lapses: 1,
    });

  it('reschedule moves the due date, keeps memory state, and never lands in the past', () => {
    const moved = reschedule(reviewCard(), '2026-01-20T09:00:00.000Z', T0);
    expect(moved.dueAt).toBe('2026-01-20T09:00:00.000Z');
    expect(moved.fsrs.due).toBe(moved.dueAt);
    expect(moved.fsrs.stability).toBe(5);
    expect(moved.fsrs.scheduledDays).toBe(21);
    const clamped = reschedule(reviewCard(), '2025-01-01T00:00:00.000Z', T0);
    expect(clamped.dueAt).toBe(T0);
    expect(CardSchema.safeParse(moved).success).toBe(true);
  });

  it('reset forgets the card but keeps counts unless asked', () => {
    const kept = resetCard(reviewCard(), T0);
    expect(kept.fsrs).toMatchObject({ state: 'new', stability: 0, reps: 4, lapses: 1, due: T0 });
    expect(kept.fsrs.lastReview).toBeNull();
    const wiped = resetCard(reviewCard(), T0, { resetCounts: true });
    expect(wiped.fsrs).toMatchObject({ reps: 0, lapses: 0 });
    // A reset card can be reviewed like a new one.
    const r = review(kept, G, T0, SETTINGS, {
      logId: 'log-000001',
      sessionId: 'session-0001',
      durationMs: 0,
    });
    expect(r.card.fsrs.state).toBe('learning');
  });

  it('suspend / bury / unbury', () => {
    const c = reviewCard();
    expect(setSuspended(c, true, T0).suspended).toBe(true);
    const LA: DayBoundary = { timeZone: 'America/Los_Angeles', rolloverHour: 4 };
    const buried = buryCard(c, '2026-03-08T20:00:00.000Z', LA); // 13:00 PDT on the DST day
    const tomorrow = studyDayStartMs(
      studyDayNumber(Date.parse('2026-03-08T20:00:00.000Z'), LA) + 1,
      LA,
    );
    expect(buried.buriedUntil).toBe(new Date(tomorrow).toISOString());
    expect(buried.buriedUntil).toBe('2026-03-09T11:00:00.000Z'); // 04:00 PDT
    expect(unburyCard(buried, T0).buriedUntil).toBeNull();
  });
});

describe('persistence', () => {
  it('JSON round trip yields a card whose next reviews are identical', () => {
    const rng = seededRandom(99);
    let card = freshCard('card-persist-1');
    let nowMs = Date.parse(T0);
    const settings = { ...SETTINGS, enableFuzz: true };
    for (let i = 0; i < 15; i += 1) {
      nowMs = Math.max(nowMs, Date.parse(card.dueAt)) + Math.floor(rng() * 2 * DAY);
      const rating = (Math.floor(rng() * 4) + 1) as Rating;
      const r = review(card, rating, nowMs, settings, {
        logId: `log-${String(i).padStart(6, '0')}`,
        sessionId: 'session-0001',
        durationMs: 1234,
      });
      // Persist both rows and restore them, as the storage layer would.
      const restoredCard = CardSchema.parse(JSON.parse(JSON.stringify(r.card)));
      const restoredLog = ReviewLogSchema.parse(JSON.parse(JSON.stringify(r.log)));
      expect(restoredCard).toEqual(r.card);
      expect(restoredLog).toEqual(r.log);
      card = restoredCard;
    }
    const nextAt = Date.parse(card.dueAt) + 3 * DAY;
    const original = freshCard('card-persist-1');
    expect(original.fsrs).toEqual(newFsrsState(T0));
    const viaRestore = CardSchema.parse(JSON.parse(JSON.stringify(card)));
    for (const rating of [1, 2, 3, 4] as const) {
      const o = { logId: 'log-999999', sessionId: 'session-0001', durationMs: 0 };
      expect(review(viaRestore, rating, nextAt, settings, o)).toEqual(
        review(card, rating, nextAt, settings, o),
      );
    }
    expect(preview(viaRestore, nextAt, settings)).toEqual(preview(card, nextAt, settings));
  });

  it('records the algorithm version and the elapsed/scheduled days in the log', () => {
    const { logs } = play([
      [G, 0],
      [G, 0],
      [G, 0],
    ]);
    expect(logs[0]?.algorithmVersion).toBe(ALGORITHM_VERSION);
    expect(ALGORITHM_VERSION).toMatch(/FSRS-6/);
    expect(logs.map((l) => [l.elapsedDays, l.scheduledDays])).toEqual([
      [0, 0],
      [0, 2],
      [2, 11],
    ]);
    expect(logs[1]?.previousState.state).toBe('learning');
    expect(logs[1]?.nextState.state).toBe('review');
  });
});

describe('time zones and clock changes', () => {
  // Reach a review-state card whose last review is 2026-01-10T07:00Z (23:00 on Jan 9 in Los Angeles).
  const reviewAt = (boundary: DayBoundary | undefined, secondReview: string) => {
    const start = freshCard('card-tz-0001', '2026-01-10T06:50:00.000Z');
    const o = { logId: 'log-000001', sessionId: 'session-0001', durationMs: 0 };
    const b = boundary ? { boundary } : {};
    const a = review(start, G, '2026-01-10T06:50:00.000Z', SETTINGS, { ...o, ...b }).card;
    const c = review(a, G, '2026-01-10T07:00:00.000Z', SETTINGS, { ...o, ...b }).card;
    expect(c.fsrs.state).toBe('review');
    return review(c, G, secondReview, SETTINGS, { ...o, ...b }).log;
  };

  it("counts elapsed days in the user's study days, not UTC calendar days", () => {
    const second = '2026-01-10T09:00:00.000Z'; // 01:00 on Jan 10 in Los Angeles; same UTC date
    expect(reviewAt(undefined, second).elapsedDays).toBe(0);
    expect(reviewAt({ timeZone: 'America/Los_Angeles', rolloverHour: 0 }, second).elapsedDays).toBe(
      1,
    );
    // With a 4am rollover both reviews belong to the study day of Jan 9.
    expect(reviewAt({ timeZone: 'America/Los_Angeles', rolloverHour: 4 }, second).elapsedDays).toBe(
      0,
    );
  });

  it('due dates are real elapsed time regardless of the boundary', () => {
    const second = '2026-01-12T09:00:00.000Z';
    const utc = reviewAt(undefined, second);
    const la = reviewAt({ timeZone: 'America/Los_Angeles', rolloverHour: 4 }, second);
    expect(Date.parse(utc.nextState.due) - Date.parse(second)).toBe(
      utc.nextState.scheduledDays * DAY,
    );
    expect(Date.parse(la.nextState.due) - Date.parse(second)).toBe(
      la.nextState.scheduledDays * DAY,
    );
  });

  it('a clock that moved back never produces a due date or review time before the last review', () => {
    const first = review(freshCard(), G, '2026-01-05T09:00:00.000Z', SETTINGS, {
      logId: 'log-000001',
      sessionId: 'session-0001',
      durationMs: 0,
    }).card;
    const r = review(first, G, '2026-01-01T00:00:00.000Z', SETTINGS, {
      logId: 'log-000002',
      sessionId: 'session-0001',
      durationMs: 0,
    });
    expect(r.clockAdjusted).toBe(true);
    expect(r.log.reviewedAt).toBe('2026-01-05T09:00:00.000Z');
    expect(Date.parse(r.card.dueAt)).toBeGreaterThanOrEqual(Date.parse('2026-01-05T09:00:00.000Z'));
    expect(r.log.elapsedDays).toBe(0);
    expect(preview(first, '2026-01-01T00:00:00.000Z', SETTINGS)[3].intervalMs).toBeGreaterThan(0);
  });

  it('a delayed review (clock jumped far forward) is handled as a late review', () => {
    const { card } = play([
      [G, 0],
      [G, 0],
      [G, 0],
    ]);
    const late = review(card, G, Date.parse(card.dueAt) + 400 * DAY, SETTINGS, {
      logId: 'log-000009',
      sessionId: 'session-0001',
      durationMs: 0,
    });
    expect(late.log.elapsedDays).toBeGreaterThan(400);
    expect(Date.parse(late.card.dueAt)).toBeGreaterThan(Date.parse(card.dueAt) + 400 * DAY);
  });
});

describe('retrievability', () => {
  it('is null for new cards, 1 at review time, and falls with time', () => {
    expect(retrievability(freshCard(), T0)).toBeNull();
    const { card } = play([
      [G, 0],
      [G, 0],
      [G, 0],
    ]);
    const at = card.fsrs.lastReview as string;
    expect(retrievability(card, at)).toBeCloseTo(1, 10);
    const later = retrievability(card, Date.parse(at) + 30 * DAY) as number;
    const much = retrievability(card, Date.parse(at) + 300 * DAY) as number;
    expect(later).toBeLessThan(1);
    expect(much).toBeLessThan(later);
    expect(much).toBeGreaterThan(0);
  });
});
