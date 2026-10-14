// Every Sunny Vault component and state, rendered once per theme column by main.tsx.
import { useId, useState } from 'react';
import {
  BookOpen,
  Brain,
  Copy,
  FileInput,
  FileText,
  Flame,
  HeartPulse,
  Layers,
  Library,
  ListTree,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Snowflake,
  Sparkles,
  Timer,
  Trash,
  Trophy,
  Workflow,
  Zap,
} from 'lucide-react';
import {
  BarMeter,
  ChoiceCards,
  ChunkyButton,
  Confetti,
  EmptyState,
  Heatmap,
  IconButton,
  IconTabBar,
  InfoTip,
  MoreGrid,
  ProgressRing,
  StatChip,
  VaultBuddy,
  useXpFloat,
  type BuddyPose,
  type MoreItem,
} from '@ui/design';
import { GOALS, SITES, type Goal, type Site } from './data';
import { SetupDialog, NewBankWizard } from './wizards';

const POSES: BuddyPose[] = ['wave', 'cheer', 'think', 'sleep'];
// 12 weeks of sample XP ending on a fixed day, so screenshots are stable.
const DAYS = Array.from({ length: 80 }, (_, i) =>
  i % 9 === 4 || i % 13 === 7 ? 0 : (i * 53 + 17) % 58,
);
const END = new Date(2026, 9, 14);

function Card({
  title,
  info,
  children,
}: {
  title: string;
  info?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="dz-card">
      <h2>
        {title}
        {info && <InfoTip label={`About ${title.toLowerCase()}`}>{info}</InfoTip>}
      </h2>
      {children}
    </section>
  );
}

function Mascot() {
  return (
    <Card title="Vault buddy" info="Decorative unless given a title. Motion stops within 5 s.">
      <div className="dz-poses">
        {POSES.map((pose) => (
          <figure key={pose}>
            <VaultBuddy pose={pose} size={96} title={`Vault buddy, ${pose}`} />
            <span className="dz-small">
              <VaultBuddy pose={pose} size={32} />
              <VaultBuddy pose={pose} size={48} />
            </span>
            <figcaption>{pose[0]!.toUpperCase() + pose.slice(1)}</figcaption>
          </figure>
        ))}
      </div>
    </Card>
  );
}

function Buttons() {
  const [pressed, setPressed] = useState(true);
  return (
    <Card title="Buttons">
      <div className="dz-row">
        <ChunkyButton variant="primary">Primary</ChunkyButton>
        <ChunkyButton>Secondary</ChunkyButton>
        <ChunkyButton variant="sun" icon={Layers}>
          Start review
        </ChunkyButton>
        <ChunkyButton variant="danger" icon={Trash}>
          Delete
        </ChunkyButton>
      </div>
      <div className="dz-row">
        <ChunkyButton variant="ghost">Ghost</ChunkyButton>
        <ChunkyButton size="sm" icon={Plus}>
          Small
        </ChunkyButton>
        <ChunkyButton size="lg" variant="primary">
          Large
        </ChunkyButton>
        <ChunkyButton variant="primary" disabledReason="Pick a colour first">
          Disabled
        </ChunkyButton>
      </div>
      <div className="dz-row">
        <IconButton icon={Search} label="Search" />
        <IconButton icon={Settings} label="Settings" />
        <IconButton
          icon={Pencil}
          label="Edit mode"
          aria-pressed={pressed}
          onClick={() => setPressed(!pressed)}
        />
        <IconButton icon={Copy} label="Copy" size="sm" tipSide="right" />
      </div>
    </Card>
  );
}

