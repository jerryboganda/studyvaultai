import { useId, useRef, useState, type ReactNode } from 'react';

export interface AsyncSwitchProps {
  /** The stored value. The switch shows the requested one while a write is pending. */
  checked: boolean;
  /**
   * Writes the new value. While the returned promise is pending the switch shows `next`, is
   * `aria-busy` and says "Saving…"; when it settles (either way) it shows `checked` again, so a
   * failed write rolls back by itself. The caller shows the failure (an alert notice).
   */
  onChange(next: boolean): Promise<unknown> | void;
  label: ReactNode;
  hint?: ReactNode;
  testId?: string;
  busyText?: string;
}

/**
 * A checkbox whose change is an async write (a setting). It never snaps back while the write is
 * pending, stays focusable like a busy button, and ignores a second click until the first settles.
 */
export function AsyncSwitch({
  checked,
  onChange,
  label,
  hint,
  testId,
  busyText = 'Saving…',
}: AsyncSwitchProps) {
  const id = useId();
  const [pending, setPending] = useState<boolean | null>(null);
  const latest = useRef(0);
  const busy = pending !== null;
  const hintId = hint ? `${id}-hint` : undefined;

  const change = (next: boolean): void => {
    if (busy) return;
    const result = onChange(next);
    if (result === undefined) return;
    const mine = ++latest.current;
    setPending(next);
    const settled = () => {
      if (latest.current === mine) setPending(null);
    };
    // The caller reports a failure; here it only ends the pending state.
    result.then(settled, settled);
  };

  return (
    <div className="sv-check">
      <input
        id={id}
        type="checkbox"
        checked={pending ?? checked}
        aria-busy={busy || undefined}
        aria-describedby={hintId}
        data-testid={testId}
        onChange={(e) => change(e.target.checked)}
      />
      <div>
        <label htmlFor={id}>{label}</label>
        {/* Seen, not spoken: a write takes milliseconds and the failure is the caller's alert. */}
        {busy ? <span className="sv-muted sv-small"> {busyText}</span> : null}
        {hint ? (
          <p id={hintId} className="sv-muted sv-small">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
