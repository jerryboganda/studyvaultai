import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ChunkyButton, IconButton } from './Buttons';
import { focusables, trapTab, useModalDialog } from './modal';
import { Stepper } from './Stepper';
import { VaultBuddy } from './VaultBuddy';

export type WizardStepContext = {
  /** This step's current validation error, if any. */
  error: string | null;
  /** Put on the invalid field as aria-describedby (and set aria-invalid on it). */
  errorId: string;
};

export type WizardStep = {
  id: string;
  /** <= 3 words; becomes the step heading. */
  title: string;
  /** Runs on Next/Finish: return a message to stay on this step. */
  validate?: () => string | null | undefined;
  content: ReactNode | ((ctx: WizardStepContext) => ReactNode);
};

export type WizardProps = {
  /** Name of the flow, e.g. "New bank" (eyebrow and accessible name). */
  label: string;
  steps: WizardStep[];
  onFinish: () => void;
  finishLabel?: string;
  finishIcon?: LucideIcon;
  /** Shows the close button and lets Escape close; asks first when `dirty`. */
  onClose?: () => void;
  dirty?: boolean;
  /** `dialog` is a native modal for as long as it is mounted; focus returns to the opener. */
  variant?: 'page' | 'dialog';
  className?: string;
};

/**
 * One decision per screen: segmented progress, the step title as a heading that takes focus on
 * every step change, Back/Next/Finish, per-step validation that keeps the user on the step and
 * moves focus to the invalid field. Choices live in the parent's state, so Back keeps them.
 */
export function Wizard({
  label,
  steps,
  onFinish,
  finishLabel = 'Finish',
  finishIcon = Check,
  onClose,
  dirty = false,
  variant = 'page',
  className,
}: WizardProps) {
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const titleId = useId();
  useModalDialog(dialog); // no-op for the page variant: no <dialog> is rendered

  const step = steps[index]!;
  const last = index === steps.length - 1;

  // Focus the heading on every step change (and on open for the dialog), the safe button on confirm.
  // The page variant compares keys instead of counting runs, so StrictMode's double effect on mount
  // does not steal focus; the dialog refocuses on every run because showModal() moved focus.
  const view = `${index}:${confirming}`;
  const lastView = useRef(view);
  useEffect(() => {
    if (variant !== 'dialog' && lastView.current === view) return;
    lastView.current = view;
    (confirming ? keep : heading).current?.focus();
  }, [view, confirming, variant]);

  // After a failed Next: the invalid field if the step marked one (or the first control inside a
  // marked group, e.g. ChoiceCards), else the step's first control.
  useEffect(() => {
    if (!errorTick || !body.current) return;
    const invalid = body.current.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = invalid && (invalid.tabIndex >= 0 ? invalid : focusables(invalid)[0]);
    (target ?? focusables(body.current)[0] ?? heading.current)?.focus();
  }, [errorTick]);

  const next = () => {
    const problem = step.validate?.() || null;
    setError(problem);
    if (problem) {
      setErrorTick((t) => t + 1);
      return;
    }
    if (last) onFinish();
    else setIndex(index + 1);
  };
  const back = () => {
    setError(null);
    setIndex(index - 1);
  };
  const requestClose = () => {
    if (!onClose) return;
    if (dirty) setConfirming(true);
    else onClose();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (variant === 'dialog') trapTab(e, e.currentTarget);
    if (e.key !== 'Escape' || !onClose) return;
    e.preventDefault(); // also stops the native dialog's own cancel
    if (confirming) setConfirming(false);
    else requestClose();
  };

  // A shown error re-checks on every render, so it disappears as soon as the step is fixed.
  const shown = error ? step.validate?.() || null : null;
  const content =
    typeof step.content === 'function' ? step.content({ error: shown, errorId }) : step.content;
  const inner = (
    <>
      <div className="sv-wiz__head">
        <span className="sv-wiz__eyebrow">{label}</span>
        {onClose && <IconButton icon={X} label="Close" tipSide="left" onClick={requestClose} />}
      </div>
      <Stepper steps={steps.map((s) => s.title)} current={index} label={label} />
      {confirming ? (
        <div className="sv-wiz__confirm" role="group" aria-labelledby={titleId}>
          <VaultBuddy pose="think" size={88} />
          <h2 className="sv-wiz__title" id={titleId}>
            Discard changes?
          </h2>
          <p className="sv-wiz__line">Your choices so far will be lost.</p>
          <div className="sv-wiz__nav">
            <ChunkyButton ref={keep} variant="primary" onClick={() => setConfirming(false)}>
              Keep editing
            </ChunkyButton>
            <ChunkyButton variant="danger" onClick={onClose}>
              Discard
            </ChunkyButton>
          </div>
        </div>
      ) : (
        <>
          <h2 className="sv-wiz__title" id={titleId} ref={heading} tabIndex={-1}>
            {step.title}
          </h2>
          <div className="sv-wiz__body" ref={body}>
            {content}
          </div>
          {shown && (
            <p id={errorId} className="sv-wiz__error" role="alert">
              <CircleAlert aria-hidden="true" strokeWidth={2.6} />
              {shown}
            </p>
          )}
          <div className="sv-wiz__nav">
            <ChunkyButton
              icon={ArrowLeft}
              onClick={back}
              disabledReason={index === 0 ? 'This is the first step' : undefined}
            >
              Back
            </ChunkyButton>
            <span className="sv-wiz__spacer" />
            {last ? (
              <ChunkyButton variant="sun" icon={finishIcon} onClick={next}>
                {finishLabel}
              </ChunkyButton>
            ) : (
              <ChunkyButton variant="primary" iconEnd={ArrowRight} onClick={next}>
                Next
              </ChunkyButton>
            )}
          </div>
        </>
      )}
    </>
  );

  const cls = `sv-wiz sv-wiz--${variant}${className ? ` ${className}` : ''}`;
  if (variant === 'dialog') {
    return (
      <dialog
        ref={dialog}
        className={cls}
        aria-label={label}
        onKeyDown={onKeyDown}
        onCancel={(e) => e.preventDefault()}
      >
        {inner}
      </dialog>
    );
  }
  return (
    <section className={cls} aria-label={label} onKeyDown={onKeyDown}>
      {inner}
    </section>
  );
}
