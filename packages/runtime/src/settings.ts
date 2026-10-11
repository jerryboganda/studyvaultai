import { browser } from 'wxt/browser';
import { parseSettings, type Settings } from '@shared';

const KEY = 'settings';

/**
 * `chrome.storage.local` is readable AND writable by content scripts, which run next to untrusted page
 * script. The copy kept there is therefore display data for the page-side code (painting, the popup
 * hint). Decisions that need a trustworthy value, in the service worker (deny list, private-window
 * capture, feature flags), read the authoritative copy instead: `getTrustedSettings`. It lives where
 * a content script cannot reach (the extension origin's IndexedDB, registered by @storage) and is
 * written only through `updateSettings`, which runs in extension pages and the worker.
 * See docs/adr/010-module-seams.md, amendment "Privileged configuration".
 */
export interface TrustedSettingsStore {
  /** The authoritative copy, or null before it was first written. */
  load(): Promise<Settings | null>;
  save(settings: Settings): Promise<void>;
}

let trusted: TrustedSettingsStore | null = null;

/**
 * Called by @storage when the context has IndexedDB. Contexts without a registered store (content
 * scripts, database-less test sandboxes) keep the single-copy behaviour.
 */
export function setTrustedSettingsStore(store: TrustedSettingsStore | null): void {
  trusted = store;
}

/** The copy in chrome.storage.local: display data. Not for security decisions in the worker. */
export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  return parseSettings(stored[KEY]);
}

/**
 * The authoritative settings. The first read after an upgrade adopts what chrome.storage.local holds
 * (the person's existing choices); from then on a write to chrome.storage.local by anything but
 * `updateSettings` is ignored here. A store that cannot be read rejects: callers fail closed.
 */
export async function getTrustedSettings(): Promise<Settings> {
  if (!trusted) return getSettings();
  const stored = await trusted.load();
  if (stored) return stored;
  return withSettingsLock(adoptStored); // the first read: seed under the lock, re-checking inside
}

/**
 * One writer at a time: Web Locks across contexts, and a queue inside this one (the authoritative
 * copy is read and written with real I/O between the two, and a context without Web Locks must not
 * interleave two read-modify-writes).
 */
let queue: Promise<unknown> = Promise.resolve();
const withSettingsLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(() =>
    navigator.locks ? navigator.locks.request('studyvault-settings', fn) : fn(),
  );
  queue = run.catch(() => undefined);
  return run;
};

/** The caller holds the settings lock (or tolerates the one-time race of the very first read). */
async function adoptStored(): Promise<Settings> {
  const stored = await trusted!.load();
  if (stored) return stored;
  const adopted = await getSettings();
  await trusted!.save(adopted);
  return adopted;
}

/**
 * Read-modify-write under a cross-context lock so the service worker (lastBankId) and the options
 * page (deny list) cannot overwrite each other. The base value is the authoritative copy, so a value
 * planted in chrome.storage.local is corrected by the next legitimate write instead of adopted.
 * Content scripts must treat settings as read-only.
 */
export async function updateSettings(mutate: (current: Settings) => Settings): Promise<Settings> {
  return withSettingsLock(async () => {
    const next = parseSettings(mutate(trusted ? await adoptStored() : await getSettings()));
    await trusted?.save(next);
    await browser.storage.local.set({ [KEY]: next });
    return next;
  });
}

/** Subscribe to settings changes from any context. Returns an unsubscribe function. */
export function watchSettings(onChange: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && KEY in changes) onChange(parseSettings(changes[KEY]?.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
