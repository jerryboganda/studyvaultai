import { browser } from 'wxt/browser';

/**
 * Cross-context change signals. IndexedDB cannot be observed from content scripts, so every
 * database mutation writes a fresh token to chrome.storage.local; listeners re-fetch what they show.
 * A token carries no data and is never used for correctness, only for liveness.
 *
 * A token is a unique value rather than an incrementing counter: two contexts bumping at once would
 * otherwise write the same number, and storage.onChanged does not fire for an unchanged value.
 *
 * Two channels, so that a change only wakes the contexts it matters to:
 *  - dataEpoch: highlights, notes or banks were created, edited, deleted or restored. Everyone
 *    (content scripts, side panel, popup) re-fetches.
 *  - resolutionEpoch: only resolver outcomes (resolved / changed / orphaned ...) were persisted. The
 *    page that produced them already knows them, so content scripts must NOT watch this one; the
 *    side panel and popup watch both so their status badges stay current.
 */
const DATA_KEY = 'dataEpoch';
const RESOLUTION_KEY = 'resolutionEpoch';

async function bump(key: string): Promise<void> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await browser.storage.local.set({ [key]: token });
}

function watch(key: string, onChange: () => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && key in changes) onChange();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export const bumpDataEpoch = (): Promise<void> => bump(DATA_KEY);
export const watchDataEpoch = (onChange: () => void): (() => void) => watch(DATA_KEY, onChange);

export const bumpResolutionEpoch = (): Promise<void> => bump(RESOLUTION_KEY);
export const watchResolutionEpoch = (onChange: () => void): (() => void) =>
  watch(RESOLUTION_KEY, onChange);
