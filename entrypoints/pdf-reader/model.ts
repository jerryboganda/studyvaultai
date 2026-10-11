import type { HighlightView, PdfRect } from '@shared';
import type { PdfResolution, PageDom, PagePart } from '@pdf';
import { CSS_UNITS } from '@pdf';

/** Pure view logic of the reader (unit-tested without a DOM). */

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];
/** Space kept around a page in the scroll area when fitting (CSS px, both axes). */
export const FIT_MARGIN = 32;

export type ZoomMode =
  { kind: 'custom'; zoom: number } | { kind: 'fit-width' } | { kind: 'fit-page' };

export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((z) => z > current + 1e-6) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--)
    if (ZOOM_STEPS[i]! < current - 1e-6) return ZOOM_STEPS[i]!;
  return MIN_ZOOM;
}

export interface Size {
  w: number;
  h: number;
}

/** Page size in PDF units as displayed (swapped for a quarter turn). */
export function displayedSize(view: readonly number[], rotation: number): Size {
  const w = Math.abs((view[2] ?? 612) - (view[0] ?? 0));
  const h = Math.abs((view[3] ?? 792) - (view[1] ?? 0));
  return rotation % 180 === 0 ? { w, h } : { w: h, h: w };
}

/** Zoom factor (1 = 100%, i.e. 96/72 CSS px per PDF unit) for a mode, page and scroll-area size. */
export function zoomFor(mode: ZoomMode, page: Size, area: Size): number {
  if (mode.kind === 'custom') return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, mode.zoom));
  const byWidth = (area.w - FIT_MARGIN) / (page.w * CSS_UNITS);
  const raw =
    mode.kind === 'fit-width'
      ? byWidth
      : Math.min(byWidth, (area.h - FIT_MARGIN) / (page.h * CSS_UNITS));
  return Number.isFinite(raw) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, raw)) : 1;
}

export function describeZoom(mode: ZoomMode, effective: number): string {
  if (mode.kind === 'fit-width') return `Fit width (${Math.round(effective * 100)}%)`;
  if (mode.kind === 'fit-page') return `Fit page (${Math.round(effective * 100)}%)`;
  return `${Math.round(effective * 100)}%`;
}

export function nextRotation(deg: number, direction: 1 | -1 = 1): 0 | 90 | 180 | 270 {
  return ((((deg + direction * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

// ---------------------------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------------------------

export interface PdfHighlightRow {
  view: HighlightView;
  pageNumber: number;
  start: number;
}

/** Highlights of this document in page order, then position on the page. Non-PDF anchors are skipped. */
export function pdfRows(views: readonly HighlightView[]): PdfHighlightRow[] {
  const rows: PdfHighlightRow[] = [];
  for (const view of views) {
    if (view.anchorSet.type !== 'pdf') continue;
    rows.push({
      view,
      pageNumber: view.anchorSet.pageNumber,
      start: view.anchorSet.textPosition.start,
    });
  }
  return rows.sort(
    (a, b) =>
      a.pageNumber - b.pageNumber ||
      a.start - b.start ||
      a.view.capturedAt.localeCompare(b.view.capturedAt),
  );
}

/** Highlights that are painted: only a unique, verified place is ever drawn. */
export function isPainted(r: PdfResolution | undefined): r is PdfResolution {
  return (
    r !== undefined && (r.status === 'resolved' || r.status === 'changed') && r.rects.length > 0
  );
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

export interface SelectionPart {
  pageNumber: number;
  quote: string;
  start: number;
  end: number;
  rects: PdfRect[];
  part: PagePart;
}

export interface PdfSelection {
  parts: SelectionPart[];
  /** Screen box of the whole selection, for placing the save bar. */
  bounds: { left: number; top: number; right: number; bottom: number };
}

export function toSelectionPart(part: PagePart, rects: PdfRect[]): SelectionPart {
  const page: PageDom = part.page;
  return {
    pageNumber: page.pageNumber,
    quote: page.text.text.slice(part.start, part.end),
    start: part.start,
    end: part.end,
    rects,
    part,
  };
}

export interface BarPlacement {
  left: number;
  top: number;
}

/**
 * Where the save bar goes: under the selection, flipped above it when there is no room below, kept
 * inside the viewport horizontally. The bar never covers the selected text.
 */
export function placeBar(
  bounds: PdfSelection['bounds'],
  bar: Size,
  viewport: Size,
  gap = 8,
): BarPlacement {
  const below = bounds.bottom + gap;
  const above = bounds.top - gap - bar.h;
  const top =
    below + bar.h <= viewport.h
      ? below
      : above >= 0
        ? above
        : Math.max(0, viewport.h - bar.h - gap);
  const left = Math.min(Math.max(gap, bounds.left), Math.max(gap, viewport.w - bar.w - gap));
  return { left, top };
}

export function pageRange(pages: readonly number[]): string {
  if (pages.length === 0) return '';
  const first = pages[0]!;
  const last = pages[pages.length - 1]!;
  return first === last ? `page ${first}` : `pages ${first}-${last}`;
}
