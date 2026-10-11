import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  CSS_UNITS,
  LazyPages,
  pageHasText,
  paintOverlay,
  paintRects,
  partRects,
  rangeParts,
  rectsForRange,
  renderPageInto,
  rotateRect,
  type FindMatch,
  type OverlayItem,
  type PdfDocument,
  type RenderedPage,
} from '@pdf';
import type { PdfRect } from '@shared';
import {
  displayedSize,
  toSelectionPart,
  zoomFor,
  type PdfSelection,
  type Size,
  type ZoomMode,
} from './model';

export interface ViewerHandle {
  jumpToPage(pageNumber: number): void;
  /** Scroll to a rectangle of a page (raw frame) so it sits in the upper third of the view. */
  reveal(pageNumber: number, rect: PdfRect | null): void;
  focus(): void;
  /** Draw the kept pages again (their text source changed). */
  redraw(): void;
}

export type ViewerShortcut =
  | 'next-page'
  | 'previous-page'
  | 'first-page'
  | 'last-page'
  | 'zoom-in'
  | 'zoom-out'
  | 'fit-width'
  | 'rotate'
  | 'search'
  | 'go-to-page'
  | 'save-selection';

interface PageInfo {
  view: readonly number[];
  rotate: number;
}

interface Props {
  doc: PdfDocument;
  zoom: ZoomMode;
  /** The reader's rotation, added to each page's own /Rotate. */
  rotation: number;
  overlays: ReadonlyMap<number, OverlayItem[]>;
  flashId: string | null;
  find: { matches: readonly FindMatch[]; current: number };
  /** The pending selection, painted on its pages while the save bar is open. */
  pending: PdfSelection | null;
  /** page -> has embedded text / where its text comes from. */
  pageNotes: ReadonlyMap<number, string>;
  onPage(pageNumber: number): void;
  onSelection(selection: PdfSelection | null): void;
  onPageText(pageNumber: number, info: { hasText: boolean; source: 'embedded' | 'ocr' }): void;
  onSelectHighlight(id: string): void;
  onShortcut(action: ViewerShortcut): void;
  onError(pageNumber: number, message: string): void;
  /** Zoom factor the latest drawn page used (fit modes depend on the window and the page). */
  onEffectiveZoom(zoom: number): void;
}

const DEFAULT_PAGE: PageInfo = { view: [0, 0, 612, 792], rotate: 0 };
const MAX_FIND_RECTS_PER_PAGE = 300;

