import { describe, expect, it } from 'vitest';
import { MAX_DP_CELLS, bestApproxSubstring, boundedEditDistance, similarity } from './fuzzy';
import { prng } from './testUtils';

/** Reference full-matrix Levenshtein. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        prev[j]! + 1,
        cur[j - 1]! + 1,
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

function randomString(rand: () => number, alphabet: string, min: number, max: number): string {
  const len = min + Math.floor(rand() * (max - min + 1));
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

describe('boundedEditDistance', () => {
  it('matches a reference Levenshtein within the bound and reports bound+1 beyond it', () => {
    const rand = prng(42);
    for (let i = 0; i < 600; i++) {
      const a = randomString(rand, 'abc', 0, 14);
      const b = randomString(rand, 'abc', 0, 14);
      const maxDist = Math.floor(rand() * 9);
      const truth = levenshtein(a, b);
      const got = boundedEditDistance(a, b, maxDist);
      expect(got, `${a} / ${b} / ${maxDist}`).toBe(truth <= maxDist ? truth : maxDist + 1);
    }
  });

  it('handles identical, empty and single-edit inputs', () => {
    expect(boundedEditDistance('', '', 3)).toBe(0);
    expect(boundedEditDistance('abc', 'abc', 0)).toBe(0);
    expect(boundedEditDistance('', 'abc', 5)).toBe(3);
    expect(boundedEditDistance('abc', '', 2)).toBe(3);
    expect(boundedEditDistance('kitten', 'sitting', 3)).toBe(3);
    expect(boundedEditDistance('kitten', 'sitting', 2)).toBe(3);
  });

  it('is cheap for a long string with one edit (prefix/suffix stripping)', () => {
    const base = 'lorem ipsum '.repeat(800); // 9.6k chars
    const edited = base.slice(0, 5000) + 'X' + base.slice(5001);
    const t0 = performance.now();
    expect(boundedEditDistance(base, edited, 100)).toBe(1);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('refuses to run an unbounded DP over large dissimilar strings', () => {
    const rand = prng(7);
    const a = randomString(rand, 'abcdefghij', 6000, 6000);
    const b = randomString(rand, 'abcdefghij', 6000, 6000);
    const t0 = performance.now();
    const d = boundedEditDistance(a, b, 3000);
    expect(d).toBe(3001);
    expect(6000 * (2 * 3000 + 1)).toBeGreaterThan(MAX_DP_CELLS);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and 1 - d/maxLen otherwise', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('same text', 'same text', 0.85)).toBe(1);
    expect(similarity('abcdefghij', 'abcdefghiX')).toBeCloseTo(0.9, 10);
  });

  it('returns 0 below the minimum', () => {
    expect(similarity('abcdefghij', 'abcdefgXYZ', 0.85)).toBe(0);
    expect(similarity('abcdefghij', 'abcdefghiX', 0.85)).toBeCloseTo(0.9, 10);
  });

  it('accepts exactly 0.85 (3 edits in 20 chars)', () => {
    const a = 'abcdefghijklmnopqrst';
    const b = 'abcdefghijklmnopqXYZ';
    expect(similarity(a, b, 0.85)).toBeCloseTo(0.85, 10);
  });
});

describe('bestApproxSubstring', () => {
  it('finds an exact occurrence with absolute offsets', () => {
    const text = 'xxxxxhello worldyyyyy';
    expect(bestApproxSubstring('hello world', text, 0, text.length, 2)).toEqual({
      start: 5,
      end: 16,
      distance: 0,
    });
  });

  it('finds a match with an edit and reports the distance', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    const m = bestApproxSubstring('quick brown fax jumps', text, 0, text.length, 3)!;
    expect(text.slice(m.start, m.end)).toBe('quick brown fox jumps');
    expect(m.distance).toBe(1);
  });

  it('respects the window and returns null when nothing is close enough', () => {
    const text = 'aaaa hello world bbbb';
    expect(bestApproxSubstring('hello world', text, 0, 4, 2)).toBeNull();
    expect(bestApproxSubstring('hello world', 'zzzzzzzzzzzzzzzzzzzz', 0, 20, 2)).toBeNull();
  });

  it('agrees with a brute-force search on small random inputs', () => {
    const rand = prng(1234);
    for (let i = 0; i < 150; i++) {
      const pattern = randomString(rand, 'abc', 4, 9);
      const text = randomString(rand, 'abc', 6, 22);
      const maxDist = 1 + Math.floor(rand() * 3);
      let truth = Infinity;
      for (let s = 0; s <= text.length; s++) {
        for (let e = s; e <= text.length; e++) {
          truth = Math.min(truth, levenshtein(pattern, text.slice(s, e)));
        }
      }
      const got = bestApproxSubstring(pattern, text, 0, text.length, maxDist);
      if (truth <= maxDist) {
        expect(got, `${pattern} in ${text}`).not.toBeNull();
        expect(got!.distance).toBe(truth);
        expect(levenshtein(pattern, text.slice(got!.start, got!.end))).toBe(truth);
      } else {
        expect(got).toBeNull();
      }
    }
  });

  it('gives up (null) when the cell budget is exhausted', () => {
    const text = 'abcdefghij'.repeat(2000);
    const budget = { cells: 500 };
    expect(bestApproxSubstring('abcdefghijabcdefghij', text, 0, text.length, 3, budget)).toBeNull();
    expect(budget.cells).toBeLessThan(0);
  });

  it('stays fast on a large window thanks to the cutoff', () => {
    const rand = prng(99);
    const text = randomString(rand, 'abcdefghijklmnopqrstuvwxyz ', 100_000, 100_000);
    const pattern = text.slice(60_000, 60_300).replace('e', 'E');
    const t0 = performance.now();
    const m = bestApproxSubstring(pattern, text, 0, text.length, 45, { cells: 50_000_000 });
    const elapsed = performance.now() - t0;
    expect(m).not.toBeNull();
    expect(m!.start).toBe(60_000);
    expect(elapsed).toBeLessThan(3000);
  });
});
