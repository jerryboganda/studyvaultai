// Toolbar popup (400x560): this tab's status, today's goal, two big actions, quick toggles.
import { useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  Dna,
  FileText,
  Gamepad2,
  Globe,
  Highlighter,
  Layers,
  LayoutDashboard,
  MousePointerClick,
  PanelRightOpen,
  Pin,
  Power,
  Settings,
} from 'lucide-react';
import { PLAYER } from '../data';
import {
  Button,
  Chip,
  Flash,
  Freezes,
  IconButton,
  InfoTip,
  Kbd,
  Ring,
  Streak,
  ToggleChip,
  useFlash,
} from '../ui';
import { VaultBuddy } from '../VaultBuddy';

export type PopupVariant = 'on' | 'off' | 'pdf';

export function Popup({ variant }: { variant: PopupVariant }) {
  const [state, setState] = useState<PopupVariant>(variant);
  const [toggles, setToggles] = useState({
    paint: true,
    toolbar: true,
    always: variant === 'on',
    game: true,
  });
  const [msg, flash] = useFlash();
  const flip = (k: keyof typeof toggles) => setToggles((t) => ({ ...t, [k]: !t[k] }));
  const togo = PLAYER.goal - PLAYER.xpToday;
  // Chrome's own PDF viewer cannot be painted, so the page toggles do not apply there.
  const pdfOff = state === 'pdf' ? 'Not in PDF viewer' : undefined;

  return (
    <div className="pp">
      <header className="pp-head">
        <VaultBuddy pose="wave" size={36} />
        <span className="pp-word">StudyVault</span>
        <IconButton
          tip="below"
          label="Open dashboard"
          icon={LayoutDashboard}
          onClick={() => flash('Dashboard opened')}
        />
        <IconButton
          tip="below-end"
          label="Settings"
          icon={Settings}
          onClick={() => flash('Settings opened')}
        />
      </header>

      <section className="sv-card pp-site" aria-label="This tab">
        <span className="pp-fav" aria-hidden>
          {state === 'pdf' ? (
            <FileText size={20} strokeWidth={2.4} />
          ) : (
            <Globe size={20} strokeWidth={2.4} />
          )}
        </span>
        <div className="pp-site__text">
          <span className="pp-host">{state === 'pdf' ? 'notes.pdf' : 'en.example.org'}</span>
          <span className="pp-site__meta">
            {state === 'on' && (
              <>
                <span>
                  <Highlighter aria-hidden size={14} strokeWidth={2.6} /> 3 saved
                </span>
                <span className="pp-attn">
                  <AlertTriangle aria-hidden size={14} strokeWidth={2.6} /> 1 to check
                </span>
              </>
            )}
            {state === 'off' && <span>3 saved earlier</span>}
            {state === 'pdf' && <span>In Chrome’s viewer</span>}
          </span>
        </div>
        {state === 'on' && (
          <span className="sv-badge sv-badge--ok">
            <Check aria-hidden size={14} strokeWidth={3} /> On
          </span>
        )}
        {state === 'off' && (
          <span className="sv-badge sv-badge--warn">
            <Power aria-hidden size={14} strokeWidth={3} /> Off
          </span>
        )}
        {state === 'pdf' && <span className="sv-badge sv-badge--info">PDF</span>}
        <InfoTip label="About this tab">
          {state === 'on' &&
            'StudyVault is on for this site. Select text to save it; saved passages are painted on the page.'}
          {state === 'off' &&
            'StudyVault is not running on this tab. Turn it on for this tab, or pin “Always on” for the whole site. Chrome asks first.'}
          {state === 'pdf' &&
            'Chrome’s own PDF viewer cannot be highlighted. Open the file in the StudyVault reader to save passages.'}
        </InfoTip>
      </section>

      <section className="sv-card pp-goal" aria-label="Today">
        <Ring
          value={PLAYER.xpToday}
          max={PLAYER.goal}
          size={96}
          stroke={11}
          label={`Daily goal: ${PLAYER.xpToday} of ${PLAYER.goal} XP`}
        >
          <span className="sv-num pp-goal__n">{PLAYER.xpToday}</span>
          <span className="pp-goal__of">/{PLAYER.goal} XP</span>
        </Ring>
        <div className="pp-goal__side">
          <span className="sv-eyebrow">Daily goal</span>
          <span className="pp-goal__hint">
            <b className="sv-num">{togo}</b> XP to go
          </span>
          <div className="pp-goal__stats">
            <Streak days={PLAYER.streak} size="lg" />
            <Freezes count={PLAYER.freezes} />
          </div>
        </div>
      </section>

      <div className="pp-actions">
        {state === 'on' && (
          <Button
            variant="primary"
            size="lg"
            icon={PanelRightOpen}
            onClick={() => flash('Side panel opened')}
          >
            Open side panel
          </Button>
        )}
        {state === 'off' && (
          <Button
            variant="primary"
            size="lg"
            icon={Power}
            onClick={() => {
              setState('on');
              flash('On for this tab');
            }}
          >
            Turn on here
          </Button>
        )}
        {state === 'pdf' && (
          <Button
            variant="primary"
            size="lg"
            icon={BookOpen}
            onClick={() => flash('Opening the reader…')}
          >
            Open in reader
          </Button>
        )}
        {state === 'on' ? (
          <Button size="lg" icon={Layers} onClick={() => flash('Review opened')}>
            Start review <span className="sv-btn__badge">{PLAYER.due}</span>
          </Button>
        ) : (
          <div className="pp-actions__pair">
            <Button icon={PanelRightOpen} onClick={() => flash('Side panel opened')}>
              Side panel
            </Button>
            <Button icon={Layers} onClick={() => flash('Review opened')}>
              Review <span className="sv-btn__badge">{PLAYER.due}</span>
            </Button>
          </div>
        )}
      </div>

      <div className="pp-toggles" role="group" aria-label="Quick toggles">
        <ToggleChip
          icon={Highlighter}
          label="Paint"
          pressed={toggles.paint}
          onToggle={() => flip('paint')}
          disabledReason={pdfOff}
        />
        <ToggleChip
          icon={MousePointerClick}
          label="Toolbar"
          pressed={toggles.toolbar}
          onToggle={() => flip('toolbar')}
          disabledReason={pdfOff}
        />
        <ToggleChip
          icon={Pin}
          label="Always on"
          pressed={toggles.always}
          onToggle={() => flip('always')}
          disabledReason={pdfOff}
        />
        <ToggleChip
          icon={Gamepad2}
          label="Game mode"
          pressed={toggles.game}
          onToggle={() => flip('game')}
        />
      </div>

      <footer className="pp-foot">
        <span className="sv-muted">Saving to</span>
        <Chip color="lime" icon={Dna}>
          Biology
        </Chip>
        <span className="pp-keys" title="Quick save">
          <span className="sv-sr">Quick save:</span>
          <Kbd>Alt</Kbd>
          <Kbd>Shift</Kbd>
          <Kbd>H</Kbd>
        </span>
      </footer>
      <Flash msg={msg} />
    </div>
  );
}
