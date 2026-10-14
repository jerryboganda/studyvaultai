// Onboarding wizard (1280x800): one decision per screen, stepper, picture cards, Back/Next.
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Globe,
  LayoutGrid,
  MousePointerClick,
  PanelRight,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { LogoMark, VaultBuddy } from '../VaultBuddy';
import { Btn, InfoTip, Steps, useGo } from '../ui';

const STEPS = ['Welcome', 'Daily goal', 'Site access', 'Ready'];

type Goal = { id: string; label: string; xp: number; min: number; tone: string };
const GOALS: Goal[] = [
  { id: 'casual', label: 'Casual', xp: 10, min: 3, tone: 'mint' },
  { id: 'regular', label: 'Regular', xp: 30, min: 10, tone: 'rose' },
  { id: 'serious', label: 'Serious', xp: 50, min: 15, tone: 'butter' },
  { id: 'intense', label: 'Intense', xp: 100, min: 30, tone: 'lavender' },
];
const SITES: { id: string; label: string; sub: string; icon: LucideIcon; tone: string }[] = [
  { id: 'tab', label: 'This tab', sub: 'Just for now', icon: MousePointerClick, tone: 'mint' },
  { id: 'site', label: 'One site', sub: 'Always on there', icon: Globe, tone: 'sky' },
  { id: 'later', label: 'Later', sub: 'Skip for now', icon: Clock, tone: 'peach' },
];

/** Garden art for the goal cards: a pot that grows from sprout to blossoming tree. */
function GoalArt({ id, tone }: { id: string; tone: string }) {
  return (
    <svg
      className="sv-pick__art"
      viewBox="0 0 84 84"
      data-tone={tone}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="42" cy="42" r="38" fill="var(--t-soft)" />
      {id === 'casual' && (
        <g>
          <path
            d="M42 56 V40"
            stroke="var(--sv-mint-solid)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <ellipse
            cx="35"
            cy="40"
            rx="7.5"
            ry="4.2"
            transform="rotate(-28 35 40)"
            fill="var(--sv-mint-solid)"
          />
          <ellipse
            cx="49"
            cy="37"
            rx="7.5"
            ry="4.2"
            transform="rotate(28 49 37)"
            fill="var(--sv-mint-solid)"
          />
        </g>
      )}
      {id === 'regular' && (
        <g>
          <path
            d="M42 56 V30"
            stroke="var(--sv-mint-solid)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <ellipse
            cx="34"
            cy="46"
            rx="8"
            ry="3.8"
            transform="rotate(-35 34 46)"
            fill="var(--sv-mint-solid)"
          />
          <path
            d="M32 18 q0 13 10 14 q10 -1 10 -14 l-5 4.5 l-5 -7 l-5 7 z"
            fill="var(--sv-rose-solid)"
          />
        </g>
      )}
      {id === 'serious' && (
        <g>
          <path
            d="M42 56 V30"
            stroke="var(--sv-mint-solid)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <ellipse
            cx="50"
            cy="45"
            rx="8"
            ry="3.8"
            transform="rotate(35 50 45)"
            fill="var(--sv-mint-solid)"
          />
          {Array.from({ length: 10 }, (_, i) => (
            <ellipse
              key={i}
              cx="42"
              cy="13"
              rx="3.6"
              ry="7"
              transform={`rotate(${i * 36} 42 23)`}
              fill="var(--sv-flame-core)"
            />
          ))}
          <circle cx="42" cy="23" r="6" fill="var(--sv-peach-solid)" />
        </g>
      )}
      {id === 'intense' && (
        <g>
          <rect x="39.5" y="34" width="5" height="22" rx="2.5" fill="var(--sv-peach-solid)" />
          <circle cx="32" cy="30" r="11" fill="var(--sv-mint-solid)" />
          <circle cx="52" cy="30" r="11" fill="var(--sv-mint-solid)" />
          <circle cx="42" cy="20" r="13" fill="var(--sv-mint-solid)" />
          <circle cx="35" cy="22" r="2.6" fill="var(--sv-rose-soft)" />
          <circle cx="48" cy="16" r="2.6" fill="var(--sv-rose-soft)" />
          <circle cx="53" cy="31" r="2.6" fill="var(--sv-rose-soft)" />
          <circle cx="30" cy="33" r="2.6" fill="var(--sv-rose-soft)" />
          <circle cx="43" cy="28" r="2.6" fill="var(--sv-rose-soft)" />
        </g>
      )}
      <rect x="25" y="54" width="34" height="8" rx="4" fill="var(--sv-lavender-solid)" />
      <path
        d="M28 61 h28 l-3.4 13 q-0.8 3 -3.8 3 h-13.6 q-3 0 -3.8 -3 z"
        fill="var(--sv-primary)"
      />
    </svg>
  );
}

