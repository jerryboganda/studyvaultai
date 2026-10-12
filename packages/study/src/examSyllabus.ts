import { syllabusTopicIndex, type CoverageTopic } from './analytics';
import type { ExamCardFacts } from './exam';
import { hashSeed, seededRandom, shuffled } from './random';

/**
 * An exam drawn from a custom syllabus (ADR-020, part 2). Pure: no clock, no storage, no React.
 *
 * Membership is not decided here. A card belongs to a topic exactly when `syllabusTopicIndex`
 * (the helper `syllabusTopicCoverage` uses for the coverage table) says its banks and tags reach the
 * topic or one of its subtopics, so the card counts in the exam setup are the numbers the coverage
 * table shows.
 *
 * Vocabulary: a *unit* is a topic coverage judges by its own cards (no subtopics, or none of its
 * subtopics points at anything). A weighted exam shares its questions between units. A card that
 * belongs to several units is counted under ONE of them (the one with the fewest cards so far,
 * decided deterministically from the seed), so the questions of an exam add up per topic.
 */

/** Banks and tags a card is in, as ids: what `loadSyllabusCoverageData` reads for coverage. */
export interface ExamCardRefs {
  bankIds: readonly string[];
  tagIds: readonly string[];
}

export interface ExamSyllabusInput {
  /** The outline, flattened in pre-order (`coverageTopics`). */
  topics: readonly CoverageTopic[];
  /** Card id -> its banks and tags. A card without an entry belongs to no topic. */
  refs: ReadonlyMap<string, ExamCardRefs>;
}

const byId = (a: ExamCardFacts, b: ExamCardFacts): number =>
  a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;

/**
 * How many of `cards` belong to the syllabus, and to each topic (a topic counts its subtopics, each
 * card once). `cards` are the cards that may be asked (live, not suspended).
 */
export function syllabusExamCounts(
  input: ExamSyllabusInput,
  cards: readonly ExamCardFacts[],
): { total: number; byTopic: ReadonlyMap<string, number> } {
  const index = syllabusTopicIndex(input.topics);
  const counts = new Array<number>(input.topics.length).fill(0);
  const seen = new Set<string>();
  let total = 0;
  for (const c of cards) {
    const refs = input.refs.get(c.cardId);
    if (refs === undefined || seen.has(c.cardId)) continue;
    seen.add(c.cardId);
    const hit = index.topicsOf(refs.bankIds, refs.tagIds);
    if (hit.size === 0) continue;
    total += 1;
    for (const i of hit) (counts[i] as number) += 1;
  }
  return { total, byTopic: new Map(input.topics.map((t, i) => [t.id, counts[i] as number])) };
}

export type SkipReason =
  /** No card is in the topic. */
  | 'nocards'
  /** Every card it holds is also in another topic and is counted there. */
  | 'shared'
  /** It has cards but the weights gave it less than one question. */
  | 'noshare';

/** Why a topic got no question, as the setup and the results say it. */
export const SKIP_REASON_TEXT: Readonly<Record<SkipReason, string>> = {
  nocards: 'no cards',
  shared: 'every card it holds is also in another topic',
  noshare: 'too few questions for its weight',
};

export interface SyllabusUnit {
  id: string;
  title: string;
  depth: number;
  /** Its part of the exam by weight among the units that have cards (they add up to 1). */
  share: number;
  /** Cards it has to draw from (a card is counted under one unit). */
  available: number;
  /** Cards in the scope that reach this unit, whichever unit they are counted under. */
  reaching: number;
}

export interface SyllabusExamPool {
  weighted: boolean;
  seed: number;
  /** Cards of the chosen topic or syllabus, each once. */
  inScope: number;
  /** Cards a draw can use: all of them, or in a weighted exam those some unit holds. */
  drawable: number;
  /** The lowest-level topics inside the scope, in outline order. */
  units: readonly SyllabusUnit[];
  /** In-scope cards by card id, each with the topic it counts under. */
  cards: readonly { facts: ExamCardFacts; topicId: string; unit: boolean }[];
  /** Topic titles by id, for what the exam keeps. */
  titles: ReadonlyMap<string, string>;
}

/**
 * The cards an exam over a topic (its whole subtree) or the whole syllabus (`topicId` null) can ask.
 * Throws RangeError when the topic is not in the syllabus.
 */
