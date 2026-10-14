import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Files,
  Highlighter,
  Layers,
  Lightbulb,
  PenLine,
  Plus,
  ListRestart,
  Search,
} from 'lucide-react';
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
  Button,
  ChoiceCards,
  ChunkyButton,
  InlineNotice,
  VaultBuddy,
  Wizard,
  errorMessage,
  plural,
  truncate,
  useObserved,
  useToast,
  type Choice,
  type WizardStep,
} from '@ui';
import { TID, initialEditorState, pickerItemId, type EditorState } from '@ui/review';
import { KnowledgePointEditor } from './KnowledgePointEditor';
import { Disclosure, Empty, Loading, Pill } from './ManageKit';
import { CardPreview, TEMPLATES, TemplateFields, useDrafts } from './TemplateEditor';

const PICKER_LIMIT = 200;
/** The "automatic deck" choice; deck ids are 8 to 64 characters, so it cannot collide. */
const AUTO = 'auto';

type Source = 'highlight' | 'several' | 'blank';
type StepId = 'source' | 'pick' | 'type' | 'write' | 'questions' | 'deck';

/** The steps of each way to start (UX_DESIGN 10: one decision per screen). */
const FLOW: Record<Source, StepId[]> = {
  highlight: ['source', 'pick', 'type', 'write', 'deck'],
  several: ['source', 'pick', 'questions', 'deck'],
  blank: ['source', 'type', 'write', 'deck'],
};

const SOURCES: Choice<Source>[] = [
  {
    value: 'highlight',
    label: 'A highlight',
    hint: 'From one quote',
    icon: Highlighter,
    tone: 'sun',
  },
  { value: 'several', label: 'Several', hint: 'One per quote', icon: Files, tone: 'primary' },
  { value: 'blank', label: 'Blank card', hint: 'Type it in', icon: PenLine, tone: 'violet' },
];

function defaultQuestion(item: HighlightListItem): string {
  const heading = item.highlight.headingContext?.trim();
  return heading ? `What does the source say about "${heading}"?` : '';
}

/**
 * Make cards as a wizard: where from (a highlight, several, or blank), which highlight, the card
 * type, the fields with a live preview, then the deck. A link with a highlight starts at the type.
 */
