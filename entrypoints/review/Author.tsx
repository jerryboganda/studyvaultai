import { useMemo, useState } from 'react';
import type { Deck } from '@study';
import {
  createCardsFromHighlight,
  createCardsFromHighlights,
  createManualCards,
  listBanks,
  listCards,
  listDecks,
  listHighlights,
  type HighlightListItem,
  type TemplateInput,
} from '@storage';
import {
  Badge,
  Button,
  EmptyState,
  InlineNotice,
  Tabs,
  errorMessage,
  plural,
  truncate,
  useAction,
  useObserved,
  useToast,
} from '@ui';
import { TID, pickerItemId } from '@ui/review';
import { KnowledgePointEditor } from './KnowledgePointEditor';
import { TemplateEditor } from './TemplateEditor';

const PICKER_LIMIT = 200;

type Mode = 'single' | 'bulk' | 'manual';

/** Make cards: from one highlight, from several at once, or typed by hand. */
export function Author({ initialHighlightId }: { initialHighlightId: string | null }) {
  const toast = useToast();
  const [bankId, setBankId] = useState('');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string | null>(initialHighlightId);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode>('single');
  const [saveError, setSaveError] = useState<string | null>(null);

  const banks = useObserved(() => listBanks(), []);
  const decks = useObserved(() => listDecks(), []);
  const page = useObserved(
    () => listHighlights({ ...(bankId ? { bankId } : {}), limit: PICKER_LIMIT }),
    [bankId],
  );
  const cardCounts = useObserved(async () => {
    const { cards } = await listCards({ limit: 2000 });
    const counts = new Map<string, number>();
    for (const c of cards)
      if (c.highlightId) counts.set(c.highlightId, (counts.get(c.highlightId) ?? 0) + 1);
    return counts;
  }, []);

  const items = useMemo(() => {
    const all = page.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter(
      (i) =>
        i.highlight.exactQuote.toLowerCase().includes(needle) ||
        i.highlight.userComment.toLowerCase().includes(needle) ||
        i.source.title.toLowerCase().includes(needle),
    );
  }, [page.data, search]);

  const activeItem = items.find((i) => i.highlight.id === active) ?? null;
  const deckList: readonly Deck[] = decks.data ?? [];
  const chosen = items.filter((i) => checked.has(i.highlight.id));

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const saveSingle = async (template: TemplateInput, deckId: string | null) => {
    if (!activeItem) return false;
    setSaveError(null);
    try {
      const cards = await createCardsFromHighlight(activeItem.highlight.id, [template], {
        ...(deckId ? { deckId } : {}),
      });
      toast.push({ message: `Created ${plural(cards.length, 'card')}.` });
      return true;
    } catch (err) {
      setSaveError(errorMessage(err));
      return false;
    }
  };

  const saveManual = async (template: TemplateInput, deckId: string | null) => {
    setSaveError(null);
    try {
      const cards = await createManualCards([template], { ...(deckId ? { deckId } : {}) });
      toast.push({ message: `Created ${plural(cards.length, 'card')}.` });
      return true;
    } catch (err) {
      setSaveError(errorMessage(err));
      return false;
    }
  };

  return (
    <div className="rv-author" data-testid={TID.author}>
      <section
        className="rv-picker sv-stack"
        aria-label="Choose highlights"
        data-testid={TID.picker}
      >
        <h2>Highlights</h2>
        <div className="sv-field">
          <label className="sv-label" htmlFor="rv-bank">
            Bank
          </label>
          <select
            id="rv-bank"
            className="sv-control"
            data-testid={TID.pickerBank}
            value={bankId}
            onChange={(e) => setBankId(e.target.value)}
          >
            <option value="">All banks</option>
            {(banks.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor="rv-search">
            Search these highlights
          </label>
          <input
            id="rv-search"
            className="sv-control"
            type="search"
            data-testid={TID.pickerSearch}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {page.error ? (
          <InlineNotice
            tone="error"
            title="Highlights could not be loaded"
            action={page.retryable ? <Button onClick={page.refresh}>Retry</Button> : undefined}
          >
            {page.error}
          </InlineNotice>
        ) : page.loading ? (
          <p className="sv-muted">Loading highlights…</p>
        ) : items.length === 0 ? (
          <EmptyState title={search ? 'No highlight matches' : 'No highlights yet'}>
            {search
              ? 'Try different words, or choose another bank.'
              : 'Save a highlight from any page first, or type a card by hand.'}
          </EmptyState>
        ) : (
          <ul className="rv-pick-list" aria-label="Highlights">
            {items.map((it) => (
              <PickRow
                key={it.highlight.id}
                item={it}
                active={it.highlight.id === active}
                checked={checked.has(it.highlight.id)}
                cards={cardCounts.data?.get(it.highlight.id) ?? 0}
                onOpen={() => {
                  setActive(it.highlight.id);
                  setMode('single');
                  setSaveError(null);
                }}
                onToggle={() => toggle(it.highlight.id)}
              />
            ))}
          </ul>
        )}
        {(page.data?.items.length ?? 0) >= PICKER_LIMIT ? (
          <p className="sv-small sv-muted">
            Showing the {PICKER_LIMIT} most recent. Choose a bank or search to narrow the list.
          </p>
        ) : null}
      </section>

      <section className="rv-workspace sv-stack" aria-label="Card workspace">
        <Tabs
          label="How to make cards"
          tabs={[
            { id: 'single', label: 'From a highlight' },
            { id: 'bulk', label: 'From several', count: chosen.length },
            { id: 'manual', label: 'Typed card' },
          ]}
          value={mode}
          onChange={(id) => {
            setMode(id as Mode);
            setSaveError(null);
          }}
        >
          {mode === 'single' ? (
            activeItem ? (
              <div className="sv-stack">
                <p className="sv-muted sv-wrap">
                  From {activeItem.source.title || activeItem.source.host}
                  {activeItem.highlight.anchorSet.type === 'pdf'
                    ? `, page ${activeItem.highlight.anchorSet.pageNumber}`
                    : ''}
                  .
                </p>
                <TemplateEditor
                  key={activeItem.highlight.id}
                  quote={activeItem.highlight.exactQuote}
                  decks={deckList}
                  autoDeckLabel={activeItem.banks[0]?.name ?? 'General'}
                  saving={false}
                  error={saveError}
                  onSave={saveSingle}
                />
                <h2>Knowledge points</h2>
                <KnowledgePointEditor highlightId={activeItem.highlight.id} highlights={items} />
              </div>
            ) : (
              <EmptyState title="Choose a highlight">
                Pick one from the list to write cards for it, or use the other tabs.
              </EmptyState>
            )
          ) : null}

          {mode === 'bulk' ? (
            <BulkCreate items={chosen} decks={deckList} onDone={() => setChecked(new Set())} />
          ) : null}

          {mode === 'manual' ? (
            <div className="sv-stack" data-testid={TID.manual}>
              <p className="sv-muted">
                A card without a source. It cannot jump back to a page, so prefer making cards from
                highlights when you can.
              </p>
              <TemplateEditor
                quote={null}
                decks={deckList}
                autoDeckLabel={null}
                saving={false}
                error={saveError}
                onSave={saveManual}
              />
            </div>
          ) : null}
        </Tabs>
      </section>
    </div>
  );
}

function PickRow({
  item,
  active,
  checked,
  cards,
  onOpen,
  onToggle,
}: {
  item: HighlightListItem;
  active: boolean;
  checked: boolean;
  cards: number;
  onOpen(): void;
  onToggle(): void;
}) {
  const quote = item.highlight.exactQuote;
  return (
    <li
      className={`rv-pick${active ? ' rv-pick--active' : ''}`}
      data-testid={pickerItemId(item.highlight.id)}
    >
      <input
        type="checkbox"
        checked={checked}
        aria-label={`Select for bulk: ${truncate(quote, 60)}`}
        onChange={onToggle}
      />
      <button
        type="button"
        className="rv-pick__body"
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
      >
        <span className="rv-pick__quote">{truncate(quote, 160)}</span>
        <span className="sv-small sv-muted">
          {item.source.title || item.source.host}
          {item.banks.length > 0 ? ` · ${item.banks.map((b) => b.name).join(', ')}` : ''}
        </span>
      </button>
      {cards > 0 ? <Badge tone="info">{plural(cards, 'card')}</Badge> : null}
    </li>
  );
}

function defaultQuestion(item: HighlightListItem): string {
  const heading = item.highlight.headingContext?.trim();
  return heading ? `What does the source say about "${heading}"?` : '';
}

/**
 * One basic card per selected highlight: the quote is the answer and the learner writes (or
 * confirms) the question. Rows without a question are left out, never filled with invented text.
 */
function BulkCreate({
  items,
  decks,
  onDone,
}: {
  items: HighlightListItem[];
  decks: readonly Deck[];
  onDone(): void;
}) {
  const toast = useToast();
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [deckId, setDeckId] = useState('');
  const questionOf = (it: HighlightListItem) => questions[it.highlight.id] ?? defaultQuestion(it);
  const rows = items
    .filter((it) => !skipped.has(it.highlight.id))
    .map((it) => ({ it, question: questionOf(it).trim() }));
  const ready = rows.filter((r) => r.question !== '');

  const create = useAction(async () => {
    const cards = await createCardsFromHighlights(
      ready.map((r) => ({
        highlightId: r.it.highlight.id,
        template: {
          template: 'basic',
          question: r.question,
          answer: r.it.highlight.exactQuote,
        } satisfies TemplateInput,
      })),
      deckId ? { deckId } : {},
    );
    toast.push({ message: `Created ${plural(cards.length, 'card')}.` });
    onDone();
  });

  if (items.length === 0) {
    return (
      <EmptyState title="Nothing selected">
        Tick the box next to two or more highlights in the list, then come back here to write a
        question for each.
      </EmptyState>
    );
  }

  return (
    <div className="sv-stack" data-testid={TID.bulk}>
      <p className="sv-muted">
        Each selected highlight becomes one question-and-answer card whose answer is the saved
        quote. Write the question for each; a row with no question is left out.
      </p>
      <ul className="sv-stack">
        {items.map((it) => {
          const id = it.highlight.id;
          const off = skipped.has(id);
          return (
            <li key={id} className="rv-bulk-row sv-stack sv-stack--tight">
              <label className="sv-check">
                <input
                  type="checkbox"
                  checked={!off}
                  onChange={() =>
                    setSkipped((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                />
                <span className="sv-quote sv-small">{truncate(it.highlight.exactQuote, 200)}</span>
              </label>
              <div className="sv-field">
                <label className="sv-label" htmlFor={`rv-bq-${id}`}>
                  Question
                </label>
                <input
                  id={`rv-bq-${id}`}
                  className="sv-control"
                  disabled={off}
                  value={questionOf(it)}
                  onChange={(e) => setQuestions((q) => ({ ...q, [id]: e.target.value }))}
                />
                {!off && questionOf(it).trim() === '' ? (
                  <p className="sv-small sv-muted">Add a question or untick this row.</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="sv-field">
        <label className="sv-label" htmlFor="rv-bulk-deck">
          Deck
        </label>
        <select
          id="rv-bulk-deck"
          className="sv-control"
          value={deckId}
          onChange={(e) => setDeckId(e.target.value)}
        >
          <option value="">Automatic: each highlight&rsquo;s own bank</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      {create.error ? (
        <InlineNotice tone="error" title="No cards were created">
          {create.error}
        </InlineNotice>
      ) : null}
      <div className="sv-row">
        <Button
          variant="primary"
          data-testid={TID.bulkCreate}
          busy={create.busy}
          disabledReason={ready.length === 0 ? 'Write at least one question first.' : undefined}
          onClick={() => void create.run()}
        >
          Create {plural(ready.length, 'card')}
        </Button>
        {ready.length < rows.length ? (
          <span className="sv-small sv-muted">
            {plural(rows.length - ready.length, 'row')} without a question will be left out.
          </span>
        ) : null}
      </div>
    </div>
  );
}
