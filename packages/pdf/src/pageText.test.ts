import { describe, expect, it } from 'vitest';
import { buildPageText, rectsForRange, streamOffsetOf, type PageTextItem } from './pageText';
import { mk } from './testing/items';

const LETTER = { viewBox: [0, 0, 612, 792], rotate: 0 } as const;

describe('buildPageText: single column', () => {
  it('joins lines top to bottom with single spaces, whatever the content-stream order', () => {
    const pt = buildPageText(
      [mk('Third line.', 72, 680), mk('First line.', 72, 720), mk('Second line.', 72, 700)],
      LETTER,
    );
    expect(pt.text).toBe('First line. Second line. Third line.');
    expect(pt.order).toEqual([1, 2, 0]);
    expect([...pt.lineEnds]).toEqual([0, 1, 2]);
  });

  it('collapses whitespace like ADR-004 (tabs, NBSP, runs) and drops leading whitespace', () => {
    const pt = buildPageText([mk('  a\u00A0\u00A0b\t c ', 72, 700)], LETTER);
    expect(pt.text).toBe('a b c');
  });

  it('places items of one line in x order and inserts a space only at word gaps', () => {
    const pt = buildPageText(
      [mk('world', 120, 700), mk('Hel', 72, 700, 12, 18), mk('lo', 90, 700, 12, 12)],
      LETTER,
    );
    // "Hel"+"lo" touch (no space); "lo" ends at 102 and "world" starts at 120 (gap 18 > 0.12 em).
    expect(pt.text).toBe('Hello world');
  });

  it('keeps a superscript on its line without a separating space', () => {
    const pt = buildPageText([mk('E = mc', 72, 700, 12, 36), mk('2', 108, 705, 8, 4)], LETTER);
    expect(pt.text).toBe('E = mc2');
    expect(pt.lineEnds.size).toBe(1);
  });

  it('is deterministic and signs the stream', () => {
    const a = buildPageText([mk('Same text', 72, 700)], LETTER);
    const b = buildPageText([mk('Same text', 72, 700)], LETTER);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(buildPageText([mk('Other text', 72, 700)], LETTER).signature);
  });
});

describe('buildPageText: hyphenation', () => {
  it('joins a word split by a hyphen at the end of a line', () => {
    const pt = buildPageText([mk('The docu-', 72, 700), mk('ment is long.', 72, 686)], LETTER);
    expect(pt.text).toBe('The document is long.');
  });

  it('keeps the hyphen when the next line starts with a capital or a digit', () => {
    const upper = buildPageText([mk('Anglo-', 72, 700), mk('Saxon', 72, 686)], LETTER);
    expect(upper.text).toBe('Anglo- Saxon');
    const digit = buildPageText([mk('Item-', 72, 700), mk('12 here', 72, 686)], LETTER);
    expect(digit.text).toBe('Item- 12 here');
  });

  it('drops a soft hyphen at a line end', () => {
    const pt = buildPageText([mk('inter\u00AD', 72, 700), mk('esting', 72, 686)], LETTER);
    expect(pt.text).toBe('interesting');
  });
});

describe('buildPageText: columns', () => {
  const left = Array.from({ length: 6 }, (_, i) => mk(`left line ${i + 1} text`, 72, 700 - i * 14));
  const right = Array.from({ length: 6 }, (_, i) =>
    mk(`right line ${i + 1} text`, 330, 700 - i * 14),
  );
  // Content-stream order interleaves the columns, the way many PDF producers emit them.
  const interleaved = left.flatMap((l, i) => [l, right[i]!]);

  it('reads the left column before the right column', () => {
    const pt = buildPageText(interleaved, LETTER);
    const expected = [...left, ...right].map((i) => i.str).join(' ');
    expect(pt.text).toBe(expected);
  });

  it('keeps full-width lines between bands of columns', () => {
    const title = mk('A Study of Reading Order Across Columns', 150, 760, 16, 300);
    const caption = mk('Figure 1 spans both columns of the page.', 100, 600, 12, 400);
    const lowerLeft = [mk('lower left one', 72, 570), mk('lower left two', 72, 556)];
    const lowerRight = [mk('lower right one', 330, 570), mk('lower right two', 330, 556)];
    const pt = buildPageText([...lowerRight, caption, ...interleaved, title, ...lowerLeft], LETTER);
    const t = pt.text;
    expect(t.startsWith('A Study of Reading Order Across Columns left line 1 text')).toBe(true);
    expect(t.indexOf('left line 6 text')).toBeLessThan(t.indexOf('right line 1 text'));
    expect(t.indexOf('right line 6 text')).toBeLessThan(t.indexOf('Figure 1 spans'));
    expect(t.indexOf('Figure 1 spans')).toBeLessThan(t.indexOf('lower left one'));
    expect(t.indexOf('lower left two')).toBeLessThan(t.indexOf('lower right one'));
  });

  it('does not split a table that sits among full-width paragraphs', () => {
    const paragraph = Array.from({ length: 10 }, (_, i) =>
      mk(
        `paragraph line ${i + 1} fills the whole measure of the page width`,
        72,
        740 - i * 14,
        12,
        460,
      ),
    );
    const row = (y: number) => [mk('alpha', 72, y), mk('beta', 250, y), mk('gamma', 420, y)];
    const pt = buildPageText([...paragraph, ...row(560), ...row(546)], LETTER);
    expect(pt.text.endsWith('alpha beta gamma alpha beta gamma')).toBe(true);
  });
});

