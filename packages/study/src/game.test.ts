// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  BADGES,
  DEFAULT_DAILY_GOAL,
  GameEventRow,
  GameFactRow,
  GameRow,
  cardEvent,
  cardUndoFact,
  deriveGame,
  foldRange,
  goalFact,
  levelForXp,
  localHour,
  mergeDays,
  modeFact,
  pendingCelebrations,
  reviewEvent,
  reviewUndoFact,
  saveEvent,
  saveUndoFact,
  sessionFact,
  startFact,
  xpForLevel,
  type Celebration,
  type DerivedGame,
} from './game';
import {
  DAY_MS,
  HOUR_MS,
  studyDayKey,
  studyDayNumber,
  studyDayStartMs,
  type DayBoundary,
} from './time';

const UTC: DayBoundary = { timeZone: 'UTC', rolloverHour: 0 };

let seq = 0;
const nextId = () => `id${String(++seq).padStart(8, '0')}`;
/** ISO instant `h` hours (and `m` minutes) after the UTC midnight that starts `day`. */
const at = (day: string, h = 12, m = 0) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + h * HOUR_MS + m * 60_000).toISOString();
const plusDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

const rv = (iso: string, id = nextId()) => reviewEvent({ id, reviewedAt: iso });
const hs = (iso: string, id = nextId()) =>
  saveEvent({ id, createdAt: iso, captureMethod: 'toolbar' })!;
const cd = (iso: string, id = nextId()) => cardEvent({ id, createdAt: iso });
const start = (iso: string) => startFact(nextId(), iso);
const goal = (g: 10 | 30 | 50 | 100, iso: string) => goalFact(nextId(), g, iso);

/**
 * A start fact far in the future: every day of the test is "before the game started", where any XP
 * counts. Without any start fact the engine judges from today (the backfill always writes one).
 */
const noGoalYet = () => start('2100-01-01T00:00:00.000Z');

/** The whole engine over one range, as storage does without a cache. No purge copies in `rows`. */
function play(rows: readonly GameRow[], nowIso: string, b: DayBoundary = UTC): DerivedGame {
  const events = rows.filter((r) => r.kind === 'review' || r.kind === 'save' || r.kind === 'card');
  return playSplit(
    events,
    rows.filter((r) => !events.includes(r)),
    nowIso,
    b,
  );
}

function playSplit(
  events: readonly GameRow[],
  facts: readonly GameRow[],
  nowIso: string,
  b: DayBoundary = UTC,
): DerivedGame {
  const T = studyDayNumber(Date.parse(nowIso), b);
  const all = foldRange(events, facts, b, T);
  return deriveGame({
    days: all.days,
    ordered: all.ordered,
    goals: facts.filter((f) => f.kind === 'goal'),
    starts: facts.filter((f) => f.kind === 'start'),
    b,
    T,
  });
}

/** `perDay[i]` reviews on day `first + i` (UTC noon onwards, one minute apart). */
function reviewsOn(first: string, perDay: readonly number[]): GameRow[] {
  return perDay.flatMap((n, i) =>
    Array.from({ length: n }, (_, k) => rv(at(plusDays(first, i), 12, k))),
  );
}
/** `reviewsOn` with every day judged by "any XP" (no goal yet). */
const habit = (first: string, perDay: readonly number[]) => [
  noGoalYet(),
  ...reviewsOn(first, perDay),
];

const badge = (g: DerivedGame, id: string) => g.badges.find((x) => x.id === id)!;

