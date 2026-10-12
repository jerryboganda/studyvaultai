/**
 * The per-viewer display preferences StudyVault keeps in `localStorage` of the extension origin
 * (shared by every extension page). None holds study data. They live here, in one list, so that
 * "Delete all data" can remove them: `localPrefs.test.ts` fails when a source file writes a key with
 * the `sv.` prefix that is not named below.
 */
export const LOCAL_PREF_PREFIX = 'sv.';

export const LOCAL_PREF_KEYS = {
  dashboardCollapsed: 'sv.dashboard.collapsed',
  dashboardContrast: 'sv.dashboard.contrast',
  dashboardSingleKeys: 'sv.dashboard.singleKeys',
  reviewKeys: 'sv.review.keys',
  /** 'on': a toast stays until it is dismissed (WCAG 2.2.1). Settings > Appearance. */
  toastsKeep: 'sv.toasts.keep',
} as const;

/**
 * Remove every listed key, and any other key under the prefix (a key from an older build). Throws
 * when storage is blocked: the caller decides whether that matters.
 */
export function clearLocalPrefs(storage: Storage = window.localStorage): string[] {
  const keys = new Set<string>(Object.values(LOCAL_PREF_KEYS));
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(LOCAL_PREF_PREFIX)) keys.add(key);
  }
  const removed = [...keys].filter((key) => storage.getItem(key) !== null);
  for (const key of keys) storage.removeItem(key);
  return removed;
}
