import type { AnchorSet, HtmlAnchorSet } from '@shared';
import { TEXT_ALGORITHM } from '@shared/constants';
import { bestApproxSubstring, boundedEditDistance, similarity, type ApproxMatch } from './fuzzy';
import { streamRangeToDomRange, streamTextOfRange } from './textStream';
import type { Resolution, ResolutionMethod, ResolutionStatus, TextStream } from './types';

// ADR-004 "Resolution order" constants.
/**
 * Every exact occurrence is scored up to this many (a few ms). A quote with more copies than this
 * (a one-word quote) is resolved from evidence-chosen candidates, see selectCandidates().
 */
const MAX_OCCURRENCES = 5000;
/** Copies kept on each side of the stored position when the list is truncated (nearest first). */
const NEAREST_PER_SIDE = 100;
/** Copies kept at each end of the document (a stored context cut by the document edge). */
const EDGE_HITS = 8;
/** Stored context characters glued to the quote to find the copies that still carry the context. */
const CONTEXT_NEEDLE_CHARS = 16;
const SHORT_QUOTE_CHARS = 24;
const CONTEXT_WEIGHT = 0.8;
/** A document boundary next to the quote counts like this many matched context characters. */
const BOUNDARY_WEIGHT = 32;
const POSITION_WEIGHT = 0.2;
const LEAD = 0.15;
const FUZZY_MIN_SIMILARITY = 0.85;
/** Proximity falls linearly to 0 at this distance (stream chars) from the stored position. */
const POSITION_SCALE = 2000;
/**
 * Safety tightening of ADR-004 step 4: the winner's context agreement must beat the runner-up's by
 * at least this much. Position alone never separates candidates whose context ties, because an
 * insertion above the quote shifts every copy and the nearest stale offset is then the wrong copy.
 * (Position still decides when the whole stream is byte-identical to the one that was captured.)
 */
const CONTEXT_SEPARATION = 0.1;

/** Total DP cells one fuzzy search may spend (about 30-60 ms worst case in V8). */
const FUZZY_CELL_BUDGET = 8_000_000;
const ANCHOR_CHARS = 16;
const MIN_ANCHOR_CHARS = 8;
const MAX_ANCHOR_HITS = 4;

/**
 * Figure guard. A fuzzy match that differs from the quote ONLY in numbers or negation words is a
 * different statement ("Step 3" vs "Step 4", "5 mg" vs "6 mg", "is" vs "is not"), not an edit of this
 * one. Below this quote length such a match is never bound. Longer quotes are whole sentences where
 * a corrected figure is far more likely an edit than a sibling.
 */
const FIGURE_GUARD_MAX_CHARS = 120;
/**
 * Two ranges are "the same text" when their intersection covers at least this share of their union.
 * High on purpose: a highlight nested in another (a word inside its sentence) must not collide.
 */
const CLAIM_OVERLAP = 0.8;
/** How often one fuzzy search may cut a rejected match out of its window and look again. */
const MAX_WINDOW_RETRIES = 8;

/** Head/tail anchoring of a long quote that something was inserted into (an ad label, a link block). */
const SPLIT_MIN_QUOTE_CHARS = 64;
const SPLIT_ANCHOR_CHARS = 24;
/** Characters that may sit between the verbatim head and tail beyond the quote's own length. */
const SPLIT_GAP_CHARS = 300;
const SPLIT_MAX_HEADS = 16;

interface Occurrences {
  at: number[];
  /** More than MAX_OCCURRENCES exist; `at` is a selection of them, not all of them. */
  truncated: boolean;
  /** Truncated and an unseen copy that carries the full stored context cannot be ruled out. */
  blind?: boolean;
  /** Truncated: the most context agreement (0..1) a copy that is not in `at` can have. */
  unseen?: number;
}

/** Stream ranges and quote texts that other saved highlights own (see resolveMany). */
interface Claims {
  ranges: Array<readonly [number, number]>;
  texts: Set<string>;
}

/** Stream offsets of a painted-capable resolution, for the cross-entry checks in resolveMany. */
const spans = new WeakMap<Resolution, readonly [number, number]>();

function orphaned(candidateCount = 0): Resolution {
  return { status: 'orphaned', confidence: 0, range: null, method: 'none', candidateCount };
}

function ambiguous(confidence: number, candidateCount: number): Resolution {
  return { status: 'ambiguous', confidence, range: null, method: 'none', candidateCount };
}

