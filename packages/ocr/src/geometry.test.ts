import { PdfRect } from '@shared/schema';
import { describe, expect, it } from 'vitest';
import {
  composeRotation,
  fitToPixelBudget,
  normalizeRotation,
  pageRectToPixelBox,
  pageRectToViewRect,
  pixelBoxToPageRect,
  turnedSize,
  unionBoxes,
} from './geometry';
import type { OcrRotation } from './types';

// A 200x100 image; the box sits near the top-left: x 20..60, y 10..30.
const IMAGE = { width: 200, height: 100 };
const BOX = { x: 20, y: 10, w: 40, h: 20 };

const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 10);
const expectRect = (
  actual: { x: number; y: number; w: number; h: number },
  expected: { x: number; y: number; w: number; h: number },
): void => {
  close(actual.x, expected.x);
  close(actual.y, expected.y);
  close(actual.w, expected.w);
  close(actual.h, expected.h);
};

describe('pixelBoxToPageRect', () => {
  it('rotation 0: plain normalisation', () => {
    expectRect(pixelBoxToPageRect(BOX, IMAGE, 0), { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it('rotation 90: image is the page rotated clockwise, so its top-left is the page bottom-left', () => {
    // View rect x 0.1..0.3, y 0.1..0.3. Rotating the page 90deg cw moves the page's top-left corner
    // to the image's top-right, so image-left maps to page-bottom: page y = 1 - viewX1.
    expectRect(pixelBoxToPageRect(BOX, IMAGE, 90), { x: 0.1, y: 0.7, w: 0.2, h: 0.2 });
    // Anchor on the image's top-right corner -> page's top-left corner.
    const corner = pixelBoxToPageRect({ x: 190, y: 0, w: 10, h: 10 }, IMAGE, 90);
    expectRect(corner, { x: 0, y: 0, w: 0.1, h: 0.05 });
  });

  it('rotation 180', () => {
    expectRect(pixelBoxToPageRect(BOX, IMAGE, 180), { x: 0.7, y: 0.7, w: 0.2, h: 0.2 });
    const corner = pixelBoxToPageRect({ x: 190, y: 90, w: 10, h: 10 }, IMAGE, 180);
    expectRect(corner, { x: 0, y: 0, w: 0.05, h: 0.1 });
  });

  it('rotation 270: image top-left is the page top-right', () => {
    expectRect(pixelBoxToPageRect(BOX, IMAGE, 270), { x: 0.7, y: 0.1, w: 0.2, h: 0.2 });
    const corner = pixelBoxToPageRect({ x: 0, y: 0, w: 10, h: 10 }, IMAGE, 270);
    expectRect(corner, { x: 0.9, y: 0, w: 0.1, h: 0.05 });
  });

  it('is the inverse of pageRectToViewRect / pageRectToPixelBox for every rotation', () => {
    for (const rotation of [0, 90, 180, 270] as OcrRotation[]) {
      const page = pixelBoxToPageRect(BOX, IMAGE, rotation);
      const view = pageRectToViewRect(page, rotation);
      expectRect(view, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
      const px = pageRectToPixelBox(page, IMAGE, rotation);
      expectRect(px, BOX);
    }
  });

  it('round-trips arbitrary boxes (property)', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 300; i += 1) {
      const width = 50 + Math.floor(rnd() * 2000);
      const height = 50 + Math.floor(rnd() * 2000);
      const x = Math.floor(rnd() * width * 0.8);
      const y = Math.floor(rnd() * height * 0.8);
      const box = {
        x,
        y,
        w: 1 + Math.floor(rnd() * (width - x - 1)),
        h: 1 + Math.floor(rnd() * (height - y - 1)),
      };
      const rotation = [0, 90, 180, 270][i % 4] as OcrRotation;
      const page = pixelBoxToPageRect(box, { width, height }, rotation);
      expect(PdfRect.safeParse(page).success).toBe(true);
      expectRect(pageRectToPixelBox(page, { width, height }, rotation), box);
    }
  });

  it('produces rects that satisfy the PdfRect schema even for boxes poking out of the image', () => {
    const rect = pixelBoxToPageRect({ x: -5, y: 90, w: 300, h: 40 }, IMAGE, 0);
    expect(PdfRect.safeParse(rect).success).toBe(true);
    expect(rect.x).toBe(0);
    expect(rect.x + rect.w).toBe(1);
    expect(rect.y + rect.h).toBe(1);
  });

  it('keeps the same page rect when the page is re-rendered at another size and rotation', () => {
    // Same physical region, page rendered at 2x scale and rotated 90 degrees (image 400x200 -> 200x400).
    const a = pixelBoxToPageRect({ x: 40, y: 20, w: 80, h: 40 }, { width: 400, height: 200 }, 0);
    // In the rotated render the region is at view x = 1 - (y + h), y = x.
    const view = pageRectToViewRect(a, 90);
    const b = pixelBoxToPageRect(
      { x: view.x * 200, y: view.y * 400, w: view.w * 200, h: view.h * 400 },
      { width: 200, height: 400 },
      90,
    );
    expectRect(b, a);
  });
});

describe('normalizeRotation', () => {
  it('accepts multiples of 90 and wraps', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
  });
  it('rejects anything else', () => {
    expect(() => normalizeRotation(45)).toThrow(RangeError);
    expect(() => normalizeRotation(Number.NaN)).toThrow(RangeError);
  });
});

describe('fitToPixelBudget', () => {
  it('leaves images within budget alone', () => {
    expect(fitToPixelBudget(2480, 3508, 10_000_000)).toEqual({
      width: 2480,
      height: 3508,
      factorX: 1,
      factorY: 1,
      scaled: false,
    });
  });

  it('scales oversize images under the budget keeping aspect ratio', () => {
    const fit = fitToPixelBudget(8000, 6000, 10_000_000);
    expect(fit.scaled).toBe(true);
    expect(fit.width * fit.height).toBeLessThanOrEqual(10_000_000);
    expect(fit.width * fit.height).toBeGreaterThan(9_900_000);
    close(fit.factorX, fit.width / 8000);
    close(fit.factorY, fit.height / 6000);
    expect(Math.abs(fit.width / fit.height - 8000 / 6000)).toBeLessThan(0.01);
  });

  it('rejects empty images', () => {
    expect(() => fitToPixelBudget(0, 10, 1000)).toThrow(RangeError);
  });
});

describe('unionBoxes', () => {
  it('returns the bounding box', () => {
    expect(
      unionBoxes([
        { x: 10, y: 10, w: 5, h: 5 },
        { x: 30, y: 8, w: 5, h: 5 },
      ]),
    ).toEqual({ x: 10, y: 8, w: 25, h: 7 });
    expect(unionBoxes([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('a page turned after it was rendered (sideways and upside-down scans)', () => {
  // Reference model, independent of the module: pixels are turned one quarter at a time, the way
  // a canvas is: a clockwise quarter takes (x, y) of a W x H image to (H - y, x) of a H x W one.
  type Box = { x: number; y: number; w: number; h: number };
  const quarter = (box: Box, size: { width: number; height: number }) => ({
    box: { x: size.height - (box.y + box.h), y: box.x, w: box.h, h: box.w },
    size: { width: size.height, height: size.width },
  });
  const turn = (box: Box, size: { width: number; height: number }, degrees: number) => {
    let cur = { box, size };
    for (let i = 0; i < degrees / 90; i += 1) cur = quarter(cur.box, cur.size);
    return cur;
  };

  it('composes the page rotation with the turn', () => {
    expect(composeRotation(0, 90)).toBe(90);
    expect(composeRotation(270, 90)).toBe(0);
    expect(composeRotation(90, 270)).toBe(0);
    expect(composeRotation(180, 180)).toBe(0);
    expect(composeRotation(270, 180)).toBe(90);
    expect(() => composeRotation(45, 0)).toThrow(RangeError);
  });

  it('swaps the axes for a quarter turn only', () => {
    expect(turnedSize(300, 200, 0)).toEqual({ width: 300, height: 200 });
    expect(turnedSize(300, 200, 90)).toEqual({ width: 200, height: 300 });
    expect(turnedSize(300, 200, 180)).toEqual({ width: 300, height: 200 });
    expect(turnedSize(300, 200, 270)).toEqual({ width: 200, height: 300 });
  });

  it('maps a word of the turned image back to its place on the page, for every turn and every page /Rotate', () => {
    // A word at a known place of the raw page (1000 x 1400 px): x 120..420, y 200..260.
    const raw = { width: 1000, height: 1400 };
    const word = { x: 120, y: 200, w: 300, h: 60 };
    const expected = { x: 0.12, y: 200 / 1400, w: 0.3, h: 60 / 1400 };
    for (const pageRotation of [0, 90, 180, 270]) {
      for (const orientation of [0, 90, 180, 270]) {
        const shown = turn(word, raw, pageRotation); // the page as it is displayed (/Rotate)
        const read = turn(shown.box, shown.size, orientation); // turned to be read
        const rect = pixelBoxToPageRect(
          read.box,
          read.size,
          composeRotation(pageRotation, orientation),
        );
        expectRect(rect, expected);
        expect(PdfRect.safeParse(rect).success).toBe(true);
      }
    }
  });

  it('puts the lines of a page stored with text running bottom to top on the right page edge', () => {
    // MSFC slides: lines run bottom to top, /Rotate 0. Turned 90 clockwise they read upright, and the
    // first line (top of the turned image) is the LEFT edge of the stored page.
    const image = { width: 3300, height: 2541 }; // the page turned 90: 2541 x 3300 became 3300 x 2541
    const firstLine = { x: 400, y: 100, w: 1500, h: 90 };
    const rect = pixelBoxToPageRect(firstLine, image, composeRotation(0, 90));
    expect(rect.x).toBeLessThan(0.1); // near the left edge of the stored page
    expect(rect.h).toBeGreaterThan(rect.w); // wider than high when read, so high when stored
  });
});
