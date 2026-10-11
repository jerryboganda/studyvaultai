/**
 * Public data types of @ocr. Everything here is plain JSON-serialisable data (no classes, no
 * Float32Arrays) so the storage layer can persist an `OcrPage` as-is and backup/sync can ship it.
 *
 * OCR output is machine-generated and may be wrong. It is never a source quote: user corrections are
 * stored separately (`OcrCorrections`) and the raw recognition result stays untouched.
 */

/** Clockwise rotation, in degrees, of the rendered image relative to the page box (PDF.js viewport rotation). */
export type OcrRotation = 0 | 90 | 180 | 270;

/** Axis-aligned box in IMAGE pixels, origin top-left, as handed to the recogniser. */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrWord {
  text: string;
  /** Engine confidence 0..100. */
  confidence: number;
  /** Image pixels (of the image the caller passed in, not of any internal downscaled copy). */
  bbox: PixelBox;
  /** Index into `OcrPage.lines`. */
  line: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: PixelBox;
  /** This line owns `OcrPage.words[first .. end)`. */
  first: number;
  end: number;
}

export interface OcrPage {
  /** 1-based page number of the document this image was rendered from (echoed from the request). */
  pageNumber: number;
  /** Pixel size of the image all boxes refer to. */
  width: number;
  height: number;
  /**
   * Clockwise rotation of the image the boxes refer to, relative to the page box: the page's own
   * displayed rotation plus `orientation`. Boxes map to page space through this value alone.
   */
  rotation: OcrRotation;
  /**
   * Extra clockwise turn the engine applied to the image before recognising it (a scan stored
   * sideways or upside down). Absent or 0: the page was read as rendered; absent is also what a page
   * recognised before orientation checks was stored with.
   */
  orientation?: OcrRotation;
  /** Render scale hint passed by the caller (1 = 72 dpi), or null when unknown. */
  scale: number | null;
  /** Mean engine confidence 0..100 (0 for a blank page). */
  confidence: number;
  /** Reading text, lines separated by "\n". For anchoring use `buildPageTextStream` instead. */
  text: string;
  words: OcrWord[];
  lines: OcrLine[];
  engine: { name: 'tesseract'; version: string; language: string };
  /** ISO timestamp. */
  recognizedAt: string;
}

/**
 * Image inputs. Canvas and ImageData are rasterised (and downscaled to the pixel budget) here.
 * Encoded inputs (Blob / bytes of a PNG, JPEG, BMP, WebP) are passed through untouched, so the caller
 * must declare their pixel size in `RecognizeOptions.width/height`.
 */
export type OcrImageSource =
  HTMLCanvasElement | OffscreenCanvas | ImageData | Blob | ArrayBuffer | Uint8Array;

export type OcrPhase = 'initializing' | 'recognizing';

export interface OcrProgress {
  pageNumber: number;
  phase: OcrPhase;
  /** 0..1 within the phase. Monotonic non-decreasing per phase for one recognize() call. */
  progress: number;
}

export interface RecognizeOptions {
  /** Echoed into the result. Default 1. */
  pageNumber?: number;
  /** Clockwise rotation of the image relative to the page box, multiples of 90. Default 0. */
  rotation?: number;
  /**
   * Turn a canvas or ImageData clockwise by this many degrees (multiple of 90, default 0) before
   * recognising it. Boxes come back in the turned image's pixels and the result's `rotation` already
   * includes the turn, so they still map to page space. Encoded inputs cannot be turned.
   */
  orientation?: number;
  /** Render scale where 1 = 72 dpi (PDF.js viewport scale). Used as a DPI hint (72 x scale). */
  scale?: number;
  /** Required for encoded inputs (Blob/bytes); ignored for canvas and ImageData. */
  width?: number;
  height?: number;
  signal?: AbortSignal;
  onProgress?: (event: OcrProgress) => void;
}

export interface OcrEngine {
  /**
   * Recognise one page image. Jobs run strictly one at a time in FIFO order on a single worker.
   * Rejects with an `OcrError` (code 'cancelled' when `signal` aborts; the worker is really terminated).
   */
  recognize(source: OcrImageSource, options?: RecognizeOptions): Promise<OcrPage>;
  /**
   * Terminates the worker and rejects every queued/running job as cancelled. The engine stays usable:
   * the next recognize() starts a fresh worker.
   */
  terminate(): Promise<void>;
}

/** Store the job runner persists into (the vault adapts its `ocrPages` table to this). */
export interface OcrJobStore {
  /** Page numbers that already have stored OCR for this document (resume skips them). */
  storedPageNumbers(): Promise<Iterable<number>>;
  saveOcrPage(page: OcrPage): Promise<void>;
}