/** Occurrences of `needle` in document order; overlapping ones count ("aa" in "aaa"). */
function scanOccurrences(text: string, needle: string): Occurrences {
  const at: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    if (at.length === MAX_OCCURRENCES) return { at, truncated: true };
    at.push(i);
  }
  return { at, truncated: false };
}

/**
 * The copies to score. With at most MAX_OCCURRENCES copies that is all of them. Otherwise the list
 * in document order is only a prefix, so a candidate set is built from evidence instead: copies
 * next to the stored position (nearest first), copies at both ends of the document, and every copy
 * that carries a stretch of the stored context (indexOf on the context-extended quote, linear). Any
 * copy left out agrees on fewer than CONTEXT_NEEDLE_CHARS characters on each side, which bounds
 * its context agreement (`unseen`); if even that scan overflowed nothing can be promised and the
 * caller must not rank (`blind`).
 */
function selectCandidates(text: string, anchor: HtmlAnchorSet, scanned: Occurrences): Occurrences {
  if (!scanned.truncated) return scanned;
  const { exact, prefix, suffix } = anchor.textQuote;
  const stored = anchor.textPosition.start;
  const picked = new Set<number>();

  // Copies within reach of a document edge also score the boundary bonus: keep the first and last few.
  for (let k = 0; k < scanned.at.length && k < NEAREST_PER_SIDE; k++) {
    const at = scanned.at[k]!;
    if (k >= EDGE_HITS && at > prefix.length) break;
    picked.add(at);
  }
  let n = 0;
  for (let i = text.lastIndexOf(exact); i !== -1 && n < NEAREST_PER_SIDE; n++) {
    if (n >= EDGE_HITS && i + exact.length + suffix.length < text.length - 1) break;
    picked.add(i);
    i = i > 0 ? text.lastIndexOf(exact, i - 1) : -1;
  }
  // The stored position's neighbourhood: the nearest copies on each side.
  n = 0;
  for (let i = text.indexOf(exact, stored); i !== -1 && n < NEAREST_PER_SIDE; n++) {
    picked.add(i);
    i = text.indexOf(exact, i + 1);
  }
  n = 0;
  for (
    let i = stored > 0 ? text.lastIndexOf(exact, stored - 1) : -1;
    i !== -1 && n < NEAREST_PER_SIDE;
    n++
  ) {
    picked.add(i);
    i = i > 0 ? text.lastIndexOf(exact, i - 1) : -1;
  }

  let blind = false;
  const before = prefix.slice(-CONTEXT_NEEDLE_CHARS);
  if (before) {
    const hits = scanOccurrences(text, before + exact);
    for (const at of hits.at) picked.add(at + before.length);
    blind ||= hits.truncated;
  }
  const after = suffix.slice(0, CONTEXT_NEEDLE_CHARS);
  if (after) {
    const hits = scanOccurrences(text, exact + after);
    for (const at of hits.at) picked.add(at);
    blind ||= hits.truncated;
  }
  // An unlisted copy matches fewer than CONTEXT_NEEDLE_CHARS characters on each side.
  const sides = prefix.length + suffix.length;
  const unseen =
    sides === 0
      ? 1
      : (Math.max(0, Math.min(CONTEXT_NEEDLE_CHARS, prefix.length) - 1) +
          Math.max(0, Math.min(CONTEXT_NEEDLE_CHARS, suffix.length) - 1)) /
        sides;
  return { at: [...picked].sort((a, b) => a - b), truncated: true, blind, unseen };
}

/** Characters of `prefix`, counted from its end, that equal the text right before `at`. */
function matchedBefore(text: string, at: number, prefix: string): number {
  const n = Math.min(prefix.length, at);
  let k = 0;
  while (k < n && text.charCodeAt(at - 1 - k) === prefix.charCodeAt(prefix.length - 1 - k)) k++;
  return k;
}

/** Characters of `suffix`, counted from its start, that equal the text starting at `end`. */
function matchedAfter(text: string, end: number, suffix: string): number {
  const n = Math.min(suffix.length, text.length - end);
  let k = 0;
  while (k < n && text.charCodeAt(end + k) === suffix.charCodeAt(k)) k++;
  return k;
}

