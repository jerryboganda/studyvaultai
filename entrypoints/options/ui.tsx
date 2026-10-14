import { useId, type ReactNode, type Ref } from 'react';
import {
  Archive,
  Bell,
  Database,
  Gamepad2,
  Globe,
  HardDrive,
  Highlighter,
  Info,
  Keyboard,
  Layers,
  Palette,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { AsyncSwitch, ChunkyButton, InfoTip, type ArtTone, type ChunkyButtonProps } from '@ui';
import { keyParts, type OptionSectionId } from './model';

/**
 * Small settings-page pieces of the Sunny look that the shared library does not have (cards with
 * an icon title, setting rows, key chips, the level emblem, the logo mark). Kept here so
 * packages/ui stays untouched; the popup keeps its own copies of the emblem and the logo.
 */

/** One icon and art tone per section (UX_DESIGN 4: one icon, one meaning). */
export const SECTION_LOOK: Record<OptionSectionId, { icon: LucideIcon; tone: ArtTone }> = {
  game: { icon: Gamepad2, tone: 'sun' },
  'site-access': { icon: Globe, tone: 'primary' },
  capture: { icon: Highlighter, tone: 'warning' },
  appearance: { icon: Palette, tone: 'violet' },
  shortcuts: { icon: Keyboard, tone: 'neutral' },
  review: { icon: Layers, tone: 'primary' },
  reminders: { icon: Bell, tone: 'sun' },
  backup: { icon: Archive, tone: 'success' },
  storage: { icon: HardDrive, tone: 'warning' },
  privacy: { icon: ShieldCheck, tone: 'success' },
  data: { icon: Database, tone: 'danger' },
  ai: { icon: Sparkles, tone: 'violet' },
  sync: { icon: RefreshCw, tone: 'primary' },
  about: { icon: Info, tone: 'neutral' },
};

/** The brand mark (fixed colours, like the mascot). Decorative: the text next to it names it. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="opt-logo">
      <rect width="32" height="32" rx="8" fill="#2a62e5" />
      <rect x="7" y="8" width="18" height="3" rx="1.5" fill="#fff" />
      <rect x="5.5" y="13.5" width="21" height="5" rx="2" fill="#ffc83d" />
      <rect x="8.5" y="15.2" width="15" height="1.6" rx="0.8" fill="#18213b" />
      <rect x="7" y="21" width="12" height="3" rx="1.5" fill="#fff" />
    </svg>
  );
}

/** Hex level emblem with the number (UX_DESIGN 11). Decorative: "Level 7" is written next to it. */
export function LevelEmblem({ level, size = 56 }: { level: number; size?: number }) {
  const digits = Math.min(String(level).length, 3);
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="opt-emblem">
      <path d="M24 3 L42 13.5 V34.5 L24 45 L6 34.5 V13.5 Z" className="opt-emblem__edge" />
      <path d="M24 9.5 L36.5 16.8 V31.2 L24 38.5 L11.5 31.2 V16.8 Z" className="opt-emblem__face" />
      <text
        x="24"
        y={digits > 2 ? 28.5 : 30}
        textAnchor="middle"
        className={`opt-emblem__num opt-emblem__num--${digits}`}
      >
        {level}
      </text>
    </svg>
  );
}

/** Art tile: a tinted rounded square around an icon (decorative). */
export function ArtTile({
  icon: Icon,
  tone,
  size,
}: {
  icon: LucideIcon;
  tone: ArtTone;
  size?: 'lg';
}) {
  return (
    <span
      className={`opt-art sv-art--${tone}${size ? ` opt-art--${size}` : ''}`}
      aria-hidden="true"
    >
      <Icon strokeWidth={2.4} />
    </span>
  );
}

/**
 * A settings card (UX_DESIGN 6.6): icon tile, a short title (h2), an optional (i) with the detail
 * and something on the right of the title. `headingRef` makes the title a focus target for when
 * the control that had focus goes away.
 */
export function Card({
  title,
  icon,
  tone = 'primary',
  info,
  aside,
  headingRef,
  testId,
  className,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  tone?: ArtTone;
  info?: ReactNode;
  aside?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  testId?: string;
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      className={`opt-card${className ? ` ${className}` : ''}`}
      aria-labelledby={id}
      data-testid={testId}
    >
      <div className="opt-card__head">
        {icon ? <ArtTile icon={icon} tone={tone} /> : null}
        <h2
          id={id}
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className="opt-card__title"
        >
          {title}
        </h2>
        {info ? (
          <InfoTip label={`About ${title.toLowerCase()}`} align="start">
            {info}
          </InfoTip>
        ) : null}
        {aside ? <div className="opt-card__aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One on/off setting: icon tile, the switch with its label (<= 3 words) and one helper line, and
 * the longer detail behind (i). `onChange` returning a promise makes it a pending switch
 * (`AsyncSwitch`): shown as chosen and busy until the write settles, rolled back if it failed.
 */
export function SettingRow({
  icon,
  tone = 'primary',
  label,
  hint,
  info,
  checked,
  onChange,
  testId,
  children,
}: {
  icon: LucideIcon;
  tone?: ArtTone;
  label: string;
  hint?: ReactNode;
  info?: ReactNode;
  checked: boolean;
  onChange(next: boolean): Promise<unknown> | void;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div className="opt-setting">
      <ArtTile icon={icon} tone={tone} />
      <div className="opt-setting__main">
        <AsyncSwitch
          label={label}
          hint={hint}
          checked={checked}
          onChange={onChange}
          testId={testId}
        />
        {children}
      </div>
      {info ? (
        <InfoTip label={`About ${label.toLowerCase()}`} align="end">
          {info}
        </InfoTip>
      ) : null}
    </div>
  );
}

/** A key combination as chips; the whole combination is read once ("Alt+Shift+S"). */
export function Keys({ shortcut }: { shortcut: string }) {
  if (!shortcut) return <span className="opt-keys opt-keys--unset">Not set</span>;
  return (
    <span className="opt-keys">
      <span className="sv-vh">{shortcut}</span>
      <span className="opt-keys__chips" aria-hidden="true">
        {keyParts(shortcut).map((k, i) => (
          <kbd key={i} className="sv-kbd">
            {k}
          </kbd>
        ))}
      </span>
    </span>
  );
}

/** ChunkyButton that stays focusable and ignores clicks while its action runs. */
export function Act({ busy = false, onClick, ...rest }: ChunkyButtonProps & { busy?: boolean }) {
  return (
    <ChunkyButton {...rest} aria-busy={busy || undefined} onClick={busy ? undefined : onClick} />
  );
}

/** A disclosure for the rarely needed detail ("More" behind one click; native details/summary). */
export function More({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="opt-more">
      <summary className="opt-more__summary">{label}</summary>
      <div className="opt-more__body">{children}</div>
    </details>
  );
}
