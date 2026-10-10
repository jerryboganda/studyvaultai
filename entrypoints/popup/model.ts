import type { SiteStatus } from '@shared';
import { classifyAddress, isAllSitesPattern } from '@ui/hosts';

/**
 * Popup view model: what the active tab's address and the worker's `site.status` answer mean for
 * the user. Pure so every branch is testable without Chrome.
 */

export type PopupState =
  /** `site.status` has not answered yet. */
  | { kind: 'loading' }
  /** Chrome did not share an address (browser page, or no access to this tab yet), or it is not http(s). */
  | { kind: 'unsupported'; reason: 'no-address' | 'scheme' | 'pdf'; scheme: string | null }
  | { kind: 'denied'; host: string; entries: string[] }
  | { kind: 'inactive'; host: string; pattern: string; allSites: boolean }
  /** StudyVault is running in this tab. `persistent`: the site is enabled for every visit. */
  | { kind: 'active'; host: string; pattern: string; persistent: boolean; allSites: boolean };

export function derivePopupState(input: {
  url: string | undefined;
  status: SiteStatus | null;
  denyList: readonly string[];
  persistentOrigins: readonly string[];
}): PopupState {
  const { url, status, denyList, persistentOrigins } = input;
  const address = classifyAddress(url, denyList);
  if (address.kind === 'no-address') {
    return { kind: 'unsupported', reason: 'no-address', scheme: null };
  }
  if (address.kind === 'unsupported') {
    return { kind: 'unsupported', reason: 'scheme', scheme: address.scheme };
  }
  if (status === null) return { kind: 'loading' };
  if (!status.supported) return { kind: 'unsupported', reason: 'scheme', scheme: null };
  if (address.kind === 'pdf') return { kind: 'unsupported', reason: 'pdf', scheme: null };

  // The worker's verdict wins: it is what injection will enforce.
  const host = address.host;
  if (status.denied) {
    return { kind: 'denied', host, entries: address.kind === 'denied' ? address.entries : [] };
  }
  const pattern = status.pattern ?? '';
  const allSites = persistentOrigins.some(isAllSitesPattern);
  if (status.active) {
    return { kind: 'active', host, pattern, persistent: status.access === 'persistent', allSites };
  }
  return { kind: 'inactive', host, pattern, allSites };
}