interface Candidate {
  start: number;
  /** Fraction of the stored context (prefix + suffix, boundaries included) that agrees, 0..1. */
  context: number;
  score: number;
  prefixDisagrees: boolean;
  suffixDisagrees: boolean;
}

function scoreCandidate(text: string, anchor: HtmlAnchorSet, at: number): Candidate {
  const { exact, prefix, suffix } = anchor.textQuote;
  const end = at + exact.length;
  const prefixMatched = matchedBefore(text, at, prefix);
  const suffixMatched = matchedAfter(text, end, suffix);

  // When the stored window was cut by the document start/end, that boundary is part of the
  // context: a copy elsewhere with the same words next to it is not the same place.
  const prefixBoundary = anchor.textPosition.start === prefix.length ? BOUNDARY_WEIGHT : 0;
  const suffixBoundary =
    anchor.documentTextLength - anchor.textPosition.end === suffix.length ? BOUNDARY_WEIGHT : 0;
  const prefixScore = prefixMatched + (prefixBoundary && at <= prefix.length ? prefixBoundary : 0);
  // A single trailing space (newline before </body>) is layout noise, not content.
  const textEnd = text.endsWith(' ') ? text.length - 1 : text.length;
  const suffixScore =
    suffixMatched + (suffixBoundary && end + suffix.length >= textEnd ? suffixBoundary : 0);
  const prefixTotal = prefix.length + prefixBoundary;
  const suffixTotal = suffix.length + suffixBoundary;

  const context =
    prefixTotal + suffixTotal === 0 ? 1 : (prefixScore + suffixScore) / (prefixTotal + suffixTotal);
  const proximity = Math.max(0, 1 - Math.abs(at - anchor.textPosition.start) / POSITION_SCALE);
  // A side "agrees" on its characters; a boundary alone only counts for a side that stored none.
  const prefixAgrees = prefix.length > 0 ? prefixMatched / prefix.length >= 0.5 : at <= 0;
  const suffixAgrees = suffix.length > 0 ? suffixMatched / suffix.length >= 0.5 : end >= textEnd;
  return {
    start: at,
    context,
    score: CONTEXT_WEIGHT * context + POSITION_WEIGHT * proximity,
    prefixDisagrees: !prefixAgrees,
    suffixDisagrees: !suffixAgrees,
  };
}

/** Nothing but the quote text itself supports this candidate. */
function isUnsupported(c: Candidate, stored: number): boolean {
  return c.prefixDisagrees && c.suffixDisagrees && c.start !== stored;
}

/** Builds the DOM range and verifies it against the live DOM; a mismatch is never painted. */
function finish(
  stream: TextStream,
  start: number,
  end: number,
  status: ResolutionStatus,
  confidence: number,
  method: ResolutionMethod,
  candidateCount: number,
): Resolution {
  const range = streamRangeToDomRange(stream, start, end);
  if (!range || streamTextOfRange(range) !== stream.text.slice(start, end)) {
    return orphaned(candidateCount);
  }
  const resolution: Resolution = { status, confidence, range, method, candidateCount };
  spans.set(resolution, [start, end]);
  return resolution;
}

// ---------------------------------------------------------------------------------------------
// Fuzzy ("changed") path
// ---------------------------------------------------------------------------------------------

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

function findAll(text: string, needle: string, limit: number): number[] {
  const hits: number[] = [];
  for (
    let i = text.indexOf(needle);
    i !== -1 && hits.length < limit;
    i = text.indexOf(needle, i + 1)
  ) {
    hits.push(i);
  }
  return hits;
}