export function Onboarding() {
  const go = useGo();
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState('regular');
  const [site, setSite] = useState('tab');
  const head = useRef<HTMLHeadingElement>(null);
  const g = GOALS.find((x) => x.id === goal)!;
  const s = SITES.find((x) => x.id === site)!;
  const SiteIcon = s.icon;

  const move = (n: number) => {
    flushSync(() => setStep(n));
    head.current?.focus();
  };

  return (
    <div className="ob">
      <span className="ob-blob ob-blob--a" aria-hidden="true" />
      <span className="ob-blob ob-blob--b" aria-hidden="true" />
      <span className="ob-blob ob-blob--c" aria-hidden="true" />
      <div className="ob-card">
        <div className="ob-top">
          <LogoMark size={32} />
          <span className="ob-brand">StudyVault</span>
          <span className="ob-count">
            Step {step + 1} of {STEPS.length}
          </span>
          {step < 3 && (
            <Btn variant="ghost" size="sm" onClick={() => move(3)}>
              Skip
            </Btn>
          )}
        </div>
        <Steps steps={STEPS} current={step} label="Setup progress" />

        <div className="ob-body" key={step}>
          {step === 0 && (
            <div className="ob-hero">
              <VaultBuddy pose="wave" size={168} />
              <h1 ref={head} tabIndex={-1}>
                Welcome to StudyVault
              </h1>
              <p className="ob-lead">
                Save, sort and review what you read.
                <InfoTip label="Where your data lives">
                  <strong>Local-first.</strong> Highlights, cards and progress stay on this device.
                  Sync and AI are off unless you turn them on.
                </InfoTip>
              </p>
              <ul className="ob-points">
                <li data-tone="butter">
                  <span className="sv-well sv-well--sm">
                    <MousePointerClick aria-hidden="true" strokeWidth={2.4} />
                  </span>
                  Save
                </li>
                <li data-tone="lavender">
                  <span className="sv-well sv-well--sm">
                    <LayoutGrid aria-hidden="true" strokeWidth={2.4} />
                  </span>
                  Sort
                </li>
                <li data-tone="mint">
                  <span className="sv-well sv-well--sm">
                    <Check aria-hidden="true" strokeWidth={2.8} />
                  </span>
                  Review
                </li>
              </ul>
            </div>
          )}

          {step === 1 && (
            <>
              <h1 ref={head} tabIndex={-1}>
                Pick your daily goal
              </h1>
              <p className="ob-lead">Change it anytime.</p>
              <fieldset className="sv-picks ob-picks">
                <legend className="sv-vh">Daily goal</legend>
                {GOALS.map((x) => (
                  <label key={x.id} className="sv-pick">
                    <input
                      type="radio"
                      name="ob-goal"
                      value={x.id}
                      checked={goal === x.id}
                      onChange={() => setGoal(x.id)}
                    />
                    <span className="sv-pick__check" aria-hidden="true">
                      <Check strokeWidth={3.5} />
                    </span>
                    <GoalArt id={x.id} tone={x.tone} />
                    <span className="sv-pick__title">{x.label}</span>
                    <span className="sv-pick__sub">{x.xp} XP a day</span>
                    <span className="sv-chip" data-tone={x.tone}>
                      ~{x.min} min
                    </span>
                  </label>
                ))}
              </fieldset>
            </>
          )}

          {step === 2 && (
            <>
              <h1 ref={head} tabIndex={-1}>
                Turn on a site
              </h1>
              <p className="ob-lead">
                Chrome asks you first.
                <InfoTip label="About site access">
                  Nothing is requested at install. Pick a tab or a site now, and change it later in
                  Settings.
                </InfoTip>
              </p>
              <fieldset className="sv-picks ob-picks ob-picks--3">
                <legend className="sv-vh">Where StudyVault runs</legend>
                {SITES.map((x) => {
                  const Icon = x.icon;
                  return (
                    <label key={x.id} className="sv-pick">
                      <input
                        type="radio"
                        name="ob-site"
                        value={x.id}
                        checked={site === x.id}
                        onChange={() => setSite(x.id)}
                      />
                      <span className="sv-pick__check" aria-hidden="true">
                        <Check strokeWidth={3.5} />
                      </span>
                      <span className="sv-well sv-well--lg ob-pickwell" data-tone={x.tone}>
                        <Icon aria-hidden="true" strokeWidth={2.2} />
                      </span>
                      <span className="sv-pick__title">{x.label}</span>
                      <span className="sv-pick__sub">{x.sub}</span>
                    </label>
                  );
                })}
              </fieldset>
              <p className="ob-safe">
                <ShieldCheck aria-hidden="true" strokeWidth={2.4} />
                Never all sites at install
              </p>
            </>
          )}

          {step === 3 && (
            <div className="ob-hero">
              <VaultBuddy pose="cheer" size={168} />
              <h1 ref={head} tabIndex={-1}>
                You&apos;re ready!
              </h1>
              <p className="ob-lead">Your first goal starts today.</p>
              <div className="ob-summary">
                <span className="sv-chip" data-tone={g.tone}>
                  {g.label} · {g.xp} XP
                </span>
                <span className="sv-chip" data-tone={s.tone}>
                  <SiteIcon aria-hidden="true" strokeWidth={2.6} />
                  {s.label}
                </span>
              </div>
              <div className="ob-finish">
                <Btn variant="primary" size="lg" icon={PanelRight} onClick={() => go('sidepanel')}>
                  Open side panel
                </Btn>
                <Btn variant="soft" size="lg" icon={LayoutGrid} onClick={() => go('dashboard')}>
                  Dashboard
                </Btn>
              </div>
            </div>
          )}
        </div>

        <div className="ob-nav">
          <Btn
            variant="ghost"
            icon={ArrowLeft}
            onClick={() => move(step - 1)}
            disabledReason={step === 0 ? 'This is the first step' : undefined}
          >
            Back
          </Btn>
          {step < 3 ? (
            <Btn
              variant="primary"
              size="lg"
              onClick={() => move(step + 1)}
              trailing={<ArrowRight aria-hidden="true" strokeWidth={2.6} />}
            >
              {step === 0 ? "Let's go" : 'Next'}
            </Btn>
          ) : (
            <Btn variant="ghost" onClick={() => move(0)}>
              Start over
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
