import { describe, expect, it } from 'vitest';
import { buildOcrPageText, buildPdfAnchor, usableOcrWords } from '@pdf';
import type { HighlightView } from '@shared';
import { pageRectToPixelBox } from '@ocr/geometry';
import type { OcrJobSummary } from '@ocr/runner';
import type { OcrPage } from '@ocr/types';
import {
  ASSUMED_MS_PER_PAGE,
  estimateRerun,
  formatDuration,
  pageOcrFromStored,
  wordsFor,
  type PageOcr,
} from './ocrModel';
import {
  carryCorrections,
  checkAnchors,
  describeRerun,
  describeRestore,
  isPlaced,
} from './ocrRerun';

const DOC = 'd'.repeat(64);

interface Line {
  /** Top of the line, 0..1 of the page. */
  y: number;
  words: string[];
  x?: number;
}

/** A recognised page: one box per word, lines in the order given. */
function reading(lines: Line[], corrected: Record<number, string> = {}): PageOcr {
  const words: Array<{
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
    confidence: number;
  }> = [];
  for (const line of lines) {
    line.words.forEach((text, i) => {
      words.push({
        text,
        x: (line.x ?? 0.1) + i * 0.1,
        y: line.y,
        w: 0.08,
        h: 0.02,
        confidence: 0.9,
      });
    });
  }
  const po = pageOcrFromStored({
    pageNumber: 1,
    text: lines.map((l) => l.words.join(' ')).join('\n'),
    correctedText: null,
    language: 'eng',
    engine: 'tesseract 5.1.1',
    confidence: 0.9,
    words,
  });
  po.corrections = { words: {}, lines: corrected };
  return po;
}

const saying = (po: PageOcr): string[] => po.page.lines.map((l) => l.text);

