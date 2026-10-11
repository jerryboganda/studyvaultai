import { describe, expect, it } from 'vitest';
import { normalizeOcrWords, runOcr, type OcrPort } from './ocr';

describe('OCR port helpers', () => {
  it('normalises pixel boxes into the raw page frame and drops empty words', () => {
    const words = normalizeOcrWords(
      [
        { text: 'Hello', bbox: { x: 100, y: 50, w: 200, h: 40 } },
        { text: '  ', bbox: { x: 0, y: 0, w: 10, h: 10 } },
        { text: 'wide', bbox: { x: 900, y: 0, w: 400, h: 40 } },
      ],
      1000,
      500,
    );
    expect(words).toHaveLength(2);
    expect(words[0]).toMatchObject({ text: 'Hello', x: 0.1, y: 0.1, w: 0.2, h: 0.08 });
    // Boxes that run past the image are clamped into the unit square (schema-valid).
    expect(words[1]!.x + words[1]!.w).toBeLessThanOrEqual(1);
    expect(normalizeOcrWords([{ text: 'a', bbox: { x: 0, y: 0, w: 1, h: 1 } }], 0, 0)).toEqual([]);
  });

  const image = { width: 100, height: 100 } as unknown as ImageData;
  const port = (fail?: number): OcrPort & { cancelled: number } => ({
    cancelled: 0,
    async recognizePage(page) {
      if (page === fail) throw new Error('engine crashed');
      return {
        text: `page ${page}`,
        words: [{ text: `w${page}`, bbox: { x: 10, y: 10, w: 20, h: 10 } }],
      };
    },
    cancel() {
      this.cancelled++;
    },
  });

  it('runs pages in order, saves normalised words and reports progress', async () => {
    const saved: Array<[number, string, number]> = [];
    const progress: number[] = [];
    const res = await runOcr({
      pages: [2, 5, 9],
      port: port(),
      render: async () => image,
      save: async (page, result, words) => void saved.push([page, result.text, words.length]),
      onProgress: (d) => progress.push(d),
    });
    expect(res).toEqual({ done: [2, 5, 9], failed: [], cancelled: false });
    expect(saved).toEqual([
      [2, 'page 2', 1],
      [5, 'page 5', 1],
      [9, 'page 9', 1],
    ]);
    expect(progress).toEqual([1, 2, 3]);
  });

  it('one failing page does not stop the rest', async () => {
    const res = await runOcr({
      pages: [1, 2, 3],
      port: port(2),
      render: async () => image,
      save: async () => undefined,
    });
    expect(res.done).toEqual([1, 3]);
    expect(res.failed).toEqual([{ page: 2, message: 'engine crashed' }]);
  });

  it('cancelling stops the loop and tells the engine', async () => {
    const ac = new AbortController();
    const p = port();
    const res = await runOcr({
      pages: [1, 2, 3, 4],
      port: p,
      signal: ac.signal,
      render: async () => image,
      save: async (page) => {
        if (page === 2) ac.abort();
      },
    });
    expect(res.cancelled).toBe(true);
    expect(res.done).toEqual([1, 2]);
    expect(p.cancelled).toBe(1);
  });
});