export function syllabusExamPool(input: {
  syllabus: ExamSyllabusInput;
  topicId: string | null;
  weighted: boolean;
  /** The cards that may be asked (live, not suspended). */
  cards: readonly ExamCardFacts[];
  seed: number;
}): SyllabusExamPool {
  const { topics, refs } = input.syllabus;
  const index = syllabusTopicIndex(topics);
  const n = topics.length;
  const root = input.topicId === null ? -1 : topics.findIndex((t) => t.id === input.topicId);
  if (input.topicId !== null && root < 0) {
    throw new RangeError('That topic is not in this syllabus any more.');
  }

  // The scope: the topic and everything below it (parents come before children).
  const inside = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    const p = index.parent[i] as number;
    inside[i] = root < 0 || i === root || (p >= 0 && inside[p] === true);
  }
  const isUnit = topics.map(
    (_, i) =>
      inside[i] === true &&
      ((index.children[i] as number[]).length === 0 || index.descendantMapped[i] === false),
  );

  // Candidates: the topics each reaches inside the scope; ancestors are in the set already.
  const seen = new Set<string>();
  const candidates: { facts: ExamCardFacts; all: number[]; units: number[] }[] = [];
  for (const facts of input.cards) {
    const r = refs.get(facts.cardId);
    if (r === undefined || seen.has(facts.cardId)) continue;
    seen.add(facts.cardId);
    const hit = index.topicsOf(r.bankIds, r.tagIds);
    if (root >= 0 ? !hit.has(root) : hit.size === 0) continue;
    const all = [...hit].filter((i) => inside[i] === true).sort((a, b) => a - b);
    candidates.push({ facts, all, units: all.filter((i) => isUnit[i] === true) });
  }
  candidates.sort((a, b) => byId(a.facts, b.facts));

  // A card in several units is counted under one: the least loaded, scarcest cards first.
  const key = (id: string): number => (hashSeed(id) ^ input.seed) >>> 0;
  const load = new Map<number, number>();
  const reaching = new Map<number, number>();
  const home = new Map<string, number>();
  const withUnit = candidates
    .filter((c) => c.units.length > 0)
    .sort(
      (a, b) =>
        a.units.length - b.units.length ||
        key(a.facts.cardId) - key(b.facts.cardId) ||
        byId(a.facts, b.facts),
    );
  for (const c of withUnit) {
    let best = c.units[0] as number;
    for (const u of c.units) {
      reaching.set(u, (reaching.get(u) ?? 0) + 1);
      if ((load.get(u) ?? 0) < (load.get(best) ?? 0)) best = u;
    }
    load.set(best, (load.get(best) ?? 0) + 1);
    home.set(c.facts.cardId, best);
  }
  // A card only a parent's own mapping reaches counts under the deepest topic it reaches.
  for (const c of candidates) {
    if (c.units.length > 0) continue;
    let best = c.all[0] as number;
    for (const i of c.all)
      if ((topics[i] as CoverageTopic).depth > (topics[best] as CoverageTopic).depth) best = i;
    home.set(c.facts.cardId, best);
  }

  const unitIndexes = topics.flatMap((_, i) => (isUnit[i] === true ? [i] : []));
  const withCards = unitIndexes.filter((i) => (load.get(i) ?? 0) > 0);
  const shareSum = withCards.reduce((sum, i) => sum + (index.share[i] as number), 0);
  const units: SyllabusUnit[] = unitIndexes.map((i) => {
    const available = load.get(i) ?? 0;
    const t = topics[i] as CoverageTopic;
    return {
      id: t.id,
      title: t.title,
      depth: t.depth,
      share: available > 0 && shareSum > 0 ? (index.share[i] as number) / shareSum : 0,
      available,
      reaching: reaching.get(i) ?? 0,
    };
  });
  const cards = candidates.map((c) => {
    const at = home.get(c.facts.cardId) as number;
    return { facts: c.facts, topicId: (topics[at] as CoverageTopic).id, unit: c.units.length > 0 };
  });
  return {
    weighted: input.weighted,
    seed: input.seed,
    inScope: candidates.length,
    drawable: input.weighted ? withUnit.length : candidates.length,
    units,
    cards,
    titles: new Map(topics.map((t) => [t.id, t.title])),
  };
}

export interface SyllabusExamDraw {
  /** The cards asked in drawing order, each with the topic it was drawn for. */
  picked: { facts: ExamCardFacts; topicId: string }[];
  /** One row per lowest-level topic of the scope, in outline order. */
  rows: {
    topicId: string;
    title: string;
    depth: number;
    share: number;
    available: number;
    asked: number;
  }[];
  /** Topics that got no question, and why (said on screen, never hidden). */
  skipped: { topicId: string; title: string; reason: SkipReason }[];
}

/**
 * Split `total` between items in proportion to `weight` (largest remainder, ties to the earlier
 * item), never giving an item more than its `cap`; what a capped item cannot take is shared by the
 * others in the same proportion. The result adds up to `min(total, sum of caps)`.
 */
