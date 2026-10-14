// Small reusable Sunny Vault components. Plain CSS classes from components.css; no inline <style>.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Flame, Info, Snowflake, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// WCAG 1.4.13: Escape dismisses hover/focus tooltips; they return once the pointer or focus moves.
if (typeof document !== 'undefined') {
  const root = document.documentElement;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') root.setAttribute('data-sv-tips-off', '');
    },
    true,
  );
  const back = () => root.removeAttribute('data-sv-tips-off');
  document.addEventListener('pointerover', back);
  document.addEventListener('focusin', back);
}

type Variant =
  'primary' | 'sun' | 'secondary' | 'ghost' | 'danger' | 'success' | 'violet' | 'warning';

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconEnd?: LucideIcon;
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
  /** Disabled controls stay focusable and say why. */
  disabledReason?: string;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconEnd: IconEnd,
  block,
  disabledReason,
  className = '',
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const tipId = useId();
  const button = (
    <button
      type="button"
      className={`sv-btn sv-btn--${variant} sv-btn--${size}${block ? ' sv-btn--block' : ''} ${className}`}
      aria-disabled={disabledReason ? true : undefined}
      aria-describedby={disabledReason ? tipId : undefined}
      onClick={disabledReason ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {Icon && <Icon aria-hidden="true" className="sv-btn__icon" strokeWidth={2.5} />}
      {children}
      {IconEnd && <IconEnd aria-hidden="true" className="sv-btn__icon" strokeWidth={2.5} />}
    </button>
  );
  if (!disabledReason) return button;
  return (
    <span className={`sv-tipwrap${block ? ' sv-tipwrap--block' : ''}`}>
      {button}
      <span role="tooltip" id={tipId} className="sv-tip">
        {disabledReason}
      </span>
    </span>
  );
}

/** Icon-only button: the label is its accessible name and its hover/focus tooltip. */
export function IconButton({
  icon: Icon,
  label,
  className = '',
  tipSide = 'bottom',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  tipSide?: 'bottom' | 'top' | 'left';
}) {
  return (
    <span className="sv-tipwrap">
      <button type="button" className={`sv-iconbtn ${className}`} aria-label={label} {...rest}>
        <Icon aria-hidden="true" strokeWidth={2.4} />
      </button>
      <span className={`sv-tip sv-tip--${tipSide}`} aria-hidden="true">
        {label}
      </span>
    </span>
  );
}

export function Badge({
  tone = 'neutral',
  icon: Icon,
  children,
  className = '',
}: {
  tone?: 'neutral' | 'primary' | 'sun' | 'success' | 'danger' | 'warning' | 'violet';
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`sv-badge sv-badge--${tone} ${className}`}>
      {Icon && <Icon aria-hidden="true" strokeWidth={2.6} />}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="sv-kbd">{children}</kbd>;
}

