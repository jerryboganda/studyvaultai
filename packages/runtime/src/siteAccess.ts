import { browser } from 'wxt/browser';

/**
 * Revoke every optional host permission this extension holds (the user's "Delete all data").
 * Returns the origins that were removed. Chrome then raises permissions.onRemoved, which makes the
 * service worker unregister the persistent content script.
 */
export async function revokeAllSiteAccess(): Promise<string[]> {
  if (!browser.permissions?.getAll) return [];
  const { origins = [] } = await browser.permissions.getAll();
  if (origins.length === 0) return [];
  await browser.permissions.remove({ origins });
  return origins;
}