export function allocateByWeight(
  items: readonly { weight: number; cap: number }[],
  total: number,
): number[] {
  const out = items.map(() => 0);
  let active = items.flatMap((it, i) => (it.cap > 0 && it.weight > 0 ? [i] : []));
  let left = Math.max(
    0,
    Math.min(
      Math.floor(total),
      active.reduce((sum, i) => sum + (items[i] as { cap: number }).cap, 0),
    ),
  );
  while (left > 0 && active.length > 0) {
    const sum = active.reduce((s, i) => s + (items[i] as { weight: number }).weight, 0);
    const ideal = active.map((i) => (left * (items[i] as { weight: number }).weight) / sum);
    const give = ideal.map((x) => Math.floor(x));
    let rest = left - give.reduce((s, g) => s + g, 0);
    const order = active
      .map((_, k) => k)
      .sort((a, b) => {
        const d =
          (ideal[b] as number) - (give[b] as number) - ((ideal[a] as number) - (give[a] as number));
        return Math.abs(d) > 1e-9 ? d : a - b;
      });
    for (const k of order) {
      if (rest <= 0) break;
      give[k] = (give[k] as number) + 1;
      rest -= 1;
    }
    const over = active.filter(
      (i, k) => (give[k] as number) > (items[i] as { cap: number }).cap - (out[i] as number),
    );
    if (over.length === 0) {
      active.forEach((i, k) => (out[i] = (out[i] as number) + (give[k] as number)));
      break;
    }
    for (const i of over) {
      const cap = (items[i] as { cap: number }).cap;
      left -= cap - (out[i] as number);
      out[i] = cap;
    }
    active = active.filter((i) => !over.includes(i));
  }
  return out;
}

/** Draw `count` questions (capped by the pool): shared by weight between units, or at random. */
export function drawSyllabusExam(pool: SyllabusExamPool, count: number): SyllabusExamDraw {
  const want = Math.max(0, Math.min(Math.floor(count), pool.drawable));
  const asked = new Map<string, number>();
  let chosen: { facts: ExamCardFacts; topicId: string }[];
  if (pool.weighted) {
    const mine = new Map<string, { facts: ExamCardFacts; topicId: string }[]>();
    for (const c of pool.cards) {
      if (!c.unit) continue;
      const list = mine.get(c.topicId);
      if (list) list.push(c);
      else mine.set(c.topicId, [c]);
    }
    const open = pool.units.filter((u) => u.available > 0);
    const quota = allocateByWeight(
      open.map((u) => ({ weight: u.share, cap: u.available })),
      want,
    );
    chosen = [];
    open.forEach((u, k) => {
      const rnd = seededRandom((hashSeed(u.id) ^ pool.seed) >>> 0);
      const take = shuffled(mine.get(u.id) ?? [], rnd).slice(0, quota[k] ?? 0);
      chosen.push(...take);
    });
    // Grouped by topic so far; the exam's own order comes from the seed like every other exam's.
    chosen = shuffled(
      chosen.sort((a, b) => byId(a.facts, b.facts)),
      seededRandom(pool.seed),
    );
  } else {
    chosen = shuffled(pool.cards, seededRandom(pool.seed)).slice(0, want);
  }
  for (const c of chosen) asked.set(c.topicId, (asked.get(c.topicId) ?? 0) + 1);

  const rows = pool.units.map((u) => ({
    topicId: u.id,
    title: u.title,
    depth: u.depth,
    share: u.share,
    available: u.available,
    asked: asked.get(u.id) ?? 0,
  }));
  const skipped = pool.units.flatMap((u): SyllabusExamDraw['skipped'] => {
    const reason: SkipReason | null =
      u.available > 0
        ? pool.weighted && (asked.get(u.id) ?? 0) === 0
          ? 'noshare'
          : null
        : u.reaching > 0
          ? 'shared'
          : 'nocards';
    return reason === null ? [] : [{ topicId: u.id, title: u.title, reason }];
  });
  return {
    picked: chosen.map((c) => ({ facts: c.facts, topicId: c.topicId })),
    rows,
    skipped,
  };
}

/** "Syllabus: Cardiorenal exam / Renal (weighted by topic)", at most 300 characters (the stored limit). */
export function syllabusScopeLabel(
  syllabusName: string,
  topicTitle: string | null,
  weighted: boolean,
): string {
  const label = `Syllabus: ${syllabusName}${topicTitle === null ? '' : ` / ${topicTitle}`}${
    weighted ? ' (weighted by topic)' : ''
  }`;
  return label.length <= 300 ? label : `${label.slice(0, 299)}…`;
}
