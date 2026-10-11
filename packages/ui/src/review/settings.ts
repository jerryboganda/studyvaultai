import '@shared/zodConfig';
import { z } from 'zod';
import { browser } from 'wxt/browser';
import { DEFAULT_ROLLOVER_HOUR, isValidTimeZone, type DayBoundary } from '@study';
import type { QueuePrefs } from '@storage';

/**
 * Study settings: how the study day is cut and how the queue is ordered. They live under their OWN
 * chrome.storage.local key, separate from the shared Settings object, so the review feature can
 * change without touching (or being broken by) the capture settings.
 *
 * Per-deck scheduling rules (target retention, daily caps, steps ...) are NOT here: they belong to
 * the deck and are stored with it (see DeckSettingsForm).
 */

export const STUDY_SETTINGS_KEY = 'studySettings';

export const StudySettings = z.object({
  schemaVersion: z.literal(1),
  /** IANA zone the study day is measured in. */
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, 'Not a time zone name Chrome knows (use e.g. Europe/Berlin)'),
  /** Local hour (0-23) at which a new study day starts. */
  rolloverHour: z.number().int().min(0).max(23),
  /** Spread decks proportionally ('deck'), by bank, or take them as they come. */
  interleave: z.enum(['deck', 'bank', 'none']),
  /** Review order: most forgotten first, or oldest due first. */
  order: z.enum(['retrievability', 'due']),
  /** New cards: oldest first, or shuffled. */
  newOrder: z.enum(['created', 'random']),
  /** A learning step due within this many minutes is shown early rather than waited for. */
  learnAheadMinutes: z.number().int().min(0).max(120),
});
export type StudySettings = z.infer<typeof StudySettings>;

/** The device's IANA zone, or UTC when the platform will not say. */
export function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultStudySettings(): StudySettings {
  return {
    schemaVersion: 1,
    timeZone: deviceTimeZone(),
    rolloverHour: DEFAULT_ROLLOVER_HOUR,
    interleave: 'deck',
    order: 'retrievability',
    newOrder: 'created',
    learnAheadMinutes: 20,
  };
}

/** Field-wise parse: one bad or missing field falls back to its default instead of failing all. */
export function parseStudySettings(raw: unknown): StudySettings {
  const defaults = defaultStudySettings();
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof StudySettings>(key: K): StudySettings[K] => {
    const parsed = StudySettings.shape[key].safeParse(r[key]);
    return parsed.success ? (parsed.data as StudySettings[K]) : defaults[key];
  };
  return {
    schemaVersion: 1,
    timeZone: pick('timeZone'),
    rolloverHour: pick('rolloverHour'),
    interleave: pick('interleave'),
    order: pick('order'),
    newOrder: pick('newOrder'),
    learnAheadMinutes: pick('learnAheadMinutes'),
  };
}

export async function getStudySettings(): Promise<StudySettings> {
  const stored = await browser.storage.local.get(STUDY_SETTINGS_KEY);
  return parseStudySettings(stored[STUDY_SETTINGS_KEY]);
}

/**
 * Read-modify-write under a cross-context lock. The result is validated: an invalid change is
 * refused with a readable message and nothing is written.
 */
export async function updateStudySettings(
  mutate: (current: StudySettings) => StudySettings,
): Promise<StudySettings> {
  const run = async () => {
    const candidate = mutate(await getStudySettings());
    const checked = StudySettings.safeParse(candidate);
    if (!checked.success) {
      throw new Error(checked.error.issues.map((i) => i.message).join('; '));
    }
    await browser.storage.local.set({ [STUDY_SETTINGS_KEY]: checked.data });
    return checked.data;
  };
  return navigator.locks ? navigator.locks.request('studyvault-study-settings', run) : run();
}

/** Subscribe to changes from any context. Returns the unsubscribe function. */
export function watchStudySettings(onChange: (settings: StudySettings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && STUDY_SETTINGS_KEY in changes) {
      onChange(parseStudySettings(changes[STUDY_SETTINGS_KEY]?.newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export const toBoundary = (s: StudySettings): DayBoundary => ({
  timeZone: s.timeZone,
  rolloverHour: s.rolloverHour,
});

export const toQueuePrefs = (s: StudySettings): QueuePrefs => ({
  interleave: s.interleave,
  order: s.order,
  newOrder: s.newOrder,
  learnAheadMs: s.learnAheadMinutes * 60_000,
});

/** What the repo needs from the settings: boundary plus queue preferences. */
export const toClock = (s: StudySettings) => ({ boundary: toBoundary(s), ...toQueuePrefs(s) });
