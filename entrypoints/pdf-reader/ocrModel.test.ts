import { describe, expect, it } from 'vitest';
import { buildOcrPageText } from '@pdf';
import { emptyCorrections, revertLine, setLineText } from '@ocr/corrections';
import { OCR_ERROR_MESSAGES } from '@ocr/errors';
import type { OcrJobSummary } from '@ocr/runner';
import type { OcrPage } from '@ocr/types';
import {
  confidenceBand,
  correctedLines,
  describeOutcome,
  describeProgress,
  pageOcrFromStored,
  storedInputFrom,
  wordsFor,
  type PageOcr,
} from './ocrModel';

const stored = (over: Partial<Parameters<typeof pageOcrFromStored>[0]> = {}) => ({
  pageNumber: 4,
  text: 'Glomeruli filter plasma\nat a steady rate',
  correctedText: null,
  language: 'eng',
  engine: 'tesseract 5.1.1',
  confidence: 0.9,
  words: [
    { text: 'Glomeruli', x: 0.1, y: 0.1, w: 0.16, h: 0.025, confidence: 0.95 },
    { text: 'filter', x: 0.28, y: 0.1, w: 0.1, h: 0.025, confidence: 0.9 },
    { text: 'plasma', x: 0.4, y: 0.1, w: 0.12, h: 0.025, confidence: 0.4 },
    { text: 'at', x: 0.1, y: 0.14, w: 0.04, h: 0.025, confidence: 0.92 },
    { text: 'a', x: 0.16, y: 0.14, w: 0.02, h: 0.025, confidence: 0.7 },
    { text: 'steady', x: 0.2, y: 0.14, w: 0.12, h: 0.025, confidence: 0.9 },
    { text: 'rate', x: 0.34, y: 0.14, w: 0.08, h: 0.025, confidence: 0.9 },
  ],
  ...over,
});

describe('pageOcrFromStored', () => {
  it('rebuilds the lines the recogniser reported from the stored text', () => {
    const po = pageOcrFromStored(stored());
    expect(po.page.lines.map((l) => l.text)).toEqual([
      'Glomeruli filter plasma',
      'at a steady rate',
    ]);
    expect(po.page.words.map((w) => w.line)).toEqual([0, 0, 0, 1, 1, 1, 1]);
    expect(po.page.words[2]!.confidence).toBeCloseTo(40, 6);
    expect(po.page.engine).toEqual({ name: 'tesseract', version: '5.1.1', language: 'eng' });
    expect(po.corrections).toEqual(emptyCorrections());
  });

  it('falls back to the box geometry for text stored without line feeds', () => {
    const po = pageOcrFromStored(stored({ text: 'Glomeruli filter plasma at a steady rate' }));
    expect(po.page.lines.map((l) => l.text)).toEqual([
      'Glomeruli filter plasma',
      'at a steady rate',
    ]);
  });

  it('falls back when the text does not reproduce the words (never mis-assigns them)', () => {
    const po = pageOcrFromStored(stored({ text: 'something else\nentirely' }));
    expect(po.page.lines).toHaveLength(2);
    expect(po.page.words.map((w) => w.text).join(' ')).toBe(
      'Glomeruli filter plasma at a steady rate',
    );
  });

  it('turns correctedText back into per-line corrections', () => {
    const po = pageOcrFromStored(
      stored({ correctedText: 'Glomeruli filter plasma\nat a constant rate' }),
    );
    expect(po.corrections.lines).toEqual({ 1: 'at a constant rate' });
    expect(wordsFor(po).map((w) => w.text)).toEqual([
      'Glomeruli',
      'filter',
      'plasma',
      'at',
      'a',
      'constant',
      'rate',
    ]);
    // A correctedText whose line count disagrees is ignored rather than guessed at.
    expect(pageOcrFromStored(stored({ correctedText: 'only one line' })).corrections).toEqual(
      emptyCorrections(),
    );
  });
});

