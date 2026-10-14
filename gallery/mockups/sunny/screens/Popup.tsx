import { useState } from 'react';
import {
  BookOpen,
  Check,
  FileText,
  Gamepad2,
  Globe,
  Highlighter,
  House,
  Layers,
  MousePointerClick,
  PanelRight,
  Power,
  Settings,
  TriangleAlert,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { GAME, PAGE } from '../data';
import { LogoMark } from '../shared';
import { LevelEmblem } from './BadgesSheet';
import {
  Badge,
  Button,
  GoalRing,
  IconButton,
  InfoTip,
  Kbd,
  Streak,
  Switch,
  ToggleChip,
} from '../ui';

export type PopupVariant = 'on' | 'off' | 'pdf';

export function Popup({ variant }: { variant: PopupVariant }) {
  const [always, setAlways] = useState(true);
  const [paint, setPaint] = useState(true);
  const [toolbar, setToolbar] = useState(true);
  const [game, setGame] = useState(true);
  const [sound, setSound] = useState(false);

  return (
    <div className="sv-screen pp">
      <header className="sv-row pp__head">
        <LogoMark />
        <h3 className="pp__brand">StudyVault</h3>
        <span className="sv-spacer" />
        {game && <Streak days={GAME.streak} />}
        <IconButton icon={Settings} label="Settings" tipSide="left" />
      </header>

      <section className="sv-card sv-card--pad pp__site" aria-label="This page">
        <div className="sv-row">
          <span className="pp__fav" aria-hidden="true">
            {variant === 'pdf' ? <FileText /> : <Globe />}
          </span>
          <span className="pp__where">
            <strong>{variant === 'pdf' ? 'lecture-04.pdf' : PAGE.host}</strong>
            <span className="sv-muted">{variant === 'pdf' ? 'Chrome PDF viewer' : PAGE.title}</span>
          </span>
          {variant === 'on' && (
            <Badge tone="success" icon={Check}>
              On
            </Badge>
          )}
          {variant === 'off' && <Badge icon={Power}>Off</Badge>}
          {variant === 'pdf' && (
            <Badge tone="primary" icon={FileText}>
              PDF
            </Badge>
          )}
        </div>

        {variant === 'on' && (
          <div className="sv-row pp__siteRow">
            <Badge tone="primary" icon={Highlighter}>
              12<span className="sv-vh"> saved here</span>
            </Badge>
            <Badge tone="warning" icon={TriangleAlert}>
              1<span className="sv-vh"> to fix</span>
            </Badge>
            <span className="sv-spacer" />
            <Switch checked={always} onChange={setAlways} label="Always on" />
            <InfoTip label="About always on" align="end">
              Runs on {PAGE.host} every visit. Chrome asks you first.
            </InfoTip>
          </div>
        )}
        {variant === 'off' && (
          <div className="pp__offRow">
            <Button variant="primary" icon={Power}>
              Turn on
            </Button>
            <Button variant="secondary">Always on</Button>
            <InfoTip label="About always on" align="end">
              Runs on {PAGE.host} every visit. Chrome asks you first.
            </InfoTip>
          </div>
        )}
        {variant === 'pdf' && (
          <div className="pp__siteActions">
            <Button variant="primary" icon={BookOpen} block>
              Open in reader
            </Button>
          </div>
        )}
      </section>

      <section className="sv-card sv-card--pad sv-row pp__today" aria-label="Today">
        {game ? (
          <>
            <GoalRing value={GAME.todayXp} goal={GAME.goalXp} size={68} stroke={8}>
              <span className="pp__ringNum">{GAME.todayXp}</span>
              <span className="pp__ringOf">/{GAME.goalXp} XP</span>
            </GoalRing>
            <div className="pp__todayText">
              <span className="sv-eyebrow">Today</span>
              <strong>{GAME.goalXp - GAME.todayXp} XP to goal</strong>
            </div>
            <LevelEmblem level={GAME.level} size={48} label={`Level ${GAME.level}`} />
          </>
        ) : (
          <div className="pp__todayText">
            <span className="sv-eyebrow">Today</span>
            <strong>8 reviewed · 3 saved</strong>
          </div>
        )}
      </section>

      <div className="pp__actions">
        <Button variant="primary" size="lg" icon={PanelRight} block>
          Open side panel
        </Button>
        <Button variant="sun" size="lg" icon={Layers} block>
          Start review
          <span className="pp__count">{GAME.due}</span>
        </Button>
      </div>

      <div className="pp__chips" role="group" aria-label="Quick toggles">
        <ToggleChip
          icon={Highlighter}
          label="Highlights"
          pressed={paint}
          onToggle={() => setPaint(!paint)}
        />
        <ToggleChip
          icon={MousePointerClick}
          label="Toolbar"
          pressed={toolbar}
          onToggle={() => setToolbar(!toolbar)}
        />
        <ToggleChip
          icon={Gamepad2}
          label="Game mode"
          pressed={game}
          onToggle={() => setGame(!game)}
        />
        <ToggleChip
          icon={sound ? Volume2 : VolumeX}
          label="Sounds"
          pressed={sound}
          onToggle={() => setSound(!sound)}
        />
      </div>

      <footer className="sv-row pp__foot">
        <Button variant="ghost" size="sm" icon={House}>
          Dashboard
        </Button>
        <span className="sv-spacer" />
        <span className="sv-muted pp__keys">
          Save <Kbd>Alt</Kbd> <Kbd>S</Kbd>
        </span>
      </footer>
    </div>
  );
}
