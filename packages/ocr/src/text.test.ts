import { PdfRect } from '@shared/schema';
import { describe, expect, it } from 'vitest';
import {
  applyCorrections,
  emptyCorrections,
  hasCorrections,
  parseCorrections,
  revertLine,
  revertWord,
  setLineText,
  setWordText,
} from './corrections';
import { buildPageTextStream, rectsForStreamRange } from './stream';
import type { OcrPage, OcrRotation, PixelBox } from './types';

/** Two lines on a 1000x500 image: "The quick brown" / "fox jumps". */
function page(rotation: OcrRotation = 0): OcrPage {
  const w = (text: string, x: number, y: number, width: number, line: number) => ({
    text,
    confidence: 80,
    bbox: { x, y, w: width, h: 20 } as PixelBox,
    line,
  });
  const words = [
    w('The', 100, 100, 60, 0),
    w('quick', 180, 100, 100, 0),
    w('brown', 300, 100, 100, 0),
    w('fox', 100, 140, 60, 1),
    w('jumps', 180, 140, 100, 1),
  ];
  return {
    pageNumber: 3,
    width: 1000,
    height: 500,
    rotation,
    scale: 2,
    confidence: 80,
    text: 'The quick brown\nfox jumps',
    words,
    lines: [
      {
        text: 'The quick brown',
        confidence: 80,
        bbox: { x: 100, y: 100, w: 300, h: 20 },
        first: 0,
        end: 3,
      },
      {
        text: 'fox jumps',
        confidence: 80,
        bbox: { x: 100, y: 140, w: 180, h: 20 },
        first: 3,
        end: 5,
      },
    ],
    engine: { name: 'tesseract', version: 'test', language: 'eng' },
    recognizedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('corrections', () => {
  it('a word edit changes the text and keeps the box, confidence becomes human-verified', () => {
    const p = page();
    const c = setWordText(emptyCorrections(), p, 1, '  qvick ');
    const words = applyCorrections(p, c);
    expect(words.map((x) => x.text)).toEqual(['The', 'qvick', 'brown', 'fox', 'jumps']);
    expect(words[1]).toMatchObject({
      text: 'qvick',
      bbox: p.words[1]!.bbox,
      source: 'word-edit',
      confidence: 100,
    });
    expect(words[0]!.source).toBe('ocr');
    // the recognised page is untouched
    expect(p.words[1]!.text).toBe('quick');
  });

  it('an empty word edit removes the word from text but keeps the other boxes', () => {
    const p = page();
    const c = setWordText(emptyCorrections(), p, 2, '');
    expect(applyCorrections(p, c).map((x) => x.text)).toEqual(['The', 'quick', 'fox', 'jumps']);
    expect(buildPageTextStream(p, c).text).toBe('The quick fox jumps');
  });

  it('a line edit replaces the line and splits its box proportionally to token length', () => {
    const p = page();
    const c = setLineText(emptyCorrections(), p, 1, 'fix  jumped');
    const words = applyCorrections(p, c).filter((x) => x.line === 1);
    expect(words.map((x) => x.text)).toEqual(['fix', 'jumped']);
    const [a, b] = words;
    // total 3 + 1 + 6 = 10 character cells over 180 px
    expect(a!.bbox).toEqual({ x: 100, y: 140, w: 54, h: 20 });
    expect(b!.bbox.x).toBeCloseTo(100 + (180 * 4) / 10);
    expect(b!.bbox.x + b!.bbox.w).toBeCloseTo(280);
    expect(words.every((x) => x.source === 'line-edit')).toBe(true);
  });

  it('a line edit supersedes (and clears) word edits inside that line only', () => {
    const p = page();
    let c = setWordText(emptyCorrections(), p, 0, 'A');
    c = setWordText(c, p, 3, 'cat');
    c = setLineText(c, p, 1, 'dog runs');
    expect(c.words).toEqual({ 0: 'A' });
    expect(c.lines).toEqual({ 1: 'dog runs' });
    expect(buildPageTextStream(p, c).text).toBe('A quick brown dog runs');
  });

  it('editing back to the OCR text removes the correction; revert helpers work', () => {
    const p = page();
    let c = setWordText(emptyCorrections(), p, 0, 'Tho');
    expect(hasCorrections(c)).toBe(true);
    c = setWordText(c, p, 0, 'The');
    expect(hasCorrections(c)).toBe(false);

    c = setLineText(emptyCorrections(), p, 0, 'changed');
    expect(hasCorrections(revertLine(c, 0))).toBe(false);
    c = setWordText(emptyCorrections(), p, 4, 'x');
    expect(hasCorrections(revertWord(c, 4))).toBe(false);
  });

  it('survives a JSON round trip (what IndexedDB / backup do) with boxes intact', () => {
    const p = page();
    let c = setWordText(emptyCorrections(), p, 1, 'quack');
    c = setLineText(c, p, 1, 'fox leaps');
    const restored = parseCorrections(JSON.parse(JSON.stringify(c)), {
      words: p.words.length,
      lines: p.lines.length,
    });
    expect(restored).toEqual(c);
    const stream = buildPageTextStream(p, restored);
    expect(stream.text).toBe('The quack brown fox leaps');
    expect(stream.items[1]!.bbox).toEqual(p.words[1]!.bbox);
  });

  it('parseCorrections drops anything that is not a valid edit', () => {
    const parsed = parseCorrections(
      {
        words: { 0: 'ok', 99: 'out of range', x: 'nan', 1: 42, '-1': 'neg', '1.5': 'frac' },
        lines: { 0: 'line', 7: 'out of range' },
        extra: 'ignored',
      },
      { words: 5, lines: 2 },
    );
    expect(parsed).toEqual({ words: { 0: 'ok' }, lines: { 0: 'line' } });
    expect(parseCorrections(null)).toEqual(emptyCorrections());
    expect(parseCorrections('nope')).toEqual(emptyCorrections());
  });

  it('rejects edits for indexes that do not exist', () => {
    const p = page();
    expect(() => setWordText(emptyCorrections(), p, 99, 'x')).toThrow(RangeError);
    expect(() => setLineText(emptyCorrections(), p, 9, 'x')).toThrow(RangeError);
  });
});

describe('buildPageTextStream rules', () => {
  it('joins words and lines with single spaces and slices back exactly', () => {
    const p = page();
    const stream = buildPageTextStream(p);
    expect(stream.text).toBe('The quick brown fox jumps');
    expect(stream.algorithm).toBe('sv-ocr-text-v1');
    for (const item of stream.items)
      expect(stream.text.slice(item.start, item.end)).toBe(item.text);
    expect(stream.items.map((i) => i.line)).toEqual([0, 0, 0, 1, 1]);
  });

  it('collapses whitespace inside words, drops empties, never leads or trails with a space', () => {
    const p = page();
    p.words[0]!.text = '  The\u00A0\n ';
    p.words[1]!.text = 'qu\tick';
    p.words[2]!.text = '   ';
    const stream = buildPageTextStream(p);
    expect(stream.text).toBe('The qu ick fox jumps');
    expect(stream.text.startsWith(' ')).toBe(false);
    expect(stream.text.endsWith(' ')).toBe(false);
    expect(stream.text).not.toMatch(/ {2}/);
  });

  it('keeps hyphens and does no Unicode normalisation', () => {
    const p = page();
    p.words[2]!.text = 'bro-';
    p.words[3]!.text = 'ﬁne'; // fi ligature must stay one char
    const stream = buildPageTextStream(p);
    expect(stream.text).toBe('The quick bro- ﬁne jumps');
  });

  it('is empty for a blank page', () => {
    const blank = { ...page(), words: [], lines: [], text: '' };
    expect(buildPageTextStream(blank)).toMatchObject({ text: '', items: [] });
  });

  it('maps every item to a valid PdfRect', () => {
    for (const rotation of [0, 90, 180, 270] as OcrRotation[]) {
      for (const item of buildPageTextStream(page(rotation)).items) {
        expect(PdfRect.safeParse(item.rect).success).toBe(true);
      }
    }
  });

  it('item rects follow the page rotation', () => {
    const upright = buildPageTextStream(page(0)).items[0]!.rect;
    expect(upright.x).toBeCloseTo(0.1);
    expect(upright.y).toBeCloseTo(0.2);
    expect(upright.w).toBeCloseTo(0.06);
    expect(upright.h).toBeCloseTo(0.04);
    const rotated = buildPageTextStream(page(90)).items[0]!.rect;
    // view x 0.1..0.16 -> page y = 1 - 0.16 = 0.84; view y 0.2..0.24 -> page x
    expect(rotated.x).toBeCloseTo(0.2);
    expect(rotated.y).toBeCloseTo(0.84);
    expect(rotated.w).toBeCloseTo(0.04);
    expect(rotated.h).toBeCloseTo(0.06);
  });
});

describe('rectsForStreamRange', () => {
  it('returns one rect per line covering whole words', () => {
    const stream = buildPageTextStream(page());
    // "quick brown fox" = offsets 4..19
    const rects = rectsForStreamRange(stream, 4, 19);
    expect(rects).toHaveLength(2);
    // quick..brown: x 180..400 of 1000, y 100..120 of 500
    expect(rects[0]!.x).toBeCloseTo(0.18);
    expect(rects[0]!.y).toBeCloseTo(0.2);
    expect(rects[0]!.w).toBeCloseTo(0.22);
    expect(rects[0]!.h).toBeCloseTo(0.04);
    expect(rects[1]!.x).toBeCloseTo(0.1);
    expect(rects[1]!.w).toBeCloseTo(0.06);
    expect(rects.every((r) => PdfRect.safeParse(r).success)).toBe(true);
  });

  it('trims words cut by the range proportionally', () => {
    const stream = buildPageTextStream(page());
    // "quick" is offsets 4..9; take "uic" = 5..8 -> chars 1..4 of 5 -> x 180+20 .. 180+80
    const [rect] = rectsForStreamRange(stream, 5, 8);
    expect(rect!.x).toBeCloseTo(0.2);
    expect(rect!.w).toBeCloseTo(0.06);
  });

  it('is empty for an empty or out of range selection', () => {
    const stream = buildPageTextStream(page());
    expect(rectsForStreamRange(stream, 3, 3)).toEqual([]);
    expect(rectsForStreamRange(stream, 100, 120)).toEqual([]);
  });

  it('uses the corrected text offsets', () => {
    const p = page();
    const c = setWordText(emptyCorrections(), p, 1, 'qu');
    const stream = buildPageTextStream(p, c);
    expect(stream.text).toBe('The qu brown fox jumps');
    // "brown" now starts at 7
    const [rect] = rectsForStreamRange(stream, 7, 12);
    expect(rect!.x).toBeCloseTo(0.3);
    expect(rect!.w).toBeCloseTo(0.1);
  });

  it('trims along the text direction on a rotated page', () => {
    const stream = buildPageTextStream(page(90));
    // "The" = 0..3; first character only -> a third of the word's 60 px width
    const [rect] = rectsForStreamRange(stream, 0, 1);
    // text runs along image x; at rotation 90 that is page y (height of the rect)
    expect(rect!.h).toBeCloseTo(0.02);
    expect(rect!.w).toBeCloseTo(0.04);
  });
});