describe('ledger rows', () => {
  it('derives deterministic ids and validates every kind', () => {
    const log = { id: 'log-00000001', reviewedAt: at('2026-03-02') };
    expect(reviewEvent(log)).toEqual({
      id: 'rv_log-00000001',
      schemaVersion: 1,
      kind: 'review',
      at: log.reviewedAt,
      ref: 'log-00000001',
      value: null,
    });
    expect(
      saveEvent({ id: 'hl-0000001', createdAt: log.reviewedAt, captureMethod: 'import' }),
    ).toBe(null);
    const rows = [
      reviewEvent(log),
      hs(log.reviewedAt),
      cd(log.reviewedAt),
      reviewUndoFact(log),
      saveUndoFact({ id: 'hl-0000001', createdAt: log.reviewedAt }),
      cardUndoFact({ id: 'card-000001', createdAt: log.reviewedAt }),
      sessionFact('session-0001', log.reviewedAt),
      goal(50, log.reviewedAt),
      modeFact(nextId(), false, log.reviewedAt),
      start(log.reviewedAt),
    ];
    for (const r of rows) expect(GameFactRow.safeParse(r).success, r.id).toBe(true);
    expect(rows.filter((r) => GameEventRow.safeParse(r).success)).toHaveLength(3);
    // id, ref and value must agree with the kind
    expect(GameRow.safeParse({ ...reviewEvent(log), id: 'rv_other-0001' }).success).toBe(false);
    expect(GameRow.safeParse({ ...goal(30, log.reviewedAt), value: 20 }).success).toBe(false);
    expect(GameRow.safeParse({ ...start(log.reviewedAt), ref: 'log-00000001' }).success).toBe(
      false,
    );
    expect(
      GameRow.safeParse({ ...modeFact(nextId(), true, log.reviewedAt), value: 2 }).success,
    ).toBe(false);
    // the shape survives superRefine: the sync applier and the integrity check read `.shape`
    expect(Object.keys(GameRow.shape).sort()).toEqual(
      ['at', 'id', 'kind', 'ref', 'schemaVersion', 'value'].sort(),
    );
  });
});

describe('levels', () => {
  it('follows 25·L·(L−1): each level needs 50 XP more than the one before', () => {
    const table = [0, 50, 150, 300, 500, 750, 1050, 1400, 1800, 2250];
    const more = [2750, 3300, 3900, 4550, 5250, 6000, 6800, 7650, 8550, 9500];
    expect(Array.from({ length: 20 }, (_, i) => xpForLevel(i + 1))).toEqual([...table, ...more]);
    for (let l = 1; l <= 20; l++) expect(xpForLevel(l + 1) - xpForLevel(l)).toBe(50 * l);
  });

  it('inverts exactly at every boundary up to level 500', () => {
    for (let n = 2; n <= 500; n++) {
      expect(levelForXp(xpForLevel(n))).toBe(n);
      expect(levelForXp(xpForLevel(n) - 1)).toBe(n - 1);
    }
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(-40)).toBe(1);
    expect(levelForXp(Number.NaN)).toBe(1);
    const big = levelForXp(1e9);
    expect(xpForLevel(big)).toBeLessThanOrEqual(1e9);
    expect(xpForLevel(big + 1)).toBeGreaterThan(1e9);
    expect(levelForXp(200_000)).toBe(89); // a backfilled 100k-review vault
  });
});

