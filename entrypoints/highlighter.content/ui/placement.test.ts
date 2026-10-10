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
    // centre x = 400 + 100 = 500 -> 500 - 150 = 350; above = 300 - 8 - 40 = 252
    expect(place(rect(400, 300, 200, 20))).toEqual({ x: 350, y: 252, placement: 'above' });
  });

  it('flips below when the selection touches the top edge', () => {
    // above = 5 - 8 - 40 < margin; below = 5 + 20 + 8 = 33
    expect(place(rect(400, 5, 200, 20))).toEqual({ x: 350, y: 33, placement: 'below' });
  });

  it('flips below when the selection is partly scrolled above the viewport', () => {
    const r = place(rect(400, -100, 200, 130));
    expect(r.placement).toBe('below');
    expect(r.y).toBe(38); // bottom = 30, + gap
  });

  it('keeps above at the bottom edge, where below has no room', () => {
    const r = place(rect(400, 760, 200, 20));
    expect(r).toEqual({ x: 350, y: 712, placement: 'above' });
  });

  it('places a tall selection that starts in view above its first line', () => {
    const r = place(rect(100, 200, 700, 3000));
    expect(r.placement).toBe('above');
    expect(r.y).toBe(152);
  });

  it('covers a selection that fills the viewport, on the nearest edge (top)', () => {
    const r = place(rect(100, -500, 700, 3000));
    expect(r).toEqual({ x: 300, y: 8, placement: 'edge' });
  });

  it('uses the bottom edge when the visible part of a tall selection is in the lower half', () => {
    // No room above (top = 20) or below (bottom = 5000); the visible part 20..790 centres at 405.
    const r = place(rect(100, 20, 700, 4980), { viewport: { w: 1000, h: 790 } });
    expect(r.placement).toBe('edge');
    expect(r.y).toBe(790 - 40 - 8);
  });

  it('pins to the bottom edge when the selection is entirely below the viewport', () => {
    expect(place(rect(400, 1500, 200, 20))).toEqual({ x: 350, y: 752, placement: 'edge' });
  });

  it('pins to the top edge when the selection is entirely above the viewport', () => {
    expect(place(rect(400, -300, 200, 20))).toEqual({ x: 350, y: 8, placement: 'edge' });
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
    expect(r).toEqual({ x: 350, y: 8, placement: 'edge' });
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
