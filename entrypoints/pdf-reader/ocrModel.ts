import {
  ocrLineNumbers,
  type OcrWordInput,
  type SaveOcrPageInput,
  type StoredOcrPage,
  type StoredPreviousReading,
} from '@pdf';
import {
  applyCorrections,
  emptyCorrections,
  hasCorrections,
  type OcrCorrections,
} from '@ocr/corrections';
import { OCR_ERROR_MESSAGES, type OcrErrorCode } from '@ocr/errors';
import { pixelBoxToPageRect, unionBoxes } from '@ocr/geometry';
import { buildPageTextStream } from '@ocr/stream';
import type { OcrJobProgress, OcrJobSummary } from '@ocr/runner';
import type { OcrLine, OcrPage, OcrWord } from '@ocr/types';

/**
 * Reader-side model of recognised pages (pure, unit-tested). The vault keeps, per page, the
 * recognised text (lines joined by a line feed), each word's normalised box and confidence, and ONE
 * string of corrected text. `PageOcr` is the richer in-memory form the correction UI and the page
 * text stream need (lines, corrections), rebuilt from that row, so nothing else has to be stored:
 *
 *   text           = the recogniser's lines, "\n" between lines, never edited
 *   correctedText  = the same lines after the person's edits (same line count), or null
 *   corrections    = lines whose corrected text differs from the recognised one
 */

export interface PageOcr {
  page: OcrPage;
  corrections: OcrCorrections;
  /**
   * The reading a re-recognition replaced, kept for one step back (ADR-006 Amendment 5). Absent when
   * the page was never read again. It is not part of the page's text: nothing reads it but "Restore".
   */
  previous?: StoredPreviousReading;
}

/** Size of the virtual image of a rebuilt page; boxes are normalised, so any size is exact. */
const VIRTUAL_PX = 10_000;

export type ConfidenceBand = 'high' | 'medium' | 'low';
export const HIGH_CONFIDENCE = 85;
export const MEDIUM_CONFIDENCE = 60;

export function confidenceBand(confidence: number): ConfidenceBand {
  return confidence >= HIGH_CONFIDENCE
    ? 'high'
    : confidence >= MEDIUM_CONFIDENCE
      ? 'medium'
      : 'low';
}

