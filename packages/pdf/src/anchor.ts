import type { PdfAnchorSet, PdfRect } from '@shared';
import { MAX_QUOTE_CHARS, PDF_TEXT_ALGORITHM } from '@shared/constants';
import { similarity } from '@highlights/fuzzy';
import { clampRect, mergeLineRects, overlapArea } from './geometry';
import { rectsForRange, type PageText } from './pageText';

/** Context kept on each side of the quote (ADR-004 uses the same width for HTML). */
export const CONTEXT_CHARS = 32;
export const MAX_RECTS = 256;

const MAX_OCCURRENCES = 200;
const SHORT_QUOTE_CHARS = 24;
const CONTEXT_WEIGHT = 0.8;
const POSITION_WEIGHT = 0.2;
const POSITION_SCALE = 2000;
const LEAD = 0.15;
const CONTEXT_LEAD = 0.1;
const RECT_MIN_OVERLAP = 0.3;
const RECT_MIN_SIMILARITY = 0.9;

export type PdfCaptureFailure = 'empty' | 'too-long';

export interface BuildAnchorInput {
  documentFingerprint: string;
  pageNumber: number;
  /** Viewport rotation the page was displayed at when the selection was made. */
  rotation: number;
  pageText: PageText;
  /** Stream range of the selection; surrounding whitespace is trimmed here. */
  start: number;
  end: number;
  /** Rects measured on screen, already converted to the raw frame; empty -> derived from geometry. */
  rects: readonly PdfRect[];
}

export type BuildAnchorResult =
  | { ok: true; anchorSet: PdfAnchorSet; exactQuote: string }
  | { ok: false; reason: PdfCaptureFailure };

/** Build the persisted anchor of one selection on one page (ADR-006 "Captured anchor"). */
export function buildPdfAnchor(input: BuildAnchorInput): BuildAnchorResult {
  const { text, signature } = input.pageText;
  let { start, end } = input;
  start = Math.max(0, start);
  end = Math.min(text.length, end);
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  if (end <= start) return { ok: false, reason: 'empty' };
  const exact = text.slice(start, end);
  if (exact.length > MAX_QUOTE_CHARS) return { ok: false, reason: 'too-long' };

  let rects = mergeLineRects(input.rects.map(clampRect));
  if (rects.length === 0) rects = rectsForRange(input.pageText, start, end);
  for (let gap = 0.02; rects.length > MAX_RECTS && gap < 1; gap *= 2)
    rects = mergeLineRects(rects, gap);
  if (rects.length === 0 || rects.length > MAX_RECTS) return { ok: false, reason: 'empty' };

  return {
    ok: true,
    exactQuote: exact,
    anchorSet: {
      type: 'pdf',
      textAlgorithm: PDF_TEXT_ALGORITHM,
      documentFingerprint: input.documentFingerprint,
      pageNumber: input.pageNumber,
      rotation: input.rotation,
      rects,
      textQuote: {
        exact,
        prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
        suffix: text.slice(end, end + CONTEXT_CHARS),
      },
      textPosition: { start, end },
      contentSignature: signature,
      documentTextLength: text.length,
    },
  };
}

export type PdfResolveStatus = 'resolved' | 'changed' | 'ambiguous' | 'orphaned';
export type PdfResolveMethod = 'position' | 'quote' | 'context' | 'rects' | 'none';

export interface PdfResolution {
  status: PdfResolveStatus;
  method: PdfResolveMethod;
  /** 1 = same text at the same place with agreeing context. */
  confidence: number;
  /** Stream range; null for ambiguous/orphaned. */
  start: number | null;
  end: number | null;
  /**
   * Raw-frame rects to paint. Empty unless status is resolved/changed: an ambiguous or orphaned
   * highlight is never painted (never silently on the wrong text).
   */
  rects: PdfRect[];
}

const none = (status: 'ambiguous' | 'orphaned', confidence = 0): PdfResolution => ({
  status,
  method: 'none',
  confidence,
  start: null,
  end: null,
  rects: [],
});

function commonSuffix(text: string, end: number, ctx: string): number {
  let k = 0;
  while (k < ctx.length && k < end && text[end - 1 - k] === ctx[ctx.length - 1 - k]) k++;
  return k;
}

function commonPrefix(text: string, from: number, ctx: string): number {
  let k = 0;
  while (k < ctx.length && from + k < text.length && text[from + k] === ctx[k]) k++;
  return k;
}

