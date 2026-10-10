import type { AnchorSet, HtmlAnchorSet } from '@shared';
import { TEXT_ALGORITHM } from '@shared/constants';
import { bestApproxSubstring, similarity, type ApproxMatch } from './fuzzy';
import { streamRangeToDomRange, streamTextOfRange } from './textStream';
import type { Resolution, ResolutionMethod, ResolutionStatus, TextStream } from './types';

// ADR-004 "Resolution order" constants.
const MAX_OCCURRENCES = 200;
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

interface Occurrences {
  at: number[];
  /** More than MAX_OCCURRENCES exist; the list is a prefix of them. */
  truncated: boolean;
}

function orphaned(candidateCount = 0): Resolution {
  return { status: 'orphaned', confidence: 0, range: null, method: 'none', candidateCount };
}

function ambiguous(confidence: number, candidateCount: number): Resolution {
  return { status: 'ambiguous', confidence, range: null, method: 'none', candidateCount };
}

function findOccurrences(text: string, needle: string): Occurrences {
  const at: number[] = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    at.push(i); // overlapping occurrences are real candidates ("aa" in "aaa")
    if (at.length >= MAX_OCCURRENCES) {
      return { at, truncated: text.indexOf(needle, i + 1) !== -1 };
    }
    i = text.indexOf(needle, i + 1);
  }
  return { at, truncated: false };
}

function commonSuffixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a.charCodeAt(a.length - 1 - k) === b.charCodeAt(b.length - 1 - k)) k++;
  return k;
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a.charCodeAt(k) === b.charCodeAt(k)) k++;
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
  const prefixMatched = commonSuffixLength(prefix, text.slice(Math.max(0, at - prefix.length), at));
  const suffixMatched = commonPrefixLength(suffix, text.slice(end, end + suffix.length));

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
  return { status, confidence, range, method, candidateCount };
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

interface FuzzyMatch extends ApproxMatch {
  sim: number;
}

/**
 * Locations near the old offset or next to the moved context whose text is >= 0.85 similar to the
 * quote, best first. Cost is bounded by a shared DP cell budget (see fuzzy.ts).
 */
function fuzzyMatches(anchor: HtmlAnchorSet, text: string): FuzzyMatch[] {
  const { exact, prefix, suffix } = anchor.textQuote;
  const length = exact.length;
  const maxDist = Math.floor((1 - FUZZY_MIN_SIMILARITY) * length + 1e-9);
  if (maxDist < 1) return []; // too short to tolerate even one edit at 0.85

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

  const budget = { cells: FUZZY_CELL_BUDGET };
  const found: FuzzyMatch[] = [];
  const seen = new Set<string>();
  for (const [from, to] of windows) {
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
    const distance = Math.round((1 - sim) * Math.max(length, end - start));
    found.push({ start, end, distance, sim });
  }
  const origin = anchor.textPosition.start;
  return found.sort(
    (a, b) => a.distance - b.distance || Math.abs(a.start - origin) - Math.abs(b.start - origin),
  );
}

function fuzzyResolve(anchor: HtmlAnchorSet, stream: TextStream): Resolution {
  const found = fuzzyMatches(anchor, stream.text);
  const best = found[0];
  if (!best) return orphaned();
  // A different location that fits almost as well means we cannot tell which one the user saw.
  const margin = Math.max(1, Math.floor(0.05 * anchor.textQuote.exact.length));
  const rival = found.find(
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
 * be a silent wrong answer.
 */
function editedOriginalSurvives(anchor: HtmlAnchorSet, text: string, start: number): boolean {
  const end = start + anchor.textQuote.exact.length;
  return fuzzyMatches(anchor, text).some((m) => m.end <= start || m.start >= end);
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Per-call memo: what is shared between anchors resolved against the same stream. */
interface Shared {
  occurrences: Map<string, Occurrences>;
  signature?: string;
}

function resolveWith(anchor: HtmlAnchorSet, stream: TextStream, shared: Shared): Resolution {
  // 1. A different text algorithm needs a migration, not a guess.
  if ((anchor as { type?: string }).type !== 'html') return orphaned();
  if (anchor.textAlgorithm !== TEXT_ALGORITHM) return orphaned();
  const { exact } = anchor.textQuote;
  if (exact.length === 0) return orphaned();

  const { text } = stream;
  const stored = anchor.textPosition.start;

  // 2. Exact occurrences (cap 200); shared across anchors with the same quote.
  let occ = shared.occurrences.get(exact);
  if (!occ) {
    occ = findOccurrences(text, exact);
    shared.occurrences.set(exact, occ);
  }
  const count = occ.at.length;

  // 5. Nothing exact: fuzzy, or orphaned.
  if (count === 0) return fuzzyResolve(anchor, stream);

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
  const ranked = occ.at
    .map((at) => scoreCandidate(text, anchor, at))
    .sort((a, b) => b.score - a.score || Math.abs(a.start - stored) - Math.abs(b.start - stored));
  const winner = ranked[0]!;
  const runnerUp = ranked[1]!;
  const separated = winner.context - runnerUp.context >= CONTEXT_SEPARATION;
  const decisive =
    winner.score - runnerUp.score >= LEAD || (winner.context === 1 && !occ.truncated);
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
    ranked.some((c) => c !== winner && (!c.prefixDisagrees || !c.suffixDisagrees));
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
  return resolveWith(anchor, stream, { occurrences: new Map() });
}

/**
 * Resolves many anchors against one stream. Shares the stream, its lazily computed signature and
 * the per-quote occurrence scan across entries; nothing is rebuilt per entry.
 */
export function resolveMany(
  entries: readonly { id: string; anchorSet: AnchorSet }[],
  stream: TextStream,
): Map<string, Resolution> {
  const shared: Shared = { occurrences: new Map() };
  const out = new Map<string, Resolution>();
  for (const entry of entries) out.set(entry.id, resolveWith(entry.anchorSet, stream, shared));
  return out;
}
