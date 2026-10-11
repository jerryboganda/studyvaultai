import { useState, type RefObject } from 'react';
import { Button } from '@ui';
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
  onOpenAnother,
}: {
  page: number;
  pageCount: number;
  zoom: ZoomMode;
  effectiveZoom: number;
  search: SearchState;
  companionOpen: boolean;
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
  onOpenAnother(): void;
}) {
  // null = follow the current page; a string = what was typed and not yet committed.
  const [typed, setTyped] = useState<string | null>(null);
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

  return (
    <header className="sv-toolbar" aria-label="PDF toolbar">
      <div className="sv-toolbar__group">
        <Button
          aria-pressed={sidePaneOpen}
          onClick={onToggleSidePane}
          title="Show or hide the outline and page thumbnails"
          data-testid="pdf-toggle-sidepane"
        >
          Outline and pages
        </Button>
      </div>

      <div className="sv-toolbar__group" role="group" aria-label="Page">
        <Button
          aria-label="Previous page"
          title="Previous page ([)"
          disabledReason={page <= 1 ? 'Already on the first page.' : undefined}
          onClick={() => onGoToPage(page - 1)}
        >
          <span aria-hidden="true">↑</span>
        </Button>
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
            onBlur={commitPage}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitPage();
              }
            }}
          />
          <span aria-hidden="true"> / {pageCount}</span>
          <span className="sv-sr"> of {pageCount}</span>
        </label>
        <Button
          aria-label="Next page"
          title="Next page (])"
          disabledReason={page >= pageCount ? 'Already on the last page.' : undefined}
          onClick={() => onGoToPage(page + 1)}
        >
          <span aria-hidden="true">↓</span>
        </Button>
      </div>

      <div className="sv-toolbar__group" role="group" aria-label="Zoom and rotation">
        <Button
          aria-label="Zoom out"
          title="Zoom out (-)"
          onClick={() => onZoom({ kind: 'custom', zoom: stepZoom(effectiveZoom, -1) })}
        >
          <span aria-hidden="true">−</span>
        </Button>
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
        <Button
          aria-label="Zoom in"
          title="Zoom in (+)"
          onClick={() => onZoom({ kind: 'custom', zoom: stepZoom(effectiveZoom, 1) })}
        >
          <span aria-hidden="true">+</span>
        </Button>
        <Button
          aria-label="Rotate pages clockwise"
          title="Rotate clockwise (R)"
          onClick={onRotate}
          data-testid="pdf-rotate"
        >
          <span aria-hidden="true">⟳</span>
        </Button>
      </div>

      <form
        className="sv-toolbar__group sv-toolbar__search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onFind(1);
        }}
      >
        <label>
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
        <Button
          aria-label="Previous match"
          disabledReason={search.total === 0 ? 'There are no matches to step through.' : undefined}
          onClick={() => onFind(-1)}
        >
          <span aria-hidden="true">‹</span>
        </Button>
        <Button
          aria-label="Next match"
          disabledReason={search.total === 0 ? 'There are no matches to step through.' : undefined}
          onClick={() => onFind(1)}
        >
          <span aria-hidden="true">›</span>
        </Button>
        <span
          className="sv-small sv-muted sv-toolbar__count"
          role="status"
          data-testid="pdf-find-count"
        >
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

      <div className="sv-toolbar__group sv-toolbar__end">
        <Button
          aria-pressed={companionOpen}
          onClick={onToggleCompanion}
          data-testid="pdf-toggle-highlights"
        >
          Highlights ({highlightCount})
        </Button>
        <Button onClick={onOpenAnother}>Open another PDF</Button>
      </div>
    </header>
  );
}
