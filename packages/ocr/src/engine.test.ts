// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOcrEngine } from './engine';
import { isOcrError } from './errors';
import type { OcrErrorCode } from './errors';
import { FakeTesseract, tesseractData } from './fakeWorker';
import type { PendingRecognition } from './fakeWorker';
import type { OcrProgress } from './types';

const BASE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/ocr/';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  extra: Parameters<typeof createOcrEngine>[0] extends infer T ? Partial<T> : never = {},
) {
  // The preflight compiles an empty module; stubbing it keeps every step a microtask so the
  // setTimeout(0) flushes below are deterministic even on a loaded CI machine.
  vi.stubGlobal('WebAssembly', { validate: () => true, compile: () => Promise.resolve({}) });
  const fake = new FakeTesseract();
  const engine = createOcrEngine({
    assetBaseUrl: BASE,
    createWorker: fake.createWorker,
    idleTimeoutMs: 0,
    jobTimeoutMs: 0,
    ...extra,
  });
  return { fake, engine };
}

const bytes = (n: number): Uint8Array => new Uint8Array([137, 80, 78, 71, n]);
const WORDS = [[{ text: 'Hello', x0: 10, y0: 20, x1: 60, y1: 40 }]];
const done = (job: PendingRecognition, lines = WORDS): void => job.resolve(tesseractData(lines));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function codeOf(promise: Promise<unknown>): Promise<OcrErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (isOcrError(error)) return error.code;
    throw error;
  }
  throw new Error('expected rejection');
}

