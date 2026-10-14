import { useEffect, useId, useState } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { ChunkyButton, type ChunkyButtonProps } from '@ui';

/**
 * Small popup-only pieces of the Sunny look that the shared library does not have yet (toggle
 * chip, switch button, level emblem, logo mark). Kept here so packages/ui stays untouched.
 */

/** The brand mark (fixed colours, like the mascot). Decorative: the title next to it names it. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="pp-logo">
      <rect width="32" height="32" rx="8" fill="#2a62e5" />
      <rect x="7" y="8" width="18" height="3" rx="1.5" fill="#fff" />
      <rect x="5.5" y="13.5" width="21" height="5" rx="2" fill="#ffc83d" />
      <rect x="8.5" y="15.2" width="15" height="1.6" rx="0.8" fill="#18213b" />
      <rect x="7" y="21" width="12" height="3" rx="1.5" fill="#fff" />
    </svg>
  );
}

/** Hex level emblem with the number (UX_DESIGN 11). Named "Level 7". */
export function LevelEmblem({ level, size = 44 }: { level: number; size?: number }) {
  const digits = String(level).length;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={`Level ${level}`}
      className="pp-emblem"
    >
      <path d="M24 3 L42 13.5 V34.5 L24 45 L6 34.5 V13.5 Z" className="pp-emblem__edge" />
      <path d="M24 9.5 L36.5 16.8 V31.2 L24 38.5 L11.5 31.2 V16.8 Z" className="pp-emblem__face" />
      <text
        x="24"
        y={digits > 2 ? 28.5 : 30}
        textAnchor="middle"
        className={`pp-emblem__num pp-emblem__num--${Math.min(digits, 3)}`}
      >
        {level}
      </text>
    </svg>
  );
}

/** ChunkyButton that stays focusable and ignores clicks while its action runs. */
export function Act({ busy = false, onClick, ...rest }: ChunkyButtonProps & { busy?: boolean }) {
  return (
    <ChunkyButton {...rest} aria-busy={busy || undefined} onClick={busy ? undefined : onClick} />
  );
}

/**
 * Quick toggle (UX_DESIGN 6.5): a square tile, `aria-pressed`; pressed = blue border, soft fill,
 * solid icon tile and a check mark (never colour alone). `onToggle` writes the new value; until the
 * stored value arrives the chip shows the requested one, and a failed write (a rejected promise)
 * rolls back. The caller reports the failure.
 */
export function ToggleChip({
  icon: Icon,
  label,
  pressed,
  onToggle,
  disabledReason,
}: {
  icon: LucideIcon;
  label: string;
  pressed: boolean;
  onToggle(next: boolean): Promise<unknown>;
  disabledReason?: string;
}) {
  const tipId = useId();
  const [pending, setPending] = useState<{ value: boolean; done: boolean } | null>(null);
  // A new stored value after the write finished ends the pending state (state adjusted in render).
  const [seen, setSeen] = useState(pressed);
  if (seen !== pressed) {
    setSeen(pressed);
    if (pending?.done) setPending(null);
  }
  // The "why disabled" tip: Escape hides it until the pointer or focus comes back (WCAG 1.4.13).
  const [tipOff, setTipOff] = useState(false);
  useEffect(() => {
    if (!disabledReason) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTipOff(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [disabledReason]);
  const live = pending && !(pending.done && pending.value === pressed) ? pending : null;
  const shown = live?.value ?? pressed;
  const click = () => {
    if (live || disabledReason) return;
    const next = !pressed;
    setPending({ value: next, done: false });
    onToggle(next).then(
      () => setPending((p) => p && { ...p, done: true }),
      () => setPending(null),
    );
  };
  const chip = (
    <button
      type="button"
      className="pp-tchip"
      aria-pressed={shown}
      aria-busy={live ? true : undefined}
      aria-disabled={disabledReason ? true : undefined}
      aria-describedby={disabledReason ? tipId : undefined}
      onClick={click}
    >
      <span className="pp-tchip__icon" aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <span className="pp-tchip__label">{label}</span>
      {shown && !disabledReason ? (
        <span className="pp-tchip__check" aria-hidden="true">
          <Check strokeWidth={3.5} />
        </span>
      ) : null}
    </button>
  );
  if (!disabledReason) return chip;
  return (
    <span
      className="sv-tipwrap pp-tchip-wrap"
      data-tip-off={tipOff ? '' : undefined}
      onPointerEnter={() => setTipOff(false)}
      onFocus={() => setTipOff(false)}
    >
      {chip}
      <span role="tooltip" id={tipId} className="sv-tip sv-tip--top">
        {disabledReason}
      </span>
    </span>
  );
}

/**
 * On/off switch for an action that takes a moment (UX_DESIGN 6.17): `role="switch"`, the thumb
 * position is the non-colour cue, the label sits to the right. While `busy` it shows the requested
 * position; when the action ends it shows `checked` again, so a failure rolls back by itself.
 * `onToggle` runs inside the click (a Chrome permission prompt needs the gesture).
 */
export function SwitchButton({
  checked,
  label,
  busy,
  onToggle,
}: {
  checked: boolean;
  label: string;
  busy: boolean;
  onToggle(next: boolean): void;
}) {
  const [want, setWant] = useState<boolean | null>(null);
  const shown = busy && want !== null ? want : checked;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      aria-busy={busy || undefined}
      className="pp-switch"
      onClick={() => {
        if (busy) return;
        setWant(!checked);
        onToggle(!checked);
      }}
    >
      <span className="pp-switch__track" aria-hidden="true">
        <span className="pp-switch__thumb" />
      </span>
      <span className="pp-switch__label">{label}</span>
    </button>
  );
}
