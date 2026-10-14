// Static sample data for the Night Arcade mockups. Mockups only: the product shows real counts.
import {
  Atom,
  BookOpen,
  Bookmark,
  Brain,
  Calculator,
  CalendarCheck,
  Code,
  Copy,
  Dna,
  Flame,
  FlaskConical,
  Globe,
  GraduationCap,
  HardDrive,
  Import,
  Landmark,
  Languages,
  Layers,
  Library,
  ListTree,
  MessageCircle,
  Music,
  Network,
  Palette,
  Pill,
  RefreshCw,
  Rocket,
  Scale,
  Sparkles,
  Stethoscope,
  Tags,
  Target,
  Trash2,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export type Theme = 'light' | 'dark' | 'system';

export type HlColor = 'lime' | 'pink' | 'cyan' | 'gold' | 'violet' | 'orange';

export const HL_COLORS: { id: HlColor; name: string }[] = [
  { id: 'gold', name: 'Gold' },
  { id: 'lime', name: 'Lime' },
  { id: 'pink', name: 'Pink' },
  { id: 'cyan', name: 'Cyan' },
  { id: 'violet', name: 'Violet' },
  { id: 'orange', name: 'Orange' },
];

export interface Bank {
  id: string;
  name: string;
  icon: LucideIcon;
  color: HlColor;
  items: number;
  due: number;
  /** Share of cards at "review" maturity, 0..1. */
  mastery: number;
}

export const BANKS: Bank[] = [
  { id: 'bio', name: 'Biology', icon: Dna, color: 'lime', items: 214, due: 9, mastery: 0.72 },
  {
    id: 'pharm',
    name: 'Pharmacology',
    icon: Pill,
    color: 'pink',
    items: 158,
    due: 11,
    mastery: 0.46,
  },
  { id: 'hist', name: 'History', icon: Landmark, color: 'cyan', items: 96, due: 3, mastery: 0.81 },
  {
    id: 'span',
    name: 'Spanish',
    icon: Languages,
    color: 'orange',
    items: 61,
    due: 1,
    mastery: 0.3,
  },
];

export interface Highlight {
  id: string;
  quote: string;
  color: HlColor;
  bank: string;
  tags: string[];
  note?: string;
  attention?: boolean;
}

export const PAGE_HIGHLIGHTS: Highlight[] = [
  {
    id: 'h1',
    quote:
      'Mitochondria make most of the cell’s ATP through oxidative phosphorylation along the inner membrane.',
    color: 'lime',
    bank: 'Biology',
    tags: ['cells', 'energy'],
    note: 'Exam topic 3',
  },
  {
    id: 'h2',
    quote:
      'The electron transport chain pumps protons, building the gradient that drives ATP synthase.',
    color: 'gold',
    bank: 'Biology',
    tags: ['energy'],
  },
  {
    id: 'h3',
    quote: 'Cyanide blocks complex IV, so cells cannot use oxygen even when it is present.',
    color: 'pink',
    bank: 'Pharmacology',
    tags: ['toxins'],
    attention: true,
  },
];

export interface Card {
  id: string;
  bank: string;
  front: string;
  back: string;
  source: string;
}

export const CARDS: Card[] = [
  {
    id: 'c1',
    bank: 'Biology',
    front: 'Where in the mitochondrion does the electron transport chain sit?',
    back: 'The inner membrane, folded into cristae.',
    source: 'Cell energy · example.org',
  },
  {
    id: 'c2',
    bank: 'Pharmacology',
    front: 'Which complex does cyanide block?',
    back: 'Complex IV (cytochrome c oxidase).',
    source: 'Toxins 101 · example.org',
  },
  {
    id: 'c3',
    bank: 'Biology',
    front: 'What drives ATP synthase to turn?',
    back: 'Protons flowing back down their gradient.',
    source: 'Cell energy · example.org',
  },
  {
    id: 'c4',
    bank: 'History',
    front: 'In which year did the printing press reach Venice?',
    back: '1469.',
    source: 'Early print · Imported PDF',
  },
  {
    id: 'c5',
    bank: 'Spanish',
    front: '“la biblioteca”',
    back: 'the library',
    source: 'Vocabulary · typed card',
  },
];

export const RATINGS = [
  { id: 'again', label: 'Again', key: '1', interval: '<1m' },
  { id: 'hard', label: 'Hard', key: '2', interval: '6m' },
  { id: 'good', label: 'Good', key: '3', interval: '1d' },
  { id: 'easy', label: 'Easy', key: '4', interval: '4d' },
] as const;

export type RatingId = (typeof RATINGS)[number]['id'];

export const PLAYER = {
  name: 'Sam',
  goal: 30,
  xpToday: 18,
  streak: 12,
  bestStreak: 21,
  freezes: 2,
  level: 7,
  levelXp: 340,
  levelNeed: 500,
  due: 24,
  dueNew: 8,
};

export interface Badge {
  id: string;
  name: string;
  how: string;
  icon: LucideIcon;
  tone: 'lime' | 'pink' | 'cyan' | 'gold';
  earned: boolean;
  /** Progress toward a locked badge, 0..1. */
  progress?: number;
}

export const BADGES: Badge[] = [
  {
    id: 'first',
    name: 'First save',
    how: 'Save your first highlight.',
    icon: Bookmark,
    tone: 'lime',
    earned: true,
  },
  {
    id: 'streak7',
    name: 'Week streak',
    how: 'Study 7 days in a row.',
    icon: Flame,
    tone: 'pink',
    earned: true,
  },
  {
    id: 'cards100',
    name: '100 reviews',
    how: 'Review 100 cards.',
    icon: Layers,
    tone: 'cyan',
    earned: true,
  },
  {
    id: 'builder',
    name: 'Bank builder',
    how: 'Create 3 banks.',
    icon: Library,
    tone: 'gold',
    earned: true,
  },
  {
    id: 'streak30',
    name: 'Month streak',
    how: 'Study 30 days in a row.',
    icon: CalendarCheck,
    tone: 'pink',
    earned: false,
    progress: 0.4,
  },
  {
    id: 'cards1000',
    name: '1,000 reviews',
    how: 'Review 1,000 cards.',
    icon: Rocket,
    tone: 'cyan',
    earned: false,
    progress: 0.62,
  },
  {
    id: 'perfect',
    name: 'Perfect week',
    how: 'Hit your goal 7 days running.',
    icon: Target,
    tone: 'lime',
    earned: false,
    progress: 0.71,
  },
  {
    id: 'exam',
    name: 'Exam ace',
    how: 'Score 90% in an exam.',
    icon: GraduationCap,
    tone: 'gold',
    earned: false,
    progress: 0,
  },
];

export interface MoreItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

export const MORE: MoreItem[] = [
  { id: 'rules', label: 'Rules', icon: Workflow },
  { id: 'syllabus', label: 'Syllabus', icon: ListTree },
  { id: 'graph', label: 'Graph', icon: Network },
  { id: 'exam', label: 'Exam', icon: GraduationCap },
  { id: 'dupes', label: 'Duplicates', icon: Copy },
  { id: 'imports', label: 'Imports', icon: Import },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'sync', label: 'Sync', icon: RefreshCw },
  { id: 'trash', label: 'Trash', icon: Trash2 },
  { id: 'storage', label: 'Storage', icon: HardDrive },
];