describe('the fold', () => {
  it('is rating-neutral: every review is 1 XP', () => {
    const logs = [1, 2, 3, 4].map((rating) => ({
      id: nextId(),
      reviewedAt: at('2026-03-02', 10, rating),
      rating,
    }));
    const g = play(logs.map(reviewEvent), at('2026-03-02', 20));
    expect(g.today).toMatchObject({ xp: 4, reviews: 4 });
    expect(g.totalXp).toBe(4);
  });

  it('cancels review, save and card cancellers, counts a canceller without target as 0 and a purge copy once', () => {
    const day = '2026-03-02';
    const log = { id: 'log-00000001', reviewedAt: at(day, 9) };
    const kept = rv(at(day, 9, 5));
    const save = { id: 'hl-00000001', createdAt: at(day, 10) };
    const merged = { id: 'card-merged1', createdAt: at(day, 10, 30) }; // a merge restore's card
    const copy = cd(at(day, 11)); // a card event whose source was purged: in both tables
    const orphanCopy = cd(at(day, 12)); // only the copy survives (this device never saw the event)
    const events = [reviewEvent(log), kept, hs(save.createdAt, save.id), cardEvent(merged), copy];
    const facts = [
      reviewUndoFact(log),
      saveUndoFact(save),
      cardUndoFact(merged),
      reviewUndoFact({ id: 'log-nothing1', reviewedAt: at(day, 13) }),
      { ...copy },
      { ...orphanCopy },
    ];
    const T = studyDayNumber(Date.parse(at(day, 20)), UTC);
    const fold = foldRange(events, facts, UTC, T);
    expect(fold.days.get(T)).toEqual({
      xp: 1 + 3 + 3,
      reviews: 1,
      saves: 0,
      cards: 2,
      sessions: 0,
      night: 0,
    });
    expect(fold.ordered.map((r) => r.id)).toEqual([kept.id, copy.id, orphanCopy.id]);
  });

  it('counts a session bonus as 5 XP and ignores goal, mode and start rows', () => {
    const day = '2026-03-02';
    const g = play(
      [sessionFact('session-0001', at(day, 9)), start(at(day, 1)), goal(10, at(day, 2))],
      at(day, 20),
    );
    expect(g.today).toMatchObject({ xp: 5, sessions: 1 });
  });

  it('reads the local hour in the study zone', () => {
    expect(localHour(Date.parse('2026-03-02T23:30:00.000Z'), 'UTC')).toBe(23);
    expect(localHour(Date.parse('2026-03-02T23:30:00.000Z'), 'Europe/Berlin')).toBe(0);
    expect(localHour(Date.parse('1969-12-31T23:30:00.000Z'), 'UTC')).toBe(23);
  });
});

describe('daily goal', () => {
  const epochDay = '2026-03-10';

  it('defaults to 30 until one is chosen, and a change applies the same day', () => {
    const rows = [start(at(epochDay, 1)), ...reviewsOn(epochDay, [12])];
    const before = play(rows, at(epochDay, 20));
    expect(before.goal).toEqual({ value: DEFAULT_DAILY_GOAL, chosen: false });
    expect(before.today).toMatchObject({ xp: 12, met: false });
    const after = play([...rows, goal(10, at(epochDay, 19))], at(epochDay, 20));
    expect(after.goal).toEqual({ value: 10, chosen: true });
    expect(after.today.met).toBe(true);
    expect(after.streak).toMatchObject({ current: 1, todayCounts: true });
  });

  it('keeps the goal each past day had, and judges days before the epoch by any XP', () => {
    const rows = [
      ...reviewsOn('2026-03-07', [1, 1, 1]), // 7, 8, 9: before the epoch, 1 XP each is enough
      start(at(epochDay, 1)),
      goal(10, at(epochDay, 2)),
      ...reviewsOn(epochDay, [10, 10]), // 10 and 11 meet 10
      goal(50, at('2026-03-12', 2)),
      ...reviewsOn('2026-03-12', [10]), // 12 does not meet 50
    ];
    const g = play(rows, at('2026-03-12', 20));
    const byKey = Object.fromEntries(g.days.map((d) => [d.dayKey, d]));
    expect(byKey['2026-03-08']).toMatchObject({ xp: 1, goal: null, met: true });
    expect(byKey['2026-03-10']).toMatchObject({ xp: 10, goal: 10, met: true });
    expect(byKey['2026-03-11']).toMatchObject({ goal: 10, met: true });
    expect(byKey['2026-03-12']).toMatchObject({ xp: 10, goal: 50, met: false });
    expect(g.streak).toMatchObject({ current: 5, todayCounts: false });
    expect(g.goal.value).toBe(50);
  });

  it('takes the earlier of two start facts as the epoch (two devices before they synced)', () => {
    const rows = [
      ...reviewsOn('2026-03-08', [1, 1, 1]),
      start(at('2026-03-10', 5)),
      start(at('2026-03-09', 5)),
    ];
    const g = play(rows, at('2026-03-10', 20));
    const byKey = Object.fromEntries(g.days.map((d) => [d.dayKey, d]));
    expect(byKey['2026-03-08']!.goal).toBeNull();
    expect(byKey['2026-03-09']).toMatchObject({ goal: 30, met: false });
  });
});

