/**
 * Very frequent quotes: bounded work and no guessing (resolve.ts scanOccurrences/selectCandidates).
 * Timings are printed; the asserted limits are deliberately generous (shared CI runners, jsdom).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAnchor, resolveMany } from './resolve';
import { buildTextStream } from './textStream';
import { capture, setBody } from './testUtils';
import type { Resolution } from './types';
import type { HtmlAnchorSet } from '@shared';

// These build 5-12k element documents; shared CI runners can be slow. The asserted ms limits below
// are what bound the work, not this timeout.
vi.setConfig({ testTimeout: 120_000 });

beforeEach(() => {
  document.body.innerHTML = '';
});

function timed(anchor: HtmlAnchorSet): { res: Resolution; ms: number } {
  const stream = buildTextStream(); // not part of the timed resolution
  const t0 = performance.now();
  const res = resolveAnchor(anchor, stream);
  return { res, ms: performance.now() - t0 };
}

describe('5,000 copies of a short quote (every copy is listed and scored)', () => {
  it('nothing separates the copies: ambiguous, bounded, never painted', () => {
    setBody(`<p>${'word '.repeat(5000)}</p>`);
    const { anchorSet } = capture('word', 2500);
    setBody(`<p>Banner.</p><p>${'word '.repeat(5000)}</p>`);
    const { res, ms } = timed(anchorSet);
    console.log(`occurrences: 5,000 copies, ambiguous resolution = ${ms.toFixed(1)} ms`);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
    expect(res.candidateCount).toBe(5000);
    expect(ms).toBeLessThan(3000);
  });

  it('one copy keeps its context among 5,000: found, bounded', () => {
    setBody(
      `<p>${'word '.repeat(2500)}The marker sentence says word once more. ${'word '.repeat(2499)}</p>`,
    );
    const { anchorSet } = capture('word', 2500);
    expect(anchorSet.textQuote.prefix).toContain('marker sentence says');
    setBody(
      `<p>Banner.</p><p>${'word '.repeat(2500)}The marker sentence says word once more. ${'word '.repeat(2499)}</p>`,
    );
    const { res, ms } = timed(anchorSet);
    console.log(`occurrences: 5,000 copies, one with intact context = ${ms.toFixed(1)} ms`);
    expect(res.status).toBe('resolved');
    expect(res.candidateCount).toBe(5000);
    const node = res.range!.startContainer as Text;
    expect(node.data.slice(res.range!.startOffset - 25, res.range!.startOffset)).toBe(
      'The marker sentence says ',
    );
    expect(ms).toBeLessThan(3000);
  });

  it('200 anchors on the same frequent quote share one scan', () => {
    setBody(`<p>${'word '.repeat(5000)}</p>`);
    const entries = Array.from({ length: 200 }, (_, i) => ({
      id: `h${i}`,
      anchorSet: capture('word', 10 + i * 20).anchorSet,
    }));
    setBody(`<p>Banner.</p><p>${'word '.repeat(5000)}</p>`);
    const t0 = performance.now();
    const out = resolveMany(entries, buildTextStream());
    const ms = performance.now() - t0;
    console.log(`occurrences: 200 anchors x 5,000 copies = ${ms.toFixed(0)} ms`);
    for (const e of entries) expect(out.get(e.id)!.range).toBeNull();
    expect(ms).toBeLessThan(10_000);
  });
});

describe('more copies than the scan cap (candidates are chosen by evidence)', () => {
  const sentence = 'The powerhouse of the cell and its many roles in energy production.';
  const filler = Array.from(
    { length: 6000 },
    (_, i) => `<p>Filler ${i} mentions a cell in passing.</p>`,
  ).join('');

  it('the real copy (last of 6,002) is found when its full context survived', () => {
    setBody(`<p>noise 1</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const { anchorSet } = capture('cell', 6001);
    expect(anchorSet.textQuote.prefix).toContain('Body');
    setBody(`<p>noise 12</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const { res, ms } = timed(anchorSet);
    console.log(`occurrences: 6,002 copies, true copy last = ${ms.toFixed(1)} ms`);
    expect(res.status).toBe('resolved');
    expect(res.method).toBe('context');
    expect((res.range!.startContainer.textContent ?? '').startsWith('Body.')).toBe(true);
    expect(ms).toBeLessThan(3000);
  });

  it('a stored context as short as the scan reach cannot exclude an unlisted copy: ambiguous', () => {
    setBody(`<p>noise 1</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const { anchorSet } = capture('cell', 6001);
    setBody(`<p>noise 12</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const { prefix, suffix } = anchorSet.textQuote;
    const short: HtmlAnchorSet = {
      ...anchorSet,
      textQuote: { ...anchorSet.textQuote, prefix: prefix.slice(-16), suffix: suffix.slice(0, 16) },
    };
    // The copy still carries all 32 stored characters, but a copy matching 15 + 15 of them could
    // exist among the unlisted ones and the margin is gone: nothing is painted.
    const { res } = timed(short);
    expect(res.range).toBeNull();
    expect(res.status).toBe('ambiguous');
    // With the full 32 + 32 stored characters the same page resolves.
    expect(timed(anchorSet).res.status).toBe('resolved');
  });

  it('the real copy gone: the look-alike with partial context is not painted', () => {
    setBody(`<p>noise 1</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const { anchorSet } = capture('cell', 6001);
    setBody(`<p>noise 12</p><p>Abstract. ${sentence}</p>${filler}`);
    const { res } = timed(anchorSet);
    expect(res.range).toBeNull();
  });

  it('10,000 identical copies: ambiguous (never ranked on position alone), bounded', () => {
    setBody(`<p>${'word '.repeat(10_000)}</p>`);
    const { anchorSet } = capture('word', 5000);
    setBody(`<p>Banner.</p><p>${'word '.repeat(10_000)}</p>`);
    const { res, ms } = timed(anchorSet);
    console.log(`occurrences: 10,000 identical copies = ${ms.toFixed(1)} ms`);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
    expect(ms).toBeLessThan(3000);
  });

  it('10,000 copies, byte-identical page: the stored position is still authoritative', () => {
    setBody(`<p>${'word '.repeat(10_000)}</p>`);
    const { anchorSet } = capture('word', 7000);
    const { res } = timed(anchorSet);
    expect(res.status).toBe('resolved');
    expect(res.method).toBe('position');
  });
});
