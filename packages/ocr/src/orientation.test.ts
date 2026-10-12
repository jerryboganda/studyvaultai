// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { OcrError } from './errors';
import {
  CONFIDENT_WORD,
  MIN_CONFIDENT_CHARS,
  ORIENTATION_BUDGET_MS,
  TRUSTED_CONFIDENCE,
  TURN_MARGIN,
  attemptOrder,
  chooseReading,
  lineDirectionFromProfiles,
  readingOf,
  recognizeUpright,
} from './orientation';
import type { OcrPage, OcrRotation } from './types';

/** A page whose words have the given [text, confidence]; the page confidence is their mean. */
function pageOf(words: Array<[string, number]>, orientation: OcrRotation = 0): OcrPage {
  const mean = words.length === 0 ? 0 : words.reduce((n, [, c]) => n + c, 0) / words.length;
  return {
    pageNumber: 1,
    width: 100,
    height: 100,
    rotation: orientation,
    ...(orientation ? { orientation } : {}),
    scale: null,
    confidence: mean,
    text: words.map(([t]) => t).join(' '),
    words: words.map(([text, confidence], line) => ({
      text,
      confidence,
      bbox: { x: 0, y: line * 10, w: 10, h: 5 },
      line,
    })),
    lines: [],
    engine: { name: 'tesseract', version: 'test', language: 'eng' },
    recognizedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Real text: confident words. Junk: many short fragments, low confidence. */
const GOOD = (): OcrPage =>
  pageOf([
    ['Technology', 92],
    ['Goals', 90],
    ['and', 88],
    ['Objectives', 91],
    ['Mitigate', 89],
    ['risk', 86],
  ]);
const JUNK = (): OcrPage =>
  pageOf([
    ['s', 41],
    ['(c)', 38],
    ['[7]', 35],
    ['NS', 44],
    ['0', 90],
    ['8', 30],
  ]);

describe('lineDirectionFromProfiles', () => {
  const stripes = (n: number, amplitude = 80): number[] =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0 : amplitude));
  const smooth = (n: number, level = 20): number[] => Array.from({ length: n }, () => level);

  it('says horizontal when the rows alternate between ink and paper and the columns do not', () => {
    expect(lineDirectionFromProfiles(stripes(330), smooth(255))).toBe('horizontal');
  });

  it('says vertical for the same page turned a quarter', () => {
    expect(lineDirectionFromProfiles(smooth(330), stripes(255))).toBe('vertical');
  });

  it('is unclear for a grid, a flat image and a blank page', () => {
    expect(lineDirectionFromProfiles(stripes(300), stripes(300))).toBe('unclear');
    expect(lineDirectionFromProfiles(smooth(300), smooth(300))).toBe('unclear');
    expect(lineDirectionFromProfiles(smooth(300, 0), smooth(300, 0))).toBe('unclear');
    expect(lineDirectionFromProfiles([], [])).toBe('unclear');
  });

  it('is unclear when one axis is only somewhat stronger (figures, charts, photographs)', () => {
    // 1.4x the energy of the other axis (amplitude 80 against 68): pages of text measured 2x and more.
    const rows = stripes(300, 80);
    const cols = stripes(300, 68);
    expect(lineDirectionFromProfiles(rows, cols)).toBe('unclear');
    expect(lineDirectionFromProfiles(cols, rows)).toBe('unclear');
    // 2.6x: a page of tables still counts as lines
    expect(lineDirectionFromProfiles(stripes(300, 80), stripes(300, 50))).toBe('horizontal');
    expect(lineDirectionFromProfiles(stripes(300, 50), stripes(300, 80))).toBe('vertical');
  });
});

