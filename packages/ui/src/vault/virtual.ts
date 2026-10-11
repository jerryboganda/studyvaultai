/** Windowing arithmetic for fixed-height rows (pure, unit-tested). */

export interface WindowInput {
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  /** Extra rows rendered above and below the viewport. */
  overscan: number;
}

export interface WindowRange {
  /** First rendered row. */
  start: number;
  /** One past the last rendered row. */
  end: number;
  totalHeight: number;
}

export function computeWindow(input: WindowInput): WindowRange {
  const { count, rowHeight, viewportHeight, overscan } = input;
  const totalHeight = Math.max(0, count) * rowHeight;
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, totalHeight: 0 };
  const maxTop = Math.max(0, totalHeight - viewportHeight);
  const scrollTop = Math.min(Math.max(0, input.scrollTop), maxTop);
  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(Math.max(viewportHeight, 0) / rowHeight) + 1;
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + visible + overscan),
    totalHeight,
  };
}

/** The scrollTop that brings row `index` fully into view with the least movement. */
export function scrollTopFor(
  index: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}
