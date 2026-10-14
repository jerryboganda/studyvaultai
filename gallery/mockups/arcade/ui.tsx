// Night Arcade building blocks. Small, reusable, accessible: every control is a real button,
// input or link with a name; colour is never the only cue; motion respects reduced-motion.
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { Check, Flame, Info, Lock, Snowflake, Zap, type LucideIcon } from 'lucide-react';
import type { HlColor } from './data';

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** True when the system asks for less motion (celebrations go calm, nothing flies). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(MOTION_QUERY);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => matchMedia(MOTION_QUERY).matches,
  );
}

type Variant = 'primary' | 'secondary' | 'ghost';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconAfter: IconAfter,
  disabledReason,
  className,
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconAfter?: LucideIcon;
  /** Disables the button and explains why (tooltip + aria-describedby). */
  disabledReason?: string;
}) {
  const tipId = useId();
  const off = Boolean(disabledReason);
  const btn = (
    <button
      type="button"
      className={`sv-btn sv-btn--${variant} sv-btn--${size}${className ? ` ${className}` : ''}`}
      aria-disabled={off || undefined}
      aria-describedby={off ? tipId : undefined}
      onClick={off ? undefined : onClick}
      {...rest}
    >
      {Icon && <Icon aria-hidden size={size === 'lg' ? 22 : 18} strokeWidth={2.5} />}
      <span>{children}</span>
      {IconAfter && <IconAfter aria-hidden size={18} strokeWidth={2.5} />}
    </button>
  );
  if (!off) return btn;
  return (
    <span className="sv-tipwrap">
      {btn}
      <span role="tooltip" id={tipId} className="sv-tip">
        {disabledReason}
      </span>
    </span>
  );
}

export function IconButton({
  label,
  icon: Icon,
  pressed,
  tip = 'above',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  /** Where the label tooltip opens; headers use 'below-end' so it stays inside the window. */
  tip?: 'above' | 'below' | 'below-end';
}) {
  return (
    <span className="sv-tipwrap">
      <button
        type="button"
        className={`sv-iconbtn${className ? ` ${className}` : ''}`}
        aria-label={label}
        aria-pressed={pressed}
        {...rest}
      >
        <Icon aria-hidden size={20} strokeWidth={2.4} />
      </button>
      <span className={`sv-tip sv-tip--${tip}`} aria-hidden>
        {label}
      </span>
    </span>
  );
}

/** Glowing progress ring. The SVG is decorative; `label` carries the value for assistive tech. */
export function Ring({
  value,
  max,
  size = 96,
  stroke = 10,
  tone = 'lime',
  label,
  children,
}: {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  tone?: 'lime' | 'pink' | 'cyan';
  label: string;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / max));
  return (
    <div
      className={`sv-ring sv-ring--${tone}`}
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable="false">
        <circle className="sv-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="sv-ring__edge"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke + 4}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <circle
          className="sv-ring__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children && (
        <div className="sv-ring__center" aria-hidden>
          {children}
        </div>
      )}
    </div>
  );
}

