/** Plain-language formatting for the backup screens. No React, no storage: unit-testable. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "2026-10-11 08:30" in the viewer's locale-independent, sortable form. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const TABLE_LABELS: Record<string, string> = {
  banks: 'Banks',
  sources: 'Sources (pages)',
  highlights: 'Highlights',
  highlightBanks: 'Highlights filed in banks',
  folders: 'Folders and topics',
  tags: 'Tags',
  highlightTags: 'Tags on highlights',
  filingRules: 'Auto-filing rules',
  syllabi: 'Syllabi',
  relations: 'Links between items',
  notes: 'Notes',
  knowledgePoints: 'Knowledge points',
  decks: 'Flashcard decks',
  cards: 'Flashcards',
  reviewLogs: 'Review history',
  aiResults: 'AI suggestions (unverified)',
  documents: 'PDF documents',
  attachments: 'Cached PDF files',
  ocrPages: 'OCR text',
};

export const tableLabel = (name: string): string => TABLE_LABELS[name] ?? name;

export interface Strength {
  /** 0 too short, 1 weak, 2 fair, 3 strong */
  level: 0 | 1 | 2 | 3;
  label: 'Too short' | 'Weak' | 'Fair' | 'Strong';
  hint: string;
}

/**
 * A rough entropy estimate (length x character classes, repeats discounted). It is a hint, not a
 * guarantee: the real defence is length, so the advice is always "use a longer phrase".
 */
export function passphraseStrength(value: string): Strength {
  const chars = [...value];
  if (chars.length < 8) {
    return {
      level: 0,
      label: 'Too short',
      hint: 'Use at least 8 characters. A phrase of four or more unrelated words is easy to remember and hard to guess.',
    };
  }
  let pool = 0;
  if (/[a-z]/.test(value)) pool += 26;
  if (/[A-Z]/.test(value)) pool += 26;
  if (/[0-9]/.test(value)) pool += 10;
  if (/[^A-Za-z0-9]/.test(value)) pool += 33;
  // repeated characters add little: count at most twice the number of distinct ones
  const effective = Math.min(chars.length, new Set(chars).size * 2);
  const bits = effective * Math.log2(Math.max(pool, 2));
  if (bits < 45) {
    return {
      level: 1,
      label: 'Weak',
      hint: 'Easy to guess with a computer. Add more words or characters.',
    };
  }
  if (bits < 70) {
    return {
      level: 2,
      label: 'Fair',
      hint: 'Reasonable. A longer phrase would be stronger.',
    };
  }
  return { level: 3, label: 'Strong', hint: 'Long enough that guessing it is impractical.' };
}

/** Sortable timestamp for file names. */
export function fileStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
}