// Figures = numbers (digits of any script, with decimal/thousand separators) and English negation
// words. Other languages' negations are not recognised (documented limitation, errs towards binding).
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
const NEGATION = /\b(?:not|no|never|none|neither|nor|without|cannot)\b|n['\u2019]t\b/gi;

function withoutFigures(s: string): string {
  return s.replace(NUMBER, '').replace(NEGATION, '').replace(/\s+/g, ' ').trim();
}

/** True when the two texts are the same apart from numbers and negation words. */
function differsOnlyByFigures(a: string, b: string): boolean {
  return a !== b && withoutFigures(a) === withoutFigures(b);
}

/**
 * A fuzzy match is "claimed" when it is the text another saved highlight owns: the same text as
 * that highlight's quote, or substantially the same range (intersection over union). A highlight
 * nested inside the match, or one that merely overlaps its edge, does not claim it.
 */
function isClaimed(claims: Claims, text: string, start: number, end: number): boolean {
  if (claims.texts.has(text.slice(start, end))) return true;
  for (const [s, e] of claims.ranges) {
    const overlap = Math.min(e, end) - Math.max(s, start);
    if (overlap > 0 && overlap / (Math.max(e, end) - Math.min(s, start)) >= CLAIM_OVERLAP) {
      return true;
    }
  }
  return false;
}

interface FuzzyMatch extends ApproxMatch {
  sim: number;
}

interface FuzzyResult {
  matches: FuzzyMatch[];
  /** Best similarity among matches rejected by the figure guard (0 when none). */
  guardedSim: number;
}

/**
 * Locations near the old offset or next to the moved context whose text is >= 0.85 similar to the
 * quote, best first. Cost is bounded by a shared DP cell budget (see fuzzy.ts).
 *
 * Matches that another highlight owns (`claims`) and, for short quotes, matches that differ only
 * by figures (`figureGuard`) are never returned. The window they were found in is searched again
 * with them cut out, so the highlight's own edited text is still found next to a look-alike sibling.
 */
function fuzzyMatches(
  anchor: HtmlAnchorSet,
  text: string,
  claims?: Claims,
  figureGuard = false,
): FuzzyResult {
  const { exact, prefix, suffix } = anchor.textQuote;
  const length = exact.length;
  const maxDist = Math.floor((1 - FUZZY_MIN_SIMILARITY) * length + 1e-9);
  if (maxDist < 1) return { matches: [], guardedSim: 0 }; // too short to tolerate one edit at 0.85

  // Where the quote can be: around its old offset, or next to wherever its context moved.
  const slack = maxDist + 8;
  const windows: Array<[number, number]> = [
    [anchor.textPosition.start - slack, anchor.textPosition.end + slack],
  ];
  const prefixAnchor = prefix.slice(-ANCHOR_CHARS);
  if (prefixAnchor.length >= MIN_ANCHOR_CHARS) {
    for (const hit of findAll(text, prefixAnchor, MAX_ANCHOR_HITS)) {
      const s = hit + prefixAnchor.length;
      windows.push([s - slack, s + length + maxDist + slack]);
    }
  }
  const suffixAnchor = suffix.slice(0, ANCHOR_CHARS);
  if (suffixAnchor.length >= MIN_ANCHOR_CHARS) {
    for (const hit of findAll(text, suffixAnchor, MAX_ANCHOR_HITS)) {
      windows.push([hit - length - maxDist - slack, hit + slack]);
    }
  }

  const guard = figureGuard && length < FIGURE_GUARD_MAX_CHARS;
  const budget = { cells: FUZZY_CELL_BUDGET };
  const found: FuzzyMatch[] = [];
  const seen = new Set<string>();
  let guardedSim = 0;
  let retries = MAX_WINDOW_RETRIES;
  // `windows` grows while it is walked: a rejected match adds the two pieces around it.
  for (let w = 0; w < windows.length; w++) {
    const [from, to] = windows[w]!;
    const key = `${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const match = bestApproxSubstring(exact, text, from, to, maxDist, budget);
    if (!match) {
      if (budget.cells < 0) break;
      continue;
    }
    // Trim collapsed spaces the alignment may have included and never split a surrogate pair.
    let { start, end } = match;
    while (start < end && text.charCodeAt(start) === 32) start++;
    while (end > start && text.charCodeAt(end - 1) === 32) end--;
    if (start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start--;
    if (end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end++;
    if (end <= start) continue;
    // The alignment bound used the pattern length; the final gate uses the real normalised score.
    const sim = similarity(exact, text.slice(start, end), FUZZY_MIN_SIMILARITY);
    if (sim < FUZZY_MIN_SIMILARITY - 1e-12) continue;

    const claimed = claims !== undefined && isClaimed(claims, text, start, end);
    const figures = !claimed && guard && differsOnlyByFigures(exact, text.slice(start, end));
    if (claimed || figures) {
      if (figures) guardedSim = Math.max(guardedSim, sim);
      if (retries-- > 0) windows.push([from, match.start], [match.end, to]);
      continue;
    }
    const distance = Math.round((1 - sim) * Math.max(length, end - start));
    found.push({ start, end, distance, sim });
  }
  const origin = anchor.textPosition.start;
  found.sort(
    (a, b) => a.distance - b.distance || Math.abs(a.start - origin) - Math.abs(b.start - origin),
  );
  return { matches: found, guardedSim };
}

/**
 * Head/tail anchoring for a long quote that is not on the page contiguously any more because
 * something was inserted between its blocks (an ad label, a related-links box) while both halves
 * stayed verbatim. The first and last SPLIT_ANCHOR_CHARS must each be found verbatim, as exactly one
 * (head, tail) pair no further apart than the quote's length plus SPLIT_GAP_CHARS; two pairs are
 * ambiguous and nothing is painted. The spanned text must then be the quote plus its inserted
 * surplus: the edit distance, after forgiving the extra length, may not exceed 15% of the quote
 * (the same 0.85 gate as the contiguous case).
 */
function headTailResolve(
  anchor: HtmlAnchorSet,
  stream: TextStream,
  claims?: Claims,
): Resolution | null {
  const { exact } = anchor.textQuote;
  const length = exact.length;
  if (length < SPLIT_MIN_QUOTE_CHARS) return null;
  const { text } = stream;
  const head = exact.slice(0, SPLIT_ANCHOR_CHARS);
  const tail = exact.slice(-SPLIT_ANCHOR_CHARS);
  const maxDist = Math.floor((1 - FUZZY_MIN_SIMILARITY) * length + 1e-9);

  const heads = findAll(text, head, SPLIT_MAX_HEADS + 1);
  if (heads.length === 0 || heads.length > SPLIT_MAX_HEADS) return null;
  let found: readonly [number, number] | null = null;
  for (const h of heads) {
    // The tail starts after the head and the whole span is neither much shorter nor much longer
    // than the quote. Searching a bounded slice keeps the work proportional to the gap.
    const base = Math.max(h + SPLIT_ANCHOR_CHARS, h + length - maxDist - SPLIT_ANCHOR_CHARS);
    const win = text.slice(base, h + length + SPLIT_GAP_CHARS);
    for (let k = win.indexOf(tail); k !== -1; k = win.indexOf(tail, k + 1)) {
      if (found) return ambiguous(0, 0);
      found = [h, base + k + SPLIT_ANCHOR_CHARS];
    }
  }
  if (!found) return null;

  const [start, end] = found;
  const span = text.slice(start, end);
  const surplus = Math.max(0, span.length - length);
  const dist = boundedEditDistance(exact, span, surplus + maxDist);
  if (dist > surplus + maxDist) return null;
  if (claims && isClaimed(claims, text, start, end)) return null;
  // Never 1: that is reserved for the quote itself being there.
  const confidence = Math.min(0.99, 1 - Math.max(0, dist - surplus) / length);
  return finish(stream, start, end, 'changed', confidence, 'fuzzy', 0);
}

function fuzzyResolve(anchor: HtmlAnchorSet, stream: TextStream, claims?: Claims): Resolution {
  const { matches, guardedSim } = fuzzyMatches(anchor, stream.text, claims, true);
  const best = matches[0];
  if (!best) {
    const split = headTailResolve(anchor, stream, claims);
    if (split) return split;
    // Only a look-alike that differs by a figure exists: not this statement, but not provably gone.
    return guardedSim > 0 ? ambiguous(guardedSim, 0) : orphaned();
  }
  // A different location that fits almost as well means we cannot tell which one the user saw.
  const margin = Math.max(1, Math.floor(0.05 * anchor.textQuote.exact.length));
  const rival = matches.find(
    (m) =>
      m !== best &&
      (m.end <= best.start || m.start >= best.end) &&
      m.distance - best.distance <= margin,
  );
  if (rival) return ambiguous(best.sim, 0);
  return finish(stream, best.start, best.end, 'changed', best.sim, 'fuzzy', 0);
}

/**
 * True when an exact copy that nothing else supports (both contexts and the position disagree) has
 * a near-identical neighbour at the old place: the original was edited in place while a verbatim copy
 * (an abstract repeating body text, a quoted block) survives elsewhere. Snapping to the copy would
 * be a silent wrong answer. (No figure guard here: a corrected number IS an edited original.)
 */
function editedOriginalSurvives(anchor: HtmlAnchorSet, text: string, start: number): boolean {
  const end = start + anchor.textQuote.exact.length;
  return fuzzyMatches(anchor, text).matches.some((m) => m.end <= start || m.start >= end);
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Per-call memo: what is shared between anchors resolved against the same stream. */
interface Shared {
  occurrences: Map<string, Occurrences>;
  signature?: string;
}

/**
 * Everything but the fuzzy fallback. Returns null when the quote is not on the page verbatim and
 * the fuzzy path has to decide (done separately so resolveMany can run it with the other entries'
 * exact results known).
 */
function resolveExact(
  anchor: HtmlAnchorSet,
  stream: TextStream,
  shared: Shared,
): Resolution | null {
  // 1. A different text algorithm needs a migration, not a guess.
  if ((anchor as { type?: string }).type !== 'html') return orphaned();
  if (anchor.textAlgorithm !== TEXT_ALGORITHM) return orphaned();
  const { exact } = anchor.textQuote;
  if (exact.length === 0) return orphaned();

  const { text } = stream;
  const stored = anchor.textPosition.start;

  // 2. Exact occurrences; the scan is shared across anchors with the same quote.
  let scanned = shared.occurrences.get(exact);
  if (!scanned) {
    scanned = scanOccurrences(text, exact);
    shared.occurrences.set(exact, scanned);
  }
  // 5. Nothing exact: fuzzy, or orphaned.
  if (scanned.at.length === 0) return null;
  const occ = selectCandidates(text, anchor, scanned);
  const count = occ.at.length;

  // The page text is byte-identical to the capture-time stream: the stored offset is authoritative,
  // even when identical copies of the quote have identical context.
  if (
    anchor.documentTextLength === text.length &&
    text.startsWith(exact, stored) &&
    anchor.contentSignature === (shared.signature ??= stream.signature)
  ) {
    return finish(
      stream,
      stored,
      stored + exact.length,
      'resolved',
      1,
      count === 1 ? 'quote' : 'position',
      count,
    );
  }
  // More copies than can be listed and the ones left out may carry the whole context.
  if (occ.blind) return ambiguous(0, count);

  // 3. One occurrence.
  if (count === 1) {
    const only = scoreCandidate(text, anchor, occ.at[0]!);
    if (isUnsupported(only, stored)) {
      // Short quotes recur ("Figure 1"): a lone hit whose neighbourhood and position both changed
      // could be a different sentence entirely (ADR-004 step 3).
      if (exact.length < SHORT_QUOTE_CHARS) return ambiguous(only.score, 1);
      if (editedOriginalSurvives(anchor, text, only.start)) return ambiguous(only.score, 1);
    }
    return finish(
      stream,
      only.start,
      only.start + exact.length,
      'resolved',
      0.9 + 0.1 * only.context,
      'quote',
      1,
    );
  }

  // 4. Several occurrences: context agreement (0.8) + position proximity (0.2).
  // One pass keeps the best two (score, then nearer to the stored offset, then document order).
  const scored = occ.at.map((at) => scoreCandidate(text, anchor, at));
  const beats = (a: Candidate, b: Candidate): boolean =>
    a.score > b.score ||
    (a.score === b.score && Math.abs(a.start - stored) < Math.abs(b.start - stored));
  let winner = scored[0]!;
  let runnerUp = scored[1]!;
  if (beats(runnerUp, winner)) [winner, runnerUp] = [runnerUp, winner];
  for (let i = 2; i < scored.length; i++) {
    const c = scored[i]!;
    if (beats(c, winner)) {
      runnerUp = winner;
      winner = c;
    } else if (beats(c, runnerUp)) {
      runnerUp = c;
    }
  }
  const separated = winner.context - runnerUp.context >= CONTEXT_SEPARATION;
  // With every copy listed, a perfect context is decisive on its own. With a selection only, an
  // unlisted copy might outscore a winner who leads on score alone, so only the full stored context
  // is decisive, and only if every unlisted copy provably falls short of it by the usual margin.
  const decisive = occ.truncated
    ? winner.context === 1 && 1 - (occ.unseen ?? 1) >= CONTEXT_SEPARATION
    : winner.score - runnerUp.score >= LEAD || winner.context === 1;
  // A copy still sits exactly where the quote was captured while the context points elsewhere:
  // two strong signals disagree (e.g. the neighbourhood was rewritten and a duplicate happens to
  // match the old context), so neither may be chosen silently.
  const contested = winner.start !== stored && text.startsWith(exact, stored);
  // Neither copy has both sides of its context: one matches the text before the quote, another the
  // text after it (content was inserted right at the quote). Each is half-supported, so choosing
  // either would be a guess.
  const winnerSides = (winner.prefixDisagrees ? 0 : 1) + (winner.suffixDisagrees ? 0 : 1);
  const halfSupportedRival =
    winnerSides < 2 &&
    scored.some((c) => c !== winner && (!c.prefixDisagrees || !c.suffixDisagrees));
  if (separated && decisive && !contested && !halfSupportedRival) {
    if (isUnsupported(winner, stored) && editedOriginalSurvives(anchor, text, winner.start)) {
      return ambiguous(winner.score, count);
    }
    return finish(
      stream,
      winner.start,
      winner.start + exact.length,
      'resolved',
      Math.min(1, winner.score),
      'context',
      count,
    );
  }
  return ambiguous(winner.score, count);
}

/**
 * Resolves one anchor against a stream built from the live document (ADR-004 resolution order).
 * `ambiguous` and `orphaned` never carry a range, so nothing wrong can be painted.
 */
export function resolveAnchor(anchor: HtmlAnchorSet, stream: TextStream): Resolution {
  return resolveExact(anchor, stream, { occurrences: new Map() }) ?? fuzzyResolve(anchor, stream);
}

export interface ResolveManyOptions {
  /**
   * Anchors of other highlights on this page that are not in `entries` (typically the ones that are
   * already painted). Their text is owned: a highlight in `entries` that lost its own quote is not
   * re-bound onto it. Without this, only the entries of the batch protect each other.
   */
  siblings?: readonly AnchorSet[];
}

const quoteOf = (anchor: AnchorSet): string | undefined =>
  (anchor as Partial<HtmlAnchorSet>).textQuote?.exact;

/**
 * Resolves many anchors against one stream. Shares the stream, its lazily computed signature and
 * the per-quote occurrence scan across entries; nothing is rebuilt per entry.
 *
 * Highlights that no longer match verbatim are resolved fuzzily only after every exact match of the
 * batch is known, so a fuzzy match can never take the text another saved highlight owns (the
 * same range, or the same text as its quote): "Step 3" is not re-bound onto the highlighted "Step 4".
 */
export function resolveMany(
  entries: readonly { id: string; anchorSet: AnchorSet }[],
  stream: TextStream,
  options: ResolveManyOptions = {},
): Map<string, Resolution> {
  const shared: Shared = { occurrences: new Map() };
  const results = entries.map((e) => resolveExact(e.anchorSet, stream, shared));

  if (results.includes(null)) {
    const claims: Claims = { ranges: [], texts: new Set() };
    const claim = (anchor: AnchorSet, resolution: Resolution | null): void => {
      const quote = quoteOf(anchor);
      if (quote) claims.texts.add(quote);
      const span = resolution?.status === 'resolved' ? spans.get(resolution) : undefined;
      if (span) claims.ranges.push(span);
    };
    entries.forEach((e, i) => claim(e.anchorSet, results[i]!));
    for (const sibling of options.siblings ?? []) {
      claim(sibling, resolveExact(sibling, stream, shared));
    }

    const fuzzy: number[] = [];
    entries.forEach((e, i) => {
      if (results[i] !== null) return;
      results[i] = fuzzyResolve(e.anchorSet, stream, claims);
      if (results[i]!.status === 'changed') fuzzy.push(i);
    });
    // Two different quotes that both landed on the same text cannot both be right.
    const demoted = new Set<number>();
    for (let a = 0; a < fuzzy.length; a++) {
      for (let b = a + 1; b < fuzzy.length; b++) {
        const i = fuzzy[a]!;
        const j = fuzzy[b]!;
        if (quoteOf(entries[i]!.anchorSet) === quoteOf(entries[j]!.anchorSet)) continue;
        const [s1, e1] = spans.get(results[i]!)!;
        const [s2, e2] = spans.get(results[j]!)!;
        const overlap = Math.min(e1, e2) - Math.max(s1, s2);
        if (overlap > 0 && overlap / (Math.max(e1, e2) - Math.min(s1, s2)) >= CLAIM_OVERLAP) {
          demoted.add(i).add(j);
        }
      }
    }
    for (const i of demoted) results[i] = ambiguous(results[i]!.confidence, 0);
  }

  const out = new Map<string, Resolution>();
  entries.forEach((e, i) => out.set(e.id, results[i]!));
  return out;
}
