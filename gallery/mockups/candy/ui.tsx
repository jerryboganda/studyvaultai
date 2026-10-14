// Small reusable Candy Garden components. Each is keyboard operable, names icon-only controls and
// explains disabled ones (aria-disabled keeps them focusable so the reason can be read).
import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type ReactNode,
} from 'react';
import { Check, Info, Lock, Snowflake, Table2, Grid3x3, X, type LucideIcon } from 'lucide-react';
import { HEAT, WEEKS, heatLevel, type BadgeDef, type Tone } from './data';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Moving between mockup screens ----------
export type ScreenId =
  | 'popup'
  | 'sidepanel'
  | 'dashboard'
  | 'review'
  | 'onboarding'
  | 'create-bank'
  | 'badges'
  | 'inpage';
export const GoContext = createContext<(id: ScreenId) => void>(() => {});
export const useGo = () => useContext(GoContext);
export const GO_EVENT = 'candy:go';

// ---------- Reduced motion ----------
const RM = '(prefers-reduced-motion: reduce)';
const subscribeRM = (cb: () => void) => {
  const m = matchMedia(RM);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
};
export const useReducedMotion = () =>
  useSyncExternalStore(
    subscribeRM,
    () => matchMedia(RM).matches,
    () => false,
  );

// ---------- Buttons ----------
type TipPos = 'above' | 'below' | 'end' | 'below-end';

export function Btn({
  children,
  variant,
  size,
  block,
  icon: Icon,
  trailing,
  onClick,
  disabledReason,
  tip,
  className,
  btnRef,
  label,
}: {
  children: ReactNode;
  variant?: 'primary' | 'go' | 'soft' | 'ghost';
  size?: 'sm' | 'lg';
  block?: boolean;
  icon?: LucideIcon;
  trailing?: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabledReason?: string;
  tip?: TipPos;
  className?: string;
  btnRef?: Ref<HTMLButtonElement>;
  label?: string;
}) {
  const reasonId = useId();
  const off = Boolean(disabledReason);
  return (
    <button
      ref={btnRef}
      type="button"
      className={cx(
        'sv-btn',
        variant && `sv-btn--${variant}`,
        size && `sv-btn--${size}`,
        block && 'sv-btn--block',
        off && 'sv-tip',
        className,
      )}
      aria-label={label}
      aria-disabled={off || undefined}
      aria-describedby={off ? reasonId : undefined}
      data-tip={disabledReason}
      data-tip-pos={tip === 'above' ? undefined : tip}
      onClick={off ? undefined : onClick}
    >
      {Icon && <Icon aria-hidden="true" strokeWidth={2.5} />}
      {children}
      {trailing}
      {off && (
        <span id={reasonId} className="sv-vh">
          {disabledReason}
        </span>
      )}
    </button>
  );
}

export function IconButton({
  label,
  icon: Icon,
  onClick,
  size,
  tip,
  pressed,
  disabledReason,
  soft,
  className,
  btnRef,
}: {
  label: string;
  icon: LucideIcon;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  size?: 'sm';
  tip?: TipPos;
  pressed?: boolean;
  disabledReason?: string;
  soft?: boolean;
  className?: string;
  btnRef?: Ref<HTMLButtonElement>;
}) {
  const reasonId = useId();
  const off = Boolean(disabledReason);
  return (
    <button
      ref={btnRef}
      type="button"
      className={cx(
        'sv-iconbtn sv-tip',
        size && 'sv-iconbtn--sm',
        soft && 'sv-iconbtn--soft',
        className,
      )}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={off || undefined}
      aria-describedby={off ? reasonId : undefined}
      data-tip={off ? disabledReason : label}
      data-tip-pos={tip === 'above' ? undefined : tip}
      onClick={off ? undefined : onClick}
    >
      <Icon aria-hidden="true" strokeWidth={2.4} />
      {off && (
        <span id={reasonId} className="sv-vh">
          {disabledReason}
        </span>
      )}
    </button>
  );
}

