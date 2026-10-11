import { describe, expect, it } from 'vitest';
import { buildPdfAnchor, resolvePdfAnchor } from './anchor';
import {
  OCR_SIGNATURE_PREFIX,
  buildOcrPageText,
  isOcrSignature,
  ocrWordsToContent,
  usableOcrWords,
  type OcrWordInput,
} from './ocr';
import { rectsForRange, streamOffsetOf } from './pageText';

/** "Glomeruli filter plasma" on one line, "at a steady rate" on the next. */
const words = (over: Record<number, string> = {}): OcrWordInput[] => {
  const base = [
    ['Glomeruli', 0.1, 0.1, 0.16, 0],
    ['filter', 0.28, 0.1, 0.1, 0],
    ['plasma', 0.4, 0.1, 0.12, 0],
    ['at', 0.1, 0.14, 0.04, 1],
    ['a', 0.16, 0.14, 0.02, 1],
    ['steady', 0.2, 0.14, 0.12, 1],
    ['rate', 0.34, 0.14, 0.08, 1],
  ] as const;
  return base.map(([text, x, y, w, line], i) => ({
    text: over[i] ?? text,
    x,
    y,
    w,
    h: 0.025,
    line,
    confidence: 90,
  }));
};

describe('buildOcrPageText (sv-ocr-text-v1 as a PageText)', () => {
  it('joins words with one space across line breaks and marks the signature as OCR', () => {
    const pt = buildOcrPageText(words());
    expect(pt.text).toBe('Glomeruli filter plasma at a steady rate');
    expect(pt.algorithm).toBe('sv-ocr-text-v1');
    expect(pt.signature.startsWith(OCR_SIGNATURE_PREFIX)).toBe(true);
    expect(isOcrSignature(pt.signature)).toBe(true);
    expect(pt.signature.length).toBeLessThanOrEqual(32); // PdfAnchorSet.contentSignature bound
    // Line ends sit after "plasma" (index 2) and after "rate" (index 6).
    expect([...pt.lineEnds]).toEqual([2, 6]);
  });

  it('maps stream offsets back to word boxes', () => {
    const pt = buildOcrPageText(words());
    // "filter" occupies [10, 16): its rect is the OCR box, not an interpolation of the line.
    const rects = rectsForRange(pt, 10, 16);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x).toBeCloseTo(0.28, 6);
    expect(rects[0]!.w).toBeCloseTo(0.1, 6);
    expect(rects[0]!.y).toBeCloseTo(0.1, 6);
    expect(streamOffsetOf(pt, 1, 0, 'start')).toBe(10);
    expect(streamOffsetOf(pt, 1, 6, 'end')).toBe(16);
  });

  it('keeps the stream separator as a trailing space of each word (copying keeps its spaces)', () => {
    const input = words();
    const pt = buildOcrPageText(input);
    const content = ocrWordsToContent(input, [0, 0, 612, 792]);
    const strs = (content.items as unknown as Array<{ str: string }>).map((i) => i.str);
    expect(strs.join('')).toBe(pt.text);
    expect(strs[0]).toBe('Glomeruli ');
    expect(strs.at(-1)).toBe('rate'); // nothing trails the last word
    // Raw lengths agree between the two builders, and the letters stay on the recogniser's box.
    expect(pt.items.map((g) => g!.length)).toEqual(strs.map((s) => s.length));
    expect(pt.segments.filter((s) => s.item === 0)).toEqual([
      { item: 0, rawStart: 0, rawEnd: 9, start: 0, end: 9 },
      { item: 0, rawStart: 9, rawEnd: 10, start: 9, end: 10 },
    ]);
    const letters = rectsForRange(pt, 0, 9)[0]!;
    expect(letters.x).toBeCloseTo(0.1, 6);
    expect(letters.w).toBeCloseTo(0.16, 6);
  });

  it('derives lines from the boxes when the words carry none (data stored before lines were kept)', () => {
    const noLines = words().map(({ line: _l, ...w }) => w);
    const pt = buildOcrPageText(noLines);
    expect(pt.text).toBe('Glomeruli filter plasma at a steady rate');
    expect([...pt.lineEnds]).toEqual([2, 6]);
  });

  it('drops empty and boxless words from both builders alike', () => {
    const input: OcrWordInput[] = [
      { text: '  ', x: 0, y: 0, w: 0.1, h: 0.1 },
      { text: 'kept', x: 0.1, y: 0.1, w: 0.1, h: 0.02 },
      { text: 'flat', x: 0.2, y: 0.1, w: 0, h: 0.02 },
      { text: 'a\u0007\tb', x: 0.3, y: 0.1, w: 0.1, h: 0.02 },
    ];
    const usable = usableOcrWords(input);
    expect(usable.map((w) => w.text)).toEqual(['kept', 'a b']);
    expect(buildOcrPageText(usable).text).toBe('kept a b');
    expect(ocrWordsToContent(usable, [0, 0, 612, 792]).items).toHaveLength(2);
  });
});

describe('anchors on OCR text', () => {
  const build = (pt = buildOcrPageText(words())) =>
    buildPdfAnchor({
      documentFingerprint: 'f'.repeat(64),
      pageNumber: 3,
      rotation: 0,
      pageText: pt,
      start: 10,
      end: 29, // "filter plasma at a"
      rects: [],
    });

  it('records that the text is OCR-derived and keeps the stream slice as the quote', () => {
    const built = build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.exactQuote).toBe('filter plasma at a');
    expect(isOcrSignature(built.anchorSet.contentSignature)).toBe(true);
    expect(built.anchorSet.textAlgorithm).toBe('sv-pdf-text-v1');
  });

  it('resolves by position on the same recognition', () => {
    const built = build();
    if (!built.ok) throw new Error('anchor');
    const res = resolvePdfAnchor(built.anchorSet, buildOcrPageText(words()));
    expect(res).toMatchObject({ status: 'resolved', method: 'position' });
  });

  it('after a correction elsewhere on the page the quote still resolves, by quote, never by a stale offset', () => {
    const built = build();
    if (!built.ok) throw new Error('anchor');
    // "Glomeruli" -> "Nephrons": offsets shift by one, the signature changes.
    const corrected = buildOcrPageText(words({ 0: 'Nephrons' }));
    const res = resolvePdfAnchor(built.anchorSet, corrected);
    expect(res.status).toBe('resolved');
    expect(res.method).not.toBe('position');
    expect(corrected.text.slice(res.start!, res.end!)).toBe('filter plasma at a');
  });

  it('a correction INSIDE the quote marks the highlight changed (same boxes), never silently re-bound', () => {
    const built = build();
    if (!built.ok) throw new Error('anchor');
    const corrected = buildOcrPageText(words({ 1: 'filters' }));
    const res = resolvePdfAnchor(built.anchorSet, corrected);
    expect(['changed', 'orphaned']).toContain(res.status);
    if (res.status === 'changed') expect(res.method).toBe('rects');
    // The stored quote is untouched by construction: it lives in the anchor and the highlight row.
    expect(built.anchorSet.textQuote.exact).toBe('filter plasma at a');
  });

  it('an OCR anchor is not trusted by offset against a different stream of the same page', () => {
    const built = build();
    if (!built.ok) throw new Error('anchor');
    const other = buildOcrPageText(words().map((w, i) => (i === 3 ? { ...w, text: 'AT' } : w)));
    const res = resolvePdfAnchor(built.anchorSet, other);
    expect(res.method).not.toBe('position');
  });
});