describe('attemptOrder', () => {
  it('never lists more than four turns, each once, and 0 only where it can matter', () => {
    for (const direction of ['horizontal', 'vertical', 'unclear'] as const) {
      const order = attemptOrder(direction);
      expect(order.length).toBeLessThanOrEqual(4);
      expect(new Set(order).size).toBe(order.length);
    }
    expect(attemptOrder('horizontal')).toEqual([0, 180]);
    expect(attemptOrder('vertical')).toEqual([90, 270, 0]);
    expect(attemptOrder('unclear')).toEqual([0, 90, 270, 180]);
  });
});

describe('readingOf and chooseReading', () => {
  it('counts the characters of confidently read words only', () => {
    const r = readingOf(
      0,
      pageOf([
        ['hello', CONFIDENT_WORD],
        ['xx', CONFIDENT_WORD - 1],
        ['world', 99],
      ]),
    );
    expect(r.strong).toBe(10);
    expect(r.mean).toBeCloseTo((CONFIDENT_WORD + CONFIDENT_WORD - 1 + 99) / 3);
    expect(readingOf(0, pageOf([])).mean).toBe(0);
  });

  it('keeps the upright reading unless a turned one holds clearly more confident text', () => {
    const upright = readingOf(0, pageOf([['abcdefghij', 90]])); // 10 characters
    const near = readingOf(90, pageOf([['abcdefghijklmn', 90]])); // 14: under 1.5x
    const clear = readingOf(90, pageOf([['abcdefghijklmnop', 90]])); // 16: over 1.5x
    expect(TURN_MARGIN).toBe(1.5);
    expect(chooseReading([upright, near]).orientation).toBe(0);
    expect(chooseReading([upright, clear]).orientation).toBe(90);
    // order does not matter
    expect(chooseReading([clear, upright]).orientation).toBe(90);
  });

  it('is not turned by a few stray marks', () => {
    const upright = readingOf(0, pageOf([]));
    const marks = readingOf(180, pageOf([['ab', 95]]));
    expect(marks.strong).toBeLessThan(MIN_CONFIDENT_CHARS);
    expect(chooseReading([upright, marks]).orientation).toBe(0);
  });

  it('picks the best turned reading when the upright one was never made', () => {
    const a = readingOf(90, pageOf([['abcdefghijkl', 90]]));
    const b = readingOf(270, pageOf([['abcdefghijklmnopqrstuvwx', 90]]));
    expect(chooseReading([a, b]).orientation).toBe(270);
  });
});

