import { DENY_HOST, denyEntriesFor, isPlaceholderSourceUrl, parseHttpUrl } from '@shared';

/** Pure host / match-pattern helpers shared by the popup, side panel and options page. */

// One deny-list matcher for the worker, the content script and every page (trailing dots included).
export { denyEntriesFor };
// Sources without an address (a PDF opened from a file, imported highlights) carry a stand-in URL
// that never resolves: show `visibleSourceUrl(url)` (empty for it), never the URL itself.
export { isPlaceholderSourceUrl, visibleSourceUrl } from '@shared';

export const ALL_SITES_ORIGINS = ['https://*/*', 'http://*/*'] as const;
const ALL_SITES = new Set<string>([...ALL_SITES_ORIGINS, '*://*/*', '<all_urls>']);

export function isAllSitesPattern(pattern: string): boolean {
  return ALL_SITES.has(pattern);
}

/** "https://example.com/*" -> "example.com". Null when it is not an origin-wide pattern. */
export function patternHost(pattern: string): string | null {
  return /^(?:\*|https?):\/\/([^/]+)\/\*$/.exec(pattern)?.[1] ?? null;
}

export function hostOf(url: string | null | undefined): string | null {
  return url ? (parseHttpUrl(url)?.hostname ?? null) : null;
}

/** An href that is safe to render from stored data: http(s) only, never javascript:/data: or a placeholder. */
export function safeHref(url: string | null | undefined): string | undefined {
  return url && !isPlaceholderSourceUrl(url) ? parseHttpUrl(url)?.href : undefined;
}

/** Chrome opens PDFs in its built-in viewer, which extensions cannot annotate (Phase 3 adds a reader). */
export function isPdfUrl(url: string): boolean {
  const u = parseHttpUrl(url);
  return u !== null && /\.pdf$/i.test(u.pathname);
}

export type AddressClass =
  | { kind: 'ok'; url: string; host: string }
  /** Chrome did not share the tab address (browser pages, or no access has been granted yet). */
  | { kind: 'no-address' }
  | { kind: 'unsupported'; scheme: string }
  | { kind: 'pdf'; host: string }
  | { kind: 'denied'; host: string; entries: string[] };

export function classifyAddress(
  url: string | null | undefined,
  denyList: readonly string[],
): AddressClass {
  if (!url) return { kind: 'no-address' };
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    let scheme = 'this address';
    try {
      scheme = new URL(url).protocol;
    } catch {
      /* keep the generic wording */
    }
    return { kind: 'unsupported', scheme };
  }
  const host = parsed.hostname;
  const entries = denyEntriesFor(host, denyList);
  if (entries.length > 0) return { kind: 'denied', host, entries };
  if (isPdfUrl(url)) return { kind: 'pdf', host };
  return { kind: 'ok', url, host };
}

/** Turn what the user typed ("https://Example.com/path", "*.example.com") into a deny-list host. */
export function normalizeDenyInput(input: string): { host: string } | { error: string } {
  let text = input.trim().toLowerCase();
  if (text === '') return { error: 'Enter a site such as example.com.' };
  if (text.includes('://')) {
    const parsed = parseHttpUrl(text);
    if (!parsed) return { error: 'Enter a web address that starts with http:// or https://.' };
    text = parsed.hostname;
  }
  text = text.replace(/^\*\./, '').replace(/\.$/, '');
  if (text.includes('/') || text.includes(':') || text.includes('*') || /\s/.test(text)) {
    return { error: 'Enter only the site name, for example example.com. Subdomains are included.' };
  }
  if (text.length > 253 || !DENY_HOST.test(text)) {
    return { error: `"${text}" is not a valid site name.` };
  }
  return { host: text };
}
