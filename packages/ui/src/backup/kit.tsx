import './kit.css';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ChunkyButton } from '../design/Buttons';
import { InfoTip } from '../design/InfoTip';
import { focusables } from '../design/modal';
import type { Tone } from '../design/motion';
import { Stepper } from '../design/Stepper';
import { VaultBuddy } from '../design/VaultBuddy';

/**
 * Small Sunny building blocks shared by the data settings (backup, sync, AI). They reuse the design
 * library's classes (picture cards, art tiles, badges) and add what those do not cover: a test id and
 * a disabled reason per picture card, icon facts, a chunky disclosure and a section header.
 */

/** Section header: art tile, title (h2), an optional one-line status and the (i) with the detail. */
export function SectionHead({
  icon: Icon,
  tone = 'primary',
  id,
  title,
  line,
  tip,
  tipLabel,
  children,
}: {
  icon: LucideIcon;
  tone?: Tone;
  id: string;
  title: string;
  line?: ReactNode;
  tip?: ReactNode;
  tipLabel?: string;
  /** Right side: a status chip or a switch. */
  children?: ReactNode;
}) {
  return (
    <header className="sd-head">
      <span className={`sd-tile sv-art--${tone}`} aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <div className="sd-head__text">
        <div className="sd-head__title">
          <h2 id={id}>{title}</h2>
          {tip ? (
            <InfoTip label={tipLabel ?? `About ${title.toLowerCase()}`} align="start">
              {tip}
            </InfoTip>
          ) : null}
        </div>
        {line ? <div className="sd-head__line">{line}</div> : null}
      </div>
      {children ? <div className="sd-head__side">{children}</div> : null}
    </header>
  );
}

export type ChoiceOption<T extends string> = {
  value: T;
  /** <= 2 words. */
  label: string;
  /** <= 3 words. */
  hint?: string;
  icon: LucideIcon;
  tone?: Tone;
  testId?: string;
  /** Extra description of this option (read with it), e.g. the help line of the checked card. */
  describedBy?: string;
};

/**
 * Picture-card radio group (UX_DESIGN 6.11) built on the design library's markup and classes, with a
 * test id per card (the shared ChoiceCards has none). Native radios in a fieldset: arrow keys move
 * and select, Tab enters on the checked card.
 */
