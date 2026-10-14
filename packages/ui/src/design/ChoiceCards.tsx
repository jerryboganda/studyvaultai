import { useId, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Tone } from './motion';

export type Choice<T extends string> = {
  value: T;
  /** <= 2 words. */
  label: string;
  /** Optional meta line under the label, <= 3 words. */
  hint?: string;
  icon?: LucideIcon;
  /** Illustration instead of an icon (e.g. a mascot pose); decorative. */
  art?: ReactNode;
  tone?: Tone;
};

export type ChoiceCardsProps<T extends string> = {
  options: Choice<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Group name: a visible heading's id (preferred, e.g. the wizard step title) or a label string. */
  labelledBy?: string;
  label?: string;
  /** Most columns to use; one column below 340px. */
  columns?: 1 | 2 | 3 | 4;
  /** Wizard validation: pass WizardStepContext's error and errorId. */
  invalid?: boolean;
  describedBy?: string;
  className?: string;
};

/**
 * Picture-card radio group (one decision per wizard screen; UX_DESIGN 6.11). Native radios in a
 * fieldset, so the browser supplies the keyboard (Tab enters on the checked card, arrows move and
 * select) and forms, screen readers and forced colours all see real radios. The checked card shows
 * a check as well as the colour change.
 */
export function ChoiceCards<T extends string>({
  options,
  value,
  onChange,
  labelledBy,
  label,
  columns,
  invalid,
  describedBy,
  className,
}: ChoiceCardsProps<T>) {
  const name = useId();
  return (
    // role=radiogroup (allowed on fieldset) is what supports aria-invalid; it still has its legend.
    <fieldset
      role="radiogroup"
      className={`sv-choiceset${className ? ` ${className}` : ''}`}
      aria-labelledby={labelledBy}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      {!labelledBy && label && <legend className="sv-vh">{label}</legend>}
      <div className={`sv-choices${columns ? ` sv-choices--${columns}` : ''}`}>
        {options.map((o) => {
          const Icon = o.icon;
          return (
            <label key={o.value} className="sv-choice">
              <input
                type="radio"
                className="sv-vh"
                name={name}
                value={o.value}
                checked={o.value === value}
                onChange={() => onChange(o.value)}
              />
              <span className="sv-choice__check" aria-hidden="true">
                <Check strokeWidth={3.5} />
              </span>
              {(o.art || Icon) && (
                <span
                  className={`sv-choice__art sv-art--${o.tone ?? 'primary'}`}
                  aria-hidden="true"
                >
                  {o.art ?? (Icon && <Icon strokeWidth={2.4} />)}
                </span>
              )}
              <span className="sv-choice__text">
                <span className="sv-choice__label">{o.label}</span>
                {o.hint && <span className="sv-choice__hint">{o.hint}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
