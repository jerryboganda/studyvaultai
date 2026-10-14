// Onboarding wizard (1280x800): one decision per screen, big picture cards, Back/Next.
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Globe,
  LayoutDashboard,
  MousePointerClick,
  PanelRightOpen,
  Pin,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import { Button, Flash, InfoTip, Kbd, Stepper, useFlash } from '../ui';
import { VaultBuddy } from '../VaultBuddy';

const GOALS = [
  { id: 'casual', name: 'Casual', xp: 10 },
  { id: 'regular', name: 'Regular', xp: 30 },
  { id: 'serious', name: 'Serious', xp: 50 },
  { id: 'intense', name: 'Intense', xp: 100 },
] as const;

const ACCESS: { id: string; name: string; hint: string; icon: LucideIcon }[] = [
  { id: 'tab', name: 'This tab', hint: 'Click to turn on', icon: MousePointerClick },
  { id: 'sites', name: 'Sites I pick', hint: 'One site at a time', icon: Pin },
  { id: 'all', name: 'All sites', hint: 'Chrome asks first', icon: Globe },
];

const STEPS = ['Daily goal', 'Site access', 'Ready'];

/** A little arcade speed gauge: the needle climbs with the goal. */
function Gauge({ level }: { level: number }) {
  const t = (level + 1) / 4;
  const a = Math.PI * (1 - t);
  const nx = 50 + Math.cos(a) * 30;
  const ny = 52 - Math.sin(a) * 30;
  const end = { x: 50 + Math.cos(a) * 38, y: 52 - Math.sin(a) * 38 };
  return (
    <svg
      className="ob-gauge"
      viewBox="0 0 100 64"
      width={120}
      height={77}
      aria-hidden
      focusable="false"
    >
      <path className="ob-gauge__track" d="M12 52 A38 38 0 0 1 88 52" />
      <path
        className="ob-gauge__edge"
        d={`M12 52 A38 38 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`}
      />
      <path
        className={`ob-gauge__fill${level === 3 ? ' is-max' : ''}`}
        d={`M12 52 A38 38 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`}
      />
      {[0, 1, 2, 3, 4].map((i) => {
        const ta = Math.PI * (1 - i / 4);
        return (
          <line
            key={i}
            className="ob-gauge__tick"
            x1={50 + Math.cos(ta) * 46}
            y1={52 - Math.sin(ta) * 46}
            x2={50 + Math.cos(ta) * 50}
            y2={52 - Math.sin(ta) * 50}
          />
        );
      })}
      <line className="ob-gauge__needle" x1={50} y1={52} x2={nx} y2={ny} />
      <circle className="ob-gauge__hub" cx={50} cy={52} r={6} />
    </svg>
  );
}

