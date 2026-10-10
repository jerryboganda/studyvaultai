import { browser } from 'wxt/browser';
import { parseSettings, type Settings } from '@shared';

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  return parseSettings(stored[KEY]);
}

/**
 * Read-modify-write under a cross-context lock so the service worker (lastBankId) and the options
 * page (deny list) cannot overwrite each other. Content scripts must treat settings as read-only.
 */
export async function updateSettings(mutate: (current: Settings) => Settings): Promise<Settings> {
  const run = async () => {
    const next = parseSettings(mutate(await getSettings()));
    await browser.storage.local.set({ [KEY]: next });
    return next;
  };
  return navigator.locks ? navigator.locks.request('studyvault-settings', run) : run();
}

/** Subscribe to settings changes from any context. Returns an unsubscribe function. */
export function watchSettings(onChange: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && KEY in changes) onChange(parseSettings(changes[KEY]?.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
