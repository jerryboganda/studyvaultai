import '@shared/zodConfig';
import { z } from 'zod';
import { browser } from 'wxt/browser';

/**
 * Progress of the welcome tour. It lives under its OWN chrome.storage.local key (like the study
 * settings), so the tour can change without touching the capture settings, and "delete all data"
 * (`storage.local.clear()`) resets it with everything else.
 *
 * Nothing in here is trusted to skip work: "applied" only describes what the last "Create" did, the
 * bank presets are re-checked against the real vault every time they run.
 */

export const ONBOARDING_KEY = 'onboarding';

/** Steps in order. The ids are stored, so do not rename them. */
export const ONBOARDING_STEPS = [
  'welcome',
  'privacy',
  'access',
  'banks',
  'look',
  'keys',
  'done',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const OnboardingState = z.object({
  schemaVersion: z.literal(1),
  /** pending: not finished (resume at `step`); skipped / completed: the tour is over. */
  status: z.enum(['pending', 'skipped', 'completed']),
  step: z.enum(ONBOARDING_STEPS),
  /** The bank preset picked on the banks step and the preview nodes the person switched off. */
  preset: z.object({
    id: z.string().min(1).max(40),
    excluded: z.array(z.string().min(1).max(300)).max(200),
  }),
  /** What the last "Create" did, so the last step can say it again. Null: nothing was created. */
  applied: z
    .object({
      presetId: z.string().min(1).max(40),
      bankName: z.string().min(1).max(200),
      createdBank: z.boolean(),
      createdFolders: z.number().int().min(0),
      existingFolders: z.number().int().min(0),
      at: z.string().max(40),
    })
    .nullable(),
  updatedAt: z.string().max(40),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

export function defaultOnboardingState(): OnboardingState {
  return {
    schemaVersion: 1,
    status: 'pending',
    step: 'welcome',
    preset: { id: 'blank', excluded: [] },
    applied: null,
    updatedAt: '',
  };
}

/** Field-wise parse: a bad or missing field falls back to its default instead of failing all. */
export function parseOnboardingState(raw: unknown): OnboardingState {
  const defaults = defaultOnboardingState();
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof OnboardingState>(key: K): OnboardingState[K] => {
    const parsed = OnboardingState.shape[key].safeParse(r[key]);
    return parsed.success ? (parsed.data as OnboardingState[K]) : defaults[key];
  };
  return {
    schemaVersion: 1,
    status: pick('status'),
    step: pick('step'),
    preset: pick('preset'),
    applied: pick('applied'),
    updatedAt: pick('updatedAt'),
  };
}

/** True when nothing was ever stored: the tour has not been shown yet. */
export async function hasOnboardingState(): Promise<boolean> {
  const stored = await browser.storage.local.get(ONBOARDING_KEY);
  return stored[ONBOARDING_KEY] !== undefined;
}

export async function getOnboardingState(): Promise<OnboardingState> {
  const stored = await browser.storage.local.get(ONBOARDING_KEY);
  return parseOnboardingState(stored[ONBOARDING_KEY]);
}

/** Read-modify-write under a cross-context lock (two tour tabs cannot overwrite each other). */
export async function updateOnboardingState(
  mutate: (current: OnboardingState) => OnboardingState,
): Promise<OnboardingState> {
  const run = async () => {
    const next = parseOnboardingState({
      ...mutate(await getOnboardingState()),
      updatedAt: new Date().toISOString(),
    });
    await browser.storage.local.set({ [ONBOARDING_KEY]: next });
    return next;
  };
  return navigator.locks ? navigator.locks.request('studyvault-onboarding', run) : run();
}

/** Subscribe to changes from any context. Returns the unsubscribe function. */
export function watchOnboardingState(onChange: (state: OnboardingState) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && ONBOARDING_KEY in changes) {
      onChange(parseOnboardingState(changes[ONBOARDING_KEY]?.newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
