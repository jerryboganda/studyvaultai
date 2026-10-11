import type { PageText } from './pageText';

export type TextStatus = 'text' | 'scanned' | 'partial';

/** A page with fewer non-space characters than this (a lone page number) counts as having no text. */
export const MIN_TEXT_CHARS = 10;
/** Pages sampled when a document is opened; the rest are learned as they are viewed. */
export const SAMPLE_PAGES = 16;

export function pageHasText(pt: Pick<PageText, 'text'>): boolean {
  let n = 0;
  for (let i = 0; i < pt.text.length && n < MIN_TEXT_CHARS; i++) if (pt.text[i] !== ' ') n++;
  return n >= MIN_TEXT_CHARS;
}

/** Evenly spread page numbers, always including the first and the last. */
export function samplePageNumbers(pageCount: number, max = SAMPLE_PAGES): number[] {
  if (pageCount <= max) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out = new Set<number>();
  for (let k = 0; k < max; k++) out.add(1 + Math.round((k * (pageCount - 1)) / (max - 1)));
  return [...out];
}

/** Document verdict from the per-page verdicts known so far (page number -> has text). */
export function summarizeTextStatus(known: ReadonlyMap<number, boolean>): TextStatus {
  let withText = 0;
  for (const has of known.values()) if (has) withText++;
  if (withText === known.size) return 'text';
  return withText === 0 ? 'scanned' : 'partial';
}
