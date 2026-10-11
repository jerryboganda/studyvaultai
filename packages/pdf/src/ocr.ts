import type { PdfRect } from '@shared';
import { clampRect } from './geometry';
import type { TextContent } from './engine';

/**
 * Port to the OCR module (`@ocr`, delivered by the ocr task). The reader depends only on this shape,
 * so wiring is one assignment in entrypoints/pdf-reader/ocr.ts. Until then the reader's "OCR this
 * document" action is disabled with an explanation. OCR output is machine-generated: the reader
 * labels text that comes from it and never presents it as the PDF's own text.
 */
export interface OcrWord {
  text: string;
  /** Pixels of the image passed to `recognizePage`, origin top-left. */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface OcrPageResult {
  text: string;
  words: OcrWord[];
  /** Engine confidence 0..1 when known. */
  confidence?: number | null;
  language?: string;
  engine?: string;
}

export interface OcrPort {
  /**
   * Recognise one page. The reader passes the page rendered at rotation 0 (the unrotated page box),
   * so word boxes divided by the image size are in the reader's normalised raw frame.
   */
  recognizePage(pageNumber: number, image: HTMLCanvasElement | ImageData): Promise<OcrPageResult>;
  /** Abort the page in flight and drop queued work. */
  cancel(): void;
}

/** A recognised word in the normalised raw page frame (what the store keeps per OCR word). */
export interface OcrWordInput extends PdfRect {
  text: string;
}

export function normalizeOcrWords(
  words: readonly OcrWord[],
  imageWidth: number,
  imageHeight: number,
): OcrWordInput[] {
  if (imageWidth <= 0 || imageHeight <= 0) return [];
  return words
    .filter((w) => w.text.trim() !== '' && w.bbox.w > 0 && w.bbox.h > 0)
    .map((w) => ({
      text: w.text,
      ...clampRect({
        x: w.bbox.x / imageWidth,
        y: w.bbox.y / imageHeight,
        w: w.bbox.w / imageWidth,
        h: w.bbox.h / imageHeight,
      }),
    }));
}

/**
 * Stand-in for pdf.js text content of a page that has none: one item per recognised word, placed from
 * its box, so the same text stream, selection and anchor code works on OCR text unchanged.
 */
export function ocrWordsToContent(
  words: readonly OcrWordInput[],
  view: readonly number[],
): TextContent {
  const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = view;
  const W = x1 - x0;
  const H = y1 - y0;
  const items = words
    .filter((w) => w.text.trim() !== '')
    .map((w) => {
      const size = Math.max(1, w.h * H * 0.85);
      return {
        str: w.text,
        dir: 'ltr',
        // Baseline: bottom of the box raised by the descent allowance used for geometry.
        transform: [size, 0, 0, size, x0 + w.x * W, y1 - (w.y + w.h) * H + 0.2 * w.h * H],
        width: w.w * W,
        height: size,
        fontName: 'sv-ocr',
        hasEOL: false,
      };
    });
  return {
    items,
    styles: { 'sv-ocr': { fontFamily: 'sans-serif', ascent: 0.9, descent: -0.2, vertical: false } },
    lang: null,
  } as unknown as TextContent;
}

export interface OcrRunOptions {
  pages: readonly number[];
  port: OcrPort;
  /** Draw a page at rotation 0 for recognition. */
  render(pageNumber: number): Promise<HTMLCanvasElement | ImageData>;
  /** Persist one page's words (normalised) and text. */
  save(pageNumber: number, result: OcrPageResult, words: OcrWordInput[]): Promise<void>;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
}

export interface OcrRunResult {
  done: number[];
  failed: Array<{ page: number; message: string }>;
  cancelled: boolean;
}

/** Sequential, cancellable page loop. One failing page does not stop the others. */
export async function runOcr(opts: OcrRunOptions): Promise<OcrRunResult> {
  const out: OcrRunResult = { done: [], failed: [], cancelled: false };
  const stop = (): void => opts.port.cancel();
  opts.signal?.addEventListener('abort', stop, { once: true });
  try {
    for (const [i, page] of opts.pages.entries()) {
      if (opts.signal?.aborted) {
        out.cancelled = true;
        break;
      }
      try {
        const image = await opts.render(page);
        const size = 'width' in image ? { w: image.width, h: image.height } : { w: 0, h: 0 };
        const result = await opts.port.recognizePage(page, image);
        if (opts.signal?.aborted) {
          out.cancelled = true;
          break;
        }
        await opts.save(page, result, normalizeOcrWords(result.words, size.w, size.h));
        out.done.push(page);
      } catch (err) {
        if (opts.signal?.aborted) {
          out.cancelled = true;
          break;
        }
        out.failed.push({
          page,
          message: err instanceof Error ? err.message : 'Recognition failed.',
        });
      }
      opts.onProgress?.(i + 1, opts.pages.length);
    }
  } finally {
    opts.signal?.removeEventListener('abort', stop);
  }
  return out;
}
