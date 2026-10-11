import { useEffect, useId, useRef, useState } from 'react';
import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_COMMENT_CHARS,
  type BankLite,
  type ColorId,
  type HighlightKind,
  type HighlightPatch,
} from '@shared';
import { isOcrSignature, type PdfResolution } from '@pdf';
import {
  Button,
  EmptyState,
  InlineNotice,
  KindChip,
  ResolveBadge,
  describeResolveState,
  errorMessage,
  safeHref,
  truncate,
} from '@ui';
import type { ResolveStatus } from '@shared';
import type { PdfHighlightRow } from './model';

const NOTE_DEBOUNCE_MS = 800;

export interface CompanionActions {
  goTo(id: string): void;
  update(id: string, patch: HighlightPatch): Promise<void>;
  remove(id: string): Promise<void>;
}

function statusOf(r: PdfResolution | undefined): ResolveStatus {
  return r ? r.status : 'unchecked';
}

/** The companion pane: this document's highlights, with note editing and jump-to. */
export function Companion({
  rows,
  resolutions,
  banks,
  ocrPages,
  originalUrl,
  selectedId,
  paletteFor,
  actions,
}: {
  rows: readonly PdfHighlightRow[];
  resolutions: ReadonlyMap<string, PdfResolution>;
  banks: readonly BankLite[];
  /** Pages whose text comes from OCR (machine-recognised, may contain errors). */
  ocrPages: ReadonlySet<number>;
  originalUrl: string | null;
  selectedId: string | null;
  paletteFor(kind: HighlightKind): ColorId;
  actions: CompanionActions;
}) {
  const attention = rows.filter(
    (r) => describeResolveState(statusOf(resolutions.get(r.view.id))).attention,
  ).length;
  return (
    <aside
      className="sv-companion"
      aria-label="Highlights in this document"
      data-testid="pdf-companion"
    >
      <h2>Highlights in this document</h2>
      {attention > 0 ? (
        <InlineNotice tone="warning" title={`${attention} not painted on the page`}>
          These could not be placed on exactly one passage, so StudyVault does not draw them rather
          than mark the wrong text. Your quotes and notes are unchanged.
        </InlineNotice>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title="No highlights yet">
          Select text on a page, then choose Save highlight. Highlights you save here come back
          every time you open this PDF.
        </EmptyState>
      ) : (
        <ul className="sv-companion__list">
          {rows.map((r) => (
            <li key={r.view.id}>
              <Card
                row={r}
                resolution={resolutions.get(r.view.id)}
                banks={banks}
                fromOcr={
                  ocrPages.has(r.pageNumber) ||
                  (r.view.anchorSet.type === 'pdf' &&
                    isOcrSignature(r.view.anchorSet.contentSignature))
                }
                originalUrl={originalUrl}
                selected={r.view.id === selectedId}
                paletteFor={paletteFor}
                actions={actions}
              />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function Card({
  row,
  resolution,
  banks,
  fromOcr,
  originalUrl,
  selected,
  paletteFor,
  actions,
}: {
  row: PdfHighlightRow;
  resolution: PdfResolution | undefined;
  banks: readonly BankLite[];
  fromOcr: boolean;
  originalUrl: string | null;
  selected: boolean;
  paletteFor(kind: HighlightKind): ColorId;
  actions: CompanionActions;
}) {
  const { view, pageNumber } = row;
  const uid = useId();
  const status = statusOf(resolution);
  const state = describeResolveState(status);
  const [note, setNote] = useState(view.userComment);
  const [saveState, setSaveState] = useState<{
    t: 'idle' | 'saving' | 'saved' | 'error';
    message?: string;
  }>({
    t: 'idle',
  });
  const saved = useRef(view.userComment);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const card = useRef<HTMLElement>(null);

  // Another context changed the note (side panel): follow it unless this field is being edited.
  useEffect(() => {
    if (view.userComment !== saved.current && document.activeElement?.id !== `${uid}-note`) {
      saved.current = view.userComment;
      setNote(view.userComment);
    }
  }, [view.userComment, uid]);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (selected) card.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const commit = async (value: string): Promise<void> => {
    clearTimeout(timer.current);
    if (value === saved.current) return;
    setSaveState({ t: 'saving' });
    try {
      await actions.update(view.id, { userComment: value });
      saved.current = value;
      setSaveState({ t: 'saved' });
    } catch (err) {
      setSaveState({ t: 'error', message: errorMessage(err, 'The note could not be saved.') });
    }
  };

  const href = originalUrl ? safeHref(originalUrl) : undefined;
  const bankNames = view.bankIds
    .map((id) => banks.find((b) => b.id === id)?.name)
    .filter((n): n is string => Boolean(n));

  return (
    <article
      ref={card}
      className={`sv-card${selected ? ' sv-card--selected' : ''}`}
      data-highlight-id={view.id}
      data-testid="pdf-highlight-card"
      aria-label={`Page ${pageNumber}, ${KIND_LABELS[view.kind].label}: ${truncate(view.exactQuote, 60)}`}
    >
      <div className="sv-row">
        <span className="sv-badge" data-testid="pdf-card-page">
          p. {pageNumber}
        </span>
        <KindChip kind={view.kind} color={view.color} />
        <ResolveBadge status={status} />
        {fromOcr ? <span className="sv-badge sv-badge--warning">OCR text</span> : null}
      </div>

      <blockquote className="sv-quote" dir="auto">
        {truncate(view.exactQuote, 400)}
      </blockquote>
      {state.attention && state.explanation ? (
        <p className="sv-small sv-muted">{state.explanation}</p>
      ) : null}
      {fromOcr ? (
        <p className="sv-small sv-muted">
          This text was recognised from a scanned image and may contain errors.
        </p>
      ) : null}
      {view.headingContext ? (
        <p className="sv-small sv-muted" dir="auto" data-testid="pdf-card-heading">
          Section: {view.headingContext}
        </p>
      ) : null}
      {bankNames.length > 0 ? (
        <p className="sv-small sv-muted">Bank: {bankNames.join(', ')}</p>
      ) : null}

      <label className="sv-field" htmlFor={`${uid}-note`}>
        <span className="sv-label">Note</span>
        <textarea
          id={`${uid}-note`}
          className="sv-control"
          rows={2}
          maxLength={MAX_COMMENT_CHARS}
          value={note}
          placeholder="Your own words (the quote above never changes)"
          onChange={(e) => {
            setNote(e.target.value);
            setSaveState({ t: 'idle' });
            clearTimeout(timer.current);
            const value = e.target.value;
            timer.current = setTimeout(() => void commit(value), NOTE_DEBOUNCE_MS);
          }}
          onBlur={() => void commit(note)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void commit(note);
            }
          }}
        />
      </label>
      <p className="sv-small sv-muted" role="status">
        {saveState.t === 'saving' ? 'Saving…' : saveState.t === 'saved' ? 'Note saved.' : ''}
      </p>
      {saveState.t === 'error' ? (
        <InlineNotice tone="error" title="Note not saved">
          {saveState.message}
        </InlineNotice>
      ) : null}

      <div className="sv-row">
        <Button onClick={() => actions.goTo(view.id)} data-testid="pdf-card-goto">
          Go to highlight
        </Button>
        <label className="sv-sr" htmlFor={`${uid}-kind`}>
          Kind
        </label>
        <select
          id={`${uid}-kind`}
          className="sv-control sv-card__kind"
          value={view.kind}
          onChange={(e) => {
            const kind = e.target.value as HighlightKind;
            void actions.update(view.id, { kind, color: paletteFor(kind) });
          }}
        >
          {HIGHLIGHT_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k].glyph} {KIND_LABELS[k].label}
            </option>
          ))}
        </select>
        {href ? (
          <a
            className="sv-btn"
            href={`${href}#page=${pageNumber}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open page in source
          </a>
        ) : (
          <Button disabledReason="This PDF was opened from a file on this device, so there is no web address to open.">
            Open page in source
          </Button>
        )}
        <Button variant="danger" onClick={() => void actions.remove(view.id)}>
          Delete
        </Button>
      </div>
    </article>
  );
}
