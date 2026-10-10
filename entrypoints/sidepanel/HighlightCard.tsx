import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_COMMENT_CHARS,
  type ColorId,
  type HighlightKind,
  type HighlightPatch,
} from '@shared';
import type { HighlightListItem } from '@storage';
import {
  Badge,
  Button,
  InlineNotice,
  KindChip,
  ResolveBadge,
  describeResolveState,
  errorMessage,
  safeHref,
  truncate,
  useAction,
  useLatest,
} from '@ui';
import type { RevealAvailability } from './model';
import { REVEAL_NOT_FOUND } from './model';

export const COMMENT_DEBOUNCE_MS = 600;
const QUOTE_PREVIEW_CHARS = 280;

export interface CardActions {
  update(id: string, patch: HighlightPatch): Promise<void>;
  remove(id: string): Promise<void>;
  reveal(id: string): Promise<{ found: boolean }>;
}

type Op =
  | { t: 'kind'; kind: HighlightKind }
  | { t: 'priority'; priority: number }
  | { t: 'delete' }
  | { t: 'reveal' };

export function HighlightCard({
  item,
  showSource,
  paletteFor,
  reveal,
  actions,
}: {
  item: HighlightListItem;
  /** Recent list: show which page the highlight came from. */
  showSource: boolean;
  paletteFor(kind: HighlightKind): ColorId;
  reveal: RevealAvailability;
  actions: CardActions;
}) {
  const { highlight, source, banks } = item;
  const uid = useId();
  const [expanded, setExpanded] = useState(false);
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
        setRevealNote(
          found
            ? { ok: true, text: 'Showing this highlight on the page.' }
            : { ok: false, text: REVEAL_NOT_FOUND },
        );
        break;
      }
    }
  });

  const quote = highlight.exactQuote;
  const long = quote.length > QUOTE_PREVIEW_CHARS;
  const href = showSource ? safeHref(source.originalUrl) : undefined;

  return (
    <article
      className="hl-card"
      aria-label={`${KIND_LABELS[highlight.kind].label}: ${truncate(quote, 60)}`}
    >
      <div className="sv-row">
        <KindChip kind={highlight.kind} color={highlight.color} />
        <ResolveBadge status={highlight.resolveStatus} />
      </div>

      <div className="sv-stack sv-stack--tight">
        <blockquote className="sv-quote">
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
        <p className="sv-small sv-muted sv-wrap">
          From {source.title ? `${source.title} · ` : ''}
          {source.host}
          {href ? (
            <>
              {' · '}
              <a href={href} target="_blank" rel="noopener noreferrer">
                Open page
              </a>
            </>
          ) : null}
        </p>
      ) : highlight.headingContext ? (
        <p className="sv-small sv-muted sv-wrap">Under: {highlight.headingContext}</p>
      ) : null}

      <div className="sv-row">
        <span className="sv-label">Banks</span>
        {banks.length === 0 ? (
          <span className="sv-muted sv-small">none</span>
        ) : (
          banks.map((b) => <Badge key={b.id}>{b.name}</Badge>)
        )}
      </div>

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

      <div className="sv-row">
        <Button
          busy={act.busy}
          disabledReason={reveal.enabled ? undefined : reveal.reason}
          onClick={() => void act.run({ t: 'reveal' })}
        >
          Show on page
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
        <InlineNotice tone={revealNote.ok ? 'success' : 'warning'} live>
          {revealNote.text}
        </InlineNotice>
      ) : null}
      {act.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={<Button onClick={act.retry}>Retry</Button>}
        >
          {act.error}
        </InlineNotice>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------

type SaveState = { kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string };

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
      } catch (err) {
        setStatus({ kind: 'error', message: errorMessage(err, 'Could not save your note.') });
      } finally {
        inflight.current = null;
      }
    },
    [save],
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
        aria-describedby={`${id}-status`}
        onChange={(e) => {
          setDraft(e.target.value);
          if (status.kind !== 'saving') setStatus({ kind: 'idle' });
        }}
        onBlur={() => {
          if (draft !== saved) void send(draft);
        }}
      />
      <div id={`${id}-status`} className="sv-small" role="status">
        {status.kind === 'saving' ? <span className="sv-muted">Saving…</span> : null}
        {status.kind === 'saved' ? <span className="sv-muted">Saved</span> : null}
        {status.kind === 'error' ? (
          <span>
            Not saved: {status.message}{' '}
            <Button variant="ghost" onClick={() => void send(draft)}>
              Retry
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