describe('lazy start', () => {
  it('creates no worker until the first recognize and reuses it afterwards', async () => {
    const { fake, engine } = setup();
    fake.onRecognize = (job) => done(job);
    await flush();
    expect(fake.created).toHaveLength(0);
    await engine.recognize(bytes(1), { width: 100, height: 50 });
    await engine.recognize(bytes(2), { width: 100, height: 50 });
    expect(fake.created).toHaveLength(1);
  });

  it('does not import tesseract.js until needed', async () => {
    vi.resetModules();
    const factory = vi.fn(() => ({
      createWorker: async (_l: string, _o: number, options: { logger: (m: unknown) => void }) => {
        options.logger({ status: 'loading tesseract core', progress: 1 });
        return {
          recognize: async () => tesseractData(WORDS),
          terminate: async () => undefined,
        };
      },
    }));
    vi.doMock('tesseract.js', factory);
    const { createOcrEngine: create } = await import('./engine');
    const engine = create({ assetBaseUrl: BASE, idleTimeoutMs: 0, jobTimeoutMs: 0 });
    expect(factory).not.toHaveBeenCalled();
    const page = await engine.recognize(bytes(1), { width: 100, height: 50 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(page.words.map((w) => w.text)).toEqual(['Hello']);
    vi.doUnmock('tesseract.js');
  });
});

describe('asset URL policy (nothing may leave the extension)', () => {
  it('passes only URLs under the injected base and local-only options to tesseract.js', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { fake, engine } = setup();
    fake.onRecognize = (job) => done(job);
    await engine.recognize(bytes(1), { width: 100, height: 50 });

    const { language, oem, options } = fake.created[0]!;
    expect(language).toBe('eng');
    expect(oem).toBe(1); // LSTM only: the legacy model is not shipped
    expect(options.workerPath).toBe(`${BASE}worker.min.js`);
    expect(options.corePath).toBe(`${BASE}tesseract-core-simd-lstm.js`);
    expect(options.langPath).toBe(BASE.slice(0, -1));
    expect(options.workerBlobURL).toBe(false);
    expect(options.cacheMethod).toBe('none');
    expect(options.gzip).toBe(true);

    // tesseract.js falls back to jsDelivr for any path that is undefined: all three must be set.
    for (const key of ['workerPath', 'corePath', 'langPath'] as const) {
      expect(typeof options[key]).toBe('string');
      expect(options[key].startsWith('chrome-extension://abcdefghijklmnopabcdefghijklmnop/')).toBe(
        true,
      );
    }
    // No string anywhere in the options is a network URL.
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(options);
    expect(strings.length).toBeGreaterThan(3);
    expect(strings.filter((s) => /^https?:/i.test(s))).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects asset bases that are not extension (or loopback dev) URLs', () => {
    for (const base of [
      'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/',
      'http://example.com/ocr/',
      'ocr/',
      'chrome-extension://abc/ocr/?x=1',
    ]) {
      expect(() => createOcrEngine({ assetBaseUrl: base })).toThrow(TypeError);
    }
    expect(() => createOcrEngine({ assetBaseUrl: 'http://127.0.0.1:5173/ocr' })).not.toThrow();
  });

  it('normalises a base without a trailing slash', async () => {
    const { fake, engine } = setup({ assetBaseUrl: BASE.slice(0, -1) });
    fake.onRecognize = (job) => done(job);
    await engine.recognize(bytes(1), { width: 100, height: 50 });
    expect(fake.created[0]!.options.workerPath).toBe(`${BASE}worker.min.js`);
  });
});

describe('recogniser diagnostics', () => {
  const workerWith = (setParameters: (p: Record<string, string | number>) => Promise<unknown>) => {
    const calls: Array<Record<string, string | number>> = [];
    const create = async () => ({
      recognize: async () => tesseractData(WORDS),
      terminate: async () => undefined,
      setParameters: async (p: Record<string, string | number>) => {
        calls.push(p);
        return setParameters(p);
      },
    });
    return { calls, create };
  };

  it('sends the recogniser printouts to the null device, once per worker', async () => {
    vi.stubGlobal('WebAssembly', { validate: () => true, compile: () => Promise.resolve({}) });
    const { calls, create } = workerWith(async () => undefined);
    const engine = createOcrEngine({
      assetBaseUrl: BASE,
      createWorker: create,
      idleTimeoutMs: 0,
      jobTimeoutMs: 0,
    });
    await engine.recognize(bytes(1), { width: 100, height: 50 });
    await engine.recognize(bytes(2), { width: 100, height: 50 });
    expect(calls).toEqual([{ debug_file: '/dev/null' }]);
  });

  it('still recognises when the recogniser refuses the variable', async () => {
    vi.stubGlobal('WebAssembly', { validate: () => true, compile: () => Promise.resolve({}) });
    const { create } = workerWith(async () => {
      throw new Error('unknown variable');
    });
    const engine = createOcrEngine({
      assetBaseUrl: BASE,
      createWorker: create,
      idleTimeoutMs: 0,
      jobTimeoutMs: 0,
    });
    const page = await engine.recognize(bytes(1), { width: 100, height: 50 });
    expect(page.words.map((w) => w.text)).toEqual(['Hello']);
  });
});

describe('queue and cancellation', () => {
  it('runs one job at a time in FIFO order', async () => {
    const { fake, engine } = setup();
    const order: number[] = [];
    const jobs = [1, 2, 3].map((n) =>
      engine
        .recognize(bytes(n), { width: 100, height: 50, pageNumber: n })
        .then((page) => order.push(page.pageNumber)),
    );
    await flush();
    const worker = fake.workers[0]!;
    expect(worker.pending).toHaveLength(1);
    expect(worker.pending[0]!.image[4]).toBe(1);
    done(worker.pending[0]!);
    await flush();
    expect(worker.pending).toHaveLength(2);
    expect(worker.pending[1]!.image[4]).toBe(2);
    done(worker.pending[1]!);
    await flush();
    done(worker.pending[2]!);
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3]);
    expect(fake.created).toHaveLength(1);
  });

  it('cancels a queued job without starting it or touching the worker', async () => {
    const { fake, engine } = setup();
    const controller = new AbortController();
    const first = engine.recognize(bytes(1), { width: 100, height: 50 });
    const second = engine.recognize(bytes(2), {
      width: 100,
      height: 50,
      signal: controller.signal,
    });
    const third = engine.recognize(bytes(3), { width: 100, height: 50 });
    await flush();
    controller.abort();
    expect(await codeOf(second)).toBe('cancelled');
    const worker = fake.workers[0]!;
    expect(worker.terminated).toBe(false);
    done(worker.pending[0]!);
    await first;
    await flush();
    expect(worker.pending).toHaveLength(2); // job 1 and job 3; job 2 never reached the worker
    expect(worker.pending[1]!.image[4]).toBe(3);
    done(worker.pending[1]!);
    await third;
  });

  it('terminates the real worker when the running job is cancelled and continues on a fresh one', async () => {
    const { fake, engine } = setup();
    const controller = new AbortController();
    const running = engine.recognize(bytes(1), {
      width: 100,
      height: 50,
      signal: controller.signal,
    });
    const next = engine.recognize(bytes(2), { width: 100, height: 50 });
    await flush();
    const first = fake.workers[0]!;
    expect(first.pending).toHaveLength(1);

    controller.abort();
    const error = await running.catch((e: unknown) => e);
    expect(isOcrError(error) && error.code).toBe('cancelled');
    expect((error as Error).name).toBe('AbortError');
    expect(first.terminated).toBe(true);

    await flush();
    expect(fake.created).toHaveLength(2);
    done(fake.workers[1]!.pending[0]!);
    expect((await next).pageNumber).toBe(1);
  });

  it('rejects immediately for an already aborted signal', async () => {
    const { fake, engine } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(
      await codeOf(
        engine.recognize(bytes(1), { width: 100, height: 50, signal: controller.signal }),
      ),
    ).toBe('cancelled');
    expect(fake.created).toHaveLength(0);
  });

  it('cancels while the worker is still starting and does not leak the late worker', async () => {
    const { fake, engine } = setup();
    fake.holdStart = true;
    const controller = new AbortController();
    const job = engine.recognize(bytes(1), { width: 100, height: 50, signal: controller.signal });
    await flush();
    controller.abort();
    expect(await codeOf(job)).toBe('cancelled');
    fake.release();
    await flush();
    expect(fake.workers[0]!.terminated).toBe(true);
    expect(fake.workers[0]!.pending).toHaveLength(0);
  });

  it('terminate() cancels queued and running jobs and leaves the engine reusable', async () => {
    const { fake, engine } = setup();
    const a = engine.recognize(bytes(1), { width: 100, height: 50 });
    const b = engine.recognize(bytes(2), { width: 100, height: 50 });
    await flush();
    await engine.terminate();
    expect(await codeOf(a)).toBe('cancelled');
    expect(await codeOf(b)).toBe('cancelled');
    expect(fake.workers[0]!.terminated).toBe(true);

    fake.onRecognize = (job) => done(job);
    const page = await engine.recognize(bytes(3), { width: 100, height: 50, pageNumber: 3 });
    expect(page.pageNumber).toBe(3);
    expect(fake.created).toHaveLength(2);
  });
});