describe('carryCorrections: a correction follows its line by where the line sits', () => {
  const old = () =>
    reading(
      [
        { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
        { y: 0.14, words: ['at', 'a', 'steedy', 'rate'] },
        { y: 0.18, words: ['every', 'minute'] },
      ],
      { 1: 'at a steady rate' },
    );

  it('keeps the text the person typed on the line of the new reading in the same place', () => {
    const next = reading([
      { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
      { y: 0.14, words: ['at', 'a', 'steedy', 'rate'] },
      { y: 0.18, words: ['every', 'minute'] },
    ]).page;
    const carried = carryCorrections(old(), next);
    expect(carried.corrections).toEqual({ words: {}, lines: { 1: 'at a steady rate' } });
    expect(carried.kept).toEqual([{ from: 2, to: 2, text: 'at a steady rate' }]);
    expect(carried.dropped).toEqual([]);
  });

  it('finds the line again when the new reading numbers its lines differently', () => {
    // a heading line appeared above: the corrected line is now line 3
    const next = reading([
      { y: 0.05, words: ['Renal', 'physiology'] },
      { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
      { y: 0.14, words: ['at', 'a', 'steedy', 'rate'] },
      { y: 0.18, words: ['every', 'minute'] },
    ]).page;
    const carried = carryCorrections(old(), next);
    expect(carried.corrections.lines).toEqual({ 2: 'at a steady rate' });
    expect(carried.kept).toEqual([{ from: 2, to: 3, text: 'at a steady rate' }]);
  });

  it('keeps the typed text even when the new reading reads the line differently', () => {
    const next = reading([
      { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
      { y: 0.14, words: ['it', 'was', 'a', 'sleady', 'rale'] },
    ]).page;
    expect(carryCorrections(old(), next).corrections.lines).toEqual({ 1: 'at a steady rate' });
  });

  it('keeps a correction that the new reading now agrees with, without storing a redundant edit', () => {
    const next = reading([
      { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
      { y: 0.14, words: ['at', 'a', 'steady', 'rate'] },
    ]).page;
    const carried = carryCorrections(old(), next);
    expect(carried.corrections).toEqual({ words: {}, lines: {} });
    expect(carried.kept).toHaveLength(1);
    expect(carried.dropped).toEqual([]);
  });

  it('drops a correction whose line has no counterpart, and says what it was', () => {
    // the new reading has nothing where the corrected line was
    const next = reading([
      { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
      { y: 0.5, words: ['something', 'else'] },
    ]).page;
    const carried = carryCorrections(old(), next);
    expect(carried.corrections).toEqual({ words: {}, lines: {} });
    expect(carried.kept).toEqual([]);
    expect(carried.dropped).toEqual([
      { line: 2, text: 'at a steady rate', recognised: 'at a steedy rate' },
    ]);
  });

  it('does not put one line of text on a block that merged two lines', () => {
    const next = reading([
      { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
      // one tall box over the corrected line and the one below it
      { y: 0.14, words: ['at', 'a', 'steedy', 'rate', 'every', 'minute'] },
    ]).page;
    // make the merged line twice as tall as the old ones (it spans both old lines)
    next.lines[1]!.bbox = { x: 1000, y: 1400, w: 6000, h: 800 };
    const carried = carryCorrections(old(), next);
    expect(carried.kept).toEqual([]);
    expect(carried.dropped.map((d) => d.line)).toEqual([2]);
  });

  it('uses each line of the new reading once: the better match wins, the other is dropped', () => {
    const two = reading(
      [
        { y: 0.1, words: ['first', 'line', 'here'] },
        { y: 0.104, words: ['second', 'line', 'here'] }, // sits almost on the first
      ],
      { 0: 'FIRST', 1: 'SECOND' },
    );
    // both old lines overlap this one by more than half; the first overlaps it more
    const next = reading([{ y: 0.101, words: ['first', 'line', 'here'] }]).page;
    const carried = carryCorrections(two, next);
    expect(carried.corrections.lines).toEqual({ 0: 'FIRST' });
    expect(carried.dropped).toEqual([{ line: 2, text: 'SECOND', recognised: 'second line here' }]);
  });

  it('carries a removal (a line corrected to nothing)', () => {
    const removed = reading(
      [
        { y: 0.1, words: ['Glomeruli', 'filter'] },
        { y: 0.14, words: ['page', '3'] },
      ],
      { 1: '' },
    );
    const next = reading([
      { y: 0.1, words: ['Glomeruli', 'filter'] },
      { y: 0.14, words: ['page', '3'] },
    ]).page;
    const carried = carryCorrections(removed, next);
    expect(carried.corrections.lines).toEqual({ 1: '' });
  });

  it('compares boxes in the page frame whatever turn each reading was made at', () => {
    const base = reading([{ y: 0.2, words: ['rotated', 'scan', 'line'] }], {
      0: 'Rotated scan line',
    });
    // the same line read from an image turned 90 degrees: its pixel box is in the turned frame
    const page = reading([{ y: 0.2, words: ['rotated', 'scan', 'line'] }]).page;
    const size = { width: 1000, height: 500 };
    const asPage = (b: { x: number; y: number; w: number; h: number }) => ({
      x: b.x / 10_000,
      y: b.y / 10_000,
      w: b.w / 10_000,
      h: b.h / 10_000,
    });
    const turned: OcrPage = {
      ...page,
      ...size,
      rotation: 90,
      lines: page.lines.map((l) => ({ ...l, bbox: pageRectToPixelBox(asPage(l.bbox), size, 90) })),
    };
    const carried = carryCorrections(base, turned);
    expect(carried.corrections.lines).toEqual({ 0: 'Rotated scan line' });
  });

  it('has nothing to carry for a page nobody corrected', () => {
    const plain = reading([{ y: 0.1, words: ['nothing', 'edited'] }]);
    const carried = carryCorrections(plain, plain.page);
    expect(carried).toEqual({ corrections: { words: {}, lines: {} }, kept: [], dropped: [] });
  });
});

// ---------------------------------------------------------------------------------------------

function highlightOn(po: PageOcr, from: string, to: string, id = 'h1'): HighlightView {
  const pt = buildOcrPageText(usableOcrWords(wordsFor(po)));
  const start = pt.text.indexOf(from);
  const end = pt.text.indexOf(to) + to.length;
  const built = buildPdfAnchor({
    documentFingerprint: DOC,
    pageNumber: po.page.pageNumber,
    rotation: 0,
    pageText: pt,
    start,
    end,
    rects: [],
  });
  if (!built.ok) throw new Error('could not anchor');
  return {
    id,
    exactQuote: built.exactQuote,
    anchorSet: built.anchorSet,
  } as unknown as HighlightView;
}

describe('checkAnchors: highlights are resolved on the old and the new reading', () => {
  const old = reading([
    { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
    { y: 0.14, words: ['at', 'a', 'steady', 'rate'] },
  ]);

  it('finds a highlight again when its words are still in the new reading', () => {
    const hl = highlightOn(old, 'filter', 'plasma');
    const next = reading([
      { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
      { y: 0.14, words: ['at', 'a', 'steady', 'rate', 'each', 'minute'] },
    ]);
    const [check] = checkAnchors([hl], 1, old, next);
    expect(check).toMatchObject({ id: 'h1', quote: 'filter plasma', before: 'resolved' });
    expect(isPlaced(check!.after)).toBe(true);
  });

  it('says so when the new reading no longer has the words and nothing sits there', () => {
    const hl = highlightOn(old, 'steady', 'rate');
    const next = reading([
      { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
      { y: 0.6, words: ['unrelated', 'text'] },
    ]);
    const [check] = checkAnchors([hl], 1, old, next);
    expect(check!.before).toBe('resolved');
    expect(isPlaced(check!.after)).toBe(false);
    expect(['ambiguous', 'orphaned']).toContain(check!.after);
  });

  it('follows the corrections the new reading carries (the stream the reader paints from)', () => {
    const hl = highlightOn(old, 'steady', 'rate');
    const next = reading(
      [
        { y: 0.1, words: ['Glomeruli', 'filter', 'plasma'] },
        { y: 0.14, words: ['at', 'a', 'steedy', 'rate'] },
      ],
      { 1: 'at a steady rate' },
    );
    const [check] = checkAnchors([hl], 1, old, next);
    expect(isPlaced(check!.after)).toBe(true);
  });

  it('looks only at highlights of that page, and only PDF anchors', () => {
    const here = highlightOn(old, 'filter', 'plasma', 'here');
    const elsewhere = {
      ...highlightOn(old, 'Glomeruli', 'filter', 'elsewhere'),
    } as unknown as HighlightView & { anchorSet: { pageNumber: number } };
    elsewhere.anchorSet = { ...elsewhere.anchorSet, pageNumber: 2 };
    const web = {
      id: 'web',
      exactQuote: 'x',
      anchorSet: { type: 'html' },
    } as unknown as HighlightView;
    const checks = checkAnchors([here, elsewhere, web], 1, old, old);
    expect(checks.map((c) => c.id)).toEqual(['here']);
  });

  it('returns nothing, and reads nothing, for a page without highlights', () => {
    expect(checkAnchors([], 1, old, old)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('what the person is told', () => {
  const summary = (over: Partial<OcrJobSummary> = {}): OcrJobSummary => ({
    status: 'completed',
    requested: 2,
    skipped: [],
    saved: [1, 2],
    reoriented: [],
    failed: [],
    durationMs: 10_000,
    ...over,
  });
  const check = (id: string, after: 'resolved' | 'orphaned', quote = 'steady rate') => ({
    id,
    pageNumber: 1,
    quote,
    before: 'resolved' as const,
    after,
  });

  it('a clean re-run is a success with the one step back explained', () => {
    const out = describeRerun(summary(), [
      { pageNumber: 1, kept: [], dropped: [], anchors: [check('a', 'resolved')] },
      { pageNumber: 2, kept: [], dropped: [], anchors: [] },
    ]);
    expect(out).toMatchObject({ tone: 'success', title: 'Recognised 2 pages again' });
    expect(out.detail).toContain('2 pages were read again and the new text replaced the old');
    expect(out.detail).toContain('Highlights on these pages: 1 found again.');
    expect(out.detail).toContain('Restore the previous reading');
    expect(out.lines).toBeUndefined();
  });

  it('lists a dropped correction and a highlight that could not be placed', () => {
    const out = describeRerun(summary(), [
      {
        pageNumber: 1,
        kept: [{ from: 1, to: 1, text: 'kept it' }],
        dropped: [
          { line: 4, text: 'The glomerulus filters', recognised: 'Tbe glomerulus fllters' },
        ],
        anchors: [check('a', 'orphaned', 'the proximal tubule')],
      },
    ]);
    expect(out.tone).toBe('warning');
    expect(out.detail).toContain('Your corrections: 1 kept, 1 dropped (listed below).');
    expect(out.detail).toContain('Highlights on these pages: 0 found again, 1 could not be placed');
    expect(out.lines).toHaveLength(2);
    expect(out.lines![0]).toContain('Page 1, line 4');
    expect(out.lines![0]).toContain('The glomerulus filters');
    expect(out.lines![1]).toContain('the proximal tubule');
    expect(out.lines![1]).toContain('stays in your list');
  });

  it('a page that could not be read keeps its text, and the result says which', () => {
    const out = describeRerun(
      summary({
        status: 'partial',
        saved: [1],
        failed: [{ pageNumber: 2, code: 'out-of-memory', message: 'x', attempts: 2 }],
      }),
      [{ pageNumber: 1, kept: [], dropped: [], anchors: [] }],
    );
    expect(out).toMatchObject({ tone: 'warning', codes: ['out-of-memory'] });
    expect(out.title).toBe('Recognised 1 page again; 1 page could not be read');
    expect(out.detail).toContain('1 page could not be read again and keeps the earlier text');
  });

  it('a cancelled run says the pages not reached keep their text', () => {
    const out = describeRerun(summary({ status: 'cancelled', saved: [1] }), [
      { pageNumber: 1, kept: [], dropped: [], anchors: [] },
    ]);
    expect(out).toMatchObject({ tone: 'info', codes: ['cancelled'] });
    expect(out.detail).toContain('1 page already read again shows the new text');
    expect(out.detail).toContain('Every other page keeps its earlier text');
  });

  it('a reading that found no text did not replace anything', () => {
    const out = describeRerun(summary({ requested: 1, saved: [1] }), [
      { pageNumber: 1, kept: [], dropped: [], anchors: [], unchanged: true },
    ]);
    expect(out.title).toBe('No page was replaced');
    expect(out.tone).toBe('warning');
    expect(out.lines![0]).toContain('found no text, so the earlier text was kept');
  });

  it('a job-level failure keeps the taxonomy message and the earlier text', () => {
    const out = describeRerun(
      summary({ status: 'failed', saved: [], error: { code: 'asset-missing', message: 'x' } }),
      [],
    );
    expect(out.tone).toBe('error');
    expect(out.codes).toEqual(['asset-missing']);
    expect(out.detail).toContain('keep their earlier text');
  });

  it('caps a long list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      line: i + 1,
      text: `fix ${i}`,
      recognised: `fx ${i}`,
    }));
    const out = describeRerun(summary(), [{ pageNumber: 1, kept: [], dropped: many, anchors: [] }]);
    expect(out.lines).toHaveLength(13);
    expect(out.lines!.at(-1)).toBe('…and 18 more.');
  });

  it('restoring says what came back and which highlights are not painted', () => {
    const out = describeRestore(3, [check('a', 'resolved'), check('b', 'orphaned', 'lost words')]);
    expect(out.title).toBe('Restored the earlier reading of page 3');
    expect(out.tone).toBe('warning');
    expect(out.detail).toContain('restoring again swaps them back');
    expect(out.detail).toContain('1 found again, 1 could not be placed');
    expect(out.lines).toHaveLength(1);
    expect(describeRestore(3, []).tone).toBe('success');
  });
});

describe('cost', () => {
  it('formats a duration in words', () => {
    expect(formatDuration(400)).toBe('1 second');
    expect(formatDuration(42_000)).toBe('42 seconds');
    expect(formatDuration(89_000)).toBe('89 seconds');
    expect(formatDuration(120_000)).toBe('2 minutes');
    expect(formatDuration(95 * 60_000)).toBe('1 hour 35 minutes');
    expect(formatDuration(3 * 3_600_000)).toBe('3 hours');
  });

  it('estimates from the page count and the last measured time, and says when it is an assumption', () => {
    const measured = estimateRerun(30, 6_000);
    expect(measured).toMatchObject({
      pages: 30,
      totalMs: 180_000,
      perPageMs: 6_000,
      measured: true,
    });
    expect(measured.text).toContain('About 3 minutes for 30 pages');
    expect(measured.text).toContain('as measured on this device in your last run');

    const assumed = estimateRerun(10, null);
    expect(assumed).toMatchObject({ totalMs: 10 * ASSUMED_MS_PER_PAGE, measured: false });
    expect(assumed.text).toContain('an assumed 8 seconds a page');
    expect(estimateRerun(1, 0).measured).toBe(false);
  });
});

it('the reading a test builds is itself what the model says (guards the helpers above)', () => {
  const po = reading([{ y: 0.1, words: ['a', 'b'] }]);
  expect(saying(po)).toEqual(['a b']);
});
