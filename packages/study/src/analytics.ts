import { flattenSyllabus, type SyllabusNode } from '@shared/schema';
import type { Card, Deck, FsrsState, Rating, ReviewLog } from './schema';
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

// ---------------------------------------------------------------------------------------------
// Syllabus coverage by topic (ADR-020, part 2)
// ---------------------------------------------------------------------------------------------

export const COVERAGE_STATES = ['none', 'thin', 'covered'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/** What a topic needs before it counts as covered. Both are adjustable by the person. */
export interface CoverageThresholds {
  minHighlights: number;
  minCards: number;
}
export const DEFAULT_COVERAGE_THRESHOLDS: Readonly<CoverageThresholds> = {
  minHighlights: 3,
  minCards: 1,
};
export const MAX_COVERAGE_THRESHOLD = 999;
/** Mature reviews a topic needs before its retention is shown as a number. */
export const MIN_TOPIC_RETENTION_REVIEWS = 5;

/** A threshold is a whole number from 0 to 999; anything else falls back to the default. */
export function normalizeThresholds(input: unknown): CoverageThresholds {
  const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const pick = (value: unknown, fallback: number): number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_COVERAGE_THRESHOLD
      ? value
      : fallback;
  return {
    minHighlights: pick(r.minHighlights, DEFAULT_COVERAGE_THRESHOLDS.minHighlights),
    minCards: pick(r.minCards, DEFAULT_COVERAGE_THRESHOLDS.minCards),
  };
}

/** none: no highlight and no card; covered: both thresholds reached; thin: anything in between. */
export function coverageState(
  highlights: number,
  cards: number,
  thresholds: CoverageThresholds,
): CoverageState {
  if (highlights === 0 && cards === 0) return 'none';
  return highlights >= thresholds.minHighlights && cards >= thresholds.minCards
    ? 'covered'
    : 'thin';
}

/** One topic of a syllabus, flattened in pre-order (a parent comes before its children). */
export interface CoverageTopic {
  id: string;
  title: string;
  depth: number;
  parentId: string | null;
  /** > 0; absent means an equal share among its siblings. */
  weight?: number;
  bankIds: readonly string[];
  tagIds: readonly string[];
}

export interface CoverageHighlight {
  id: string;
  deletedAt: string | null;
  /** Live banks the highlight is filed in. */
  bankIds: readonly string[];
  tagIds: readonly string[];
}

export interface CoverageCard {
  id: string;
  deletedAt: string | null;
  suspended: boolean;
  fsrs: Pick<FsrsState, 'state' | 'due' | 'lastReview'>;
  /** The card's deck's bank and the banks its highlight is filed in. */
  bankIds: readonly string[];
  /** The card's own tags and its highlight's, as tag ids. */
  tagIds: readonly string[];
}

export interface TopicCoverage {
  id: string;
  title: string;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  /** As set by the person; 1 when not set. */
  weight: number;
  /** This topic's part of the whole syllabus (0..1); the parts of the top-level topics add up to 1. */
  share: number;
  /** The topic itself points at a bank or a tag. */
  mapped: boolean;
  /** The topic or one of its subtopics points at a bank or a tag. */
  subtreeMapped: boolean;
  /** Live highlights under the topic and its subtopics, each counted once. */
  highlights: number;
  /** Active (not suspended, not deleted) cards, each counted once. */
  cards: number;
  /** Of those, review cards due by the end of today and learning steps due now. */
  due: number;
  /** Retention of mature reviews; `value` stays null below the minimum number of reviews. */
  retention: { value: number | null; reviews: number };
  lastStudiedAt: string | null;
  state: CoverageState;
  /** 'own': judged by the thresholds. 'subtopics': judged from the subtopics, by weight. */
  scoredFrom: 'own' | 'subtopics';
  /** Weighted share of this topic that is covered (0..1). */
  covered: number;
  /** Weighted share with at least some material (thin or covered). */
  started: number;
}

export interface SyllabusCoverage {
  status: 'ok' | 'empty';
  thresholds: CoverageThresholds;
  topics: TopicCoverage[];
  /** Weighted share of the syllabus that is covered (0..1); null without topics. */
  covered: number | null;
  /** Weighted share with at least some material. */
  started: number | null;
  /** Topics that nothing is mapped to, themselves or through a subtopic. */
  unmapped: number;
}

/** A stored outline as the flat, pre-order topic list that coverage and exam scopes read. */
export function coverageTopics(nodes: readonly SyllabusNode[]): CoverageTopic[] {
  return flattenSyllabus(nodes).map(({ node, depth, parentId }) => ({
    id: node.id,
    title: node.title,
    depth,
    parentId,
    ...(node.weight === undefined ? {} : { weight: node.weight }),
    bankIds: node.bankIds,
    tagIds: node.tagIds,
  }));
}

/**
 * The shape of a syllabus as coverage and exams read it: the tree (a parent must come before its
 * child; anything else is treated as a root), what each topic points at, each topic's weight among
 * its siblings and its part of the whole syllabus, and which topics an item with given banks and
 * tags belongs to. Pure. `syllabusTopicCoverage` and the exam scope both use it, so "belongs to a
 * topic" has exactly one definition (ADR-020).
 */
export interface SyllabusTopicIndex {
  /** Index of the parent topic, or -1 for a top-level topic. */
  parent: number[];
  children: number[][];
  roots: number[];
  /** The topic itself points at a bank or a tag. */
  ownMapped: boolean[];
  /** Some topic below it points at a bank or a tag. */
  descendantMapped: boolean[];
  /** It or some topic below it points at a bank or a tag. */
  subtreeMapped: boolean[];
  /** As set; 1 when absent or not a positive number. */
  weight: number[];
  /** Weight relative to its siblings (they add up to 1). */
  rel: number[];
  /** Part of the whole syllabus (0..1); the top-level topics add up to 1. */
  share: number[];
  /** The topics an item belongs to: those it matches and all their ancestors, each once. */
  topicsOf(bankIds: readonly string[], tagIds: readonly string[]): Set<number>;
}

export function syllabusTopicIndex(topics: readonly CoverageTopic[]): SyllabusTopicIndex {
  const n = topics.length;
  // Tree shape. A parent must come before its child; anything else is treated as a root.
  const index = new Map<string, number>();
  topics.forEach((t, i) => {
    if (!index.has(t.id)) index.set(t.id, i);
  });
  const parent = topics.map((t, i) => {
    const p = t.parentId === null ? -1 : (index.get(t.parentId) ?? -1);
    return p < i ? p : -1;
  });
  const children: number[][] = topics.map(() => []);
  const roots: number[] = [];
  parent.forEach((p, i) => (p < 0 ? roots : (children[p] as number[])).push(i));

  const byBank = new Map<string, number[]>();
  const byTag = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string, i: number) => {
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  };
  const ownMapped = topics.map((t, i) => {
    for (const id of t.bankIds) add(byBank, id, i);
    for (const id of t.tagIds) add(byTag, id, i);
    return t.bankIds.length > 0 || t.tagIds.length > 0;
  });

  const topicsOf = (bankIds: readonly string[], tagIds: readonly string[]): Set<number> => {
    const hit = new Set<number>();
    // An ancestor that is already in the set brought its own ancestors with it.
    const climb = (from: number) => {
      for (let at = from; at >= 0 && !hit.has(at); at = parent[at] as number) hit.add(at);
    };
    for (const id of bankIds) for (const i of byBank.get(id) ?? []) climb(i);
    for (const id of tagIds) for (const i of byTag.get(id) ?? []) climb(i);
    return hit;
  };

  // Shares: weights are relative among siblings.
  const weight = topics.map((t) =>
    typeof t.weight === 'number' && Number.isFinite(t.weight) && t.weight > 0 ? t.weight : 1,
  );
  const rel = new Array<number>(n).fill(0);
  const normalise = (list: readonly number[]) => {
    const total = list.reduce((sum, i) => sum + (weight[i] as number), 0);
    for (const i of list) rel[i] = (weight[i] as number) / total;
  };
  normalise(roots);
  for (const list of children) if (list.length > 0) normalise(list);
  const share = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const p = parent[i] as number;
    share[i] = (p < 0 ? 1 : (share[p] as number)) * (rel[i] as number);
  }

  // Which topics have anything mapped at or below them.
  const descendantMapped = new Array<boolean>(n).fill(false);
  const subtreeMapped = new Array<boolean>(n).fill(false);
  for (let i = n - 1; i >= 0; i -= 1) {
    subtreeMapped[i] = (ownMapped[i] as boolean) || (descendantMapped[i] as boolean);
    const p = parent[i] as number;
    if (p >= 0 && subtreeMapped[i]) descendantMapped[p] = true;
  }

  return {
    parent,
    children,
    roots,
    ownMapped,
    descendantMapped,
    subtreeMapped,
    weight,
    rel,
    share,
    topicsOf,
  };
}

