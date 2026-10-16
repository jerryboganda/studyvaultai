import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Ellipsis,
  ExternalLink,
  House,
  Inbox,
  Layers,
  ListTree,
  LocateFixed,
  NotebookPen,
  NotebookText,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_COMMENT_CHARS,
  isPlaceholderSourceUrl,
  type BankLite,
  type ColorId,
  type FilingSuggestion,
  type HighlightKind,
  type HighlightPatch,
  type ResolveStatus,
} from '@shared';
import type { HighlightDetail, HighlightListItem, RelationRef } from '@storage';
import {
  Badge,
  Button,
  InfoTip,
  InlineNotice,
  KindChip,
  describeResolveState,
  errorMessage,
  isRetryable,
  truncate,
  useAction,
  useLatest,
  useToast,
} from '@ui';
import {
  LinksSection,
  RelatedSection,
  type LinkSearchPort,
  type LinksPort,
  type RelatedPort,
} from '@ui/vault';
import { CardNotes } from './CardNotes';
import { CardTags } from './CardTags';
import { FilingChip } from './FilingChip';
import { IconAction } from './IconAction';
import { extensionPageUrl, optionsUrl } from './links';
import type { RevealAvailability } from './model';
import { REVEAL_NOT_FOUND, sourceLinkFor } from './model';
import { useCardMemory } from './useCardMemory';

export const COMMENT_DEBOUNCE_MS = 600;
// About four lines in a 320 px panel; the rest is one "Show full quote" away.
const QUOTE_PREVIEW_CHARS = 180;

// The AI engine and its screens are fetched when a card's AI drafts are opened, not with the panel.
const HighlightAiActions = lazy(() =>
  import('@ui/ai').then((m) => ({ default: m.HighlightAiActions })),
);

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
  /** File / dismiss a filing rule's pending suggestion (docs/adr/017-filing-rules.md). */
  fileSuggestion?(highlightId: string): Promise<void>;
  dismissSuggestion?(highlightId: string): Promise<void>;
}

/** What is the same for every card of a list. */
export interface CardContext {
  /** Settings.features.review: flashcards can be made. */
  reviewOn: boolean;
  /** Settings.features.ai; null until settings are read. */
  aiOn: boolean | null;
  /** id of the panel's shared tag <datalist>. */
  tagListId: string;
  /** Pending filing suggestions by highlight id; a card shows its own until filed or dismissed. */
  suggestions?: ReadonlyMap<string, FilingSuggestion>;
  /** The search index behind each card's Related section; the section is left out without it. */
  related?: RelatedPort;
  /** The links of each card; the section is left out without it. */
  links?: {
    port: LinksPort;
    search: LinkSearchPort;
    /** Open the dashboard's graph around an item. */
    onShowGraph(item: RelationRef): void;
  };
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

const FLASHCARD_OFF = 'Review is turned off in Settings, so flashcards cannot be made.';

/**
 * One highlight (UX_DESIGN 6.18): a colour strip, kind, quote, the quick note (always one tap
 * away: it is the page overlay's hand-over target), bank and tag chips, and three actions. The
 * editors (kind, priority, tags, study notes, links, related, AI, delete) sit behind "More actions".
 */
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
  const { announce, push } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useCardMemory(`${highlight.id}:open`, false);
  const [aiOpen, setAiOpen] = useState(false);
  const [revealNote, setRevealNote] = useState<{ ok: boolean; text: string } | null>(null);
  const state = describeResolveState(highlight.resolveStatus);
  const suggestion = context.suggestions?.get(highlight.id);

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
  const tags = detail?.tags ?? [];
  const noteCount = detail?.notes.length ?? 0;
  const drawerId = `${uid}-more`;

  return (
    <article
      className={`hl-card sp-sw--${highlight.color}`}
      data-highlight-id={highlight.id}
      aria-label={`${KIND_LABELS[highlight.kind].label}: ${truncate(quote, 60)}`}
    >
      <div className="hl-card__top">
        <KindChip kind={highlight.kind} color={highlight.color} />
        {highlight.resolveStatus === 'resolved' ? null : (
          <span className="hl-card__state">
            <StatusBadge status={highlight.resolveStatus} />
            {state.attention && state.explanation ? (
              <InfoTip label="Why it needs a look" align="end">
                {state.explanation}
              </InfoTip>
            ) : null}
          </span>
        )}
      </div>

      <blockquote className="hl-card__quote" dir="auto">
        {long && !expanded ? truncate(quote, QUOTE_PREVIEW_CHARS) : quote}
      </blockquote>
      {long ? (
        <div>
          <button
            type="button"
            className="sp-link"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : 'Show full quote'}
          </button>
        </div>
      ) : null}

      {showSource ? (
        <p className="hl-card__meta sv-wrap" dir="auto">
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
        <p className="hl-card__meta sv-wrap" dir="auto">
          <ListTree aria-hidden="true" strokeWidth={2.4} />
          Under: {highlight.headingContext}
        </p>
      ) : null}

