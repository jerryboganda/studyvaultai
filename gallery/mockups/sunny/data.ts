// Static sample data for the Sunny Vault mockups (no backend). Numbers are illustrative only.

export type HlColour = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

export const HL_COLOURS: { id: HlColour; name: string }[] = [
  { id: 'yellow', name: 'Yellow' },
  { id: 'green', name: 'Green' },
  { id: 'blue', name: 'Blue' },
  { id: 'pink', name: 'Pink' },
  { id: 'purple', name: 'Purple' },
];

export type Bank = {
  id: string;
  name: string;
  emoji: string;
  colour: string; // swatch token name
  highlights: number;
  cards: number;
  mastered: number; // 0..100
  due: number;
};

export const BANKS: Bank[] = [
  {
    id: 'cardio',
    name: 'Cardiology',
    emoji: '🫀',
    colour: 'pink',
    highlights: 128,
    cards: 64,
    mastered: 72,
    due: 6,
  },
  {
    id: 'neuro',
    name: 'Neuro',
    emoji: '🧠',
    colour: 'violet',
    highlights: 94,
    cards: 41,
    mastered: 48,
    due: 5,
  },
  {
    id: 'pharm',
    name: 'Pharmacology',
    emoji: '💊',
    colour: 'sun',
    highlights: 210,
    cards: 120,
    mastered: 35,
    due: 3,
  },
  {
    id: 'rad',
    name: 'Radiology',
    emoji: '🩻',
    colour: 'blue',
    highlights: 57,
    cards: 22,
    mastered: 81,
    due: 0,
  },
  {
    id: 'inbox',
    name: 'Inbox',
    emoji: '📥',
    colour: 'green',
    highlights: 12,
    cards: 0,
    mastered: 0,
    due: 0,
  },
];

export type Highlight = {
  id: string;
  colour: HlColour;
  quote: string;
  bank: string;
  tags: string[];
  note?: string;
  attention?: boolean;
};

export const PAGE = { host: 'anatomy.example.org', title: 'The heart · Open Anatomy' };

export const HIGHLIGHTS: Highlight[] = [
  {
    id: 'h1',
    colour: 'yellow',
    quote:
      'The sinoatrial node, found in the right atrium, produces the electrical signal that starts each heartbeat.',
    bank: 'cardio',
    tags: ['conduction', 'exam'],
    note: 'Pacemaker of the heart',
  },
  {
    id: 'h2',
    colour: 'green',
    quote: 'Blood flows from the left atrium to the left ventricle through the mitral valve.',
    bank: 'cardio',
    tags: ['valves'],
  },
  {
    id: 'h3',
    colour: 'blue',
    quote:
      'A normal resting heart rate for adults ranges from 60 to 100 beats per minute, varying with fitness and age.',
    bank: 'cardio',
    tags: ['vitals'],
  },
  {
    id: 'h4',
    colour: 'pink',
    quote: 'Coronary arteries supply the heart muscle itself with oxygen-rich blood.',
    bank: 'inbox',
    tags: [],
    attention: true,
  },
];

export type Flashcard = { id: string; deck: string; front: string; back: string; kind: string };

export const CARDS: Flashcard[] = [
  {
    id: 'c1',
    deck: 'cardio',
    kind: 'Q&A',
    front: 'Which valve sits between the left atrium and the left ventricle?',
    back: 'The mitral valve',
  },
  {
    id: 'c2',
    deck: 'cardio',
    kind: 'Fill in',
    front: 'The ______ node is the heart’s natural pacemaker.',
    back: 'Sinoatrial (SA)',
  },
  {
    id: 'c3',
    deck: 'cardio',
    kind: 'Q&A',
    front: 'Normal resting heart rate for adults?',
    back: '60 to 100 beats per minute',
  },
  {
    id: 'c4',
    deck: 'neuro',
    kind: 'Term',
    front: 'Spaced repetition',
    back: 'Reviewing at growing intervals so memories last longer',
  },
];

export const RATINGS = [
  { id: 'again', label: 'Again', key: '1', interval: '<1m', variant: 'danger' },
  { id: 'hard', label: 'Hard', key: '2', interval: '6m', variant: 'warning' },
  { id: 'good', label: 'Good', key: '3', interval: '1d', variant: 'success' },
  { id: 'easy', label: 'Easy', key: '4', interval: '4d', variant: 'violet' },
] as const;

export const GAME = {
  name: 'Sam',
  todayXp: 18,
  goalXp: 30,
  streak: 12,
  freezes: 2,
  level: 7,
  levelXp: 340,
  levelNeed: 500,
  due: 14,
  dueMix: { fresh: 5, learning: 3, review: 6 },
};

/** 12 weeks x 7 days of XP, oldest first. Deterministic sample. */
export const HEATMAP: number[] = Array.from({ length: 84 }, (_, i) => {
  if (i >= 72) return [24, 31, 30, 42, 35, 38, 18][i - 77] ?? 28; // last 12 days: streak
  const v = (i * 53 + 17) % 61;
  return v < 14 ? 0 : v;
});

export type BadgeDef = {
  id: string;
  name: string;
  hint: string;
  tone: 'sun' | 'primary' | 'success' | 'danger' | 'violet' | 'warning';
  earned: boolean;
  progress?: [number, number];
};

export const BADGES: BadgeDef[] = [
  { id: 'first', name: 'First save', hint: 'Save your first highlight', tone: 'sun', earned: true },
  { id: 'week', name: 'Week streak', hint: 'Study 7 days in a row', tone: 'danger', earned: true },
  { id: 'builder', name: 'Bank builder', hint: 'Create 3 banks', tone: 'primary', earned: true },
  { id: 'owl', name: 'Night owl', hint: 'Review after 10 pm', tone: 'violet', earned: true },
  {
    id: 'hundred',
    name: '100 cards',
    hint: 'Review 100 cards',
    tone: 'success',
    earned: false,
    progress: [64, 100],
  },
  {
    id: 'month',
    name: 'Month streak',
    hint: 'Study 30 days in a row',
    tone: 'warning',
    earned: false,
    progress: [12, 30],
  },
  {
    id: 'perfect',
    name: 'Perfect day',
    hint: 'Hit your goal with no Again',
    tone: 'sun',
    earned: false,
    progress: [0, 1],
  },
  {
    id: 'scholar',
    name: 'Scholar',
    hint: 'Reach level 10',
    tone: 'primary',
    earned: false,
    progress: [7, 10],
  },
];