describe('storedInputFrom (what the vault gets)', () => {
  it('keeps the recognised text untouched and stores corrections as correctedText', () => {
    const po = pageOcrFromStored(stored());
    const clean = storedInputFrom('d'.repeat(64), po);
    expect(clean.text).toBe('Glomeruli filter plasma\nat a steady rate');
    expect(clean.correctedText).toBeNull();
    expect(clean.words[2]).toMatchObject({ text: 'plasma', confidence: 0.4 });
    expect(clean.words[0]!.x).toBeCloseTo(0.1, 6);
    expect(clean.confidence).not.toBeNull();

    const edited: PageOcr = {
      page: po.page,
      corrections: setLineText(po.corrections, po.page, 1, 'at a constant rate'),
    };
    const input = storedInputFrom('d'.repeat(64), edited);
    expect(input.text).toBe(clean.text); // the recognition itself is never edited
    expect(input.correctedText).toBe('Glomeruli filter plasma\nat a constant rate');
    // Round trip: what is stored comes back as the same corrections.
    const back = pageOcrFromStored({
      pageNumber: 4,
      text: input.text,
      correctedText: input.correctedText ?? null,
      words: input.words,
      language: input.language,
      engine: input.engine,
    });
    expect(back.corrections.lines).toEqual({ 1: 'at a constant rate' });
    // Reverting clears it.
    const reverted: PageOcr = {
      page: po.page,
      corrections: revertLine(edited.corrections, 1),
    };
    expect(storedInputFrom('d'.repeat(64), reverted).correctedText).toBeNull();
  });

  it('a removed line survives the round trip as an empty line', () => {
    const po = pageOcrFromStored(stored());
    const edited: PageOcr = {
      page: po.page,
      corrections: setLineText(po.corrections, po.page, 0, ''),
    };
    expect(correctedLines(edited)).toEqual(['', 'at a steady rate']);
    const input = storedInputFrom('d'.repeat(64), edited);
    expect(input.correctedText).toBe('\nat a steady rate');
    const back = pageOcrFromStored({ ...stored(), correctedText: input.correctedText ?? null });
    expect(
      wordsFor(back)
        .map((w) => w.text)
        .join(' '),
    ).toBe('at a steady rate');
  });
});

describe('the page stream a correction produces', () => {
  it('changes only future text: the same words in the same boxes, new letters', () => {
    const po = pageOcrFromStored(stored());
    const before = buildOcrPageText(wordsFor(po));
    const after = buildOcrPageText(
      wordsFor({
        page: po.page,
        corrections: setLineText(po.corrections, po.page, 0, 'Nephrons filter plasma'),
      }),
    );
    expect(before.text).toBe('Glomeruli filter plasma at a steady rate');
    expect(after.text).toBe('Nephrons filter plasma at a steady rate');
    expect(after.signature).not.toBe(before.signature);
    expect(after.signature.startsWith('ocr1:')).toBe(true);
  });
});

describe('confidence and messages', () => {
  it('bands are 85 / 60 and always have a text name', () => {
    expect(confidenceBand(100)).toBe('high');
    expect(confidenceBand(85)).toBe('high');
    expect(confidenceBand(84.9)).toBe('medium');
    expect(confidenceBand(60)).toBe('medium');
    expect(confidenceBand(59.9)).toBe('low');
    expect(confidenceBand(0)).toBe('low');
  });

  const summary = (over: Partial<OcrJobSummary>): OcrJobSummary => ({
    status: 'completed',
    requested: 3,
    skipped: [],
    saved: [1, 2, 3],
    reoriented: [],
    failed: [],
    durationMs: 10,
    ...over,
  });

  it('maps every job outcome and every error code to a sentence for the person', () => {
    expect(describeOutcome(summary({}))).toMatchObject({
      tone: 'success',
      title: 'Recognised 3 pages',
    });
    expect(describeOutcome(summary({}) as OcrJobSummary).detail).toContain('may be wrong');

    const partial = describeOutcome(
      summary({
        status: 'partial',
        saved: [1, 2],
        failed: [
          { pageNumber: 3, code: 'out-of-memory', message: 'm', attempts: 2 },
          { pageNumber: 4, code: 'failed', message: 'm', attempts: 2 },
        ],
      }),
    );
    expect(partial.tone).toBe('warning');
    expect(partial.title).toContain('2 pages could not be read');
    expect(partial.detail).toContain(OCR_ERROR_MESSAGES['out-of-memory']);
    expect(partial.codes.sort()).toEqual(['failed', 'out-of-memory']);

    const cancelled = describeOutcome(summary({ status: 'cancelled', saved: [1], skipped: [2] }));
    expect(cancelled).toMatchObject({ tone: 'info', codes: ['cancelled'] });
    expect(cancelled.detail).toContain('2 pages recognised so far were kept');

    for (const code of ['asset-missing', 'wasm-unsupported', 'out-of-memory', 'failed'] as const) {
      const failed = describeOutcome(
        summary({
          status: 'failed',
          saved: [],
          error: { code, message: OCR_ERROR_MESSAGES[code] },
        }),
      );
      expect(failed.tone).toBe('error');
      expect(failed.detail).toBe(OCR_ERROR_MESSAGES[code]);
      expect(failed.codes).toEqual([code]);
    }
  });

  it('progress is a sentence per phase and counts the page being worked on', () => {
    const p = (phase: Parameters<typeof describeProgress>[0]['phase'], completed = 1) =>
      describeProgress({ phase, pageNumber: 7, completed, total: 4, progress: 0.3 });
    expect(p('rendering')).toBe('Preparing page 7 (2 of 4)…');
    expect(p('recognizing')).toBe('Recognising text on page 7 (2 of 4)…');
    expect(p('initializing')).toContain('Starting the text recogniser');
    expect(p('saved', 2)).toBe('2 of 4 pages done.');
  });

  it('says it is checking orientation, and which pages were turned to be read', () => {
    const progress = describeProgress({
      phase: 'orienting',
      pageNumber: 1,
      completed: 0,
      total: 1,
      progress: 0.9,
    });
    expect(progress).toMatch(/checking orientation of page 1/i);

    const one = describeOutcome(
      summary({ saved: [1], reoriented: [{ pageNumber: 1, orientation: 90 }] }),
    );
    expect(one.tone).toBe('success');
    expect(one.title).toBe('Recognised 1 page');
    expect(one.detail).toContain(
      'Page 1 is stored sideways (its lines run from bottom to top); it was turned to be read.',
    );
    expect(one.detail).toContain('may be wrong');

    const down = describeOutcome(
      summary({ saved: [2], reoriented: [{ pageNumber: 2, orientation: 180 }] }),
    );
    expect(down.detail).toContain('Page 2 is stored upside down');
    const other = describeOutcome(
      summary({ saved: [3], reoriented: [{ pageNumber: 3, orientation: 270 }] }),
    );
    expect(other.detail).toContain('(its lines run from top to bottom)');

    const several = describeOutcome(
      summary({
        saved: [1, 2, 3],
        reoriented: [
          { pageNumber: 1, orientation: 90 },
          { pageNumber: 3, orientation: 270 },
        ],
      }),
    );
    expect(several.detail).toContain('Pages 1, 3 are stored sideways or upside down');
    // a pass with no turned page says nothing about turning
    expect(describeOutcome(summary({})).detail).not.toContain('turned');
  });
});