      <CommentField
        id={`${uid}-note`}
        value={highlight.userComment}
        onSave={(text) => actions.update(highlight.id, { userComment: text })}
      />

      <ul className="hl-chips" aria-label="Banks and tags">
        {banks.length === 0 ? (
          <li className="hl-chip hl-chip--none">No bank</li>
        ) : (
          banks.map((b) => <BankChip key={b.id} bank={b} />)
        )}
        {open
          ? null
          : tags.map((t) => (
              <li key={t.id} className="hl-tag" dir="auto">
                <span aria-hidden="true">#</span>
                <span>{t.name}</span>
              </li>
            ))}
        {noteCount > 0 && !open ? (
          <li className="hl-chip">
            <NotebookText aria-hidden="true" strokeWidth={2.4} />
            {noteCount}
            <span className="sv-sr"> {noteCount === 1 ? 'study note' : 'study notes'}</span>
          </li>
        ) : null}
      </ul>

      {suggestion && actions.fileSuggestion && actions.dismissSuggestion ? (
        <FilingChip
          suggestion={suggestion}
          onFile={() => actions.fileSuggestion!(highlight.id)}
          onDismiss={() => actions.dismissSuggestion!(highlight.id)}
        />
      ) : null}

      <div className="hl-card__actions">
        <IconAction
          icon={Layers}
          label="Make flashcard"
          busy={act.busy}
          data-testid="card-flashcard"
          disabledReason={context.reviewOn ? undefined : FLASHCARD_OFF}
          onClick={() => void act.run({ t: 'flashcard' })}
        />
        <IconAction
          icon={LocateFixed}
          label="Show on page"
          busy={act.busy}
          disabledReason={reveal.enabled ? undefined : reveal.reason}
          onClick={() => void act.run({ t: 'reveal' })}
        />
        <IconAction
          icon={House}
          label="Open in dashboard"
          busy={act.busy}
          data-testid="card-dashboard"
          onClick={() => void act.run({ t: 'dashboard' })}
        />
        <span className="hl-card__spacer" />
        <IconAction
          icon={Ellipsis}
          label="More actions"
          tipSide="left"
          aria-expanded={open}
          aria-controls={drawerId}
          data-testid="card-more"
          className={open ? 'is-open' : undefined}
          onClick={() => setOpen(!open)}
        />
      </div>

