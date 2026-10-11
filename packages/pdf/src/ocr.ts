import type { PdfRect } from '@shared';
import { cyrb53Hex } from '@highlights/hash';
import { clampRect } from './geometry';
import type { TextContent } from './engine';
import type { ItemGeometry, PageText, TextSegment } from './pageText';

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
  /**
   * Visual line the recogniser put the word on, words listed in reading order. Derived from the boxes
   * when absent (data stored before lines were kept).
   */
  line?: number;
  /** Engine confidence 0..100; absent for words the person typed. */
  confidence?: number;
  /** True for words that come from a person's correction, not from the recogniser. */
  edited?: boolean;
}

/** Text algorithm id of the OCR page stream (the same id `@ocr` publishes as OCR_TEXT_ALGORITHM). */
export const OCR_TEXT_ALGORITHM = 'sv-ocr-text-v1' as const;
/**
 * `PageText.signature` of an OCR stream starts with this, so `PdfAnchorSet.contentSignature` records
 * that the anchor space is recognised text (the anchor schema only admits `sv-pdf-text-v1` as
 * `textAlgorithm`). A later corrected or re-run OCR changes the signature, and resolution then goes
 * by quote, context and rectangles instead of trusting the stored offset (ADR-006, "OCR pages").
 */
export const OCR_SIGNATURE_PREFIX = 'ocr1:';

export function isOcrSignature(contentSignature: string): boolean {
  return contentSignature.startsWith(OCR_SIGNATURE_PREFIX);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const WS = /[\t\n\v\f\r \u00A0]+/g;
const cleanText = (s: string): string => s.replace(CONTROL, '').replace(WS, ' ').trim();

/** Words that take part in the stream: boxed, non-empty after cleaning. Index space of both builders. */
export function usableOcrWords(words: readonly OcrWordInput[]): OcrWordInput[] {
  const out: OcrWordInput[] = [];
  for (const w of words) {
    const text = cleanText(w.text);
    if (text !== '' && w.w > 0 && w.h > 0) out.push({ ...w, text });
  }
  return out;
}

/** Line numbers per word: the given ones, or consecutive words are grouped by vertical overlap. */
export function ocrLineNumbers(words: readonly OcrWordInput[]): number[] {
  if (words.every((w) => typeof w.line === 'number')) return words.map((w) => w.line as number);
  let line = -1;
  let ref = Number.NaN;
  let height = 0;
  return words.map((w) => {
    const cy = w.y + w.h / 2;
    if (!(Math.abs(cy - ref) <= 0.6 * Math.min(w.h, height))) line += 1;
    ref = cy;
    height = w.h;
    return line;
  });
}

/**
 * Page text stream `sv-ocr-text-v1` as a `PageText`, so selection, search, anchors and resolution run on
 * recognised text exactly as on a PDF's own. Words stay in the recogniser's reading order and are joined
 * with ONE space whether or not they share a line; line ends only add a `<br>` to the text layer. No
 * hyphen repair (the stream must stay faithful to the picture), no case folding. Input is expected to
 * have gone through `usableOcrWords` (the same list feeds `ocrWordsToContent`).
 *
 * Every word but the last carries its stream separator as a trailing space in its own text-layer string
 * (as most PDF text items do), so copying selected recognised text keeps its spaces. The item's box is
 * stretched by that one character so the word's letters stay on the recogniser's box.
 */
export function buildOcrPageText(words: readonly OcrWordInput[]): PageText {
  const lines = ocrLineNumbers(words);
  const strs = words.map((w) => cleanText(w.text));
  const valid = (i: number): boolean => strs[i] !== '' && words[i]!.w > 0 && words[i]!.h > 0;
  let last = -1;
  words.forEach((_, i) => {
    if (valid(i)) last = i;
  });
  let text = '';
  const segments: TextSegment[] = [];
  const items: Array<ItemGeometry | null> = [];
  const order: number[] = [];
  const lineEnds = new Set<number>();
  const byItem = new Map<number, TextSegment[]>();
  words.forEach((w, i) => {
    if (!valid(i)) {
      items.push(null);
      return;
    }
    const str = strs[i]!;
    const trailing = i === last ? 0 : 1;
    const stretch = (str.length + trailing) / str.length;
    const r = clampRect(w);
    items.push({
      box: clampRect({ ...r, w: r.w * stretch }),
      // Bottom-left origin, advance along +x, "up" towards -y (raw frame, y down).
      quad: [r.x, r.y + r.h, r.w * stretch, 0, 0, -r.h],
      length: str.length + trailing,
    });
    const own: TextSegment[] = [
      {
        item: i,
        rawStart: 0,
        rawEnd: str.length,
        start: text.length,
        end: text.length + str.length,
      },
    ];
    text += str;
    if (trailing) {
      own.push({
        item: i,
        rawStart: str.length,
        rawEnd: str.length + 1,
        start: text.length,
        end: text.length + 1,
      });
      text += ' ';
    }
    segments.push(...own);
    byItem.set(i, own);
    const previous = order[order.length - 1];
    if (previous !== undefined && lines[previous] !== lines[i]) lineEnds.add(order.length - 1);
    order.push(i);
  });
  if (order.length > 0) lineEnds.add(order.length - 1);
  return {
    text,
    signature: OCR_SIGNATURE_PREFIX + cyrb53Hex(text),
    algorithm: OCR_TEXT_ALGORITHM,
    segments,
    items,
    order,
    lineEnds,
    itemSegments: byItem,
  };
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
 * its box, so the same text stream, selection and anchor code works on OCR text unchanged. Every word
 * but the last ends in the space that separates it from the next one (see buildOcrPageText).
 */
export function ocrWordsToContent(
  words: readonly OcrWordInput[],
  view: readonly number[],
): TextContent {
  const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = view;
  const W = x1 - x0;
  const H = y1 - y0;
  const usable = usableOcrWords(words);
  const items = usable.map((w, i) => {
    const size = Math.max(1, w.h * H * 0.85);
    const trailing = i === usable.length - 1 ? 0 : 1;
    return {
      str: trailing ? w.text + ' ' : w.text,
      dir: 'ltr',
      // Baseline: bottom of the box raised by the descent allowance used for geometry.
      transform: [size, 0, 0, size, x0 + w.x * W, y1 - (w.y + w.h) * H + 0.2 * w.h * H],
      width: w.w * W * ((w.text.length + trailing) / w.text.length),
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
