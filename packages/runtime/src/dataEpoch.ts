import { browser } from 'wxt/browser';

/**
 * Cross-context change signal. IndexedDB cannot be observed from content scripts, so every
 * database mutation writes a fresh token to chrome.storage.local; listeners re-fetch what they show.
 * The token carries no data and is never used for correctness, only for liveness.
 *
 * It is a unique value rather than an incrementing counter: two contexts bumping at once would
 * otherwise write the same number, and storage.onChanged does not fire for an unchanged value.
 */
const KEY = 'dataEpoch';

export async function bumpDataEpoch(): Promise<void> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await browser.storage.local.set({ [KEY]: token });
}

export function watchDataEpoch(onChange: () => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && KEY in changes) onChange();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
