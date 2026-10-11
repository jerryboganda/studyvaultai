import { describe, expect, it } from 'vitest';
import type { HighlightView } from '@shared';
import type { PdfResolution } from '@pdf';
import {
  describeZoom,
  displayedSize,
  isPainted,
  nextRotation,
  pageRange,
  pdfRows,
  placeBar,
  stepZoom,
  zoomFor,
} from './model';

describe('zoom', () => {
  it('steps through the ladder from any current value and clamps at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.18, 1)).toBe(1.25);
    expect(stepZoom(1.18, -1)).toBe(1.1);
    expect(stepZoom(5, 1)).toBe(5);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });

  const letter = { w: 612, h: 792 };
  it('fit width uses the scroll area width; fit page also respects its height', () => {
    const area = { w: 1032, h: 500 };
    const byWidth = zoomFor({ kind: 'fit-width' }, letter, area);
    expect(byWidth).toBeCloseTo((1032 - 32) / (612 * (96 / 72)), 5);
    const byPage = zoomFor({ kind: 'fit-page' }, letter, area);
    expect(byPage).toBeCloseTo((500 - 32) / (792 * (96 / 72)), 5);
    expect(byPage).toBeLessThan(byWidth);
  });

  it('keeps custom zoom inside 25%-500% and survives a zero-sized area', () => {
    expect(zoomFor({ kind: 'custom', zoom: 9 }, letter, { w: 1, h: 1 })).toBe(5);
    expect(zoomFor({ kind: 'custom', zoom: 0.01 }, letter, { w: 1, h: 1 })).toBe(0.25);
    expect(zoomFor({ kind: 'fit-width' }, { w: 0, h: 0 }, { w: 800, h: 600 })).toBe(1);
  });

  it('swaps the page size for a quarter turn and labels the mode', () => {
    expect(displayedSize([0, 0, 612, 792], 90)).toEqual({ w: 792, h: 612 });
    expect(displayedSize([10, 10, 622, 802], 0)).toEqual({ w: 612, h: 792 });
    expect(describeZoom({ kind: 'fit-width' }, 1.186)).toBe('Fit width (119%)');
    expect(describeZoom({ kind: 'custom', zoom: 1.5 }, 1.5)).toBe('150%');
  });

  it('rotates in 90 degree steps both ways', () => {
    expect(nextRotation(0)).toBe(90);
    expect(nextRotation(270)).toBe(0);
    expect(nextRotation(0, -1)).toBe(270);
  });
});

describe('save bar placement', () => {
  const bar = { w: 360, h: 280 };
  const viewport = { w: 1200, h: 800 };

  it('goes under the selection and never covers it', () => {
    const p = placeBar({ left: 200, top: 100, right: 500, bottom: 130 }, bar, viewport);
    expect(p.top).toBeGreaterThanOrEqual(130);
    expect(p.left).toBe(200);
  });

  it('flips above when there is no room below', () => {
    const p = placeBar({ left: 200, top: 600, right: 500, bottom: 640 }, bar, viewport);
    expect(p.top + bar.h).toBeLessThanOrEqual(600);
  });

  it('stays inside the viewport horizontally', () => {
    const p = placeBar({ left: 1100, top: 100, right: 1190, bottom: 120 }, bar, viewport);
    expect(p.left + bar.w).toBeLessThanOrEqual(viewport.w);
  });

  it('falls back to the bottom edge when neither side fits', () => {
    const p = placeBar({ left: 10, top: 100, right: 300, bottom: 700 }, bar, viewport);
    expect(p.top + bar.h).toBeLessThanOrEqual(viewport.h);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});

const view = (
  id: string,
  page: number,
  start: number,
  at = '2026-10-11T10:00:00.000Z',
): HighlightView => ({
  id,
  sourceId: 'doc-00000001',
  exactQuote: 'quote',
  anchorSet: {
    type: 'pdf',
    textAlgorithm: 'sv-pdf-text-v1',
    documentFingerprint: 'f'.repeat(64),
    pageNumber: page,
    rotation: 0,
    rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
    textQuote: { exact: 'quote', prefix: '', suffix: '' },
    textPosition: { start, end: start + 5 },
    contentSignature: 'abc',
    documentTextLength: 100,
  },
  kind: 'essential',
  color: 'amber',
  priority: 3,
  userComment: '',
  headingContext: null,
  bankIds: [],
  capturedAt: at,
  resolveStatus: 'unchecked',
  resolveConfidence: null,
});

describe('highlight rows', () => {
  it('orders by page, then position on the page, and skips non-PDF anchors', () => {
    const html: HighlightView = {
      ...view('h-html0001', 1, 0),
      anchorSet: {
        type: 'html',
        textAlgorithm: 'sv-text-v1',
        textQuote: { exact: 'x', prefix: '', suffix: '' },
        textPosition: { start: 0, end: 1 },
        structuralPath: null,
        contentSignature: 'a',
        documentTextLength: 1,
      },
    };
    const rows = pdfRows([
      view('h-0003xxxx', 2, 5),
      view('h-0002xxxx', 1, 50),
      html,
      view('h-0001xxxx', 1, 7),
    ]);
    expect(rows.map((r) => r.view.id)).toEqual(['h-0001xxxx', 'h-0002xxxx', 'h-0003xxxx']);
  });

  it('paints only resolved or changed highlights that have rectangles', () => {
    const r = (status: PdfResolution['status'], rects = 1): PdfResolution => ({
      status,
      method: 'quote',
      confidence: 1,
      start: 0,
      end: 5,
      rects: Array.from({ length: rects }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })),
    });
    expect(isPainted(r('resolved'))).toBe(true);
    expect(isPainted(r('changed'))).toBe(true);
    expect(isPainted(r('ambiguous'))).toBe(false);
    expect(isPainted(r('orphaned'))).toBe(false);
    expect(isPainted(r('resolved', 0))).toBe(false);
    expect(isPainted(undefined)).toBe(false);
  });

  it('names a page or a page range', () => {
    expect(pageRange([4])).toBe('page 4');
    expect(pageRange([4, 5, 6])).toBe('pages 4-6');
    expect(pageRange([])).toBe('');
  });
});
