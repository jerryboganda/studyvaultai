/**
 * Bounded approximate matching for the "changed" resolution path (ADR-004 step 5).
 *
 * Everything here is cost-capped: distances use a band of width 2k+1 with row early-exit, and the
 * substring search uses Ukkonen's cutoff plus an explicit cell budget. A page that is rewritten
 * wholesale therefore produces `null` quickly instead of an O(n*m) stall in the content script.
 */

/** Hard cap on DP cells for a single similarity() call (about 10-20 ms in V8). */
export const MAX_DP_CELLS = 4_000_000;
/** Default total DP cell budget for one approximate substring search. */
export const DEFAULT_SEARCH_BUDGET = 8_000_000;

/**
 * Levenshtein distance when it is <= `maxDist`; otherwise returns `maxDist + 1`.
 * Common prefix/suffix are stripped first (distance-preserving), so a one-word edit in a long quote
 * costs almost nothing. Returns `maxDist + 1` when the banded DP would exceed MAX_DP_CELLS.
 */
export function boundedEditDistance(a: string, b: string, maxDist: number): number {
  const over = maxDist + 1;
  if (maxDist < 0) return 0;
  let aStart = 0;
  let aEnd = a.length;
  let bStart = 0;
  let bEnd = b.length;
  while (aStart < aEnd && bStart < bEnd && a.charCodeAt(aStart) === b.charCodeAt(bStart)) {
    aStart++;
    bStart++;
  }
  while (aEnd > aStart && bEnd > bStart && a.charCodeAt(aEnd - 1) === b.charCodeAt(bEnd - 1)) {
    aEnd--;
    bEnd--;
  }
  const m = aEnd - aStart;
  const n = bEnd - bStart;
  if (m === 0) return n <= maxDist ? n : over;
  if (n === 0) return m <= maxDist ? m : over;
  if (Math.abs(m - n) > maxDist) return over;
  const k = Math.min(maxDist, Math.max(m, n));
  if (m * (2 * k + 1) > MAX_DP_CELLS) return over;

  const INF = k + 1;
  let prev = new Int32Array(n + 2);
  let cur = new Int32Array(n + 2);
  for (let j = 0; j <= n; j++) prev[j] = j <= k ? j : INF;
  for (let i = 1; i <= m; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(n, i + k);
    cur[lo - 1] = lo === 1 && i <= k ? i : INF;
    const ai = a.charCodeAt(aStart + i - 1);
    let rowMin = INF;
    for (let j = lo; j <= hi; j++) {
      let v = prev[j - 1]! + (ai === b.charCodeAt(bStart + j - 1) ? 0 : 1);
      const up = prev[j]! + 1;
      if (up < v) v = up;
      const left = cur[j - 1]! + 1;
      if (left < v) v = left;
      if (v > INF) v = INF;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi + 1 <= n) cur[hi + 1] = INF; // right band edge: never read stale values
    if (rowMin > k) return over;
    const t = prev;
    prev = cur;
    cur = t;
  }
  const d = prev[n]!;
  return d <= maxDist ? d : over;
}

/**
 * Normalised similarity 1 - dist / max(len). Returns 0 as soon as the result is known to be below
 * `minSimilarity` (or the DP would be too large), so callers can use it as a cheap gate.
 */
export function similarity(a: string, b: string, minSimilarity = 0): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const maxDist = Math.floor((1 - minSimilarity) * maxLen + 1e-9);
  const d = boundedEditDistance(a, b, maxDist);
  return d > maxDist ? 0 : 1 - d / maxLen;
}

export interface ApproxMatch {
  /** Absolute offsets into `text`. */
  start: number;
  end: number;
  distance: number;
}

/**
 * Best approximate occurrence of `pattern` inside `text[from, to)` with edit distance <= maxDist
 * (Sellers' algorithm with start tracking and Ukkonen's cutoff). Ties prefer the earliest end.
 * Returns null when nothing qualifies or `budget.cells` runs out.
 */
export function bestApproxSubstring(
  pattern: string,
  text: string,
  from: number,
  to: number,
  maxDist: number,
  budget: { cells: number } = { cells: DEFAULT_SEARCH_BUDGET },
): ApproxMatch | null {
  const m = pattern.length;
  const lo = Math.max(0, from);
  const hi = Math.min(text.length, to);
  const width = hi - lo;
  if (m === 0 || maxDist < 0 || width < m - maxDist) return null;

  const INF = maxDist + 1;
  let prevCost = new Int32Array(m + 2);
  let prevStart = new Int32Array(m + 2);
  let curCost = new Int32Array(m + 2);
  let curStart = new Int32Array(m + 2);
  for (let i = 0; i <= m; i++) prevCost[i] = i <= maxDist ? i : INF;
  let top = Math.min(m, maxDist); // last row whose cost is <= maxDist
  let best: ApproxMatch | null = null;

  for (let j = 1; j <= width; j++) {
    const ch = text.charCodeAt(lo + j - 1);
    curCost[0] = 0; // a match may start anywhere: the empty prefix costs nothing
    curStart[0] = j;
    const lim = Math.min(m, top + 1);
    budget.cells -= lim;
    if (budget.cells < 0) return null;
    for (let i = 1; i <= lim; i++) {
      let c = prevCost[i - 1]! + (pattern.charCodeAt(i - 1) === ch ? 0 : 1);
      let s = prevStart[i - 1]!;
      const del = curCost[i - 1]! + 1;
      if (del < c) {
        c = del;
        s = curStart[i - 1]!;
      }
      const ins = prevCost[i]! + 1;
      if (ins < c) {
        c = ins;
        s = prevStart[i]!;
      }
      curCost[i] = c > INF ? INF : c;
      curStart[i] = s;
    }
    if (lim < m) curCost[lim + 1] = INF; // sentinel for the next column's "up" read
    let t = lim;
    while (t > 0 && curCost[t]! > maxDist) t--;
    top = t;
    if (lim === m && curCost[m]! <= maxDist) {
      const dist = curCost[m]!;
      if (!best || dist < best.distance) {
        best = { start: lo + curStart[m]!, end: lo + j, distance: dist };
      }
    }
    const c1 = prevCost;
    prevCost = curCost;
    curCost = c1;
    const s1 = prevStart;
    prevStart = curStart;
    curStart = s1;
  }
  return best;
}