describe('progress', () => {
  it('is clamped, monotonic per phase and reports initialising before recognising', async () => {
    const { fake, engine } = setup();
    const events: OcrProgress[] = [];
    fake.onRecognize = (job) => {
      const log = fake.created[0]!.options.logger;
      for (const p of [0, 0.2, 0.1, 0.5, 0.5, 1.4, 0.9]) {
        log({ status: 'recognizing text', progress: p });
      }
      log({ status: 'some unknown status', progress: 0.5 });
      done(job);
    };
    await engine.recognize(bytes(1), {
      width: 100,
      height: 50,
      pageNumber: 7,
      onProgress: (e) => events.push(e),
    });
    const init = events.filter((e) => e.phase === 'initializing').map((e) => e.progress);
    const rec = events.filter((e) => e.phase === 'recognizing').map((e) => e.progress);
    expect(init.length).toBeGreaterThan(0);
    expect(init.at(-1)).toBe(1);
    expect(rec).toEqual([...rec].sort((a, b) => a - b));
    expect(new Set(rec).size).toBe(rec.length); // no duplicates
    expect(rec[0]).toBe(0);
    expect(rec.at(-1)).toBe(1);
    expect(Math.max(...rec)).toBeLessThanOrEqual(1);
    expect(events.every((e) => e.pageNumber === 7)).toBe(true);
    // all initialising events precede recognising events
    const firstRec = events.findIndex((e) => e.phase === 'recognizing');
    expect(events.slice(firstRec).some((e) => e.phase === 'initializing')).toBe(false);
  });

  it('does not report initialising for a warm worker', async () => {
    const { fake, engine } = setup();
    fake.onRecognize = (job) => done(job);
    await engine.recognize(bytes(1), { width: 100, height: 50 });
    const events: OcrProgress[] = [];
    await engine.recognize(bytes(2), { width: 100, height: 50, onProgress: (e) => events.push(e) });
    expect(events.some((e) => e.phase === 'initializing')).toBe(false);
    expect(events.at(-1)).toMatchObject({ phase: 'recognizing', progress: 1 });
  });

  it('survives a throwing onProgress consumer', async () => {
    const { fake, engine } = setup();
    fake.onRecognize = (job) => done(job);
    const page = await engine.recognize(bytes(1), {
      width: 100,
      height: 50,
      onProgress: () => {
        throw new Error('consumer bug');
      },
    });
    expect(page.words).toHaveLength(1);
  });
});

