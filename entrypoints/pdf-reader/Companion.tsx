import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronDown,
  ExternalLink,
  Library,
  LocateFixed,
  NotebookPen,
  RotateCcw,
  ScanText,
  TableOfContents,
  Trash2,
} from 'lucide-react';
import {
  COLOR_SWATCH,
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
  BuddyEmptyState,
  Button,
  IconButton,
  InfoTip,
  InlineNotice,
  ResolveBadge,
  describeResolveState,
  errorMessage,
  plural,
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

/** The highlights tab: this document's highlights as cards, with note editing and jump-to. */
export function Companion({
  rows,
  resolutions,
  banks,
  ocrPages,
  originalUrl,
  selectedId,
  paletteFor,
  actions,
  loading = false,
  error = null,
  onRetry,
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
  /** The list has not been read yet: no empty state is claimed. */
  loading?: boolean;
  /** The list could not be read: said as an error, never as "no highlights". */
  error?: string | null;
  onRetry?(): void;
}) {
  const attention = rows.filter(
    (r) => describeResolveState(statusOf(resolutions.get(r.view.id))).attention,
  ).length;
  return (
    <section
      className="sv-companion"
      aria-label="Highlights in this document"
      data-testid="pdf-companion"
    >
      <h2 className="sv-sr">Highlights in this document</h2>
      {error ? (
        <InlineNotice
          tone="error"
          title="Highlights not loaded"
          action={
            onRetry ? (
              <Button onClick={onRetry}>
                <RotateCcw aria-hidden="true" />
                Retry
              </Button>
            ) : undefined
          }
        >
          {error}
        </InlineNotice>
      ) : null}
      {attention > 0 ? (
        <p className="sv-attention" role="note">
          <span className="sv-pill sv-pill--warning">
            {plural(attention, 'highlight')} not painted
          </span>
          <InfoTip label="Why some are not painted" align="start">
            These could not be placed on exactly one passage, so StudyVault does not draw them
            rather than mark the wrong text. Your quotes and notes are unchanged.
          </InfoTip>
        </p>
      ) : null}
      {rows.length === 0 ? (
        loading ? (
          <p className="sv-muted sv-small" role="status">
            Loading highlights…
          </p>
        ) : error ? null : (
          <BuddyEmptyState
            pose="sleep"
            mascotSize={112}
            title="No highlights yet"
            text="Select text on a page, then press S."
          />
        )
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
    </section>
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
  // Resolved and not-yet-checked need no badge: only a status that asks for a look is shown.
  const flagged = status !== 'resolved' && status !== 'unchecked';
  const stripe = { '--sv-stripe': COLOR_SWATCH[view.color].solid } as CSSProperties;

  return (
    <article
      ref={card}
      className={`sv-hlcard${selected ? ' sv-hlcard--selected' : ''}`}
      style={stripe}
      aria-current={selected ? 'true' : undefined}
      data-highlight-id={view.id}
      data-testid="pdf-highlight-card"
      aria-label={`Page ${pageNumber}, ${KIND_LABELS[view.kind].label}: ${truncate(view.exactQuote, 60)}`}
    >
      <div className="sv-hlcard__top">
        <span className="sv-pill" data-testid="pdf-card-page">
          p. {pageNumber}
        </span>
        {/* The kind chip is the kind control: one place shows the kind and changes it. */}
        <span className="sv-hlcard__kindwrap">
          <label className="sv-sr" htmlFor={`${uid}-kind`}>
            Kind
          </label>
          <select
            id={`${uid}-kind`}
            className="sv-hlcard__kind"
            value={view.kind}
            onChange={(e) => {
              const kind = e.target.value as HighlightKind;
              actions.update(view.id, { kind, color: paletteFor(kind) }).catch((err: unknown) =>
                setSaveState({
                  t: 'error',
                  message: errorMessage(err, 'The kind could not be changed.'),
                }),
              );
            }}
          >
            {HIGHLIGHT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k].glyph} {KIND_LABELS[k].label}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" strokeWidth={2.6} />
        </span>
        {flagged ? <ResolveBadge status={status} /> : null}
        {fromOcr ? (
          <span className="sv-pill sv-pill--warning">
            <ScanText aria-hidden="true" strokeWidth={2.4} />
            OCR text
          </span>
        ) : null}
        {(flagged && state.explanation) || fromOcr ? (
          <InfoTip label="About this highlight" align="end">
            {flagged && state.explanation ? `${state.explanation} ` : ''}
            {fromOcr ? 'This text was recognised from a scanned image and may contain errors.' : ''}
          </InfoTip>
        ) : null}
      </div>

      <blockquote className="sv-hlcard__quote" dir="auto">
        {view.exactQuote}
      </blockquote>

      {view.headingContext || bankNames.length > 0 ? (
        <div className="sv-hlcard__meta">
          {view.headingContext ? (
            <span className="sv-hlcard__heading" dir="auto" data-testid="pdf-card-heading">
              <TableOfContents aria-hidden="true" strokeWidth={2.4} />
              <span className="sv-sr">Section: </span>
              {view.headingContext}
            </span>
          ) : null}
          {bankNames.map((name) => (
            <span key={name} className="sv-pill sv-pill--bank">
              <Library aria-hidden="true" strokeWidth={2.4} />
              <span className="sv-sr">Bank: </span>
              {name}
            </span>
          ))}
        </div>
      ) : null}

      {/* At rest the note reads as a line of the card (icon + text), as on the side panel. */}
      <div className="sv-hlcard__note">
        <label htmlFor={`${uid}-note`}>
          <NotebookPen aria-hidden="true" strokeWidth={2.4} />
          <span className="sv-sr">Note</span>
        </label>
        <textarea
          id={`${uid}-note`}
          className="sv-hlcard__noteinput"
          rows={1}
          maxLength={MAX_COMMENT_CHARS}
          value={note}
          dir="auto"
          placeholder="Quick note"
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
        <p className="sv-hlcard__status" role="status">
          {saveState.t === 'saving' ? 'Saving…' : saveState.t === 'saved' ? 'Note saved.' : ''}
        </p>
      </div>
      {saveState.t === 'error' ? (
        <InlineNotice tone="error" title="Not saved">
          {saveState.message}
        </InlineNotice>
      ) : null}

      <div className="sv-hlcard__actions">
        <IconButton
          icon={LocateFixed}
          label="Go to highlight"
          size="sm"
          tipSide="top"
          onClick={() => actions.goTo(view.id)}
          data-testid="pdf-card-goto"
        />
        {/* A file from this device has no address to go back to: the link is offered for web PDFs. */}
        {href ? (
          <a
            className="sv-ibtn sv-ibtn--sm"
            href={`${href}#page=${pageNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open page in source"
            title="Open page in source"
          >
            <ExternalLink aria-hidden="true" strokeWidth={2.4} />
          </a>
        ) : null}
        <span className="sv-grow" />
        <IconButton
          icon={Trash2}
          label="Delete"
          size="sm"
          tipSide="top"
          className="sv-ibtn--danger"
          onClick={() => {
            actions.remove(view.id).catch((err: unknown) =>
              setSaveState({
                t: 'error',
                message: errorMessage(err, 'The highlight could not be deleted.'),
              }),
            );
          }}
        />
      </div>
    </article>
  );
}
