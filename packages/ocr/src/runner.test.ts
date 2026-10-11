// @vitest-environment node
import type { OcrPort as ReaderOcrPort } from '@pdf/ocr';
import { PdfRect } from '@shared/schema';
import { describe, expect, it, vi } from 'vitest';
import { createOcrEngine } from './engine';
import { OcrError } from './errors';
import { FakeTesseract, tesseractData } from './fakeWorker';
import { createOcrPort, runOcrJob } from './runner';
import type { OcrJobProgress, OcrJobSummary, RenderedPage } from './runner';
import type { OcrImageSource, OcrJobStore, OcrPage, RecognizeOptions } from './types';

function pageFor(pageNumber: number, text = `page ${pageNumber}`): OcrPage {
  return {
    pageNumber,
    width: 1000,
    height: 500,
    rotation: 0,
    scale: 1,
    confidence: 90,
    text,
    words: [{ text, confidence: 90, bbox: { x: 100, y: 100, w: 200, h: 20 }, line: 0 }],
    lines: [{ text, confidence: 90, bbox: { x: 100, y: 100, w: 200, h: 20 }, first: 0, end: 1 }],
    engine: { name: 'tesseract', version: 'test', language: 'eng' },
    recognizedAt: '2026-01-01T00:00:00.000Z',
  };
}

function memoryStore(initial: number[] = []) {
  const stored = new Set(initial);
  const saved: OcrPage[] = [];
  const store: OcrJobStore & { failSaves: number } = {
    failSaves: 0,
    storedPageNumbers: async () => [...stored],
    saveOcrPage: async (page) => {
      if (store.failSaves > 0) {
        store.failSaves -= 1;
        throw new Error('QuotaExceededError');
      }
      saved.push(page);
      stored.add(page.pageNumber);
    },
  };
  return { store, saved, stored };
}

type Engine = { recognize(source: OcrImageSource, options?: RecognizeOptions): Promise<OcrPage> };

function setup(
  behaviour: (
    page: number,
    attempt: number,
    options: RecognizeOptions,
  ) => Promise<OcrPage> | OcrPage,
  initial: number[] = [],
) {
  const attempts = new Map<number, number>();
  const calls: number[] = [];
  const engine: Engine = {
    async recognize(_source, options = {}) {
      const n = options.pageNumber ?? 0;
      calls.push(n);
      const attempt = (attempts.get(n) ?? 0) + 1;
      attempts.set(n, attempt);
      options.onProgress?.({ pageNumber: n, phase: 'recognizing', progress: 0 });
      options.onProgress?.({ pageNumber: n, phase: 'recognizing', progress: 0.5 });
      const page = await behaviour(n, attempt, options);
      options.onProgress?.({ pageNumber: n, phase: 'recognizing', progress: 1 });
      return page;
    },
  };
  const released: number[] = [];
  const renderPage = vi.fn(async (n: number): Promise<RenderedPage> => ({
    image: new Uint8Array([n]),
    width: 100,
    height: 50,
    rotation: 90,
    scale: 2,
    release: () => released.push(n),
  }));
  const mem = memoryStore(initial);
  const events: OcrJobProgress[] = [];
  const run = (
    pages: number[],
    extra: Partial<Parameters<typeof runOcrJob>[0]> = {},
  ): Promise<OcrJobSummary> =>
    runOcrJob({
      pages,
      renderPage,
      engine,
      store: mem.store,
      onProgress: (e) => events.push(e),
      ...extra,
    });
  return { run, calls, attempts, released, renderPage, events, ...mem };
}

