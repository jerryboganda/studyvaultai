import { OcrError } from './errors';
import { fitToPixelBudget } from './geometry';
import type { OcrImageSource } from './types';

export interface PreparedImage {
  /** Encoded image (PNG for rasterised sources, the caller's bytes for encoded ones). */
  data: Uint8Array;
  /** Size of the ORIGINAL image; result boxes are expressed in these pixels. */
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

function isEncoded(source: OcrImageSource): source is Blob | ArrayBuffer | Uint8Array {
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
  options: { width?: number; height?: number; maxPixels: number },
): Promise<PreparedImage> {
  if (isEncoded(source)) {
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

  const { width, height } = source;
  const fit = fitToPixelBudget(width, height, options.maxPixels);
  const temp: AnyCanvas[] = [];
  try {
    let full: AnyCanvas;
    if (isImageData(source)) {
      full = createCanvas(width, height);
      temp.push(full);
      (context2d(full) as CanvasRenderingContext2D).putImageData(source, 0, 0);
    } else {
      full = source;
    }
    let out = full;
    if (fit.scaled) {
      out = createCanvas(fit.width, fit.height);
      temp.push(out);
      const ctx = context2d(out);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(full as CanvasImageSource, 0, 0, fit.width, fit.height);
    }
    const data = await canvasToPng(out);
    return { data, width, height, factorX: fit.factorX, factorY: fit.factorY };
  } finally {
    for (const canvas of temp) release(canvas);
  }
}
