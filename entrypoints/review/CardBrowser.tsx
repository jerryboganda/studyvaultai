import { useState } from 'react';
import type { Card, Deck } from '@study';
import {
  createDeck,
  deleteCards,
  deleteDeck,
  listCards,
  listDecks,
  rescheduleCard,
  resetCardProgress,
  restoreCards,
  setCardsSuspended,
  updateCard,
  type CardFilter,
  type CardPatch,
} from '@storage';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  InlineNotice,
  errorMessage,
  plural,
  truncate,
  useAction,
  useObserved,
  useToast,
} from '@ui';
import { TID, cardRowId, formatWhen, type StudySettings } from '@ui/review';
import { CardEditForm } from './CardEditForm';

const FILTERS: { id: CardFilter; label: string }[] = [
  { id: 'all', label: 'All cards' },
  { id: 'new', label: 'New' },
  { id: 'learning', label: 'Learning' },
  { id: 'review', label: 'Review' },
  { id: 'due', label: 'Due now' },
  { id: 'suspended', label: 'Suspended' },
  { id: 'buried', label: 'Buried' },
  { id: 'leech', label: 'Leeches' },
  { id: 'deleted', label: 'Deleted' },
];

const STATE_LABEL = {
  new: 'New',
  learning: 'Learning',
  review: 'Review',
  relearning: 'Relearning',
};