export function Author({ initialHighlightId }: { initialHighlightId: string | null }) {
  const toast = useToast();
  const [bankId, setBankId] = useState('');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<Source | null>(initialHighlightId ? 'highlight' : null);
  const [active, setActive] = useState<string | null>(initialHighlightId);
  /** Ticked highlights for "Several", kept by id so a filter change never drops one. */
  const [checked, setChecked] = useState<ReadonlyMap<string, HighlightListItem>>(new Map());
  const [editor, setEditor] = useState<EditorState>(() => initialEditorState(null));
  /** The highlight whose quote seeded the editor (the cloze text starts as the quote). */
  const [seeded, setSeeded] = useState<string | null>(null);
  const [deckId, setDeckId] = useState('');
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  /** First step shown: later than "source" when the choice is already made (a link, "Make another"). */
  const [from, setFrom] = useState<StepId>(initialHighlightId ? 'type' : 'source');
  const [run, setRun] = useState(0);
  const [done, setDone] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

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

  const all = useMemo(() => page.data?.items ?? [], [page.data]);
  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter(
      (i) =>
        i.highlight.exactQuote.toLowerCase().includes(needle) ||
        i.highlight.userComment.toLowerCase().includes(needle) ||
        i.source.title.toLowerCase().includes(needle),
    );
  }, [all, search]);
  // Kept while the person searches or filters: the chosen highlight does not vanish with the list.
  const [activeItem, setActiveItem] = useState<HighlightListItem | null>(null);
  const found = all.find((i) => i.highlight.id === active) ?? null;
  if (found && found !== activeItem) setActiveItem(found);
  const chosenItem = active && activeItem?.highlight.id === active ? activeItem : null;

  // A linked highlight that is not among the newest: open the picker instead of a quote-less card.
  if (from === 'type' && source === 'highlight' && page.data && !found && !chosenItem) {
    setFrom('pick');
    setRun((r) => r + 1);
  }
  const quote = source === 'highlight' ? (chosenItem?.highlight.exactQuote ?? null) : null;
  // A new highlight seeds the editor with its quote (the cloze text); the card type and tags stay.
  if (source === 'highlight' && chosenItem && seeded !== chosenItem.highlight.id) {
    setSeeded(chosenItem.highlight.id);
    setEditor((s) => ({
      ...initialEditorState(chosenItem.highlight.exactQuote, s.template),
      tags: s.tags,
    }));
  }

  const deckList: readonly Deck[] = decks.data ?? [];
  const { input, built, count } = useDrafts(editor, quote);
  const chosen = [...checked.values()];
  const questionOf = (it: HighlightListItem) => questions[it.highlight.id] ?? defaultQuestion(it);
  const bulkRows = chosen
    .filter((it) => !skipped.has(it.highlight.id))
    .map((it) => ({ it, question: questionOf(it).trim() }));
  const ready = bulkRows.filter((r) => r.question !== '');

  const chooseSource = (next: Source) => {
    if (next === source) return;
    setSource(next);
    setSaveError(null);
    if (next === 'blank') {
      setSeeded(null);
      setEditor((s) => ({ ...initialEditorState(null, s.template), tags: s.tags }));
    } else if (next === 'highlight') {
      setSeeded(null); // re-seeded from the chosen highlight, if there is one
    }
  };

  const toggle = (it: HighlightListItem) =>
    setChecked((prev) => {
      const next = new Map(prev);
      if (next.has(it.highlight.id)) next.delete(it.highlight.id);
      else next.set(it.highlight.id, it);
      return next;
    });

  const finish = async () => {
    if (inFlight.current || source === null) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    const deck = deckId ? { deckId } : {};
    try {
      let made = 0;
      if (source === 'several') {
        const cards = await createCardsFromHighlights(
          ready.map((r) => ({
            highlightId: r.it.highlight.id,
            template: {
              template: 'basic',
              question: r.question,
              answer: r.it.highlight.exactQuote,
            } satisfies TemplateInput,
          })),
          deck,
        );
        made = cards.length;
      } else if (source === 'highlight') {
        if (!chosenItem) throw new Error('Pick a highlight first.');
        made = (await createCardsFromHighlight(chosenItem.highlight.id, [input], deck)).length;
      } else {
        made = (await createManualCards([input], deck)).length;
      }
      toast.push({ message: `Created ${plural(made, 'card')}.` });
      setDone(made);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  /** Another card from the same start: the fields clear, the source and type stay. */
  const another = () => {
    if (source === 'several') {
      setChecked(new Map());
      setQuestions({});
      setSkipped(new Set());
      setFrom('pick');
    } else {
      setEditor((s) => ({ ...initialEditorState(quote, s.template), tags: s.tags }));
      setFrom('write');
    }
    setDone(null);
    setRun((r) => r + 1);
  };
  const restart = () => {
    setSource(null);
    setActive(null);
    setActiveItem(null);
    setSeeded(null);
    setChecked(new Map());
    setQuestions({});
    setSkipped(new Set());
    setEditor(initialEditorState(null));
    setDeckId('');
    setFrom('source');
    setDone(null);
    setRun((r) => r + 1);
  };

  const picker = (multi: boolean) => (
    <div className="rvm-fields" data-testid={TID.picker}>
      <div className="rvm-toolbar">
        <div className="rvm-search">
          <label className="sv-vh" htmlFor="rv-search">
            Search highlights
          </label>
          <Search aria-hidden="true" strokeWidth={2.4} />
          <input
            id="rv-search"
            className="sv-control"
            type="search"
            placeholder="Search highlights"
            data-testid={TID.pickerSearch}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
      </div>
      {multi ? (
        <p className="rvm-line" role="status">
          {plural(checked.size, 'highlight')} ticked
        </p>
      ) : null}
      {page.error ? (
        <InlineNotice
          tone="error"
          title="Highlights could not load"
          action={page.retryable ? <Button onClick={page.refresh}>Retry</Button> : undefined}
        >
          {page.error}
        </InlineNotice>
      ) : page.loading ? (
        <Loading>Loading highlights…</Loading>
      ) : items.length === 0 ? (
        <Empty
          title={search ? 'No highlight matches' : 'No highlights yet'}
          line={
            search ? 'Try other words or another bank.' : 'Save one from a page, or start blank.'
          }
        >
          {search ? null : (
            <ChunkyButton variant="primary" icon={PenLine} onClick={() => chooseSource('blank')}>
              Blank card
            </ChunkyButton>
          )}
        </Empty>
      ) : (
        <fieldset className="rvm-picks">
          <legend className="sv-vh">Highlights</legend>
          {items.map((it) => (
            <PickRow
              key={it.highlight.id}
              item={it}
              multi={multi}
              checked={multi ? checked.has(it.highlight.id) : it.highlight.id === active}
              cards={cardCounts.data?.get(it.highlight.id) ?? 0}
              onChange={() => {
                if (multi) toggle(it);
                else setActive(it.highlight.id);
              }}
            />
          ))}
        </fieldset>
      )}
      {all.length >= PICKER_LIMIT ? (
        <p className="rvm-line">Showing the {PICKER_LIMIT} newest. Search or pick a bank.</p>
      ) : null}
    </div>
  );

  const autoChoice: Choice<string> =
    source === 'several'
      ? { value: AUTO, label: 'Automatic', hint: 'Each own bank', icon: Layers, tone: 'sun' }
      : source === 'highlight'
        ? {
            value: AUTO,
            label: 'Automatic',
            hint: chosenItem?.banks[0]?.name ?? 'General',
            icon: Layers,
            tone: 'sun',
          }
        : {
            value: AUTO,
            label: 'General',
            hint: deckList.length === 0 ? 'Made for you' : 'Default deck',
            icon: Layers,
            tone: 'sun',
          };
  const finalCount = source === 'several' ? ready.length : count;

  const STEPS: Record<StepId, WizardStep> = {
    source: {
      id: 'source',
      title: 'Start from',
      validate: () => (source ? null : 'Pick where to start.'),
      content: ({ error, errorId }) => (
        <ChoiceCards
          label="Start from"
          options={SOURCES}
          value={source}
          onChange={chooseSource}
          columns={3}
          invalid={Boolean(error)}
          describedBy={error ? errorId : undefined}
        />
      ),
    },
    pick: {
      id: 'pick',
      title: source === 'several' ? 'Pick highlights' : 'Pick a highlight',
      validate: () =>
        source === 'several'
          ? checked.size > 0
            ? null
            : 'Tick at least one highlight.'
          : chosenItem
            ? null
            : 'Pick a highlight.',
      content: () => picker(source === 'several'),
    },
    type: {
      id: 'type',
      title: 'Card type',
      content: (
        <>
          {source === 'highlight' && chosenItem ? (
            <div className="rvm-from">
              <Highlighter className="rvm-from__icon" aria-hidden="true" strokeWidth={2.4} />
              <p className="rvm-from__quote" dir="auto">
                {truncate(chosenItem.highlight.exactQuote, 140)}
              </p>
              {from === 'type' ? (
                <ChunkyButton
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFrom('pick');
                    setRun((r) => r + 1);
                  }}
                >
                  Change
                </ChunkyButton>
              ) : null}
            </div>
          ) : null}
          <ChoiceCards
            label="Card type"
            options={TEMPLATES.map((t) => ({
              value: t.id,
              label: t.label,
              hint: t.hint,
              icon: t.icon,
              tone: t.tone,
            }))}
            value={editor.template}
            onChange={(template) => setEditor((s) => ({ ...s, template }))}
            columns={3}
          />
        </>
      ),
    },
    write: {
      id: 'write',
      title: 'Write the card',
      validate: () => (built.ok ? null : (built.issues[0] ?? 'The card is not complete yet.')),
      content: (
        <div className="rvm-write">
          <TemplateFields
            key={`${editor.template}-${seeded ?? 'none'}`}
            state={editor}
            onChange={setEditor}
            quote={quote}
            testId={source === 'blank' ? TID.manual : undefined}
          />
          <CardPreview state={editor} built={built} count={count} />
        </div>
      ),
    },
    questions: {
      id: 'questions',
      title: 'Write questions',
      validate: () => (ready.length > 0 ? null : 'Write at least one question.'),
      content: (
        <div className="rvm-fields" data-testid={TID.bulk}>
          <p className="rvm-line">The quote becomes the answer. Untick a row to leave it out.</p>
          <ul className="rvm-fields">
            {chosen.map((it) => {
              const id = it.highlight.id;
              const off = skipped.has(id);
              return (
                <li key={id} className="rvm-kp">
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
                    <span className="rvm-pick__quote" dir="auto">
                      {truncate(it.highlight.exactQuote, 200)}
                    </span>
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
                      <p className="rvm-line">Add a question or untick this row.</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ),
    },
    deck: {
      id: 'deck',
      title: 'Pick a deck',
      content: (
        <>
          <div data-testid={TID.deckSelect}>
            <ChoiceCards
              label="Deck"
              className="rvm-compact"
              options={[
                autoChoice,
                ...deckList.map((d) => ({ value: d.id, label: d.name, icon: Layers })),
              ]}
              value={deckId || AUTO}
              onChange={(v) => setDeckId(v === AUTO ? '' : v)}
              columns={3}
            />
          </div>
          <div className="rvm-badges">
            <Pill icon={Check} tone="success">
              {plural(finalCount, 'card')} ready
            </Pill>
            {source !== 'several' ? (
              <Pill>{TEMPLATES.find((t) => t.id === editor.template)?.label}</Pill>
            ) : null}
            {source === 'several' && ready.length < bulkRows.length ? (
              <Pill tone="warning">{bulkRows.length - ready.length} left out</Pill>
            ) : null}
          </div>
          {saving ? (
            <p className="rvm-line" role="status">
              Saving…
            </p>
          ) : null}
          {saveError ? (
            <InlineNotice tone="error" title="The cards were not saved">
              {saveError}
            </InlineNotice>
          ) : null}
        </>
      ),
    },
  };
  const flow = FLOW[source ?? 'highlight'];
  const steps = flow.slice(Math.max(0, flow.indexOf(from))).map((id) => STEPS[id]);
  const dirty =
    source !== null &&
    (checked.size > 0 ||
      JSON.stringify(editor) !== JSON.stringify(initialEditorState(quote, editor.template)));

  return (
    <div className="rvm" data-testid={TID.author}>
      {done !== null ? (
        <Done
          count={done}
          another={source === 'several' ? 'Make more' : 'Make another'}
          onAnother={another}
          onRestart={restart}
        />
      ) : (
        <Wizard
          key={run}
          className="rvm-wiz"
          label="Create cards"
          steps={steps}
          dirty={dirty}
          finishLabel={
            source === 'several'
              ? `Create ${plural(ready.length, 'card')}`
              : count > 1
                ? `Create ${count} cards`
                : 'Create card'
          }
          finishIcon={Plus}
          onFinish={() => void finish()}
        />
      )}
      {source === 'highlight' && chosenItem ? (
        <Disclosure
          summary={
            <>
              <Lightbulb aria-hidden="true" width={18} height={18} />
              Knowledge points
            </>
          }
        >
          <KnowledgePointEditor highlightId={chosenItem.highlight.id} highlights={all} />
        </Disclosure>
      ) : null}
    </div>
  );
}

function Done({
  count,
  another,
  onAnother,
  onRestart,
}: {
  count: number;
  another: string;
  onAnother(): void;
  onRestart(): void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), []);
  return (
    <section className="rvm-card rvm-done" aria-labelledby="rv-made">
      <span className="rvm-done__halo">
        <VaultBuddy pose="cheer" size={140} />
      </span>
      <h2 id="rv-made" ref={title} tabIndex={-1}>
        {count === 1 ? 'Card created!' : `${count} cards created!`}
      </h2>
      <p className="rvm-line">
        {count === 1 ? 'It joins your next review.' : 'They join your next review.'}
      </p>
      <div className="rvm-done__actions">
        <ChunkyButton variant="primary" icon={Plus} onClick={onAnother}>
          {another}
        </ChunkyButton>
        <ChunkyButton icon={ListRestart} onClick={onRestart}>
          Start over
        </ChunkyButton>
      </div>
    </section>
  );
}

function PickRow({
  item,
  multi,
  checked,
  cards,
  onChange,
}: {
  item: HighlightListItem;
  multi: boolean;
  checked: boolean;
  cards: number;
  onChange(): void;
}) {
  return (
    <label className="rvm-pick" data-testid={pickerItemId(item.highlight.id)}>
      <input
        type={multi ? 'checkbox' : 'radio'}
        name={multi ? undefined : 'rv-pick'}
        className="sv-vh"
        checked={checked}
        onChange={onChange}
      />
      <span className={`rvm-pick__mark${multi ? ' rvm-pick__mark--box' : ''}`} aria-hidden="true">
        <Check strokeWidth={3.5} />
      </span>
      <span className="rvm-pick__body">
        <span className="rvm-pick__quote" dir="auto">
          {truncate(item.highlight.exactQuote, 160)}
        </span>
        <span className="rvm-badges">
          <span className="rvm-line">{item.source.title || item.source.host}</span>
          {item.banks.map((b) => (
            <Pill key={b.id}>{b.name}</Pill>
          ))}
          {cards > 0 ? (
            <Pill icon={Layers} tone="primary">
              {plural(cards, 'card')}
            </Pill>
          ) : null}
        </span>
      </span>
    </label>
  );
}
