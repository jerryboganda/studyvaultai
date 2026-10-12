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

  describe('force: reading stored pages again', () => {
    it('reads every requested page, skips nothing and does not ask the store what it has', async () => {
      const t = setup((n) => pageFor(n, `new ${n}`), [1, 2]);
      const asked = vi.spyOn(t.store, 'storedPageNumbers');
      const summary = await t.run([1, 2, 3], { force: true });
      expect(summary).toMatchObject({ status: 'completed', skipped: [], saved: [1, 2, 3] });
      expect(t.calls).toEqual([1, 2, 3]);
      expect(asked).not.toHaveBeenCalled();
      expect(t.saved.map((p) => p.text)).toEqual(['new 1', 'new 2', 'new 3']);
      expect(t.events.some((e) => e.phase === 'skipped')).toBe(false);
      expect(t.events.at(-1)).toMatchObject({ phase: 'done', completed: 3, total: 3, progress: 1 });
    });

    it('saves a page only after its new reading succeeded: a failing page is never touched', async () => {
      const t = setup(
        (n) => {
          if (n === 2) throw new OcrError('out-of-memory');
          return pageFor(n, `new ${n}`);
        },
        [1, 2, 3],
      );
      const summary = await t.run([1, 2, 3], { force: true });
      expect(summary.status).toBe('partial');
      expect(summary.failed.map((f) => f.pageNumber)).toEqual([2]);
      // page 2 was never handed to the store, so whatever it holds is still there
      expect(t.saved.map((p) => p.pageNumber)).toEqual([1, 3]);
      expect(summary.saved).toEqual([1, 3]);
    });

    it('a cancel leaves the pages that were not reached untouched', async () => {
      const controller = new AbortController();
      const t = setup(
        (n) => {
          if (n === 3) {
            controller.abort();
            throw new OcrError('cancelled');
          }
          return pageFor(n, `new ${n}`);
        },
        [1, 2, 3, 4],
      );
      const summary = await t.run([1, 2, 3, 4], { force: true, signal: controller.signal });
      expect(summary.status).toBe('cancelled');
      expect(t.saved.map((p) => p.pageNumber)).toEqual([1, 2]);
      expect(t.calls).toEqual([1, 2, 3]); // page 4 was never read
    });

    it('a render failure keeps the stored page and the run goes on', async () => {
      const t = setup((n) => pageFor(n, `new ${n}`), [1, 2]);
      t.renderPage.mockImplementation(async (n: number) => {
        if (n === 1) throw new Error('render exploded');
        return { image: new Uint8Array([n]), width: 100, height: 50 };
      });
      const summary = await t.run([1, 2], { force: true });
      expect(summary.saved).toEqual([2]);
      expect(summary.failed.map((f) => f.pageNumber)).toEqual([1]);
      expect(t.saved.map((p) => p.pageNumber)).toEqual([2]);
    });
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

describe('runOcrJob: scans stored sideways or upside down', () => {
  const words = (list: Array<[string, number]>): OcrPage['words'] =>
    list.map(([text, confidence], i) => ({
      text,
      confidence,
      bbox: { x: 10, y: 10 + i * 20, w: 100, h: 15 },
      line: 0,
    }));
  const GOOD: Array<[string, number]> = [
    ['Technology', 92],
    ['Goals', 90],
    ['and', 88],
    ['Objectives', 91],
  ];
  const JUNK: Array<[string, number]> = [
    ['s', 41],
    ['(c)', 38],
    ['NS', 44],
  ];

  /** An engine whose reading depends on the turn it was asked for (what the real one does). */
  function turnedEngine(read: Partial<Record<number, Array<[string, number]> | Error>>) {
    const asked: Array<{ page: number; orientation: number; rotation: number }> = [];
    const engine: Engine = {
      async recognize(_source, options = {}) {
        const orientation = options.orientation ?? 0;
        asked.push({
          page: options.pageNumber ?? 0,
          orientation,
          rotation: options.rotation ?? 0,
        });
        options.onProgress?.({
          pageNumber: options.pageNumber ?? 0,
          phase: 'recognizing',
          progress: 0.5,
        });
        const out = read[orientation] ?? JUNK;
        if (out instanceof Error) throw out;
        const list = words(out);
        const mean = list.reduce((n, w) => n + w.confidence, 0) / list.length;
        const base = pageFor(options.pageNumber ?? 1);
        return {
          ...base,
          rotation: (((options.rotation ?? 0) + orientation) % 360) as 0 | 90 | 180 | 270,
          ...(orientation ? { orientation: orientation as 90 | 180 | 270 } : {}),
          confidence: mean,
          words: list,
          text: out.map(([t]) => t).join(' '),
        };
      },
    };
    return { engine, asked };
  }

  const run = (
    engine: Engine,
    direction: 'horizontal' | 'vertical' | 'unclear' | null,
    extra: Partial<Parameters<typeof runOcrJob>[0]> = {},
  ) => {
    const mem = memoryStore();
    const events: OcrJobProgress[] = [];
    const lineDirection = vi.fn(() => direction);
    const summary = runOcrJob({
      pages: [1],
      renderPage: async (n) => ({
        image: new Uint8Array([n]),
        width: 100,
        height: 50,
        rotation: 270,
      }),
      engine,
      store: mem.store,
      lineDirection,
      onProgress: (e) => events.push(e),
      ...extra,
    });
    return { summary, events, lineDirection, ...mem };
  };

  it('reads a page whose lines run vertically after turning it, and records the turn', async () => {
    const t = turnedEngine({ 90: GOOD });
    const r = run(t.engine, 'vertical');
    const summary = await r.summary;
    expect(summary).toMatchObject({
      status: 'completed',
      saved: [1],
      reoriented: [{ pageNumber: 1, orientation: 90 }],
    });
    // one reading, at the first turn, with the page's own /Rotate passed along
    expect(t.asked).toEqual([{ page: 1, orientation: 90, rotation: 270 }]);
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0]).toMatchObject({
      orientation: 90,
      rotation: 0,
      text: 'Technology Goals and Objectives',
    });
    expect(r.events.some((e) => e.phase === 'orienting' && e.pageNumber === 1)).toBe(true);
    const progress = r.events.map((e) => e.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
  });

  it('tries the other sideways turn when the first is junk', async () => {
    const t = turnedEngine({ 270: GOOD });
    const r = run(t.engine, 'vertical');
    const summary = await r.summary;
    expect(t.asked.map((a) => a.orientation)).toEqual([90, 270]);
    expect(summary.reoriented).toEqual([{ pageNumber: 1, orientation: 270 }]);
    expect(r.saved[0]).toMatchObject({ orientation: 270 });
  });

  it('reads an upside-down page as shown first, then turned 180', async () => {
    const t = turnedEngine({ 180: GOOD });
    const r = run(t.engine, 'horizontal');
    const summary = await r.summary;
    expect(t.asked.map((a) => a.orientation)).toEqual([0, 180]);
    expect(summary.reoriented).toEqual([{ pageNumber: 1, orientation: 180 }]);
    expect(r.events.filter((e) => e.phase === 'orienting')).toHaveLength(1);
  });

  it('does nothing extra for a page that reads well: one reading, no orienting phase', async () => {
    const t = turnedEngine({ 0: GOOD });
    const r = run(t.engine, 'horizontal');
    const summary = await r.summary;
    expect(t.asked).toHaveLength(1);
    expect(summary.reoriented).toEqual([]);
    expect(r.events.some((e) => e.phase === 'orienting')).toBe(false);
    expect('orientation' in r.saved[0]!).toBe(false); // read as shown: a page stored before this change looks the same
  });

  it('never makes more than four readings of a page, and keeps the one as shown when none is better', async () => {
    const t = turnedEngine({});
    const r = run(t.engine, 'unclear');
    const summary = await r.summary;
    expect(t.asked.map((a) => a.orientation)).toEqual([0, 90, 270, 180]);
    expect(summary).toMatchObject({ status: 'completed', reoriented: [] });
    expect(r.saved[0]).toMatchObject({ rotation: 270 });
    expect('orientation' in r.saved[0]!).toBe(false);
  });

  it('can be switched off, and is not attempted when the image cannot be judged', async () => {
    const t = turnedEngine({ 90: GOOD });
    const off = run(t.engine, 'vertical', { checkOrientation: false });
    await off.summary;
    expect(off.lineDirection).not.toHaveBeenCalled();
    expect(t.asked.map((a) => a.orientation)).toEqual([0]);

    const t2 = turnedEngine({ 90: GOOD });
    const unknown = run(t2.engine, null);
    await unknown.summary;
    expect(t2.asked.map((a) => a.orientation)).toEqual([0]);
  });

  it('keeps the page and the job when a turned reading fails', async () => {
    const poor: Array<[string, number]> = [
      ['faint', 50],
      ['copy', 45],
    ];
    const t = turnedEngine({ 0: poor, 180: new OcrError('failed', 'worker died') });
    const r = run(t.engine, 'horizontal');
    const summary = await r.summary;
    expect(summary).toMatchObject({ status: 'completed', saved: [1], failed: [], reoriented: [] });
    expect(r.saved[0]!.text).toBe('faint copy');
  });

  it('cancels in the middle of an orientation check: nothing is saved and a re-run reads the page', async () => {
    const controller = new AbortController();
    const asked: number[] = [];
    const engine: Engine = {
      async recognize(_s, options = {}) {
        asked.push(options.orientation ?? 0);
        if ((options.orientation ?? 0) === 90) {
          controller.abort();
          throw new OcrError('cancelled');
        }
        return {
          ...pageFor(1),
          confidence: 40,
          words: words(JUNK),
          text: 's (c) NS',
        };
      },
    };
    const r = run(engine, 'unclear', { signal: controller.signal });
    const summary = await r.summary;
    expect(summary.status).toBe('cancelled');
    expect(asked).toEqual([0, 90]);
    expect(r.saved).toEqual([]);

    // resume: the page is still to do and is read now
    const t = turnedEngine({ 0: GOOD });
    const again = await runOcrJob({
      pages: [1],
      renderPage: async () => ({ image: new Uint8Array([1]), width: 100, height: 50 }),
      engine: t.engine,
      store: r.store,
      lineDirection: () => 'horizontal',
    });
    expect(again).toMatchObject({ status: 'completed', saved: [1] });
  });

  it('is exposed as part of the engine path: real engine, fake canvases, boxes land on the page', async () => {
    // A 400 x 200 canvas (the page as shown, /Rotate 270). Its text runs bottom to top once shown,
    // so turned 90 clockwise it reads. The fake recogniser reads junk for any other image.
    class Canvas {
      transform: number[] | null = null;
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          imageSmoothingQuality: 'low',
          setTransform: (...t: number[]) => {
            this.transform = t;
          },
          drawImage: () => undefined,
        };
      }
      convertToBlob() {
        // a clockwise quarter has (a, b, c, d) = (0, 1, -1, 0)
        const quarter = this.transform?.[1] === 1 && this.transform?.[2] === -1;
        return Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71, quarter ? 90 : 0])]));
      }
    }
    vi.stubGlobal('OffscreenCanvas', Canvas);
    try {
      const fake = new FakeTesseract();
      fake.onRecognize = (job) =>
        job.resolve(
          job.image[4] === 90
            ? tesseractData(
                [[{ text: 'Technology', x0: 20, y0: 10, x1: 120, y1: 30, confidence: 93 }]],
                93,
              )
            : tesseractData([[{ text: 'x', x0: 5, y0: 5, x1: 9, y1: 9, confidence: 30 }]], 30),
        );
      const engine = createOcrEngine({
        assetBaseUrl: 'chrome-extension://abc/ocr/',
        createWorker: fake.createWorker,
        idleTimeoutMs: 0,
        jobTimeoutMs: 0,
      });
      const { store, saved } = memoryStore();
      const summary = await runOcrJob({
        pages: [1],
        renderPage: async () => ({
          image: new Canvas(400, 200) as unknown as OffscreenCanvas,
          rotation: 0,
        }),
        engine,
        store,
        lineDirection: () => 'vertical',
      });
      expect(summary).toMatchObject({
        status: 'completed',
        reoriented: [{ pageNumber: 1, orientation: 90 }],
      });
      // the turned image is 200 x 400; a word at x 20..120, y 10..30 of it sits, on the page as it was
      // rendered (400 x 200), at x = y_turned, y = 200 - (x_turned + w): the left edge, low on the page
      const [page] = saved;
      expect(page).toMatchObject({ width: 200, height: 400, rotation: 90, orientation: 90 });
      const { pixelBoxToPageRect } = await import('./geometry');
      const rect = pixelBoxToPageRect(
        page!.words[0]!.bbox,
        { width: 200, height: 400 },
        page!.rotation,
      );
      expect(rect.x).toBeCloseTo(10 / 400, 6);
      expect(rect.y).toBeCloseTo((200 - 120) / 200, 6);
      expect(rect.w).toBeCloseTo(20 / 400, 6);
      expect(rect.h).toBeCloseTo(100 / 200, 6);
      await engine.terminate();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