describe('streak and freezes', () => {
  it('earns a freeze at 7, 14 and 21 streak days and forfeits it at the cap', () => {
    const first = '2026-01-01';
    expect(play(habit(first, Array(7).fill(1)), at(plusDays(first, 6))).streak).toMatchObject({
      current: 7,
      freezes: 1,
    });
    expect(play(habit(first, Array(6).fill(1)), at(plusDays(first, 5))).streak.freezes).toBe(0);
    expect(play(habit(first, Array(14).fill(1)), at(plusDays(first, 13))).streak.freezes).toBe(2);
    const g = play(habit(first, Array(21).fill(1)), at(plusDays(first, 20)));
    expect(g.streak).toMatchObject({ current: 21, longest: 21, freezes: 2 });
  });

  it('spends one freeze per missed day, never lengthens the run, and resets on the third miss', () => {
    const first = '2026-01-01';
    // 14 met days (2 freezes), 1 miss, 1 met: the run is 15, not 16
    const a = play(habit(first, [...Array(14).fill(1), 0, 1]), at(plusDays(first, 15)));
    expect(a.streak).toMatchObject({ current: 15, freezes: 1 });
    expect(a.days.find((d) => d.dayKey === plusDays(first, 14))).toMatchObject({ frozen: true });
    // two misses use both freezes and keep the run
    const b = play(habit(first, [...Array(14).fill(1), 0, 0, 1]), at(plusDays(first, 16)));
    expect(b.streak).toMatchObject({ current: 15, freezes: 0 });
    // three misses in a row always reset (at most 2 are held)
    const c = play(habit(first, [...Array(14).fill(1), 0, 0, 0, 1]), at(plusDays(first, 17)));
    expect(c.streak).toMatchObject({ current: 1, longest: 14, freezes: 0 });
    // a miss with no freeze held resets
    const d = play(habit(first, [1, 1, 0, 1]), at(plusDays(first, 3)));
    expect(d.streak).toMatchObject({ current: 1, longest: 2 });
  });

  it('keeps today open: an unmet today does not break the run until it ends', () => {
    const first = '2026-01-01';
    const g = play(habit(first, [1, 1, 1]), at(plusDays(first, 3), 8));
    expect(g.streak).toMatchObject({ current: 3, todayCounts: false });
    expect(g.today.met).toBe(false);
    const met = play(habit(first, [1, 1, 1, 1]), at(plusDays(first, 3), 20));
    expect(met.streak).toMatchObject({ current: 4, todayCounts: true });
  });

  it('heals itself when a late row fills a frozen day: the freeze comes back', () => {
    const first = '2026-01-01';
    const rows = habit(first, [...Array(7).fill(1), 0, 1]);
    const frozen = play(rows, at(plusDays(first, 8), 20));
    expect(frozen.streak).toMatchObject({ current: 8, freezes: 0 });
    const healed = play([...rows, rv(at(plusDays(first, 7), 15))], at(plusDays(first, 8), 20));
    expect(healed.streak).toMatchObject({ current: 9, freezes: 1 });
    expect(healed.days.some((d) => d.frozen)).toBe(false);
  });

  it('earns freezes before the epoch, so ignoring the goal card still earns them', () => {
    const first = '2026-01-01';
    const rows = [...reviewsOn(first, Array(7).fill(1)), start(at(plusDays(first, 7), 1))];
    const g = play(rows, at(plusDays(first, 7), 8));
    expect(g.streak).toMatchObject({ current: 7, freezes: 1, todayCounts: false });
  });
});

