import {
  useEffect,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { Check, Power, type LucideIcon } from 'lucide-react';
import { IconButton, InfoTip, VaultBuddy, type ArtTone, type ChunkyButtonProps } from '@ui';
import './more.css';

/**
 * Small pieces shared by the dashboard's "More" views (duplicates, trash, storage, chat, graph,
 * syllabus, rules): the view header, a quiet loading state, icon actions that say why they cannot
 * run, chips and toggle pills. Built here, not in @ui, because the shared library is frozen while
 * the surfaces are restyled.
 */

/** Title row of a More view: art tile, title, (i), an optional count chip and the main actions. */
export function ViewHead({
  icon: Icon,
  tone = 'primary',
  title,
  titleId,
  titleRef,
  info,
  infoLabel,
  count,
  off,
  children,
}: {
  icon: LucideIcon;
  tone?: ArtTone;
  title: string;
  titleId: string;
  /** The title can take focus (tabindex -1) when the control that had it goes away. */
  titleRef?: RefObject<HTMLHeadingElement | null>;
  /** Detail kept out of the screen (at most three short sentences). */
  info?: ReactNode;
  infoLabel?: string;
  /** A short count such as "3 rules"; read as part of the header. */
  count?: string;
  /** The feature is switched off: an "Off" badge beside the title. */
  off?: boolean;
  /** The view's main action(s), at the end of the row. */
  children?: ReactNode;
}) {
  return (
    <header className="mv-head">
      <span className={`mv-head__art sv-art--${tone}`} aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <h2 id={titleId} className="mv-head__title" ref={titleRef} tabIndex={-1}>
        {title}
      </h2>
      {info ? <InfoTip label={infoLabel ?? `About ${title.toLowerCase()}`}>{info}</InfoTip> : null}
      {count ? <span className="mv-chip mv-chip--count">{count}</span> : null}
      {off ? (
        <span className="mv-chip mv-chip--neutral">
          <Power aria-hidden="true" strokeWidth={2.4} />
          Off
        </span>
      ) : null}
      {children ? <div className="mv-head__actions">{children}</div> : null}
    </header>
  );
}

/**
 * Illustrated empty state (the shared BuddyEmptyState look) whose one action can carry a test id:
 * a view shows its main button here while the list is empty, and in the header otherwise.
 */
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action: { label: string; icon: LucideIcon; onClick(): void; testId: string };
}) {
  return (
    <div className="sv-emptystate">
      <VaultBuddy pose="sleep" size={120} />
      <h3 className="sv-emptystate__title">{title}</h3>
      <p className="sv-emptystate__text">{text}</p>
      <Action
        variant="primary"
        icon={action.icon}
        onClick={action.onClick}
        data-testid={action.testId}
      >
        {action.label}
      </Action>
    </div>
  );
}

/** Loading state: the thinking mascot and one line, announced politely. */
export function Loading({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="mv-loading dash-loading" role="status" data-testid={testId}>
      <VaultBuddy pose="think" size={56} />
      <span>{children}</span>
    </div>
  );
}

/**
 * Icon-only action. When it cannot run it stays focusable (aria-disabled) and its name and tooltip
 * say why, so the reason is never hover-only or hidden.
 */
export function IconAction({
  label,
  disabledReason,
  onClick,
  className,
  ...rest
}: ComponentProps<typeof IconButton> & { disabledReason?: string | undefined }) {
  return (
    <IconButton
      {...rest}
      label={disabledReason ? `${label}. ${disabledReason}` : label}
      aria-disabled={disabledReason ? true : undefined}
      className={`mv-ibtn${className ? ` ${className}` : ''}`}
      onClick={disabledReason ? undefined : onClick}
    />
  );
}

/**
 * ChunkyButton whose element stays the same when it becomes unavailable and back: the shared one
 * swaps in a wrapper for its tooltip, which re-creates the <button> and drops keyboard focus when a
 * click makes it busy. The reason is the hover/focus tooltip and the description; Escape hides it.
 */
