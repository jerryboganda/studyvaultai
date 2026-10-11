import type { Card, Deck, Rating, ReviewLog } from './schema';
import { retrievability } from './scheduler';
import { MINUTE_MS, studyDayKey, studyDayNumber, studyDayStartMs, toMs } from './time';
import type { DateInput, DayBoundary } from './time';

/**
 * Review analytics computed from plain arrays of cards and review logs. Nothing is invented: a
 * number that cannot be derived from the data is `null` (or the report says `insufficient_data`).
 * Corrected (undone) logs are ignored everywhere.
 */

type CardLite = Pick<Card, 'id' | 'deckId' | 'deletedAt' | 'suspended' | 'fsrs'>;
type LogLite = Pick<
  ReviewLog,
  'cardId' | 'reviewedAt' | 'rating' | 'durationMs' | 'previousState' | 'userCorrection'
>;

const active = (c: CardLite): boolean => !c.deletedAt && !c.suspended;
const counted = (l: LogLite): boolean => !l.userCorrection;

/** Index of the last element of `sorted` that is <= value, or -1. */
function floorIndex(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) <= value) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function dayStarts(now: DateInput, boundary: DayBoundary, from: number, to: number): number[] {
  const today = studyDayNumber(toMs(now), boundary);
  const out: number[] = [];
  for (let k = from; k <= to; k += 1) out.push(studyDayStartMs(today + k, boundary));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Forecast and backlog
// ---------------------------------------------------------------------------------------------

export interface ForecastDay {
  /** 0 = today. */
  dayOffset: number;
  dayKey: string;
  /** Cards that come due that study day (reviews + learning steps). */
  due: number;
  review: number;
  learning: number;
}

export interface DueForecast {
  /** Review/learning cards already past their study day: they are due today as well. */
  overdue: number;
  days: ForecastDay[];
  /** Scheduled further out than the window. */
  beyond: number;
  /** New cards that could be introduced now (not postponed). */
  newAvailable: number;
  totalCards: number;
}

/** How many cards come due on each of the next `days` study days (default 30). */
export function dueForecast(
  cards: readonly CardLite[],
  now: DateInput,
  boundary: DayBoundary,
  days = 30,
): DueForecast {
  const nowMs = toMs(now);
  const today = studyDayNumber(nowMs, boundary);
  const starts = dayStarts(now, boundary, 0, days);
  const rows: ForecastDay[] = Array.from({ length: days }, (_, k) => ({
    dayOffset: k,
    dayKey: studyDayKey(today + k),
    due: 0,
    review: 0,
    learning: 0,
  }));
  let overdue = 0;
  let beyond = 0;
  let newAvailable = 0;
  let totalCards = 0;
  for (const c of cards) {
    if (!active(c)) continue;
    totalCards += 1;
    const dueMs = Date.parse(c.fsrs.due);
    if (c.fsrs.state === 'new') {
      if (dueMs <= nowMs) newAvailable += 1;
      continue;
    }
    if (dueMs < (starts[0] as number)) {
      overdue += 1;
    } else if (dueMs >= (starts[days] as number)) {
      beyond += 1;
    } else {
      const row = rows[floorIndex(starts, dueMs)] as ForecastDay;
      row.due += 1;
      if (c.fsrs.state === 'review') row.review += 1;
      else row.learning += 1;
    }
  }
  return { overdue, days: rows, beyond, newAvailable, totalCards };
}

export interface BacklogStats {
  /** Review cards due on an earlier study day. */
  overdue: number;
  /** Review cards due today (not yet overdue). */
  dueToday: number;
  /** Learning/relearning steps due right now. */
  learningDue: number;
  oldestOverdueDays: number | null;
  medianOverdueDays: number | null;
  overdueByDeck: Record<string, number>;
}

export function backlog(
  cards: readonly CardLite[],
  now: DateInput,
  boundary: DayBoundary,
): BacklogStats {
  const nowMs = toMs(now);
  const today = studyDayNumber(nowMs, boundary);
  const dayStart = studyDayStartMs(today, boundary);
  const dayEnd = studyDayStartMs(today + 1, boundary);
  const lateDays: number[] = [];
  const overdueByDeck: Record<string, number> = {};
  let dueToday = 0;
  let learningDue = 0;
  for (const c of cards) {
    if (!active(c)) continue;
    const dueMs = Date.parse(c.fsrs.due);
    if (c.fsrs.state === 'review') {
      if (dueMs < dayStart) {
        lateDays.push(today - studyDayNumber(dueMs, boundary));
        overdueByDeck[c.deckId] = (overdueByDeck[c.deckId] ?? 0) + 1;
      } else if (dueMs < dayEnd) {
        dueToday += 1;
      }
    } else if (c.fsrs.state !== 'new' && dueMs <= nowMs) {
      learningDue += 1;
    }
  }
  lateDays.sort((a, b) => a - b);
  const mid = lateDays.length >> 1;
  const median =
    lateDays.length === 0
      ? null
      : lateDays.length % 2
        ? (lateDays[mid] as number)
        : ((lateDays[mid - 1] as number) + (lateDays[mid] as number)) / 2;
  return {
    overdue: lateDays.length,
    dueToday,
    learningDue,
    oldestOverdueDays: lateDays.length ? (lateDays[lateDays.length - 1] as number) : null,
    medianOverdueDays: median,
    overdueByDeck,
  };
}

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

export interface RetentionReport {
  status: 'ok' | 'insufficient_data';
  minSamples: number;
  totalReviews: number;
  /** Reviews of graduated (review-state) cards: the ones that measure retention. */
  matureReviews: number;
  /** Mature reviews answered Hard/Good/Easy. */
  recalled: number;
  /** recalled / matureReviews, or null while matureReviews < minSamples. */
  trueRetention: number | null;
  /** Share of each answer among mature reviews; null per rating while there are no mature reviews. */
  byRating: Record<Rating, { count: number; share: number | null }>;
}

/** Measured ("true") retention from review logs: Again = forgotten, anything else = recalled. */
export function trueRetention(
  logs: readonly LogLite[],
  opts: { minSamples?: number; sinceMs?: number } = {},
): RetentionReport {
  const minSamples = opts.minSamples ?? 20;
  const counts: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let total = 0;
  let mature = 0;
  for (const l of logs) {
    if (!counted(l)) continue;
    if (opts.sinceMs !== undefined && Date.parse(l.reviewedAt) < opts.sinceMs) continue;
    total += 1;
    if (l.previousState.state !== 'review') continue;
    mature += 1;
    counts[l.rating] += 1;
  }
  const recalled = mature - counts[1];
  const share = (n: number): number | null => (mature === 0 ? null : n / mature);
  return {
    status: mature >= minSamples ? 'ok' : 'insufficient_data',
    minSamples,
    totalReviews: total,
    matureReviews: mature,
    recalled,
    trueRetention: mature >= minSamples ? recalled / mature : null,
    byRating: {
      1: { count: counts[1], share: share(counts[1]) },
      2: { count: counts[2], share: share(counts[2]) },
      3: { count: counts[3], share: share(counts[3]) },
      4: { count: counts[4], share: share(counts[4]) },
    },
  };
}

/** Mean predicted recall of graduated cards right now (FSRS default weights): an estimate. */
export function estimatedRetention(
  cards: readonly CardLite[],
  now: DateInput,
): { value: number | null; cards: number } {
  const nowMs = toMs(now);
  let sum = 0;
  let n = 0;
  for (const c of cards) {
    const r = c.fsrs.state === 'review' && active(c) ? retrievability(c, nowMs) : null;
    if (r === null) continue;
    sum += r;
    n += 1;
  }
  return { value: n === 0 ? null : sum / n, cards: n };
}

// ---------------------------------------------------------------------------------------------
// Counts by deck / bank
// ---------------------------------------------------------------------------------------------

export interface CardCounts {
  total: number;
  new: number;
  learning: number;
  review: number;
  relearning: number;
  suspended: number;
  /** Review/learning cards due now or earlier today (before caps). */
  due: number;
  /** Review cards due on an earlier study day. */
  overdue: number;
}

const emptyCounts = (): CardCounts => ({
  total: 0,
  new: 0,
  learning: 0,
  review: 0,
  relearning: 0,
  suspended: 0,
  due: 0,
  overdue: 0,
});

export interface DeckCounts extends CardCounts {
  deckId: string;
  bankId: string | null;
  name: string;
}

export interface BankCounts extends CardCounts {
  bankId: string | null;
  decks: number;
}

export function countsByDeck(
  cards: readonly CardLite[],
  decks: readonly Pick<Deck, 'id' | 'bankId' | 'name' | 'deletedAt'>[],
  now: DateInput,
  boundary: DayBoundary,
): { decks: DeckCounts[]; orphanCards: number } {
  const nowMs = toMs(now);
  const today = studyDayNumber(nowMs, boundary);
  const dayStart = studyDayStartMs(today, boundary);
  const dayEnd = studyDayStartMs(today + 1, boundary);
  const rows = new Map<string, DeckCounts>();
  for (const d of decks) {
    if (!d.deletedAt) {
      rows.set(d.id, { ...emptyCounts(), deckId: d.id, bankId: d.bankId, name: d.name });
    }
  }
  let orphanCards = 0;
  for (const c of cards) {
    if (c.deletedAt) continue;
    const row = rows.get(c.deckId);
    if (!row) {
      orphanCards += 1;
      continue;
    }
    row.total += 1;
    if (c.suspended) {
      row.suspended += 1;
      continue;
    }
    const s = c.fsrs;
    row[s.state] += 1;
    const dueMs = Date.parse(s.due);
    if (s.state === 'review') {
      if (dueMs < dayEnd) row.due += 1;
      if (dueMs < dayStart) row.overdue += 1;
    } else if (s.state !== 'new' && dueMs <= nowMs) {
      row.due += 1;
    }
  }
  return {
    decks: [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    orphanCards,
  };
}

export function countsByBank(deckCounts: readonly DeckCounts[]): BankCounts[] {
  const banks = new Map<string | null, BankCounts>();
  for (const d of deckCounts) {
    const row = banks.get(d.bankId) ?? { ...emptyCounts(), bankId: d.bankId, decks: 0 };
    row.decks += 1;
    for (const key of Object.keys(emptyCounts()) as (keyof CardCounts)[]) row[key] += d[key];
    banks.set(d.bankId, row);
  }
  return [...banks.values()];
}

// ---------------------------------------------------------------------------------------------
// Study log and streak
// ---------------------------------------------------------------------------------------------

export interface StudyDay {
  dayKey: string;
  reviews: number;
  /** Cards seen for the first time that day. */
  newCards: number;
  /** Sum of answer times, each capped at `maxCountedMs`. */
  durationMs: number;
  /** Answers other than Again. */
  passed: number;
  /** passed / reviews, or null on days without reviews. */
  accuracy: number | null;
}

/** One row per study day for the last `days` days (oldest first), zeros included. */
export function studyLog(
  logs: readonly LogLite[],
  now: DateInput,
  boundary: DayBoundary,
  opts: { days?: number; maxCountedMs?: number } = {},
): StudyDay[] {
  const days = opts.days ?? 30;
  const cap = opts.maxCountedMs ?? 5 * MINUTE_MS;
  const today = studyDayNumber(toMs(now), boundary);
  const starts = dayStarts(now, boundary, -(days - 1), 1);
  const rows: StudyDay[] = Array.from({ length: days }, (_, i) => ({
    dayKey: studyDayKey(today - (days - 1) + i),
    reviews: 0,
    newCards: 0,
    durationMs: 0,
    passed: 0,
    accuracy: null,
  }));
  for (const l of logs) {
    if (!counted(l)) continue;
    const at = Date.parse(l.reviewedAt);
    if (at < (starts[0] as number) || at >= (starts[days] as number)) continue;
    const row = rows[floorIndex(starts, at)] as StudyDay;
    row.reviews += 1;
    if (l.previousState.state === 'new') row.newCards += 1;
    row.durationMs += Math.min(cap, l.durationMs);
    if (l.rating > 1) row.passed += 1;
  }
  for (const r of rows) r.accuracy = r.reviews === 0 ? null : r.passed / r.reviews;
  return rows;
}

export interface StreakReport {
  /** Consecutive study days ending today, or ending yesterday while today is still open. */
  current: number;
  longest: number;
  studiedToday: boolean;
  lastStudyDayKey: string | null;
}

export function streak(
  logs: readonly LogLite[],
  now: DateInput,
  boundary: DayBoundary,
): StreakReport {
  const today = studyDayNumber(toMs(now), boundary);
  const days = new Set<number>();
  for (const l of logs) {
    if (!counted(l)) continue;
    const d = studyDayNumber(Date.parse(l.reviewedAt), boundary);
    if (d <= today) days.add(d); // a device clock that ran ahead must not invent days
  }
  if (days.size === 0)
    return { current: 0, longest: 0, studiedToday: false, lastStudyDayKey: null };
  const sorted = [...days].sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    run = (sorted[i] as number) - (sorted[i - 1] as number) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const studiedToday = days.has(today);
  let cursor = studiedToday ? today : today - 1;
  let current = 0;
  while (days.has(cursor)) {
    current += 1;
    cursor -= 1;
  }
  return {
    current,
    longest,
    studiedToday,
    lastStudyDayKey: studyDayKey(sorted[sorted.length - 1] as number),
  };
}

// ---------------------------------------------------------------------------------------------
// Syllabus coverage
// ---------------------------------------------------------------------------------------------

export type NodeCoverage = 'uncovered' | 'new' | 'learning' | 'learned';

export interface CoverageReport {
  status: 'ok' | 'no_syllabus';
  total: number;
  /** Nodes with at least one active card. */
  covered: number;
  /** Nodes whose active cards are all graduated. */
  learned: number;
  ratio: number | null;
  learnedRatio: number | null;
  nodes: { nodeId: string; cards: number; status: NodeCoverage }[];
}

/**
 * Coverage of a syllabus by cards. `links` says which cards belong to which syllabus node (the vault
 * derives it from topic/folder membership). Suspended and deleted cards do not cover anything.
 */
export function syllabusCoverage(
  nodeIds: readonly string[],
  links: readonly { nodeId: string; cardId: string }[],
  cards: readonly CardLite[],
): CoverageReport {
  const unique = [...new Set(nodeIds)];
  if (unique.length === 0) {
    return {
      status: 'no_syllabus',
      total: 0,
      covered: 0,
      learned: 0,
      ratio: null,
      learnedRatio: null,
      nodes: [],
    };
  }
  const byId = new Map(cards.filter(active).map((c) => [c.id, c]));
  const perNode = new Map<string, Set<string>>();
  for (const l of links) {
    if (!byId.has(l.cardId)) continue;
    const set = perNode.get(l.nodeId) ?? new Set<string>();
    set.add(l.cardId);
    perNode.set(l.nodeId, set);
  }
  let covered = 0;
  let learned = 0;
  const nodes = unique.map((nodeId) => {
    const ids = perNode.get(nodeId);
    const states = ids ? [...ids].map((id) => (byId.get(id) as CardLite).fsrs.state) : [];
    let status: NodeCoverage = 'uncovered';
    if (states.length > 0) {
      covered += 1;
      if (states.every((s) => s === 'review')) {
        status = 'learned';
        learned += 1;
      } else {
        status = states.every((s) => s === 'new') ? 'new' : 'learning';
      }
    }
    return { nodeId, cards: states.length, status };
  });
  return {
    status: 'ok',
    total: unique.length,
    covered,
    learned,
    ratio: covered / unique.length,
    learnedRatio: learned / unique.length,
    nodes,
  };
}
