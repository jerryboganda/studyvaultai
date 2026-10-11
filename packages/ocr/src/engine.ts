import { OCR_LANGUAGE, resolveAssetUrls } from './assets';
import { OcrError, toOcrError } from './errors';
import { composeRotation, normalizeRotation } from './geometry';
import { prepareImage } from './image';
import type { PreparedImage } from './image';
import { convertRecognition } from './result';
import type { OcrEngine, OcrImageSource, OcrPage, OcrPhase, RecognizeOptions } from './types';

/** tesseract.js OEM.LSTM_ONLY. The legacy engine is not shipped (it needs the 10 MB data file). */
const OEM_LSTM_ONLY = 1;

/** Default per-page pixel budget (US Letter at 300 dpi is 8.4 MP). */
export const DEFAULT_MAX_PIXELS = 10_000_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_JOB_TIMEOUT_MS = 300_000;

/** Messages tesseract.js' logger emits, in the order a cold worker goes through them. */
const INIT_STAGES = [
  'loading tesseract core',
  'initializing tesseract',
  'loading language traineddata',
  'initializing api',
] as const;

// WebAssembly probes (same bytes wasm-feature-detect ships): a v128 SIMD function, and an empty module.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);
const EMPTY_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

// ---------------------------------------------------------------------------------------------
// The slice of tesseract.js this package depends on. Declared here (not imported) so tests can
// inject a fake and so a tesseract.js upgrade shows up as a type error in ONE place.
// ---------------------------------------------------------------------------------------------

export interface TesseractLogMessage {
  status?: unknown;
  progress?: unknown;
}

export interface TesseractWorkerOptions {
  workerPath: string;
  corePath: string;
  langPath: string;
  /** false: a blob: worker would need `blob:` in script-src; the extension CSP forbids it. */
  workerBlobURL: false;
  /** 'none': the traineddata already ships inside the extension; do not duplicate it into IndexedDB. */
  cacheMethod: 'none';
  gzip: true;
  logger: (message: TesseractLogMessage) => void;
  errorHandler: (error: unknown) => void;
}

export interface TesseractWorkerLike {
  recognize(
    image: Uint8Array,
    options?: Record<string, string | number | boolean>,
    output?: Record<string, boolean>,
  ): Promise<{ data: unknown }>;
  terminate(): Promise<unknown> | unknown;
  /** Tesseract variables (absent in test doubles). */
  setParameters?(params: Record<string, string | number>): Promise<unknown>;
  /** The underlying DOM Worker (when present) so a crash after start can be observed. */
  worker?: {
    addEventListener?: (type: 'error', listener: (event: { message?: string }) => void) => void;
  } | null;
}

export type CreateWorkerFn = (
  language: string,
  oem: number,
  options: TesseractWorkerOptions,
) => Promise<TesseractWorkerLike>;

/** tesseract.js is loaded on first use only: importing @ocr executes nothing and bundles lazily. */
const loadTesseract: CreateWorkerFn = async (language, oem, options) => {
  const mod = (await import('tesseract.js')) as unknown as {
    createWorker?: CreateWorkerFn;
    default?: { createWorker?: CreateWorkerFn };
  };
  const create = mod.createWorker ?? mod.default?.createWorker;
  if (typeof create !== 'function')
    throw new OcrError('failed', 'tesseract.js has no createWorker');
  return create(language, oem, options);
};

// ---------------------------------------------------------------------------------------------

export interface OcrEngineOptions {
  /** Extension URL of the folder holding the OCR assets: `browser.runtime.getURL('/ocr/')`. */
  assetBaseUrl: string;
  /** Test seam. Default: lazy `import('tesseract.js')`. Receives the exact options tesseract gets. */
  createWorker?: CreateWorkerFn;
  /** Largest image (width x height) handed to the recogniser; bigger canvases are downscaled. */
  maxPixels?: number;
  /** Terminate the idle worker (frees ~100+ MB of wasm heap) after this long. 0 = never. */
  idleTimeoutMs?: number;
  /** A job that has not finished by then is failed and its worker killed. 0 = never. */
  jobTimeoutMs?: number;
}

interface Job {
  source: OcrImageSource;
  options: RecognizeOptions;
  resolve(page: OcrPage): void;
  reject(error: OcrError): void;
  settled: boolean;
  /** Set while the job runs: rejects the job's race (abort, crash, timeout). */
  fail: ((error: OcrError) => void) | null;
  usesWorker: boolean;
  detach: () => void;
}

