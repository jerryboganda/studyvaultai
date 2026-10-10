/**
 * Pure URL identity and policy helpers. No Chrome APIs; safe in every context.
 * Source identity must be deterministic: the same page always yields the same key.
 */

const TRACKING_PARAMS =
  /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi)$/i;

export function parseHttpUrl(input: string): URL | null {
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Normalise for identity: lowercase scheme/host (URL does this), no default port, no tracking
 * params, sorted query, no trailing slash (except root). The fragment is dropped unless it is a
 * client-side route ("#/..." or "#!..."), which SPAs use as the page identity.
 */
export function normalizeUrl(input: string): string | null {
  const u = parseHttpUrl(input);
  if (!u) return null;
  u.username = '';
  u.password = '';
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (!/^#(\/|!)/.test(u.hash)) u.hash = '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

/**
 * A page-declared canonical URL is only trusted when it stays on the same host (ignoring a
 * leading "www."), so a hostile page cannot claim another site's identity.
 */
export function trustedCanonical(pageUrl: string, canonicalHref: string | null): string | null {
  if (!canonicalHref) return null;
  const page = parseHttpUrl(pageUrl);
  if (!page) return null;
  let canon: URL | null;
  try {
    canon = parseHttpUrl(new URL(canonicalHref, page).toString());
  } catch {
    canon = null;
  }
  if (!canon) return null;
  const strip = (h: string) => h.replace(/^www\./, '');
  if (strip(canon.hostname) !== strip(page.hostname)) return null;
  return normalizeUrl(canon.toString());
}

export function sourceKeys(pageUrl: string, canonicalHref: string | null) {
  const visitedKey = normalizeUrl(pageUrl);
  if (!visitedKey) return null;
  return { urlKey: trustedCanonical(pageUrl, canonicalHref) ?? visitedKey, visitedKey };
}

/** Match pattern granting access to exactly one origin, e.g. "https://example.com/*". */
export function originPattern(url: string): string | null {
  const u = parseHttpUrl(url);
  return u ? `${u.protocol}//${u.host}/*` : null;
}

/** Deny entries match the host itself and any subdomain. */
export function isHostDenied(host: string, denyList: readonly string[]): boolean {
  const h = host.toLowerCase();
  return denyList.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.length > 0 && (h === e || h.endsWith(`.${e}`));
  });
}

export type CaptureBlock = 'unsupported-scheme' | 'denied-site';

/** Why capture is not allowed on `url`, or null when it is. Scheme check first, then deny list. */
export function captureBlock(url: string, denyList: readonly string[]): CaptureBlock | null {
  const u = parseHttpUrl(url);
  if (!u) return 'unsupported-scheme';
  return isHostDenied(u.hostname, denyList) ? 'denied-site' : null;
}
