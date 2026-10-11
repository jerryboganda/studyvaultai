import { describe, expect, it } from 'vitest';
import { placeToolbar, type Rect } from './placement';

const VIEWPORT = { w: 1000, h: 800 };
const TOOLBAR = { w: 300, h: 40 };

const rect = (left: number, top: number, width: number, height: number): Rect => ({
  left,
  top,
  width,
  height,
});

const place = (selection: Rect, over: Partial<Parameters<typeof placeToolbar>[0]> = {}) =>
  placeToolbar({ selection, toolbar: TOOLBAR, viewport: VIEWPORT, ...over });

describe('placeToolbar', () => {
  it('prefers the space above the selection, centred on it', () => {
    // centre x = 400 + 100 = 500 -> 500 - 150 = 350; above = 300 - 12 - 40 = 248
    expect(place(rect(400, 300, 200, 20))).toMatchObject({ x: 350, y: 248, placement: 'above' });
  });

  it('flips below when the selection touches the top edge', () => {
    // above = 5 - 12 - 40 < margin; below = 5 + 20 + 12 = 37
    expect(place(rect(400, 5, 200, 20))).toMatchObject({ x: 350, y: 37, placement: 'below' });
  });

  it('flips below when the selection is partly scrolled above the viewport', () => {
    const r = place(rect(400, -100, 200, 130));
    expect(r.placement).toBe('below');
    expect(r.y).toBe(42); // bottom = 30, + gap
  });

  it('keeps above at the bottom edge, where below has no room', () => {
    const r = place(rect(400, 760, 200, 20));
    expect(r).toMatchObject({ x: 350, y: 708, placement: 'above' });
  });

  it('places a tall selection that starts in view above its first line', () => {
    const r = place(rect(100, 200, 700, 3000));
    expect(r.placement).toBe('above');
    expect(r.y).toBe(148);
  });

  it('covers a selection that fills the viewport, on the nearest edge (top)', () => {
    const r = place(rect(100, -500, 700, 3000));
    expect(r).toMatchObject({ x: 300, y: 8, placement: 'edge' });
  });

  it('uses the bottom edge when the visible part of a tall selection is in the lower half', () => {
    // No room above (top = 20) or below (bottom = 5000); the visible part 20..790 centres at 405.
    const r = place(rect(100, 20, 700, 4980), { viewport: { w: 1000, h: 790 } });
    expect(r.placement).toBe('edge');
    expect(r.y).toBe(790 - 40 - 8);
  });

  it('pins to the bottom edge when the selection is entirely below the viewport', () => {
    expect(place(rect(400, 1500, 200, 20))).toMatchObject({ x: 350, y: 752, placement: 'edge' });
  });

  it('pins to the top edge when the selection is entirely above the viewport', () => {
    expect(place(rect(400, -300, 200, 20))).toMatchObject({ x: 350, y: 8, placement: 'edge' });
  });

  it('clamps to the left margin', () => {
    expect(place(rect(0, 300, 20, 20)).x).toBe(8);
  });

  it('clamps to the right margin', () => {
    expect(place(rect(980, 300, 20, 20)).x).toBe(1000 - 300 - 8);
  });

  it('pins to the left margin when the toolbar is wider than a narrow viewport', () => {
    const r = place(rect(50, 300, 100, 20), { viewport: { w: 280, h: 800 } });
    expect(r.x).toBe(8);
    expect(r.placement).toBe('above');
  });

  it('honours a custom gap and margin', () => {
    const r = place(rect(400, 300, 200, 20), { gap: 20, margin: 30 });
    expect(r.y).toBe(300 - 20 - 40);
    const clamped = place(rect(0, 300, 10, 20), { margin: 30 });
    expect(clamped.x).toBe(30);
  });

  it('takes the top edge when the toolbar is taller than the viewport', () => {
    const r = place(rect(400, 300, 200, 20), { toolbar: { w: 300, h: 900 } });
    expect(r).toMatchObject({ x: 350, y: 8, placement: 'edge' });
  });

  it('reports the largest size that still fits inside the margins', () => {
    const r = place(rect(400, 300, 200, 20));
    expect(r.maxWidth).toBe(1000 - 16);
    expect(r.maxHeight).toBe(800 - 16);
    const custom = place(rect(400, 300, 200, 20), { margin: 20, viewport: { w: 640, h: 360 } });
    expect(custom).toMatchObject({ maxWidth: 600, maxHeight: 320 });
  });

  it('places an oversized element as the largest one that fits: on the margins, never off screen', () => {
    // 388px tall in a 360px viewport (200% zoom of 1280x720): capped to 344px, so top = margin.
    const r = place(rect(200, 150, 160, 20), {
      toolbar: { w: 424, h: 388 },
      viewport: { w: 640, h: 360 },
    });
    expect(r).toMatchObject({ y: 8, placement: 'edge', maxHeight: 344 });
    expect(r.y + Math.min(388, r.maxHeight)).toBeLessThanOrEqual(360 - 8);
    const wide = place(rect(200, 150, 160, 20), {
      toolbar: { w: 900, h: 40 },
      viewport: { w: 640, h: 360 },
    });
    expect(wide.x).toBe(8);
    expect(wide.maxWidth).toBe(624);
    expect(wide.x + Math.min(900, wide.maxWidth)).toBeLessThanOrEqual(640 - 8);
  });

  it('never reports a negative limit for a viewport smaller than the margins', () => {
    const r = place(rect(0, 0, 10, 10), { viewport: { w: 10, h: 10 } });
    expect(r.maxWidth).toBe(0);
    expect(r.maxHeight).toBe(0);
  });

  it('stays inside a 320x256 viewport for any selection and any element size', () => {
    const viewport = { w: 320, h: 256 };
    for (const size of [
      { w: 100, h: 40 },
      { w: 424, h: 80 },
      { w: 300, h: 388 },
      { w: 560, h: 260 },
    ]) {
      for (let top = -300; top <= 500; top += 50) {
        for (const left of [-50, 0, 150, 300, 400]) {
          const r = placeToolbar({
            selection: rect(left, top, 80, 20),
            toolbar: size,
            viewport,
          });
          const w = Math.min(size.w, r.maxWidth);
          const h = Math.min(size.h, r.maxHeight);
          const where = `size=${size.w}x${size.h} top=${top} left=${left}`;
          expect(r.x, where).toBeGreaterThanOrEqual(8);
          expect(r.x + w, where).toBeLessThanOrEqual(viewport.w - 8);
          expect(r.y, where).toBeGreaterThanOrEqual(8);
          expect(r.y + h, where).toBeLessThanOrEqual(viewport.h - 8);
        }
      }
    }
  });

  it('stays clear of the whole line box of the selected word, not just its glyph box', () => {
    // 20px text with a 40px line height, wrapped over two lines. The word on line 2 has a glyph box
    // of 23px; its line box reaches 8.5px above and below it. The seam between line 1 and line 2 is
    // the top of that line box, and a click there selects the word and then has to reach the page
    // again (triple click), so the toolbar must end above the seam, not 8px above the glyphs.
    const lineTop = 300;
    const halfLeading = (40 - 23) / 2;
    const glyphs = rect(400, lineTop + halfLeading, 60, 23);
    const above = place(glyphs);
    expect(above.placement).toBe('above');
    expect(above.y + TOOLBAR.h).toBeLessThanOrEqual(lineTop);

    // Same word on a line near the top: the toolbar flips below, and must start under the line box.
    const lineBottom = 10 + 40;
    const top = rect(400, 10 + halfLeading, 60, 23);
    const below = place(top);
    expect(below.placement).toBe('below');
    expect(below.y).toBeGreaterThanOrEqual(lineBottom);
  });

  it('keeps at least a 12px gap to the glyph box above and below by default', () => {
    const a = place(rect(400, 300, 60, 20));
    expect(300 - (a.y + TOOLBAR.h)).toBeGreaterThanOrEqual(12);
    const b = place(rect(400, 5, 60, 20));
    expect(b.y - (5 + 20)).toBeGreaterThanOrEqual(12);
  });

  it('rounds to whole pixels', () => {
    const r = place(rect(400.4, 300.6, 99.3, 20.2));
    expect(Number.isInteger(r.x)).toBe(true);
    expect(Number.isInteger(r.y)).toBe(true);
  });

  it('never overlaps the selection and stays inside the viewport whenever it reports above/below', () => {
    const margin = 8;
    for (let top = -400; top <= 1200; top += 37) {
      for (const height of [14, 60, 400, 900]) {
        for (const left of [0, 120, 480, 940]) {
          const selection = rect(left, top, 60, height);
          const r = place(selection);
          expect(r.x).toBeGreaterThanOrEqual(margin);
          expect(r.x + TOOLBAR.w).toBeLessThanOrEqual(VIEWPORT.w - margin);
          if (r.placement === 'edge') continue;
          expect(r.y).toBeGreaterThanOrEqual(margin);
          expect(r.y + TOOLBAR.h).toBeLessThanOrEqual(VIEWPORT.h - margin);
          const overlaps = r.y < top + height && r.y + TOOLBAR.h > top;
          expect(overlaps, `top=${top} height=${height}`).toBe(false);
        }
      }
    }
  });
});
