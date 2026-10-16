import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  Highlighter,
  RotateCw,
  Search,
  TableOfContents,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button, IconButton, InfoTip, type IconButtonProps } from '@ui';
import { describeZoom, stepZoom, type ZoomMode } from './model';

export interface SearchState {
  query: string;
  status: 'idle' | 'searching' | 'done';
  total: number;
  /** 0-based index of the current match, -1 for none. */
  current: number;
  pagesDone: number;
  pageCount: number;
  truncated: boolean;
}

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/**
 * Icon button that can be unavailable: it stays focusable (aria-disabled), ignores clicks and is
 * described by its reason; the tooltip keeps its name.
 */
function Tool({ reason, onClick, ...rest }: IconButtonProps & { reason?: string }) {
  const id = useId();
  return (
    <>
      <IconButton
        {...rest}
        aria-disabled={reason ? true : undefined}
        aria-describedby={reason ? id : undefined}
        onClick={reason ? undefined : onClick}
      />
      {reason ? (
        <span id={id} className="sv-sr">
          {reason}
        </span>
      ) : null}
    </>
  );
}

/** The reader's one-row toolbar: page, zoom, find, and the side pane's two toggles. */
export function Toolbar({
  page,
  pageCount,
  zoom,
  effectiveZoom,
  search,
  companionOpen,
  sidePaneOpen,
  highlightCount,
  pageInput,
  searchInput,
  onGoToPage,
  onZoom,
  onRotate,
  onQuery,
  onFind,
  onToggleCompanion,
  onToggleSidePane,
  backTo,
  onBack,
}: {
  page: number;
  pageCount: number;
  zoom: ZoomMode;
  effectiveZoom: number;
  search: SearchState;
  /** The side pane shows the highlights (or the page text). */
  companionOpen: boolean;
  /** The side pane shows the outline, the pages or the links. */
  sidePaneOpen: boolean;
  highlightCount: number;
  pageInput: RefObject<HTMLInputElement | null>;
  searchInput: RefObject<HTMLInputElement | null>;
  onGoToPage(n: number): void;
  onZoom(mode: ZoomMode): void;
  onRotate(): void;
  onQuery(q: string): void;
  onFind(direction: 1 | -1): void;
  onToggleCompanion(): void;
  onToggleSidePane(): void;
  /** The page Back returns to after a link was followed; null: no link has been followed yet. */
  backTo?: number | null;
  /** Back (Alt+Left). Without it the button is not offered. */
  onBack?(): void;
}) {
  // null = follow the current page; a string = what was typed and not yet committed.
  const [typed, setTyped] = useState<string | null>(null);
  // Narrow windows fold zoom, rotation and the shortcuts into "More tools" (one copy of each control:
  // CSS shows the group inline when there is room).
  const [more, setMore] = useState(false);
  const moreBox = useRef<HTMLDivElement>(null);
  const moreId = useId();
  useEffect(() => {
    if (!more) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!moreBox.current?.contains(e.target as Node)) setMore(false);
    };
    // Capture, like the tooltips (which stop the event): one Escape closes the panel. An open (i)
    // inside it is closed first, on its own.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (moreBox.current?.querySelector('.sv-infotip__btn[aria-expanded="true"]')) return;
      e.preventDefault();
      setMore(false);
      moreBox.current?.querySelector<HTMLElement>('.sv-toolbar__morebtn')?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [more]);
  const draft = typed ?? String(page);

  const commitPage = (): void => {
    const n = Number.parseInt(draft, 10);
    setTyped(null);
    if (Number.isInteger(n)) onGoToPage(Math.min(Math.max(1, n), pageCount));
  };

  const zoomValue =
    zoom.kind === 'fit-width'
      ? 'fit-width'
      : zoom.kind === 'fit-page'
        ? 'fit-page'
        : String(Math.round(zoom.zoom * 100) / 100);
  const customIsPreset =
    zoom.kind !== 'custom' || PRESETS.includes(Math.round(zoom.zoom * 100) / 100);

  const searching = search.status === 'searching';
  const found = searching
    ? ''
    : search.query.trim() === ''
      ? ''
      : search.total === 0
        ? 'No matches'
        : `${search.current + 1} of ${search.total}${search.truncated ? '+' : ''}`;
  const noMatches = search.total === 0 ? 'There are no matches to step through.' : undefined;

  return (
    <header className="sv-toolbar" aria-label="PDF toolbar">
      <div className="sv-toolbar__group" role="group" aria-label="Page">
        <Tool
          icon={ChevronUp}
          label="Previous page"
          tipSide="right"
          reason={page <= 1 ? 'Already on the first page.' : undefined}
          onClick={() => onGoToPage(page - 1)}
        />
        <label className="sv-toolbar__page">
          <span className="sv-sr">Page number</span>
          <input
            ref={pageInput}
            className="sv-control sv-toolbar__pageinput"
            type="number"
            inputMode="numeric"
            min={1}
            max={pageCount}
            value={draft}
            data-testid="pdf-page-input"
            onChange={(e) => setTyped(e.target.value)}
            // Leaving the box commits what was typed; with nothing typed it must not jump back to the
            // top of the current page (a click into the document would undo the person's scrolling).
            onBlur={() => {
              if (typed !== null) commitPage();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitPage();
              }
            }}
          />
          <span aria-hidden="true">/ {pageCount}</span>
          <span className="sv-sr"> of {pageCount}</span>
        </label>
        <Tool
          icon={ChevronDown}
          label="Next page"
          reason={page >= pageCount ? 'Already on the last page.' : undefined}
          onClick={() => onGoToPage(page + 1)}
        />
        {onBack ? (
          <Button
            variant="ghost"
            className="sv-toolbar__back"
            title="Back to where the last link was followed (Alt+Left)"
            disabledReason={backTo == null ? 'No link has been followed yet.' : undefined}
            onClick={onBack}
            data-testid="pdf-back"
          >
            <Undo2 aria-hidden="true" />
            <span className="sv-toolbar__backtext">
              {backTo == null ? 'Back' : `Back to page ${backTo}`}
            </span>
          </Button>
        ) : null}
      </div>

      <div
        ref={moreBox}
        className={`sv-toolbar__more${more ? ' sv-toolbar__more--open' : ''}`}
        // Tabbing out of the panel closes it: it never floats over the page behind the focus.
        onBlur={(e) => {
          if (more && !e.currentTarget.contains(e.relatedTarget as Node | null)) setMore(false);
        }}
      >
        <IconButton
          icon={Ellipsis}
          label="More tools"
          tipSide="left"
          className="sv-toolbar__morebtn"
          aria-expanded={more}
          aria-controls={moreId}
          onClick={() => setMore((m) => !m)}
        />
        <div
          id={moreId}
          className="sv-toolbar__group sv-toolbar__overflow"
          role="group"
          aria-label="Zoom and rotation"
        >
          <Tool
            icon={ZoomOut}
            label="Zoom out"
            onClick={() => onZoom({ kind: 'custom', zoom: stepZoom(effectiveZoom, -1) })}
          />
          <label>
            <span className="sv-sr">Zoom level</span>
            <select
              className="sv-control sv-toolbar__zoom"
              value={zoomValue}
              data-testid="pdf-zoom"
              onChange={(e) => {
                const v = e.target.value;
                onZoom(
                  v === 'fit-width'
                    ? { kind: 'fit-width' }
                    : v === 'fit-page'
                      ? { kind: 'fit-page' }
                      : { kind: 'custom', zoom: Number(v) },
                );
              }}
            >
              <option value="fit-width">Fit width</option>
              <option value="fit-page">Fit page</option>
              {PRESETS.map((z) => (
                <option key={z} value={String(z)}>
                  {Math.round(z * 100)}%
                </option>
              ))}
              {customIsPreset ? null : (
                <option value={zoomValue}>{describeZoom(zoom, effectiveZoom)}</option>
              )}
            </select>
          </label>
          <Tool
            icon={ZoomIn}
            label="Zoom in"
            onClick={() => onZoom({ kind: 'custom', zoom: stepZoom(effectiveZoom, 1) })}
          />
          <Tool
            icon={RotateCw}
            label="Rotate pages clockwise"
            onClick={onRotate}
            data-testid="pdf-rotate"
          />
          <InfoTip label="Keyboard shortcuts" align="end">
            <span data-testid="pdf-keyboard-hint">
              Without a mouse: press <kbd className="sv-kbd">F7</kbd> for caret browsing, select
              with <kbd className="sv-kbd">Shift</kbd> and the arrows, then press{' '}
              <kbd className="sv-kbd">S</kbd> or <kbd className="sv-kbd">Enter</kbd> to save.{' '}
              <kbd className="sv-kbd">]</kbd> <kbd className="sv-kbd">[</kbd> page,{' '}
              <kbd className="sv-kbd">+</kbd> <kbd className="sv-kbd">-</kbd> zoom,{' '}
              <kbd className="sv-kbd">R</kbd> rotate, <kbd className="sv-kbd">/</kbd> search.
            </span>
          </InfoTip>
        </div>
      </div>

      <form
        className="sv-toolbar__group sv-toolbar__search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onFind(1);
        }}
      >
        <label className="sv-toolbar__find">
          <Search aria-hidden="true" strokeWidth={2.4} />
          <span className="sv-sr">Search in this PDF</span>
          <input
            ref={searchInput}
            className="sv-control"
            type="search"
            placeholder="Search in PDF"
            value={search.query}
            data-testid="pdf-search"
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                onFind(-1);
              }
            }}
          />
        </label>
        <Tool
          icon={ChevronLeft}
          label="Previous match"
          reason={noMatches}
          onClick={() => onFind(-1)}
        />
        <Tool icon={ChevronRight} label="Next match" reason={noMatches} onClick={() => onFind(1)} />
        <span className="sv-small sv-toolbar__count" role="status" data-testid="pdf-find-count">
          {searching ? (
            <>
              {/* One steady word is announced; the page counter ticks for the eye only. */}
              <span>Searching…</span>
              <span aria-hidden="true">
                {` page ${search.pagesDone} of ${search.pageCount}${search.total > 0 ? `, ${search.total} found` : ''}`}
              </span>
            </>
          ) : (
            found
          )}
        </span>
      </form>

      <div className="sv-toolbar__group sv-toolbar__end" role="group" aria-label="Side pane">
        <Tool
          icon={TableOfContents}
          label="Outline and pages"
          tipSide="left"
          aria-pressed={sidePaneOpen}
          onClick={onToggleSidePane}
          data-testid="pdf-toggle-sidepane"
        />
        <span className="sv-toolbar__counted">
          <Tool
            icon={Highlighter}
            label={`Highlights (${highlightCount})`}
            tipSide="left"
            aria-pressed={companionOpen}
            onClick={onToggleCompanion}
            data-testid="pdf-toggle-highlights"
          />
          {highlightCount > 0 ? (
            <span className="sv-toolbar__badge" aria-hidden="true">
              {highlightCount > 99 ? '99+' : highlightCount}
            </span>
          ) : null}
        </span>
      </div>
    </header>
  );
}
