import { browser } from 'wxt/browser';
import { callBackground, updateSettings } from '@runtime';

/**
 * Site-access flows shared by the popup and the options page (ADR-003). Each one persists the
 * user's choice in settings and then asks the worker to re-register the persistent content script.
 * Call them straight from a click handler: `grantSiteAccess` makes `permissions.request` its
 * first await so Chrome still sees the user gesture.
 */

const MAX_LIST = 500; // Settings schema limit; exceeding it would make parseSettings drop the list.

function checkSize(list: readonly string[], what: string) {
  if (list.length > MAX_LIST) {
    throw new Error(`You have reached the limit of ${MAX_LIST} ${what}. Remove some first.`);
  }
}

/** Ask Chrome for host access; false when the user declined (nothing is changed then). */
export async function grantSiteAccess(patterns: readonly string[]): Promise<boolean> {
  const granted = await browser.permissions.request({ origins: [...patterns] });
  if (!granted) return false;
  await updateSettings((s) => {
    const persistentOrigins = [...new Set([...s.persistentOrigins, ...patterns])];
    checkSize(persistentOrigins, 'enabled sites');
    return { ...s, persistentOrigins };
  });
  await callBackground('site.sync', {});
  return true;
}

export async function revokeSiteAccess(patterns: readonly string[]): Promise<void> {
  // `remove` answers false when there was nothing to remove (already revoked); settings must
  // still converge, so the result is not an error.
  await browser.permissions.remove({ origins: [...patterns] });
  await updateSettings((s) => ({
    ...s,
    persistentOrigins: s.persistentOrigins.filter((p) => !patterns.includes(p)),
  }));
  await callBackground('site.sync', {});
}

export async function editDenyList(edit: (current: string[]) => string[]): Promise<void> {
  await updateSettings((s) => {
    const denyList = edit([...s.denyList]);
    checkSize(denyList, 'deny-list entries');
    return { ...s, denyList };
  });
  await callBackground('site.sync', {});
}
