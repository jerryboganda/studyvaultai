import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_COMMENT_CHARS,
  isPlaceholderSourceUrl,
  type ColorId,
  type HighlightKind,
  type HighlightPatch,
} from '@shared';
import type { HighlightDetail, HighlightListItem } from '@storage';
import {
  Badge,
  Button,
  InlineNotice,
  KindChip,
  ResolveBadge,
  describeResolveState,
  errorMessage,
  isRetryable,
  truncate,
  useAction,
  useLatest,
  useToast,
} from '@ui';
import { HighlightAiActions } from '@ui/ai';
import { CardNotes } from './CardNotes';
import { CardTags } from './CardTags';
import { extensionPageUrl, optionsUrl } from './links';
import type { RevealAvailability } from './model';
import { REVEAL_NOT_FOUND, sourceLinkFor } from './model';

export const COMMENT_DEBOUNCE_MS = 600;
const QUOTE_PREVIEW_CHARS = 280;

export interface CardActions {
  update(id: string, patch: HighlightPatch): Promise<void>;
  remove(id: string): Promise<void>;
  reveal(id: string): Promise<{ found: boolean }>;
  /** Open the dashboard on this highlight (extension page; reuses an open dashboard tab). */
  openDashboard(id: string): Promise<void>;
  /** Open the review page's card author on this highlight. */
  makeFlashcard(id: string): Promise<void>;
  addTag(highlightId: string, name: string): Promise<void>;
  removeTag(highlightId: string, tagId: string): Promise<void>;
  saveNote(input: {
    highlightId: string;
    sourceId: string;
    noteId: string | null;
    body: string;
  }): Promise<void>;
}

/** What is the same for every card of a list. */
export interface CardContext {
  /** Settings.features.review: flashcards can be made. */
  reviewOn: boolean;
  /** Settings.features.ai; null until settings are read. */
  aiOn: boolean | null;
  /** id of the panel's shared tag <datalist>. */
  tagListId: string;
}

/** The part of a highlight's detail the card shows. */
export type CardDetail = Pick<HighlightDetail, 'tags' | 'notes'>;

type Op =
  | { t: 'kind'; kind: HighlightKind }
  | { t: 'priority'; priority: number }
  | { t: 'delete' }
  | { t: 'reveal' }
  | { t: 'dashboard' }
  | { t: 'flashcard' };