export const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(props, ref) {
  const { doc } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<number, HTMLElement>());
  const hosts = useRef(new Map<number, HTMLElement>());
  const rendered = useRef(new Map<number, RenderedPage>());
  const lazy = useRef<LazyPages<RenderedPage> | null>(null);
  const ratios = useRef(new Map<number, number>());
  const observer = useRef<IntersectionObserver | null>(null);
  const currentPage = useRef(0);
  const evaluateSelection = useRef<(() => void) | null>(null);

  const latest = useRef(props);
  latest.current = props;

  const [infos, setInfos] = useState<ReadonlyMap<number, PageInfo>>(new Map());
  const [first, setFirst] = useState<PageInfo | null>(null);
  const [area, setArea] = useState<Size>({ w: 800, h: 600 });
  const [failed, setFailed] = useState<ReadonlyMap<number, string>>(new Map());
  const areaRef = useRef(area);
  areaRef.current = area;
  const visibleNow = (): number[] => [...ratios.current].filter(([, r]) => r > 0).map(([n]) => n);

  const infoFor = useCallback(
    (n: number): PageInfo => infos.get(n) ?? first ?? DEFAULT_PAGE,
    [infos, first],
  );
  /** Total viewport rotation of a page: its own /Rotate plus the reader's. */
  const rotationOf = (info: PageInfo): number => (info.rotate + props.rotation) % 360;
  const cssSize = (n: number): Size => {
    const info = infoFor(n);
    const size = displayedSize(info.view, rotationOf(info));
    const z = zoomFor(props.zoom, size, area);
    return { w: size.w * z * CSS_UNITS, h: size.h * z * CSS_UNITS };
  };

  // Page 1 gives the placeholder size of every page that has not been drawn yet.
  useEffect(() => {
    let live = true;
    doc
      .getPage(1)
      .then((p) => live && setFirst({ view: p.view, rotate: p.rotate }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [doc]);

  // Scroll-area size (fit modes depend on it). Trailing debounce: dragging the window edge is not
  // a reason to redraw every frame.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = (): void => setArea({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  // Which pages are on screen -> which pages hold a canvas.
  const paintHighlights = useCallback((n: number): void => {
    const r = rendered.current.get(n);
    if (!r) return;
    const p = latest.current;
    const items = (p.overlays.get(n) ?? []).map((i) => ({ ...i, selected: i.id === p.flashId }));
    paintOverlay(r.layers.highlights, items, r.dom.rotation, p.onSelectHighlight);
  }, []);

  const paintFind = useCallback((n: number): void => {
    const r = rendered.current.get(n);
    if (!r) return;
    const { matches, current } = latest.current.find;
    const here: Array<{ m: FindMatch; index: number }> = [];
    matches.forEach((m, index) => {
      if (m.page === n && here.length < MAX_FIND_RECTS_PER_PAGE) here.push({ m, index });
    });
    if (here.length === 0) {
      paintRects(r.layers.find, [], r.dom.rotation, 'sv-pdf-find');
      return;
    }
    const pt = r.dom.text;
    const rects: PdfRect[] = [];
    const marks: boolean[] = [];
    for (const { m, index } of here) {
      for (const rect of rectsForRange(pt, m.start, m.end)) {
        rects.push(rect);
        marks.push(index === current);
      }
    }
    paintRects(r.layers.find, rects, r.dom.rotation, 'sv-pdf-find', (i) => marks[i] === true);
  }, []);

  useEffect(() => {
    const hooks = {
      render: async (n: number, signal: AbortSignal): Promise<RenderedPage> => {
        const host = hosts.current.get(n);
        if (!host) throw new DOMException('Page slot is gone.', 'AbortError');
        const [pdfPage, pageText, content, source] = await Promise.all([
          doc.getPage(n),
          doc.pageText(n),
          doc.textContent(n),
          doc.textSource(n),
        ]);
        if (signal.aborted) throw new DOMException('Render cancelled.', 'AbortError');
        const p = latest.current;
        const rot = (pdfPage.rotate + p.rotation) % 360;
        const size = displayedSize(pdfPage.view, rot);
        const z = zoomFor(p.zoom, size, areaRef.current);
        const scale = z * CSS_UNITS;
        p.onEffectiveZoom(z);
        const page = await renderPageInto({
          pdfPage,
          content,
          pageText,
          pageNumber: n,
          host,
          scale,
          rotation: rot,
          signal,
        });
        rendered.current.set(n, page);
        setInfos((prev) => {
          const have = prev.get(n);
          if (have && have.rotate === pdfPage.rotate && have.view === pdfPage.view) return prev;
          return new Map(prev).set(n, { view: pdfPage.view, rotate: pdfPage.rotate });
        });
        setFailed((prev) => {
          if (!prev.has(n)) return prev;
          const next = new Map(prev);
          next.delete(n);
          return next;
        });
        latest.current.onPageText(n, { hasText: pageHasText(pageText), source });
        paintHighlights(n);
        paintFind(n);
        // A selection made while this page was still drawing becomes visible to the reader now.
        evaluateSelection.current?.();
        return page;
      },
      release: (n: number, page: RenderedPage): void => {
        if (rendered.current.get(n) === page) rendered.current.delete(n);
        page.destroy();
      },
      onError: (n: number, err: unknown): void => {
        const message = err instanceof Error ? err.message : 'The page could not be drawn.';
        setFailed((prev) => new Map(prev).set(n, message));
        latest.current.onError(n, message);
      },
    };
    const l = new LazyPages<RenderedPage>(hooks, doc.pageCount);
    const drawn = rendered.current;
    lazy.current = l;
    l.setVisible(visibleNow());
    return () => {
      l.destroy();
      lazy.current = null;
      drawn.clear();
    };
    // paintHighlights/paintFind are stable; the document is the only real dependency.
  }, [doc, paintHighlights, paintFind]);

  // Zoom, rotation or (in fit modes) window size changed: redraw what is kept.
  const fitKey =
    props.zoom.kind === 'custom' ? props.zoom.zoom : `${props.zoom.kind}:${area.w}x${area.h}`;
  useEffect(() => {
    lazy.current?.invalidate();
  }, [fitKey, props.rotation]);

  // Overlays, flash and find results repaint the rendered pages without redrawing them.
  useEffect(() => {
    for (const n of rendered.current.keys()) paintHighlights(n);
  }, [props.overlays, props.flashId, paintHighlights]);
  useEffect(() => {
    for (const n of rendered.current.keys()) paintFind(n);
  }, [props.find, paintFind]);
  useEffect(() => {
    for (const [n, r] of rendered.current) {
      const parts = props.pending?.parts.filter((p) => p.pageNumber === n) ?? [];
      paintRects(
        r.layers.pending,
        parts.flatMap((p) => p.rects),
        r.dom.rotation,
        'sv-pdf-pending',
      );
    }
  }, [props.pending, infos]);

  // Visibility and current page.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.pageNumber);
          if (e.isIntersecting) ratios.current.set(n, e.intersectionRatio || 0.0001);
          else ratios.current.set(n, 0);
        }
        lazy.current?.setVisible(visibleNow());
        let best = 0;
        let bestRatio = 0;
        for (const [n, r] of ratios.current) {
          if (r > bestRatio + 1e-6 || (Math.abs(r - bestRatio) <= 1e-6 && r > 0 && n < best)) {
            best = n;
            bestRatio = r;
          }
        }
        if (best > 0 && best !== currentPage.current) {
          currentPage.current = best;
          latest.current.onPage(best);
        }
      },
      { root, rootMargin: '200px 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    observer.current = io;
    const seen = ratios.current;
    for (const el of slots.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observer.current = null;
      seen.clear();
    };
  }, [doc]);

  const setSlot = useCallback(
    (n: number) => (el: HTMLElement | null) => {
      const prev = slots.current.get(n);
      if (prev && prev !== el) observer.current?.unobserve(prev);
      if (el) {
        slots.current.set(n, el);
        observer.current?.observe(el);
      } else {
        slots.current.delete(n);
        ratios.current.delete(n);
      }
    },
    [],
  );
  // One stable callback ref per page, so React does not detach/attach on every render.
  const slotRefs = useRef(new Map<number, (el: HTMLElement | null) => void>());
  const slotRef = (n: number) => {
    let f = slotRefs.current.get(n);
    if (!f) slotRefs.current.set(n, (f = setSlot(n)));
    return f;
  };
  const hostRefs = useRef(new Map<number, (el: HTMLElement | null) => void>());
  const hostRef = (n: number) => {
    let f = hostRefs.current.get(n);
    if (!f) {
      f = (el: HTMLElement | null) => {
        if (el) hosts.current.set(n, el);
        else hosts.current.delete(n);
      };
      hostRefs.current.set(n, f);
    }
    return f;
  };

  // Selection -> stream ranges on the rendered pages.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = (): void => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        latest.current.onSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const pages = [...rendered.current.values()]
        .map((r) => r.dom)
        .sort((a, b) => a.pageNumber - b.pageNumber);
      const parts = rangeParts(range, pages).map((p) => toSelectionPart(p, partRects(p)));
      if (parts.length === 0) {
        latest.current.onSelection(null);
        return;
      }
      const b = range.getBoundingClientRect();
      latest.current.onSelection({
        parts,
        bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      });
    };
    const soon = (): void => {
      clearTimeout(timer);
      timer = setTimeout(evaluate, 80);
    };
    evaluateSelection.current = soon;
    document.addEventListener('selectionchange', soon);
    return () => {
      clearTimeout(timer);
      evaluateSelection.current = null;
      document.removeEventListener('selectionchange', soon);
    };
  }, []);

  const scrollToPage = useCallback((n: number, offset = 0): void => {
    const el = scroller.current;
    const slot = slots.current.get(n);
    if (!el || !slot) return;
    el.scrollTop = Math.max(0, slot.offsetTop - 8 + offset);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      jumpToPage: (n) => scrollToPage(Math.min(Math.max(1, n), doc.pageCount)),
      reveal: (n, rect) => {
        const el = scroller.current;
        const slot = slots.current.get(n);
        if (!el || !slot) return;
        if (!rect) return scrollToPage(n);
        const info = infoFor(n);
        const r = rotateRect(rect, rotationOf(info));
        const h = slot.getBoundingClientRect().height || cssSize(n).h;
        el.scrollTop = Math.max(0, slot.offsetTop + r.y * h - el.clientHeight / 3);
      },
      focus: () => scroller.current?.focus(),
      redraw: () => lazy.current?.invalidate(),
    }),
    // cssSize/rotationOf/infoFor close over the latest render; the handle is re-created each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, scrollToPage, infos, first, props.rotation, props.zoom, area],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const map: Record<string, ViewerShortcut> = {
      ']': 'next-page',
      '[': 'previous-page',
      Home: 'first-page',
      End: 'last-page',
      '+': 'zoom-in',
      '=': 'zoom-in',
      '-': 'zoom-out',
      '0': 'fit-width',
      r: 'rotate',
      '/': 'search',
      g: 'go-to-page',
      h: 'save-selection',
    };
    const action = map[e.key];
    if (action) {
      e.preventDefault();
      props.onShortcut(action);
    }
  };

  const pages = Array.from({ length: doc.pageCount }, (_, i) => i + 1);
  return (
    <div
      ref={scroller}
      className="sv-viewer"
      tabIndex={0}
      role="region"
      aria-label={`PDF pages. ${doc.pageCount} pages. Press ] and [ to change page, + and - to zoom, R to rotate, slash to search, H to save a selection.`}
      onKeyDown={onKeyDown}
      data-testid="pdf-viewer"
    >
      <ol className="sv-pages">
        {pages.map((n) => {
          const size = cssSize(n);
          const note = failed.get(n) ?? props.pageNotes.get(n);
          return (
            <li
              key={n}
              ref={slotRef(n)}
              className="sv-slot"
              data-page-number={n}
              data-testid={`pdf-page-${n}`}
              aria-label={`Page ${n} of ${doc.pageCount}`}
              style={{ width: size.w }}
            >
              <div ref={hostRef(n)} className="sv-page" style={{ width: size.w, height: size.h }} />
              <p className="sv-slot__note sv-small">
                <span>Page {n}</span>
                {note ? <span className="sv-slot__warn"> · {note}</span> : null}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
});