/** Find, fix and manage cards and decks. Reachable home of everything a session can suspend. */
export function CardBrowser({ settings }: { settings: StudySettings }) {
  const toast = useToast();
  const [deckId, setDeckId] = useState('');
  const [filter, setFilter] = useState<CardFilter>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [newDeck, setNewDeck] = useState('');
  const [confirmDeck, setConfirmDeck] = useState(false);

  const decks = useObserved(() => listDecks(), []);
  const list = useObserved(
    () =>
      listCards({
        ...(deckId ? { deckId } : {}),
        filter,
        search,
        boundary: {
          timeZone: settings.timeZone,
          rolloverHour: settings.rolloverHour,
        },
        limit: 300,
      }),
    [deckId, filter, search, settings.timeZone, settings.rolloverHour],
  );
  const deckName = new Map((decks.data ?? []).map((d) => [d.id, d.name]));
  const cards: Card[] = list.data?.cards ?? [];
  const selectedDeck: Deck | undefined = (decks.data ?? []).find((d) => d.id === deckId);

  const create = useAction(async () => {
    const deck = await createDeck({ name: newDeck });
    setNewDeck('');
    setDeckId(deck.id);
    toast.push({ message: `Deck “${deck.name}” created.` });
  });

  const removeDeck = useAction(async () => {
    if (!selectedDeck) return;
    const out = await deleteDeck(selectedDeck.id);
    setDeckId('');
    setConfirmDeck(false);
    toast.push({ message: `Deck deleted with ${plural(out.deleted, 'card')}.` });
  });

  const act = useAction(async (fn: () => Promise<string | void>) => {
    const message = await fn();
    if (message) toast.push({ message });
  });

  const undoDelete = async (ids: string[]) => {
    try {
      await restoreCards(ids);
      toast.push({ message: 'Card restored.' });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err) });
    }
  };

  return (
    <div className="sv-stack" data-testid={TID.browser}>
      <section className="rv-toolbar" aria-label="Filters">
        <div className="sv-field">
          <label className="sv-label" htmlFor="rv-bdeck">
            Deck
          </label>
          <select
            id="rv-bdeck"
            className="sv-control"
            data-testid={TID.browserDeck}
            value={deckId}
            onChange={(e) => setDeckId(e.target.value)}
          >
            <option value="">All decks</option>
            {(decks.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor="rv-bfilter">
            Show
          </label>
          <select
            id="rv-bfilter"
            className="sv-control"
            data-testid={TID.browserFilter}
            value={filter}
            onChange={(e) => setFilter(e.target.value as CardFilter)}
          >
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sv-field rv-grow">
          <label className="sv-label" htmlFor="rv-bsearch">
            Search text and tags
          </label>
          <input
            id="rv-bsearch"
            className="sv-control"
            type="search"
            data-testid={TID.browserSearch}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </section>

      <section className="rv-decks-admin sv-stack sv-stack--tight" aria-label="Decks">
        <form
          className="sv-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (newDeck.trim() !== '') void create.run();
          }}
        >
          <div className="sv-field rv-grow">
            <label className="sv-label" htmlFor="rv-newdeck">
              New deck
            </label>
            <input
              id="rv-newdeck"
              className="sv-control"
              data-testid={TID.newDeckName}
              maxLength={80}
              value={newDeck}
              onChange={(e) => setNewDeck(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            data-testid={TID.newDeck}
            busy={create.busy}
            disabledReason={newDeck.trim() === '' ? 'Type a name for the deck first.' : undefined}
          >
            Create deck
          </Button>
          {selectedDeck ? (
            <Button variant="danger" onClick={() => setConfirmDeck(true)}>
              Delete deck “{truncate(selectedDeck.name, 24)}”
            </Button>
          ) : null}
        </form>
        {create.error ? <InlineNotice tone="error">{create.error}</InlineNotice> : null}
      </section>

      {list.error ? (
        <InlineNotice
          tone="error"
          title="Cards could not be loaded"
          action={list.retryable ? <Button onClick={list.refresh}>Retry</Button> : undefined}
        >
          {list.error}
        </InlineNotice>
      ) : list.loading ? (
        <p className="sv-muted">Loading cards…</p>
      ) : cards.length === 0 ? (
        <EmptyState title={filter === 'all' && !search ? 'No cards here yet' : 'No card matches'}>
          {filter === 'all' && !search
            ? 'Make cards from a highlight in the Create view.'
            : 'Change the filter or the search words.'}
        </EmptyState>
      ) : (
        <>
          <p className="sv-small sv-muted" role="status">
            {list.data && list.data.total > cards.length
              ? `Showing ${cards.length} of ${list.data.total} cards. Narrow the filter to see the rest.`
              : plural(cards.length, 'card')}
          </p>
          {act.error ? <InlineNotice tone="error">{act.error}</InlineNotice> : null}
          <ul className="sv-stack">
            {cards.map((c) => (
              <li key={c.id} className="rv-cardrow" data-testid={cardRowId(c.id)}>
                {editing === c.id ? (
                  <CardEditForm
                    card={c}
                    busy={act.busy}
                    error={editError}
                    onCancel={() => setEditing(null)}
                    onSave={async (patch: CardPatch) => {
                      try {
                        setEditError(null);
                        await updateCard(c.id, patch);
                        setEditing(null);
                        toast.push({ message: 'Card saved.' });
                        return true;
                      } catch (err) {
                        setEditError(errorMessage(err));
                        return false;
                      }
                    }}
                  />
                ) : (
                  <>
                    <div className="sv-stack sv-stack--tight">
                      <p className="rv-cardrow__front sv-wrap">{truncate(c.front, 220)}</p>
                      <p className="sv-small sv-muted sv-wrap">
                        {c.cardType === 'cloze' || c.cardType === 'mcq'
                          ? truncate(c.back, 120)
                          : truncate(c.back, 160)}
                      </p>
                      <div className="sv-row">
                        <Badge>{deckName.get(c.deckId) ?? 'Deck'}</Badge>
                        <Badge tone={c.fsrs.state === 'new' ? 'info' : 'neutral'}>
                          {STATE_LABEL[c.fsrs.state]}
                        </Badge>
                        {c.suspended ? <Badge tone="warning">Suspended</Badge> : null}
                        {c.tags.includes('leech') ? <Badge tone="danger">Leech</Badge> : null}
                        {c.needsHumanVerification ? (
                          <Badge tone="warning">Needs your check</Badge>
                        ) : null}
                        {c.deletedAt ? <Badge tone="danger">Deleted</Badge> : null}
                        {c.fsrs.state !== 'new' ? (
                          <span className="sv-small sv-muted">
                            due {formatWhen(c.fsrs.due, settings.timeZone)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="sv-row">
                      {c.deletedAt ? (
                        <Button onClick={() => void undoDelete([c.id])}>Restore</Button>
                      ) : (
                        <>
                          <Button onClick={() => setEditing(c.id)}>Edit</Button>
                          <Button
                            busy={act.busy}
                            onClick={() =>
                              void act.run(async () => {
                                await setCardsSuspended([c.id], !c.suspended);
                                return c.suspended ? 'Card unsuspended.' : 'Card suspended.';
                              })
                            }
                          >
                            {c.suspended ? 'Unsuspend' : 'Suspend'}
                          </Button>
                          <Button
                            busy={act.busy}
                            disabledReason={
                              c.fsrs.state === 'new'
                                ? 'A new card has no progress to reset.'
                                : undefined
                            }
                            onClick={() =>
                              void act.run(async () => {
                                await resetCardProgress(c.id);
                                return 'Progress reset: the card is new again.';
                              })
                            }
                          >
                            Reset progress
                          </Button>
                          <RescheduleButton card={c} onDone={(m) => toast.push({ message: m })} />
                          <Button
                            variant="danger"
                            busy={act.busy}
                            onClick={() =>
                              void act.run(async () => {
                                await deleteCards([c.id]);
                                toast.push({
                                  message:
                                    'Card deleted. A copy stays on this device until you delete its highlight forever from Trash or delete all data in Settings.',
                                  action: { label: 'Undo', onClick: () => void undoDelete([c.id]) },
                                });
                              })
                            }
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {confirmDeck && selectedDeck ? (
        <ConfirmDialog
          danger
          title={`Delete the deck “${selectedDeck.name}”?`}
          confirmLabel="Delete deck and its cards"
          onConfirm={() => void removeDeck.run()}
          onCancel={() => setConfirmDeck(false)}
        >
          <p>
            The deck and its cards leave your review queue. Highlights and quotes are not touched,
            and a copy of the cards stays on this device until you delete their highlights forever
            from Trash or delete all data in Settings.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function RescheduleButton({ card, onDone }: { card: Card; onDone(message: string): void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const apply = useAction(async () => {
    const at = new Date(`${value}T00:00:00`);
    if (Number.isNaN(at.getTime())) throw new Error('Choose a date.');
    await rescheduleCard(card.id, at);
    setOpen(false);
    onDone('Card rescheduled.');
  });
  if (!open) {
    return (
      <Button
        disabledReason={
          card.fsrs.state === 'new' ? 'A new card has no due date to move.' : undefined
        }
        onClick={() => setOpen(true)}
      >
        Reschedule
      </Button>
    );
  }
  return (
    <span className="rv-inline">
      <label className="sv-sr" htmlFor={`rv-date-${card.id}`}>
        New due date
      </label>
      <input
        id={`rv-date-${card.id}`}
        className="sv-control"
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        variant="primary"
        busy={apply.busy}
        disabledReason={value === '' ? 'Choose a date first.' : undefined}
        onClick={() => void apply.run()}
      >
        Move
      </Button>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
      {apply.error ? <span className="sv-small rv-error">{apply.error}</span> : null}
    </span>
  );
}