describe('buildPageText: rotation and geometry', () => {
  it('reads a /Rotate 90 page as it is displayed', () => {
    // Display is landscape; lines run along user-space +y and stack along user-space +x.
    const side = (str: string, x: number): PageTextItem => ({
      str,
      transform: [0, 12, -12, 0, x, 72],
      width: str.length * 6,
      height: 12,
      dir: 'ltr',
    });
    const pt = buildPageText([side('Second line', 140), side('First line', 100)], {
      viewBox: [0, 0, 612, 792],
      rotate: 90,
    });
    expect(pt.text).toBe('First line Second line');
  });

  it('stores raw-frame boxes that are normalised to the unrotated page', () => {
    const pt = buildPageText([mk('Hello', 72, 720, 12, 30)], LETTER);
    const box = pt.items[0]!.box;
    expect(box.x).toBeCloseTo(72 / 612, 4);
    expect(box.w).toBeCloseTo(30 / 612, 4);
    expect(box.y).toBeCloseTo((792 - 732) / 792, 3);
    expect(box.y + box.h).toBeLessThanOrEqual(1);
  });

  it('honours a non-zero view box origin', () => {
    const pt = buildPageText([mk('Hello', 172, 820, 12, 30)], {
      viewBox: [100, 100, 712, 892],
      rotate: 0,
    });
    expect(pt.items[0]!.box.x).toBeCloseTo(72 / 612, 4);
  });

  it('ignores items with unusable geometry instead of throwing', () => {
    const bad: PageTextItem = { str: 'x', transform: [NaN, 0, 0, 12, 0, 0], width: 1, height: 1 };
    const pt = buildPageText([bad, mk('kept', 72, 700)], LETTER);
    expect(pt.text).toBe('kept');
  });
});

describe('stream offsets', () => {
  const pt = buildPageText([mk('Hello  big world', 72, 700), mk('second', 72, 686)], LETTER);

  it('maps raw offsets of an item to stream offsets and back through rects', () => {
    expect(pt.text).toBe('Hello big world second');
    expect(streamOffsetOf(pt, 0, 0, 'start')).toBe(0);
    expect(streamOffsetOf(pt, 0, 3, 'start')).toBe(3);
    // raw 6 is inside the collapsed double space: forward for a start, backward for an end.
    expect(streamOffsetOf(pt, 0, 6, 'start')).toBe(6);
    expect(streamOffsetOf(pt, 0, 6, 'end')).toBe(5);
    // after the double space, raw 7 is "b": stream 6.
    expect(streamOffsetOf(pt, 0, 7, 'start')).toBe(6);
    expect(streamOffsetOf(pt, 1, 0, 'start')).toBe(pt.text.indexOf('second'));
    expect(streamOffsetOf(pt, 99, 0, 'start')).toBeNull();
  });

  it('derives line rects for a stream range', () => {
    const start = pt.text.indexOf('big');
    const rects = rectsForRange(pt, start, pt.text.length);
    expect(rects).toHaveLength(2); // the tail of line 1 and all of line 2
    expect(rects[0]!.y).toBeLessThan(rects[1]!.y);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildPageText: large pages and tables', () => {
  const dense = (wordsPerColumn: number, step: number) => {
    const items: PageTextItem[] = [];
    for (let line = 0; line < 300; line++) {
      for (let w = 0; w < wordsPerColumn * 2; w++) {
        const col = w < wordsPerColumn ? 72 : 330;
        items.push(mk(`w${line}_${w}`, col + (w % wordsPerColumn) * step, 760 - line * 2.4, 2, 5));
      }
    }
    return items;
  };

  it('reads a dense two-column page of 4,200 items column by column, well inside a frame', () => {
    const items = dense(7, 5.6); // 0.3 em word gaps at 2 pt text
    const t0 = performance.now();
    const pt = buildPageText(items, LETTER);
    const ms = performance.now() - t0;
    expect(pt.text.length).toBeGreaterThan(25_000);
    expect(pt.text.indexOf('w299_6')).toBeLessThan(pt.text.indexOf('w0_7'));
    expect(ms).toBeLessThan(1500);
  });

  it('a ruled table of aligned columns is read down the columns, widest gaps first (documented limit)', () => {
    // 20 aligned cells per row: every gap qualifies as a gutter, only the widest three are used.
    const pt = buildPageText(dense(10, 24), LETTER);
    // The wide gap between the two halves must be one of the cuts: the left half comes before the right.
    expect(pt.text.indexOf('w299_9')).toBeLessThan(pt.text.indexOf('w0_10'));
  });
});