export const BAND_TEXT: Record<ConfidenceBand, string> = {
  high: 'high confidence',
  medium: 'medium confidence',
  low: 'low confidence',
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Assign words to the recognised lines when `text` reproduces them exactly; null otherwise. */
function linesFromText(text: string, words: readonly string[]): number[] | null {
  // Text without line feeds (stored before lines were kept) says nothing about the lines.
  if (!text.includes('\n')) return null;
  const lineTexts = text.split('\n');
  const out: number[] = [];
  let at = 0;
  for (let line = 0; line < lineTexts.length; line++) {
    let acc = '';
    const target = lineTexts[line]!;
    if (target === '' && line === lineTexts.length - 1) break;
    while (at < words.length && acc.length < target.length) {
      acc = acc === '' ? words[at]! : `${acc} ${words[at]!}`;
      out.push(line);
      at += 1;
    }
    if (acc !== target) return null;
  }
  return at === words.length ? out : null;
}

/** Rebuilds the in-memory page from a vault row (the inverse of `storedInputFrom`). */
export function pageOcrFromStored(
  stored: Pick<
    StoredOcrPage,
    'pageNumber' | 'text' | 'correctedText' | 'words' | 'orientation' | 'previousReading'
  > & {
    language?: string;
    engine?: string;
    confidence?: number | null;
  },
): PageOcr {
  const texts = stored.words.map((w) => w.text);
  const fromText = linesFromText(stored.text, texts);
  const lineOf =
    fromText ??
    ocrLineNumbers(stored.words.map((w) => ({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h })));
  const words: OcrWord[] = stored.words.map((w, i) => ({
    text: w.text,
    confidence: clamp(w.confidence * 100, 0, 100),
    bbox: { x: w.x * VIRTUAL_PX, y: w.y * VIRTUAL_PX, w: w.w * VIRTUAL_PX, h: w.h * VIRTUAL_PX },
    line: lineOf[i] ?? 0,
  }));
  const lines: OcrLine[] = [];
  words.forEach((w, i) => {
    const last = lines[lines.length - 1];
    if (last && words[last.first]!.line === w.line) {
      last.end = i + 1;
      return;
    }
    lines.push({ text: '', confidence: 0, bbox: w.bbox, first: i, end: i + 1 });
  });
  for (const line of lines) {
    const own = words.slice(line.first, line.end);
    line.text = own.map((w) => w.text).join(' ');
    line.confidence = own.reduce((n, w) => n + w.confidence, 0) / own.length;
    line.bbox = unionBoxes(own.map((w) => w.bbox));
  }
  // Re-number lines 0..n-1 in order (the geometric fallback may have started at any value).
  lines.forEach((line, index) => {
    for (let i = line.first; i < line.end; i++) words[i]!.line = index;
  });

  const corrections = emptyCorrections();
  if (stored.correctedText !== null) {
    const edited = stored.correctedText.split('\n');
    if (edited.length === lines.length) {
      edited.forEach((text, i) => {
        if (text !== lines[i]!.text) corrections.lines[i] = text;
      });
    }
  }
  const meanConfidence =
    words.length === 0 ? 0 : words.reduce((n, w) => n + w.confidence, 0) / words.length;
  const [engineName = 'ocr', engineVersion = 'unknown'] = (stored.engine ?? 'ocr unknown').split(
    ' ',
  );
  return {
    page: {
      pageNumber: stored.pageNumber,
      width: VIRTUAL_PX,
      height: VIRTUAL_PX,
      // The stored boxes are already in the page's own frame, whatever turn the recogniser needed.
      rotation: 0,
      ...(stored.orientation ? { orientation: stored.orientation } : {}),
      scale: null,
      confidence: meanConfidence,
      text: lines.map((l) => l.text).join('\n'),
      words,
      lines,
      engine: {
        name: engineName as 'tesseract',
        version: engineVersion,
        language: stored.language ?? 'eng',
      },
      recognizedAt: new Date(0).toISOString(),
    },
    corrections,
    ...(stored.previousReading ? { previous: stored.previousReading } : {}),
  };
}

/** The page's current reading, text and corrections, as the one step back it becomes when replaced. */
export function readingFrom(po: PageOcr, replacedAt: string): StoredPreviousReading {
  const s = storedInputFrom('', po);
  return {
    text: s.text,
    correctedText: s.correctedText ?? null,
    words: s.words,
    language: s.language,
    engine: s.engine,
    confidence: s.confidence,
    ...(s.orientation === undefined ? {} : { orientation: s.orientation }),
    replacedAt,
  };
}

/** The page as it reads when its kept earlier reading is put back (and the current one is kept). */
export function swapReading(po: PageOcr, replacedAt: string): PageOcr | null {
  const was = po.previous;
  if (!was) return null;
  return {
    ...pageOcrFromStored({
      pageNumber: po.page.pageNumber,
      text: was.text,
      correctedText: was.correctedText,
      words: was.words,
      language: was.language,
      engine: was.engine,
      confidence: was.confidence,
      ...(was.orientation === undefined ? {} : { orientation: was.orientation }),
    }),
    previous: readingFrom(po, replacedAt),
  };
}

/** Text of every line after the person's edits (one entry per recognised line). */
export function correctedLines(po: PageOcr): string[] {
  const out = po.page.lines.map(() => [] as string[]);
  for (const word of applyCorrections(po.page, po.corrections)) out[word.line]?.push(word.text);
  return out.map((words) => words.join(' '));
}

/** What `saveOcrPage` stores for a page: recognised text untouched, corrections as `correctedText`. */
export function storedInputFrom(documentId: string, po: PageOcr): SaveOcrPageInput {
  const { page } = po;
  const image = { width: page.width, height: page.height };
  return {
    documentId,
    pageNumber: page.pageNumber,
    text: page.text,
    words: page.words.map((w) => ({
      text: w.text,
      ...pixelBoxToPageRect(w.bbox, image, page.rotation),
      confidence: clamp(w.confidence / 100, 0, 1),
    })),
    language: page.engine.language,
    engine: `${page.engine.name} ${page.engine.version}`.slice(0, 64),
    confidence: page.words.length === 0 ? null : clamp(page.confidence / 100, 0, 1),
    orientation: page.orientation ?? 0,
    correctedText: hasCorrections(po.corrections) ? correctedLines(po).join('\n') : null,
  };
}

/** The words the reader's text layer and page-text stream are built from (corrections applied). */
export function wordsFor(po: PageOcr): OcrWordInput[] {
  return buildPageTextStream(po.page, po.corrections).items.map((item) => ({
    text: item.text,
    x: item.rect.x,
    y: item.rect.y,
    w: item.rect.w,
    h: item.rect.h,
    line: item.line,
    confidence: item.confidence,
    edited: item.source !== 'ocr',
  }));
}

export function wordsByPage(pages: ReadonlyMap<number, PageOcr>): Map<number, OcrWordInput[]> {
  const out = new Map<number, OcrWordInput[]>();
  for (const [n, po] of pages) out.set(n, wordsFor(po));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

export function describeProgress(p: OcrJobProgress): string {
  const n = p.pageNumber;
  const of = `${Math.min(p.completed + 1, p.total)} of ${p.total}`;
  switch (p.phase) {
    case 'skipped':
      return `Pages that were already recognised are skipped (${p.completed} of ${p.total} done).`;
    case 'rendering':
      return `Preparing page ${n} (${of})…`;
    case 'initializing':
      return `Starting the text recogniser (${of}). This happens once and can take a few seconds…`;
    case 'recognizing':
      return `Recognising text on page ${n} (${of})…`;
    case 'orienting':
      return `Checking orientation of page ${n}: this scan may be sideways or upside down (${of})…`;
    case 'saving':
      return `Saving page ${n} (${of})…`;
    case 'saved':
    case 'failed':
      return `${p.completed} of ${p.total} pages done.`;
    case 'done':
      return 'Finishing…';
  }
}

export interface OcrOutcome {
  tone: 'success' | 'warning' | 'error' | 'info';
  title: string;
  detail: string;
  /** Distinct error codes behind the outcome (taxonomy of @ocr). */
  codes: OcrErrorCode[];
  /** Itemised results (dropped corrections, highlights that could not be placed), one per line. */
  lines?: string[];
}

export const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
export const MACHINE =
  'The text is machine-recognised and may be wrong. Check it before you rely on it.';

// What reading the pages again costs (the reader asks before it starts).

/** Used until a run on this device has measured a page: a text page took about 6 s, a turned one 15 s. */
export const ASSUMED_MS_PER_PAGE = 8_000;

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return plural(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}

export interface RerunEstimate {
  pages: number;
  totalMs: number;
  perPageMs: number;
  /** False: nothing has been timed on this device yet, so the figure is an assumption. */
  measured: boolean;
  text: string;
}

export function estimateRerun(pages: number, measuredMsPerPage: number | null): RerunEstimate {
  const measured = measuredMsPerPage !== null && measuredMsPerPage > 0;
  const perPageMs = measured ? (measuredMsPerPage as number) : ASSUMED_MS_PER_PAGE;
  const totalMs = pages * perPageMs;
  const basis = measured
    ? `${formatDuration(perPageMs)} a page, as measured on this device in your last run`
    : `an assumed ${formatDuration(perPageMs)} a page, because no page has been timed on this device yet`;
  return {
    pages,
    totalMs,
    perPageMs,
    measured,
    text: `About ${formatDuration(totalMs)} for ${plural(pages, 'page')} (${basis}). A page that is stored sideways takes longer.`,
  };
}

/** How a page that needed a turn is stored, in words (the turn is the clockwise one that read it). */
export const ORIENTATION_TEXT: Record<90 | 180 | 270, string> = {
  90: 'sideways (its lines run from bottom to top)',
  180: 'upside down',
  270: 'sideways (its lines run from top to bottom)',
};

function turnedNote(summary: OcrJobSummary): string {
  const turned = summary.reoriented;
  if (turned.length === 0) return '';
  const numbers = turned.map((t) => t.pageNumber);
  const shown = numbers.slice(0, 5).join(', ') + (numbers.length > 5 ? ' and more' : '');
  return numbers.length === 1
    ? `Page ${shown} is stored ${ORIENTATION_TEXT[turned[0]!.orientation as 90 | 180 | 270]}; it was turned to be read. `
    : `Pages ${shown} are stored sideways or upside down; they were turned to be read. `;
}

export function describeOutcome(summary: OcrJobSummary): OcrOutcome {
  const saved = summary.saved.length;
  const kept = saved + summary.skipped.length;
  switch (summary.status) {
    case 'completed':
      return {
        tone: 'success',
        title:
          saved === 0
            ? 'Every requested page was already recognised'
            : `Recognised ${plural(saved, 'page')}`,
        detail: `${turnedNote(summary)}${MACHINE}`,
        codes: [],
      };
    case 'partial': {
      const codes = [...new Set(summary.failed.map((f) => f.code))];
      const first = summary.failed[0];
      return {
        tone: 'warning',
        title: `Recognised ${plural(saved, 'page')}; ${plural(summary.failed.length, 'page')} could not be read`,
        detail: `${first ? `${OCR_ERROR_MESSAGES[first.code]} (page ${first.pageNumber}${summary.failed.length > 1 ? `, and ${summary.failed.length - 1} more` : ''}). ` : ''}Choose OCR again to retry only those pages. ${turnedNote(summary)}${MACHINE}`,
        codes,
      };
    }
    case 'cancelled':
      return {
        tone: 'info',
        title: 'Text recognition cancelled',
        detail:
          kept > 0
            ? `${plural(kept, 'page')} recognised so far ${kept === 1 ? 'was' : 'were'} kept. Choose OCR again to continue from where it stopped.`
            : 'Nothing was recognised. Choose OCR again to start over.',
        codes: ['cancelled'],
      };
    case 'failed': {
      const code = summary.error?.code ?? 'failed';
      return {
        tone: 'error',
        title: 'Text recognition stopped',
        detail:
          code === 'failed' && summary.error?.message
            ? summary.error.message
            : OCR_ERROR_MESSAGES[code],
        codes: [code],
      };
    }
  }
}