export function HighlightCard({
  item,
  detail,
  context,
  showSource,
  paletteFor,
  reveal,
  actions,
}: {
  item: HighlightListItem;
  /** undefined while loading; null when the details could not be read. */
  detail: CardDetail | null | undefined;
  context: CardContext;
  /** Recent list: show which page the highlight came from. */
  showSource: boolean;
  paletteFor(kind: HighlightKind): ColorId;
  reveal: RevealAvailability;
  actions: CardActions;
}) {
  const { highlight, source, banks } = item;
  const uid = useId();
  const { announce } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [revealNote, setRevealNote] = useState<{ ok: boolean; text: string } | null>(null);
  const state = describeResolveState(highlight.resolveStatus);

  const act = useAction(async (op: Op) => {
    setRevealNote(null);
    switch (op.t) {
      case 'kind':
        // The colour follows the kind so the page paint keeps meaning what the label says.
        await actions.update(highlight.id, { kind: op.kind, color: paletteFor(op.kind) });
        break;
      case 'priority':
        await actions.update(highlight.id, { priority: op.priority });
        break;
      case 'delete':
        await actions.remove(highlight.id);
        break;
      case 'reveal': {
        const { found } = await actions.reveal(highlight.id);
        const text = found ? 'Showing this highlight on the page.' : REVEAL_NOT_FOUND;
        setRevealNote({ ok: found, text });
        announce(text);
        break;
      }
      case 'dashboard':
        await actions.openDashboard(highlight.id);
        break;
      case 'flashcard':
        await actions.makeFlashcard(highlight.id);
        break;
    }
  });

  const quote = highlight.exactQuote;
  const long = quote.length > QUOTE_PREVIEW_CHARS;
  const link = showSource ? sourceLinkFor(item) : ({ kind: 'none' } as const);
  // Made-up addresses of imported and file PDFs never resolve: show the title, not the address.
  const where = [
    source.title,
    isPlaceholderSourceUrl(source.originalUrl) ? '' : source.host,
  ].filter((x) => x !== '');

  return (
    <article
      className="hl-card"
      data-highlight-id={highlight.id}
      aria-label={`${KIND_LABELS[highlight.kind].label}: ${truncate(quote, 60)}`}
    >
      <div className="sv-row">
        <KindChip kind={highlight.kind} color={highlight.color} />
        <ResolveBadge status={highlight.resolveStatus} />
      </div>

      <div className="sv-stack sv-stack--tight">
        <blockquote className="sv-quote" dir="auto">
          {long && !expanded ? truncate(quote, QUOTE_PREVIEW_CHARS) : quote}
        </blockquote>
        {long ? (
          <div>
            <Button variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show less' : 'Show full quote'}
            </Button>
          </div>
        ) : null}
        {state.attention && state.explanation ? (
          <p className="sv-small sv-muted">{state.explanation}</p>
        ) : null}
      </div>

      {showSource ? (
        <p className="sv-small sv-muted sv-wrap" dir="auto">
          From {where.length > 0 ? where.join(' · ') : 'an imported source'}
          {link.kind === 'web' ? (
            <>
              {' · '}
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                Open page
              </a>
            </>
          ) : link.kind === 'pdf' ? (
            <>
              {' · '}
              <a href={extensionPageUrl(link.path)} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            </>
          ) : null}
        </p>
      ) : highlight.headingContext ? (
        <p className="sv-small sv-muted sv-wrap" dir="auto">
          Under: {highlight.headingContext}
        </p>
      ) : null}

      <div className="sv-row">
        <span className="sv-label">Banks</span>
        {banks.length === 0 ? (
          <span className="sv-muted sv-small">none</span>
        ) : (
          banks.map((b) => (
            <Badge key={b.id}>
              <span dir="auto">{b.name}</span>
            </Badge>
          ))
        )}
      </div>

      <CardTags
        highlightId={highlight.id}
        tags={detail === undefined ? undefined : (detail?.tags ?? null)}
        listId={context.tagListId}
        onAdd={actions.addTag}
        onRemove={actions.removeTag}
      />

      <CommentField
        id={`${uid}-note`}
        value={highlight.userComment}
        onSave={(text) => actions.update(highlight.id, { userComment: text })}
      />

      <div className="hl-fields">
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-kind`}>
            Kind
          </label>
          <select
            id={`${uid}-kind`}
            className="sv-control"
            value={highlight.kind}
            onChange={(e) => void act.run({ t: 'kind', kind: e.target.value as HighlightKind })}
          >
            {HIGHLIGHT_KINDS.map((k) => (
              <option key={k} value={k}>
                {`${KIND_LABELS[k].glyph} ${KIND_LABELS[k].label}`}
              </option>
            ))}
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-priority`}>
            Priority
          </label>
          <select
            id={`${uid}-priority`}
            className="sv-control"
            value={highlight.priority}
            onChange={(e) => void act.run({ t: 'priority', priority: Number(e.target.value) })}
          >
            <option value={1}>1 (lowest)</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={5}>5 (highest)</option>
          </select>
        </div>
      </div>

      <CardNotes
        highlightId={highlight.id}
        sourceId={highlight.sourceId}
        notes={detail === undefined ? undefined : (detail?.notes ?? null)}
        onSave={actions.saveNote}
      />

      <div className="sv-row">
        <Button
          busy={act.busy}
          disabledReason={reveal.enabled ? undefined : reveal.reason}
          onClick={() => void act.run({ t: 'reveal' })}
        >
          Show on page
        </Button>
        <Button
          busy={act.busy}
          data-testid="card-flashcard"
          disabledReason={
            context.reviewOn
              ? undefined
              : 'Review is turned off in Settings, so flashcards cannot be made.'
          }
          onClick={() => void act.run({ t: 'flashcard' })}
        >
          Make flashcard
        </Button>
        <Button
          busy={act.busy}
          data-testid="card-dashboard"
          onClick={() => void act.run({ t: 'dashboard' })}
        >
          Open in dashboard
        </Button>
        <Button variant="danger" busy={act.busy} onClick={() => void act.run({ t: 'delete' })}>
          Delete
        </Button>
      </div>
      {reveal.enabled ? null : (
        // Also exposed to assistive tech through the button's description.
        <p className="sv-small sv-muted" aria-hidden="true">
          {reveal.reason}
        </p>
      )}
      {revealNote ? (
        <InlineNotice tone={revealNote.ok ? 'success' : 'warning'}>{revealNote.text}</InlineNotice>
      ) : null}
      {context.aiOn === true ? (
        <div className="sv-stack sv-stack--tight">
          <div>
            <Button
              aria-expanded={aiOpen}
              data-testid="card-ai-toggle"
              onClick={() => setAiOpen((v) => !v)}
            >
              AI drafts
            </Button>
          </div>
          {aiOpen ? (
            <HighlightAiActions
              highlights={[{ id: highlight.id, exactQuote: highlight.exactQuote }]}
              onOpenSettings={() => void browser.tabs.create({ url: optionsUrl('ai') })}
            />
          ) : null}
        </div>
      ) : context.aiOn === false ? (
        <p className="sv-small sv-muted" data-testid="card-ai-hint">
          AI drafts are off, so nothing is sent anywhere.{' '}
          <a href={optionsUrl('ai')} target="_blank" rel="noopener noreferrer">
            Turn them on in Options
          </a>
          .
        </p>
      ) : null}
      {act.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={act.retryable ? <Button onClick={act.retry}>Retry</Button> : undefined}
        >
          {act.error}
        </InlineNotice>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------

type SaveState =
  { kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string; retryable: boolean };

/**
 * Comment editor with debounced autosave. `value` is what storage holds; `draft` is what the
 * user typed. The note is flushed on blur and on unmount, so leaving the tab never drops text.
 */
function CommentField({
  id,
  value,
  onSave,
}: {
  id: string;
  value: string;
  onSave(text: string): Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value); // last text known to be persisted
  const [seen, setSeen] = useState(value);
  const [status, setStatus] = useState<SaveState>({ kind: 'idle' });
  const { announce } = useToast();
  const inflight = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const save = useLatest(onSave);

  // Storage changed underneath (another view, undo): follow it unless the user has unsaved edits.
  if (value !== seen) {
    setSeen(value);
    if (draft === saved) {
      setDraft(value);
      setSaved(value);
    }
  }

  const send = useCallback(
    async (text: string) => {
      if (inflight.current === text) return;
      inflight.current = text;
      setStatus({ kind: 'saving' });
      try {
        await save.current(text);
        setSaved(text);
        setStatus({ kind: 'saved' });
        announce('Note saved.');
      } catch (err) {
        setStatus({
          kind: 'error',
          message: errorMessage(err, 'Could not save your note.'),
          retryable: isRetryable(err),
        });
      } finally {
        inflight.current = null;
      }
    },
    [save, announce],
  );

  useEffect(() => {
    pending.current = draft === saved ? null : draft;
  });

  useEffect(() => {
    if (draft === saved) return undefined;
    const timer = setTimeout(() => void send(draft), COMMENT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, saved, send]);

  useEffect(
    () => () => {
      const text = pending.current;
      if (text !== null) void save.current(text).catch(() => undefined);
    },
    [save],
  );

  return (
    <div className="sv-field">
      <label className="sv-label" htmlFor={id}>
        Your note
      </label>
      <textarea
        id={id}
        className="sv-control"
        rows={2}
        maxLength={MAX_COMMENT_CHARS}
        value={draft}
        placeholder="Add your own words (optional)"
        dir="auto"
        aria-describedby={`${id}-status`}
        onChange={(e) => {
          setDraft(e.target.value);
          if (status.kind !== 'saving') setStatus({ kind: 'idle' });
        }}
        onBlur={() => {
          if (draft !== saved) void send(draft);
        }}
      />
      {/* Saved/Saving are spoken through the surface's one status region (announce above). */}
      <div id={`${id}-status`} className="sv-small">
        {status.kind === 'saving' ? <span className="sv-muted">Saving…</span> : null}
        {status.kind === 'saved' ? <span className="sv-muted">Saved</span> : null}
        {status.kind === 'error' ? (
          <span role="alert">
            Not saved: {status.message}{' '}
            {status.retryable ? (
              <Button variant="ghost" onClick={() => void send(draft)}>
                Retry
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