function Game() {
  const [xp, setXp] = useState(18);
  const [burst, setBurst] = useState(0);
  const float = useXpFloat();
  return (
    <Card title="Game layer" info="XP is rating-neutral: review 1, save 2, card 3, session +5.">
      <div className="dz-row">
        <StatChip icon={Flame} value={12} label="day streak" tone="flame" />
        <StatChip icon={Snowflake} value={2} label="freezes" tone="ice" />
        <span className="dz-xp">
          <StatChip icon={Zap} value={xp} label="XP today" tone="sun" />
          {float.node}
        </span>
      </div>
      <div className="dz-row">
        <ProgressRing value={0} max={30} unit="XP" label="Daily goal" size={64}>
          <span className="dz-ringnum">0</span>
        </ProgressRing>
        <ProgressRing value={xp} max={30} unit="XP" label="Daily goal" size={88} stroke={10}>
          <span className="dz-ringnum dz-ringnum--lg">{xp}</span>
          <span className="dz-ringof">of 30 XP</span>
        </ProgressRing>
        <ProgressRing value={7} max={10} label="Cards" tone="primary" size={64}>
          <span className="dz-ringnum">7</span>
        </ProgressRing>
        <ProgressRing value={10} max={10} label="Session" tone="success" size={64}>
          <span className="dz-ringnum">10</span>
        </ProgressRing>
      </div>
      <div className="dz-stack">
        {(
          [
            ['Level 7', 340, 500, 'sun', 'lg'],
            ['Cardiology', 72, 100, 'success', 'md'],
            ['Neuro', 48, 100, 'primary', 'md'],
            ['Exam prep', 30, 100, 'violet', 'sm'],
            ['Inbox', 0, 100, 'success', 'md'],
          ] as const
        ).map(([label, value, max, tone, size]) => (
          <div className="dz-meterrow" key={label}>
            <span>{label}</span>
            <BarMeter value={value} max={max} label={label} tone={tone} size={size} />
            <span>{max === 100 ? `${value}%` : `${value}/${max}`}</span>
          </div>
        ))}
      </div>
      <div className="dz-row">
        <ChunkyButton
          variant="sun"
          icon={Zap}
          onClick={() => {
            setXp(xp + 2);
            float.award(2);
          }}
        >
          Save (+2 XP)
        </ChunkyButton>
        <ChunkyButton icon={Trophy} onClick={() => setBurst(burst + 1)}>
          Celebrate
        </ChunkyButton>
      </div>
      <div className="dz-confetti">
        {burst > 0 && <Confetti key={burst} />}
        <VaultBuddy pose="cheer" size={88} />
      </div>
    </Card>
  );
}

function Choices() {
  const [goal, setGoal] = useState<Goal>('30');
  const [site, setSite] = useState<Site | null>(null);
  const id = useId();
  return (
    <Card title="Picture choices">
      <h3 id={`${id}-goal`}>Your daily goal</h3>
      <ChoiceCards
        labelledBy={`${id}-goal`}
        value={goal}
        onChange={setGoal}
        options={GOALS}
        columns={4}
      />
      <h3 id={`${id}-site`}>Turn on a site</h3>
      <ChoiceCards labelledBy={`${id}-site`} value={site} onChange={setSite} options={SITES} />
    </Card>
  );
}

const MORE: MoreItem[] = [
  { id: 'rules', label: 'Rules', icon: Workflow, tone: 'primary', onSelect: () => {} },
  { id: 'syllabus', label: 'Syllabus', icon: ListTree, tone: 'success', onSelect: () => {} },
  { id: 'graph', label: 'Graph', icon: Network, tone: 'violet', onSelect: () => {} },
  { id: 'exam', label: 'Exam', icon: Timer, tone: 'danger', onSelect: () => {} },
  { id: 'imports', label: 'Imports', icon: FileInput, tone: 'warning', onSelect: () => {} },
  { id: 'ai', label: 'AI', icon: Sparkles, tone: 'violet', status: 'Off', onSelect: () => {} },
  {
    id: 'sync',
    label: 'Sync',
    icon: RefreshCw,
    tone: 'success',
    status: 'Off',
    onSelect: () => {},
  },
  { id: 'trash', label: 'Trash', icon: Trash, tone: 'neutral', onSelect: () => {} },
  { id: 'settings', label: 'Settings', icon: Settings, tone: 'neutral', onSelect: () => {} },
];

type Tab = 'page' | 'banks' | 'review' | 'search' | 'more';

