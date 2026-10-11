import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { seededRandom, type Deck } from '@study';
import { buildTemplateDrafts, type TemplateInput, type TemplateName } from '@storage';
import { Button, InlineNotice, Tabs, plural } from '@ui';
import {
  CardFace,
  TID,
  clozeWrap,
  initialEditorState,
  nextClozeIndex,
  toTemplateInput,
  type EditorState,
} from '@ui/review';

const TEMPLATES: { id: TemplateName; label: string; testId: string; about: string }[] = [
  {
    id: 'basic',
    label: 'Question and answer',
    testId: TID.tplBasic,
    about: 'A question on the front, the answer on the back.',
  },
  {
    id: 'cloze',
    label: 'Fill in the blank',
    testId: TID.tplCloze,
    about: 'Hide words in the passage; each deletion number becomes its own card.',
  },
  {
    id: 'definition',
    // Not just "Definition": the tab panel takes the tab's name, and the field below it is
    // already called "Definition", which made two controls share one accessible name.
    label: 'Term and definition',
    testId: TID.tplDefinition,
    about: 'A term on the front, its definition on the back.',
  },
  {
    id: 'compare',
    label: 'Compare',
    testId: TID.tplCompare,
    about: 'Two things side by side across several aspects.',
  },
  {
    id: 'mcq',
    label: 'Multiple choice',
    testId: TID.tplMcq,
    about: 'A question with options and one correct answer.',
  },
];

const MAX_PREVIEW = 6;

/**
 * Card editor: fields per template, a live preview that is built by exactly the builders the card
 * is stored with, and (for cloze) a helper that wraps the selected text. Nothing is generated: the
 * quote is shown for reference and seeds the cloze text; every other field is the learner's own.
 */