describe('result conversion and image handling', () => {
  it('returns words, lines, text and confidence in image pixels', async () => {
    const { fake, engine } = setup();
    fake.onRecognize = (job) =>
      job.resolve(
        tesseractData(
          [
            [
              { text: 'Hello', x0: 10, y0: 20, x1: 60, y1: 40, confidence: 96 },
              { text: 'world', x0: 70, y0: 20, x1: 120, y1: 40, confidence: 80 },
            ],
            [{ text: 'again', x0: 10, y0: 60, x1: 70, y1: 80 }],
          ],
          93,
        ),
      );
    const page = await engine.recognize(bytes(1), {
      width: 200,
      height: 100,
      pageNumber: 4,
      rotation: 450,
      scale: 2,
    });
    expect(page).toMatchObject({
      pageNumber: 4,
      width: 200,
      height: 100,
      rotation: 90,
      scale: 2,
      confidence: 93,
      text: 'Hello world\nagain',
      engine: { name: 'tesseract', version: '5.1.0-fake', language: 'eng' },
    });
    expect(page.words[1]).toEqual({
      text: 'world',
      confidence: 80,
      bbox: { x: 70, y: 20, w: 50, h: 20 },
      line: 0,
    });
    expect(page.lines).toEqual([
      {
        text: 'Hello world',
        confidence: 88,
        bbox: { x: 10, y: 20, w: 110, h: 20 },
        first: 0,
        end: 2,
      },
      { text: 'again', confidence: 88, bbox: { x: 10, y: 60, w: 60, h: 20 }, first: 2, end: 3 },
    ]);
    expect(Date.parse(page.recognizedAt)).not.toBeNaN();
  });

  it('treats a page with no text as a valid empty result', async () => {
    const { fake, engine } = setup();
    fake.onRecognize = (job) => job.resolve({ data: { text: '', confidence: 0, blocks: null } });
    const page = await engine.recognize(bytes(1), { width: 100, height: 50 });
    expect(page).toMatchObject({ words: [], lines: [], text: '', confidence: 0 });
  });

  it('sets a DPI hint from the render scale', async () => {
    const { fake, engine } = setup();
    fake.onRecognize = (job) => done(job);
    await engine.recognize(bytes(1), { width: 100, height: 50, scale: 4 });
    await engine.recognize(bytes(2), { width: 100, height: 50 });
    await engine.recognize(bytes(3), { width: 100, height: 50, scale: 0.2 });
    const [a, b, c] = fake.workers[0]!.pending;
    expect(a!.options).toEqual({ user_defined_dpi: '288' });
    expect(a!.output).toEqual({ blocks: true });
    expect(b!.options).toEqual({});
    expect(c!.options).toEqual({ user_defined_dpi: '70' }); // clamped to Tesseract's credible range
  });

  it('requires a declared size for encoded input and enforces the pixel budget', async () => {
    const { fake, engine } = setup({ maxPixels: 1000 });
    expect(await codeOf(engine.recognize(bytes(1)))).toBe('failed');
    expect(await codeOf(engine.recognize(bytes(1), { width: 100, height: 50 }))).toBe(
      'out-of-memory',
    );
    expect(fake.created).toHaveLength(0);
  });

  it('downscales canvases to the pixel budget and maps boxes back to original pixels', async () => {
    const drawn: number[][] = [];
    class FakeOffscreenCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          imageSmoothingQuality: 'low',
          drawImage: (_s: unknown, ...a: number[]) => drawn.push(a),
        };
      }
      convertToBlob() {
        return Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71, 9])]));
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const source = new FakeOffscreenCanvas(4000, 2000); // 8 MP
    const { fake, engine } = setup({ maxPixels: 2_000_000 });
    fake.onRecognize = (job) => done(job, [[{ text: 'big', x0: 500, y0: 250, x1: 1000, y1: 500 }]]); // coordinates in the 2000x1000 copy

    const page = await engine.recognize(source as unknown as OffscreenCanvas, { pageNumber: 1 });
    // 8 MP -> 2 MP budget: both axes halve (sqrt(2e6 / 8e6) = 0.5).
    expect(drawn).toEqual([[0, 0, 2000, 1000]]);
    expect(page.width).toBe(4000);
    expect(page.height).toBe(2000);
    expect(page.words[0]!.bbox).toEqual({ x: 1000, y: 500, w: 1000, h: 500 });
  });

  it('passes small canvases through without a copy', async () => {
    const source = {
      width: 300,
      height: 200,
      getContext: () => null,
      convertToBlob: () => Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71, 5])])),
    };
    const { fake, engine } = setup();
    fake.onRecognize = (job) => done(job);
    await engine.recognize(source as unknown as OffscreenCanvas);
    expect(Array.from(fake.workers[0]!.pending[0]!.image)).toEqual([137, 80, 78, 71, 5]);
  });
});