describe('orientation in stored rows', () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    pageNumber: 1,
    text: 'Technology Goals',
    correctedText: null,
    words: [
      { text: 'Technology', x: 0.1, y: 0.2, w: 0.04, h: 0.3, confidence: 0.9 },
      { text: 'Goals', x: 0.1, y: 0.55, w: 0.04, h: 0.15, confidence: 0.9 },
    ],
    ...extra,
  });

  it('keeps the turn of a recognised page through a save, a reload and a correction', () => {
    const po = pageOcrFromStored(row({ orientation: 90 }));
    expect(po.page.orientation).toBe(90);
    // the boxes are already in the page's own frame: no second rotation is applied
    expect(po.page.rotation).toBe(0);
    const input = storedInputFrom('doc', po);
    expect(input.orientation).toBe(90);
    expect(input.words[0]!.y).toBeCloseTo(0.2, 6);
    expect(input.words[0]!.h).toBeCloseTo(0.3, 6);
    // saving a correction keeps it
    const corrected = {
      ...po,
      corrections: setLineText(emptyCorrections(), po.page, 0, 'Technology Goals!'),
    };
    expect(storedInputFrom('doc', corrected).orientation).toBe(90);
  });

  it('reads a row stored before orientation checks as read upright', () => {
    const po = pageOcrFromStored(row());
    expect(po.page.orientation).toBeUndefined();
    expect(storedInputFrom('doc', po).orientation).toBe(0);
  });

  it('turns the boxes of a freshly recognised, turned page into the page frame', () => {
    // The turned image is 3000 x 2000 (a page of 2000 x 3000 stored sideways, turned 90 clockwise).
    const page: OcrPage = {
      pageNumber: 1,
      width: 3000,
      height: 2000,
      rotation: 90,
      orientation: 90,
      scale: null,
      confidence: 90,
      text: 'Technology',
      words: [
        { text: 'Technology', confidence: 90, bbox: { x: 300, y: 200, w: 600, h: 100 }, line: 0 },
      ],
      lines: [
        {
          text: 'Technology',
          confidence: 90,
          bbox: { x: 300, y: 200, w: 600, h: 100 },
          first: 0,
          end: 1,
        },
      ],
      engine: { name: 'tesseract', version: 'test', language: 'eng' },
      recognizedAt: '2026-01-01T00:00:00.000Z',
    };
    const input = storedInputFrom('doc', { page, corrections: emptyCorrections() });
    expect(input.orientation).toBe(90);
    const w = input.words[0]!;
    // 0.1 across, 0.1 down and 0.2 wide in the turned image: 0.1 from the left of the stored page,
    // 0.7 down it, 0.05 wide and 0.2 high (what read left to right now runs up the page)
    expect(w.x).toBeCloseTo(0.1, 6);
    expect(w.y).toBeCloseTo(0.7, 6);
    expect(w.w).toBeCloseTo(0.05, 6);
    expect(w.h).toBeCloseTo(0.2, 6);
    expect(w.h).toBeGreaterThan(w.w); // a word of a sideways line is tall on the stored page
  });
});
