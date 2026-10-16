import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BookA,
  Columns2,
  Eye,
  EyeOff,
  ListChecks,
  MessageCircleQuestion,
  Plus,
  Quote,
  TextCursorInput,
  Trash,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { seededRandom } from '@study';
import { buildTemplateDrafts, type TemplateName } from '@storage';
import { Button, ChunkyButton, IconButton, InfoTip, InlineNotice, type ArtTone } from '@ui';
import {
  CardFace,
  TID,
  clozeWrap,
  nextClozeIndex,
  toTemplateInput,
  type EditorState,
} from '@ui/review';
import { Disclosure } from './ManageKit';

/** The five card types as picture cards: label <= 2 words, hint <= 3 words. */
export const TEMPLATES: {
  id: TemplateName;
  label: string;
  hint: string;
  icon: LucideIcon;
  tone: ArtTone;
}[] = [
  {
    id: 'basic',
    label: 'Q and A',
    hint: 'Question, answer',
    icon: MessageCircleQuestion,
    tone: 'primary',
  },
  { id: 'cloze', label: 'Fill blank', hint: 'Hide some words', icon: TextCursorInput, tone: 'sun' },
  { id: 'definition', label: 'Term', hint: 'Term, definition', icon: BookA, tone: 'success' },
  { id: 'compare', label: 'Compare', hint: 'Side by side', icon: Columns2, tone: 'violet' },
  {
    id: 'mcq',
    label: 'Multiple choice',
    hint: 'One right option',
    icon: ListChecks,
    tone: 'warning',
  },
];

const MAX_PREVIEW = 6;

/**
 * The cards the editor would store, built by exactly the builders the repo stores with. Nothing is
 * generated: the quote seeds the cloze text; every other field is the learner's own.
 */
export function useDrafts(state: EditorState, quote: string | null) {
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
  return { input, built, count: built.ok ? built.value.length : 0 };
}

function isTouched(state: EditorState): boolean {
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
}

/**
 * The fields of one card type (the type itself is picked on the step before). Optional fields
 * sit under "More fields"; the cloze helper wraps the selected words in the text box.
 */
