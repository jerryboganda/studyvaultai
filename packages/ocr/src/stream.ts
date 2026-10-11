import type { PdfRect } from '@shared/schema';
import { applyCorrections } from './corrections';
import type { CorrectedWord, OcrCorrections } from './corrections';
import { pixelBoxToPageRect, unionBoxes } from './geometry';
import type { OcrPage, OcrRotation, PixelBox } from './types';

/*
 * Page text stream of an OCR'd page (same family as the PDF reader's text-layer stream, so highlights
 * anchor identically whether a page has a text layer or was recognised):
 *
 *  1. Words are taken in the engine's reading order (block > paragraph > line > word), AFTER user
 *     corrections (a corrected word keeps its box; deleted words vanish).
 *  2. Whitespace inside a word is collapsed: every run of [\t\n\v\f\r SPACE NBSP] becomes one space.
 *  3. Consecutive words are joined with exactly ONE space, whether they share a line or not. Line
 *     breaks are not represented (no "\n"), and a trailing hyphen is NOT removed: the stream must stay
 *     faithful to what the page shows or ranges could not be mapped back to boxes.
 *  4. No leading or trailing space. No Unicode normalisation or case folding (lengths stay predictable).
 *  5. `items[i].start/end` are offsets into `text`; `text.slice(start, end) === items[i].text`.
 *     Separator spaces belong to no item.
 *
 * The stream is derived data: it is rebuilt from (page, corrections) every time, never stored, so
 * rule changes only need a new algorithm id, not a data migration.
 */
export const OCR_TEXT_ALGORITHM = 'sv-ocr-text-v1' as const;

export interface OcrTextItem {
  text: string;
  /** Normalised page rect (origin top-left, page rotation 0): selectable overlay text + anchor rects. */
  rect: PdfRect;
  /** Same box in image pixels of the OCR'd image (before rotation mapping). */
  bbox: PixelBox;
  confidence: number;
  line: number;
  start: number;
  end: number;
  source: CorrectedWord['source'];
}

export interface PageTextStream {
  algorithm: typeof OCR_TEXT_ALGORITHM;
  text: string;
  items: OcrTextItem[];
  image: { width: number; height: number; rotation: OcrRotation };
}

export function buildPageTextStream(page: OcrPage, corrections?: OcrCorrections): PageTextStream {
  const image = { width: page.width, height: page.height, rotation: page.rotation };
  const items: OcrTextItem[] = [];
  let text = '';
  for (const word of applyCorrections(page, corrections)) {
    if (word.text.length === 0) continue;
    if (text.length > 0) text += ' ';
    const start = text.length;
    text += word.text;
    items.push({
      text: word.text,
      rect: pixelBoxToPageRect(word.bbox, image, page.rotation),
      bbox: word.bbox,
      confidence: word.confidence,
      line: word.line,
      start,
      end: text.length,
      source: word.source,
    });
  }
  return { algorithm: OCR_TEXT_ALGORITHM, text, items, image };
}

/**
 * Highlight rectangles for the stream range [start, end): one rect per line, in reading order
 * (PdfAnchorSet.rects). Words cut by the range are trimmed proportionally to character count, which is
 * exact for monospace and within a glyph or two for proportional fonts.
 */
export function rectsForStreamRange(stream: PageTextStream, start: number, end: number): PdfRect[] {
  const perLine = new Map<number, PixelBox[]>();
  for (const item of stream.items) {
    const from = Math.max(start, item.start);
    const to = Math.min(end, item.end);
    if (to <= from) continue;
    const length = item.end - item.start;
    const a = (from - item.start) / length;
    const b = (to - item.start) / length;
    const box: PixelBox = {
      x: item.bbox.x + item.bbox.w * a,
      y: item.bbox.y,
      w: item.bbox.w * (b - a),
      h: item.bbox.h,
    };
    const boxes = perLine.get(item.line);
    if (boxes) boxes.push(box);
    else perLine.set(item.line, [box]);
  }
  return [...perLine.values()].map((boxes) =>
    pixelBoxToPageRect(unionBoxes(boxes), stream.image, stream.image.rotation),
  );
}