export function Bar({
  value,
  max,
  label,
  tone = 'lime',
  size = 'md',
}: {
  value: number;
  max: number;
  label: string;
  tone?: 'lime' | 'pink' | 'cyan' | 'xp';
  size?: 'sm' | 'md' | 'lg';
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value / max)) * 100);
  return (
    <div
      className={`sv-bar sv-bar--${tone} sv-bar--${size}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <span className="sv-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Chip({
  color,
  icon: Icon,
  children,
}: {
  color: HlColor;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span className={`sv-chip sv-c-${color}`}>
      {Icon ? (
        <Icon aria-hidden size={14} strokeWidth={2.6} />
      ) : (
        <span className="sv-chip__dot" aria-hidden />
      )}
      <span className="sv-chip__text">{children}</span>
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="sv-tag">#{children}</span>;
}

/** A badge drawn as an arcade token. Decorative; the caller prints the name and locked state. */
export function Token({
  icon: Icon,
  tone,
  earned,
  size = 64,
}: {
  icon: LucideIcon;
  tone: 'lime' | 'pink' | 'cyan' | 'gold';
  earned: boolean;
  size?: number;
}) {
  return (
    <span
      className={`sv-token sv-token--${tone}${earned ? '' : ' is-locked'}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Icon size={Math.round(size * 0.4)} strokeWidth={2.5} />
      {!earned && (
        <span className="sv-token__lock">
          <Lock size={Math.round(size * 0.2)} strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

export function Streak({ days, size = 'md' }: { days: number; size?: 'md' | 'lg' }) {
  return (
    <span className={`sv-stat sv-stat--streak sv-stat--${size}`} title={`${days} day streak`}>
      <Flame aria-hidden size={size === 'lg' ? 26 : 18} strokeWidth={2.6} />
      <span className="sv-num">{days}</span>
      <span className="sv-sr">day streak</span>
    </span>
  );
}

export function Xp({
  value,
  size = 'md',
  suffix = 'XP',
}: {
  value: number | string;
  size?: 'md' | 'lg';
  suffix?: string;
}) {
  return (
    <span className={`sv-stat sv-stat--xp sv-stat--${size}`}>
      <Zap aria-hidden size={size === 'lg' ? 24 : 18} strokeWidth={2.6} />
      <span className="sv-num">{value}</span>
      <span className="sv-stat__unit">{suffix}</span>
    </span>
  );
}

export function Freezes({ count, max = 2 }: { count: number; max?: number }) {
  return (
    <span className="sv-stat sv-stat--freeze" title={`${count} of ${max} streak freezes`}>
      <span className="sv-freezes" aria-hidden>
        {Array.from({ length: max }, (_, i) => (
          <Snowflake key={i} size={16} strokeWidth={2.6} className={i < count ? 'is-on' : ''} />
        ))}
      </span>
      <span className="sv-sr">
        {count} of {max} streak freezes
      </span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="sv-kbd">{children}</kbd>;
}

/** (i) popover for the longer explanation. Escape or a click outside closes it; focus returns. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  return (
    <span
      className="sv-info"
      ref={box}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          btn.current?.focus();
        }
      }}
    >
      <button
        ref={btn}
        type="button"
        className="sv-info__btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Info aria-hidden size={16} strokeWidth={2.6} />
      </button>
      <span id={id} className="sv-info__pop" hidden={!open}>
        {children}
      </span>
    </span>
  );
}

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
      <span className="sv-switch__track" aria-hidden>
        <span className="sv-switch__thumb">{checked && <Check size={12} strokeWidth={3.5} />}</span>
      </span>
      {!hideLabel && <span className="sv-switch__label">{label}</span>}
    </button>
  );
}

/** Icon chip that toggles: pressed state shows a filled chip and a check, not colour alone. */
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
  onToggle: () => void;
  /** Disables the chip and explains why (tooltip + aria-describedby). */
  disabledReason?: string;
}) {
  const tipId = useId();
  const off = Boolean(disabledReason);
  const on = pressed && !off;
  const chip = (
    <button
      type="button"
      className="sv-tchip"
      aria-pressed={on}
      aria-disabled={off || undefined}
      aria-describedby={off ? tipId : undefined}
      onClick={off ? undefined : onToggle}
    >
      <span className="sv-tchip__icon" aria-hidden>
        <Icon size={20} strokeWidth={2.4} />
        {on && (
          <span className="sv-tchip__check">
            <Check size={10} strokeWidth={4} />
          </span>
        )}
      </span>
      <span className="sv-tchip__label">{label}</span>
    </button>
  );
  if (!off) return chip;
  return (
    <span className="sv-tipwrap">
      {chip}
      <span role="tooltip" id={tipId} className="sv-tip">
        {disabledReason}
      </span>
    </span>
  );
}

/** Wizard progress: a chunky segmented bar plus "Step n of m" for everyone. */
export function Stepper({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <div className="sv-stepper">
      <div className="sv-stepper__segs" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={i < step ? 'is-done' : i === step ? 'is-now' : ''} />
        ))}
      </div>
      <p className="sv-stepper__text">
        <span className="sv-sr">{label}: </span>Step {step + 1} of {total}
      </p>
    </div>
  );
}

/** Confetti burst. Renders nothing under reduced motion; callers keep a calm static cue. */
export function Confetti({ pieces = 36 }: { pieces?: number }) {
  const reduced = useReducedMotion();
  if (reduced) return null;
  const colors = [
    'var(--sv-lime)',
    'var(--sv-hl-pink)',
    'var(--sv-cyan)',
    'var(--sv-xp)',
    'var(--sv-hl-violet)',
  ];
  return (
    <div className="sv-confetti" aria-hidden>
      {Array.from({ length: pieces }, (_, i) => (
        <span
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            background: colors[i % colors.length],
            animationDelay: `${(i % 9) * 70}ms`,
            animationDuration: `${1400 + ((i * 53) % 900)}ms`,
            transform: `rotate(${(i * 47) % 360}deg)`,
            width: i % 3 ? 8 : 12,
            height: i % 3 ? 14 : 8,
            borderRadius: i % 4 ? 3 : 999,
          }}
        />
      ))}
    </div>
  );
}

/** A bank as a chunky tile: icon block, name, count, due badge, known-share bar. */
export function BankTile({
  name,
  icon: Icon,
  color,
  items,
  due,
  pct,
  onClick,
}: {
  name: string;
  icon: LucideIcon;
  color: HlColor;
  items: number;
  due: number;
  pct: number;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="sv-bank__top">
        <span className="sv-bank__icon" aria-hidden>
          <Icon size={20} strokeWidth={2.4} />
        </span>
        <span className="sv-bank__name">
          {name}
          <small>{items} items</small>
        </span>
        <span className="sv-badge">{due} due</span>
      </span>
      <span className="sv-bank__prog">
        <Bar value={pct} max={100} size="sm" label={`${name}: ${pct}% known`} />
        <span className="sv-bank__pct" aria-hidden>
          {pct}%
        </span>
      </span>
    </>
  );
  const cls = `sv-bank sv-c-${color}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Short-lived status message for mockup feedback ("Side panel opened"). */
export function useFlash(ms = 2600): [string, (msg: string) => void] {
  const [msg, setMsg] = useState('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [
    msg,
    (next: string) => {
      window.clearTimeout(timer.current);
      setMsg(next);
      timer.current = window.setTimeout(() => setMsg(''), ms);
    },
  ];
}

/** Polite live region that shows the flash message as a small pill. */
export function Flash({ msg, className }: { msg: string; className?: string }) {
  return (
    <p
      role="status"
      className={`sv-flash${msg ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
    >
      {msg}
    </p>
  );
}

/** Screen-reader-only text. */
export function Sr({ children }: { children: ReactNode }) {
  return <span className="sv-sr">{children}</span>;
}
