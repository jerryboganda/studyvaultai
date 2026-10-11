import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { placeToolbar, type Placement, type Rect } from './placement';

/**
 * Inline style for a floating surface. Hidden until measured, so it never flashes at the origin
 * (and, being hidden, cannot take focus yet: wait for a non-null placement before focusing it).
 * Once placed it is also capped to the layout viewport.
 */
export function floatingStyle(placement: Placement | null): CSSProperties {
  return placement
    ? {
        transform: `translate(${placement.x}px, ${placement.y}px)`,
        maxWidth: placement.maxWidth,
        maxHeight: placement.maxHeight,
      }
    : { visibility: 'hidden' };
}

/**
 * Measures `ref` and places it next to `anchor` before paint. Returns null until measured, so the
 * element can stay hidden instead of flashing at the origin. `layoutKey` re-measures when the
 * content changes shape where ResizeObserver is unavailable.
 */
export function useFloating(
  ref: RefObject<HTMLElement | null>,
  anchor: Rect,
  layoutKey?: unknown,
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const measureRef = useRef<() => void>(() => undefined);
  const { left, top, width, height } = anchor;

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = ref.current;
      if (!el) return;
      const doc = el.ownerDocument;
      const win = doc.defaultView;
      const next = placeToolbar({
        selection: { left, top, width, height },
        toolbar: { w: el.offsetWidth, h: el.offsetHeight },
        viewport: {
          w: doc.documentElement.clientWidth || win?.innerWidth || 0,
          h: doc.documentElement.clientHeight || win?.innerHeight || 0,
        },
      });
      setPlacement((prev) =>
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.placement === next.placement &&
        prev.maxWidth === next.maxWidth &&
        prev.maxHeight === next.maxHeight
          ? prev
          : next,
      );
    };
    measureRef.current = measure;
    measure();
  }, [ref, left, top, width, height, layoutKey]);

  // One observer for the element's lifetime; it always calls the latest measure.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return placement;
}
