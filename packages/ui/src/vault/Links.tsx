import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SearchOptions, SearchResult } from '@search';
import { MAX_RELATION_NOTE_CHARS, RELATION_TYPES, type Relation, type RelationType } from '@shared';
import {
  createRelation,
  deleteRelation,
  findKnowledgePoints,
  listLinks,
  restoreRelation,
  updateRelationNote,
  type CreateRelationStatus,
  type LinkEnd,
  type LinkEntry,
  type RelationInput,
  type RelationRef,
} from '@storage';
import { Button } from '../Button';
import { useAction, useAsync, useObserved } from '../hooks';
import { InlineNotice } from '../Notice';
import { errorMessage, plural, truncate } from '../text';
import { useToast } from '../Toast';
import { KIND_NAME, TYPE_MEANING, TYPE_NAME, phrase } from './linkLabels';
import type { SearchHostState } from './searchHost';

/**
 * The Links section of a highlight (dashboard preview and side-panel card): what this item is linked
 * to and from, with the other end's text, and the controls to add, retype, annotate and remove
 * links. Collapsed until asked. Links are the person's own, stored apart from what the items say
 * (ADR-011, ADR-018).
 */

/** What the section reads and writes; `storageLinks` is the real one. */
export interface LinksPort {
  list(ref: RelationRef): Promise<LinkEntry[]>;
  create(input: RelationInput): Promise<{ relation: Relation; status: CreateRelationStatus }>;
  remove(id: string): Promise<void>;
  restore(id: string): Promise<unknown>;
  setNote(id: string, note: string): Promise<unknown>;
  /** Knowledge points whose text holds `query`; they are not in the search index. */
  knowledgePoints(query: string): Promise<LinkEnd[]>;
}

export const storageLinks: LinksPort = {
  list: listLinks,
  create: createRelation,
  remove: deleteRelation,
  restore: restoreRelation,
  setNote: (id, note) => updateRelationNote(id, note),
  knowledgePoints: (query) => findKnowledgePoints(query),
};

/** The search index the picker asks (the same one Related uses); the surface starts and owns it. */
export interface LinkSearchPort {
  state: SearchHostState;
  /** Changes whenever the indexed content changed. */
  revision: number;
  /** The picker was opened: start the index if this surface keeps it stopped until needed. */
  request?(): void;
  search(query: string, options?: SearchOptions): SearchResult;
}

export interface LinksProps {
  /** The item whose links are listed. */
  item: RelationRef;
  port: LinksPort;
  search: LinkSearchPort;
  /** Show the highlight of a linked item; a rejected promise is reported next to the link. */
  onOpen(highlightId: string): void | Promise<void>;
  /** Show this item in the graph; the button is left out without it. */
  onShowGraph?(item: RelationRef): void;
  /** Read (and count) the links before the section is opened. */
  eager?: boolean;
  openLabel?: string;
}

const NOTE_ROWS = 2;
const TEXT_CHARS = 200;
const PICK_LIMIT = 8;
const isUsable = (s: SearchHostState): boolean => s.phase === 'ready' || s.phase === 'updating';

const sameEnd = (a: RelationRef, b: RelationRef) => a.kind === b.kind && a.id === b.id;

function placeOf(end: LinkEnd): string {
  return [end.sourceTitle, end.host].filter((x) => x !== '').join(' · ');
}