function SidePanel() {
  const [tab, setTab] = useState<Tab>('page');
  return (
    <Card title="Side panel, 320px">
      <div className="dz-panel">
        <div className="dz-panel__head">
          <VaultBuddy pose="wave" size={36} />
          <ProgressRing value={18} max={30} unit="XP" label="Daily goal" size={40} stroke={6}>
            <span>18</span>
          </ProgressRing>
          <StatChip icon={Flame} value={12} label="day streak" tone="flame" hideLabel />
          <span className="dz-spacer" />
          <IconButton icon={Settings} label="Settings" tipSide="left" />
        </div>
        <IconTabBar
          label="Side panel"
          tabs={[
            { id: 'page', label: 'This page', icon: FileText },
            { id: 'banks', label: 'Banks', icon: Library },
            { id: 'review', label: 'Review', icon: Layers, count: 14 },
            { id: 'search', label: 'Search', icon: Search },
          ]}
          more={{ id: 'more' }}
          active={tab}
          onChange={setTab}
        >
          <div className="dz-panel__body">
            {tab === 'page' && (
              <EmptyState
                title="Nothing saved yet"
                text="Select text, then Alt S."
                heading="h3"
                mascotSize={112}
              />
            )}
            {tab === 'banks' &&
              (
                [
                  ['Cardiology', HeartPulse, 'danger', 72],
                  ['Neuro', Brain, 'violet', 48],
                  ['Inbox', BookOpen, 'success', 0],
                ] as const
              ).map(([name, Icon, tone, pct]) => (
                <div className="dz-bank" key={name}>
                  <span className="dz-bank__top">
                    <span className={`dz-bank__tile sv-art--${tone}`} aria-hidden="true">
                      <Icon strokeWidth={2.4} />
                    </span>
                    <span className="dz-bank__name">
                      {name}
                      <small>{pct ? '64 cards' : 'No cards yet'}</small>
                    </span>
                  </span>
                  <span className="dz-bank__bar">
                    <BarMeter
                      value={pct}
                      max={100}
                      label={`${name} mastered`}
                      tone="success"
                      size="sm"
                    />
                    {pct}%
                  </span>
                </div>
              ))}
            {tab === 'review' && (
              <EmptyState
                pose="cheer"
                title="14 cards due"
                text="About 6 minutes."
                heading="h3"
                mascotSize={96}
                action={{ label: 'Start review', icon: Layers, onClick: () => {} }}
              />
            )}
            {tab === 'search' && (
              <EmptyState
                pose="think"
                title="Search everything"
                text="Notes, cards and pages."
                heading="h3"
              />
            )}
            {tab === 'more' && <MoreGrid label="More tools" items={MORE} columns={3} />}
          </div>
        </IconTabBar>
      </div>
    </Card>
  );
}

function Empties() {
  return (
    <Card title="Empty states">
      <div className="dz-emptygrid">
        <EmptyState
          pose="wave"
          title="No banks yet"
          text="Group what you save."
          heading="h3"
          mascotSize={88}
          action={{ label: 'New bank', icon: Plus, onClick: () => {} }}
        />
        <EmptyState
          pose="sleep"
          title="All caught up"
          text="Next card tomorrow."
          heading="h3"
          mascotSize={88}
        />
      </div>
    </Card>
  );
}

function Contrast() {
  const [goal, setGoal] = useState<Goal>('50');
  return (
    <Card
      title="More contrast, compact"
      info="data-contrast=more and data-density=compact on a wrapper."
    >
      <div className="dz-hc dz-stack" data-contrast="more" data-density="compact">
        <div className="dz-row">
          <ChunkyButton variant="primary">Next</ChunkyButton>
          <ChunkyButton>Back</ChunkyButton>
          <StatChip icon={Zap} value={340} label="XP" tone="sun" />
        </div>
        <BarMeter value={340} max={500} label="Level 7" tone="sun" />
        <ChoiceCards
          label="Daily goal"
          value={goal}
          onChange={setGoal}
          options={GOALS.slice(1, 3)}
        />
      </div>
    </Card>
  );
}

export function Showcase() {
  return (
    <div className="dz-grid">
      <Mascot />
      <Buttons />
      <Game />
      <Card title="Streak calendar" info="Arrow keys move by day and week. Escape hides the tip.">
        <Heatmap days={DAYS} goal={30} title="Streak calendar" end={END} locale="en-US" />
      </Card>
      <Choices />
      <NewBankWizard />
      <SidePanel />
      <SetupDialog />
      <Empties />
      <Contrast />
    </div>
  );
}
