// Deterministic candidate generation for contradiction detection. The model never decides WHICH pairs to
// look at, it only judges the pairs produced here (so it cannot be steered to invent a conflict).
import { matchForm } from './text';

const STOP = new Set(
  (
    'the and for are but not you all any can had her was one our out has have been from that this with ' +
    'they will would there their what about which when were than then them these those into also such ' +
    'may more most other some only over very its his how who why does did per via'
  ).split(' '),
);

export interface CandidateInput {
  id: string;
  text: string;
}

export interface CandidateOptions {
  maxPairs?: number;
  minShared?: number;
  minJaccard?: number;
}

export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of matchForm(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

/**
 * Pairs of distinct chunks that talk about the same things (>= minShared shared content words and
 * Jaccard >= minJaccard), strongest first, ties broken by id so the result is reproducible.
 */
export function candidatePairs(
  chunks: readonly CandidateInput[],
  opts: CandidateOptions = {},
): [string, string][] {
  const { maxPairs = 30, minShared = 2, minJaccard = 0.08 } = opts;
  const sorted = [...chunks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const toks = sorted.map((c) => contentTokens(c.text));
  const scored: { a: string; b: string; score: number; shared: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const A = toks[i]!;
      const B = toks[j]!;
      let shared = 0;
      for (const t of A) if (B.has(t)) shared++;
      const union = A.size + B.size - shared;
      const score = union === 0 ? 0 : shared / union;
      if (shared >= minShared && score >= minJaccard) {
        scored.push({ a: sorted[i]!.id, b: sorted[j]!.id, score, shared });
      }
    }
  }
  scored.sort(
    (x, y) =>
      y.score - x.score ||
      y.shared - x.shared ||
      (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
      (x.b < y.b ? -1 : x.b > y.b ? 1 : 0),
  );
  return scored.slice(0, maxPairs).map((p) => [p.a, p.b]);
}
