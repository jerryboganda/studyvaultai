// Popup (400x560): tab status, today's goal ring, streak and level, two big actions, quick toggles.
import { useRef, useState } from 'react';
import {
  Ban,
  Bell,
  BellOff,
  BookOpen,
  CircleCheck,
  CirclePause,
  Eye,
  EyeOff,
  FileText,
  Globe,
  HeartPulse,
  Highlighter,
  LayoutGrid,
  LoaderCircle,
  MousePointerClick,
  MousePointer2,
  PanelRight,
  Play,
  Settings,
  ShieldOff,
  TriangleAlert,
  Volume2,
  VolumeX,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { ME } from '../data';
import { LogoMark } from '../VaultBuddy';
import { Bar, Btn, IconButton, InfoTip, Ring, StreakFlame, Switch, useGo } from '../ui';

export type PopupVariant = 'active' | 'off' | 'pdf' | 'blocked';

const SITE: Record<
  PopupVariant,
  {
    host: string;
    icon: LucideIcon;
    tone: string;
    status: string;
    statusIcon: LucideIcon;
    info: string;
  }
> = {
  active: {
    host: 'openmed.example.org',
    icon: Globe,
    tone: 'mint',
    status: 'On here',
    statusIcon: CircleCheck,
    info: 'StudyVault runs on this tab. Select text to save it.',
  },
  off: {
    host: 'openmed.example.org',
    icon: Globe,
    tone: 'peach',
    status: 'Off here',
    statusIcon: CirclePause,
    info: 'Nothing runs until you turn it on. "Always on" asks Chrome once for this site.',
  },
  pdf: {
    host: 'arxiv.org',
    icon: FileText,
    tone: 'sky',
    status: 'PDF file',
    statusIcon: FileText,
    info: "Chrome's PDF viewer is closed to extensions. Open the file in the StudyVault reader instead.",
  },
  blocked: {
    host: 'chrome://settings',
    icon: ShieldOff,
    tone: 'plain',
    status: "Can't run here",
    statusIcon: Ban,
    info: 'Chrome keeps its own pages private, so no extension can read them.',
  },
};

type ToggleKey = 'toolbar' | 'paint' | 'remind' | 'sound';
const TOGGLES: { id: ToggleKey; label: string; on: LucideIcon; off: LucideIcon }[] = [
  { id: 'toolbar', label: 'Toolbar', on: MousePointerClick, off: MousePointer2 },
  { id: 'paint', label: 'Highlights', on: Eye, off: EyeOff },
  { id: 'remind', label: 'Reminders', on: Bell, off: BellOff },
  { id: 'sound', label: 'Sounds', on: Volume2, off: VolumeX },
];

export function Popup({
  variant,
  onVariant,
}: {
  variant: PopupVariant;
  onVariant: (v: PopupVariant) => void;
}) {
  const go = useGo();
  const site = SITE[variant];
  const SiteIcon = site.icon;
  const StatusIcon = site.statusIcon;
  const [on, setOn] = useState<Record<ToggleKey, boolean>>({
    toolbar: true,
    paint: true,
    remind: true,
    sound: false,
  });
  const [always, setAlways] = useState(false);
  const [reader, setReader] = useState<'idle' | 'opening' | 'done'>('idle');
  const timer = useRef(0);

  const openReader = () => {
    setReader('opening');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setReader('done'), 900);
  };

  return (
    <div className="pp">
      <span className="pp-deco pp-deco--a" aria-hidden="true" />
      <span className="pp-deco pp-deco--b" aria-hidden="true" />
      <header className="pp-head">
        <LogoMark size={30} />
        <span className="pp-brand">StudyVault</span>
        <span className="pp-spacer" />
        <IconButton
          label="Open dashboard"
          icon={LayoutGrid}
          tip="below"
          onClick={() => go('dashboard')}
        />
        <IconButton
          label="Settings"
          icon={Settings}
          tip="below-end"
          disabledReason="Settings: next mockup round"
        />
      </header>

      <section className="pp-site sv-card" aria-label="This tab">
        <span className="sv-well" data-tone={site.tone}>
          <SiteIcon aria-hidden="true" strokeWidth={2.4} />
        </span>
        <div className="pp-site__main">
          <p className="pp-host">{site.host}</p>
          <div className="pp-site__chips">
            <span className="sv-chip" data-tone={site.tone}>
              <StatusIcon aria-hidden="true" strokeWidth={2.6} />
              {site.status}
            </span>
            {variant === 'active' && (
              <>
                <span className="sv-chip">
                  <Highlighter aria-hidden="true" strokeWidth={2.6} />5 saved
                </span>
                <span className="sv-chip" data-tone="peach">
                  <TriangleAlert aria-hidden="true" strokeWidth={2.6} />1 to check
                </span>
              </>
            )}
            {variant === 'off' && (
              <Switch label="Always on" checked={always} onChange={setAlways} />
            )}
          </div>
        </div>
        <InfoTip label="About this tab" align="end">
          {site.info}
        </InfoTip>
      </section>

      <section className="pp-stats" aria-label="Today">
        <div className="pp-stat">
          <Ring
            value={ME.todayXp}
            max={ME.goal}
            size={58}
            stroke={7}
            label={`Daily goal: ${ME.todayXp} of ${ME.goal} XP`}
          >
            <span className="sv-ring__value pp-ring__v">{ME.todayXp}</span>
            <span className="sv-ring__unit">/{ME.goal}</span>
          </Ring>
          <span className="pp-stat__label">Daily goal</span>
        </div>
        <div className="pp-stat">
          <span className="pp-stat__big">
            <StreakFlame days={ME.streak} size={30} />
          </span>
          <span className="pp-stat__label">Day streak</span>
        </div>
        <div className="pp-stat">
          <span className="pp-level" aria-hidden="true">
            {ME.level}
          </span>
          <Bar
            size="sm"
            value={ME.levelXp}
            max={ME.levelNeed}
            label={`Level ${ME.level}`}
            valueText={`${ME.levelXp} of ${ME.levelNeed} XP`}
            className="pp-stat__bar"
          />
          <span className="pp-stat__label">Level {ME.level}</span>
        </div>
      </section>

      <div className="pp-actions">
        {variant === 'active' && (
          <Btn variant="primary" size="lg" block icon={PanelRight} onClick={() => go('sidepanel')}>
            Open side panel
          </Btn>
        )}
        {variant === 'off' && (
          <Btn variant="primary" size="lg" block icon={Zap} onClick={() => onVariant('active')}>
            Turn on here
          </Btn>
        )}
        {variant === 'pdf' && (
          <Btn
            variant="primary"
            size="lg"
            block
            icon={reader === 'opening' ? LoaderCircle : reader === 'done' ? CircleCheck : BookOpen}
            onClick={reader === 'idle' ? openReader : undefined}
            className={reader === 'opening' ? 'is-busy' : undefined}
          >
            {reader === 'opening'
              ? 'Opening…'
              : reader === 'done'
                ? 'Opened in new tab'
                : 'Open in reader'}
          </Btn>
        )}
        {variant === 'blocked' && (
          <Btn
            variant="primary"
            size="lg"
            block
            icon={PanelRight}
            disabledReason="Chrome pages block extensions"
          >
            Open side panel
          </Btn>
        )}
        <Btn
          variant="go"
          size="lg"
          block
          icon={Play}
          onClick={() => go('review')}
          trailing={
            <span className="sv-btn__count">
              {ME.due}
              <span className="sv-vh"> due</span>
            </span>
          }
        >
          Start review
        </Btn>
      </div>

      <div className="pp-toggles" role="group" aria-label="Quick toggles">
        {TOGGLES.map((t) => {
          const Icon = on[t.id] ? t.on : t.off;
          return (
            <button
              key={t.id}
              type="button"
              className="pp-toggle"
              aria-pressed={on[t.id]}
              onClick={() => setOn((s) => ({ ...s, [t.id]: !s[t.id] }))}
            >
              <span className="pp-toggle__icon">
                <Icon aria-hidden="true" strokeWidth={2.4} />
              </span>
              {t.label}
            </button>
          );
        })}
      </div>

      <footer className="pp-foot">
        <span className="pp-save">
          Save to
          <span className="sv-chip" data-tone="rose">
            <HeartPulse aria-hidden="true" strokeWidth={2.6} />
            Cardiology
          </span>
        </span>
        <span className="pp-keys">
          <kbd className="sv-kbd">Alt</kbd>
          <kbd className="sv-kbd">S</kbd>
          <span className="pp-keys__l">Save</span>
        </span>
      </footer>
    </div>
  );
}