/** Canvas double that records how it was drawn onto; its PNG bytes say which turn it holds. */
class RecordingCanvas {
  static drawn: Array<{ from: unknown; transform: number[] | null; args: number[] }> = [];
  static created: Array<{ width: number; height: number }> = [];
  private transform: number[] | null = null;
  constructor(
    public width: number,
    public height: number,
  ) {
    RecordingCanvas.created.push({ width, height });
  }
  getContext() {
    return {
      imageSmoothingQuality: 'low',
      setTransform: (...t: number[]) => {
        this.transform = t;
      },
      drawImage: (from: unknown, ...args: number[]) => {
        RecordingCanvas.drawn.push({ from, transform: this.transform, args });
      },
    };
  }
  convertToBlob() {
    return Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71, this.transform ? 1 : 0])]));
  }
}

describe('turning a page that is stored sideways or upside down', () => {
  const turned = async (
    size: { width: number; height: number },
    options: Record<string, number>,
    extra: Parameters<typeof createOcrEngine>[0] extends infer T ? Partial<T> : never = {},
  ) => {
    RecordingCanvas.drawn = [];
    RecordingCanvas.created = [];
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const { fake, engine } = setup(extra);
    fake.onRecognize = (job) =>
      job.resolve(tesseractData([[{ text: 'Hello', x0: 10, y0: 20, x1: 60, y1: 40 }]]));
    const source = new RecordingCanvas(size.width, size.height);
    RecordingCanvas.created = [];
    const page = await engine.recognize(source as unknown as OffscreenCanvas, {
      pageNumber: 4,
      ...options,
    });
    return { page, fake, source };
  };

  const cases: Array<[number, number[]]> = [
    // clockwise quarter: (x, y) of a 400 x 200 image lands at (200 - y, x) of a 200 x 400 one
    [90, [0, 1, -1, 0, 200, 0]],
    [180, [-1, 0, 0, -1, 400, 200]],
    // three quarters: (x, y) -> (y, 400 - x)
    [270, [0, -1, 1, 0, 0, 400]],
  ];
  it.each(cases)(
    'turns the canvas %i degrees clockwise, reports boxes in the turned pixels and maps them with the combined rotation',
    async (turn, transform) => {
      const { page, source } = await turned(
        { width: 400, height: 200 },
        { orientation: turn, rotation: 270 },
      );
      expect(RecordingCanvas.drawn).toHaveLength(1);
      expect(RecordingCanvas.drawn[0]).toMatchObject({ from: source, transform, args: [0, 0] });
      const swapped = turn !== 180;
      expect(RecordingCanvas.created).toEqual([
        swapped ? { width: 200, height: 400 } : { width: 400, height: 200 },
      ]);
      expect(page).toMatchObject({
        width: swapped ? 200 : 400,
        height: swapped ? 400 : 200,
        // the page's own /Rotate (270) and the turn compose: this is what maps boxes to page space
        rotation: (270 + turn) % 360,
        orientation: turn,
      });
      expect(page.words[0]!.bbox).toEqual({ x: 10, y: 20, w: 50, h: 20 });
    },
  );

  it('scales a turned page to the pixel budget in the same draw and maps boxes back', async () => {
    const { page } = await turned(
      { width: 4000, height: 2000 },
      { orientation: 90, rotation: 0 },
      { maxPixels: 2_000_000 },
    );
    // turned 2000 x 4000 (8 MP) -> 1000 x 2000 (2 MP): both axes halve
    expect(RecordingCanvas.created).toEqual([{ width: 1000, height: 2000 }]);
    expect(RecordingCanvas.drawn[0]!.transform).toEqual([0, 0.5, -0.5, 0, 1000, 0]);
    expect(page).toMatchObject({ width: 2000, height: 4000, rotation: 90, orientation: 90 });
    expect(page.words[0]!.bbox).toEqual({ x: 20, y: 40, w: 100, h: 40 });
  });

  it('draws nothing extra and records no orientation when the page is not turned', async () => {
    const { page } = await turned({ width: 400, height: 200 }, { orientation: 0, rotation: 90 });
    expect(RecordingCanvas.drawn).toEqual([]);
    expect(page.rotation).toBe(90);
    expect('orientation' in page).toBe(false);
  });

  it('refuses to turn an encoded image, before a worker is started', async () => {
    const { fake, engine } = setup();
    const code = await codeOf(
      engine.recognize(bytes(1), { width: 100, height: 50, orientation: 90 }),
    );
    expect(code).toBe('failed');
    expect(fake.created).toHaveLength(0);
  });

  it('rejects a turn that is not a multiple of 90', async () => {
    const { engine } = setup();
    expect(
      await codeOf(engine.recognize(bytes(1), { width: 10, height: 10, orientation: 45 })),
    ).toBe('failed');
  });
});

