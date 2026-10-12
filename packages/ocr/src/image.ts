import { OcrError } from './errors';
import { fitToPixelBudget, turnedSize } from './geometry';
import { lineDirectionFromProfiles } from './orientation';
import type { LineDirection } from './orientation';
import type { OcrImageSource, OcrRotation } from './types';

export interface PreparedImage {
  /** Encoded image (PNG for rasterised sources, the caller's bytes for encoded ones). */
  data: Uint8Array;
  /** Size of the ORIGINAL image after any turn; result boxes are expressed in these pixels. */
  width: number;
  height: number;
  /** sent / original, per axis (1 unless the pixel budget forced a downscale). */
  factorX: number;
  factorY: number;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new OcrError('failed', 'no canvas implementation is available to encode the page image');
}

function context2d(
  canvas: AnyCanvas,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new OcrError('failed', 'a 2d canvas context could not be created');
  return ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

async function canvasToPng(canvas: AnyCanvas): Promise<Uint8Array> {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new OcrError('failed', 'the page image could not be encoded');
  return new Uint8Array(await blob.arrayBuffer());
}

const release = (canvas: AnyCanvas): void => {
  canvas.width = 0;
  canvas.height = 0;
};

export function isEncoded(source: OcrImageSource): source is Blob | ArrayBuffer | Uint8Array {
  return (
    source instanceof Uint8Array ||
    source instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && source instanceof Blob)
  );
}

/** Structural so it also holds for ImageData from another realm (workers, iframes) and in Node tests. */
function isImageData(source: OcrImageSource): source is ImageData {
  return 'data' in source && !('getContext' in source);
}

/**
 * Turns any supported input into encoded bytes within the pixel budget. Runs on the calling thread,
 * once per job (jobs are serialised), so at most one encoded copy of a page is alive at a time.
 */
export async function prepareImage(
  source: OcrImageSource,
  options: { width?: number; height?: number; maxPixels: number; turn?: OcrRotation },
): Promise<PreparedImage> {
  const turn = options.turn ?? 0;
  if (isEncoded(source)) {
    if (turn !== 0) {
      throw new OcrError('failed', 'an encoded image input cannot be turned; pass a canvas');
    }
    const { width, height } = options;
    if (!(Number.isInteger(width) && Number.isInteger(height) && width! > 0 && height! > 0)) {
      throw new OcrError(
        'failed',
        'encoded image inputs need their pixel size (RecognizeOptions.width/height)',
      );
    }
    if (width! * height! > options.maxPixels) {
      throw new OcrError(
        'out-of-memory',
        `encoded image ${width}x${height} exceeds the ${options.maxPixels} pixel budget; render it smaller`,
      );
    }
    const data =
      source instanceof Uint8Array
        ? source
        : source instanceof ArrayBuffer
          ? new Uint8Array(source)
          : new Uint8Array(await source.arrayBuffer());
    return { data, width: width!, height: height!, factorX: 1, factorY: 1 };
  }

  const { width: sourceWidth, height: sourceHeight } = source;
  const { width, height } = turnedSize(sourceWidth, sourceHeight, turn);
  const fit = fitToPixelBudget(width, height, options.maxPixels);
  const temp: AnyCanvas[] = [];
  try {
    let full: AnyCanvas;
    if (isImageData(source)) {
      full = createCanvas(sourceWidth, sourceHeight);
      temp.push(full);
      (context2d(full) as CanvasRenderingContext2D).putImageData(source, 0, 0);
    } else {
      full = source;
    }
    let out = full;
    if (fit.scaled || turn !== 0) {
      out = createCanvas(fit.width, fit.height);
      temp.push(out);
      const ctx = context2d(out);
      ctx.imageSmoothingQuality = 'high';
      if (turn === 0) {
        ctx.drawImage(full as CanvasImageSource, 0, 0, fit.width, fit.height);
      } else {
        // Clockwise turn about the origin, then scale to the budget: (x, y) -> turned -> output.
        const sx = fit.factorX;
        const sy = fit.factorY;
        if (turn === 90) {
          ctx.setTransform(0, sy, -sx, 0, sourceHeight * sx, 0);
        } else if (turn === 180) {
          ctx.setTransform(-sx, 0, 0, -sy, sourceWidth * sx, sourceHeight * sy);
        } else {
          ctx.setTransform(0, -sy, sx, 0, 0, sourceWidth * sy);
        }
        ctx.drawImage(full as CanvasImageSource, 0, 0);
      }
    }
    const data = await canvasToPng(out);
    return { data, width, height, factorX: fit.factorX, factorY: fit.factorY };
  } finally {
    for (const canvas of temp) release(canvas);
  }
}

/** Longest side of the copy whose ink is measured: 400 px keeps a 300 dpi text line a few px tall. */
const PROFILE_SIDE = 400;

/**
 * Which way the lines of text of a canvas or ImageData run (`lineDirectionFromProfiles`), measured on
 * a copy of at most 400 px (about 30 ms for a 9 MP page). `null` when the image cannot be sampled:
 * encoded inputs, or no canvas implementation. Transparent pixels count as paper.
 */
export function inkLineDirection(source: OcrImageSource): LineDirection | null {
  if (isEncoded(source)) return null;
  const { width, height } = source;
  if (!(width >= 1 && height >= 1)) return null;
  const temp: AnyCanvas[] = [];
  try {
    const ratio = Math.min(1, PROFILE_SIDE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    let from: AnyCanvas;
    if (isImageData(source)) {
      from = createCanvas(width, height);
      temp.push(from);
      (context2d(from) as CanvasRenderingContext2D).putImageData(source, 0, 0);
    } else {
      from = source;
    }
    const small = createCanvas(w, h);
    temp.push(small);
    const ctx = context2d(small);
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(from as CanvasImageSource, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const rows = new Float64Array(h);
    const cols = new Float64Array(w);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const ink = 255 - (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
        rows[y]! += ink / w;
        cols[x]! += ink / h;
      }
    }
    return lineDirectionFromProfiles(rows, cols);
  } catch {
    return null;
  } finally {
    for (const canvas of temp) release(canvas);
  }
}