describe('milestones and badges', () => {
  const first = '2026-01-01';

  it('a first 7-day run reports the badge, not the streak milestone; a later one reports the milestone', () => {
    const rows = habit(first, Array(7).fill(1));
    const g = play(rows, at(plusDays(first, 6), 20));
    const keys = g.milestones.map((m) => m.key);
    expect(keys).toContain('badge:streak_7');
    expect(keys.some((k) => k.startsWith('streak:7'))).toBe(false);
    expect(badge(g, 'streak_7').unlockedDayKey).toBe(plusDays(first, 6));

    const again = habit(first, [...Array(7).fill(1), 0, 0, 0, ...Array(7).fill(1)]);
    const h = play(again, at(plusDays(first, 16), 20));
    expect(h.milestones.map((m) => m.key)).toEqual(
      expect.arrayContaining([`streak:7:${plusDays(first, 16)}`]),
    );
    expect(h.milestones.map((m) => m.key)).not.toContain('badge:streak_7');
  });

  it('reports streak milestones at 30, 100 and 365, dated at the goal crossing', () => {
    for (const n of [30, 100, 365]) {
      const rows = habit(first, Array(n).fill(1));
      const today = plusDays(first, n - 1);
      const g = play(rows, at(today, 20));
      const streak = g.milestones.filter((m) => m.kind === 'streak' || m.key === 'badge:streak_30');
      if (n === 30) {
        expect(streak.map((m) => m.key)).toEqual(['badge:streak_30']); // the badge suppresses it
      } else {
        expect(streak.map((m) => m.key)).toEqual([`streak:${n}:${today}`]);
      }
      expect(streak[0]!.at).toBe(at(today, 12, 0));
      expect(g.streak.current).toBe(n);
    }
  });

  it('unlocks every badge by its rule and day, and re-locks it when the history changes', () => {
    const day = '2026-02-01';
    const save = { id: 'hl-00000001', createdAt: at(day, 9) };
    const rows: GameRow[] = [
      start(at(day, 0)),
      goal(10, at(day, 0, 30)),
      hs(save.createdAt, save.id),
      cd(at(day, 9, 30)),
      sessionFact('session-0001', at(day, 10)),
    ];
    const g = play(rows, at(day, 20));
    expect(badge(g, 'first_save')).toMatchObject({ unlockedDayKey: day, value: 1, target: 1 });
    expect(badge(g, 'first_card').unlockedDayKey).toBe(day);
    expect(badge(g, 'first_session').unlockedDayKey).toBe(day);
    expect(badge(g, 'cards_100')).toMatchObject({ unlockedDayKey: null, value: 1, target: 100 });
    expect(g.today.xp).toBe(10);
    // undoing the save re-locks first_save (its celebration key stays seen, so it never repeats)
    const undone = play([...rows, saveUndoFact(save)], at(day, 20));
    expect(badge(undone, 'first_save')).toMatchObject({ unlockedDayKey: null, value: 0 });

    // counts: 100 saves, 100 cards and 1000 reviews over two days
    const many: GameRow[] = [
      ...Array.from({ length: 60 }, (_, i) => hs(at(day, 1, i))),
      ...Array.from({ length: 40 }, (_, i) => hs(at(plusDays(day, 1), 1, i))),
      ...Array.from({ length: 100 }, (_, i) => cd(at(plusDays(day, 1), 2, i % 60))),
      ...Array.from({ length: 1000 }, (_, i) =>
        rv(at(plusDays(day, 1), 3 + Math.floor(i / 60), i % 60)),
      ),
    ];
    const m = play(many, at(plusDays(day, 2), 12));
    expect(badge(m, 'bank_builder')).toMatchObject({
      unlockedDayKey: plusDays(day, 1),
      value: 100,
    });
    expect(badge(m, 'cards_100').unlockedDayKey).toBe(plusDays(day, 1));
    expect(badge(m, 'reviews_1000').unlockedDayKey).toBe(plusDays(day, 1));
    expect(m.totalXp).toBe(100 * 2 + 100 * 3 + 1000);
    expect(badge(m, 'level_10')).toMatchObject({ unlockedDayKey: null, value: 1500, target: 2250 });
  });

  it('level_10 needs 2,250 XP and goal_getter ten met goal days from the epoch on', () => {
    const day = '2026-02-01';
    const below = play(
      Array.from({ length: 749 }, (_, i) => cd(at(day, Math.floor(i / 60), i % 60))),
      at(day, 23),
    );
    expect(badge(below, 'level_10')).toMatchObject({ unlockedDayKey: null, value: 2247 });
    expect(below.level).toEqual({ level: 9, floorXp: 1800, nextXp: 2250 });
    const at10 = play(
      Array.from({ length: 750 }, (_, i) => cd(at(day, Math.floor(i / 60), i % 60))),
      at(day, 23),
    );
    expect(badge(at10, 'level_10').unlockedDayKey).toBe(day);
    expect(at10.milestones.map((x) => x.key)).toEqual(
      expect.arrayContaining(['level:10', 'badge:level_10', 'level:2', 'badge:first_card']),
    );

    const rows = [
      start(at(day, 0)),
      goal(10, at(day, 0, 1)),
      ...reviewsOn(day, Array(10).fill(10)),
    ];
    const g = play(rows, at(plusDays(day, 9), 20));
    expect(badge(g, 'goal_getter')).toMatchObject({ unlockedDayKey: plusDays(day, 9), value: 10 });
    expect(g.milestones.map((x) => x.key)).toContain('badge:goal_getter');
  });

  it('counts night owl reviews by the local hour in the study zone, across a DST change', () => {
    const berlin: DayBoundary = { timeZone: 'Europe/Berlin', rolloverHour: 4 };
    // 2026-03-29: clocks go forward in Berlin. 23:30 local is 22:30Z before and 21:30Z after.
    const nights = [
      ...Array.from({ length: 12 }, (_, i) => rv(`2026-03-27T22:${String(i + 10)}:00.000Z`)), // 23:xx CET
      ...Array.from({ length: 12 }, (_, i) => rv(`2026-03-29T21:${String(i + 10)}:00.000Z`)), // 23:xx CEST
      rv('2026-03-29T00:59:00.000Z'), // 01:59 CET, the night of the change
    ];
    const notNight = [
      rv('2026-03-29T02:30:00.000Z'), // 04:30 CEST
      rv('2026-03-27T21:59:00.000Z'), // 22:59 CET
    ];
    const g = play([...nights, ...notNight], '2026-03-30T12:00:00.000Z', berlin);
    expect(badge(g, 'night_owl')).toMatchObject({ value: 25, target: 25 });
    expect(badge(g, 'night_owl').unlockedDayKey).not.toBeNull();
    const fewer = play([...nights.slice(1), ...notNight], '2026-03-30T12:00:00.000Z', berlin);
    expect(badge(fewer, 'night_owl')).toMatchObject({ value: 24, unlockedDayKey: null });
  });

  it('defines eleven badges, none of them about ratings, time pressure or money', () => {
    expect(BADGES).toHaveLength(11);
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(11);
  });
});

