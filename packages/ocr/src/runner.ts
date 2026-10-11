import type { PdfRect } from '@shared/schema';
import { OcrError, toOcrError } from './errors';
import type { OcrErrorCode } from './errors';
import { inkLineDirection } from './image';
import { ORIENTATION_BUDGET_MS, recognizeUpright } from './orientation';
import type { LineDirection } from './orientation';
import { buildPageTextStream } from './stream';
import type {
  OcrEngine,
  OcrImageSource,
  OcrJobStore,
  OcrPage,
  OcrRotation,
  PixelBox,
  RecognizeOptions,
} from './types';

/** What a page renderer hands back: the image plus how it was rendered. */
export interface RenderedPage {
  image: OcrImageSource;
  /** Clockwise rotation of the image relative to the page box. Default 0. */
  rotation?: number;
  /** Render scale where 1 = 72 dpi. */
  scale?: number;
  /** Required for encoded (Blob/bytes) images. */
  width?: number;
  height?: number;
  /** Called when the image is no longer needed (free the canvas). */
  release?: () => void;
}

const isRenderedPage = (value: OcrImageSource | RenderedPage): value is RenderedPage =>
  typeof value === 'object' && value !== null && 'image' in value;

const toRendered = (value: OcrImageSource | RenderedPage): RenderedPage =>
  isRenderedPage(value) ? value : { image: value };

// ---------------------------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------------------------

export type OcrJobPhase =
  | 'skipped'
  | 'rendering'
  | 'initializing'
  | 'recognizing'
  /** The page looks sideways or upside down, or its first reading was poor: other turns are tried. */
  | 'orienting'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'done';

export interface OcrJobProgress {
  phase: OcrJobPhase;
  /** Page the event is about; null for job-level events. */
  pageNumber: number | null;
  /** Pages finished so far: already stored + saved + failed. */
  completed: number;
  /** Distinct pages requested. */
  total: number;
  /** 0..1 over the whole job, monotonic non-decreasing. */
  progress: number;
}

export interface OcrJobPageFailure {
  pageNumber: number;
  code: OcrErrorCode;
  message: string;
  detail?: string;
  attempts: number;
}

export interface OcrJobSummary {
  /**
   * completed: every requested page is stored (now or earlier)
   * partial:   the job ran through but some pages failed twice (see `failed`)
   * cancelled: the signal aborted; pages saved before that are kept and a re-run resumes
   * failed:    a job-level error stopped it (engine unusable, or the store rejected a save)
   */
  status: 'completed' | 'partial' | 'cancelled' | 'failed';
  requested: number;
  skipped: number[];
  saved: number[];
  /** Saved pages that were read after turning them (stored sideways or upside down). */
  reoriented: Array<{ pageNumber: number; orientation: OcrRotation }>;
  failed: OcrJobPageFailure[];
  error?: { code: OcrErrorCode; message: string; detail?: string };
  durationMs: number;
}

export interface RunOcrJobOptions {
  /** 1-based page numbers to make sure are recognised. Duplicates are ignored. */
  pages: readonly number[];
  renderPage(pageNumber: number, signal: AbortSignal): Promise<OcrImageSource | RenderedPage>;
  engine: Pick<OcrEngine, 'recognize'>;
  store: OcrJobStore;
  signal?: AbortSignal;
  onProgress?: (event: OcrJobProgress) => void;
  /** Extra attempts per page after a retryable failure (worker crash, out of memory). Default 1. */
  retries?: number;
  /**
   * Read pages that are stored sideways or upside down by turning them (never more than four readings
   * of a page, never a network request, no extra data). Default true. Encoded images (Blob, bytes)
   * cannot be turned and are read as they are.
   */
  checkOrientation?: boolean;
  /** Time allowed for all the readings of one page. Default ORIENTATION_BUDGET_MS. */
  orientationBudgetMs?: number;
  /** Test seam: which way the lines of the image run. Default: measured from the canvas ink. */
  lineDirection?(image: OcrImageSource): LineDirection | null;
}