      {revealNote ? (
        <InlineNotice tone={revealNote.ok ? 'success' : 'warning'}>{revealNote.text}</InlineNotice>
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

      {open ? (
        <div id={drawerId} className="hl-drawer" data-testid="card-drawer">
          <KindPicker
            value={highlight.kind}
            paletteFor={paletteFor}
            onChange={(kind) => void act.run({ t: 'kind', kind })}
          />
          <PriorityPicker
            value={highlight.priority}
            onChange={(priority) => void act.run({ t: 'priority', priority })}
          />
          <CardTags
            highlightId={highlight.id}
            tags={detail === undefined ? undefined : (detail?.tags ?? null)}
            listId={context.tagListId}
            onAdd={actions.addTag}
            onRemove={actions.removeTag}
          />
          <CardNotes
            highlightId={highlight.id}
            sourceId={highlight.sourceId}
            notes={detail === undefined ? undefined : (detail?.notes ?? null)}
            onSave={actions.saveNote}
          />
          {context.links ? (
            <LinksSection
              item={{ kind: 'highlight', id: highlight.id }}
              port={context.links.port}
              search={context.links.search}
              openLabel="Open in dashboard"
              onOpen={(id) => actions.openDashboard(id)}
              onShowGraph={context.links.onShowGraph}
            />
          ) : null}
          {context.related ? (
            <RelatedSection
              id={highlight.id}
              port={context.related}
              openLabel="Open in dashboard"
              onOpen={(id) => actions.openDashboard(id)}
              onLink={
                context.links
                  ? async (otherId) => {
                      const links = context.links!.port;
                      const made = await links.create({
                        fromKind: 'highlight',
                        fromId: highlight.id,
                        toKind: 'highlight',
                        toId: otherId,
                        type: 'related',
                      });
                      push({
                        message:
                          made.status === 'existing'
                            ? 'These are already linked.'
                            : 'Linked as Related.',
                        action:
                          made.status === 'existing'
                            ? undefined
                            : {
                                label: 'Undo',
                                onClick: () => {
                                  void links.remove(made.relation.id).catch(() => undefined);
                                },
                              },
                      });
                    }
                  : undefined
              }
            />
          ) : null}
          {context.aiOn === true ? (
            <div className="sv-stack sv-stack--tight">
              <div>
                <Button
                  aria-expanded={aiOpen}
                  data-testid="card-ai-toggle"
                  onClick={() => setAiOpen((v) => !v)}
                >
                  <Sparkles aria-hidden="true" className="sp-btnicon" strokeWidth={2.4} />
                  AI drafts
                </Button>
              </div>
              {aiOpen ? (
                <Suspense fallback={<p className="sv-small sv-muted">Loading the AI actions…</p>}>
                  <HighlightAiActions
                    highlights={[{ id: highlight.id, exactQuote: highlight.exactQuote }]}
                    onOpenSettings={() => void browser.tabs.create({ url: optionsUrl('ai') })}
                  />
                </Suspense>
              ) : null}
            </div>
          ) : context.aiOn === false ? (
            <p className="hl-ai-off" data-testid="card-ai-hint">
              <Sparkles aria-hidden="true" strokeWidth={2.4} />
              <span>AI drafts are off.</span>
              <a href={optionsUrl('ai')} target="_blank" rel="noopener noreferrer">
                Turn on <span className="sv-sr">AI drafts in Options</span>
                <ExternalLink aria-hidden="true" strokeWidth={2.4} />
              </a>
              <InfoTip label="About AI drafts" side="top" align="end">
                While AI is off, nothing is sent anywhere.
              </InfoTip>
            </p>
          ) : null}
          <div className="hl-drawer__foot">
            <Button variant="danger" busy={act.busy} onClick={() => void act.run({ t: 'delete' })}>
              <Trash2 aria-hidden="true" className="sp-btnicon" strokeWidth={2.4} />
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * How the quote was last found on its page, in plain words (UX_DESIGN 6.18 "Not found", 8 no
 * jargon). The full explanation stays behind the card's (i).
 */
const SHORT_STATUS: Partial<Record<ResolveStatus, string>> = {
  ambiguous: 'Many matches',
  orphaned: 'Not found',
};

export function StatusBadge({ status }: { status: ResolveStatus }) {
  const d = describeResolveState(status);
  return (
    <Badge tone={d.tone} glyph={d.glyph}>
      {SHORT_STATUS[status] ?? d.label}
    </Badge>
  );
}

function BankChip({ bank }: { bank: BankLite }) {
  return (
    <li className={`hl-chip sp-sw--${bank.color}`} dir="auto">
      {bank.isInbox ? (
        <Inbox aria-hidden="true" strokeWidth={2.4} />
      ) : (
        <span className="hl-chip__dot" aria-hidden="true" />
      )}
      {bank.name}
    </li>
  );
}

/** The seven kinds as dots in the user's palette, each with its glyph and name (UX_DESIGN 6.19). */
function KindPicker({
  value,
  paletteFor,
  onChange,
}: {
  value: HighlightKind;
  paletteFor(kind: HighlightKind): ColorId;
  onChange(kind: HighlightKind): void;
}) {
  const name = useId();
  return (
    <fieldset className="hl-pick">
      <legend className="hl-pick__legend">
        Kind <span className="hl-pick__value">{KIND_LABELS[value].label}</span>
      </legend>
      <div className="hl-kinds">
        {HIGHLIGHT_KINDS.map((k) => (
          <label key={k} className={`hl-kind sp-sw--${paletteFor(k)}`} title={KIND_LABELS[k].label}>
            <input
              type="radio"
              className="hl-pick__input"
              name={name}
              value={k}
              checked={value === k}
              onChange={() => onChange(k)}
            />
            <span className="hl-kind__dot" aria-hidden="true">
              {KIND_LABELS[k].glyph}
            </span>
            <span className="sv-sr">{KIND_LABELS[k].label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const PRIORITIES = [1, 2, 3, 4, 5] as const;

function PriorityPicker({ value, onChange }: { value: number; onChange(p: number): void }) {
  const name = useId();
  return (
    <fieldset className="hl-pick">
      <legend className="hl-pick__legend">Priority</legend>
      <div className="hl-seg">
        {PRIORITIES.map((p) => (
          <label key={p} className="hl-seg__opt">
            <input
              type="radio"
              className="hl-pick__input"
              name={name}
              value={p}
              checked={value === p}
              onChange={() => onChange(p)}
            />
            <span aria-hidden="true">{p}</span>
            <span className="sv-sr">{p === 1 ? '1 (lowest)' : p === 5 ? '5 (highest)' : p}</span>
          </label>
        ))}
      </div>
    </fieldset>
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
    <div className="hl-note">
      <label className="hl-note__label" htmlFor={id}>
        <NotebookPen aria-hidden="true" strokeWidth={2.4} />
        <span className="sv-sr">Your note</span>
      </label>
      <textarea
        id={id}
        className="hl-note__input"
        rows={1}
        maxLength={MAX_COMMENT_CHARS}
        value={draft}
        placeholder="Quick note"
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
      <div id={`${id}-status`} className="hl-note__status">
        {status.kind === 'saving' ? <span>Saving…</span> : null}
        {status.kind === 'saved' ? <span>Saved</span> : null}
        {status.kind === 'error' ? (
          <span role="alert" className="hl-note__error">
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