const noop = (): void => undefined;
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

async function preflight(): Promise<void> {
  if (typeof WebAssembly !== 'object') {
    throw new OcrError('wasm-unsupported', 'WebAssembly is not available');
  }
  if (!WebAssembly.validate(SIMD_PROBE)) {
    throw new OcrError('wasm-unsupported', 'WebAssembly SIMD is not available');
  }
  try {
    // An extension CSP without 'wasm-unsafe-eval' lets tesseract.js hang forever inside its worker
    // (verified in Chromium); compiling an empty module here turns that into a clear error.
    await WebAssembly.compile(EMPTY_MODULE);
  } catch (cause) {
    throw new OcrError(
      'wasm-unsupported',
      `WebAssembly compilation is blocked (extension CSP needs 'wasm-unsafe-eval'): ${String(cause)}`,
      { cause },
    );
  }
}

export function createOcrEngine(options: OcrEngineOptions): OcrEngine {
  const urls = resolveAssetUrls(options.assetBaseUrl);
  const createWorker = options.createWorker ?? loadTesseract;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  let worker: TesseractWorkerLike | null = null;
  let starting: Promise<TesseractWorkerLike> | null = null;
  /** Bumped whenever the worker is discarded so a start that finishes late cleans up after itself. */
  let generation = 0;
  let running = false;
  let current: Job | null = null;
  let report: ((phase: OcrPhase, progress: number) => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: Job[] = [];

  const clearIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const dropWorker = (): void => {
    generation += 1;
    const w = worker;
    worker = null;
    starting = null;
    if (w) {
      try {
        // terminate() can throw synchronously or reject; either way the worker is gone for us.
        void Promise.resolve(w.terminate()).catch(noop);
      } catch {
        /* already dead */
      }
    }
  };

  const onLog = (message: TesseractLogMessage): void => {
    if (!report) return;
    const progress = clamp01(Number(message.progress));
    if (message.status === 'recognizing text') {
      report('recognizing', progress);
      return;
    }
    const stage = INIT_STAGES.findIndex((s) => s === message.status);
    if (stage >= 0) report('initializing', (stage + progress) / INIT_STAGES.length);
  };

  const spawn = async (): Promise<TesseractWorkerLike> => {
    await preflight();
    const born = generation;
    let lastWorkerError: unknown;
    const w = await createWorker(OCR_LANGUAGE, OEM_LSTM_ONLY, {
      workerPath: urls.workerPath,
      corePath: urls.corePath,
      langPath: urls.langPath,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      // A worker discarded mid-start must not feed progress into the next job.
      logger: (message) => {
        if (born === generation) onLog(message);
      },
      // Without a handler tesseract.js re-throws worker errors as uncaught exceptions.
      errorHandler: (error) => {
        lastWorkerError = error;
      },
    }).catch((error: unknown) => {
      throw toOcrError(error ?? lastWorkerError, 'init');
    });
    try {
      // Tesseract prints a line for every speck it cannot read ("Line cannot be recognized!!") to
      // stderr, which the worker turns into console errors on a page that was read correctly. They
      // say nothing a person can act on: send them to the null device. Purely cosmetic.
      await w.setParameters?.({ debug_file: '/dev/null' });
    } catch {
      /* a recogniser that refuses the variable still recognises */
    }
    w.worker?.addEventListener?.('error', (event) => {
      if (worker !== w) return;
      dropWorker();
      current?.fail?.(toOcrError(event?.message ?? 'worker crashed'));
    });
    return w;
  };

  const acquire = (): Promise<TesseractWorkerLike> => {
    if (worker) return Promise.resolve(worker);
    if (!starting) {
      const mine = generation;
      const pending = spawn().then(
        (w) => {
          if (mine !== generation) {
            // Discarded (cancel/terminate) while starting: do not leak the late worker.
            void Promise.resolve(w.terminate()).catch(noop);
            throw new OcrError('cancelled');
          }
          worker = w;
          starting = null;
          return w;
        },
        (error: unknown) => {
          if (starting === pending) starting = null;
          throw toOcrError(error, 'init');
        },
      );
      starting = pending;
    }
    return starting;
  };

  const settle = (job: Job, page: OcrPage | OcrError): void => {
    if (job.settled) return;
    job.settled = true;
    job.detach();
    if (page instanceof OcrError) job.reject(page);
    else job.resolve(page);
  };

  const execute = async (job: Job): Promise<void> => {
    const { options: opts } = job;
    const pageNumber = opts.pageNumber ?? 1;
    const last: Record<OcrPhase, number> = { initializing: -1, recognizing: -1 };
    report = (phase, progress) => {
      const value = clamp01(progress);
      if (value <= last[phase]) return; // monotonic per phase, no duplicate events
      last[phase] = value;
      try {
        opts.onProgress?.({ pageNumber, phase, progress: value });
      } catch {
        /* a consumer bug must not break recognition */
      }
    };
    const failed = new Promise<never>((_, reject) => {
      job.fail = reject;
    });
    failed.catch(noop);
    /** Races any step against abort / crash / timeout; the loser's late rejection is swallowed. */
    const guard = <T>(promise: Promise<T>): Promise<T> => {
      promise.catch(noop);
      return Promise.race([promise, failed]);
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (opts.signal?.aborted) throw new OcrError('cancelled');
      const rotation = normalizeRotation(opts.rotation ?? 0);
      const orientation = normalizeRotation(opts.orientation ?? 0);
      const prepared: PreparedImage = await guard(
        prepareImage(job.source, {
          width: opts.width,
          height: opts.height,
          maxPixels,
          turn: orientation,
        }),
      );
      if (opts.signal?.aborted) throw new OcrError('cancelled');

      if (jobTimeoutMs > 0) {
        timer = setTimeout(() => {
          job.fail?.(new OcrError('failed', `no result after ${jobTimeoutMs} ms`));
        }, jobTimeoutMs);
      }
      job.usesWorker = true;
      const cold = worker === null;
      const w = await guard(acquire());
      if (cold) report('initializing', 1);
      report('recognizing', 0);

      // DPI hint: Tesseract is tuned for ~300 dpi and otherwise has to guess from pixel size.
      const hint: Record<string, string> = {};
      if (opts.scale !== undefined && opts.scale > 0) {
        const sent = (opts.scale * 72 * (prepared.factorX + prepared.factorY)) / 2;
        hint.user_defined_dpi = String(Math.min(600, Math.max(70, Math.round(sent))));
      }
      const result = await guard(w.recognize(prepared.data, hint, { blocks: true }));

      const page = convertRecognition(result?.data, {
        pageNumber,
        width: prepared.width,
        height: prepared.height,
        factorX: prepared.factorX,
        factorY: prepared.factorY,
        // The image the boxes refer to was turned by `orientation` after the page was rendered.
        rotation: composeRotation(rotation, orientation),
        orientation,
        scale: opts.scale ?? null,
      });
      report('recognizing', 1);
      settle(job, page);
    } catch (error) {
      const err = toOcrError(error);
      // A cancelled job only poisons the worker if it was actually using it (then it must die: that
      // is what makes cancel real). Any other failure may have left the wasm module aborted.
      if (err.code !== 'cancelled' || job.usesWorker) dropWorker();
      settle(job, err);
    } finally {
      if (timer !== null) clearTimeout(timer);
      job.fail = null;
      report = null;
    }
  };

  const pump = (): void => {
    if (running) return;
    const job = queue.shift();
    if (!job) {
      if (worker && idleTimeoutMs > 0 && idleTimer === null) {
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (!running && queue.length === 0) dropWorker();
        }, idleTimeoutMs);
      }
      return;
    }
    clearIdle();
    running = true;
    current = job;
    void execute(job).finally(() => {
      running = false;
      current = null;
      pump();
    });
  };

  return {
    recognize(source, recognizeOptions = {}) {
      return new Promise<OcrPage>((resolve, reject) => {
        const { signal } = recognizeOptions;
        if (signal?.aborted) {
          reject(new OcrError('cancelled'));
          return;
        }
        const job: Job = {
          source,
          options: recognizeOptions,
          resolve,
          reject,
          settled: false,
          fail: null,
          usesWorker: false,
          detach: noop,
        };
        if (signal) {
          const onAbort = (): void => {
            const queued = queue.indexOf(job);
            if (queued >= 0) {
              queue.splice(queued, 1);
              settle(job, new OcrError('cancelled'));
            } else {
              job.fail?.(new OcrError('cancelled'));
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          job.detach = () => signal.removeEventListener('abort', onAbort);
        }
        queue.push(job);
        pump();
      });
    },

    async terminate() {
      clearIdle();
      for (const job of queue.splice(0)) settle(job, new OcrError('cancelled'));
      current?.fail?.(new OcrError('cancelled'));
      dropWorker();
    },
  };
}
