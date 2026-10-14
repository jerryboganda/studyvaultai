import { useEffect, useId, useRef, useState } from 'react';
import {
  AppWindow,
  ArrowLeft,
  Bike,
  Bookmark,
  Layers,
  Plus,
  Trophy,
  Check,
  Coffee,
  Flame,
  Globe,
  MousePointerClick,
  PanelRight,
  Rocket,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { VaultBuddy } from '../VaultBuddy';
import { Badge, Button, InfoTip, Switch, WizardProgress } from '../ui';

type Pick = {
  id: string;
  title: string;
  meta: string;
  icon: LucideIcon;
  tone: string;
  tag?: string;
};

const GOALS: Pick[] = [
  { id: '10', title: 'Casual', meta: '10 XP a day', icon: Coffee, tone: 'success' },
  { id: '30', title: 'Regular', meta: '30 XP a day', icon: Bike, tone: 'primary', tag: 'Popular' },
  { id: '50', title: 'Serious', meta: '50 XP a day', icon: Rocket, tone: 'violet' },
  { id: '100', title: 'Intense', meta: '100 XP a day', icon: Flame, tone: 'danger' },
];
const ACCESS: Pick[] = [
  { id: 'tab', title: 'This tab', meta: 'When you click', icon: MousePointerClick, tone: 'sun' },
  { id: 'site', title: 'One site', meta: 'Every visit', icon: AppWindow, tone: 'primary' },
  // The broadest grant gets a plain globe and a caution tone, never a "safe" shield.
  { id: 'all', title: 'All sites', meta: 'Everywhere', icon: Globe, tone: 'warning' },
];

function PickGroup({
  legend,
  items,
  value,
  onChange,
  cols,
}: {
  legend: string;
  items: Pick[];
  value: string;
  onChange: (v: string) => void;
  cols: number;
}) {
  const name = useId();
  return (
    <fieldset className="sv-picks" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      <legend className="sv-vh">{legend}</legend>
      {items.map(({ id, title, meta, icon: Icon, tone, tag }) => (
        <label key={id} className="sv-pick">
          <input
            type="radio"
            name={name}
            value={id}
            checked={value === id}
            onChange={() => onChange(id)}
          />
          <span className="sv-pick__check" aria-hidden="true">
            <Check strokeWidth={3.5} />
          </span>
          <span className={`sv-pick__art sv-art--${tone}`} aria-hidden="true">
            <Icon strokeWidth={2.2} />
          </span>
          <span className="sv-pick__title">{title}</span>
          <span className="sv-pick__meta">{meta}</span>
          {tag && <Badge tone="sun">{tag}</Badge>}
        </label>
      ))}
    </fieldset>
  );
}

export function Onboarding() {
  const [step, setStep] = useState(1);
  const [goal, setGoal] = useState('30');
  const [access, setAccess] = useState('tab');
  const [game, setGame] = useState(true);
  const [finished, setFinished] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const total = 3;

  // Move focus to each new step's heading (not on first render).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step, finished]);

  const goalPick = GOALS.find((g) => g.id === goal)!;
  const accessPick = ACCESS.find((a) => a.id === access)!;

  return (
    <div className="sv-screen ob">
      <div className="ob__blob ob__blob--a" aria-hidden="true" />
      <div className="ob__blob ob__blob--b" aria-hidden="true" />
      <div className="sv-card ob__card">
        {!finished && (
          <div className="sv-row ob__top">
            <WizardProgress step={step} total={total} label="Welcome tour" />
            <Button variant="ghost" size="sm" onClick={() => setFinished(true)}>
              Skip
            </Button>
          </div>
        )}

        {finished ? (
          <div className="ob__step ob__step--center">
            <VaultBuddy pose="cheer" size={150} />
            <h3 className="ob__title" ref={heading} tabIndex={-1}>
              All set!
            </h3>
            <p className="sv-muted">Happy studying.</p>
            <div className="sv-row ob__nav ob__nav--center">
              <Button
                variant="secondary"
                icon={ArrowLeft}
                onClick={() => {
                  setFinished(false);
                  setStep(1);
                }}
              >
                Restart tour
              </Button>
              <Button variant="primary">Open dashboard</Button>
            </div>
          </div>
        ) : (
          <>
            {step === 1 && (
              <div className="ob__step">
                <div className="sv-row ob__intro">
                  <VaultBuddy pose="wave" size={96} />
                  <div className="ob__bubble">
                    <h3 className="ob__title" ref={heading} tabIndex={-1}>
                      Your daily goal
                    </h3>
                    <p className="sv-muted">Change it any time.</p>
                  </div>
                </div>
                <PickGroup
                  legend="Daily goal"
                  items={GOALS}
                  value={goal}
                  onChange={setGoal}
                  cols={4}
                />
                <ul className="sv-row ob__rules" aria-label="How you earn XP">
                  <li className="ob__rulesLabel">Earn XP</li>
                  <li>
                    <Badge tone="primary" icon={Layers}>
                      Review +1
                    </Badge>
                  </li>
                  <li>
                    <Badge tone="sun" icon={Bookmark}>
                      Save +2
                    </Badge>
                  </li>
                  <li>
                    <Badge tone="violet" icon={Plus}>
                      New card +3
                    </Badge>
                  </li>
                  <li>
                    <Badge tone="success" icon={Trophy}>
                      Session +5
                    </Badge>
                  </li>
                </ul>
              </div>
            )}
            {step === 2 && (
              <div className="ob__step">
                <div className="sv-row ob__intro">
                  <VaultBuddy pose="think" size={96} />
                  <div className="ob__bubble">
                    <div className="sv-row ob__titleRow">
                      <h3 className="ob__title" ref={heading} tabIndex={-1}>
                        Turn on a site
                      </h3>
                      <InfoTip label="About site access" align="start">
                        Chrome asks before StudyVault can read a page. Nothing is asked during this
                        tour. Change it later in Settings.
                      </InfoTip>
                    </div>
                    <p className="sv-muted">Nothing is asked now.</p>
                  </div>
                </div>
                <PickGroup
                  legend="Site access"
                  items={ACCESS}
                  value={access}
                  onChange={setAccess}
                  cols={3}
                />
              </div>
            )}
            {step === 3 && (
              <div className="ob__step ob__step--center">
                <VaultBuddy pose="cheer" size={140} />
                <h3 className="ob__title" ref={heading} tabIndex={-1}>
                  You’re ready!
                </h3>
                <ul className="sv-row ob__summary" aria-label="Your choices">
                  <li>
                    <Badge tone="primary" icon={goalPick.icon}>
                      {goalPick.title} · {goalPick.meta}
                    </Badge>
                  </li>
                  <li>
                    <Badge tone="sun" icon={accessPick.icon}>
                      {accessPick.title}
                    </Badge>
                  </li>
                </ul>
                <div className="sv-card ob__game">
                  <Switch checked={game} onChange={setGame} label="Game mode" />
                  <span className="sv-muted">{game ? 'XP, streaks, badges' : 'Plain mode'}</span>
                </div>
                <Button variant="secondary" icon={PanelRight}>
                  Open side panel
                </Button>
              </div>
            )}

            <div className="sv-row ob__nav">
              <Button
                variant="secondary"
                size="lg"
                icon={ArrowLeft}
                onClick={() => setStep(step - 1)}
                disabledReason={step === 1 ? 'This is the first step' : undefined}
              >
                Back
              </Button>
              <span className="sv-spacer" />
              {step < total ? (
                <Button variant="primary" size="lg" onClick={() => setStep(step + 1)}>
                  Next
                </Button>
              ) : (
                <Button variant="sun" size="lg" onClick={() => setFinished(true)}>
                  Finish
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