// ---------- Ring, bar, flame ----------
export function Ring({
  value,
  max,
  size = 64,
  stroke = 8,
  label,
  color,
  children,
}: {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  label: string;
  color?: string;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, value / max));
  const style = {
    width: size,
    height: size,
    ...(color ? { '--ring': color } : {}),
  } as CSSProperties;
  return (
    <div className="sv-ring" role="img" aria-label={label} style={style}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="sv-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="sv-ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
        />
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
  valueText,
  size,
  tone,
  className,
}: {
  value: number;
  max: number;
  label: string;
  valueText?: string;
  size?: 'sm';
  tone?: Tone;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={cx('sv-bar', size && 'sv-bar--sm', tone && 'sv-bar--tone', className)}
      data-tone={tone}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
    >
      <span style={{ width: pct > 0 ? `max(12px, ${pct}%)` : 0 }} />
    </div>
  );
}

/** In-house two-tone flame (coral with a butter core). */
export function FlameIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 1.8c1 4 6.6 6.4 6.6 12.6A6.6 6.6 0 0 1 5.4 14.4c0-3.4 1.9-5 2.9-7 .6 2 1.6 3 2.8 3.1C10.6 7.6 10.7 4.4 12 1.8Z"
        fill="var(--sv-flame)"
      />
      <path
        d="M12 11c1.6 1.9 3.3 3 3.3 5.2a3.3 3.3 0 0 1-6.6 0c0-1.7 1.7-3 3.3-5.2Z"
        fill="var(--sv-flame-core)"
      />
    </svg>
  );
}

export function StreakFlame({ days, size = 22 }: { days: number; size?: number }) {
  return (
    <span className="sv-flame">
      <FlameIcon size={size} />
      <span>{days}</span>
      <span className="sv-vh"> day streak</span>
    </span>
  );
}

export function Freezes({ held, max = 2 }: { held: number; max?: number }) {
  return (
    <span className="sv-freezes" role="img" aria-label={`${held} of ${max} streak freezes`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className="sv-freeze" data-on={i < held || undefined}>
          <Snowflake aria-hidden="true" strokeWidth={2.6} />
        </span>
      ))}
    </span>
  );
}

// ---------- Info popover ----------
export function InfoTip({
  label,
  children,
  align,
}: {
  label: string;
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <span
      className="sv-info"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          btn.current?.focus();
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={btn}
        type="button"
        className="sv-iconbtn sv-info__btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Info aria-hidden="true" strokeWidth={2.5} />
      </button>
      {open && (
        <span id={id} className="sv-info__pop" data-align={align} tabIndex={-1}>
          {children}
        </span>
      )}
    </span>
  );
}

// ---------- Switch & segmented ----------
export function Switch({
  checked,
  onChange,
  label,
  hideLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
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
      {!hideLabel && <span>{label}</span>}
      <span className="sv-switch__track" aria-hidden="true">
        <span className="sv-switch__thumb">
          {checked ? <Check strokeWidth={3.5} /> : <X strokeWidth={3.5} />}
        </span>
      </span>
    </button>
  );
}

export function Seg<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; icon?: LucideIcon }[];
}) {
  const name = useId();
  return (
    <fieldset className="sv-seg">
      <legend className="sv-vh">{label}</legend>
      {options.map(({ id, label: text, icon: Icon }) => (
        <label key={id}>
          <input
            type="radio"
            name={name}
            value={id}
            checked={value === id}
            onChange={() => onChange(id)}
          />
          {Icon && <Icon aria-hidden="true" strokeWidth={2.5} />}
          {text}
        </label>
      ))}
    </fieldset>
  );
}

