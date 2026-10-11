import type { PdfRect } from '@shared';

/**
 * Normalised rectangles live in the RAW page box: origin top-left, 0..1 of the page box at viewport
 * rotation 0 (neither /Rotate nor the reader's rotation is applied). That frame is a property of the
 * document alone, so a highlight survives zoom, rotation and reopening (ADR-006).
 */

export type Rotation = 0 | 90 | 180 | 270;

export function normalizeRotation(deg: number): Rotation {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Clamp into the unit square and make sure the result satisfies the PdfRect schema. */
export function clampRect(r: PdfRect): PdfRect {
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  return { x, y, w: Math.min(clamp01(r.w), 1 - x), h: Math.min(clamp01(r.h), 1 - y) };
}

/** Raw-frame rect -> the frame of a viewport rotated clockwise by `rotation`. */
export function rotateRect(r: PdfRect, rotation: number): PdfRect {
  switch (normalizeRotation(rotation)) {
    case 90:
      return { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
    case 180:
      return { x: 1 - (r.x + r.w), y: 1 - (r.y + r.h), w: r.w, h: r.h };
    case 270:
      return { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
    default:
      return r;
  }
}

/** Rect measured in a viewport rotated by `rotation` -> the raw frame. */
export function unrotateRect(r: PdfRect, rotation: number): PdfRect {
  return rotateRect(r, 360 - normalizeRotation(rotation));
}

export function boundsOf(rects: readonly PdfRect[]): PdfRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Area of the intersection of two rects. */
export function overlapArea(a: PdfRect, b: PdfRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * One rect per visual line: rects that share a line (vertical overlap of at least half the shorter
 * one) and touch or nearly touch (gap <= `gap`, in page widths) are united. Input order is irrelevant;
 * output is top-to-bottom, left-to-right, which is reading order for horizontal text.
 */
export function mergeLineRects(rects: readonly PdfRect[], gap = 0.01): PdfRect[] {
  const sorted = rects
    .filter((r) => r.w > 0 && r.h > 0)
    .slice()
    .sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const out: PdfRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const vOverlap = Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y);
      const sameLine = vOverlap >= 0.5 * Math.min(last.h, r.h);
      if (sameLine && r.x <= last.x + last.w + gap && r.x + r.w >= last.x - gap) {
        const x = Math.min(last.x, r.x);
        const y = Math.min(last.y, r.y);
        out[out.length - 1] = {
          x,
          y,
          w: Math.max(last.x + last.w, r.x + r.w) - x,
          h: Math.max(last.y + last.h, r.y + r.h) - y,
        };
        continue;
      }
    }
    out.push(r);
  }
  return out;
}