describe('recognizeUpright', () => {
  function harness(
    pages: Partial<Record<OcrRotation, OcrPage | Error>>,
    extra: Partial<Parameters<typeof recognizeUpright>[0]> = {},
  ) {
    const calls: OcrRotation[] = [];
    const turned: Array<[OcrRotation, number]> = [];
    const run = (direction: 'horizontal' | 'vertical' | 'unclear') =>
      recognizeUpright({
        direction,
        recognize: async (turn) => {
          calls.push(turn);
          const out = pages[turn] ?? JUNK();
          if (out instanceof Error) throw out;
          return out;
        },
        onTurned: (turn, index) => turned.push([turn, index]),
        ...extra,
      });
    return { calls, turned, run };
  }

  it('reads an upright page once and checks nothing', async () => {
    const h = harness({ 0: GOOD() });
    const result = await h.run('horizontal');
    expect(h.calls).toEqual([0]);
    expect(h.turned).toEqual([]);
    expect(result.orientation).toBe(0);
    expect(readingOf(0, GOOD()).mean).toBeGreaterThanOrEqual(TRUSTED_CONFIDENCE);
  });

  it('turns a page whose lines run vertically straight away, and stops at the first good reading', async () => {
    const h = harness({
      90: pageOf(
        [
          ['Technology', 92],
          ['Goals', 90],
        ],
        90,
      ),
    });
    const result = await h.run('vertical');
    expect(h.calls).toEqual([90]);
    expect(h.turned).toEqual([[90, 0]]);
    expect(result.orientation).toBe(90);
    expect(result.page.orientation).toBe(90);
  });

  it('tries the other sideways turn before the page as shown', async () => {
    const h = harness({
      270: pageOf(
        [
          ['Technology', 92],
          ['Goals', 90],
        ],
        270,
      ),
    });
    const result = await h.run('vertical');
    expect(h.calls).toEqual([90, 270]);
    expect(result.orientation).toBe(270);
    expect(h.turned.map(([t]) => t)).toEqual([90, 270]);
  });

  it('reads an upside-down page with at most two readings', async () => {
    const h = harness({
      0: JUNK(),
      180: pageOf(
        [
          ['Technology', 92],
          ['Goals', 90],
        ],
        180,
      ),
    });
    const result = await h.run('horizontal');
    expect(h.calls).toEqual([0, 180]);
    expect(result.orientation).toBe(180);
    expect(h.turned).toEqual([[180, 1]]);
  });

  it('keeps the reading as shown when every turn is junk, and never makes more than four', async () => {
    const poor = pageOf([
      ['The', 72],
      ['quick', 55],
      ['brown', 58],
      ['fox', 52],
    ]);
    const h = harness({ 0: poor });
    const result = await h.run('unclear');
    expect(h.calls).toEqual([0, 90, 270, 180]);
    expect(h.calls.length).toBeLessThanOrEqual(4);
    expect(result.orientation).toBe(0);
    expect(result.page).toBe(poor);
    expect(result.readings).toHaveLength(4);
  });

  it('keeps a poor upright reading against junk turns of a page that looked upright', async () => {
    const poor = pageOf([
      ['faint', 50],
      ['photocopy', 45],
    ]);
    const h = harness({ 0: poor });
    expect((await h.run('horizontal')).orientation).toBe(0);
    expect(h.calls).toEqual([0, 180]);
  });

  it('stops when the time budget cannot cover another reading', async () => {
    let clock = 0;
    const calls: OcrRotation[] = [];
    await recognizeUpright({
      direction: 'unclear',
      budgetMs: 100_000,
      now: () => clock,
      recognize: async (turn) => {
        calls.push(turn);
        clock += 60_000; // a slow machine: a reading takes a minute
        return JUNK();
      },
    });
    // after one reading 60 s are spent and another 60 s would not fit in 100 s
    expect(calls).toEqual([0]);
    expect(ORIENTATION_BUDGET_MS).toBeGreaterThan(60_000);
  });

  it('lets an error of the first reading through (the caller retries as for any page)', async () => {
    const h = harness({ 90: new OcrError('out-of-memory', 'oom') });
    await expect(h.run('vertical')).rejects.toMatchObject({ code: 'out-of-memory' });
    expect(h.calls).toEqual([90]);
  });

  it('keeps the best reading so far when a later reading fails', async () => {
    const poor = pageOf([
      ['faint', 50],
      ['photocopy', 45],
    ]);
    const h = harness({ 0: poor, 180: new OcrError('failed', 'worker died') });
    const result = await h.run('horizontal');
    expect(result.page).toBe(poor);
    expect(result.orientation).toBe(0);
  });

  it('never swallows a cancellation', async () => {
    const poor = pageOf([['faint', 50]]);
    const h = harness({ 0: poor, 180: new OcrError('cancelled') });
    await expect(h.run('horizontal')).rejects.toMatchObject({ code: 'cancelled' });

    const controller = new AbortController();
    const calls: OcrRotation[] = [];
    await expect(
      recognizeUpright({
        direction: 'unclear',
        signal: controller.signal,
        recognize: async (turn) => {
          calls.push(turn);
          controller.abort();
          return poor;
        },
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toEqual([0]);
  });

  it('reports each turned reading before it starts', async () => {
    const onTurned = vi.fn();
    await recognizeUpright({
      direction: 'unclear',
      onTurned,
      recognize: async () => JUNK(),
    });
    expect(onTurned.mock.calls.map((c) => c[0])).toEqual([90, 270, 180]);
  });
});