describe('study days across DST', () => {
  const cases: Array<[string, string, string]> = [
    ['Europe/Berlin', '2026-03-29', 'spring'],
    ['Europe/Berlin', '2026-10-25', 'fall'],
    ['America/Sao_Paulo', '2018-11-04', 'spring'], // clocks jumped 00:00 -> 01:00 (DST ended in 2019)
    ['America/Sao_Paulo', '2018-02-18', 'fall'],
  ];
  for (const [timeZone, day, label] of cases) {
    for (const rolloverHour of [0, 2, 4]) {
      it(`${timeZone} ${label} ${day}, rollover ${rolloverHour}: a 23 or 25 hour day is one day`, () => {
        const b: DayBoundary = { timeZone, rolloverHour };
        const mid = Date.parse(`${day}T12:00:00.000Z`);
        const d = studyDayNumber(mid, b);
        const s = studyDayStartMs(d, b);
        const e = studyDayStartMs(d + 1, b);
        expect(e - s).toBeGreaterThanOrEqual(23 * HOUR_MS);
        expect(e - s).toBeLessThanOrEqual(25 * HOUR_MS);
        const rows = [
          noGoalYet(),
          rv(new Date(studyDayStartMs(d - 1, b)).toISOString()),
          rv(new Date(s).toISOString()),
          rv(new Date(e - 1).toISOString()),
          rv(new Date(e).toISOString()),
        ];
        const g = play(rows, new Date(e + HOUR_MS).toISOString(), b);
        const byKey = Object.fromEntries(g.days.map((x) => [x.dayKey, x.xp]));
        expect(byKey[studyDayKey(d - 1)]).toBe(1);
        expect(byKey[studyDayKey(d)]).toBe(2);
        expect(byKey[studyDayKey(d + 1)]).toBe(1);
        expect(g.streak.current).toBe(3);
      });
    }
  }
});