function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  for (
    let i = text.indexOf(needle);
    i !== -1 && at.length < MAX_OCCURRENCES;
    i = text.indexOf(needle, i + 1)
  ) {
    at.push(i);
  }
  return at;
}

/**
 * Resolve a stored anchor against the CURRENT text stream of its page (ADR-006 "Resolution order"):
 * exact quote + context, then position, then rect proximity. Whenever there is not exactly one
 * defensible place, the answer is `ambiguous` or `orphaned` and nothing is painted.
 */
export function resolvePdfAnchor(anchor: PdfAnchorSet, pt: PageText): PdfResolution {
  const { exact, prefix, suffix } = anchor.textQuote;
  const { text } = pt;
  const stored = anchor.textPosition.start;
  const sameText = anchor.contentSignature === pt.signature;

  const painted = (start: number, method: PdfResolveMethod, confidence: number): PdfResolution => ({
    status: 'resolved',
    method,
    confidence,
    start,
    end: start + exact.length,
    rects:
      sameText && start === stored
        ? anchor.rects.map(clampRect)
        : rectsForRange(pt, start, start + exact.length),
  });

  // 1. Unchanged page text and the quote sits where it was captured: the stored place is authoritative
  //    (this is what separates two byte-identical repeated passages).
  if (sameText && text.startsWith(exact, stored)) return painted(stored, 'position', 1);

  const hits = occurrences(text, exact);
  const total = prefix.length + suffix.length;
  const scored = hits.map((at) => {
    const before = commonSuffix(text, at, prefix);
    const after = commonPrefix(text, at + exact.length, suffix);
    const context = total === 0 ? 1 : (before + after) / total;
    const proximity = Math.max(0, 1 - Math.abs(at - stored) / POSITION_SCALE);
    return { at, context, score: CONTEXT_WEIGHT * context + POSITION_WEIGHT * proximity };
  });

  if (scored.length === 1) {
    const only = scored[0]!;
    if (exact.length < SHORT_QUOTE_CHARS && only.context < 0.5 && only.at !== stored) {
      return none('ambiguous', only.context); // "Figure 1" somewhere else is not the same place
    }
    return painted(only.at, 'quote', 0.6 + 0.4 * only.context);
  }

  if (scored.length > 1) {
    scored.sort((p, q) => q.score - p.score);
    const [best, second] = [scored[0]!, scored[1]!];
    const lead = best.score - second.score;
    const contextLead = best.context - second.context;
    if (
      (lead >= LEAD && contextLead >= CONTEXT_LEAD) ||
      (best.context === 1 && second.context < 1 && lead >= LEAD)
    ) {
      return painted(best.at, 'context', best.context);
    }
    return none('ambiguous', best.context);
  }

  // 3. The words are not in the stream any more (different extractor, re-OCR): look at what the stored
  //    rectangles cover. Accepted only when it still reads as the same passage.
  return resolveByRects(anchor, pt);
}

function resolveByRects(anchor: PdfAnchorSet, pt: PageText): PdfResolution {
  const { exact } = anchor.textQuote;
  let min = Infinity;
  let max = -Infinity;
  for (const s of pt.segments) {
    const g = s.item >= 0 ? pt.items[s.item] : null;
    if (!g) continue;
    const area = g.box.w * g.box.h;
    if (area <= 0) continue;
    const covered = anchor.rects.some((r) => overlapArea(r, g.box) / area >= RECT_MIN_OVERLAP);
    if (!covered) continue;
    min = Math.min(min, s.start);
    max = Math.max(max, s.end);
  }
  if (!Number.isFinite(min) || max <= min) return none('orphaned');
  const slice = pt.text.slice(min, max);
  const at = slice.indexOf(exact);
  if (at !== -1) {
    const start = min + at;
    return {
      status: 'changed',
      method: 'rects',
      confidence: 0.9,
      start,
      end: start + exact.length,
      rects: anchor.rects.map(clampRect),
    };
  }
  const sim = similarity(exact, slice, RECT_MIN_SIMILARITY);
  if (sim >= RECT_MIN_SIMILARITY) {
    return {
      status: 'changed',
      method: 'rects',
      confidence: sim,
      start: min,
      end: max,
      rects: anchor.rects.map(clampRect),
    };
  }
  return none('orphaned');
}