/** Errors that will repeat for every page: stop instead of failing the whole document page by page. */
const FATAL: ReadonlySet<OcrErrorCode> = new Set(['asset-missing', 'wasm-unsupported']);

/**
 * Recognises `pages` one at a time (bounded memory: one rendered page alive at once), saving each page
 * as soon as it is done so a cancel, crash or tab close loses at most the page in flight, and a re-run
 * skips everything already stored. Never rejects for cancellation or OCR failures; inspect `status`.
 */
export async function runOcrJob(options: RunOcrJobOptions): Promise<OcrJobSummary> {
  const started = Date.now();
  const retries = Math.max(0, options.retries ?? 1);
  for (const n of options.pages) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`invalid page number ${n}`);
  }
  const requested = [...new Set(options.pages)].sort((a, b) => a - b);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });

  const summary: OcrJobSummary = {
    status: 'completed',
    requested: requested.length,
    skipped: [],
    saved: [],
    reoriented: [],
    failed: [],
    durationMs: 0,
  };
  const total = requested.length;
  let completed = 0;
  let high = 0;
  const emit = (phase: OcrJobPhase, pageNumber: number | null, fraction = 0): void => {
    const raw = total === 0 ? 1 : (completed + Math.min(1, Math.max(0, fraction))) / total;
    high = Math.max(high, Math.min(1, raw));
    try {
      options.onProgress?.({ phase, pageNumber, completed, total, progress: high });
    } catch {
      /* a consumer bug must not break the job */
    }
  };
  const finish = (status: OcrJobSummary['status'], error?: OcrError): OcrJobSummary => {
    summary.status = status;
    if (error) summary.error = { code: error.code, message: error.message, detail: error.detail };
    summary.durationMs = Date.now() - started;
    return summary;
  };

  try {
    let stored: Set<number>;
    try {
      stored = new Set(await options.store.storedPageNumbers());
    } catch (cause) {
      return finish(
        'failed',
        new OcrError('failed', `could not read stored OCR pages: ${String(cause)}`),
      );
    }
    const todo = requested.filter((n) => !stored.has(n));
    summary.skipped = requested.filter((n) => stored.has(n));
    completed = summary.skipped.length;
    if (summary.skipped.length > 0) emit('skipped', null);

    for (const pageNumber of todo) {
      if (controller.signal.aborted) return finish('cancelled', new OcrError('cancelled'));
      let attempts = 0;
      let lastError: OcrError | null = null;
      for (;;) {
        attempts += 1;
        let stage: 'render' | 'recognize' | 'save' = 'render';
        let rendered: RenderedPage | null = null;
        try {
          emit('rendering', pageNumber);
          rendered = toRendered(await options.renderPage(pageNumber, controller.signal));
          if (controller.signal.aborted) throw new OcrError('cancelled');
          stage = 'recognize';
          const current = rendered;
          const image = current.image;
          const direction =
            options.checkOrientation === false
              ? null
              : (options.lineDirection ?? inkLineDirection)(image);
          // With an orientation check a page's progress is 0..0.9 reading, 0.9..0.99 turned readings.
          const share = direction === null ? 1 : 0.9;
          const read = (turn: number): Promise<OcrPage> =>
            options.engine.recognize(image, {
              pageNumber,
              rotation: current.rotation,
              orientation: turn,
              scale: current.scale,
              width: current.width,
              height: current.height,
              signal: controller.signal,
              onProgress: (event) =>
                event.phase === 'initializing'
                  ? emit('initializing', pageNumber)
                  : emit('recognizing', pageNumber, event.progress * share),
            });
          let page: OcrPage;
          let orientation: OcrRotation = 0;
          if (direction === null) {
            page = await read(0);
          } else {
            const upright = await recognizeUpright({
              direction,
              signal: controller.signal,
              budgetMs: options.orientationBudgetMs ?? ORIENTATION_BUDGET_MS,
              onTurned: (_turn, index) => emit('orienting', pageNumber, 0.9 + 0.03 * index),
              recognize: read,
            });
            page = upright.page;
            orientation = upright.orientation;
          }
          stage = 'save';
          emit('saving', pageNumber, 1);
          try {
            await options.store.saveOcrPage(page);
          } catch {
            // One immediate retry: a transient IndexedDB abort should not discard a recognised page.
            await options.store.saveOcrPage(page);
          }
          summary.saved.push(pageNumber);
          if (orientation !== 0) summary.reoriented.push({ pageNumber, orientation });
          completed += 1;
          emit('saved', pageNumber);
          lastError = null;
          break;
        } catch (error) {
          const err = toOcrError(error);
          if (err.code === 'cancelled') return finish('cancelled', err);
          if (stage === 'save') {
            return finish(
              'failed',
              new OcrError(
                'failed',
                `could not save OCR text for page ${pageNumber}: ${err.detail ?? ''}`,
              ),
            );
          }
          if (FATAL.has(err.code)) return finish('failed', err);
          lastError = err;
          if (!err.retryable || attempts > retries) break;
        } finally {
          try {
            rendered?.release?.();
          } catch {
            /* releasing is best effort */
          }
        }
      }
      if (lastError) {
        summary.failed.push({
          pageNumber,
          code: lastError.code,
          message: lastError.message,
          detail: lastError.detail,
          attempts,
        });
        completed += 1;
        emit('failed', pageNumber);
      }
    }
    emit('done', null, 0);
    return finish(summary.failed.length > 0 ? 'partial' : 'completed');
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

// ---------------------------------------------------------------------------------------------
// OcrPort: the narrow interface the PDF reader consumes
// ---------------------------------------------------------------------------------------------

/**
 * Structurally assignable to the PDF reader's `OcrPort` (packages/pdf/src/ocr.ts): `bbox` is in the
 * pixels of the image passed in, which the reader divides by the image size itself.
 */
export interface OcrPortWord {
  text: string;
  /** Pixels of the recognised image, origin top-left. */
  bbox: PixelBox;
  /** The same box as a normalised page rect (rotation-aware): ready for PdfAnchorSet.rects. */
  rect: PdfRect;
  /** Engine confidence 0..100. */
  confidence: number;
}

export interface OcrPortResult {
  /** Page text stream (see buildPageTextStream): words joined by single spaces. */
  text: string;
  words: OcrPortWord[];
  /** Mean engine confidence 0..1, or null for a page with no recognised text. */
  confidence: number | null;
  language: string;
  engine: string;
  /** The full recognition result, ready for `OcrJobStore.saveOcrPage`. */
  page: OcrPage;
}

export interface OcrPort {
  recognizePage(
    pageNumber: number,
    source: OcrImageSource | RenderedPage,
    options?: Pick<RecognizeOptions, 'rotation' | 'scale' | 'width' | 'height' | 'onProgress'>,
  ): Promise<OcrPortResult>;
  /** Aborts every recognizePage call in flight or queued through this port. */
  cancel(): void;
}

export function createOcrPort(engine: Pick<OcrEngine, 'recognize'>): OcrPort {
  const controllers = new Set<AbortController>();
  return {
    async recognizePage(pageNumber, source, options = {}) {
      const controller = new AbortController();
      controllers.add(controller);
      const rendered = toRendered(source);
      try {
        const page = await engine.recognize(rendered.image, {
          pageNumber,
          rotation: options.rotation ?? rendered.rotation,
          scale: options.scale ?? rendered.scale,
          width: options.width ?? rendered.width,
          height: options.height ?? rendered.height,
          onProgress: options.onProgress,
          signal: controller.signal,
        });
        const stream = buildPageTextStream(page);
        return {
          text: stream.text,
          words: stream.items.map((item) => ({
            text: item.text,
            bbox: item.bbox,
            rect: item.rect,
            confidence: item.confidence,
          })),
          confidence: page.words.length === 0 ? null : page.confidence / 100,
          language: page.engine.language,
          engine: `${page.engine.name} ${page.engine.version}`,
          page,
        };
      } finally {
        controllers.delete(controller);
        try {
          rendered.release?.();
        } catch {
          /* best effort */
        }
      }
    },
    cancel() {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}
