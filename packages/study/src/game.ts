import '@shared/zodConfig';
import { z } from 'zod';
import { SCHEMA_VERSION } from '@shared/constants';
import { Id, IsoDate } from '@shared/schema';
import type { Highlight } from '@shared/schema';
import type { Card, ReviewLog } from './schema';
import { DAY_MS, HOUR_MS, studyDayKey, studyDayNumber, tzOffsetMs, type DayBoundary } from './time';

/**
 * Game layer rules (ADR-022, UX_DESIGN.md section 11): the ledger row shapes, XP, levels, the
 * goal-based streak with freezes, badges and today's milestones. Pure: no clock, no I/O. Storage
 * (packages/storage/src/game.ts) reads the two ledger tables and hands the rows to `startFold` and
 * `deriveGame`; nothing derived here is ever stored.
 */

/** Changing a derivation rule bumps this, which re-runs the backfill (S/game.ts). */
export const GAME_RULES_VERSION = 1 as const;
export const XP = { review: 1, save: 2, card: 3, session: 5 } as const;
/** Casual, Regular, Serious, Intense. */
export const DAILY_GOALS = [10, 30, 50, 100] as const;
export const DailyGoal = z.union([z.literal(10), z.literal(30), z.literal(50), z.literal(100)]);
export type DailyGoal = z.infer<typeof DailyGoal>;
/** Until one is chosen (UX_DESIGN.md "Daily goal (existing users)"). Never written as a fact. */
export const DEFAULT_DAILY_GOAL: DailyGoal = 30;
export const FREEZE_EVERY = 7;
export const FREEZE_CAP = 2;
export const STREAK_MILESTONES = [7, 30, 100, 365] as const;
export type StreakMilestone = (typeof STREAK_MILESTONES)[number];
/** A save deleted this soon after it was made takes its XP back (the save toast's undo, or a quick delete). */
export const UNDO_SAVE_WINDOW_MS = 10 * 60_000;
/** Night owl hours, [23:00, 04:00) local time in the study zone. */
export const NIGHT_FROM_HOUR = 23;
export const NIGHT_TO_HOUR = 4;

export const GAME_EVENT_KINDS = [
  'review',
  'save',
  'card', // derivable: gameEvents (and purge copies in gameFacts)
  'review_undo',
  'save_undo',
  'card_undo', // cancellers; a merge restore writes them too (spec section 10)
  'session', // facts with a deterministic id
  'goal',
  'mode',
  'start', // facts with a uuid id
] as const;
export type GameEventKind = (typeof GAME_EVENT_KINDS)[number];
export const DERIVED_KINDS: ReadonlySet<GameEventKind> = new Set(['review', 'save', 'card']);
export const GAME_PREFIX = {
  review: 'rv',
  save: 'hs',
  card: 'cd',
  review_undo: 'ru',
  save_undo: 'hu',
  card_undo: 'cu',
  session: 'sb',
  goal: 'gs',
  mode: 'gm',
  start: 'gx',
} as const satisfies Record<GameEventKind, string>;

/** One ledger row. XP is never stored: it is `XP[kind]` under GAME_RULES_VERSION. */
export const GameRow = z
  .object({
    // prefix + Id (shared Id: 8-64 of [0-9A-Za-z_-]), so at most 67 characters
    id: z.string().regex(/^[a-z]{2}_[0-9A-Za-z_-]{8,64}$/),
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.enum(GAME_EVENT_KINDS),
    at: IsoDate,
    /** logId | highlightId | cardId | sessionId; null for goal, mode and start. */
    ref: Id.nullable(),
    /** goal: a DAILY_GOAL; mode: 0 | 1; otherwise null. */
    value: z.number().int().nullable(),
  })
  .superRefine((r, ctx) => {
    const p = GAME_PREFIX[r.kind];
    const own = r.kind === 'goal' || r.kind === 'mode' || r.kind === 'start';
    const ok = own
      ? r.ref === null &&
        r.id.startsWith(`${p}_`) &&
        (r.kind === 'goal'
          ? DailyGoal.safeParse(r.value).success
          : r.kind === 'mode'
            ? r.value === 0 || r.value === 1
            : r.value === null)
      : r.ref !== null && r.id === `${p}_${r.ref}` && r.value === null;
    if (!ok) ctx.addIssue({ code: 'custom', message: `invalid ${r.kind} game row` });
  });
