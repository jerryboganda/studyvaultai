import { useId, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  COLOR_SWATCH,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  type ColorId,
  type HighlightKind,
} from '@shared';
import { rove } from './context';

interface ChoiceProps<T extends string | number> {
  label: string;
  /** Shown after the label (aria-hidden: the checked radio already says it). */
  valueText?: string;
  options: readonly T[];
  value: T;
  /** Accessible name and tooltip of an option. */
  name(option: T): string;
  render(option: T): ReactNode;
  className: string;
  /** Label and options on one row. */
  inline?: boolean;
  onChange(option: T): void;
}

/**
 * A picture radio group without <input> elements (the overlay has no inputs at all, so a page script
 * has nothing to observe): one tab stop on the checked option, arrows / Home / End move and choose
 * (WAI-ARIA APG radio group). Moves are counted from the focused option, not from `value`, which may
 * still be waiting for a write to finish.
 */
export function Choice<T extends string | number>(p: ChoiceProps<T>) {
  const id = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
    const i = radios.indexOf((e.target as Element).closest('[role="radio"]') as HTMLElement);
    const next = rove(
      e.key,
      i,
      radios.length,
      ['ArrowLeft', 'ArrowUp'],
      ['ArrowRight', 'ArrowDown'],
    );
    if (i === -1 || next === -1) return;
    e.preventDefault();
    radios[next]?.focus({ preventScroll: true });
    p.onChange(p.options[next] as T);
  };
  return (
    <div className={p.inline ? 'sv-field sv-inline' : 'sv-field'}>
      <span className="sv-label" id={id}>
        {p.label}
        {p.valueText ? (
          <span className="sv-value" aria-hidden="true">
            {p.valueText}
          </span>
        ) : null}
      </span>
      <div role="radiogroup" aria-labelledby={id} className={p.className} onKeyDown={onKeyDown}>
        {p.options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            className="sv-btn sv-radio"
            aria-checked={option === p.value}
            tabIndex={option === p.value ? 0 : -1}
            aria-label={p.name(option)}
            title={p.name(option)}
            onClick={() => p.onChange(option)}
          >
            {p.render(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A kind as a 28 px dot with a rim in its palette colour and its glyph (colour is never the only cue). */
export function KindDot({ kind, color }: { kind: HighlightKind; color: ColorId }) {
  return (
    <span
      className="sv-swatch"
      aria-hidden="true"
      style={{ '--dot': COLOR_SWATCH[color].solid } as CSSProperties}
    >
      {KIND_LABELS[kind].glyph}
    </span>
  );
}

export function KindChoice(p: {
  value: HighlightKind;
  palette: Record<HighlightKind, ColorId>;
  showValue?: boolean;
  onChange(kind: HighlightKind): void;
}) {
  return (
    <Choice
      label="Kind"
      valueText={p.showValue ? KIND_LABELS[p.value].label : undefined}
      options={HIGHLIGHT_KINDS}
      value={p.value}
      name={(k) => KIND_LABELS[k].label}
      render={(k) => <KindDot kind={k} color={p.palette[k]} />}
      className="sv-kinds"
      onChange={p.onChange}
    />
  );
}

const PRIORITIES = [1, 2, 3, 4, 5] as const;
const PRIORITY_NAMES: Record<number, string> = { 1: '1 (lowest)', 5: '5 (highest)' };

/** Priority 1-5 as numbered steps, tinted up to the chosen one (a small bar meter, styles.css). */
export function PriorityChoice(p: { value: number; onChange(priority: number): void }) {
  return (
    <Choice
      label="Priority"
      inline
      options={PRIORITIES}
      value={p.value as (typeof PRIORITIES)[number]}
      name={(n) => PRIORITY_NAMES[n] ?? String(n)}
      render={(n) => n}
      className="sv-pips"
      onChange={p.onChange}
    />
  );
}