export function Choices<T extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  columns,
  invalid,
  describedBy,
  name,
  testId,
}: {
  options: ChoiceOption<T>[];
  value: T | null;
  onChange(next: T): void;
  label?: string;
  labelledBy?: string;
  columns?: 1 | 2 | 3 | 4;
  invalid?: boolean;
  describedBy?: string;
  /** The radio group name; unique per page. */
  name: string;
  testId?: string;
}) {
  return (
    <fieldset
      role="radiogroup"
      className="sv-choiceset"
      aria-labelledby={labelledBy}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      {!labelledBy && label ? <legend className="sv-vh">{label}</legend> : null}
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
                data-testid={o.testId}
                aria-describedby={o.describedBy}
                onChange={() => onChange(o.value)}
              />
              <span className="sv-choice__check" aria-hidden="true">
                <Check strokeWidth={3.5} />
              </span>
              <span className={`sv-choice__art sv-art--${o.tone ?? 'primary'}`} aria-hidden="true">
                <Icon strokeWidth={2.4} />
              </span>
              <span className="sv-choice__text">
                <span className="sv-choice__label">{o.label}</span>
                {o.hint ? <span className="sv-choice__hint">{o.hint}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Status pill: icon + words (the words always say what the colour says). */
export function Chip({
  icon: Icon,
  tone = 'neutral',
  children,
  testId,
}: {
  icon?: LucideIcon;
  tone?: ChipTone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span className={`sv-badge sv-badge--${tone} sd-chip`} data-testid={testId}>
      {Icon ? <Icon aria-hidden="true" strokeWidth={2.6} /> : null}
      <span>{children}</span>
    </span>
  );
}

/** A grid of icon facts (a real <dl>: the label is the dt, the value the dd). */
export function Facts({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <dl className="sd-facts" data-testid={testId}>
      {children}
    </dl>
  );
}

export function Fact({
  icon: Icon,
  label,
  children,
  testId,
  mono,
  wide,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  testId?: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`sd-fact${wide ? ' sd-fact--wide' : ''}`}>
      <dt>
        <Icon aria-hidden="true" strokeWidth={2.4} />
        {label}
      </dt>
      <dd className={mono ? 'sd-mono' : undefined} data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** Chunky disclosure for the advanced and rarely needed parts. */
export function Disclosure({
  summary,
  icon: Icon,
  children,
  testId,
  open,
  onToggle,
}: {
  summary: ReactNode;
  icon?: LucideIcon;
  children: ReactNode;
  testId?: string;
  open?: boolean;
  onToggle?(open: boolean): void;
}) {
  return (
    <details
      className="sd-more"
      data-testid={testId}
      open={open}
      onToggle={onToggle ? (e) => onToggle(e.currentTarget.open) : undefined}
    >
      <summary>
        {Icon ? <Icon aria-hidden="true" strokeWidth={2.4} className="sd-more__icon" /> : null}
        <span className="sd-more__label">{summary}</span>
        <ChevronDown aria-hidden="true" strokeWidth={2.6} className="sd-more__chev" />
      </summary>
      <div className="sd-more__body">{children}</div>
    </details>
  );
}

/**
 * Result screen of a flow: the mascot (cheer for success, think otherwise), a title that takes focus
 * when it appears (so the screen reader hears the outcome and focus never falls to <body>), one line.
 */
export function Outcome({
  pose = 'cheer',
  title,
  line,
  focus = true,
}: {
  pose?: 'cheer' | 'think' | 'sleep' | 'wave';
  title: string;
  line?: ReactNode;
  focus?: boolean;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <div className="sd-outcome">
      <div className="sd-outcome__head">
        <VaultBuddy pose={pose} size={88} />
        <div className="sd-outcome__text">
          <h3 ref={ref} tabIndex={-1} className="sd-outcome__title">
            {title}
          </h3>
          {line ? <div className="sd-outcome__line">{line}</div> : null}
        </div>
      </div>
    </div>
  );
}

export type FlowStep = {
  id: string;
  /** <= 3 words; the step heading. */
  title: string;
  /** Runs on Next / Finish: a message keeps the person on this step. */
  validate?: () => string | null | undefined;
  /** The content shows the error itself, under the field it names (<StepError>). */
  inlineError?: boolean;
  content: ReactNode | ((ctx: { error: string | null; errorId: string }) => ReactNode);
};

/**
 * Inline step flow with the design library's wizard look (UX_DESIGN 6.9): progress "2/4", one
 * decision per step, the step title takes focus on every step change, Next validates and moves focus
 * to the invalid field, Back keeps every answer (the answers live in the parent). Unlike the shared
 * Wizard it puts test ids on Next and the final verb, can show that verb busy, and lets a review step
 * jump back to an earlier one (`index` is controlled by the parent).
 */
export function StepFlow({
  label,
  steps,
  index,
  onIndex,
  finish,
  testId,
  autoFocus = false,
}: {
  label: string;
  steps: FlowStep[];
  index: number;
  onIndex(next: number): void;
  finish: {
    label: string;
    icon?: LucideIcon;
    onClick(): void;
    testId?: string;
    busy?: boolean;
  };
  testId?: string;
  /** Focus the step title on mount too: the flow came back after the screen that replaced it. */
  autoFocus?: boolean;
}) {
  const at = Math.min(index, steps.length - 1);
  const step = steps[at]!;
  const last = at === steps.length - 1;
  const [error, setError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const errorId = useId();

  // Focus the step title when the step changes (on mount only when asked: the flow sits in a page).
  const lastStep = useRef(autoFocus ? '' : step.id);
  useEffect(() => {
    if (lastStep.current === step.id) return;
    lastStep.current = step.id;
    heading.current?.focus();
  }, [step.id]);

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
    if (last) finish.onClick();
    else onIndex(at + 1);
  };
  const back = () => {
    setError(null);
    onIndex(at - 1);
  };

  // A shown error re-checks on every render, so it goes away as soon as the step is fixed.
  const shown = error ? step.validate?.() || null : null;
  const content =
    typeof step.content === 'function' ? step.content({ error: shown, errorId }) : step.content;
  const FinishIcon = finish.icon ?? Check;

  return (
    <section className="sv-wiz sv-wiz--page sd-flow" aria-label={label} data-testid={testId}>
      <div className="sv-wiz__head">
        <span className="sv-wiz__eyebrow">{label}</span>
      </div>
      <Stepper steps={steps.map((s) => s.title)} current={at} label={label} />
      <h3 className="sv-wiz__title" ref={heading} tabIndex={-1}>
        {step.title}
      </h3>
      <div className="sv-wiz__body" ref={body}>
        {content}
      </div>
      {shown && !step.inlineError ? <StepError id={errorId}>{shown}</StepError> : null}
      <div className="sv-wiz__nav">
        <ChunkyButton
          icon={ArrowLeft}
          onClick={back}
          disabledReason={at === 0 ? 'This is the first step' : undefined}
          data-testid={testId ? `${testId}-back` : undefined}
        >
          Back
        </ChunkyButton>
        <span className="sv-wiz__spacer" />
        {last ? (
          <ChunkyButton
            variant="sun"
            icon={FinishIcon}
            aria-busy={finish.busy || undefined}
            data-testid={finish.testId}
            onClick={finish.busy ? undefined : next}
          >
            {finish.label}
          </ChunkyButton>
        ) : (
          <ChunkyButton
            variant="primary"
            iconEnd={ArrowRight}
            data-testid={testId ? `${testId}-next` : undefined}
            onClick={next}
          >
            Next
          </ChunkyButton>
        )}
      </div>
    </section>
  );
}

/** A wizard step's error, under the field it names (UX_DESIGN 6.9); `id` is the step's errorId. */
export function StepError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="sv-wiz__error" role="alert">
      <CircleAlert aria-hidden="true" strokeWidth={2.6} />
      {children}
    </p>
  );
}

/** A file picker as a big drop card: picture, title, and the input's label styled as a button. */
export function FilePick({
  id,
  title,
  line,
  accept,
  icon: Icon,
  tone = 'primary',
  testId,
  dropTestId,
  disabled,
  describedBy,
  pickLabel = 'Choose file',
  onFile,
  children,
}: {
  id: string;
  title: string;
  line?: ReactNode;
  accept: string;
  icon: LucideIcon;
  tone?: Tone;
  testId: string;
  dropTestId?: string;
  disabled?: boolean;
  describedBy?: string;
  pickLabel?: string;
  onFile(file: File | undefined): void;
  children?: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`sd-drop${dragging ? ' sd-drop--active' : ''}`}
      data-testid={dropTestId}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled) onFile(e.dataTransfer?.files?.[0]);
      }}
    >
      <span className={`sd-drop__art sv-art--${tone}`} aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <p className="sd-drop__title">{title}</p>
      {line ? <p className="sd-line">{line}</p> : null}
      <input
        id={id}
        type="file"
        className="sv-vh"
        accept={accept}
        disabled={disabled}
        aria-describedby={describedBy}
        data-testid={testId}
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = '';
          onFile(picked);
        }}
      />
      <label
        htmlFor={id}
        className="sv-chunky sv-chunky--primary sv-chunky--md sd-drop__pick"
        aria-disabled={disabled || undefined}
      >
        {pickLabel}
      </label>
      {children}
    </div>
  );
}

/** Count tiles ("12 Highlights"), for what a file holds or what a restore wrote. */
export function Counts({
  items,
  testId,
}: {
  items: { label: string; value: number }[];
  testId?: string;
}) {
  return (
    <ul className="sd-counts" data-testid={testId}>
      {items.map((i) => (
        <li key={i.label}>
          <span>{i.label}</span>
          <span>{i.value}</span>
        </li>
      ))}
    </ul>
  );
}