export function Action({
  disabledReason,
  onClick,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconEnd: IconEnd,
  block,
  className,
  children,
  ...rest
}: Omit<ChunkyButtonProps, 'disabledReason'> & {
  disabledReason?: string | undefined;
}) {
  const id = useId();
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (!disabledReason) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !off) {
        // Only when this tip is showing: the wrapper has the pointer or the focus.
        const wrap = document.getElementById(id)?.parentElement;
        if (!wrap?.matches(':hover, :focus-within')) return;
        e.preventDefault();
        e.stopPropagation();
        setOff(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [disabledReason, off, id]);
  return (
    <span
      className={`sv-tipwrap${block ? ' sv-tipwrap--block' : ''}`}
      data-tip-off={off ? '' : undefined}
      onPointerEnter={() => setOff(false)}
      onFocus={() => setOff(false)}
    >
      {/* ChunkyButton's own markup and classes (it would override aria-disabled). */}
      <button
        type="button"
        {...rest}
        className={`sv-chunky sv-chunky--${variant} sv-chunky--${size}${block ? ' sv-chunky--block' : ''}${className ? ` ${className}` : ''}`}
        aria-disabled={disabledReason ? true : undefined}
        aria-describedby={disabledReason ? id : rest['aria-describedby']}
        onClick={disabledReason ? (e) => e.preventDefault() : onClick}
      >
        {Icon ? <Icon aria-hidden="true" className="sv-chunky__icon" strokeWidth={2.5} /> : null}
        {children}
        {IconEnd ? (
          <IconEnd aria-hidden="true" className="sv-chunky__icon" strokeWidth={2.5} />
        ) : null}
      </button>
      {disabledReason ? (
        <span role="tooltip" id={id} className="sv-tip sv-tip--top">
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A link drawn as an icon button (opens a page in a new tab): the name is its label and the
 * hover/focus tooltip repeats it; Escape hides the tooltip until the pointer or focus comes back.
 */
export function IconLink({
  icon: Icon,
  label,
  href,
  tipSide = 'bottom',
  className,
}: {
  icon: LucideIcon;
  label: string;
  href: string;
  tipSide?: 'bottom' | 'top' | 'left' | 'right';
  className?: string;
}) {
  const id = useId();
  const [off, setOff] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || off) return;
      const wrap = document.getElementById(id)?.parentElement;
      if (!wrap?.matches(':hover, :focus-within')) return;
      e.preventDefault();
      e.stopPropagation();
      setOff(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [off, id]);
  return (
    <span
      className="sv-tipwrap"
      data-tip-off={off ? '' : undefined}
      onPointerEnter={() => setOff(false)}
      onFocus={() => setOff(false)}
    >
      <a
        id={id}
        className={`sv-ibtn sv-ibtn--md mv-ibtn${className ? ` ${className}` : ''}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
      >
        <Icon aria-hidden="true" strokeWidth={2.4} />
      </a>
      <span className={`sv-tip sv-tip--${tipSide}`} aria-hidden="true">
        {label}
      </span>
    </span>
  );
}

/** Pill with an optional icon. `prefix` is read by screen readers only ("Site: example.com"). */
export function Chip({
  icon: Icon,
  tone,
  prefix,
  children,
  className,
}: {
  icon?: LucideIcon;
  tone?: 'primary' | 'sun' | 'success' | 'danger' | 'warning' | 'violet' | 'neutral';
  prefix?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`mv-chip${tone ? ` mv-chip--${tone}` : ''}${className ? ` ${className}` : ''}`}
    >
      {Icon ? <Icon aria-hidden="true" strokeWidth={2.4} /> : null}
      {prefix ? <span className="sv-vh">{prefix}: </span> : null}
      <span className="mv-chip__text">{children}</span>
    </span>
  );
}

/**
 * A set of toggle pills: native checkboxes (so roles, names and forms stay real) drawn as chips with
 * a check mark when on, so the state is never colour only.
 */
export function TogglePills<T extends string>({
  legend,
  hideLegend,
  options,
  values,
  onChange,
  testId,
  max,
}: {
  legend: string;
  hideLegend?: boolean;
  options: ReadonlyArray<{ value: T; label: ReactNode; glyph?: string; disabled?: boolean }>;
  values: readonly T[];
  onChange(next: T[]): void;
  testId?: string;
  max?: number;
}) {
  const atMax = max !== undefined && values.length >= max;
  return (
    <fieldset className="mv-pills" data-testid={testId}>
      <legend className={hideLegend ? 'sv-vh' : 'mv-label'}>{legend}</legend>
      <div className="mv-pills__list">
        {options.map((o) => {
          const on = values.includes(o.value);
          return (
            <label key={o.value} className="mv-pill" data-on={on ? '' : undefined}>
              <input
                type="checkbox"
                className="sv-vh"
                checked={on}
                disabled={(o.disabled || (atMax && !on)) ?? false}
                onChange={() =>
                  onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])
                }
              />
              <span className="mv-pill__tick" aria-hidden="true" />
              {o.glyph ? (
                <span className="mv-pill__glyph" aria-hidden="true">
                  {o.glyph}
                </span>
              ) : null}
              <span dir="auto">{o.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Picture cards that can be picked together (native checkboxes, the look of ChoiceCards): for a
 * wizard step where more than one answer applies.
 */
export function CheckCards<T extends string>({
  label,
  options,
  values,
  onChange,
  invalid,
  describedBy,
  testId,
  columns,
}: {
  label: string;
  options: ReadonlyArray<{
    value: T;
    label: string;
    hint?: string;
    icon: LucideIcon;
    tone?: ArtTone;
  }>;
  values: readonly T[];
  onChange(next: T[]): void;
  invalid?: boolean;
  describedBy?: string;
  testId?: string;
  /** Most columns to use (one column below 340 px), as in ChoiceCards. */
  columns?: 2 | 3 | 4;
}) {
  return (
    <fieldset
      className="sv-choiceset"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      <legend className="sv-vh">{label}</legend>
      <div className={`sv-choices${columns ? ` sv-choices--${columns}` : ''}`}>
        {options.map((o) => {
          const Icon = o.icon;
          const on = values.includes(o.value);
          return (
            <label key={o.value} className="sv-choice">
              <input
                type="checkbox"
                className="sv-vh"
                value={o.value}
                checked={on}
                onChange={() =>
                  onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])
                }
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

/** A segmented choice of a few options (native radios). */
export function Segments<T extends string | number>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: ReadonlyArray<{ value: T; label: string; testId?: string }>;
  value: T;
  onChange(next: T): void;
}) {
  const name = useId();
  return (
    <fieldset className="mv-seg">
      <legend className="sv-vh">{legend}</legend>
      {options.map((o) => (
        <label key={String(o.value)} className="mv-seg__opt">
          <input
            type="radio"
            className="sv-vh"
            name={name}
            checked={o.value === value}
            data-testid={o.testId}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
