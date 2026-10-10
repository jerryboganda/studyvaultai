import { MAX_TITLE_CHARS, MAX_URL_CHARS, parseHttpUrl, type PageInfo } from '@shared';

/**
 * Page identity as sent to the service worker. Everything here is page-controlled input: it is
 * only shaped to fit the protocol limits, never trusted (the worker re-validates the origin).
 */

/**
 * `href` shortened until it fits the protocol limit: first the fragment goes, then the query.
 * Returns null for non-http(s) addresses and for ones that still do not fit.
 */
export function fitUrl(href: string): string | null {
  const url = parseHttpUrl(href);
  if (!url) return null;
  if (url.href.length <= MAX_URL_CHARS) return url.href;
  url.hash = '';
  if (url.href.length <= MAX_URL_CHARS) return url.href;
  url.search = '';
  return url.href.length <= MAX_URL_CHARS ? url.href : null;
}

/** First valid `<link rel="canonical">`, resolved against the document base. Null when absent or unusable. */
export function canonicalHref(doc: Document): string | null {
  for (const link of Array.from(doc.getElementsByTagName('link'))) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical')) continue;
    const raw = link.getAttribute('href')?.trim();
    if (!raw) continue;
    try {
      const resolved = fitUrl(new URL(raw, doc.baseURI).href);
      if (resolved) return resolved;
    } catch {
      // malformed href: try the next link
    }
  }
  return null;
}

function clipTitle(title: string): string {
  if (title.length <= MAX_TITLE_CHARS) return title;
  const last = title.charCodeAt(MAX_TITLE_CHARS - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return title.slice(0, splitsPair ? MAX_TITLE_CHARS - 1 : MAX_TITLE_CHARS);
}

/** The page a highlight is saved against; null when the address cannot be stored. */
export function readPageInfo(doc: Document, href: string): PageInfo | null {
  const url = fitUrl(href);
  if (!url) return null;
  const title = clipTitle(doc.title.trim()) || new URL(url).hostname;
  return { url, canonicalUrl: canonicalHref(doc), title };
}
