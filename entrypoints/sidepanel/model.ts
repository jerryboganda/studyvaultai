import {
  MAX_BANK_NAME_CHARS,
  MAX_NOTE_BODY_CHARS,
  MAX_TAG_NAME_CHARS,
  isPlaceholderSourceUrl,
  type PageStatus,
} from '@shared';
import { pdfReaderPath } from '@pdf/readerUrl';
import type { HighlightListItem } from '@storage';
import { classifyAddress, hostOf, safeHref, type AddressClass } from '@ui/hosts';
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

/** What is wrong with a bank name the user typed, or null when it can be created. */
export function validateBankName(input: string): string | null {
  const name = input.trim();
  if (name === '') return 'Enter a name for the bank.';
  if (name.length > MAX_BANK_NAME_CHARS) {
    return `Use ${MAX_BANK_NAME_CHARS} characters or fewer (this is ${name.length}).`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Tabs and the bank filter
// ---------------------------------------------------------------------------------------------

export const VIEWS = ['page', 'recent', 'search', 'banks', 'review'] as const;
export type View = (typeof VIEWS)[number];

/** `#search` -> 'search'. Anything else (including the empty hash) is not a view. */
export function viewFromHash(hash: string): View | null {
  const id = hash.replace(/^#/, '');
  return (VIEWS as readonly string[]).includes(id) ? (id as View) : null;
}

/** A bank (and optionally one folder of it) that Recent and Search are narrowed to. */
export interface BankScope {
  bankId: string;
  bankName: string;
  folderId: string | null;
  folderName: string | null;
}

export const scopeLabel = (scope: BankScope): string =>
  scope.folderName ? `${scope.bankName} › ${scope.folderName}` : scope.bankName;

// ---------------------------------------------------------------------------------------------
// Source links
// ---------------------------------------------------------------------------------------------

export type SourceLink =
  | { kind: 'web'; href: string }
  /** Extension-relative path of the StudyVault PDF reader, at the highlight's page. */
  | { kind: 'pdf'; path: string; label: string }
  | { kind: 'none' };

export function sourceLinkFor(item: HighlightListItem): SourceLink {
  const { highlight, source } = item;
  if (source.type === 'pdf') {
    if (!source.documentId) return { kind: 'none' };
    const page = highlight.anchorSet.type === 'pdf' ? highlight.anchorSet.pageNumber : null;
    return {
      kind: 'pdf',
      path: pdfReaderPath({ doc: source.documentId, page, highlight: highlight.id }),
      label: page ? `Open in the PDF reader, page ${page}` : 'Open in the PDF reader',
    };
  }
  if (isPlaceholderSourceUrl(source.originalUrl)) return { kind: 'none' };
  const href = safeHref(source.originalUrl);
  return href ? { kind: 'web', href } : { kind: 'none' };
}

// ---------------------------------------------------------------------------------------------
// Tags and notes typed in the panel
// ---------------------------------------------------------------------------------------------

/** The tag name to create or attach, or what is wrong with what was typed. */
export function parseTagInput(input: string): { name: string } | { error: string } {
  const name = input.replace(/\s+/g, ' ').trim();
  if (name === '') return { error: 'Enter a tag name.' };
  if (name.length > MAX_TAG_NAME_CHARS) {
    return { error: `Use ${MAX_TAG_NAME_CHARS} characters or fewer (this is ${name.length}).` };
  }
  return { name };
}

/** What is wrong with a note body the person typed, or null when it can be saved. */
export function validateNoteBody(input: string): string | null {
  if (input.trim() === '') return 'Write something, or cancel.';
  if (input.length > MAX_NOTE_BODY_CHARS) {
    return `Use ${MAX_NOTE_BODY_CHARS.toLocaleString()} characters or fewer (this is ${input.length.toLocaleString()}).`;
  }
  return null;
}
