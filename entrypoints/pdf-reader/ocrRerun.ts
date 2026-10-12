import { buildOcrPageText, resolvePdfAnchor, usableOcrWords, type PdfResolveStatus } from '@pdf';
import type { HighlightView, PdfAnchorSet, PdfRect } from '@shared';
import { emptyCorrections, setLineText, type OcrCorrections } from '@ocr/corrections';
import { pixelBoxToPageRect } from '@ocr/geometry';
import type { OcrJobSummary } from '@ocr/runner';
import type { OcrPage } from '@ocr/types';
import {
  MACHINE,
  correctedLines,
  describeOutcome,
  plural,
  wordsFor,
  type OcrOutcome,
  type PageOcr,
} from './ocrModel';

/**
 * Reading a page again (ADR-006 Amendment 5). Pure and unit-tested: what the person corrected is carried
 * onto the new reading by where the line sits, what highlights do on the new text is checked with the
 * anchor machinery itself, and the result is put into words. The cost estimate is in ocrModel.ts (the
 * panel asks with it); this module is loaded when a page is read again.
 */

// ---------------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------------

/** Two line boxes are the same line when they overlap by at least this share of their union. */
export const MIN_LINE_OVERLAP = 0.5;

export interface CarriedLine {
  /** 1-based line of the old reading and of the new one. */
  from: number;
  to: number;
  text: string;
}

export interface DroppedCorrection {
  /** 1-based line of the old reading. */
  line: number;
  /** What the person typed. */
  text: string;
  /** What the recogniser had read there. */
  recognised: string;
}

export interface CarryResult {
  /** Corrections of the NEW reading (keyed by its line indexes). */
  corrections: OcrCorrections;
  kept: CarriedLine[];
  dropped: DroppedCorrection[];
}

