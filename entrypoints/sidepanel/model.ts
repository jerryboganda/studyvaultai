import type { PageStatus } from '@shared';
import type { HighlightListItem } from '@storage';
import { classifyAddress, hostOf, type AddressClass } from '@ui/hosts';
import { describeResolveState } from '@ui/resolveState';

/** Side panel view model. Pure: everything the panel decides is testable without Chrome. */

export interface PageIdentity {
  url: string;
  canonicalUrl: string | null;
  title: string;
  host: string;
}

export type PageState =
  | { kind: 'loading' }
  | { kind: 'no-tab' }
  /** The content script answered: StudyVault is running in the tab. */
  | { kind: 'live'; identity: PageIdentity; status: PageStatus }
  /** Not running here (yet). `identity` is known when Chrome shared the tab address. */
  | { kind: 'inactive'; identity: PageIdentity | null }
  /** Chrome blocks extensions on this page, or the site is on the deny list. */
  | {
      kind: 'unavailable';
      address: Exclude<AddressClass, { kind: 'ok' } | { kind: 'no-address' }>;
    };

export function derivePageState(input: {
  tabLoaded: boolean;
  tab: { url: string | undefined; title: string | undefined } | null;
  /** Successful `content.pageStatus` for this tab, if any. */
  status: PageStatus | null;
  /** `content.pageStatus` has finished (successfully or not) for this tab. */
  statusSettled: boolean;
  denyList: readonly string[];
}): PageState {
  const { tabLoaded, tab, status, statusSettled, denyList } = input;
  if (!tabLoaded) return { kind: 'loading' };
  if (!tab) return { kind: 'no-tab' };
  if (status) {
    return {
      kind: 'live',
      status,
      identity: {
        url: status.url,
        canonicalUrl: status.canonicalUrl,
        title: status.title,
        host: hostOf(status.url) ?? '',
      },
    };
  }
  if (!statusSettled) return { kind: 'loading' };
  const address = classifyAddress(tab.url, denyList);
  switch (address.kind) {
    case 'ok':
      return {
        kind: 'inactive',
        identity: {
          url: address.url,
          canonicalUrl: null,
          title: tab.title ?? '',
          host: address.host,
        },
      };
    case 'no-address':
      return { kind: 'inactive', identity: null };
    default:
      return { kind: 'unavailable', address };
  }
}

const startOf = (item: HighlightListItem): number =>
  item.highlight.anchorSet.type === 'html' ? item.highlight.anchorSet.textPosition.start : 0;

/** Reading order within a group; ambiguous/orphaned items (not painted) come first. */
export function groupPageItems(items: readonly HighlightListItem[]): {
  attention: HighlightListItem[];
  rest: HighlightListItem[];
} {
  const sorted = [...items].sort(
    (a, b) =>
      startOf(a) - startOf(b) || a.highlight.capturedAt.localeCompare(b.highlight.capturedAt),
  );
  const needs = (i: HighlightListItem) => describeResolveState(i.highlight.resolveStatus).attention;
  return { attention: sorted.filter(needs), rest: sorted.filter((i) => !needs(i)) };
}

export type RevealAvailability = { enabled: true } | { enabled: false; reason: string };

export function revealAvailability(opts: {
  /** StudyVault is running in the active tab. */
  live: boolean;
  /** The highlight belongs to the page shown in the active tab. */
  onActivePage: boolean;
}): RevealAvailability {
  if (!opts.live) {
    return {
      enabled: false,
      reason: 'StudyVault is not running in the current tab, so it cannot show this on the page.',
    };
  }
  if (!opts.onActivePage) {
    return {
      enabled: false,
      reason: 'This highlight is from another page. Open that page to see it there.',
    };
  }
  return { enabled: true };
}

export const REVEAL_NOT_FOUND =
  'StudyVault could not find this highlight on the page right now. The page text may have changed or has not finished loading; your saved quote is unchanged.';
