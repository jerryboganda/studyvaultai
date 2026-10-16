import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Hover/focus tooltips (WCAG 1.4.13): while the tip shows, Escape hides it and stops there (a
 * dialog around it keeps its own Escape for the next press); it comes back when the pointer
 * re-enters or the control is focused again. The tip is part of the hover area (components.css
 * bridges the gap), so the pointer can move onto it.
 */
function useTip(enabled: boolean) {
  const [off, setOff] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const shown = enabled && (hovered || focused) && !off;
  useEffect(() => {
    if (!shown) return undefined;
    // Capture on the document: runs before React's root listener and covers hover with focus elsewhere.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOff(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [shown]);
  return {
    wrap: {
      'data-tip-off': off ? '' : undefined,
      onPointerEnter: () => {
        setHovered(true);
        setOff(false);
      },
      onPointerLeave: () => setHovered(false),
    },
    // On the control itself: focus events do not bubble under Preact.
    control: {
      onFocus: () => {
        setFocused(true);
        setOff(false);
      },
      onBlur: () => setFocused(false),
    },
  };
}

export type ChunkyVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'sun';

export type ChunkyButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  variant?: ChunkyVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconEnd?: LucideIcon;
  block?: boolean;
  /** Disabled controls stay focusable and say why (no dead controls). */
  disabledReason?: string;
};

/** Chunky 3D button: a darker bottom edge that presses down on click. */
export const ChunkyButton = forwardRef<HTMLButtonElement, ChunkyButtonProps>(function ChunkyButton(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    iconEnd: IconEnd,
    block,
    disabledReason,
    className,
    children,
    onClick,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const tipId = useId();
  const tip = useTip(Boolean(disabledReason));
  const classes = ['sv-chunky', `sv-chunky--${variant}`, `sv-chunky--${size}`];
  if (block) classes.push('sv-chunky--block');
  if (className) classes.push(className);
  const button = (
    <button
      type="button"
      {...rest}
      ref={ref}
      className={classes.join(' ')}
      aria-disabled={disabledReason ? true : undefined}
      aria-describedby={disabledReason ? tipId : rest['aria-describedby']}
      onClick={disabledReason ? (e) => e.preventDefault() : onClick}
      onFocus={(e) => {
        tip.control.onFocus();
        onFocus?.(e);
      }}
      onBlur={(e) => {
        tip.control.onBlur();
        onBlur?.(e);
      }}
    >
      {Icon && <Icon aria-hidden="true" className="sv-chunky__icon" strokeWidth={2.5} />}
      {children}
      {IconEnd && <IconEnd aria-hidden="true" className="sv-chunky__icon" strokeWidth={2.5} />}
    </button>
  );
  if (!disabledReason) return button;
  return (
    <span className={`sv-tipwrap${block ? ' sv-tipwrap--block' : ''}`} {...tip.wrap}>
      {button}
      <span role="tooltip" id={tipId} className="sv-tip sv-tip--top">
        {disabledReason}
      </span>
    </span>
  );
});

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  icon: LucideIcon;
  /** Required: the accessible name and the visible tooltip. */
  label: string;
  size?: 'sm' | 'md';
  tipSide?: 'bottom' | 'top' | 'left' | 'right';
};

/** Icon-only button: its label is both the accessible name and the hover/focus tooltip. */
export function IconButton({
  icon: Icon,
  label,
  size = 'md',
  tipSide = 'bottom',
  className,
  onFocus,
  onBlur,
  ...rest
}: IconButtonProps) {
  const tip = useTip(true);
  return (
    <span className="sv-tipwrap" {...tip.wrap}>
      <button
        type="button"
        {...rest}
        className={`sv-ibtn sv-ibtn--${size}${className ? ` ${className}` : ''}`}
        aria-label={label}
        onFocus={(e) => {
          tip.control.onFocus();
          onFocus?.(e);
        }}
        onBlur={(e) => {
          tip.control.onBlur();
          onBlur?.(e);
        }}
      >
        <Icon aria-hidden="true" strokeWidth={2.4} />
      </button>
      {/* The label is already the name; the tip repeats it for sighted users only. */}
      <span className={`sv-tip sv-tip--${tipSide}`} aria-hidden="true">
        {label}
      </span>
    </span>
  );
}