export function TemplateEditor({
  quote,
  decks,
  autoDeckLabel,
  saving,
  error,
  initial,
  onSave,
}: {
  /** The highlight's quote, or null for a typed (free-standing) card. */
  quote: string | null;
  decks: readonly Deck[];
  /** Describes the automatic deck choice ("Cardiology"), or null when there is none. */
  autoDeckLabel: string | null;
  saving: boolean;
  error: string | null;
  initial?: Partial<EditorState>;
  /** Returns true when the cards were stored (the editor then clears itself). */
  onSave(template: TemplateInput, deckId: string | null): Promise<boolean>;
}) {
  const uid = useId();
  const [state, setState] = useState<EditorState>(() => ({
    ...initialEditorState(quote),
    ...initial,
  }));
  const [deckId, setDeckId] = useState<string>('');
  const [clozeIndex, setClozeIndex] = useState('');
  const [clozeHint, setClozeHint] = useState('');
  const [wrapError, setWrapError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  /** Where the caret goes once the wrapped text is on screen (set by `wrap`, applied below). */
  const restore = useRef<{ start: number; end: number } | null>(null);

  const input = useMemo(() => toTemplateInput(state), [state]);
  const built = useMemo(
    () =>
      buildTemplateDrafts(
        input,
        { highlightId: quote ? 'preview-only' : null, quote, knowledgePointId: null },
        { random: seededRandom(7) },
      ),
    [input, quote],
  );
  const touched = useMemo(() => {
    switch (state.template) {
      case 'basic':
        return state.basic.question.trim() !== '' || state.basic.answer.trim() !== '';
      case 'definition':
        return state.definition.term.trim() !== '' || state.definition.definition.trim() !== '';
      case 'compare':
        return state.compare.left.trim() !== '' || state.compare.right.trim() !== '';
      case 'cloze':
        return /\{\{c\d/.test(state.cloze.markup);
      case 'mcq':
        return state.mcq.stem.trim() !== '' || state.mcq.choices.some((c) => c.trim() !== '');
    }
  }, [state]);

  const patch = <K extends 'basic' | 'definition' | 'compare' | 'cloze' | 'mcq'>(
    key: K,
    value: Partial<EditorState[K]>,
  ) => setState((s) => ({ ...s, [key]: { ...s[key], ...value } }));

  const draftCount = built.ok ? built.value.length : 0;
  const disabledReason = built.ok
    ? undefined
    : (built.issues[0] ?? 'The card is not complete yet.');

  const wrap = () => {
    const el = area.current;
    if (!el) return;
    const parsed = Number(clozeIndex);
    const index = clozeIndex.trim() === '' ? nextClozeIndex(state.cloze.markup) : parsed;
    const out = clozeWrap(state.cloze.markup, el.selectionStart, el.selectionEnd, index, clozeHint);
    if (!out.ok) {
      setWrapError(out.error);
      return;
    }
    setWrapError(null);
    restore.current = { start: out.selectionStart, end: out.selectionEnd };
    patch('cloze', { markup: out.text });
    setClozeHint('');
  };

  // Placed right after the new text is committed, not in an animation frame: a later selection
  // (by a person, a screen reader or a script) must never be overwritten by a late callback, which
  // would wrap the wrong words (the nested {{c1::{{c2::...}}}} markup seen in CI).
  useLayoutEffect(() => {
    const target = restore.current;
    const el = area.current;
    if (!target || !el) return;
    restore.current = null;
    el.focus();
    el.setSelectionRange(target.start, target.end);
  }, [state.cloze.markup]);

  const save = async () => {
    if (!built.ok || busy) return;
    setBusy(true);
    try {
      const stored = await onSave(input, deckId === '' ? null : deckId);
      if (stored) {
        setState((s) => ({ ...initialEditorState(quote, s.template), tags: s.tags }));
        setClozeIndex('');
        setClozeHint('');
      }
    } finally {
      setBusy(false);
    }
  };

  const tpl = TEMPLATES.find((t) => t.id === state.template) ?? TEMPLATES[0]!;
  const field = (
    name: string,
    label: string,
    value: string,
    set: (v: string) => void,
    opts: { rows?: number; hint?: string } = {},
  ) => (
    <div className="sv-field">
      <label className="sv-label" htmlFor={`${uid}-${name}`}>
        {label}
      </label>
      {opts.rows ? (
        <textarea
          id={`${uid}-${name}`}
          className="sv-control"
          rows={opts.rows}
          value={value}
          aria-describedby={opts.hint ? `${uid}-${name}-h` : undefined}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          id={`${uid}-${name}`}
          className="sv-control"
          value={value}
          aria-describedby={opts.hint ? `${uid}-${name}-h` : undefined}
          onChange={(e) => set(e.target.value)}
        />
      )}
      {opts.hint ? (
        <p id={`${uid}-${name}-h`} className="sv-small sv-muted">
          {opts.hint}
        </p>
      ) : null}
    </div>
  );

  return (
    <form
      className="sv-stack"
      data-testid={TID.editor}
      aria-label="Card editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabledReason) void save();
      }}
    >
      {quote ? (
        <div>
          <p className="sv-label">Source quote (read only)</p>
          <blockquote className="sv-quote">{quote}</blockquote>
          {state.template === 'basic' || state.template === 'definition' ? (
            <Button
              onClick={() =>
                state.template === 'basic'
                  ? patch('basic', { answer: quote })
                  : patch('definition', { definition: quote })
              }
            >
              Use the quote as the answer
            </Button>
          ) : null}
        </div>
      ) : null}

      <Tabs
        label="Card type"
        tabs={TEMPLATES.map((t) => ({ id: t.id, label: t.label }))}
        value={state.template}
        onChange={(id) => setState((s) => ({ ...s, template: id as TemplateName }))}
      >
        <div className="sv-stack">
          <p className="sv-small sv-muted">{tpl.about}</p>

          {state.template === 'basic' ? (
            <>
              {field(
                'q',
                'Question',
                state.basic.question,
                (v) => patch('basic', { question: v }),
                { rows: 2 },
              )}
              {field('a', 'Answer', state.basic.answer, (v) => patch('basic', { answer: v }), {
                rows: 3,
              })}
              {field(
                'e',
                'Explanation (optional)',
                state.basic.explanation,
                (v) => patch('basic', { explanation: v }),
                { rows: 2 },
              )}
            </>
          ) : null}

          {state.template === 'definition' ? (
            <>
              {field('t', 'Term', state.definition.term, (v) => patch('definition', { term: v }))}
              {field(
                'd',
                'Definition',
                state.definition.definition,
                (v) => patch('definition', { definition: v }),
                { rows: 3 },
              )}
              {field(
                'x',
                'Example (optional)',
                state.definition.example,
                (v) => patch('definition', { example: v }),
                { rows: 2 },
              )}
            </>
          ) : null}

          {state.template === 'compare' ? (
            <>
              <div className="rv-grid">
                {field('l', 'First item', state.compare.left, (v) => patch('compare', { left: v }))}
                {field('r', 'Second item', state.compare.right, (v) =>
                  patch('compare', { right: v }),
                )}
              </div>
              <fieldset className="rv-fieldset">
                <legend className="sv-label">Aspects</legend>
                <ul className="sv-stack sv-stack--tight">
                  {state.compare.rows.map((row, i) => (
                    <li key={i} className="rv-grid rv-grid--rows">
                      <input
                        className="sv-control"
                        aria-label={`Aspect ${i + 1}`}
                        placeholder="Aspect"
                        value={row.aspect}
                        onChange={(e) => {
                          const rows = state.compare.rows.map((r, j) =>
                            j === i ? { ...r, aspect: e.target.value } : r,
                          );
                          patch('compare', { rows });
                        }}
                      />
                      <input
                        className="sv-control"
                        aria-label={`Aspect ${i + 1}: ${state.compare.left || 'first item'}`}
                        placeholder={state.compare.left || 'First item'}
                        value={row.left}
                        onChange={(e) => {
                          const rows = state.compare.rows.map((r, j) =>
                            j === i ? { ...r, left: e.target.value } : r,
                          );
                          patch('compare', { rows });
                        }}
                      />
                      <input
                        className="sv-control"
                        aria-label={`Aspect ${i + 1}: ${state.compare.right || 'second item'}`}
                        placeholder={state.compare.right || 'Second item'}
                        value={row.right}
                        onChange={(e) => {
                          const rows = state.compare.rows.map((r, j) =>
                            j === i ? { ...r, right: e.target.value } : r,
                          );
                          patch('compare', { rows });
                        }}
                      />
                      <Button
                        aria-label={`Remove aspect ${i + 1}`}
                        disabledReason={
                          state.compare.rows.length <= 1 ? 'Keep at least one aspect.' : undefined
                        }
                        onClick={() =>
                          patch('compare', { rows: state.compare.rows.filter((_, j) => j !== i) })
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button
                  disabledReason={
                    state.compare.rows.length >= 20 ? 'At most 20 aspects.' : undefined
                  }
                  onClick={() =>
                    patch('compare', {
                      rows: [...state.compare.rows, { aspect: '', left: '', right: '' }],
                    })
                  }
                >
                  Add aspect
                </Button>
              </fieldset>
            </>
          ) : null}

          {state.template === 'cloze' ? (
            <>
              <div className="sv-field">
                <label className="sv-label" htmlFor={`${uid}-cloze`}>
                  Text with deletions
                </label>
                <textarea
                  id={`${uid}-cloze`}
                  ref={area}
                  className="sv-control"
                  rows={5}
                  data-testid={TID.clozeText}
                  value={state.cloze.markup}
                  aria-describedby={`${uid}-cloze-h`}
                  onChange={(e) => patch('cloze', { markup: e.target.value })}
                />
                <p id={`${uid}-cloze-h`} className="sv-small sv-muted">
                  Select a word or phrase in the box, then press &ldquo;Hide selection&rdquo;. You
                  can also type {'{{c1::answer}}'} or {'{{c1::answer::hint}}'} by hand.
                </p>
              </div>
              <div className="rv-grid rv-grid--rows">
                <div className="sv-field">
                  <label className="sv-label" htmlFor={`${uid}-ci`}>
                    Deletion number
                  </label>
                  <input
                    id={`${uid}-ci`}
                    className="sv-control"
                    inputMode="numeric"
                    data-testid={TID.clozeIndex}
                    placeholder={`next: ${nextClozeIndex(state.cloze.markup)}`}
                    value={clozeIndex}
                    onChange={(e) => setClozeIndex(e.target.value.replace(/\D/g, '').slice(0, 2))}
                  />
                </div>
                <div className="sv-field">
                  <label className="sv-label" htmlFor={`${uid}-ch`}>
                    Hint (optional)
                  </label>
                  <input
                    id={`${uid}-ch`}
                    className="sv-control"
                    data-testid={TID.clozeHint}
                    value={clozeHint}
                    onChange={(e) => setClozeHint(e.target.value)}
                  />
                </div>
                <Button data-testid={TID.clozeWrap} onClick={wrap}>
                  Hide selection
                </Button>
              </div>
              {wrapError ? <InlineNotice tone="warning">{wrapError}</InlineNotice> : null}
              <label className="sv-check">
                <input
                  type="checkbox"
                  checked={state.cloze.perDeletion}
                  onChange={(e) => patch('cloze', { perDeletion: e.target.checked })}
                />
                <span>
                  One card per deletion number (the others stay visible as context). Untick to hide
                  everything on a single card.
                </span>
              </label>
              {field(
                'ce',
                'Explanation (optional)',
                state.cloze.explanation,
                (v) => patch('cloze', { explanation: v }),
                { rows: 2 },
              )}
            </>
          ) : null}

          {state.template === 'mcq' ? (
            <>
              {field('s', 'Question', state.mcq.stem, (v) => patch('mcq', { stem: v }), {
                rows: 2,
              })}
              <fieldset className="rv-fieldset">
                <legend className="sv-label">Options (mark the correct one)</legend>
                <ul className="sv-stack sv-stack--tight">
                  {state.mcq.choices.map((text, i) => (
                    <li key={i} className="rv-row">
                      <input
                        type="radio"
                        name={`${uid}-key`}
                        aria-label={`Option ${i + 1} is correct`}
                        checked={state.mcq.correctIndex === i}
                        onChange={() => patch('mcq', { correctIndex: i })}
                      />
                      <input
                        className="sv-control sv-grow"
                        aria-label={`Option ${i + 1} text`}
                        value={text}
                        onChange={(e) =>
                          patch('mcq', {
                            choices: state.mcq.choices.map((c, j) =>
                              j === i ? e.target.value : c,
                            ),
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
                <Button
                  disabledReason={state.mcq.choices.length >= 8 ? 'At most 8 options.' : undefined}
                  onClick={() => patch('mcq', { choices: [...state.mcq.choices, ''] })}
                >
                  Add option
                </Button>
              </fieldset>
              {field(
                'me',
                'Why the answer is right (optional)',
                state.mcq.explanation,
                (v) => patch('mcq', { explanation: v }),
                { rows: 2 },
              )}
              <p className="sv-small sv-muted">
                Options are shown in a different order each time you review, so the position of the
                right answer is not what you learn.
              </p>
            </>
          ) : null}

          <div className="sv-field">
            <label className="sv-label" htmlFor={`${uid}-tags`}>
              Tags (comma separated, optional)
            </label>
            <input
              id={`${uid}-tags`}
              className="sv-control"
              value={state.tags}
              onChange={(e) => setState((s) => ({ ...s, tags: e.target.value }))}
            />
          </div>
        </div>
      </Tabs>

      <section className="rv-previews sv-stack" aria-label="Card preview" data-testid={TID.preview}>
        <h3>Preview</h3>
        {built.ok ? (
          <>
            <p className="sv-small sv-muted">{plural(draftCount, 'card')} will be created.</p>
            {built.value.slice(0, MAX_PREVIEW).map((draft, i) => (
              <div key={i} className="rv-preview-pair">
                {draftCount > 1 ? (
                  <p className="sv-label">
                    Card {i + 1} of {draftCount}
                    {draft.cloze?.activeIndex ? ` (hides c${draft.cloze.activeIndex})` : ''}
                  </p>
                ) : null}
                <div className="rv-preview-box">
                  <p className="sv-label">Question side</p>
                  <CardFace card={draft} reveal={false} />
                </div>
                <div className="rv-preview-box">
                  <p className="sv-label">Answer side (after you reveal it)</p>
                  <CardFace card={draft} reveal />
                </div>
              </div>
            ))}
            {draftCount > MAX_PREVIEW ? (
              <p className="sv-small sv-muted">+ {draftCount - MAX_PREVIEW} more not shown.</p>
            ) : null}
          </>
        ) : touched ? (
          <div data-testid={TID.previewIssues}>
            <InlineNotice tone="info" title="To finish this card">
              <ul className="rv-list">
                {built.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </InlineNotice>
          </div>
        ) : (
          <p className="sv-muted">Fill in the fields above to see the card.</p>
        )}
      </section>

      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-deck`}>
          Deck
        </label>
        <select
          id={`${uid}-deck`}
          className="sv-control"
          data-testid={TID.deckSelect}
          value={deckId}
          onChange={(e) => setDeckId(e.target.value)}
        >
          <option value="">
            {autoDeckLabel
              ? `Automatic: ${autoDeckLabel}`
              : decks.length === 0
                ? 'General (created for you)'
                : 'General'}
          </option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <InlineNotice tone="error" title="The cards were not saved">
          {error}
        </InlineNotice>
      ) : null}
      <div className="sv-row">
        <Button
          variant="primary"
          type="submit"
          data-testid={TID.saveCards}
          busy={saving || busy}
          disabledReason={disabledReason}
        >
          {draftCount > 1 ? `Create ${draftCount} cards` : 'Create card'}
        </Button>
        {disabledReason && touched ? (
          <span className="sv-small sv-muted">{disabledReason}</span>
        ) : null}
      </div>
    </form>
  );
}