export const MORE_EXTRA: MoreItem[] = [
  { id: 'fields', label: 'Custom fields', icon: Tags },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
];

export const BANK_ICONS: { id: string; name: string; icon: LucideIcon }[] = [
  { id: 'book', name: 'Book', icon: BookOpen },
  { id: 'brain', name: 'Brain', icon: Brain },
  { id: 'dna', name: 'DNA', icon: Dna },
  { id: 'pill', name: 'Pill', icon: Pill },
  { id: 'steth', name: 'Stethoscope', icon: Stethoscope },
  { id: 'flask', name: 'Flask', icon: FlaskConical },
  { id: 'atom', name: 'Atom', icon: Atom },
  { id: 'calc', name: 'Maths', icon: Calculator },
  { id: 'globe', name: 'Globe', icon: Globe },
  { id: 'lang', name: 'Languages', icon: Languages },
  { id: 'law', name: 'Law', icon: Scale },
  { id: 'code', name: 'Code', icon: Code },
  { id: 'music', name: 'Music', icon: Music },
  { id: 'art', name: 'Art', icon: Palette },
  { id: 'history', name: 'History', icon: Landmark },
];

/** 12 weeks of daily XP, oldest first; deterministic so screenshots are stable. */
export const HEAT: number[] = Array.from({ length: 84 }, (_, i) => {
  const r = Math.sin(i * 12.9898) * 43758.5453;
  const f = r - Math.floor(r);
  if (i === 83) return 18; // today, matches PLAYER.xpToday
  if (i >= 72) return 20 + Math.round(f * 40); // the current 12-day streak
  if (f < 0.22) return 0;
  return Math.round(f * 70);
});
