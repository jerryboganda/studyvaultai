import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@ui';
import type { Parsed } from './rulesModel';

/**
 * Chip inputs of the filing-rules form: a list of values with a remove button each, and a field that
 * adds more. The value is validated when it is added, and the reason it was refused is written under
 * the field. Free text and picked ids look the same to a reader: a chip with a remove button.
 */

function Chips({
  label,
  chips,
  onRemove,
}: {
  label: string;
  chips: ReadonlyArray<{ value: string; text: string }>;
  onRemove(value: string): void;
}) {
  if (chips.length === 0) return null;
  return (
    <ul className="rule-chips" aria-label={`${label}, ${chips.length} added`}>
      {chips.map((chip) => (
        <li key={chip.value} className="sv-badge rule-chip">
          <span dir="auto" className="sv-wrap">
            {chip.text}
          </span>
          <button
            type="button"
            className="rule-chip__x"
            aria-label={`Remove ${chip.text}`}
            onClick={() => onRemove(chip.value)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function ChipInput({
  label,
  hint,
  values,
  onChange,
  parse,
  max,
  placeholder,
  addLabel = 'Add',
  testId,
}: {
  label: string;
  hint?: string;
  values: readonly string[];
  onChange(next: string[]): void;
  /** What was typed, as the value(s) to add, or why it cannot be. */
  parse(raw: string): Parsed;
  max: number;
  placeholder?: string;
  addLabel?: string;
  testId: string;
}) {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = (): void => {
    if (text.trim() === '') {
      setProblem('Type something to add first.');
      return;
    }
    const parsed = parse(text);
    if (!parsed.ok) {
      setProblem(parsed.message);
      return;
    }
    const fresh = parsed.values.filter((v) => !values.some((x) => same(x, v)));
    if (fresh.length === 0) {
      setProblem('That is already in the list.');
      return;
    }
    if (values.length + fresh.length > max) {
      setProblem(`You can add at most ${max} entries here.`);
      return;
    }
    onChange([...values, ...fresh]);
    setText('');
    setProblem(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return;
    // Enter adds the chip. It must not also submit the dialog's form.
    e.preventDefault();
    add();
  };

  return (
    <div className="sv-field" data-testid={testId}>
      <label className="sv-label" htmlFor={`${uid}-in`}>
        {label}
      </label>
      {hint ? (
        <p id={`${uid}-hint`} className="sv-small sv-muted">
          {hint}
        </p>
      ) : null}
      <Chips
        label={label}
        chips={values.map((v) => ({ value: v, text: v }))}
        onRemove={(value) => {
          onChange(values.filter((v) => v !== value));
          input.current?.focus();
        }}
      />
      <div className="sv-row">
        <input
          ref={input}
          id={`${uid}-in`}
          className="sv-control rule-chip-input"
          type="text"
          dir="auto"
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={placeholder}
          aria-invalid={problem ? true : undefined}
          aria-describedby={
            [hint ? `${uid}-hint` : null, problem ? `${uid}-problem` : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          onKeyDown={onKeyDown}
        />
        <Button
          onClick={add}
          disabledReason={values.length >= max ? `At most ${max} entries are allowed.` : undefined}
        >
          {addLabel}
        </Button>
      </div>
      {problem ? (
        <p id={`${uid}-problem`} role="alert" className="rule-problem sv-small">
          Error: {problem}
        </p>
      ) : null}
    </div>
  );
}

export function ChipPicker({
  label,
  hint,
  values,
  onChange,
  options,
  nameOf,
  max,
  addLabel = 'Add',
  emptyText,
  testId,
}: {
  label: string;
  hint?: string;
  values: readonly string[];
  onChange(next: string[]): void;
  options: ReadonlyArray<{ value: string; text: string }>;
  /** The text of a chosen value, also when it is not among the options any more. */
  nameOf(value: string): string;
  max: number;
  addLabel?: string;
  /** Said when there is nothing to choose from at all. */
  emptyText: string;
  testId: string;
}) {
  const uid = useId();
  const select = useRef<HTMLSelectElement>(null);
  const [choice, setChoice] = useState('');
  const rest = options.filter((o) => !values.includes(o.value));
  const picked = rest.some((o) => o.value === choice) ? choice : '';

  return (
    <div className="sv-field" data-testid={testId}>
      <label className="sv-label" htmlFor={`${uid}-pick`}>
        {label}
      </label>
      {hint ? <p className="sv-small sv-muted">{hint}</p> : null}
      <Chips
        label={label}
        chips={values.map((v) => ({ value: v, text: nameOf(v) }))}
        onRemove={(value) => {
          onChange(values.filter((v) => v !== value));
          select.current?.focus();
        }}
      />
      {options.length === 0 ? (
        <p className="sv-small sv-muted">{emptyText}</p>
      ) : (
        <div className="sv-row">
          <select
            ref={select}
            id={`${uid}-pick`}
            className="sv-control rule-chip-input"
            value={picked}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">
              {rest.length === 0 ? 'Every tag is already added' : 'Choose a tag…'}
            </option>
            {rest.map((o) => (
              <option key={o.value} value={o.value}>
                {o.text}
              </option>
            ))}
          </select>
          <Button
            disabledReason={
              values.length >= max
                ? `At most ${max} entries are allowed.`
                : picked === ''
                  ? 'Choose a tag first.'
                  : undefined
            }
            onClick={() => {
              onChange([...values, picked]);
              setChoice('');
              select.current?.focus();
            }}
          >
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
