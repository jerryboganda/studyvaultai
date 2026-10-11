// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makeClozeMarkup, parseCloze, renderCloze, segmentsToText } from './cloze';

const question = (markup: string, activeIndex: number | null = null): string =>
  segmentsToText(renderCloze(markup, { activeIndex, reveal: false }));
const answer = (markup: string, activeIndex: number | null = null): string =>
  segmentsToText(renderCloze(markup, { activeIndex, reveal: true }));

describe('parseCloze', () => {
  it('parses one deletion, with and without a hint', () => {
    expect(parseCloze('The {{c1::mitochondria}} makes ATP.').deletions).toEqual([
      { index: 1, answer: 'mitochondria', hint: null },
    ]);
    expect(parseCloze('The {{c1::mitochondria::organelle}} makes ATP.').deletions).toEqual([
      { index: 1, answer: 'mitochondria', hint: 'organelle' },
    ]);
  });

  it('parses several deletions and repeated indexes in document order', () => {
    const p = parseCloze('{{c2::B}} and {{c1::A}} and {{c1::C}}');
    expect(p.deletions.map((d) => [d.index, d.answer])).toEqual([
      [2, 'B'],
      [1, 'A'],
      [1, 'C'],
    ]);
    expect(p.indexes).toEqual([1, 2]);
  });

  it('handles nested deletions: outer answer is the flattened text', () => {
    const p = parseCloze('{{c1::The {{c2::inner}} part}} is hidden');
    expect(p.deletions).toEqual([
      { index: 1, answer: 'The inner part', hint: null },
      { index: 2, answer: 'inner', hint: null },
    ]);
    // Testing c2: c1 is context (shown), c2 hidden.
    expect(question('{{c1::The {{c2::inner}} part}} is hidden', 2)).toBe(
      'The [...] part is hidden',
    );
    // Testing c1: the whole outer span is hidden, nested one with it.
    expect(question('{{c1::The {{c2::inner}} part}} is hidden', 1)).toBe('[...] is hidden');
    expect(answer('{{c1::The {{c2::inner}} part}} is hidden', 1)).toBe('The inner part is hidden');
  });

  it('never throws on malformed markup: broken pieces stay literal', () => {
    const cases = [
      '{{c1::unclosed',
      'stray }} closer',
      '{{c0::zero index}}',
      '{{c1::}}',
      '{{c1:: }}',
      '{{c1::::onlyhint}}',
      '{{cX::bad}}',
      '{{c100::three digits}}',
      '{{c1::a {{c2::b}}',
      '{{c1::a::h1::h2}}',
      '}}{{',
      '',
    ];
    for (const markup of cases) {
      const p = parseCloze(markup);
      expect(Array.isArray(p.deletions)).toBe(true);
      // The literal text is preserved: rendering with nothing hidden gives back the input (modulo valid clozes).
    }
    expect(parseCloze('{{c1::unclosed').deletions).toEqual([]);
    expect(question('{{c1::unclosed')).toBe('{{c1::unclosed');
    expect(parseCloze('{{c0::zero index}}').deletions).toEqual([]);
    expect(parseCloze('{{c1::}}').deletions).toEqual([]);
    expect(question('stray }} closer')).toBe('stray }} closer');
    expect(parseCloze('{{c1::a {{c2::b}}').deletions).toEqual([
      { index: 2, answer: 'b', hint: null },
    ]);
    expect(question('{{c1::a {{c2::b}}', 2)).toBe('{{c1::a [...]');
  });

  it('keeps a hint that itself contains :: (first :: splits answer and hint)', () => {
    expect(parseCloze('{{c1::answer::see std::vector}}').deletions).toEqual([
      { index: 1, answer: 'answer', hint: 'see std::vector' },
    ]);
  });

  it('bounds nesting depth instead of recursing without limit', () => {
    const deep = `${'{{c1::'.repeat(50)}x${'}}'.repeat(50)}`;
    const p = parseCloze(deep);
    expect(p.deletions.length).toBeLessThanOrEqual(6);
    expect(() => renderCloze(deep, { activeIndex: null, reveal: false })).not.toThrow();
  });

  it('is linear on hostile input (no catastrophic backtracking)', () => {
    const hostile = '{{c1::'.repeat(5000) + 'a'.repeat(20000) + '}}'.repeat(5000);
    const t0 = Date.now();
    parseCloze(hostile);
    parseCloze('{{c1:'.repeat(20000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('renderCloze', () => {
  const sentence = 'The {{c1::heart::organ}} pumps {{c2::blood}} through {{c1::vessels}}.';

  it('hides every deletion when no index is active', () => {
    expect(question(sentence)).toBe('The [organ] pumps [...] through [...].');
    expect(answer(sentence)).toBe('The heart pumps blood through vessels.');
  });

  it('hides only the active index and shows the others as context', () => {
    expect(question(sentence, 1)).toBe('The [organ] pumps blood through [...].');
    expect(question(sentence, 2)).toBe('The heart pumps [...] through vessels.');
    const segs = renderCloze(sentence, { activeIndex: 2, reveal: true });
    expect(segs.filter((s) => s.kind === 'answer')).toEqual([
      { kind: 'answer', index: 2, text: 'blood' },
    ]);
  });

  it('returns text segments only: markup-looking content is never HTML', () => {
    const evil = 'Use {{c1::<script>alert(1)</script>}} and <img src=x onerror=alert(2)>';
    const segs = renderCloze(evil, { activeIndex: null, reveal: true });
    expect(segs.map((s) => s.kind).sort()).toEqual(['answer', 'text', 'text']);
    expect(segmentsToText(segs)).toBe(
      'Use <script>alert(1)</script> and <img src=x onerror=alert(2)>',
    );
  });

  it('accepts an already parsed cloze', () => {
    const parsed = parseCloze(sentence);
    expect(segmentsToText(renderCloze(parsed, { activeIndex: 1, reveal: false }))).toBe(
      'The [organ] pumps blood through [...].',
    );
  });
});

describe('makeClozeMarkup', () => {
  const text = 'Insulin lowers blood glucose and is made in beta cells.';
  it('wraps selected spans and numbers them', () => {
    const out = makeClozeMarkup(text, [
      { start: 0, end: 7 },
      { start: 44, end: 54, hint: 'islets' },
    ]);
    expect(out).toBe(
      '{{c1::Insulin}} lowers blood glucose and is made in {{c2::beta cells::islets}}.',
    );
    expect(parseCloze(out).deletions).toHaveLength(2);
  });

  it('rejects overlapping, empty, out-of-range and delimiter-bearing selections', () => {
    expect(() =>
      makeClozeMarkup(text, [
        { start: 0, end: 5 },
        { start: 3, end: 8 },
      ]),
    ).toThrow(RangeError);
    expect(() => makeClozeMarkup(text, [{ start: 4, end: 4 }])).toThrow(RangeError);
    expect(() => makeClozeMarkup(text, [{ start: 0, end: 999 }])).toThrow(RangeError);
    expect(() => makeClozeMarkup('std::vector grows', [{ start: 0, end: 11 }])).toThrow(RangeError);
    expect(() => makeClozeMarkup(text, [{ start: 0, end: 7, index: 0 }])).toThrow(RangeError);
    expect(() => makeClozeMarkup(text, [{ start: 0, end: 7, hint: 'a}}b' }])).toThrow(RangeError);
  });

  it('allows several spans to share one index', () => {
    const out = makeClozeMarkup(text, [
      { start: 0, end: 7, index: 1 },
      { start: 8, end: 14, index: 1 },
    ]);
    expect(parseCloze(out).indexes).toEqual([1]);
  });
});
