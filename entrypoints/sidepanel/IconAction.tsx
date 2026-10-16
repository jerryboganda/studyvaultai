import { useEffect, useId, useState, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

export type IconActionProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'disabled' | 'children'
> & {
  icon: LucideIcon;
  /** The accessible name and the hover/focus tip. */
  label: string;
  /** Unavailable now: stays focusable (aria-disabled); the reason is in the tip and the description. */
  disabledReason?: string;
  /** Action in flight: ignores clicks and says so. */
  busy?: boolean;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
};

/**
 * The cards' small icon action. Like @ui IconButton (same classes and tip), plus an unavailable
 * state with its reason (no dead controls, UX_DESIGN 6.1) and a busy state. While the tip shows,
 * Escape hides it until the pointer or focus comes back (WCAG 1.4.13).
 */
export function IconAction({
  icon: Icon,
  label,
  disabledReason,
  busy = false,
  tipSide = 'top',
  className,
  onClick,
  ...rest
}: IconActionProps) {
  const reasonId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [off, setOff] = useState(false);
  const shown = (hovered || focused) && !off;
  useEffect(() => {
    if (!shown) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOff(true);
      // Only a tip on the focused button keeps the key; a tip under a resting pointer must not
      // swallow the Escape a focused field elsewhere (a note editor) is waiting for.
      if (!focused) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [shown, focused]);
  const inert = busy || disabledReason !== undefined;
  return (
    <span
      className="sv-tipwrap"
      data-tip-off={off ? '' : undefined}
      onPointerEnter={() => {
        setHovered(true);
        setOff(false);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        {...rest}
        className={`sv-ibtn sv-ibtn--sm sp-iact${className ? ` ${className}` : ''}`}
        aria-label={label}
        aria-disabled={inert || undefined}
        aria-busy={busy || undefined}
        aria-describedby={disabledReason ? reasonId : rest['aria-describedby']}
        onFocus={() => {
          setFocused(true);
          setOff(false);
        }}
        onBlur={() => setFocused(false)}
        onClick={inert ? undefined : onClick}
      >
        <Icon aria-hidden="true" strokeWidth={2.4} />
      </button>
      <span className={`sv-tip sv-tip--${tipSide}`} aria-hidden="true">
        {disabledReason ? (
          <>
            <strong>{label}</strong> {disabledReason}
          </>
        ) : (
          label
        )}
      </span>
      {disabledReason ? (
        <span id={reasonId} className="sv-sr">
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}