export type GameRow = z.infer<typeof GameRow>;
/** Rows of `gameEvents`: derivable kinds only. */
export const GameEventRow = GameRow.refine(
  (r) => DERIVED_KINDS.has(r.kind),
  'not a derivable kind',
);
/** Rows of `gameFacts`: any kind (derivable kinds only as purge copies). */
export const GameFactRow = GameRow;

// ---------------------------------------------------------------------------------------------
// Derivation helpers: a ledger row is a pure function of its source row
// ---------------------------------------------------------------------------------------------

const row = (
  kind: GameEventKind,
  idPart: string,
  at: string,
  ref: string | null,
  value: number | null = null,
): GameRow => ({
  id: `${GAME_PREFIX[kind]}_${idPart}`,
  schemaVersion: SCHEMA_VERSION,
  kind,
  at,
  ref,
  value,
});

export const reviewEvent = (log: Pick<ReviewLog, 'id' | 'reviewedAt'>): GameRow =>
  row('review', log.id, log.reviewedAt, log.id);
/** Imports earn nothing (UX_DESIGN.md section 11). */
export const saveEvent = (
  h: Pick<Highlight, 'id' | 'createdAt' | 'captureMethod'>,
): GameRow | null => (h.captureMethod === 'import' ? null : row('save', h.id, h.createdAt, h.id));
export const cardEvent = (c: Pick<Card, 'id' | 'createdAt'>): GameRow =>
  row('card', c.id, c.createdAt, c.id);
/** Dated at the review, so the XP leaves the day it was earned. */
export const reviewUndoFact = (log: Pick<ReviewLog, 'id' | 'reviewedAt'>): GameRow =>
  row('review_undo', log.id, log.reviewedAt, log.id);
export const saveUndoFact = (h: Pick<Highlight, 'id' | 'createdAt'>): GameRow =>
  row('save_undo', h.id, h.createdAt, h.id);
/** No card is ever undone: only a merge restore writes this, for a merged card (S/game.ts). */
export const cardUndoFact = (c: Pick<Card, 'id' | 'createdAt'>): GameRow =>
  row('card_undo', c.id, c.createdAt, c.id);
/** What each canceller cancels: `ru_<x>` cancels `rv_<x>`, `hu_` cancels `hs_`, `cu_` cancels `cd_`. */
export const CANCELS = {
  review_undo: 'review',
  save_undo: 'save',
  card_undo: 'card',
} as const satisfies Partial<Record<GameEventKind, GameEventKind>>;
export const sessionFact = (sessionId: string, at: string): GameRow =>
  row('session', sessionId, at, sessionId);
/** `uuid` is passed in so this module stays pure. */
export const goalFact = (uuid: string, goal: DailyGoal, at: string): GameRow =>
  row('goal', uuid, at, null, goal);
export const modeFact = (uuid: string, on: boolean, at: string): GameRow =>
  row('mode', uuid, at, null, on ? 1 : 0);
export const startFact = (uuid: string, at: string): GameRow => row('start', uuid, at, null);

// ---------------------------------------------------------------------------------------------
// Levels: level L starts at 25·L·(L−1) XP, so each step needs 50 XP more than the one before
// ---------------------------------------------------------------------------------------------

export const xpForLevel = (level: number): number => 25 * level * (level - 1);

export function levelForXp(xp: number): number {
  const x = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  let l = Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * x) / 25)) / 2));
  while (xpForLevel(l + 1) <= x) l++; // integer correction against float error
  while (l > 1 && xpForLevel(l) > x) l--;
  return l;
}

// ---------------------------------------------------------------------------------------------
// Range fold: rows -> per-study-day totals
// ---------------------------------------------------------------------------------------------

export interface DayTotals {
  xp: number;
  reviews: number;
  saves: number;
  cards: number;
  sessions: number;
  night: number;
}
/** `[day, xp, reviews, saves, cards, sessions, night]`: the cached form of one day. */
export type DayTuple = [number, number, number, number, number, number, number];
export type DayMap = Map<number, DayTotals>;

