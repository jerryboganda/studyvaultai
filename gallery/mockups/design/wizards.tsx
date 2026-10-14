// Wizard demos: an inline (page) flow with validation, and a dialog flow with a dirty check.
import { useId, useState } from 'react';
import { BookOpen, Brain, Dna, HeartPulse, Pill, Plus, RotateCcw, Sparkles } from 'lucide-react';
import {
  BarMeter,
  ChoiceCards,
  ChunkyButton,
  Confetti,
  VaultBuddy,
  Wizard,
  type Choice,
} from '@ui/design';
import { GOALS, SITES, type Goal, type Site } from './data';

type IconId = 'brain' | 'heart' | 'pill' | 'dna' | 'book';
const ICONS: Choice<IconId>[] = [
  { value: 'brain', label: 'Brain', icon: Brain, tone: 'violet' },
  { value: 'heart', label: 'Heart', icon: HeartPulse, tone: 'danger' },
  { value: 'pill', label: 'Pills', icon: Pill, tone: 'warning' },
  { value: 'dna', label: 'Genes', icon: Dna, tone: 'success' },
  { value: 'book', label: 'Book', icon: BookOpen, tone: 'primary' },
];

export function NewBankWizard() {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<IconId>('brain');
  const [done, setDone] = useState(false);
  const nameId = useId();
  const chosen = ICONS.find((i) => i.value === icon)!;
  const Icon = chosen.icon!;

  if (done) {
    return (
      <section className="dz-card dz-done" aria-label="New bank">
        <Confetti />
        <VaultBuddy pose="cheer" size={112} />
        <h2>Bank ready!</h2>
        <ChunkyButton
          icon={RotateCcw}
          onClick={() => {
            setName('');
            setIcon('brain');
            setDone(false);
          }}
        >
          Start again
        </ChunkyButton>
      </section>
    );
  }
  return (
    <Wizard
      className="dz-flow"
      label="New bank"
      finishLabel="Create bank"
      onFinish={() => setDone(true)}
      steps={[
        {
          id: 'name',
          title: 'Name your bank',
          validate: () => (name.trim() ? null : 'Enter a name'),
          content: ({ error, errorId }) => (
            <div className="sv-textfield">
              <label htmlFor={nameId}>Bank name</label>
              <input
                id={nameId}
                value={name}
                maxLength={60}
                placeholder="e.g. Anatomy"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          ),
        },
        {
          id: 'icon',
          title: 'Pick an icon',
          content: (
            <ChoiceCards label="Icon" value={icon} onChange={setIcon} options={ICONS} columns={3} />
          ),
        },
        {
          id: 'review',
          title: 'Looks good?',
          content: (
            <div className="dz-bank">
              <span className="dz-bank__top">
                <span className={`dz-bank__tile sv-art--${chosen.tone}`} aria-hidden="true">
                  <Icon strokeWidth={2.4} />
                </span>
                <span className="dz-bank__name">
                  {name.trim()}
                  <small>0 saved · 0 cards</small>
                </span>
              </span>
              <span className="dz-bank__bar">
                <BarMeter
                  value={0}
                  max={100}
                  label={`${name.trim()} mastered`}
                  tone="success"
                  size="sm"
                />
                0%
              </span>
            </div>
          ),
        },
      ]}
    />
  );
}

export function SetupDialog() {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const reset = () => {
    setGoal(null);
    setSite(null);
    setOpen(false);
  };
  return (
    <section className="dz-card">
      <h2>Wizard as a dialog</h2>
      <div className="dz-row">
        <ChunkyButton variant="primary" icon={Sparkles} onClick={() => setOpen(true)}>
          Set up
        </ChunkyButton>
        <span className="dz-note">{saved ?? 'Escape asks first once you pick something.'}</span>
      </div>
      {open && (
        <Wizard
          variant="dialog"
          label="Set up"
          dirty={goal !== null || site !== null}
          onClose={reset}
          finishLabel="Done"
          onFinish={() => {
            setSaved(
              `Saved: ${goal} XP a day, ${site === 'tab' ? 'this tab' : site === 'site' ? 'one site' : 'all sites'}.`,
            );
            reset();
          }}
          steps={[
            {
              id: 'goal',
              title: 'Your daily goal',
              validate: () => (goal ? null : 'Pick a goal'),
              content: (
                <ChoiceCards
                  label="Daily goal"
                  value={goal}
                  onChange={setGoal}
                  options={GOALS}
                  columns={2}
                />
              ),
            },
            {
              id: 'site',
              title: 'Turn on a site',
              validate: () => (site ? null : 'Pick one'),
              content: (
                <ChoiceCards label="Site access" value={site} onChange={setSite} options={SITES} />
              ),
            },
            {
              id: 'ready',
              title: 'All set',
              content: (
                <div className="dz-row">
                  <VaultBuddy pose="cheer" size={72} />
                  <span>You can change these later.</span>
                </div>
              ),
            },
          ]}
        />
      )}
      <ChunkyButton size="sm" icon={Plus} disabledReason="Only one setup at a time">
        Another
      </ChunkyButton>
    </section>
  );
}