export function GoalRing({
  value,
  goal,
  size = 64,
  stroke = 8,
  children,
  label,
}: {
  value: number;
  goal: number;
  size?: number;
  stroke?: number;
  children?: ReactNode;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, value / goal);
  return (
    <div
      className="sv-ring"
      role="img"
      aria-label={label ?? `Daily goal: ${value} of ${goal} XP`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="sv-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        {/* Darker arc under a narrower yellow one: a 3:1 outline around the progress. */}
        {(['edge', 'value'] as const).map((part) => (
          <circle
            key={part}
            className={`sv-ring__${part}`}
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={part === 'edge' ? stroke : stroke - 3}
            strokeDasharray={`${c * pct} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ))}
      </svg>
      <div className="sv-ring__center" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}

export function Bar({
  value,
  max,
  label,
  tone = 'sun',
  size = 'md',
}: {
  value: number;
  max: number;
  label: string;
  tone?: 'sun' | 'primary' | 'success' | 'violet';
  size?: 'sm' | 'md' | 'lg';
}) {
  const pct = Math.round((Math.min(value, max) / max) * 100);
  return (
    <div
      className={`sv-bar sv-bar--${tone} sv-bar--${size}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div className="sv-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Streak({ days, size = 'md' }: { days: number; size?: 'md' | 'lg' }) {
  return (
    <span className={`sv-streak sv-streak--${size}`} role="img" aria-label={`${days}-day streak`}>
      <Flame aria-hidden="true" className="sv-streak__flame" strokeWidth={2.4} />
      <span aria-hidden="true">{days}</span>
    </span>
  );
}

export function Xp({ value, suffix = 'XP' }: { value: number | string; suffix?: string }) {
  return (
    <span className="sv-xp">
      <Zap aria-hidden="true" strokeWidth={2.6} />
      {value} {suffix}
    </span>
  );
}

export function Freezes({ held, max = 2 }: { held: number; max?: number }) {
  const name = `${held} of ${max} streak freezes`;
  return (
    <span className="sv-freezes" role="img" aria-label={name} title={name}>
      {Array.from({ length: max }, (_, i) => (
        <Snowflake
          key={i}
          aria-hidden="true"
          className={i < held ? 'is-on' : 'is-off'}
          strokeWidth={2.6}
        />
      ))}
    </span>
  );
}

/** On/off switch with a visible label. */
export function Switch({
  checked,
  onChange,
  label,
  hideLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hideLabel?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      className="sv-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="sv-switch__track" aria-hidden="true">
        <span className="sv-switch__thumb" />
      </span>
      {!hideLabel && <span className="sv-switch__label">{label}</span>}
    </button>
  );
}

/** Pressed-state chip with an icon (quick toggles). */
export function ToggleChip({
  icon: Icon,
  label,
  pressed,
  onToggle,
}: {
  icon: LucideIcon;
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="sv-tchip" aria-pressed={pressed} onClick={onToggle}>
      <span className="sv-tchip__icon" aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <span className="sv-tchip__label">{label}</span>
    </button>
  );
}

/** "(i)" button that opens a short explanation. Escape or a click outside closes it. */
export function InfoTip({
  label,
  children,
  side = 'bottom',
  align = 'center',
}: {
  label: string;
  children: ReactNode;
  side?: 'bottom' | 'top';
  align?: 'center' | 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    }
  };
  return (
    <span className="sv-info" ref={wrap} onKeyDown={onKey}>
      <button
        ref={btn}
        type="button"
        className="sv-info__btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Info aria-hidden="true" strokeWidth={2.6} />
      </button>
      <span
        id={id}
        role="note"
        className={`sv-info__pop sv-info__pop--${side} sv-info__pop--${align}`}
        hidden={!open}
      >
        {children}
        <button
          type="button"
          className="sv-info__close"
          aria-label="Close"
          onClick={() => {
            setOpen(false);
            btn.current?.focus();
          }}
        >
          <X aria-hidden="true" strokeWidth={2.6} />
        </button>
      </span>
    </span>
  );
}

/** Tab strip with roving focus (arrow keys, Home/End). */
export function useTabs<T extends string>(ids: readonly T[], initial: T) {
  const [active, setActive] = useState<T>(initial);
  const base = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent) => {
    const i = ids.indexOf(active);
    const next =
      e.key === 'ArrowRight'
        ? ids[(i + 1) % ids.length]
        : e.key === 'ArrowLeft'
          ? ids[(i - 1 + ids.length) % ids.length]
          : e.key === 'Home'
            ? ids[0]
            : e.key === 'End'
              ? ids[ids.length - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    setActive(next);
    refs.current.get(next)?.focus();
  };
  const tab = (id: T) => ({
    id: `${base}-tab-${id}`,
    role: 'tab' as const,
    'aria-selected': active === id,
    // Only the shown panel exists in the DOM, so only its tab points at it.
    'aria-controls': active === id ? `${base}-panel-${id}` : undefined,
    tabIndex: active === id ? 0 : -1,
    onClick: () => setActive(id),
    ref: (el: HTMLButtonElement | null) => {
      if (el) refs.current.set(id, el);
      else refs.current.delete(id);
    },
  });
  const panel = (id: T) => ({
    id: `${base}-panel-${id}`,
    role: 'tabpanel' as const,
    'aria-labelledby': `${base}-tab-${id}`,
    tabIndex: 0,
  });
  return { active, setActive, tab, panel, onKeyDown };
}

/** Wizard header: progress bar plus "Step n of m". */
export function WizardProgress({
  step,
  total,
  label,
}: {
  step: number;
  total: number;
  label: string;
}) {
  return (
    <div className="sv-wprog">
      <Bar value={step} max={total} label={`${label}: step ${step} of ${total}`} tone="primary" />
      <span className="sv-wprog__count" aria-hidden="true">
        {step}/{total}
      </span>
    </div>
  );
}

const CONFETTI_COLOURS = ['#ffc83d', '#2a62e5', '#ff7ab6', '#3cc48f', '#a68bff', '#ff8a33'];

/** Decorative confetti. components.css hides it under prefers-reduced-motion. */
export function Confetti({ pieces = 44 }: { pieces?: number }) {
  return (
    <div className="sv-confetti" aria-hidden="true">
      {Array.from({ length: pieces }, (_, i) => (
        <span
          key={i}
          className={`sv-confetti__bit sv-confetti__bit--${i % 3}`}
          style={{
            left: `${(i * 37) % 100}%`,
            background: CONFETTI_COLOURS[i % CONFETTI_COLOURS.length],
            animationDelay: `${(i % 11) * 0.12}s`,
            animationDuration: `${2.2 + (i % 5) * 0.35}s`,
          }}
        />
      ))}
    </div>
  );
}

/** Visually hidden live region for short announcements. */
export function Announce({ text }: { text: string }) {
  return (
    <span className="sv-vh" role="status" aria-live="polite">
      {text}
    </span>
  );
}
