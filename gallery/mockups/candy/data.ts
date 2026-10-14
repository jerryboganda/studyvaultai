// Static sample data for the Candy Garden mockups (no backend). Numbers are illustrative only;
// the product draws every figure from the local database.
import {
  Award,
  BookA,
  Bone,
  Bookmark,
  Brain,
  CircleQuestionMark,
  Compass,
  Copy,
  FileDown,
  Flame,
  FolderPlus,
  HardDrive,
  HeartPulse,
  Inbox,
  Languages,
  Layers,
  Lightbulb,
  ListTree,
  MessageCircle,
  Moon,
  Network,
  Pill,
  Quote,
  RefreshCw,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Sunrise,
  Timer,
  Trash,
  Trophy,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';

export type Tone = 'lavender' | 'mint' | 'peach' | 'butter' | 'sky' | 'rose';

export const ME = {
  name: 'Sam',
  goal: 30,
  todayXp: 18,
  streak: 12,
  freezes: 2,
  level: 7,
  levelXp: 340,
  levelNeed: 500,
  due: 14,
  mix: { new: 4, learning: 3, review: 7 },
};

export type Kind = { id: string; label: string; tone: Tone; icon: LucideIcon };
export const KINDS: Kind[] = [
  { id: 'key', label: 'Key idea', tone: 'butter', icon: Lightbulb },
  { id: 'def', label: 'Definition', tone: 'mint', icon: BookA },
  { id: 'q', label: 'Question', tone: 'rose', icon: CircleQuestionMark },
  { id: 'ex', label: 'Example', tone: 'lavender', icon: Shapes },
  { id: 'src', label: 'Source', tone: 'sky', icon: Quote },
];
export const kindOf = (id: string): Kind => KINDS.find((k) => k.id === id) ?? KINDS[0]!;

export type Bank = {
  id: string;
  name: string;
  icon: LucideIcon;
  tone: Tone;
  items: number;
  due: number;
  learned: number;
};
export const BANKS: Bank[] = [
  {
    id: 'cardio',
    name: 'Cardiology',
    icon: HeartPulse,
    tone: 'rose',
    items: 128,
    due: 6,
    learned: 72,
  },
  {
    id: 'neuro',
    name: 'Neuroscience',
    icon: Brain,
    tone: 'lavender',
    items: 94,
    due: 4,
    learned: 58,
  },
  { id: 'pharm', name: 'Pharmacology', icon: Pill, tone: 'peach', items: 76, due: 3, learned: 41 },
  { id: 'anat', name: 'Anatomy', icon: Bone, tone: 'butter', items: 152, due: 1, learned: 83 },
  { id: 'span', name: 'Spanish', icon: Languages, tone: 'sky', items: 210, due: 0, learned: 64 },
  { id: 'inbox', name: 'Inbox', icon: Inbox, tone: 'mint', items: 12, due: 0, learned: 20 },
];
export const bankOf = (id: string): Bank => BANKS.find((b) => b.id === id) ?? BANKS[0]!;

export type Highlight = {
  id: string;
  quote: string;
  kind: string;
  bank: string;
  tags: string[];
  attention?: boolean;
};
export const HIGHLIGHTS: Highlight[] = [
  {
    id: 'h5',
    quote: 'A BNP above 400 pg/mL makes heart failure likely in a breathless patient.',
    kind: 'key',
    bank: 'cardio',
    tags: ['labs'],
    attention: true,
  },
  {
    id: 'h1',
    quote:
      'The Frank–Starling law: stroke volume rises as the ventricle fills with more blood, up to a limit. Past that point, extra stretch no longer adds force and the curve flattens.',
    kind: 'key',
    bank: 'cardio',
    tags: ['physiology', 'high-yield'],
  },
  {
    id: 'h2',
    quote: 'An ejection fraction under 40% points to heart failure with reduced ejection fraction.',
    kind: 'def',
    bank: 'cardio',
    tags: ['definition'],
  },
  {
    id: 'h3',
    quote: 'Why do loop diuretics ease breathlessness before the weight starts to fall?',
    kind: 'q',
    bank: 'pharm',
    tags: ['diuretics'],
  },
  {
    id: 'h4',
    quote:
      'ACE inhibitors lower afterload and slow remodelling; check potassium and kidney function.',
    kind: 'ex',
    bank: 'pharm',
    tags: ['drugs', 'monitoring'],
  },
];

export type Card = {
  id: string;
  bank: string;
  front: string;
  back: string;
  source?: string;
  intervals: [string, string, string, string];
};
export const CARDS: Card[] = [
  {
    id: 'c1',
    bank: 'cardio',
    front: 'What does the Frank–Starling law describe?',
    back: 'Stroke volume rises with ventricular filling, up to a limit.',
    source: 'stroke volume rises as the ventricle fills with more blood, up to a limit',
    intervals: ['<1m', '6m', '1d', '4d'],
  },
  {
    id: 'c2',
    bank: 'cardio',
    front: 'Which ejection fraction marks HFrEF?',
    back: 'Below 40%.',
    source:
      'An ejection fraction under 40% points to heart failure with reduced ejection fraction.',
    intervals: ['<1m', '10m', '2d', '5d'],
  },
  {
    id: 'c3',
    bank: 'pharm',
    front: 'Loop diuretics act on which part of the nephron?',
    back: 'The thick ascending limb of the loop of Henle.',
    intervals: ['<1m', '8m', '1d', '3d'],
  },
  {
    id: 'c4',
    bank: 'pharm',
    front: 'What do you check after starting an ACE inhibitor?',
    back: 'Potassium and kidney function (creatinine).',
    source: 'check potassium and kidney function',
    intervals: ['<1m', '6m', '3d', '8d'],
  },
  {
    id: 'c5',
    bank: 'neuro',
    front: 'Which lobe holds the primary visual cortex?',
    back: 'The occipital lobe.',
    intervals: ['<1m', '12m', '4d', '11d'],
  },
];

export type BadgeDef = {
  id: string;
  name: string;
  icon: LucideIcon;
  tone: Tone;
  how: string;
  earned?: string;
  progress?: [number, number];
};
export const BADGES: BadgeDef[] = [
  {
    id: 'first',
    name: 'First save',
    icon: Bookmark,
    tone: 'butter',
    how: 'Save your first highlight.',
    earned: '2 Aug',
  },
  {
    id: 'week',
    name: 'Week streak',
    icon: Flame,
    tone: 'peach',
    how: 'Study 7 days in a row.',
    earned: '9 Oct',
  },
  {
    id: 'maker',
    name: 'Card maker',
    icon: Layers,
    tone: 'lavender',
    how: 'Create 25 flashcards.',
    earned: '21 Sep',
  },
  {
    id: 'owl',
    name: 'Night study',
    icon: Moon,
    tone: 'sky',
    how: 'Finish a session after 10 pm.',
    earned: '3 Oct',
  },
  {
    id: 'banks',
    name: 'Bank builder',
    icon: FolderPlus,
    tone: 'mint',
    how: 'Create 5 banks.',
    earned: '14 Aug',
  },
  {
    id: 'early',
    name: 'Early bird',
    icon: Sunrise,
    tone: 'rose',
    how: 'Finish a session before 8 am.',
    earned: '28 Sep',
  },
  {
    id: 'month',
    name: 'Month streak',
    icon: Trophy,
    tone: 'butter',
    how: 'Study 30 days in a row.',
    progress: [12, 30],
  },
  {
    id: 'perfect',
    name: 'Perfect week',
    icon: Award,
    tone: 'mint',
    how: 'Meet your goal 7 days running.',
    progress: [5, 7],
  },
  {
    id: 'explorer',
    name: 'Explorer',
    icon: Compass,
    tone: 'lavender',
    how: 'Try 5 tools from More.',
    progress: [2, 5],
  },
];

export type MoreItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  status?: string;
};
export const MORE: MoreItem[] = [
  { id: 'rules', label: 'Rules', icon: WandSparkles, hint: 'Auto-file new saves', status: '3 on' },
  { id: 'syllabus', label: 'Syllabus', icon: ListTree, hint: 'Map topics to banks' },
  { id: 'graph', label: 'Graph', icon: Network, hint: 'See linked ideas' },
  { id: 'exam', label: 'Exam', icon: Timer, hint: 'Timed practice test' },
  { id: 'dupes', label: 'Duplicates', icon: Copy, hint: 'Merge repeated quotes', status: '2' },
  { id: 'imports', label: 'Imports', icon: FileDown, hint: 'Bring in highlights' },
  { id: 'ai', label: 'AI', icon: Sparkles, hint: 'Optional, off by default', status: 'Off' },
  { id: 'sync', label: 'Sync', icon: RefreshCw, hint: 'Optional, off by default', status: 'Off' },
  { id: 'trash', label: 'Trash', icon: Trash, hint: 'Restore deleted items', status: '4' },
  { id: 'storage', label: 'Storage', icon: HardDrive, hint: 'Space used on device' },
  { id: 'chat', label: 'Chat', icon: MessageCircle, hint: 'Ask your notes (AI)' },
  { id: 'fields', label: 'Fields', icon: SlidersHorizontal, hint: 'Custom fields' },
];

