import type { PdfRect } from '@shared/schema';
import type { OcrRotation, PixelBox } from './types';

/*
 * Coordinate spaces
 *  - image px      : the rendered page image the recogniser saw, origin top-left, y down.
 *  - view space    : the same image divided by its size (0..1). Rotated by `rotation` w.r.t. the page.
 *  - page space    : PdfRect: 0..1 of the page box, origin top-left, rotation 0. Stable under zoom,
 *                    rotation and re-rendering, which is why anchors are stored in it.
 * `rotation` is the clockwise rotation (PDF.js viewport rotation) the image has relative to page space.
 */

export interface ImageSize {
  width: number;
  height: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Accepts multiples of 90 in any range (-90, 450 ...); anything else is a caller bug. */
export function normalizeRotation(degrees: number): OcrRotation {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) {
    throw new RangeError(`rotation must be a multiple of 90 degrees, got ${degrees}`);
  }
  return (((degrees % 360) + 360) % 360) as OcrRotation;
}

/**
 * Rotation of an image that was turned clockwise by `turn` after being rendered at `rotation` (the
 * page's displayed rotation): the value `pixelBoxToPageRect` needs to map its boxes to page space.
 */
export function composeRotation(rotation: number, turn: number): OcrRotation {
  return normalizeRotation(normalizeRotation(rotation) + normalizeRotation(turn));
}

/** Size of an image of `width` x `height` after a clockwise turn (axes swap for 90 and 270). */
export function turnedSize(width: number, height: number, turn: OcrRotation): ImageSize {
  return turn === 90 || turn === 270 ? { width: height, height: width } : { width, height };
}

/** View space (0..1 of the rotated image) -> page space. */
function viewToPage(x: number, y: number, w: number, h: number, rotation: OcrRotation): PdfRect {
  switch (rotation) {
    case 0:
      return { x, y, w, h };
    case 90:
      return { x: y, y: 1 - x - w, w: h, h: w };
    case 180:
      return { x: 1 - x - w, y: 1 - y - h, w, h };
    case 270:
      return { x: 1 - y - h, y: x, w: h, h: w };
  }
}

/** Page space -> view space (inverse of `viewToPage`). */
export function pageRectToViewRect(rect: PdfRect, rotation: OcrRotation): PdfRect {
  const { x, y, w, h } = rect;
  switch (rotation) {
    case 0:
      return { x, y, w, h };
    case 90:
      return { x: 1 - y - h, y: x, w: h, h: w };
    case 180:
      return { x: 1 - x - w, y: 1 - y - h, w, h };
    case 270:
      return { x: y, y: 1 - x - w, w: h, h: w };
  }
}

/** Image-pixel box -> normalised page rect (rotation-aware, clamped to 0..1). */
export function pixelBoxToPageRect(
  box: PixelBox,
  image: ImageSize,
  rotation: OcrRotation = 0,
): PdfRect {
  if (!(image.width > 0 && image.height > 0)) {
    throw new RangeError('image size must be positive');
  }
  const r = viewToPage(
    box.x / image.width,
    box.y / image.height,
    box.w / image.width,
    box.h / image.height,
    rotation,
  );
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  return { x, y, w: clamp01(r.x + r.w) - x, h: clamp01(r.y + r.h) - y };
}

/** Normalised page rect -> box in the pixels of an image rendered at `rotation` (overlay positioning). */
export function pageRectToPixelBox(
  rect: PdfRect,
  image: ImageSize,
  rotation: OcrRotation = 0,
): PixelBox {
  const v = pageRectToViewRect(rect, rotation);
  return {
    x: v.x * image.width,
    y: v.y * image.height,
    w: v.w * image.width,
    h: v.h * image.height,
  };
}

/** Smallest box containing every input box. */
export function unionBoxes(boxes: readonly PixelBox[]): PixelBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface PixelBudget {
  /** Size actually sent to the recogniser. */
  width: number;
  height: number;
  /** sent / original; boxes are divided by these to get back to original pixels. */
  factorX: number;
  factorY: number;
  scaled: boolean;
}

/**
 * Keeps width*height <= maxPixels (aspect preserved) so one page can never ask the wasm heap for an
 * unbounded Leptonica image. A US Letter page at 300 dpi is 8.4 MP, so the 10 MP default only
 * ever touches posters and over-sampled scans.
 */
export function fitToPixelBudget(width: number, height: number, maxPixels: number): PixelBudget {
  if (!(width >= 1 && height >= 1) || !Number.isFinite(width * height)) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
  if (width * height <= maxPixels) {
    return { width, height, factorX: 1, factorY: 1, scaled: false };
  }
  const ratio = Math.sqrt(maxPixels / (width * height));
  const w = Math.max(1, Math.floor(width * ratio));
  const h = Math.max(1, Math.floor(height * ratio));
  return { width: w, height: h, factorX: w / width, factorY: h / height, scaled: true };
}
