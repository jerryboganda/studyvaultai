import { describe, expect, it } from 'vitest';
import { computeWindow, scrollTopFor } from './virtual';

describe('computeWindow', () => {
  const base = { count: 10_000, rowHeight: 50, viewportHeight: 500, overscan: 5 };

  it('renders the viewport plus overscan, however many rows exist', () => {
    const w = computeWindow({ ...base, scrollTop: 0 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(0 + 11 + 5);
    expect(w.totalHeight).toBe(500_000);
  });

  it('moves with the scroll position', () => {
    const w = computeWindow({ ...base, scrollTop: 25_000 });
    expect(w.start).toBe(500 - 5);
    expect(w.end).toBe(500 + 11 + 5);
  });

  it('clamps at the end of the list', () => {
    const w = computeWindow({ ...base, scrollTop: 10_000_000 });
    expect(w.end).toBe(10_000);
    expect(w.start).toBeGreaterThan(9_900);
  });

  it('handles empty and degenerate input', () => {
    expect(computeWindow({ ...base, count: 0, scrollTop: 0 })).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
    });
    expect(computeWindow({ ...base, rowHeight: 0, scrollTop: 0 }).end).toBe(0);
    expect(computeWindow({ ...base, count: 3, scrollTop: -50 })).toMatchObject({
      start: 0,
      end: 3,
    });
  });
});

describe('scrollTopFor', () => {
  it('only moves when the row is outside the viewport', () => {
    expect(scrollTopFor(5, 50, 0, 500)).toBe(0);
    expect(scrollTopFor(12, 50, 0, 500)).toBe(150);
    expect(scrollTopFor(2, 50, 400, 500)).toBe(100);
    expect(scrollTopFor(0, 50, 0, 500)).toBe(0);
  });
});
