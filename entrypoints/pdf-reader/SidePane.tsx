import { useEffect, useMemo, useRef, useState } from 'react';
import type { OutlineEntry, PageLink, PageLinks, PdfDocument } from '@pdf';
import { NO_LINKS } from '@pdf';
import { BuddyEmptyState, Button } from '@ui';
import { LinkList } from './links';

export type NavTab = 'outline' | 'pages' | 'links';

/**
 * The links of the page in view, read while `enabled` (the side pane is open); null while reading.
 * Without `doc.getLinks` there is nothing to read and the Links tab is not offered.
 */
export function usePageLinks(
  doc: Partial<Pick<PdfDocument, 'getLinks'>>,
  page: number,
  enabled: boolean,
): PageLinks | null {
  const [read, setRead] = useState<{ page: number; links: PageLinks } | null>(null);
  useEffect(() => {
    if (!doc.getLinks || !enabled) return undefined;
    let live = true;
    doc.getLinks(page).then(
      (links) => live && setRead({ page, links }),
      () => live && setRead({ page, links: NO_LINKS }),
    );
    return () => {
      live = false;
    };
  }, [doc, enabled, page]);
  return read?.page === page ? read.links : null;
}

/**
 * The navigation tabs of the side pane: the document outline (bookmarks), lazy page thumbnails and
 * the links of the page in view. Thumbnails are drawn only while they are near the pane's visible
 * area and released when they leave it, so a 1,000-page document costs a handful of small canvases.
 */
export function SidePane({
  tab,
  doc,
  outline,
  page,
  links,
  onGoToPage,
  onFollowLink,
}: {
  tab: NavTab;
  doc: Pick<PdfDocument, 'getPage' | 'pageCount'>;
  /** null while the outline is still being read. */
  outline: readonly OutlineEntry[] | null;
  page: number;
  /** The page's links (`usePageLinks`); null while they are read. */
  links: PageLinks | null;
  onGoToPage(pageNumber: number): void;
  onFollowLink(link: PageLink): void;
}) {
  return (
    <nav className="sv-sidepane" aria-label="Outline and pages" data-testid="pdf-sidepane">
      {tab === 'outline' ? (
        <OutlineList outline={outline} page={page} onGoToPage={onGoToPage} />
      ) : tab === 'pages' ? (
        <Thumbnails doc={doc} page={page} onGoToPage={onGoToPage} />
      ) : (
        <LinkList links={links} pageNumber={page} onFollow={onFollowLink} />
      )}
    </nav>
  );
}

function OutlineList({
  outline,
  page,
  onGoToPage,
}: {
  outline: readonly OutlineEntry[] | null;
  page: number;
  onGoToPage(pageNumber: number): void;
}) {
  // The section in view: the last entry that starts on or before the current page.
  const current = useMemo(() => {
    let found = -1;
    outline?.forEach((e, i) => {
      if (e.pageNumber !== null && e.pageNumber <= page) found = i;
    });
    return found;
  }, [outline, page]);

  if (outline === null)
    return (
      <p className="sv-muted" role="status">
        Reading the outline…
      </p>
    );
  if (outline.length === 0) {
    return (
      <div data-testid="pdf-outline-empty">
        <BuddyEmptyState
          pose="think"
          mascotSize={96}
          title="No outline"
          text="This PDF has no bookmarks. Try Pages."
        />
      </div>
    );
  }
  return (
    <ul className="sv-outline" data-testid="pdf-outline">
      {outline.map((entry, i) => (
        <li key={i} style={{ paddingInlineStart: `${entry.depth * 0.9}rem` }}>
          {entry.pageNumber === null ? (
            <Button
              variant="ghost"
              disabledReason="This bookmark does not point to a page in the file."
            >
              {entry.title}
            </Button>
          ) : (
            <Button
              variant="ghost"
              aria-current={i === current ? 'location' : undefined}
              onClick={() => onGoToPage(entry.pageNumber!)}
            >
              <span className="sv-grow">{entry.title}</span>
              <span className="sv-outline__page sv-small"> · p. {entry.pageNumber}</span>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

const THUMB_WIDTH = 112;

function Thumbnails({
  doc,
  page,
  onGoToPage,
}: {
  doc: Pick<PdfDocument, 'getPage' | 'pageCount'>;
  page: number;
  onGoToPage(pageNumber: number): void;
}) {
  const root = useRef<HTMLOListElement>(null);
  const pages = useMemo(() => Array.from({ length: doc.pageCount }, (_, i) => i + 1), [doc]);

  // Keep the current page's thumbnail in view without stealing focus.
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>(`[data-thumb="${page}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [page]);

  return (
    <ol className="sv-thumbs" ref={root} data-testid="pdf-thumbs">
      {pages.map((n) => (
        <li key={n}>
          <Thumb
            doc={doc}
            pageNumber={n}
            current={n === page}
            root={root}
            onGo={() => onGoToPage(n)}
          />
        </li>
      ))}
    </ol>
  );
}

function Thumb({
  doc,
  pageNumber,
  current,
  root,
  onGo,
}: {
  doc: Pick<PdfDocument, 'getPage'>;
  pageNumber: number;
  current: boolean;
  root: React.RefObject<HTMLOListElement | null>;
  onGo(): void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(1.3);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = button.current;
    const cv = canvas.current;
    if (!el || !cv) return undefined;
    let cancelAll: (() => void) | null = null;
    const clear = (): void => {
      cancelAll?.();
      cancelAll = null;
      cv.width = 0;
      cv.height = 0;
    };
    const draw = (): void => {
      let cancelled = false;
      let task: { cancel(): void } | null = null;
      cancelAll = () => {
        cancelled = true;
        task?.cancel();
      };
      void (async () => {
        try {
          const p = await doc.getPage(pageNumber);
          if (cancelled) return;
          const unit = p.getViewport({ scale: 1 });
          const scale = THUMB_WIDTH / unit.width;
          const vp = p.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
          cv.width = Math.max(1, Math.floor(vp.width));
          cv.height = Math.max(1, Math.floor(vp.height));
          setAspect(unit.height / unit.width);
          const t = p.render({ canvas: cv, viewport: vp });
          task = t;
          await t.promise;
        } catch (err) {
          if (!cancelled && (err as { name?: string }).name !== 'RenderingCancelledException') {
            setFailed(true);
          }
        }
      })();
    };
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (very old engines, test DOM): draw once instead of never.
      draw();
      return clear;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) draw();
          else clear();
        }
      },
      // The tab panel is what scrolls (the list itself never clips, so as a root it saw every page).
      { root: root.current?.closest('[role="tabpanel"]') ?? null, rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clear();
    };
  }, [doc, pageNumber, root]);

  return (
    <button
      ref={button}
      type="button"
      className="sv-thumb"
      data-thumb={pageNumber}
      aria-label={`Go to page ${pageNumber}`}
      aria-current={current ? 'page' : undefined}
      onClick={onGo}
    >
      <span className="sv-thumb__frame" style={{ aspectRatio: `1 / ${aspect}` }}>
        <canvas ref={canvas} aria-hidden="true" />
        {failed ? <span className="sv-small">No preview</span> : null}
      </span>
      <span className="sv-thumb__num">{pageNumber}</span>
    </button>
  );
}