describe('runOcrJob', () => {
  it('recognises pages in order, saves each, and reports monotonic 0..1 progress', async () => {
    const t = setup((n) => pageFor(n));
    const summary = await t.run([3, 1, 2, 2]);
    expect(summary).toMatchObject({
      status: 'completed',
      requested: 3,
      skipped: [],
      saved: [1, 2, 3],
      failed: [],
    });
    expect(t.calls).toEqual([1, 2, 3]);
    expect(t.saved.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    const progress = t.events.map((e) => e.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
    expect(t.events.at(-1)).toMatchObject({ phase: 'done', completed: 3, total: 3 });
    expect(t.events.filter((e) => e.phase === 'saved').map((e) => e.completed)).toEqual([1, 2, 3]);
    // rendering parameters reach the engine; every rendered page is released
    expect(t.released).toEqual([1, 2, 3]);
    expect(Math.max(...progress)).toBeLessThanOrEqual(1);
  });

  it('passes rotation, scale, size and the abort signal to the engine', async () => {
    const seen: RecognizeOptions[] = [];
    const t = setup((n, _a, options) => {
      seen.push(options);
      return pageFor(n);
    });
    await t.run([5]);
    expect(seen[0]).toMatchObject({
      pageNumber: 5,
      rotation: 90,
      scale: 2,
      width: 100,
      height: 50,
    });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('resumes: pages already stored are skipped and counted as done', async () => {
    const t = setup((n) => pageFor(n), [1, 2]);
    const summary = await t.run([1, 2, 3, 4]);
    expect(t.calls).toEqual([3, 4]);
    expect(summary).toMatchObject({ status: 'completed', skipped: [1, 2], saved: [3, 4] });
    const first = t.events[0]!;
    expect(first).toMatchObject({ phase: 'skipped', completed: 2, total: 4, progress: 0.5 });
  });

  it('completes immediately when everything is already stored', async () => {
    const t = setup((n) => pageFor(n), [1, 2]);
    const summary = await t.run([1, 2]);
    expect(summary).toMatchObject({ status: 'completed', saved: [], skipped: [1, 2] });
    expect(t.calls).toEqual([]);
    expect(t.events.at(-1)).toMatchObject({ phase: 'done', progress: 1 });
  });

  it('survives a cancel: keeps what was saved and a re-run continues from there', async () => {
    const controller = new AbortController();
    const t = setup((n) => pageFor(n));
    const first = await runOcrJob({
      pages: [1, 2, 3, 4],
      renderPage: async (n) => new Uint8Array([n]),
      engine: {
        async recognize(_s, o = {}) {
          const n = o.pageNumber ?? 0;
          if (n === 2) {
            controller.abort();
            throw new OcrError('cancelled');
          }
          return pageFor(n);
        },
      },
      store: t.store,
      signal: controller.signal,
    });
    expect(first.status).toBe('cancelled');
    expect(first.saved).toEqual([1]);
    expect(first.failed).toEqual([]);
    expect(t.saved.map((p) => p.pageNumber)).toEqual([1]);

    const again = await t.run([1, 2, 3, 4]);
    expect(again).toMatchObject({ status: 'completed', skipped: [1], saved: [2, 3, 4] });
  });

  it('does not start when the signal is already aborted', async () => {
    const t = setup((n) => pageFor(n));
    const controller = new AbortController();
    controller.abort();
    const summary = await t.run([1, 2], { signal: controller.signal });
    expect(summary.status).toBe('cancelled');
    expect(t.calls).toEqual([]);
  });

  it('retries a page once after a worker crash and then succeeds', async () => {
    const t = setup((n, attempt) => {
      if (n === 2 && attempt === 1) throw new OcrError('failed', 'worker crashed');
      return pageFor(n);
    });
    const summary = await t.run([1, 2, 3]);
    expect(summary.status).toBe('completed');
    expect(t.attempts.get(2)).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(t.released).toEqual([1, 2, 2, 3]);
  });

  it('gives up on a page after the retry and carries on with the rest', async () => {
    const t = setup((n) => {
      if (n === 2) throw new OcrError('out-of-memory', 'oom');
      return pageFor(n);
    });
    const summary = await t.run([1, 2, 3]);
    expect(t.attempts.get(2)).toBe(2);
    expect(summary.status).toBe('partial');
    expect(summary.saved).toEqual([1, 3]);
    expect(summary.failed).toEqual([
      expect.objectContaining({ pageNumber: 2, code: 'out-of-memory', attempts: 2 }),
    ]);
    expect(t.events.at(-1)).toMatchObject({ phase: 'done', completed: 3, progress: 1 });
  });

  it('stops at once on an error that would repeat for every page', async () => {
    for (const code of ['asset-missing', 'wasm-unsupported'] as const) {
      const t = setup(() => {
        throw new OcrError(code, 'x');
      });
      const summary = await t.run([1, 2, 3]);
      expect(summary.status).toBe('failed');
      expect(summary.error?.code).toBe(code);
      expect(t.calls).toEqual([1]);
      expect(summary.error?.message).toMatch(/^[A-Z]/);
    }
  });

  it('retries a failed render and reports an unrenderable page', async () => {
    const t = setup((n) => pageFor(n));
    t.renderPage.mockImplementation(async (n: number) => {
      if (n === 2) throw new Error('page tree is corrupt');
      return { image: new Uint8Array([n]), width: 100, height: 50, release: () => undefined };
    });
    const summary = await t.run([1, 2]);
    expect(t.renderPage).toHaveBeenCalledTimes(3);
    expect(summary.status).toBe('partial');
    expect(summary.failed[0]).toMatchObject({ pageNumber: 2, code: 'failed', attempts: 2 });
  });

  it('retries one failed save immediately; two failures stop the job without losing earlier pages', async () => {
    const t = setup((n) => pageFor(n));
    t.store.failSaves = 1;
    const ok = await t.run([1, 2]);
    expect(ok).toMatchObject({ status: 'completed', saved: [1, 2] });
    expect(t.calls).toEqual([1, 2]); // the save retry did not re-run OCR

    const t2 = setup((n) => pageFor(n));
    t2.store.failSaves = 2;
    const bad = await t2.run([1, 2]);
    expect(bad.status).toBe('failed');
    expect(bad.saved).toEqual([]);
    expect(bad.error?.detail).toContain('page 1');
    expect(t2.calls).toEqual([1]);
  });

  it('reports a store that cannot be read', async () => {
    const t = setup((n) => pageFor(n));
    t.store.storedPageNumbers = async () => {
      throw new Error('db closed');
    };
    const summary = await t.run([1]);
    expect(summary.status).toBe('failed');
    expect(t.calls).toEqual([]);
  });

  it('rejects page numbers that are not positive integers', async () => {
    const t = setup((n) => pageFor(n));
    await expect(t.run([0])).rejects.toThrow(RangeError);
    await expect(t.run([1.5])).rejects.toThrow(RangeError);
  });

  it('ignores a throwing progress consumer', async () => {
    const t = setup((n) => pageFor(n));
    const summary = await t.run([1], {
      onProgress: () => {
        throw new Error('ui bug');
      },
    });
    expect(summary.status).toBe('completed');
  });

  it('works end to end with the real engine: crash, fresh worker, retry, resume', async () => {
    const fake = new FakeTesseract();
    let crashed = false;
    fake.onRecognize = (job) => {
      const page = job.image[0]!;
      if (page === 2 && !crashed) {
        crashed = true;
        job.worker.crash('Uncaught RuntimeError: memory access out of bounds');
        return;
      }
      job.resolve(tesseractData([[{ text: `p${page}`, x0: 10, y0: 10, x1: 50, y1: 30 }]]));
    };
    const engine = createOcrEngine({
      assetBaseUrl: 'chrome-extension://abc/ocr/',
      createWorker: fake.createWorker,
      idleTimeoutMs: 0,
      jobTimeoutMs: 0,
    });
    const { store, saved } = memoryStore();
    const summary = await runOcrJob({
      pages: [1, 2, 3],
      renderPage: async (n) => ({ image: new Uint8Array([n]), width: 100, height: 50 }),
      engine,
      store,
    });
    expect(summary).toMatchObject({ status: 'completed', saved: [1, 2, 3] });
    expect(fake.created).toHaveLength(2); // the crashed worker was replaced
    expect(fake.workers[0]!.terminated).toBe(true);
    expect(saved.map((p) => p.words[0]!.text)).toEqual(['p1', 'p2', 'p3']);
    await engine.terminate();
  });
});

describe('createOcrPort', () => {
  it('returns the page text stream and normalised word boxes', async () => {
    const page: OcrPage = {
      ...pageFor(7),
      rotation: 0,
      words: [
        { text: 'Hello', confidence: 95, bbox: { x: 100, y: 50, w: 250, h: 50 }, line: 0 },
        { text: 'world', confidence: 90, bbox: { x: 400, y: 50, w: 250, h: 50 }, line: 0 },
      ],
      lines: [
        {
          text: 'Hello world',
          confidence: 90,
          bbox: { x: 100, y: 50, w: 550, h: 50 },
          first: 0,
          end: 2,
        },
      ],
    };
    const recognize = vi.fn(async (_source: OcrImageSource, _options?: RecognizeOptions) => page);
    const release = vi.fn();
    const port = createOcrPort({ recognize });
    const result = await port.recognizePage(7, {
      image: new Uint8Array([1]),
      width: 1000,
      height: 500,
      release,
    });
    expect(result.text).toBe('Hello world');
    expect(result.words).toHaveLength(2);
    expect(result.words[0]).toMatchObject({
      text: 'Hello',
      confidence: 95,
      // the reader's contract: pixels of the image passed in
      bbox: { x: 100, y: 50, w: 250, h: 50 },
    });
    expect(result.words[0]!.rect.x).toBeCloseTo(0.1);
    expect(result.words[0]!.rect.w).toBeCloseTo(0.25);
    expect(result.words.every((w) => PdfRect.safeParse(w.rect).success)).toBe(true);
    expect(result).toMatchObject({ language: 'eng', engine: 'tesseract test' });
    expect(result.confidence).toBeCloseTo(0.9);
    expect(result.page).toBe(page);
    expect(release).toHaveBeenCalledTimes(1);
    expect(recognize.mock.calls[0]![1]).toMatchObject({ pageNumber: 7, width: 1000, height: 500 });
  });

  it('is assignable to the PDF reader OcrPort (compile-time contract)', async () => {
    const port: ReaderOcrPort = createOcrPort({ recognize: async () => pageFor(1) });
    const result = await port.recognizePage(1, { width: 10, height: 10 } as unknown as ImageData);
    expect(result.words[0]!.bbox).toEqual({ x: 100, y: 100, w: 200, h: 20 });
  });

  it('accepts a bare image source and lets per-call options override', async () => {
    const recognize = vi.fn(async (_source: OcrImageSource, _options?: RecognizeOptions) =>
      pageFor(1),
    );
    const port = createOcrPort({ recognize });
    await port.recognizePage(1, new Uint8Array([1]), {
      rotation: 180,
      scale: 3,
      width: 10,
      height: 5,
    });
    expect(recognize.mock.calls[0]![1]).toMatchObject({
      rotation: 180,
      scale: 3,
      width: 10,
      height: 5,
    });
  });

  it('cancel() aborts every call in flight', async () => {
    const aborted: boolean[] = [];
    const engine: Engine = {
      recognize: (_s, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => {
            aborted.push(true);
            reject(new OcrError('cancelled'));
          });
        }),
    };
    const port = createOcrPort(engine);
    const a = port.recognizePage(1, new Uint8Array([1]), { width: 1, height: 1 });
    const b = port.recognizePage(2, new Uint8Array([2]), { width: 1, height: 1 });
    port.cancel();
    await expect(a).rejects.toMatchObject({ code: 'cancelled', name: 'AbortError' });
    await expect(b).rejects.toMatchObject({ code: 'cancelled' });
    expect(aborted).toHaveLength(2);

    // the port is usable again afterwards
    const ok = createOcrPort({ recognize: async () => pageFor(3) });
    ok.cancel();
    expect(
      (await ok.recognizePage(3, new Uint8Array([3]), { width: 1, height: 1 })).page.pageNumber,
    ).toBe(3);
  });
});