function overlap(a: PdfRect, b: PdfRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (!(w > 0 && h > 0)) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Each line's box in the page's own frame (0..1), whatever turn the page was read at. */
function lineRects(page: OcrPage): PdfRect[] {
  const image = { width: page.width, height: page.height };
  return page.lines.map((line) => pixelBoxToPageRect(line.bbox, image, page.rotation));
}

/**
 * Corrections are stored per line, and a line index means nothing in another reading, but every line has
 * a box. A corrected line goes onto the line of the new reading that sits in the same place (an
 * overlap of at least MIN_LINE_OVERLAP, best first, each line used once); the text the person typed is
 * kept as it is. A correction with no such line is dropped and reported, and the old reading keeps it.
 */
export function carryCorrections(old: PageOcr, next: OcrPage): CarryResult {
  const typed = correctedLines(old);
  const wasRects = lineRects(old.page);
  const nowRects = lineRects(next);
  const pairs: Array<{ from: number; to: number; score: number }> = [];
  old.page.lines.forEach((line, from) => {
    if ((typed[from] ?? line.text) === line.text) return; // not a correction
    nowRects.forEach((rect, to) => {
      const score = overlap(wasRects[from]!, rect);
      if (score >= MIN_LINE_OVERLAP) pairs.push({ from, to, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);

  let corrections = emptyCorrections();
  const usedFrom = new Set<number>();
  const usedTo = new Set<number>();
  const kept: CarriedLine[] = [];
  for (const { from, to } of pairs) {
    if (usedFrom.has(from) || usedTo.has(to)) continue;
    usedFrom.add(from);
    usedTo.add(to);
    const text = typed[from]!;
    corrections = setLineText(corrections, next, to, text);
    kept.push({ from: from + 1, to: to + 1, text });
  }
  const dropped: DroppedCorrection[] = [];
  old.page.lines.forEach((line, from) => {
    if ((typed[from] ?? line.text) === line.text || usedFrom.has(from)) return;
    dropped.push({ line: from + 1, text: typed[from]!, recognised: line.text });
  });
  kept.sort((a, b) => a.to - b.to);
  return { corrections, kept, dropped };
}

// ---------------------------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------------------------

export interface AnchorCheck {
  id: string;
  pageNumber: number;
  quote: string;
  /** Where the highlight resolved on the reading that was replaced, and on the new one. */
  before: PdfResolveStatus;
  after: PdfResolveStatus;
}

/** A highlight that is painted somewhere (resolved, or found again by its rectangles). */
export const isPlaced = (status: PdfResolveStatus): boolean =>
  status === 'resolved' || status === 'changed';

const streamOf = (po: PageOcr) => buildOcrPageText(usableOcrWords(wordsFor(po)));

/**
 * Every highlight of the page, resolved against the old reading and against the new one with
 * `resolvePdfAnchor`, the function the reader paints with. Nothing is written: a highlight that cannot be
 * placed is not painted and stays in the list; only its quote and notes are the person's.
 */
export function checkAnchors(
  highlights: readonly HighlightView[],
  pageNumber: number,
  before: PageOcr,
  after: PageOcr,
): AnchorCheck[] {
  const mine: Array<{ view: HighlightView; anchor: PdfAnchorSet }> = [];
  for (const view of highlights) {
    if (view.anchorSet.type === 'pdf' && view.anchorSet.pageNumber === pageNumber) {
      mine.push({ view, anchor: view.anchorSet });
    }
  }
  if (mine.length === 0) return [];
  const was = streamOf(before);
  const now = streamOf(after);
  return mine.map(({ view, anchor }) => ({
    id: view.id,
    pageNumber,
    quote: view.exactQuote,
    before: resolvePdfAnchor(anchor, was).status,
    after: resolvePdfAnchor(anchor, now).status,
  }));
}

// ---------------------------------------------------------------------------------------------
// What was done, in words
// ---------------------------------------------------------------------------------------------

export interface RerunPageResult {
  pageNumber: number;
  kept: CarriedLine[];
  dropped: DroppedCorrection[];
  anchors: readonly AnchorCheck[];
  /** The new reading found no words, so the earlier text was kept as it was. */
  unchanged?: boolean;
}

const MAX_LISTED = 12;
const snippet = (s: string, max = 60): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const STEP_BACK =
  'Each page keeps the reading it replaced for one step back: use “Restore the previous reading” in the Page text tab.';

function listLines(pages: readonly RerunPageResult[]): string[] {
  const out: string[] = [];
  for (const p of pages) {
    if (p.unchanged) {
      out.push(
        `Page ${p.pageNumber}: the new reading found no text, so the earlier text was kept as it was.`,
      );
    }
    for (const d of p.dropped) {
      out.push(
        `Page ${p.pageNumber}, line ${d.line}: your correction “${snippet(d.text)}” found no matching line in the new reading and was dropped. The previous reading still has it.`,
      );
    }
    for (const a of p.anchors) {
      if (isPlaced(a.after)) continue;
      out.push(
        `Page ${p.pageNumber}: the highlight “${snippet(a.quote)}” could not be placed on the new text, so it is not painted. It stays in your list with its quote and notes unchanged.`,
      );
    }
  }
  return out.length > MAX_LISTED
    ? [...out.slice(0, MAX_LISTED), `…and ${out.length - MAX_LISTED} more.`]
    : out;
}

function resultSentences(pages: readonly RerunPageResult[]): string {
  const kept = pages.reduce((n, p) => n + p.kept.length, 0);
  const dropped = pages.reduce((n, p) => n + p.dropped.length, 0);
  const anchors = pages.flatMap((p) => p.anchors);
  const unplaced = anchors.filter((a) => !isPlaced(a.after)).length;
  const parts: string[] = [];
  if (kept + dropped > 0) {
    parts.push(
      `Your corrections: ${kept} kept${dropped > 0 ? `, ${dropped} dropped (listed below)` : ''}.`,
    );
  }
  if (anchors.length > 0) {
    parts.push(
      `Highlights on these pages: ${anchors.length - unplaced} found again${unplaced > 0 ? `, ${unplaced} could not be placed (listed below)` : ''}.`,
    );
  }
  return parts.join(' ');
}

/** The result of a re-recognition job: counts, then the items that need the person's eye. */
export function describeRerun(
  summary: OcrJobSummary,
  pages: readonly RerunPageResult[],
): OcrOutcome {
  // A page the runner saved but whose new reading found no words was not replaced.
  const saved = summary.saved.length - pages.filter((p) => p.unchanged).length;
  const failed = summary.failed.length;
  const lines = listLines(pages);
  const items = lines.length > 0 ? { lines } : {};
  const results = resultSentences(pages);
  const replaced =
    saved > 0
      ? `${plural(saved, 'page')} ${saved === 1 ? 'was' : 'were'} read again and the new text replaced the old. `
      : '';
  switch (summary.status) {
    case 'completed': {
      const needsEye = lines.length > 0;
      return {
        tone: needsEye ? 'warning' : 'success',
        title: saved === 0 ? 'No page was replaced' : `Recognised ${plural(saved, 'page')} again`,
        detail: `${replaced}${results} ${saved === 0 ? '' : STEP_BACK} ${MACHINE}`
          .replace(/\s+/g, ' ')
          .trim(),
        codes: [],
        ...items,
      };
    }
    case 'partial': {
      const codes = [...new Set(summary.failed.map((f) => f.code))];
      return {
        tone: 'warning',
        title: `Recognised ${plural(saved, 'page')} again; ${plural(failed, 'page')} could not be read`,
        detail:
          `${replaced}${plural(failed, 'page')} could not be read again and ${failed === 1 ? 'keeps' : 'keep'} the earlier text. ${results} ${STEP_BACK} ${MACHINE}`
            .replace(/\s+/g, ' ')
            .trim(),
        codes,
        ...items,
      };
    }
    case 'cancelled':
      return {
        tone: 'info',
        title: 'Reading again cancelled',
        detail:
          `${saved > 0 ? `${plural(saved, 'page')} already read again ${saved === 1 ? 'shows' : 'show'} the new text. ` : ''}Every other page keeps its earlier text. ${results}`
            .replace(/\s+/g, ' ')
            .trim(),
        codes: ['cancelled'],
        ...items,
      };
    case 'failed': {
      const base = describeOutcome(summary);
      return {
        ...base,
        detail: `${base.detail} Pages that were not read again keep their earlier text. ${results}`
          .replace(/\s+/g, ' ')
          .trim(),
        ...items,
      };
    }
  }
}

/** The result of putting a page's earlier reading back. */
export function describeRestore(pageNumber: number, anchors: readonly AnchorCheck[]): OcrOutcome {
  const unplaced = anchors.filter((a) => !isPlaced(a.after));
  const lines = listLines([{ pageNumber, kept: [], dropped: [], anchors }]);
  return {
    tone: unplaced.length > 0 ? 'warning' : 'success',
    title: `Restored the earlier reading of page ${pageNumber}`,
    detail:
      `The reading that was replaced is back, with the corrections it had. The reading you had until now is kept: restoring again swaps them back. ${
        anchors.length > 0
          ? `Highlights on this page: ${anchors.length - unplaced.length} found again${unplaced.length > 0 ? `, ${unplaced.length} could not be placed (listed below)` : ''}. `
          : ''
      }${MACHINE}`
        .replace(/\s+/g, ' ')
        .trim(),
    codes: [],
    ...(lines.length > 0 ? { lines } : {}),
  };
}
