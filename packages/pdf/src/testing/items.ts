import type { PageTextItem } from '../pageText';

/** An upright Helvetica-ish item: advance = 0.5 em per character. Test-only. */
export function mk(str: string, x: number, y: number, size = 12, width?: number): PageTextItem {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: width ?? str.length * size * 0.5,
    height: size,
    dir: 'ltr',
  };
}