describe('error taxonomy', () => {
  const cases: [string, unknown, OcrErrorCode][] = [
    [
      'language data 404',
      'Network error while fetching chrome-extension://x/ocr/eng.traineddata.gz. Response code: 404',
      'asset-missing',
    ],
    ['worker script failed to load (empty ErrorEvent)', '', 'asset-missing'],
    [
      'importScripts failure',
      "NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope'",
      'asset-missing',
    ],
    [
      'CSP blocks wasm',
      'CompileError: WebAssembly.instantiate(): Compiling or instantiating WebAssembly module violates the following Content Security policy directive',
      'wasm-unsupported',
    ],
    ['wasm out of memory', 'RuntimeError: Aborted(OOM). Build with -sASSERTIONS', 'out-of-memory'],
    [
      'allocation failure',
      new RangeError('WebAssembly.Memory(): could not allocate memory'),
      'out-of-memory',
    ],
    ['anything else', 'Error attempting to read image.', 'failed'],
  ];

  it.each(cases)('classifies a start failure: %s', async (_name, rejection, code) => {
    const { fake, engine } = setup();
    fake.createError = rejection;
    const error = await engine
      .recognize(bytes(1), { width: 100, height: 50 })
      .catch((e: unknown) => e);
    expect(isOcrError(error) && error.code).toBe(code);
    // The message is for the user, the technical text lives in `detail`.
    expect((error as Error).message).toMatch(/^[A-Z]/);
    expect((error as Error).message).not.toMatch(/RuntimeError|CompileError|chrome-extension:\/\//);
  });

  it('classifies a recognition failure and discards the possibly aborted worker', async () => {
    const { fake, engine } = setup();
    fake.onRecognize = (job) => job.reject('RuntimeError: Aborted(OOM). Build with -sASSERTIONS');
    const code = await codeOf(engine.recognize(bytes(1), { width: 100, height: 50 }));
    expect(code).toBe('out-of-memory');
    expect(fake.workers[0]!.terminated).toBe(true);

    fake.onRecognize = (job) => done(job);
    await engine.recognize(bytes(2), { width: 100, height: 50 });
    expect(fake.created).toHaveLength(2);
  });

  it('reports a worker that dies mid-job instead of hanging', async () => {
    const { fake, engine } = setup();
    const job = engine.recognize(bytes(1), { width: 100, height: 50 });
    await flush();
    fake.workers[0]!.crash('Uncaught RangeError: Maximum call stack size exceeded');
    expect(await codeOf(job)).toBe('failed');
    expect(fake.workers[0]!.terminated).toBe(true);
  });

  it('reports blocked WebAssembly before spawning a worker', async () => {
    const { fake, engine } = setup();
    vi.stubGlobal('WebAssembly', {
      validate: () => true,
      compile: () => Promise.reject(new Error('violates the following Content Security policy')),
    });
    expect(await codeOf(engine.recognize(bytes(1), { width: 100, height: 50 }))).toBe(
      'wasm-unsupported',
    );
    expect(fake.created).toHaveLength(0);
  });

  it('reports missing SIMD before spawning a worker', async () => {
    const { fake, engine } = setup();
    vi.stubGlobal('WebAssembly', { validate: () => false, compile: () => Promise.resolve({}) });
    expect(await codeOf(engine.recognize(bytes(1), { width: 100, height: 50 }))).toBe(
      'wasm-unsupported',
    );
    expect(fake.created).toHaveLength(0);
  });

  it('rejects a rotation that is not a multiple of 90', async () => {
    const { engine } = setup();
    expect(await codeOf(engine.recognize(bytes(1), { width: 100, height: 50, rotation: 45 }))).toBe(
      'failed',
    );
  });
});

describe('resource bounds', () => {
  it('terminates the idle worker and starts a new one on demand', async () => {
    vi.useFakeTimers();
    const { fake, engine } = setup({ idleTimeoutMs: 30_000 });
    fake.onRecognize = (job) => done(job);
    await engine.recognize(bytes(1), { width: 100, height: 50 });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fake.workers[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.workers[0]!.terminated).toBe(true);
    await engine.recognize(bytes(2), { width: 100, height: 50 });
    expect(fake.created).toHaveLength(2);
  });

  it('does not idle-terminate while a job is queued', async () => {
    vi.useFakeTimers();
    const { fake, engine } = setup({ idleTimeoutMs: 1000 });
    fake.onRecognize = (job) => done(job);
    await engine.recognize(bytes(1), { width: 100, height: 50 });
    await vi.advanceTimersByTimeAsync(900);
    await engine.recognize(bytes(2), { width: 100, height: 50 });
    await vi.advanceTimersByTimeAsync(900);
    expect(fake.workers[0]!.terminated).toBe(false);
    expect(fake.created).toHaveLength(1);
  });

  it('fails a hung job after the job timeout and kills its worker', async () => {
    vi.useFakeTimers();
    const { fake, engine } = setup({ jobTimeoutMs: 5_000 });
    const job = engine.recognize(bytes(1), { width: 100, height: 50 });
    const outcome = job.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    const error = await outcome;
    expect(isOcrError(error) && error.code).toBe('failed');
    expect(fake.workers[0]!.terminated).toBe(true);
  });
});
