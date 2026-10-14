import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, ListChecks, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  ChunkyButton,
  IconButton,
  Stepper,
  VaultBuddy,
  focusables,
  trapTab,
  useModalDialog,
} from '@ui';

/**
 * The shared Wizard (packages/ui/src/design/Wizard.tsx) plus two things the "Looks good?" step of
 * UX_DESIGN 6.9 needs and the frozen shared one cannot do yet: it can open on any step (editing a
 * rule opens on its review), and a step can jump back to an earlier answer (`goTo`). After a jump
 * the forward button reads "Review": it checks every step on the way back, in order, and stops on
 * the first one that needs a fix; finishing does the same for every step before the last, so a
 * wizard that opened on its review never saves an answer an earlier step would refuse. Same markup
 * and classes as the shared Wizard, so it looks the same; candidate for @ui once the library thaws.
 */

export type JumpStepContext = {
  /** This step's current validation error, if any. */
  error: string | null;
  /** Put on the invalid field as aria-describedby (and set aria-invalid on it). */
  errorId: string;
  /** Go back to an earlier step by its id; "Review" then brings the person back here. */
  goTo(id: string): void;
};

export type JumpStep = {
  id: string;
  /** <= 3 words; becomes the step heading. */
  title: string;
  /** Runs on Next/Finish: return a message to stay on this step. */
  validate?: () => string | null | undefined;
  content: ReactNode | ((ctx: JumpStepContext) => ReactNode);
};

export function JumpWizard({
  label,
  steps,
  start = 0,
  onFinish,
  finishLabel = 'Finish',
  finishIcon = Check,
  onClose,
  dirty = false,
  className,
}: {
  /** Name of the flow (eyebrow and accessible name). */
  label: string;
  steps: JumpStep[];
  /** Step to open on (clamped). */
  start?: number;
  onFinish: () => void;
  finishLabel?: string;
  finishIcon?: LucideIcon;
  /** Shows the close button and lets Escape close; asks first when `dirty`. */
  onClose: () => void;
  dirty?: boolean;
  className?: string;
}) {
  const [index, setIndexRaw] = useState(() => Math.max(0, Math.min(start, steps.length - 1)));
  // The step a jump came from, by id: steps can come and go while the person is away from it.
  const [returnId, setReturnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const titleId = useId();
  useModalDialog(dialog);

  // Steps can come and go (a branch); the index never points past the end.
  const at = Math.min(index, steps.length - 1);
  const step = steps[at]!;
  const last = at === steps.length - 1;
  const found = returnId === null ? -1 : steps.findIndex((s) => s.id === returnId);
  const returnTo = returnId === null ? null : found < 0 ? steps.length - 1 : found;
  const reviewing = returnTo !== null && returnTo > at;

  // The heading takes focus on every step change and on open (showModal moved it); the safe
  // button takes it when "Discard changes?" shows.
  const view = `${at}:${confirming}`;
  useEffect(() => {
    (confirming ? keep : heading).current?.focus();
  }, [view, confirming]);

  // After a failed Next: the invalid field if the step marked one, else its first control.
  useEffect(() => {
    if (!errorTick || !body.current) return;
    const invalid = body.current.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = invalid && (invalid.tabIndex >= 0 ? invalid : focusables(invalid)[0]);
    (target ?? focusables(body.current)[0] ?? heading.current)?.focus();
  }, [errorTick]);

  const fail = (to: number, problem: string) => {
    setIndexRaw(to);
    setError(problem);
    setErrorTick((t) => t + 1);
  };

  const next = () => {
    const problem = step.validate?.() || null;
    if (problem) {
      fail(at, problem);
      return;
    }
    setError(null);
    if (reviewing && returnTo !== null) {
      // Every step on the way back to the review must hold, in order.
      for (let i = at + 1; i < returnTo; i += 1) {
        const p = steps[i]!.validate?.() || null;
        if (p) {
          fail(i, p);
          return;
        }
      }
      setIndexRaw(returnTo);
      setReturnId(null);
      return;
    }
    if (!last) {
      setIndexRaw(at + 1);
      return;
    }
    // A wizard that opened on its review has not checked the steps before it: the first one that
    // needs a fix is shown with its message instead of finishing.
    for (let i = 0; i < at; i += 1) {
      const p = steps[i]!.validate?.() || null;
      if (p) {
        setReturnId(step.id);
        fail(i, p);
        return;
      }
    }
    onFinish();
  };
  const back = () => {
    setError(null);
    setIndexRaw(at - 1);
  };
  const goTo = (id: string) => {
    const to = steps.findIndex((s) => s.id === id);
    if (to < 0 || to >= at) return;
    setError(null);
    // A second jump from an earlier step still comes back to the first one's step.
    if (returnTo === null || returnTo < at) setReturnId(step.id);
    setIndexRaw(to);
  };
  const requestClose = () => {
    if (dirty) setConfirming(true);
    else onClose();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    trapTab(e, e.currentTarget);
    if (e.key !== 'Escape') return;
    e.preventDefault(); // also stops the native dialog's own cancel
    if (confirming) setConfirming(false);
    else requestClose();
  };

  // A shown error re-checks on every render, so it disappears as soon as the step is fixed.
  const shown = error ? step.validate?.() || null : null;
  const content =
    typeof step.content === 'function'
      ? step.content({ error: shown, errorId, goTo })
      : step.content;

  return (
    <dialog
      ref={dialog}
      className={`sv-wiz sv-wiz--dialog${className ? ` ${className}` : ''}`}
      aria-label={label}
      onKeyDown={onKeyDown}
      onCancel={(e) => e.preventDefault()}
    >
      <div className="sv-wiz__head">
        <span className="sv-wiz__eyebrow">{label}</span>
        <IconButton icon={X} label="Close" tipSide="left" onClick={requestClose} />
      </div>
      <Stepper steps={steps.map((s) => s.title)} current={at} label={label} />
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
              disabledReason={at === 0 ? 'This is the first step' : undefined}
            >
              Back
            </ChunkyButton>
            <span className="sv-wiz__spacer" />
            {reviewing ? (
              <ChunkyButton variant="primary" icon={ListChecks} onClick={next}>
                Review
              </ChunkyButton>
            ) : last ? (
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
    </dialog>
  );
}
