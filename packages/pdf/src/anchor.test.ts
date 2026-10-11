import { describe, expect, it } from 'vitest';
import { PdfAnchorSet } from '@shared';
import { buildPdfAnchor, resolvePdfAnchor, type PdfResolution } from './anchor';
import { buildPageText, rectsForRange, type PageText, type PageTextItem } from './pageText';
import { mk } from './testing/items';

const LETTER = { viewBox: [0, 0, 612, 792], rotate: 0 } as const;

const page = (lines: string[], top = 720): PageText =>
  buildPageText(
    lines.map((l, i) => mk(l, 72, top - i * 14)),
    LETTER,
  );

function capture(pt: PageText, quote: string, occurrence = 0) {
  let at = -1;
  for (let k = 0; k <= occurrence; k++) at = pt.text.indexOf(quote, at + 1);
  if (at < 0) throw new Error(`quote not in page: ${quote}`);
  const built = buildPdfAnchor({
    documentFingerprint: 'a'.repeat(64),
    pageNumber: 3,
    rotation: 0,
    pageText: pt,
    start: at,
    end: at + quote.length,
    rects: rectsForRange(pt, at, at + quote.length),
  });
  if (!built.ok) throw new Error(`capture failed: ${built.reason}`);
  return built;
}

const painted = (r: PdfResolution): boolean => r.rects.length > 0;