const zero = (): DayTotals => ({ xp: 0, reviews: 0, saves: 0, cards: 0, sessions: 0, night: 0 });
type Counted = 'review' | 'save' | 'card' | 'session';
const COUNTER: Record<Counted, keyof DayTotals> = {
  review: 'reviews',
  save: 'saves',
  card: 'cards',
  session: 'sessions',
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Ledger order: by instant, then id (ISO strings of different precision compare by instant). */
export const byAtId = (a: GameRow, b: GameRow): number =>
  Date.parse(a.at) - Date.parse(b.at) || cmp(a.id, b.id);

/** Local hour (0-23) of an instant in a zone. */
export function localHour(ms: number, timeZone: string): number {
  const local = ms + tzOffsetMs(ms, timeZone);
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
}
const isNight = (ms: number, timeZone: string) => {
  const h = localHour(ms, timeZone);
  return h >= NIGHT_FROM_HOUR || h < NIGHT_TO_HOUR;
};

export interface FoldResult {
  days: DayMap;
  /** Counted rows dated today (day T) or later, in ledger order: milestones need their order. */
  ordered: GameRow[];
}

export interface Fold {
  /** One `gameEvents` row of the range (rows of other kinds are ignored). */
  add(event: GameRow): void;
  finish(): FoldResult;
}

/**
 * Fold the ledger rows whose `at` lies in one range. `facts` are the range's `gameFacts` rows; the
 * range's `gameEvents` rows are streamed in with `add`. A canceller and its target, and a purge copy
 * and its event, share an `at`, so any split into ranges keeps them together.
 *  - `ru_<log>` cancels `rv_<log>`, `hu_<h>` cancels `hs_<h>`, `cu_<card>` cancels `cd_<card>`; a
 *    canceller without a target counts 0;
 *  - a purge copy counts only when its event is not in `gameEvents` (same id: counted once);
 *  - sessions count; goal, mode and start rows are not XP.
 */
export function startFold(facts: readonly GameRow[], b: DayBoundary, T: number): Fold {
  const cancel = new Set<string>();
  const copies = new Map<string, GameRow>();
  const sessions: GameRow[] = [];
  for (const f of facts) {
    const target = (CANCELS as Partial<Record<GameEventKind, GameEventKind>>)[f.kind];
    if (target) cancel.add(`${GAME_PREFIX[target]}_${f.ref}`);
    else if (f.kind === 'session') sessions.push(f);
    else if (DERIVED_KINDS.has(f.kind)) copies.set(f.id, f);
  }
  const days: DayMap = new Map();
  const ordered: GameRow[] = [];
  const count = (r: GameRow) => {
    if (cancel.has(r.id)) return;
    const kind = r.kind as Counted;
    const ms = Date.parse(r.at);
    const d = studyDayNumber(ms, b);
    let day = days.get(d);
    if (!day) {
      day = zero();
      days.set(d, day);
    }
    day[COUNTER[kind]]++;
    day.xp += XP[kind];
    if (kind === 'review' && isNight(ms, b.timeZone)) day.night++;
    if (d >= T) ordered.push(r);
  };
  return {
    add(event) {
      if (!DERIVED_KINDS.has(event.kind)) return;
      copies.delete(event.id);
      count(event);
    },
    finish() {
      for (const c of copies.values()) count(c);
      for (const s of sessions) count(s);
      ordered.sort(byAtId);
      return { days, ordered };
    },
  };
}

export function foldRange(
  events: Iterable<GameRow>,
  facts: readonly GameRow[],
  b: DayBoundary,
  T: number,
): FoldResult {
  const fold = startFold(facts, b, T);
  for (const e of events) fold.add(e);
  return fold.finish();
}

/** Day-by-day sum of two folds (a closed-day prefix and the range after it). */
export function mergeDays(a: DayMap, b: DayMap): DayMap {
  const out: DayMap = new Map();
  for (const src of [a, b]) {
    for (const [d, t] of src) {
      const cur = out.get(d) ?? zero();
      out.set(d, {
        xp: cur.xp + t.xp,
        reviews: cur.reviews + t.reviews,
        saves: cur.saves + t.saves,
        cards: cur.cards + t.cards,
        sessions: cur.sessions + t.sessions,
        night: cur.night + t.night,
      });
    }
  }
  return out;
}

export const daysToTuples = (days: DayMap): DayTuple[] =>
  [...days]
    .sort(([a], [b]) => a - b)
    .map(([d, t]) => [d, t.xp, t.reviews, t.saves, t.cards, t.sessions, t.night]);

export const tuplesToDays = (tuples: readonly DayTuple[]): DayMap =>
  new Map(
    tuples.map(([d, xp, reviews, saves, cards, sessions, night]) => [
      d,
      { xp, reviews, saves, cards, sessions, night },
    ]),
  );

// ---------------------------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------------------------

type Metric = 'saves' | 'cards' | 'sessions' | 'reviews' | 'night' | 'xp' | 'streak' | 'goalDays';

export const BADGES = [
  { id: 'first_save', name: 'First save', metric: 'saves', target: 1 },
  { id: 'first_card', name: 'First card', metric: 'cards', target: 1 },
  { id: 'first_session', name: 'Session done', metric: 'sessions', target: 1 },
  // Owner default (spec section 17): 100 cards created, not 100 reviews.
  { id: 'cards_100', name: 'First 100 cards', metric: 'cards', target: 100 },
  { id: 'bank_builder', name: 'Bank builder', metric: 'saves', target: 100 },
  { id: 'reviews_1000', name: 'Thousand reviews', metric: 'reviews', target: 1000 },
  { id: 'streak_7', name: '7-day streak', metric: 'streak', target: 7 },
  { id: 'streak_30', name: '30-day streak', metric: 'streak', target: 30 },
  { id: 'goal_getter', name: 'Goal getter', metric: 'goalDays', target: 10 },
  { id: 'night_owl', name: 'Night owl', metric: 'night', target: 25 },
  { id: 'level_10', name: 'Level 10', metric: 'xp', target: xpForLevel(10) },
] as const satisfies readonly { id: string; name: string; metric: Metric; target: number }[];
export type BadgeId = (typeof BADGES)[number]['id'];

const COUNT_METRICS = ['saves', 'cards', 'sessions', 'reviews', 'night', 'xp'] as const;
type CountMetric = (typeof COUNT_METRICS)[number];
const isCountMetric = (m: Metric): m is CountMetric =>
  (COUNT_METRICS as readonly string[]).includes(m);

// ---------------------------------------------------------------------------------------------
// Celebrations (section 9 of the spec)
// ---------------------------------------------------------------------------------------------

export type Celebration = { key: string; /** ISO instant of the crossing row. */ at: string } & (
  | { kind: 'goal'; dayKey: string; goal: number; xp: number }
  | { kind: 'level'; level: number }
  | { kind: 'badge'; badgeId: BadgeId }
  | { kind: 'streak'; days: StreakMilestone }
);

/** Device-local record of the celebrations already shown (`meta['game.seen']`). */
export interface GameSeen {
  baselineAt: string;
  keys: string[];
}

// ---------------------------------------------------------------------------------------------
// Replay: goals, streak, freezes, badges and today's milestones
// ---------------------------------------------------------------------------------------------

export interface DeriveInput {
  /** Totals per study day: every closed day plus today and clock-ahead days. */
  days: DayMap;
  /** Counted rows dated today or later, in ledger order (from the fold of today's range). */
  ordered: readonly GameRow[];
  /** Every `goal` fact. */
  goals: readonly GameRow[];
  /** Every `start` fact: the earliest one is the game's epoch on this vault. */
  starts: readonly GameRow[];
  b: DayBoundary;
  /** Today's study day number. */
  T: number;
}

export interface GameDay {
  dayKey: string;
  xp: number;
  goal: number | null;
  met: boolean;
  frozen: boolean;
}

export interface DerivedGame {
  goal: { value: DailyGoal; chosen: boolean };
  today: {
    dayKey: string;
    xp: number;
    met: boolean;
    reviews: number;
    saves: number;
    cards: number;
    sessions: number;
  };
  totalXp: number;
  level: { level: number; floorXp: number; nextXp: number };
  streak: { current: number; longest: number; todayCounts: boolean; freezes: 0 | 1 | 2 };
  badges: { id: BadgeId; unlockedDayKey: string | null; value: number; target: number }[];
  /** The last 84 study days, oldest first (UX_DESIGN.md heatmap). */
  days: GameDay[];
  /** Every milestone dated today, sorted by `at` (eligibility is `pendingCelebrations`). */
  milestones: Celebration[];
}

export const HISTORY_DAYS = 84;

/** Pure replay of the ledger totals; see the spec sections 6.4-6.7. */
export function deriveGame(input: DeriveInput): DerivedGame {
  const { days, b, T } = input;
  const goals = [...input.goals].sort(byAtId).flatMap((g) => {
    const v = DailyGoal.safeParse(g.value);
    return v.success ? [{ day: studyDayNumber(Date.parse(g.at), b), value: v.data }] : [];
  });
  const startDays = input.starts.map((s) => studyDayNumber(Date.parse(s.at), b));
  // No start fact cannot happen once the backfill finished; judge from today if it ever does.
  const epoch = startDays.length > 0 ? Math.min(...startDays) : T;
  /** The goal a day is judged by: null before the epoch (any XP counts). A change applies the same day. */
  const goalFor = (d: number): DailyGoal | null => {
    if (d < epoch) return null;
    let value: DailyGoal = DEFAULT_DAILY_GOAL;
    for (const g of goals) {
      if (g.day > d) break;
      value = g.value;
    }
    return value;
  };
  const xpOn = (d: number) => days.get(d)?.xp ?? 0;
  const met = (d: number) => {
    const g = goalFor(d);
    return g === null ? xpOn(d) >= 1 : xpOn(d) >= g;
  };

  // ---- streak and freezes over the whole history
  let first: number | null = null;
  for (const [d, t] of days) if (d <= T && t.xp > 0 && (first === null || d < first)) first = d;
  let held = 0;
  let run = 0;
  let longest = 0;
  let goalDays = 0;
  let todayRun = 0;
  const frozen = new Set<number>();
  const reached: Partial<Record<'streak7' | 'streak30' | 'goalDays', number>> = {};
  if (first !== null) {
    for (let d = first; d <= T; d++) {
      if (met(d)) {
        run++;
        longest = Math.max(longest, run);
        if (goalFor(d) !== null && ++goalDays === 10) reached.goalDays ??= d;
        if (run % FREEZE_EVERY === 0 && held < FREEZE_CAP) held++; // earned at 7, 14, 21 ...
        if (run >= 7) reached.streak7 ??= d;
        if (run >= 30) reached.streak30 ??= d;
        if (d === T) todayRun = run;
      } else if (d === T) {
        break; // today stays open until it ends
      } else if (run > 0 && held > 0) {
        held--; // keeps the run, never lengthens it
        frozen.add(d);
      } else {
        run = 0;
      }
    }
  }
  const todayCounts = met(T);

  // ---- totals and count badges
  const sorted = [...days].sort(([a], [c]) => a - c);
  const totals = zero();
  for (const [, t] of sorted)
    for (const k of Object.keys(totals) as (keyof DayTotals)[]) totals[k] += t[k];
  const countUnlock = new Map<CountMetric, Map<number, number>>(); // metric -> target -> day
  const cum = zero();
  const targets = COUNT_METRICS.map(
    (m) => [m, BADGES.filter((x) => x.metric === m).map((x) => x.target as number)] as const,
  );
  for (const [d, t] of sorted) {
    if (d > T) break;
    for (const [m, list] of targets) {
      const before = cum[m];
      cum[m] += t[m];
      for (const target of list) {
        if (before < target && cum[m] >= target) {
          const per = countUnlock.get(m) ?? new Map<number, number>();
          if (!per.has(target)) per.set(target, d);
          countUnlock.set(m, per);
        }
      }
    }
  }
  const badges = BADGES.map((badge) => {
    const target: number = badge.target;
    const m: Metric = badge.metric;
    let value: number;
    let day: number | null;
    if (isCountMetric(m)) {
      value = totals[m];
      // Crossed only through clock-ahead rows: unlocked today.
      day = countUnlock.get(m)?.get(target) ?? (value >= target ? T : null);
    } else if (m === 'streak') {
      value = longest;
      day = (target === 7 ? reached.streak7 : reached.streak30) ?? null;
    } else {
      value = goalDays;
      day = reached.goalDays ?? null;
    }
    return { id: badge.id, unlockedDayKey: day === null ? null : studyDayKey(day), value, target };
  });

  // ---- today's milestones, on top of every other day (clock-ahead rows included)
  const todayTotals = days.get(T) ?? zero();
  const base = zero();
  for (const k of Object.keys(base) as (keyof DayTotals)[]) base[k] = totals[k] - todayTotals[k];
  const gT = goalFor(T);
  const threshold = gT ?? 1;
  const dayKey = studyDayKey(T);
  const milestones: Celebration[] = [];
  const running = zero();
  let crossedAt: string | null = null;
  for (const r of input.ordered) {
    const ms = Date.parse(r.at);
    if (studyDayNumber(ms, b) !== T) continue;
    const kind = r.kind as Counted;
    const before = { ...running };
    running[COUNTER[kind]]++;
    running.xp += XP[kind];
    if (kind === 'review' && isNight(ms, b.timeZone)) running.night++;
    if (crossedAt === null && running.xp >= threshold) crossedAt = r.at;
    const fromLevel = levelForXp(base.xp + before.xp);
    const toLevel = levelForXp(base.xp + running.xp);
    for (let l = Math.max(2, fromLevel + 1); l <= toLevel; l++) {
      milestones.push({ key: `level:${l}`, at: r.at, kind: 'level', level: l });
    }
    for (const badge of BADGES) {
      const m: Metric = badge.metric;
      if (!isCountMetric(m)) continue;
      if (base[m] + before[m] < badge.target && base[m] + running[m] >= badge.target) {
        milestones.push({ key: `badge:${badge.id}`, at: r.at, kind: 'badge', badgeId: badge.id });
      }
    }
  }
  if (gT !== null && crossedAt !== null && todayCounts) {
    milestones.push({
      key: `goal:${dayKey}`,
      at: crossedAt,
      kind: 'goal',
      dayKey,
      goal: gT,
      xp: todayTotals.xp,
    });
  }
  if (todayCounts && crossedAt !== null) {
    const streakBadges: [number | undefined, BadgeId, StreakMilestone][] = [
      [reached.streak7, 'streak_7', 7],
      [reached.streak30, 'streak_30', 30],
    ];
    const badgeToday = new Set<number>();
    for (const [day, id, n] of streakBadges) {
      if (day === T) {
        milestones.push({ key: `badge:${id}`, at: crossedAt, kind: 'badge', badgeId: id });
        badgeToday.add(n);
      }
    }
    if (reached.goalDays === T) {
      milestones.push({
        key: 'badge:goal_getter',
        at: crossedAt,
        kind: 'badge',
        badgeId: 'goal_getter',
      });
    }
    const n = STREAK_MILESTONES.find((x) => x === todayRun);
    if (n !== undefined && !badgeToday.has(n)) {
      milestones.push({ key: `streak:${n}:${dayKey}`, at: crossedAt, kind: 'streak', days: n });
    }
  }
  milestones.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || cmp(x.key, y.key));

  // ---- the heatmap window
  const history: GameDay[] = [];
  for (let d = T - HISTORY_DAYS + 1; d <= T; d++) {
    history.push({
      dayKey: studyDayKey(d),
      xp: xpOn(d),
      goal: goalFor(d),
      met: met(d),
      frozen: frozen.has(d),
    });
  }

  const level = levelForXp(totals.xp);
  const lastGoal = goals.filter((g) => g.day <= T).at(-1);
  return {
    goal: { value: gT ?? lastGoal?.value ?? DEFAULT_DAILY_GOAL, chosen: goals.length > 0 },
    today: {
      dayKey,
      xp: todayTotals.xp,
      met: todayCounts,
      reviews: todayTotals.reviews,
      saves: todayTotals.saves,
      cards: todayTotals.cards,
      sessions: todayTotals.sessions,
    },
    totalXp: totals.xp,
    level: { level, floorXp: xpForLevel(level), nextXp: xpForLevel(level + 1) },
    streak: {
      current: run, // today's run once today counts, else the run that today may extend
      longest,
      todayCounts,
      freezes: held as 0 | 1 | 2,
    },
    badges,
    days: history,
    milestones,
  };
}

/**
 * Which of today's milestones may still be celebrated on this device: Game mode on, at or after the
 * device baseline and after Game mode was last switched back on, and not already shown. Older
 * milestones are never celebrated (no backlog after a backfill, restore, late sync or mode switch).
 */
export function pendingCelebrations(
  milestones: readonly Celebration[],
  o: { mode: boolean; modeOnAt: string | null; seen: GameSeen | null },
): Celebration[] {
  if (!o.mode || o.seen === null) return [];
  const baseline = Date.parse(o.seen.baselineAt);
  const on = o.modeOnAt === null ? Number.NEGATIVE_INFINITY : Date.parse(o.modeOnAt);
  const shown = new Set(o.seen.keys);
  return milestones.filter((m) => {
    const t = Date.parse(m.at);
    return t >= baseline && t >= on && !shown.has(m.key);
  });
}