/**
 * Coverage of a custom syllabus by what the person actually holds. A highlight or a card belongs to
 * a topic when one of its banks or tags is one the topic (or a subtopic) points at, and is counted
 * once however many mappings match. Deleted highlights, deleted and suspended cards count nowhere.
 *
 * Judging: a topic without subtopics, or whose subtopics point at nothing, is judged by the
 * thresholds. A topic with mapped subtopics is judged from them: its covered share is the weighted
 * share of its subtopics that are covered (weights are relative among siblings; absent = 1).
 * Everything is derived from the arguments: the clock arrives as `opts.now`.
 */
export function syllabusTopicCoverage(
  topics: readonly CoverageTopic[],
  facts: {
    highlights: readonly CoverageHighlight[];
    cards: readonly CoverageCard[];
    logs: readonly LogLite[];
  },
  opts: {
    now: DateInput;
    boundary: DayBoundary;
    thresholds?: Partial<CoverageThresholds>;
    minRetentionReviews?: number;
  },
): SyllabusCoverage {
  const thresholds = normalizeThresholds(opts.thresholds);
  const minReviews = opts.minRetentionReviews ?? MIN_TOPIC_RETENTION_REVIEWS;
  const n = topics.length;
  if (n === 0) {
    return { status: 'empty', thresholds, topics: [], covered: null, started: null, unmapped: 0 };
  }

  // Tree shape, mapping, weights and membership: one definition, shared with the exam scope.
  const {
    children,
    roots,
    ownMapped,
    descendantMapped,
    subtreeMapped,
    weight,
    rel,
    share,
    topicsOf,
  } = syllabusTopicIndex(topics);

  // Highlights.
  const highlights = new Array<number>(n).fill(0);
  const seenHighlights = new Set<string>();
  for (const h of facts.highlights) {
    if (h.deletedAt !== null || seenHighlights.has(h.id)) continue;
    seenHighlights.add(h.id);
    for (const i of topicsOf(h.bankIds, h.tagIds)) (highlights[i] as number) += 1;
  }

  // Cards: count, due, last studied, and the ids (for retention).
  const nowMs = toMs(opts.now);
  const dayEnd = studyDayStartMs(studyDayNumber(nowMs, opts.boundary) + 1, opts.boundary);
  const cardIds: string[][] = topics.map(() => []);
  const due = new Array<number>(n).fill(0);
  const lastMs = new Array<number>(n).fill(-Infinity);
  const lastIso = new Array<string | null>(n).fill(null);
  const seenCards = new Set<string>();
  for (const c of facts.cards) {
    if (c.deletedAt !== null || c.suspended || seenCards.has(c.id)) continue;
    seenCards.add(c.id);
    const dueMs = Date.parse(c.fsrs.due);
    const isDue =
      c.fsrs.state === 'review' ? dueMs < dayEnd : c.fsrs.state !== 'new' && dueMs <= nowMs;
    const last = c.fsrs.lastReview === null ? Number.NaN : Date.parse(c.fsrs.lastReview);
    for (const i of topicsOf(c.bankIds, c.tagIds)) {
      (cardIds[i] as string[]).push(c.id);
      if (isDue) (due[i] as number) += 1;
      if (last > (lastMs[i] as number)) {
        lastMs[i] = last;
        lastIso[i] = c.fsrs.lastReview;
      }
    }
  }

  // Retention of mature reviews, per topic, from the logs of its cards.
  const logsByCard = new Map<string, LogLite[]>();
  for (const l of facts.logs) {
    if (!counted(l)) continue;
    const list = logsByCard.get(l.cardId);
    if (list) list.push(l);
    else logsByCard.set(l.cardId, [l]);
  }

  // Judging, bottom-up.
  const state = new Array<CoverageState>(n).fill('none');
  const covered = new Array<number>(n).fill(0);
  const started = new Array<number>(n).fill(0);
  const scoredFrom = new Array<'own' | 'subtopics'>(n).fill('own');
  for (let i = n - 1; i >= 0; i -= 1) {
    const kids = children[i] as number[];
    if (kids.length === 0 || !descendantMapped[i]) {
      const s = coverageState(highlights[i] as number, (cardIds[i] as string[]).length, thresholds);
      state[i] = s;
      covered[i] = s === 'covered' ? 1 : 0;
      started[i] = s === 'none' ? 0 : 1;
      continue;
    }
    let c = 0;
    let s = 0;
    for (const k of kids) {
      c += (rel[k] as number) * (covered[k] as number);
      s += (rel[k] as number) * (started[k] as number);
    }
    scoredFrom[i] = 'subtopics';
    covered[i] = c;
    started[i] = s;
    state[i] = c >= 1 - 1e-9 ? 'covered' : s <= 1e-9 ? 'none' : 'thin';
  }

  const rows: TopicCoverage[] = topics.map((t, i) => {
    const ids = cardIds[i] as string[];
    const pooled: LogLite[] = [];
    for (const id of ids) {
      const list = logsByCard.get(id);
      if (list) for (const l of list) pooled.push(l);
    }
    const retention = trueRetention(pooled, { minSamples: minReviews });
    return {
      id: t.id,
      title: t.title,
      depth: t.depth,
      parentId: t.parentId,
      hasChildren: (children[i] as number[]).length > 0,
      weight: weight[i] as number,
      share: share[i] as number,
      mapped: ownMapped[i] as boolean,
      subtreeMapped: subtreeMapped[i] as boolean,
      highlights: highlights[i] as number,
      cards: ids.length,
      due: due[i] as number,
      retention: { value: retention.trueRetention, reviews: retention.matureReviews },
      lastStudiedAt: lastIso[i] as string | null,
      state: state[i] as CoverageState,
      scoredFrom: scoredFrom[i] as 'own' | 'subtopics',
      covered: covered[i] as number,
      started: started[i] as number,
    };
  });

  let overallCovered = 0;
  let overallStarted = 0;
  for (const r of roots) {
    overallCovered += (rel[r] as number) * (covered[r] as number);
    overallStarted += (rel[r] as number) * (started[r] as number);
  }
  return {
    status: 'ok',
    thresholds,
    topics: rows,
    covered: overallCovered,
    started: overallStarted,
    unmapped: subtreeMapped.filter((m) => !m).length,
  };
}