export function Onboarding() {
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState<(typeof GOALS)[number]['id']>('regular');
  const [access, setAccess] = useState('sites');
  const [finished, setFinished] = useState(false);
  const [moved, setMoved] = useState(false);
  const [msg, flash] = useFlash();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (moved) heading.current?.focus();
  }, [step, finished, moved]);

  const go = (n: number) => {
    setMoved(true);
    setStep(n);
  };
  const g = GOALS.find((x) => x.id === goal) ?? GOALS[1];
  const ac = ACCESS.find((x) => x.id === access) ?? ACCESS[1];

  return (
    <div className="ob">
      <header className="ob-top">
        <span className="ob-logo">
          <VaultBuddy pose="wave" size={36} />
          StudyVault
        </span>
        {!finished && (
          <button
            type="button"
            className="sv-btn sv-btn--ghost sv-btn--sm"
            onClick={() => {
              setMoved(true);
              setFinished(true);
            }}
          >
            Skip tour
          </button>
        )}
      </header>

      <div className="sv-card ob-card">
        {finished ? (
          <div className="ob-done">
            <VaultBuddy pose="wave" size={150} />
            <h2 ref={heading} tabIndex={-1}>
              All set!
            </h2>
            <p className="sv-muted">See you on your first page.</p>
            <div className="ob-done__cta">
              <a className="sv-btn sv-btn--primary sv-btn--lg" href="#screen-dashboard">
                <LayoutDashboard aria-hidden size={22} strokeWidth={2.5} />
                <span>Open dashboard</span>
              </a>
              <Button
                variant="ghost"
                icon={RotateCcw}
                onClick={() => {
                  setFinished(false);
                  go(0);
                }}
              >
                Start over
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Stepper step={step} total={STEPS.length} label={STEPS[step] ?? ''} />
            {step < 2 && <VaultBuddy pose="think" size={96} className="ob-buddy" />}

            {step === 0 && (
              <fieldset className="ob-step">
                <legend>
                  <h2 ref={heading} tabIndex={-1}>
                    Pick your daily goal
                  </h2>
                </legend>
                <p className="ob-help">
                  Change it any time.
                  <InfoTip label="How XP works">
                    Review a card: 1 XP, whatever you rate it. Save a highlight: 2. Make a card: 3.
                    Finish a session: +5.
                  </InfoTip>
                </p>
                <div className="ob-picks ob-picks--4">
                  {GOALS.map((x, i) => (
                    <label key={x.id} className="sv-pick">
                      <input
                        type="radio"
                        name="ob-goal"
                        value={x.id}
                        checked={goal === x.id}
                        onChange={() => setGoal(x.id)}
                      />
                      <span className="sv-pick__check" aria-hidden>
                        <Check size={14} strokeWidth={3.5} />
                      </span>
                      <Gauge level={i} />
                      <span className="ob-pick__name">{x.name}</span>
                      <span className="ob-pick__xp">
                        <span className="sv-num">{x.xp}</span> XP / day
                      </span>
                      <span className="ob-pick__hint">≈ {x.xp} cards</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {step === 1 && (
              <fieldset className="ob-step">
                <legend>
                  <h2 ref={heading} tabIndex={-1}>
                    Turn on a site
                  </h2>
                </legend>
                <p className="ob-help">
                  Nothing is asked now.
                  <InfoTip label="About site access">
                    StudyVault only runs where you allow it. Chrome shows its own prompt before a
                    site is added, and you can change this in Settings.
                  </InfoTip>
                </p>
                <div className="ob-picks ob-picks--3">
                  {ACCESS.map((x) => (
                    <label key={x.id} className="sv-pick ob-access">
                      <input
                        type="radio"
                        name="ob-access"
                        value={x.id}
                        checked={access === x.id}
                        onChange={() => setAccess(x.id)}
                      />
                      <span className="sv-pick__check" aria-hidden>
                        <Check size={14} strokeWidth={3.5} />
                      </span>
                      <span className="ob-access__art" aria-hidden>
                        <x.icon size={40} strokeWidth={2.2} />
                      </span>
                      <span className="ob-pick__name">{x.name}</span>
                      <span className="ob-pick__hint">{x.hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {step === 2 && (
              <div className="ob-step ob-ready">
                <VaultBuddy pose="cheer" size={150} />
                <h2 ref={heading} tabIndex={-1}>
                  You’re ready!
                </h2>
                <p className="ob-summary">
                  <span className="sv-badge sv-badge--ok">
                    <Check aria-hidden size={14} strokeWidth={3} /> {g.name} · {g.xp} XP
                  </span>
                  {ac && (
                    <span className="sv-badge sv-badge--info">
                      <ac.icon aria-hidden size={14} strokeWidth={2.8} /> {ac.name}
                    </span>
                  )}
                </p>
                <Button
                  variant="pink"
                  size="lg"
                  icon={PanelRightOpen}
                  onClick={() => flash('Side panel opened')}
                >
                  Open side panel
                </Button>
                <p className="ob-help">
                  Or press <Kbd>Alt</Kbd> <Kbd>Shift</Kbd> <Kbd>S</Kbd>
                </p>
              </div>
            )}

            <div className="ob-nav">
              <Button
                variant="ghost"
                icon={ArrowLeft}
                onClick={() => go(step - 1)}
                disabledReason={step === 0 ? 'This is the first step' : undefined}
              >
                Back
              </Button>
              <Button
                variant="primary"
                iconAfter={step === STEPS.length - 1 ? Check : ArrowRight}
                onClick={() => {
                  if (step === STEPS.length - 1) {
                    setMoved(true);
                    setFinished(true);
                  } else go(step + 1);
                }}
              >
                {step === STEPS.length - 1 ? 'Finish' : 'Next'}
              </Button>
            </div>
          </>
        )}
        <Flash msg={msg} />
      </div>
    </div>
  );
}