describe('buildPdfAnchor', () => {
  const pt = page([
    'The renal cortex contains glomeruli.',
    'Each glomerulus filters plasma into the nephron.',
    'Tubular reabsorption follows filtration.',
  ]);

  it('produces a schema-valid anchor with quote, context, position and signature', () => {
    const { anchorSet, exactQuote } = capture(pt, 'filters plasma into the nephron.');
    expect(PdfAnchorSet.safeParse(anchorSet).success).toBe(true);
    expect(exactQuote).toBe('filters plasma into the nephron.');
    expect(anchorSet.textQuote.prefix.endsWith('Each glomerulus ')).toBe(true);
    expect(anchorSet.textQuote.suffix.startsWith(' Tubular')).toBe(true);
    expect(anchorSet.textAlgorithm).toBe('sv-pdf-text-v1');
    expect(anchorSet.contentSignature).toBe(pt.signature);
    expect(anchorSet.documentTextLength).toBe(pt.text.length);
    expect(pt.text.slice(anchorSet.textPosition.start, anchorSet.textPosition.end)).toBe(
      exactQuote,
    );
  });

  it('trims surrounding whitespace and rejects an empty selection', () => {
    const at = pt.text.indexOf('Each');
    const ok = buildPdfAnchor({
      documentFingerprint: 'f'.repeat(64),
      pageNumber: 1,
      rotation: 0,
      pageText: pt,
      start: at - 1,
      end: at + 5,
      rects: [],
    });
    expect(ok.ok && ok.exactQuote).toBe('Each');
    const blank = buildPdfAnchor({
      documentFingerprint: 'f'.repeat(64),
      pageNumber: 1,
      rotation: 0,
      pageText: pt,
      start: 5,
      end: 5,
      rects: [],
    });
    expect(blank).toEqual({ ok: false, reason: 'empty' });
  });

  it('takes a selection across a line wrap as ONE contiguous quote with one rect per line', () => {
    const { anchorSet, exactQuote } = capture(pt, 'glomeruli. Each glomerulus filters');
    expect(exactQuote).toContain('glomeruli. Each');
    expect(anchorSet.rects).toHaveLength(2);
  });

  it('refuses a selection larger than the quote limit', () => {
    const big = page(Array.from({ length: 2 }, () => 'x '.repeat(6000)));
    const r = buildPdfAnchor({
      documentFingerprint: 'f'.repeat(64),
      pageNumber: 1,
      rotation: 0,
      pageText: big,
      start: 0,
      end: big.text.length,
      rects: [],
    });
    expect(r).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('resolvePdfAnchor', () => {
  const lines = [
    'Introduction to the physiology of the kidney.',
    'The renal cortex contains glomeruli.',
    'Each glomerulus filters plasma into the nephron.',
    'Tubular reabsorption follows filtration.',
  ];
  const original = page(lines);
  const { anchorSet } = capture(original, 'Each glomerulus filters plasma into the nephron.');

  it('unchanged page: resolves by position with full confidence and the stored rects', () => {
    const r = resolvePdfAnchor(anchorSet, original);
    expect(r).toMatchObject({ status: 'resolved', method: 'position', confidence: 1 });
    expect(r.rects).toEqual(anchorSet.rects);
  });

  it('text inserted above: still resolves (unique quote) and re-derives rects for the new place', () => {
    const edited = page(['A new preface line was added here.', ...lines]);
    const r = resolvePdfAnchor(anchorSet, edited);
    expect(r.status).toBe('resolved');
    expect(r.method).toBe('quote');
    expect(edited.text.slice(r.start!, r.end!)).toBe(anchorSet.textQuote.exact);
    expect(r.rects).not.toEqual(anchorSet.rects);
    expect(r.rects.length).toBeGreaterThan(0);
  });

  it('duplicates: the copy with matching context wins', () => {
    const dup = page([
      'Alpha beta. Take 5 mg daily. Gamma delta.',
      'Unrelated sentence in between the two.',
      'Epsilon zeta. Take 5 mg daily. Eta theta.',
    ]);
    const second = capture(dup, 'Take 5 mg daily.', 1).anchorSet;
    const edited = page([
      'A new line shifts everything down by one.',
      'Alpha beta. Take 5 mg daily. Gamma delta.',
      'Unrelated sentence in between the two.',
      'Epsilon zeta. Take 5 mg daily. Eta theta.',
    ]);
    const r = resolvePdfAnchor(second, edited);
    expect(r.status).toBe('resolved');
    expect(r.method).toBe('context');
    expect(edited.text.slice(r.start! - 14, r.start!)).toBe('Epsilon zeta. ');
  });

  it('identical copies with identical context are ambiguous and never painted', () => {
    const dup = page(['Same words here.', 'Same words here.', 'Same words here.']);
    const a = capture(dup, 'Same words here.', 1).anchorSet;
    // Four copies now: two of them have exactly the stored context on both sides.
    const shifted = page([
      'Preface.',
      'Same words here.',
      'Same words here.',
      'Same words here.',
      'Same words here.',
    ]);
    const r = resolvePdfAnchor(a, shifted);
    expect(r.status).toBe('ambiguous');
    expect(painted(r)).toBe(false);
    expect(r.start).toBeNull();
  });

  it('byte-identical page: position separates identical repeated passages', () => {
    const dup = page(['Same words here.', 'Same words here.', 'Same words here.']);
    for (const k of [0, 1, 2]) {
      const a = capture(dup, 'Same words here.', k).anchorSet;
      const r = resolvePdfAnchor(a, dup);
      expect(r).toMatchObject({ status: 'resolved', method: 'position' });
      expect(r.start).toBe(a.textPosition.start);
    }
  });

  it('a short quote that now only appears with different context is ambiguous', () => {
    const before = page([
      'See Figure 1 for the overview of the whole kidney.',
      'Other text follows below.',
    ]);
    const a = capture(before, 'Figure 1').anchorSet;
    const after = page([
      'Totally different page.',
      'The caption reads Figure 1 of an unrelated study.',
    ]);
    const r = resolvePdfAnchor(a, after);
    expect(r.status).toBe('ambiguous');
    expect(painted(r)).toBe(false);
  });

  it('quote gone and nothing under the rectangles: orphaned, not painted', () => {
    // Different words, and moved away from the stored rectangles too.
    const moved = buildPageText(
      [
        mk('Completely different content now.', 72, 100),
        mk('Nothing of the old text remains here.', 72, 86),
      ],
      LETTER,
    );
    const r = resolvePdfAnchor(anchorSet, moved);
    expect(r.status).toBe('orphaned');
    expect(painted(r)).toBe(false);
  });

  it('rect proximity: same place, text re-extracted differently, quote still inside it', () => {
    // The extractor now glues the sentence to a neighbour so the stream no longer holds the exact quote
    // surrounded the same way, but the words under the stored rectangles still contain it.
    const items: PageTextItem[] = [mk('Each glomerulus filters plasma into the nephron.', 72, 692)];
    // Replace one character so exact search fails but similarity is high.
    const edited = buildPageText(
      items.map((i) => ({ ...i, str: i.str.replace('plasma', 'plasmo') })),
      LETTER,
    );
    const r = resolvePdfAnchor(anchorSet, edited);
    expect(r.status).toBe('changed');
    expect(r.method).toBe('rects');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(painted(r)).toBe(true);
  });
});
