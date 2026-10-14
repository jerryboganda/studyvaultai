import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ChevronRight, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { IconButton, InfoTip, VaultBuddy, useModalDialog, type ArtTone, type BuddyPose } from '@ui';
import '@ui/review/manage.css';

/**
 * Small layout pieces shared by the Create, Cards and Stats views (UX_DESIGN 6): a titled card
 * with its icon tile and (i), an illustrated empty state that takes any actions, a quiet loading
 * line, a disclosure, and a side-sheet dialog. Local to the review page on purpose.
 */

export function Panel({
  icon: Icon,
  tone = 'primary',
  title,
  tip,
  end,
  testId,
  children,
  className,
}: {
  icon: LucideIcon;
  tone?: ArtTone;
  /** <= 3 words. */
  title: string;
  /** Detail kept behind (i): at most three short sentences. */
  tip?: ReactNode;
  /** Controls on the right of the title. */
  end?: ReactNode;
  testId?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      className={`rvm-card${className ? ` ${className}` : ''}`}
      aria-labelledby={id}
      data-testid={testId}
    >
      <div className="rvm-card__head">
        <span className={`rvm-art sv-art--${tone}`} aria-hidden="true">
          <Icon strokeWidth={2.4} />
        </span>
        <h2 id={id}>{title}</h2>
        {tip ? <InfoTip label={`About ${title.toLowerCase()}`}>{tip}</InfoTip> : null}
        {end ? <div className="rvm-card__end">{end}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Mascot, a title of <= 3 words, one line, and the actions the caller passes. */
export function Empty({
  pose = 'sleep',
  title,
  line,
  children,
  heading: Heading = 'h3',
}: {
  pose?: BuddyPose;
  title: string;
  line?: ReactNode;
  children?: ReactNode;
  heading?: 'h2' | 'h3';
}) {
  return (
    <div className="sv-emptystate rvm-empty">
      <VaultBuddy pose={pose} size={112} />
      <Heading className="sv-emptystate__title">{title}</Heading>
      {line ? <p className="sv-emptystate__text">{line}</p> : null}
      {children}
    </div>
  );
}

/** Loading under a second is just this line; the thinking mascot keeps it friendly, not busy. */
export function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="rvm-loading" role="status">
      <VaultBuddy pose="think" size={40} />
      {children}
    </p>
  );
}

export function Disclosure({
  summary,
  children,
  open,
  testId,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <details
      className={`rvm-disclosure${className ? ` ${className}` : ''}`}
      open={open}
      data-testid={testId}
    >
      <summary>
        <ChevronRight className="rvm-chev" aria-hidden="true" strokeWidth={2.6} />
        {summary}
      </summary>
      <div className="rvm-disclosure__body">{children}</div>
    </details>
  );
}

/**
 * Modal side sheet on the native <dialog>: the page behind is inert, Escape and the X close it,
 * focus starts on the title and returns to the opener. Mount it only while it is open.
 */
export function SideSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useModalDialog(ref);
  useEffect(() => heading.current?.focus(), []);
  return (
    <dialog
      ref={ref}
      className="rvm-sheet rvm"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault(); // the parent unmounts the sheet; closing here would desync its state
        onClose();
      }}
    >
      <div className="rvm-sheet__inner">
        <div className="rvm-sheet__head">
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <IconButton icon={X} label="Close" tipSide="left" onClick={onClose} />
        </div>
        {children}
      </div>
    </dialog>
  );
}

/**
 * A link that looks like ChunkyButton. The other review views are tabs of this page that only
 * Review.tsx can switch, so these links reload the page on the right `?view=`.
 */
export function LinkButton({
  href,
  icon: Icon,
  variant = 'primary',
  children,
}: {
  href: string;
  icon?: LucideIcon;
  variant?: 'primary' | 'secondary';
  children: ReactNode;
}) {
  return (
    <a className={`sv-chunky sv-chunky--${variant} sv-chunky--md rvm-linkbtn`} href={href}>
      {Icon ? <Icon aria-hidden="true" className="sv-chunky__icon" strokeWidth={2.5} /> : null}
      {children}
    </a>
  );
}

/** A non-interactive pill: icon + short text, tone from the status families. */
export function Pill({
  icon: Icon,
  tone,
  children,
}: {
  icon?: LucideIcon;
  tone?: 'primary' | 'sun' | 'success' | 'warning' | 'danger' | 'violet';
  children: ReactNode;
}) {
  return (
    <span className={`rvm-badge${tone ? ` rvm-badge--${tone}` : ''}`}>
      {Icon ? <Icon aria-hidden="true" strokeWidth={2.6} /> : null}
      {children}
    </span>
  );
}