// ---- Streak heatmap: Monday-first weeks, from Mon 27 Jul to today (Wed 14 Oct 2026). ----
export type Day = { iso: string; label: string; xp: number; freeze?: boolean; today?: boolean };
const START = Date.UTC(2026, 6, 27);
const DAYS = 80;
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const noise = (i: number) => {
  const x = Math.sin(i * 91.7 + 13.3) * 43758.5453;
  return x - Math.floor(x);
};

export const HEAT: Day[] = Array.from({ length: DAYS }, (_, i) => {
  const d = new Date(START + i * 86_400_000);
  const r = noise(i);
  const inStreak = i >= DAYS - ME.streak;
  let xp = r < 0.28 ? 0 : Math.round(6 + r * 70);
  if (inStreak) xp = Math.max(xp, 12 + Math.round(r * 40));
  if (i === DAYS - ME.streak - 1) xp = 0; // the day the last streak ended
  if (i === DAYS - 1) xp = ME.todayXp;
  return {
    iso: d.toISOString().slice(0, 10),
    label: fmt.format(d),
    xp,
    freeze: i === 44,
    today: i === DAYS - 1,
  };
}).map((d) => (d.freeze ? { ...d, xp: 0 } : d));

export const WEEKS: Day[][] = Array.from({ length: Math.ceil(DAYS / 7) }, (_, w) =>
  HEAT.slice(w * 7, w * 7 + 7),
);
export const heatLevel = (xp: number) =>
  xp <= 0 ? 0 : xp < 10 ? 1 : xp < 30 ? 2 : xp < 50 ? 3 : 4;
