import { useId, type ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** Action in flight: stays focusable, ignores clicks, announces busy. */
  busy?: boolean;
  /**
   * Why the action is unavailable. The button stays focusable (aria-disabled) so keyboard and
   * screen-reader users can discover the reason; callers should also show it as visible text.
   */
  disabledReason?: string;
}

export function Button({
  variant = 'secondary',
  busy = false,
  disabledReason,
  onClick,
  className,
  children,
  ...rest
}: ButtonProps) {
  const reasonId = useId();
  const inert = busy || disabledReason !== undefined;
  return (
    <>
      <button
        type="button"
        {...rest}
        className={`sv-btn sv-btn--${variant}${className ? ` ${className}` : ''}`}
        aria-disabled={inert || undefined}
        aria-busy={busy || undefined}
        aria-describedby={disabledReason ? reasonId : rest['aria-describedby']}
        title={disabledReason ?? rest.title}
        onClick={inert ? undefined : onClick}
      >
        {children}
      </button>
      {disabledReason ? (
        <span id={reasonId} className="sv-sr">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}