export function LinksSection({
  item,
  port,
  search,
  onOpen,
  onShowGraph,
  eager = false,
  openLabel = 'Open',
}: LinksProps) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const enabled = eager || open;
  const links = useObserved(
    () => (enabled ? port.list(item) : Promise.resolve([] as LinkEntry[])),
    [item.kind, item.id, enabled],
  );
  const entries = links.data ?? [];
  const known = enabled && links.data !== undefined;

  return (
    <div className="sv-stack sv-stack--tight" data-testid="links">
      <div>
        <Button
          aria-expanded={open}
          aria-controls={`${uid}-panel`}
          data-testid="links-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide links' : known ? `Show links (${entries.length})` : 'Show links'}
        </Button>
      </div>
      <div id={`${uid}-panel`} hidden={!open} className="sv-stack sv-stack--tight">
        {open ? (
          <>
            {links.error ? (
              <InlineNotice
                tone="error"
                title="Could not read the links"
                action={<Button onClick={links.refresh}>Try again</Button>}
              >
                {links.error}
              </InlineNotice>
            ) : null}
            {known ? (
              <p className="sv-small" role="status" data-testid="links-summary">
                {entries.length === 0
                  ? 'No links yet. Link this to another highlight, note or knowledge point to connect your ideas.'
                  : `${plural(entries.length, 'link')}, in both directions.`}
              </p>
            ) : null}
            {entries.length > 0 ? (
              <ul className="sv-related__list" aria-label="Links">
                {entries.map((entry) => (
                  <LinkRow
                    key={entry.relation.id}
                    entry={entry}
                    port={port}
                    openLabel={openLabel}
                    onOpen={onOpen}
                    refresh={links.refresh}
                  />
                ))}
              </ul>
            ) : null}
            <div ref={actions} className="sv-row">
              <Button
                aria-expanded={adding}
                data-testid="link-add"
                onClick={() => setAdding((v) => !v)}
              >
                {adding ? 'Cancel adding a link' : 'Add link'}
              </Button>
              {onShowGraph ? (
                <Button data-testid="link-graph" onClick={() => onShowGraph(item)}>
                  Show in graph
                </Button>
              ) : null}
            </div>
            {adding ? (
              <LinkPicker
                item={item}
                entries={entries}
                port={port}
                search={search}
                onDone={() => {
                  setAdding(false);
                  links.refresh();
                  // The picker is gone: focus goes back to the control that opened it.
                  actions.current?.querySelector('button')?.focus();
                }}
                onCancel={() => setAdding(false)}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One link
// ---------------------------------------------------------------------------------------------

function LinkRow({
  entry,
  port,
  openLabel,
  onOpen,
  refresh,
}: {
  entry: LinkEntry;
  port: LinksPort;
  openLabel: string;
  onOpen: LinksProps['onOpen'];
  refresh(): void;
}) {
  const uid = useId();
  const toast = useToast();
  const { relation, direction, other } = entry;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(relation.note ?? '');
  const snippet = truncate(other.text, TEXT_CHARS);
  const stands = phrase(relation.type, direction);
  const opened = other.highlightId;

  const open = useAction(async () => {
    if (opened !== null) await onOpen(opened);
  });

  const retype = useAction(async (type: RelationType) => {
    if (type === relation.type) return;
    const made = await port.create({
      fromKind: relation.fromKind,
      fromId: relation.fromId,
      toKind: relation.toKind,
      toId: relation.toId,
      type,
      ...(relation.note ? { note: relation.note } : {}),
    });
    if (made.status === 'existing') {
      throw new Error(`These two items are already linked as ${TYPE_NAME[type]}.`);
    }
    await port.remove(relation.id);
    refresh();
    toast.push({
      message: `Changed the link to ${TYPE_NAME[type]}.`,
      action: {
        label: 'Undo',
        onClick: () => {
          void (async () => {
            await port.remove(made.relation.id);
            await port.restore(relation.id);
            refresh();
          })().catch((err: unknown) =>
            toast.push({ tone: 'error', message: errorMessage(err, 'Could not undo the change.') }),
          );
        },
      },
    });
  });

  const remove = useAction(async () => {
    await port.remove(relation.id);
    refresh();
    toast.push({
      message: 'Removed the link.',
      // The Remove button is gone with the row: Undo takes the keyboard focus.
      focusAction: true,
      action: {
        label: 'Undo',
        onClick: () => {
          void port.restore(relation.id).then(refresh, (err: unknown) =>
            toast.push({
              tone: 'error',
              message: errorMessage(err, 'Could not bring the link back.'),
            }),
          );
        },
      },
    });
  });

  const saveNote = useAction(async () => {
    await port.setNote(relation.id, draft);
    setEditing(false);
    refresh();
    toast.announce('Note on the link saved.');
  });

  const failure = open.error ?? retype.error ?? remove.error;
  return (
    <li
      className="sv-related__item"
      data-testid="link-item"
      data-relation-id={relation.id}
      data-type={relation.type}
      data-direction={direction}
      data-other-kind={other.kind}
      data-other-id={other.id}
    >
      <p className="sv-row">
        <span className="sv-badge sv-badge--info">
          <span aria-hidden="true">{direction === 'out' ? '→' : '←'}</span>
          <span data-testid="link-phrase">{stands}</span>
        </span>
        <span className="sv-badge">{KIND_NAME[other.kind]}</span>
      </p>
      <p className="sv-wrap" dir="auto" data-testid="link-text">
        {snippet}
      </p>
      {placeOf(other) !== '' ? (
        <p className="sv-small sv-muted sv-wrap" dir="auto">
          {placeOf(other)}
        </p>
      ) : null}
      {relation.note && !editing ? (
        <p className="sv-small sv-wrap" dir="auto" data-testid="link-note">
          <span className="sv-muted">Your note on this link: </span>
          {relation.note}
        </p>
      ) : null}
      {editing ? (
        <form
          className="sv-field"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saveNote.busy) void saveNote.run();
          }}
        >
          <label className="sv-label" htmlFor={`${uid}-note`}>
            Note on this link
          </label>
          <textarea
            id={`${uid}-note`}
            className="sv-control"
            rows={NOTE_ROWS}
            maxLength={MAX_RELATION_NOTE_CHARS}
            dir="auto"
            value={draft}
            data-testid="link-note-input"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="sv-row">
            <Button
              type="submit"
              variant="primary"
              busy={saveNote.busy}
              data-testid="link-note-save"
            >
              Save note
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                setDraft(relation.note ?? '');
              }}
            >
              Cancel
            </Button>
          </div>
          {saveNote.error ? (
            <InlineNotice tone="error" title="The note was not saved">
              {saveNote.error}
            </InlineNotice>
          ) : null}
        </form>
      ) : null}
      <div className="sv-row">
        <Button
          busy={open.busy}
          aria-label={`${openLabel}: ${truncate(other.text, 60)}`}
          data-testid="link-open"
          disabledReason={
            opened === null
              ? 'This note is not attached to a highlight, so there is nothing to show.'
              : undefined
          }
          onClick={() => void open.run()}
        >
          {openLabel}
        </Button>
        <label className="sv-sr" htmlFor={`${uid}-type`}>
          Type of link to {truncate(other.text, 60)}
        </label>
        <select
          id={`${uid}-type`}
          className="sv-control sv-links__type"
          value={relation.type}
          disabled={retype.busy}
          data-testid="link-type"
          onChange={(e) => void retype.run(e.target.value as RelationType)}
        >
          {RELATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_NAME[t]}
            </option>
          ))}
        </select>
        <Button
          aria-label={`${relation.note ? 'Edit' : 'Add'} the note on the link to ${truncate(other.text, 60)}`}
          aria-expanded={editing}
          data-testid="link-note-edit"
          onClick={() => {
            setDraft(relation.note ?? '');
            setEditing((v) => !v);
          }}
        >
          {relation.note ? 'Edit note' : 'Add note'}
        </Button>
        <Button
          variant="danger"
          busy={remove.busy}
          aria-label={`Remove the link to ${truncate(other.text, 60)}`}
          data-testid="link-remove"
          onClick={() => void remove.run()}
        >
          Remove
        </Button>
      </div>
      {failure ? (
        <InlineNotice tone="error" title="That did not work">
          {failure}
        </InlineNotice>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Adding a link
// ---------------------------------------------------------------------------------------------

type Where = 'index' | 'points';

function waiting(state: SearchHostState): string | null {
  switch (state.phase) {
    case 'idle':
    case 'restoring':
      return 'Opening the search index…';
    case 'building':
      return `Building the search index: ${state.done.toLocaleString()}${
        state.total ? ` of ${state.total.toLocaleString()}` : ' so far'
      }. Results appear when it finishes.`;
    case 'error':
      return `Search is unavailable: ${state.message}`;
    default:
      return null;
  }
}

function LinkPicker({
  item,
  entries,
  port,
  search,
  onDone,
  onCancel,
}: {
  item: RelationRef;
  entries: LinkEntry[];
  port: LinksPort;
  search: LinkSearchPort;
  onDone(): void;
  onCancel(): void;
}) {
  const uid = useId();
  const toast = useToast();
  const [where, setWhere] = useState<Where>('index');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<LinkEnd | null>(null);
  const [type, setType] = useState<RelationType>('related');
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    search.request?.();
    input.current?.focus();
    // once, when the picker opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usable = isUsable(search.state);
  const wait = where === 'index' ? waiting(search.state) : null;
  const text = query.trim();

  const found = useMemo((): { ends: LinkEnd[] } | { error: string } | null => {
    if (where !== 'index' || !usable || text === '') return null;
    try {
      const { hits } = search.search(text, {
        limit: PICK_LIMIT,
        facets: false,
        suggest: false,
      });
      return {
        ends: hits.map(({ doc }) => ({
          kind: doc.docType,
          id: doc.id,
          text: (doc.docType === 'note' ? doc.comment : doc.quote).replace(/\s+/g, ' ').trim(),
          sourceTitle: doc.title,
          host: doc.host ?? '',
          highlightId: doc.highlightId ?? (doc.docType === 'highlight' ? doc.id : null),
        })),
      };
    } catch (err) {
      return { error: errorMessage(err, 'Search failed.') };
    }
    // `revision` stands for "the indexed content changed".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where, usable, text, search.revision, search.search]);

  const points = useAsync(
    () => (where === 'points' ? port.knowledgePoints(text) : Promise.resolve([] as LinkEnd[])),
    [where, text],
  );

  const candidates: LinkEnd[] =
    where === 'points' ? (points.data ?? []) : found && 'ends' in found ? found.ends : [];
  const searched =
    where === 'points' ? points.data !== undefined : found !== null && 'ends' in found;

  // What each candidate is already linked as (any direction), for the person's information.
  const linkedAs = (end: RelationRef): RelationType[] =>
    entries.filter((e) => sameEnd(e.other, end)).map((e) => e.relation.type);

  const duplicate =
    chosen !== null &&
    entries.some(
      (e) =>
        sameEnd(e.other, chosen) &&
        e.relation.type === type &&
        (type === 'related' || e.direction === direction),
    );
  const reason =
    chosen === null
      ? 'Choose the item to link to first.'
      : duplicate
        ? `Already linked as ${TYPE_NAME[type]}. Choose another type or another item.`
        : undefined;

  const add = useAction(async () => {
    if (chosen === null) return;
    const out = direction === 'out' || type === 'related';
    const made = await port.create({
      fromKind: out ? item.kind : chosen.kind,
      fromId: out ? item.id : chosen.id,
      toKind: out ? chosen.kind : item.kind,
      toId: out ? chosen.id : item.id,
      type,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    if (made.status === 'existing') {
      throw new Error(`These two items are already linked as ${TYPE_NAME[type]}.`);
    }
    toast.push({
      message: `Linked as ${TYPE_NAME[type]}.`,
      action: {
        label: 'Undo',
        onClick: () => {
          void port
            .remove(made.relation.id)
            .catch((err: unknown) =>
              toast.push({ tone: 'error', message: errorMessage(err, 'Could not undo the link.') }),
            );
        },
      },
    });
    onDone();
  });

  const pick = (end: LinkEnd) => {
    setChosen(end);
    add.clear();
  };

  return (
    <form
      className="sv-related__item"
      aria-label="Add a link"
      data-testid="link-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason === undefined && !add.busy) void add.run();
      }}
    >
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-where`}>
          Link to a
        </label>
        <select
          id={`${uid}-where`}
          className="sv-control"
          value={where}
          data-testid="link-where"
          onChange={(e) => {
            setWhere(e.target.value as Where);
            setChosen(null);
          }}
        >
          <option value="index">Highlight or note</option>
          <option value="points">Knowledge point</option>
        </select>
      </div>
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-q`}>
          {where === 'index' ? 'Search your highlights and notes' : 'Search your knowledge points'}
        </label>
        <input
          ref={input}
          id={`${uid}-q`}
          className="sv-control"
          type="search"
          value={query}
          maxLength={200}
          autoComplete="off"
          dir="auto"
          data-testid="link-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter in the search box searches; it must not submit the form.
            if (e.key === 'Enter') e.preventDefault();
          }}
        />
      </div>
      {wait ? (
        <InlineNotice tone={search.state.phase === 'error' ? 'error' : 'info'} live>
          {wait}
        </InlineNotice>
      ) : null}
      {found && 'error' in found ? (
        <InlineNotice tone="error" title="Could not search">
          {found.error}
        </InlineNotice>
      ) : null}
      {points.error && where === 'points' ? (
        <InlineNotice tone="error" title="Could not read knowledge points">
          {points.error}
        </InlineNotice>
      ) : null}
      <p className="sv-small sv-muted" role="status" data-testid="link-results-summary">
        {where === 'index' && text === ''
          ? 'Type a word or phrase to find the item.'
          : !searched
            ? ''
            : candidates.length === 0
              ? 'Nothing matches. Try other words.'
              : `${plural(candidates.length, 'match', 'matches')}. Choose one.`}
      </p>
      {candidates.length > 0 ? (
        <fieldset className="sv-stack sv-stack--tight" data-testid="link-candidates">
          <legend className="sv-sr">Items to link to</legend>
          {candidates.map((end) => {
            const self = sameEnd(end, item);
            const already = linkedAs(end);
            return (
              <label
                key={`${end.kind}:${end.id}`}
                className="sv-check"
                data-testid="link-candidate"
                data-kind={end.kind}
                data-id={end.id}
              >
                <input
                  type="radio"
                  name={`${uid}-pick`}
                  checked={chosen !== null && sameEnd(chosen, end)}
                  disabled={self}
                  onChange={() => pick(end)}
                />
                <span className="sv-wrap" dir="auto">
                  <span className="sv-badge">{KIND_NAME[end.kind]}</span>{' '}
                  {truncate(end.text || 'Empty', TEXT_CHARS)}
                  {where === 'index' && end.sourceTitle !== '' ? (
                    <span className="sv-small sv-muted"> · {end.sourceTitle}</span>
                  ) : null}
                  {self ? (
                    <span className="sv-small"> (this is the item you are linking from)</span>
                  ) : already.length > 0 ? (
                    <span className="sv-small sv-muted">
                      {' '}
                      (already linked: {[...new Set(already)].map((t) => TYPE_NAME[t]).join(', ')})
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <div className="sv-row">
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-type`}>
            Type of link
          </label>
          <select
            id={`${uid}-type`}
            className="sv-control"
            value={type}
            data-testid="link-new-type"
            onChange={(e) => setType(e.target.value as RelationType)}
          >
            {RELATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_NAME[t]}
              </option>
            ))}
          </select>
        </div>
        {type !== 'related' ? (
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${uid}-dir`}>
              Direction
            </label>
            <select
              id={`${uid}-dir`}
              className="sv-control"
              value={direction}
              data-testid="link-new-direction"
              onChange={(e) => setDirection(e.target.value as 'out' | 'in')}
            >
              <option value="out">This item → the chosen item</option>
              <option value="in">The chosen item → this item</option>
            </select>
          </div>
        ) : null}
      </div>
      <p className="sv-small sv-muted">{TYPE_MEANING[type]}</p>
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-note`}>
          Note on the link (optional)
        </label>
        <textarea
          id={`${uid}-note`}
          className="sv-control"
          rows={NOTE_ROWS}
          maxLength={MAX_RELATION_NOTE_CHARS}
          dir="auto"
          value={note}
          data-testid="link-new-note"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {add.error ? (
        <InlineNotice tone="error" title="The link was not added">
          {add.error}
        </InlineNotice>
      ) : null}
      {reason && chosen !== null ? (
        <p className="sv-small" data-testid="link-reason">
          {reason}
        </p>
      ) : null}
      <div className="sv-row">
        <Button
          type="submit"
          variant="primary"
          busy={add.busy}
          disabledReason={reason}
          data-testid="link-submit"
        >
          Add link
        </Button>
        <Button onClick={onCancel} data-testid="link-cancel">
          Cancel
        </Button>
      </div>
    </form>
  );
}
