// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inkLineDirection } from './image';

/**
 * A canvas whose 2D context returns RGBA pixels from `ink(x, y)` (0 = paper, 255 = black) for the
 * copy it was asked to draw, like the small copy the real code measures.
 */
function stubCanvas(ink: (x: number, y: number, w: number, h: number) => number) {
  class Small {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return {
        imageSmoothingQuality: 'low',
        fillStyle: '',
        fillRect: () => undefined,
        drawImage: () => undefined,
        putImageData: () => undefined,
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const v = 255 - ink(x, y, w, h);
              const i = (y * w + x) * 4;
              data[i] = data[i + 1] = data[i + 2] = v;
              data[i + 3] = 255;
            }
          }
          return { data, width: w, height: h };
        },
      };
    }
  }
  vi.stubGlobal('OffscreenCanvas', Small);
  return Small;
}

afterEach(() => vi.unstubAllGlobals());

describe('inkLineDirection', () => {
  it('reads horizontal lines of text from a 9 MP canvas by measuring a small copy', () => {
    const Canvas = stubCanvas((_x, y) => (y % 4 < 2 ? 200 : 0)); // a ruled page: lines run along x
    const page = new Canvas(2550, 3300);
    expect(inkLineDirection(page as unknown as OffscreenCanvas)).toBe('horizontal');
  });

  it('reads vertical lines (a page stored sideways)', () => {
    const Canvas = stubCanvas((x) => (x % 4 < 2 ? 200 : 0));
    const page = new Canvas(3300, 2550);
    expect(inkLineDirection(page as unknown as OffscreenCanvas)).toBe('vertical');
  });

  it('says unclear for a blank page', () => {
    const Canvas = stubCanvas(() => 0);
    expect(inkLineDirection(new Canvas(100, 100) as unknown as OffscreenCanvas)).toBe('unclear');
  });

  it('cannot judge encoded images or an image with no canvas to sample it on', () => {
    expect(inkLineDirection(new Uint8Array([1, 2, 3]))).toBeNull();
    // Node has no OffscreenCanvas or document here: ImageData would need a canvas to be drawn on.
    const imageData = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    expect(inkLineDirection(imageData as unknown as ImageData)).toBeNull();
  });
});
