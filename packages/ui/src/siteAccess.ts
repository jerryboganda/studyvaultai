import { browser } from 'wxt/browser';
import { isRegistrablePattern } from '@shared';
import { callBackground, updateSettings } from '@runtime';
import { patternHost } from './hosts';

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

export interface GrantResult {
  /** False when the user declined in Chrome's prompt; nothing was changed then. */
  granted: boolean;
  /**
   * Requested patterns the worker did not register after the sync. Chrome granted the access, but
   * the content script will not start by itself there: the UI must say so.
   */
  notRegistered: string[];
}

/** Ask Chrome for host access, remember it, and report which patterns really became always-on. */
export async function grantSiteAccess(patterns: readonly string[]): Promise<GrantResult> {
  // Checked before the prompt (synchronously, so the user gesture survives): a pattern the worker
  // cannot register would be stored and then silently dropped by every sync.
  const unusable = patterns.filter((p) => !isRegistrablePattern(p));
  if (unusable.length > 0) {
    const names = unusable.map((p) => patternHost(p) ?? p).join(', ');
    throw new Error(
      `StudyVault cannot keep itself switched on for ${names}: Chrome would accept the permission, but this address cannot be registered as an always-on site. Use "Activate on this tab" there instead.`,
    );
  }
  const granted = await browser.permissions.request({ origins: [...patterns] });
  if (!granted) return { granted: false, notRegistered: [] };
  await updateSettings((s) => {
    const persistentOrigins = [...new Set([...s.persistentOrigins, ...patterns])];
    checkSize(persistentOrigins, 'enabled sites');
    return { ...s, persistentOrigins };
  });
  const { registeredMatches } = await callBackground('site.sync', {});
  return { granted: true, notRegistered: patterns.filter((p) => !registeredMatches.includes(p)) };
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