export function TemplateFields({
  state,
  onChange,
  quote,
  testId,
}: {
  state: EditorState;
  onChange(update: (s: EditorState) => EditorState): void;
  /** The highlight's quote, or null for a typed (free-standing) card. */
  quote: string | null;
  testId?: string;
}) {
  const uid = useId();
  const [clozeIndex, setClozeIndex] = useState('');
  const [clozeHint, setClozeHint] = useState('');
  const [wrapError, setWrapError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  /** Where the caret goes once the wrapped text is on screen (set by `wrap`, applied below). */
  const restore = useRef<{ start: number; end: number } | null>(null);
  // "More fields" opens by itself when one of them already holds something (Back keeps answers).
  const [moreOpen] = useState(
    () =>
      state.tags.trim() !== '' ||
      [state.basic.explanation, state.definition.example, state.cloze.explanation].some(
        (v) => v.trim() !== '',
      ) ||
      state.mcq.explanation.trim() !== '',
  );

  const patch = <K extends 'basic' | 'definition' | 'compare' | 'cloze' | 'mcq'>(
    key: K,
    value: Partial<EditorState[K]>,
  ) => onChange((s) => ({ ...s, [key]: { ...s[key], ...value } }));

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
    setClozeIndex('');
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

  const field = (
    name: string,
    label: string,
    value: string,
    set: (v: string) => void,
    rows?: number,
    placeholder?: string,
  ) => (
    <div className="sv-field">
      <label className="sv-label" htmlFor={`${uid}-${name}`}>
        {label}
      </label>
      {rows ? (
        <textarea
          id={`${uid}-${name}`}
          className="sv-control"
          rows={rows}
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          id={`${uid}-${name}`}
          className="sv-control"
          placeholder={placeholder}
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </div>
  );

  const tags = field(
    'tags',
    'Tags (optional)',
    state.tags,
    (v) => onChange((s) => ({ ...s, tags: v })),
    undefined,
    'Comma separated',
  );
  const more = (extra: ReactNode) => (
    <Disclosure summary="More fields" open={moreOpen}>
      {extra}
      {tags}
    </Disclosure>
  );

  return (
    <div className="rvm-fields" role="group" aria-label="Card editor" data-testid={TID.editor}>
      <div className="rvm-fields" data-testid={testId}>
        {quote ? (
          <div className="rvm-from">
            <Quote className="rvm-from__icon" aria-hidden="true" strokeWidth={2.4} />
            <blockquote className="rvm-from__quote" dir="auto">
              <span className="sv-vh">Source quote: </span>
              {quote}
            </blockquote>
            {state.template === 'basic' || state.template === 'definition' ? (
              <Button
                onClick={() =>
                  state.template === 'basic'
                    ? patch('basic', { answer: quote })
                    : patch('definition', { definition: quote })
                }
              >
                Use as answer
              </Button>
            ) : null}
          </div>
        ) : null}

        {state.template === 'basic' ? (
          <>
            {field(
              'q',
              'Question',
              state.basic.question,
              (v) => patch('basic', { question: v }),
              2,
            )}
            {field('a', 'Answer', state.basic.answer, (v) => patch('basic', { answer: v }), 3)}
            {more(
              field(
                'e',
                'Explanation (optional)',
                state.basic.explanation,
                (v) => patch('basic', { explanation: v }),
                2,
              ),
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
              3,
            )}
            {more(
              field(
                'x',
                'Example (optional)',
                state.definition.example,
                (v) => patch('definition', { example: v }),
                2,
              ),
            )}
          </>
        ) : null}

        {state.template === 'compare' ? (
          <>
            <div className="rvm-row">
              {field('l', 'First item', state.compare.left, (v) => patch('compare', { left: v }))}
              {field('r', 'Second item', state.compare.right, (v) =>
                patch('compare', { right: v }),
              )}
            </div>
            <fieldset className="rvm-fieldset">
              <legend>Aspects</legend>
              <ul className="rvm-fields">
                {state.compare.rows.map((row, i) => (
                  <li key={i} className="rvm-aspect">
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
                    {state.compare.rows.length > 1 ? (
                      <IconButton
                        icon={Trash}
                        label={`Remove aspect ${i + 1}`}
                        size="sm"
                        onClick={() =>
                          patch('compare', { rows: state.compare.rows.filter((_, j) => j !== i) })
                        }
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
              <ChunkyButton
                size="sm"
                icon={Plus}
                disabledReason={state.compare.rows.length >= 20 ? 'At most 20 aspects.' : undefined}
                onClick={() =>
                  patch('compare', {
                    rows: [...state.compare.rows, { aspect: '', left: '', right: '' }],
                  })
                }
              >
                Add aspect
              </ChunkyButton>
            </fieldset>
            {more(null)}
          </>
        ) : null}

        {state.template === 'cloze' ? (
          <>
            <div className="sv-field">
              <span className="rvm-label">
                <label className="sv-label" htmlFor={`${uid}-cloze`}>
                  Text with blanks
                </label>
                <InfoTip label="How to make blanks">
                  Select words in the box, then press Hide selection. You can also type{' '}
                  {'{{c1::answer}}'} or {'{{c1::answer::hint}}'}.
                </InfoTip>
              </span>
              <textarea
                id={`${uid}-cloze`}
                ref={area}
                className="sv-control"
                rows={5}
                data-testid={TID.clozeText}
                value={state.cloze.markup}
                onChange={(e) => patch('cloze', { markup: e.target.value })}
              />
            </div>
            <div className="rvm-row">
              <ChunkyButton icon={EyeOff} data-testid={TID.clozeWrap} onClick={wrap}>
                Hide selection
              </ChunkyButton>
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
              <div className="sv-field rvm-numfield">
                <label className="sv-label" htmlFor={`${uid}-ci`}>
                  Blank number
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
            </div>
            {wrapError ? <InlineNotice tone="warning">{wrapError}</InlineNotice> : null}
            <span className="rvm-label">
              <label className="sv-check">
                <input
                  type="checkbox"
                  checked={state.cloze.perDeletion}
                  onChange={(e) => patch('cloze', { perDeletion: e.target.checked })}
                />
                <span className="sv-label">One card per blank</span>
              </label>
              <InfoTip label="About one card per blank">
                Each blank number becomes its own card, with the other blanks shown as context.
                Untick to hide every blank on a single card.
              </InfoTip>
            </span>
            {more(
              field(
                'ce',
                'Explanation (optional)',
                state.cloze.explanation,
                (v) => patch('cloze', { explanation: v }),
                2,
              ),
            )}
          </>
        ) : null}

        {state.template === 'mcq' ? (
          <>
            {field('s', 'Question', state.mcq.stem, (v) => patch('mcq', { stem: v }), 2)}
            <fieldset className="rvm-fieldset">
              <legend className="rvm-label">
                Options
                <InfoTip label="About the options">
                  Options are shuffled at every review, so you learn the answer, not its place.
                </InfoTip>
              </legend>
              <p className="rvm-line">Tick the right one.</p>
              <ul className="rvm-fields">
                {state.mcq.choices.map((text, i) => (
                  <li key={i} className="rvm-optrow">
                    <input
                      type="radio"
                      name={`${uid}-key`}
                      aria-label={`Option ${i + 1} is correct`}
                      checked={state.mcq.correctIndex === i}
                      onChange={() => patch('mcq', { correctIndex: i })}
                    />
                    <input
                      className="sv-control"
                      aria-label={`Option ${i + 1} text`}
                      placeholder={`Option ${i + 1}`}
                      value={text}
                      onChange={(e) =>
                        patch('mcq', {
                          choices: state.mcq.choices.map((c, j) => (j === i ? e.target.value : c)),
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
              <ChunkyButton
                size="sm"
                icon={Plus}
                disabledReason={state.mcq.choices.length >= 8 ? 'At most 8 options.' : undefined}
                onClick={() => patch('mcq', { choices: [...state.mcq.choices, ''] })}
              >
                Add option
              </ChunkyButton>
            </fieldset>
            {more(
              field(
                'me',
                'Explanation (optional)',
                state.mcq.explanation,
                (v) => patch('mcq', { explanation: v }),
                2,
              ),
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Live front and back of every card the fields make, or what is still missing. */
export function CardPreview({
  state,
  built,
  count,
}: {
  state: EditorState;
  built: ReturnType<typeof useDrafts>['built'];
  count: number;
}) {
  return (
    <section className="rvm-preview" aria-label="Card preview" data-testid={TID.preview}>
      <span className="rvm-preview__head">
        <Eye aria-hidden="true" strokeWidth={2.4} />
        Preview
      </span>
      {built.ok ? (
        <>
          {count > 1 ? <p className="rvm-line">{count} cards will be created.</p> : null}
          {built.value.slice(0, MAX_PREVIEW).map((draft, i) => (
            <div key={i} className="rvm-fields">
              {count > 1 ? (
                <p className="rvm-line">
                  Card {i + 1} of {count}
                  {draft.cloze?.activeIndex ? ` (hides c${draft.cloze.activeIndex})` : ''}
                </p>
              ) : null}
              <div className="rvm-pair">
                <div className="rvm-face">
                  <span className="rvm-face__side">Front</span>
                  <CardFace card={draft} reveal={false} />
                </div>
                <div className="rvm-face rvm-face--back">
                  <span className="rvm-face__side">Back</span>
                  <CardFace card={draft} reveal />
                </div>
              </div>
            </div>
          ))}
          {count > MAX_PREVIEW ? (
            <p className="rvm-line">+ {count - MAX_PREVIEW} more not shown.</p>
          ) : null}
        </>
      ) : isTouched(state) ? (
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
        <p className="rvm-line">Fill in the fields to see the card.</p>
      )}
    </section>
  );
}
