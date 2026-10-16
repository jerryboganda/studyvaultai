import { useState } from 'react';
import {
  Bug,
  CalendarClock,
  Check,
  CirclePlus,
  EyeOff,
  GraduationCap,
  Layers,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Search,
  TimerReset,
  Trash,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
  Button,
  ChunkyButton,
  ConfirmDialog,
  IconButton,
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
import { Empty, LinkButton, Loading, Pill, SideSheet } from './ManageKit';

const FILTERS: { id: CardFilter; label: string; icon: LucideIcon }[] = [
  { id: 'all', label: 'All cards', icon: Layers },
  { id: 'new', label: 'New', icon: CirclePlus },
  { id: 'learning', label: 'Learning', icon: GraduationCap },
  { id: 'review', label: 'Review', icon: Repeat },
  { id: 'due', label: 'Due now', icon: CalendarClock },
  { id: 'suspended', label: 'Suspended', icon: Pause },
  { id: 'buried', label: 'Buried', icon: EyeOff },
  { id: 'leech', label: 'Leeches', icon: Bug },
  { id: 'deleted', label: 'Deleted', icon: Trash },
];

const STATE_LOOK = {
  new: { label: 'New', icon: CirclePlus, tone: 'primary' },
  learning: { label: 'Learning', icon: GraduationCap, tone: 'sun' },
  review: { label: 'Review', icon: Repeat, tone: 'success' },
  relearning: { label: 'Relearning', icon: Repeat, tone: 'warning' },
} as const;

/** Find, fix and manage cards and decks. Reachable home of everything a session can suspend. */
export function CardBrowser({ settings }: { settings: StudySettings }) {
  const toast = useToast();
  const [deckId, setDeckId] = useState('');
  const [filter, setFilter] = useState<CardFilter>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  /** The "New deck" field: null while closed. */
  const [newDeck, setNewDeck] = useState<string | null>(null);
  const [confirmDeck, setConfirmDeck] = useState(false);
  const [confirmReset, setConfirmReset] = useState<Card | null>(null);
  /** Cards with an action in flight: only their own buttons wait. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [actError, setActError] = useState<string | null>(null);

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
  const editingCard = editing ? cards.find((c) => c.id === editing) : undefined;

  const create = useAction(async () => {
    const deck = await createDeck({ name: newDeck ?? '' });
    setNewDeck(null);
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

  const act = async (id: string, fn: () => Promise<string | void>) => {
    if (busy.has(id)) return;
    const mark = (on: boolean) =>
      setBusy((s) => {
        const next = new Set(s);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
    mark(true);
    setActError(null);
    try {
      const message = await fn();
      if (message) toast.push({ message });
    } catch (err) {
      setActError(errorMessage(err));
    } finally {
      mark(false);
    }
  };

  const undoDelete = async (ids: string[]) => {
    try {
      await restoreCards(ids);
      toast.push({ message: 'Card restored.' });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err) });
    }
  };

  const filtered = filter !== 'all' || search.trim() !== '';

  return (
    <div className="rvm" data-testid={TID.browser}>
      <section className="rvm-card" aria-label="Find cards">
        <div className="rvm-toolbar">
          <div className="rvm-search">
            <label className="sv-vh" htmlFor="rv-bsearch">
              Search cards
            </label>
            <Search aria-hidden="true" strokeWidth={2.4} />
            <input
              id="rv-bsearch"
              className="sv-control"
              type="search"
              placeholder="Search text and tags"
              data-testid={TID.browserSearch}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="sv-field">
            <label className="sv-label" htmlFor="rv-bdeck">
              Deck
            </label>
            <div className="rvm-unit">
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
              {selectedDeck ? (
                <IconButton
                  icon={Trash}
                  label={`Delete deck ${truncate(selectedDeck.name, 24)}`}
                  onClick={() => setConfirmDeck(true)}
                />
              ) : null}
            </div>
          </div>
          {newDeck === null ? (
            <ChunkyButton icon={Plus} onClick={() => setNewDeck('')}>
              New deck
            </ChunkyButton>
          ) : null}
        </div>

        {newDeck !== null ? (
          <form
            className="rvm-row"
            aria-label="New deck"
            onSubmit={(e) => {
              e.preventDefault();
              if (newDeck.trim() !== '') void create.run();
            }}
          >
            <div className="sv-field">
              <label className="sv-label" htmlFor="rv-newdeck">
                Deck name
              </label>
              <input
                id="rv-newdeck"
                className="sv-control"
                data-testid={TID.newDeckName}
                maxLength={80}
                // Opened by the person's own click, so moving focus into it is expected.
                autoFocus
                value={newDeck}
                onChange={(e) => setNewDeck(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setNewDeck(null);
                  }
                }}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              data-testid={TID.newDeck}
              busy={create.busy}
              disabledReason={newDeck.trim() === '' ? 'Type a name for the deck first.' : undefined}
            >
              <Check aria-hidden="true" width={18} height={18} /> Create deck
            </Button>
            <IconButton icon={X} label="Cancel" onClick={() => setNewDeck(null)} />
          </form>
        ) : null}
        {create.error ? <InlineNotice tone="error">{create.error}</InlineNotice> : null}

        <div className="rvm-chips" role="group" aria-label="Show" data-testid={TID.browserFilter}>
          {FILTERS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="rvm-chip"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {/* The check is the second cue for "on", beside the colour (1.4.1). */}
              {filter === id ? (
                <Check aria-hidden="true" strokeWidth={3} />
              ) : (
                <Icon aria-hidden="true" strokeWidth={2.4} />
              )}
              {label}
            </button>
          ))}
        </div>
      </section>

      {list.error ? (
        <InlineNotice
          tone="error"
          title="Cards could not load"
          action={list.retryable ? <Button onClick={list.refresh}>Retry</Button> : undefined}
        >
          {list.error}
        </InlineNotice>
      ) : list.loading ? (
        <Loading>Loading cards…</Loading>
      ) : cards.length === 0 ? (
        <Empty
          title={filtered ? 'No card matches' : 'No cards yet'}
          line={filtered ? 'Try another filter or other words.' : 'Make one from a highlight.'}
        >
          {filtered ? null : (
            <LinkButton href="?view=create" icon={Plus}>
              Create cards
            </LinkButton>
          )}
        </Empty>
      ) : (
        <>
          <p className="rvm-line" role="status">
            {list.data && list.data.total > cards.length
              ? `Showing ${cards.length} of ${list.data.total} cards. Narrow the filter to see the rest.`
              : plural(cards.length, 'card')}
          </p>
          {actError ? <InlineNotice tone="error">{actError}</InlineNotice> : null}
          <ul className="rvm-cards">
            {cards.map((c) => {
              const look = STATE_LOOK[c.fsrs.state];
              const rowBusy = busy.has(c.id);
              return (
                <li
                  key={c.id}
                  className={c.suspended || c.deletedAt ? 'is-off' : undefined}
                  data-testid={cardRowId(c.id)}
                  aria-busy={rowBusy || undefined}
                >
                  <div className="rvm-badges">
                    <Pill icon={look.icon} tone={look.tone}>
                      {look.label}
                    </Pill>
                    <Pill icon={Layers}>{deckName.get(c.deckId) ?? 'Deck'}</Pill>
                    {c.suspended ? (
                      <Pill icon={Pause} tone="warning">
                        Suspended
                      </Pill>
                    ) : null}
                    {c.tags.includes('leech') ? (
                      <Pill icon={Bug} tone="danger">
                        Leech
                      </Pill>
                    ) : null}
                    {c.needsHumanVerification ? (
                      <Pill icon={TriangleAlert} tone="warning">
                        Needs your check
                      </Pill>
                    ) : null}
                    {c.deletedAt ? (
                      <Pill icon={Trash} tone="danger">
                        Deleted
                      </Pill>
                    ) : null}
                  </div>
                  <p className="rvm-cardfront" dir="auto">
                    {truncate(c.front, 220)}
                  </p>
                  <p className="rvm-cardback" dir="auto">
                    {c.cardType === 'cloze' || c.cardType === 'mcq'
                      ? truncate(c.back, 120)
                      : truncate(c.back, 160)}
                  </p>
                  <div className="rvm-cardfoot">
                    {c.fsrs.state !== 'new' ? (
                      <Pill icon={CalendarClock}>
                        due {formatWhen(c.fsrs.due, settings.timeZone)}
                      </Pill>
                    ) : null}
                    <div className="rvm-cardfoot__acts">
                      {c.deletedAt ? (
                        <ChunkyButton
                          size="sm"
                          icon={Undo2}
                          onClick={() => void undoDelete([c.id])}
                        >
                          Restore
                        </ChunkyButton>
                      ) : (
                        <>
                          <IconButton
                            icon={Pencil}
                            label="Edit"
                            size="sm"
                            tipSide="top"
                            onClick={() => {
                              setEditError(null);
                              setEditing(c.id);
                            }}
                          />
                          <IconButton
                            icon={c.suspended ? Play : Pause}
                            label={c.suspended ? 'Unsuspend' : 'Suspend'}
                            size="sm"
                            tipSide="top"
                            aria-disabled={rowBusy || undefined}
                            onClick={() =>
                              void act(c.id, async () => {
                                await setCardsSuspended([c.id], !c.suspended);
                                return c.suspended ? 'Card unsuspended.' : 'Card suspended.';
                              })
                            }
                          />
                          {/* A new card has no due date or progress: nothing to move or reset. */}
                          {c.fsrs.state !== 'new' ? (
                            <>
                              <RescheduleButton
                                card={c}
                                onDone={(m) => toast.push({ message: m })}
                              />
                              <IconButton
                                icon={TimerReset}
                                label="Reset progress"
                                size="sm"
                                tipSide="top"
                                aria-disabled={rowBusy || undefined}
                                onClick={() => setConfirmReset(c)}
                              />
                            </>
                          ) : null}
                          <IconButton
                            icon={Trash}
                            label="Delete"
                            size="sm"
                            tipSide="top"
                            aria-disabled={rowBusy || undefined}
                            onClick={() =>
                              void act(c.id, async () => {
                                await deleteCards([c.id]);
                                toast.push({
                                  message: 'Card deleted. Find it under Deleted.',
                                  action: { label: 'Undo', onClick: () => void undoDelete([c.id]) },
                                });
                              })
                            }
                          />
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {editingCard ? (
        <SideSheet title="Edit card" onClose={() => setEditing(null)}>
          <CardEditForm
            card={editingCard}
            busy={savingEdit}
            error={editError}
            onCancel={() => setEditing(null)}
            onSave={async (patch: CardPatch) => {
              setSavingEdit(true);
              try {
                setEditError(null);
                await updateCard(editingCard.id, patch);
                setEditing(null);
                toast.push({ message: 'Card saved.' });
                return true;
              } catch (err) {
                setEditError(errorMessage(err));
                return false;
              } finally {
                setSavingEdit(false);
              }
            }}
          />
        </SideSheet>
      ) : null}

      {confirmReset ? (
        <ConfirmDialog
          danger
          title="Reset this card?"
          confirmLabel="Reset progress"
          onConfirm={() => {
            const card = confirmReset;
            setConfirmReset(null);
            void act(card.id, async () => {
              await resetCardProgress(card.id);
              return 'Progress reset: the card is new again.';
            });
          }}
          onCancel={() => setConfirmReset(null)}
        >
          <p>Its schedule starts over. Its review history stays.</p>
        </ConfirmDialog>
      ) : null}

      {confirmDeck && selectedDeck ? (
        <ConfirmDialog
          danger
          title={`Delete the deck “${selectedDeck.name}”?`}
          confirmLabel="Delete deck"
          onConfirm={() => void removeDeck.run()}
          onCancel={() => setConfirmDeck(false)}
        >
          <p>
            Its cards leave review. Highlights stay, and a copy of the cards stays on this device.
          </p>
          {removeDeck.error ? <InlineNotice tone="error">{removeDeck.error}</InlineNotice> : null}
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
      <IconButton
        icon={CalendarClock}
        label="Reschedule"
        size="sm"
        tipSide="top"
        onClick={() => setOpen(true)}
      />
    );
  }
  return (
    <span className="rvm-resched">
      <label className="sv-sr" htmlFor={`rv-date-${card.id}`}>
        New due date
      </label>
      <input
        id={`rv-date-${card.id}`}
        className="sv-control"
        type="date"
        value={value}
        // Opened by the person's own click, so moving focus into it is expected.
        autoFocus
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
      <IconButton icon={X} label="Cancel" size="sm" onClick={() => setOpen(false)} />
      {apply.error ? <span className="rvm-fielderr">{apply.error}</span> : null}
    </span>
  );
}