// ---------- Tabs ----------
export type TabDef<T extends string> = {
  id: T;
  label: string;
  icon: LucideIcon;
  count?: number;
  countLabel?: string;
};

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idBase,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = tabs.length;
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % n
        : e.key === 'ArrowLeft'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="sv-tabbar">
      {tabs.map((t, i) => {
        const Icon = t.icon;
        const sel = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-selected={sel}
            aria-controls={`${idBase}-panel`}
            tabIndex={sel ? 0 : -1}
            className="sv-tab"
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <Icon aria-hidden="true" strokeWidth={sel ? 2.6 : 2.2} />
            <span>{t.label}</span>
            {t.count ? (
              <span className="sv-count">
                <span aria-hidden="true">{t.count}</span>
                <span className="sv-vh">, {t.countLabel ?? t.count}</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Stepper ----------
export function Steps({
  steps,
  current,
  label,
}: {
  steps: string[];
  current: number;
  label: string;
}) {
  return (
    <div className="sv-steps">
      <ol aria-label={label}>
        {steps.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'now' : 'todo';
          return (
            <li key={s} data-state={state} aria-current={i === current ? 'step' : undefined}>
              <span aria-hidden="true" />
              <span>
                {state === 'done' && <Check aria-hidden="true" strokeWidth={3.5} />}
                {s}
                {state === 'done' && <span className="sv-vh"> (done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------- Focus trap for dialogs ----------
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="radio"]), input[type="radio"]:checked, textarea, select, [tabindex]:not([tabindex="-1"])';
export function trapTab(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ---------- Confetti (static sparkles under reduced motion) ----------
const CONFETTI_COLOURS = [
  'var(--sv-lavender-solid)',
  'var(--sv-mint-solid)',
  'var(--sv-peach-solid)',
  'var(--sv-flame-core)',
  'var(--sv-sky-solid)',
  'var(--sv-rose-solid)',
  'var(--sv-primary-soft-2)',
];
const rnd = (i: number, s: number) => {
  const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const PIECES = Array.from({ length: 72 }, (_, i) => ({
  left: rnd(i, 1) * 100,
  delay: rnd(i, 2) * 0.9,
  dur: 2.4 + rnd(i, 3) * 1.8,
  dx: (rnd(i, 4) - 0.5) * 180,
  rot: 360 + rnd(i, 5) * 540,
  colour: CONFETTI_COLOURS[i % CONFETTI_COLOURS.length],
}));
const SPARKS = [
  { x: 18, y: 22, s: 26 },
  { x: 80, y: 16, s: 20 },
  { x: 10, y: 58, s: 16 },
  { x: 88, y: 52, s: 24 },
  { x: 30, y: 8, s: 14 },
  { x: 68, y: 6, s: 16 },
];

export function Confetti() {
  const reduced = useReducedMotion();
  if (reduced) {
    return (
      <div className="sv-sparkles" aria-hidden="true">
        {SPARKS.map((p, i) => (
          <svg
            key={i}
            width={p.s}
            height={p.s}
            viewBox="-8 -8 16 16"
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
          >
            <path
              d="M0 -7 C1 -2 2 -1 7 0 C2 1 1 2 0 7 C-1 2 -2 1 -7 0 C-2 -1 -1 -2 0 -7 Z"
              fill={CONFETTI_COLOURS[i % CONFETTI_COLOURS.length]}
            />
          </svg>
        ))}
      </div>
    );
  }
  return (
    <div className="sv-confetti" aria-hidden="true">
      {PIECES.map((p, i) => (
        <i
          key={i}
          style={
            {
              left: `${p.left}%`,
              background: p.colour,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.dur}s`,
              '--dx': `${p.dx}px`,
              '--rot': `${p.rot}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

// ---------- Streak heatmap (SVG + table fallback) ----------
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Heatmap({ cell = 15, gap = 4 }: { cell?: number; gap?: number }) {
  const [table, setTable] = useState(false);
  const active = HEAT.filter((d) => d.xp > 0).length;
  const step = cell + gap;
  const left = 30;
  const top = 18;
  const w = left + WEEKS.length * step;
  const h = top + 7 * step;
  const months = WEEKS.map((wk, i) => {
    const first = wk[0]!;
    const prev = WEEKS[i - 1]?.[0];
    const m = first.label.split(' ')[2];
    return !prev || prev.label.split(' ')[2] !== m ? m : null;
  });
  return (
    <div className="sv-heat">
      <div className="sv-heat__bar">
        <p className="sv-hint">
          Last 12 weeks · <strong>{active}</strong> active days
        </p>
        <button
          type="button"
          className="sv-btn sv-btn--ghost sv-btn--sm"
          aria-pressed={table}
          onClick={() => setTable((t) => !t)}
        >
          {table ? (
            <Grid3x3 aria-hidden="true" strokeWidth={2.5} />
          ) : (
            <Table2 aria-hidden="true" strokeWidth={2.5} />
          )}
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
      {table ? (
        <div className="sv-heat__table" role="region" aria-label="XP per day, table" tabIndex={0}>
          <table>
            <caption className="sv-vh">XP earned per day, last 12 weeks</caption>
            <thead>
              <tr>
                <th scope="col">Week of</th>
                {WEEKDAYS.map((d) => (
                  <th key={d} scope="col">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEKS.map((wk) => (
                <tr key={wk[0]!.iso}>
                  <th scope="row">{wk[0]!.label.slice(4)}</th>
                  {WEEKDAYS.map((_, i) => {
                    const d = wk[i];
                    return <td key={i}>{!d ? '–' : d.freeze ? 'Freeze' : d.xp}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <svg
            className="sv-heat__svg"
            viewBox={`0 0 ${w} ${h}`}
            width={w}
            height={h}
            role="img"
            aria-label={`Study days, last 12 weeks: ${active} active days, ${HEAT.filter((d) => d.freeze).length} freeze used. Table view available.`}
          >
            {months.map((m, i) =>
              m ? (
                <text key={i} x={left + i * step} y={11} className="sv-heat__lbl">
                  {m}
                </text>
              ) : null,
            )}
            {[0, 2, 4].map((r) => (
              <text key={r} x={0} y={top + r * step + cell - 3} className="sv-heat__lbl">
                {WEEKDAYS[r]}
              </text>
            ))}
            {WEEKS.map((wk, c) =>
              wk.map((d, r) => (
                <rect
                  key={d.iso}
                  x={left + c * step}
                  y={top + r * step}
                  width={cell}
                  height={cell}
                  rx={4.5}
                  className="sv-heat__c"
                  data-l={d.freeze ? 'f' : heatLevel(d.xp)}
                  data-today={d.today || undefined}
                >
                  <title>{`${d.label}: ${d.freeze ? 'freeze used' : `${d.xp} XP`}`}</title>
                </rect>
              )),
            )}
          </svg>
          <div className="sv-heat__legend" aria-hidden="true">
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((l) => (
              <i key={l} className="sv-heat__c" data-l={l} />
            ))}
            <span>More</span>
            <i className="sv-heat__c" data-l="f" />
            <span>Freeze</span>
            <i className="sv-heat__c" data-l="2" data-today="" />
            <span>Today</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Badge medal ----------
export function Medal({
  b,
  selected,
  onSelect,
  compact,
}: {
  b: BadgeDef;
  selected?: boolean;
  onSelect?: () => void;
  compact?: boolean;
}) {
  const Icon = b.icon;
  const locked = !b.earned;
  const state = locked ? `locked, ${b.progress?.[0] ?? 0} of ${b.progress?.[1] ?? 1}` : 'earned';
  const body = (
    <>
      <span className="sv-medal__disc" aria-hidden="true">
        <Icon strokeWidth={2.3} />
        {locked && (
          <span className="sv-medal__lock">
            <Lock strokeWidth={3} />
          </span>
        )}
      </span>
      <span className="sv-medal__name" aria-hidden="true">
        {b.name}
      </span>
      {locked && b.progress && !compact && (
        <span className="sv-medal__prog" aria-hidden="true">
          <span style={{ width: `${(b.progress[0] / b.progress[1]) * 100}%` }} />
        </span>
      )}
    </>
  );
  return onSelect ? (
    <button
      type="button"
      className="sv-medal"
      data-tone={b.tone}
      data-locked={locked || undefined}
      aria-pressed={selected}
      aria-label={`${b.name}, ${state}`}
      onClick={onSelect}
    >
      {body}
    </button>
  ) : (
    <span
      className="sv-medal"
      data-tone={b.tone}
      data-locked={locked || undefined}
      role="img"
      aria-label={`${b.name}, ${state}`}
    >
      {body}
    </span>
  );
}