describe('clock-ahead rows', () => {
  it('count in the totals, the level and badge values, never in a day', () => {
    const today = '2026-04-01';
    const ahead = cd(at(plusDays(today, 2)));
    const g = play([rv(at(today, 9)), ahead], at(today, 20));
    expect(g.totalXp).toBe(4);
    expect(g.today.xp).toBe(1);
    expect(g.days.reduce((n, d) => n + d.xp, 0)).toBe(1);
    // crossed only because of the row from the future: unlocked today
    expect(badge(g, 'first_card')).toMatchObject({ value: 1, unlockedDayKey: today });
    expect(g.milestones.map((m) => m.key)).not.toContain('badge:first_card');
  });
});

/** Mulberry32: a seeded generator, so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLedger(seed: number, days = 40, b: DayBoundary = UTC) {
  const r = rng(seed);
  const first = '2026-01-01';
  const events: GameRow[] = [];
  const facts: GameRow[] = [start(at(plusDays(first, 10), 0))];
  for (let d = 0; d < days; d++) {
    const n = Math.floor(r() * 12);
    for (let k = 0; k < n; k++) {
      const iso = at(plusDays(first, d), Math.floor(r() * 24), Math.floor(r() * 60));
      const roll = r();
      const id = nextId();
      if (roll < 0.6) {
        events.push(rv(iso, id));
        if (r() < 0.1) facts.push(reviewUndoFact({ id, reviewedAt: iso }));
      } else if (roll < 0.8) {
        events.push(hs(iso, id));
        if (r() < 0.1) facts.push(saveUndoFact({ id, createdAt: iso }));
      } else {
        const c = cd(iso, id);
        if (r() < 0.2) facts.push({ ...c }); // a purge copy, the event still here ...
        if (r() < 0.1) facts.push({ ...cd(iso) }); // ... or gone
        events.push(c);
      }
      if (r() < 0.05) facts.push(sessionFact(nextId(), iso));
      if (r() < 0.02) facts.push(goal(([10, 30, 50, 100] as const)[Math.floor(r() * 4)]!, iso));
    }
  }
  return { events, facts, now: at(plusDays(first, days - 1), 18), b };
}

function shuffle<T>(items: readonly T[], r: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('replay properties', () => {
  it('is deterministic: any input order gives the same state', () => {
    for (const seed of [1, 2, 3]) {
      const { events, facts, now } = randomLedger(seed);
      const base = playSplit(events, facts, now);
      const r = rng(seed * 101);
      for (let i = 0; i < 3; i++) {
        expect(playSplit(shuffle(events, r), shuffle(facts, r), now)).toEqual(base);
      }
    }
  });

  it('a prefix fold plus a tail fold equals one full fold, at any cut', () => {
    for (const seed of [11, 12, 13, 14]) {
      const { events, facts, now, b } = randomLedger(seed);
      const T = studyDayNumber(Date.parse(now), b);
      const full = foldRange(events, facts, b, T);
      const r = rng(seed);
      for (let k = 0; k < 4; k++) {
        const cutDay = T - Math.floor(r() * 30);
        const cut = studyDayStartMs(cutDay, b);
        const before = (x: GameRow) => Date.parse(x.at) < cut;
        const prefix = foldRange(events.filter(before), facts.filter(before), b, T);
        const tail = foldRange(
          events.filter((x) => !before(x)),
          facts.filter((x) => !before(x)),
          b,
          T,
        );
        expect(mergeDays(prefix.days, tail.days)).toEqual(full.days);
        expect(tail.ordered.map((x) => x.id)).toEqual(full.ordered.map((x) => x.id));
      }
    }
  });
});

describe('celebration eligibility', () => {
  const day = '2026-05-01';
  const rows = [start(at(day, 0)), goal(10, at(day, 0, 1)), ...reviewsOn(day, [12])];
  const g = play(rows, at(day, 20));
  const goalKey = `goal:${day}`;

  it('offers only today’s milestones, after the baseline, with Game mode on, not yet seen', () => {
    expect(g.milestones.map((m) => m.key)).toContain(goalKey);
    const seen = { baselineAt: at(day, 0), keys: [] };
    const all = pendingCelebrations(g.milestones, { mode: true, modeOnAt: null, seen });
    expect(all.map((m) => m.key)).toContain(goalKey);
    const goalMet = all.find((m) => m.key === goalKey) as Extract<Celebration, { kind: 'goal' }>;
    expect(goalMet).toMatchObject({
      kind: 'goal',
      dayKey: day,
      goal: 10,
      xp: 12,
      at: at(day, 12, 9),
    });
    // yesterday's goal is never offered
    expect(play(rows, at(plusDays(day, 1), 20)).milestones).toEqual([]);
    // before the baseline (the backfill finished after the crossing): nothing
    expect(
      pendingCelebrations(g.milestones, {
        mode: true,
        modeOnAt: null,
        seen: { baselineAt: at(day, 13), keys: [] },
      }),
    ).toEqual([]);
    // Game mode off: nothing; switched back on after the crossing: no backlog
    expect(pendingCelebrations(g.milestones, { mode: false, modeOnAt: null, seen })).toEqual([]);
    expect(pendingCelebrations(g.milestones, { mode: true, modeOnAt: at(day, 15), seen })).toEqual(
      [],
    );
    // already shown on this device, or no baseline yet
    expect(
      pendingCelebrations(g.milestones, {
        mode: true,
        modeOnAt: null,
        seen: { ...seen, keys: all.map((m) => m.key) },
      }),
    ).toEqual([]);
    expect(pendingCelebrations(g.milestones, { mode: true, modeOnAt: null, seen: null })).toEqual(
      [],
    );
  });

  it('a goal un-met by an undo is not offered, and sorts by the crossing instant', () => {
    const log = { id: 'log-goal0001', reviewedAt: at(day, 13) };
    const base = [start(at(day, 0)), goal(10, at(day, 0, 1)), ...reviewsOn(day, [9])];
    const met = play([...base, reviewEvent(log)], at(day, 20));
    expect(met.milestones.map((m) => m.key)).toContain(goalKey);
    const unmet = play([...base, reviewEvent(log), reviewUndoFact(log)], at(day, 20));
    expect(unmet.milestones.map((m) => m.key)).not.toContain(goalKey);
    const times = met.milestones.map((m) => Date.parse(m.at));
    expect(times).toEqual([...times].sort((a, c) => a - c));
  });
});
