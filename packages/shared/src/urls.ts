/**
 * Pure URL identity and policy helpers. No Chrome APIs; safe in every context.
 * Source identity must be deterministic: the same page always yields the same key.
 */

const TRACKING_PARAMS =
  /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi)$/i;

/**
 * Long stems that never occur in an innocent word, matched in the name with its separators removed
 * ("access-token", "accessToken" and "ACCESS_TOKEN" all become "accesstoken").
 */
const CREDENTIAL_STEM =
  /token|secret|passw|passphrase|passcode|passkey|credential|bearer|session|sessid|csrf|xsrf|signature|authori[sz]ation|verifier|jwt|apikey|hmac|key(?:id)?$/;
/** Short ones would also hit "author", "keyword", "design" or "assess": they must be a whole word. */
const CREDENTIAL_WORD = /^(?:keys?|sigs?|sids?|sess|auth|oauth|otp|pwd|pw|pass|tickets?)$/;

/**
 * Whether a parameter name carries a credential or a one-time grant (presigned-URL signatures, OAuth
 * codes and tokens, session ids, API keys). Such parameters are never persisted and never part of a
 * source key: a rotating token would fork one page into many sources and copy a live secret into the
 * database, backups, sync and the side panel. The name is judged case-insensitively as words
 * (camelCase and any separator split them) and as one compact string; `code` counts as the last
 * word only ("code", "auth_code", not "encode" or "codes"), and `x-amz-*` / `x-goog-*` as a family.
 * Deliberately broad: `code`, `key` and `session` are sometimes page identity, and then two pages
 * that differ only in that parameter share a source (the text anchors still tell them apart).
 * Total: any string is a valid input.
 */
function isCredentialName(name: string): boolean {
  const words =
    name
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z]+|\d+/g) ?? [];
  return (
    CREDENTIAL_STEM.test(words.join('')) ||
    words.some((w) => CREDENTIAL_WORD.test(w)) ||
    words.at(-1) === 'code' ||
    (words[0] === 'x' && (words[1] === 'amz' || words[1] === 'goog'))
  );
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Removes `;name=value` path parameters (Java's ";jsessionid=...") whose name is a credential. */
function dropPathCredentials(u: URL): void {
  const pathname = u.pathname.replace(/;([^/;=]*)=[^/;]*/g, (m, name: string) =>
    isCredentialName(safeDecode(name)) ? '' : m,
  );
  if (pathname !== u.pathname) u.pathname = pathname;
}

export function parseHttpUrl(input: string): URL | null {
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * The part of a fragment that is page identity: a client-side route ("#/a/b?x=1", "#!/a") with its
 * credential parameters removed. Any other fragment ("#section", "#access_token=...") is dropped.
 */
function routeFragment(input: string): string {
  if (!/^#(\/|!)/.test(input)) return '';
  // A second "#" starts nothing a router can use ("#/cb#access_token=..." is a credential blob).
  const end = input.indexOf('#', 1);
  const hash = end < 0 ? input : input.slice(0, end);
  const q = hash.indexOf('?');
  const path = q < 0 ? hash : hash.slice(0, q);
  // "#/access_token=...&token_type=bearer" is a credential blob in route clothing, not a route.
  const blob = path.split(/[/!&;]/).some((segment) => {
    const eq = segment.indexOf('=');
    return eq > 0 && isCredentialName(safeDecode(segment.slice(0, eq)));
  });
  if (blob) return '';
  if (q < 0) return hash;
  const params = new URLSearchParams(hash.slice(q + 1));
  const secret = [...params.keys()].filter(isCredentialName);
  if (secret.length === 0) return hash;
  for (const name of secret) params.delete(name);
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

/**
 * `input` without what must not be stored: userinfo, credential query parameters, and any fragment
 * that is not a route. Everything else (parameter order, tracking parameters) is kept as visited, so
 * the result is still a faithful, openable address. Null when `input` is not an http(s) URL.
 */
export function redactUrl(input: string): string | null {
  const u = parseHttpUrl(input);
  if (!u) return null;
  u.username = '';
  u.password = '';
  const all = [...u.searchParams.entries()];
  const kept = all.filter(([k]) => !isCredentialName(k));
  if (kept.length !== all.length) {
    u.search = '';
    for (const [k, v] of kept) u.searchParams.append(k, v);
  }
  dropPathCredentials(u);
  u.hash = routeFragment(u.hash);
  return u.toString();
}

/**
 * Normalise for identity: lowercase scheme/host (URL does this), no default port, no tracking or
 * credential params, sorted query, no trailing slash (except root). The fragment is dropped unless it
 * is a client-side route ("#/..." or "#!..."), which SPAs use as the page identity.
 */
export function normalizeUrl(input: string): string | null {
  const u = parseHttpUrl(input);
  if (!u) return null;
  u.username = '';
  u.password = '';
  const kept = [...u.searchParams.entries()].filter(
    ([k]) => !TRACKING_PARAMS.test(k) && !isCredentialName(k),
  );
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  dropPathCredentials(u);
  u.hash = routeFragment(u.hash);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

const withoutWww = (host: string) => host.replace(/^www\./, '');

/**
 * Same scheme, same port and same host, ignoring a leading "www.". URL parsing already lowercases
 * the host and drops default ports, so "https://a.example:443" equals "https://a.example". Host
 * alone is not a site: http vs https, or :8443 vs :443, are different servers.
 */
export function sameSite(a: string | URL, b: string | URL): boolean {
  const ua = typeof a === 'string' ? parseHttpUrl(a) : a;
  const ub = typeof b === 'string' ? parseHttpUrl(b) : b;
  return (
    ua !== null &&
    ub !== null &&
    ua.protocol === ub.protocol &&
    ua.port === ub.port &&
    withoutWww(ua.hostname) === withoutWww(ub.hostname)
  );
}

/** `url` with a leading "www." removed from the host, for comparing two spellings of one site. */
function foldWww(url: string): string {
  const u = new URL(url);
  u.hostname = withoutWww(u.hostname);
  return u.toString();
}

/**
 * A page-declared canonical URL is trusted only when it names the page itself: same scheme, port and
 * host (a leading "www." is ignored) and, after normalisation (tracking and credential parameters,
 * fragment and trailing slash ignored), the same path and query. A canonical that points anywhere
 * else is a claim about content, not identity: "/" on every route of a single-page app or "page 1"
 * on every page of a listing would merge unrelated pages into one source. Those are keyed by the
 * visited URL instead.
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
  if (!canon || !sameSite(canon, page)) return null;
  const canonical = normalizeUrl(canon.toString());
  const visited = normalizeUrl(page.toString());
  if (canonical === null || visited === null) return null;
  return foldWww(canonical) === foldWww(visited) ? canonical : null;
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

/**
 * scheme://host[:port]/*  where host is "*", "*.name", a name, or a bracketed IPv6 literal. These
 * are the origin-wide patterns StudyVault registers. Underscores and "[::1]" are accepted because
 * Chromium accepts them (checked against a real Chromium build); a pattern this rejects would be
 * dropped by the worker's registration, so callers must refuse it before storing it.
 */
export const MATCH_PATTERN =
  /^(\*|https?):\/\/(\*|(?:\*\.)?[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::(\*|\d{1,5}))?\/\*$/i;

/** Deny entries become `*://*.host/*`; anything with wildcards, ports or paths cannot be expressed. */
export const DENY_HOST = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

export const isRegistrablePattern = (pattern: string): boolean => MATCH_PATTERN.test(pattern);

/**
 * Host as compared by the deny list: lowercase, no trailing dot. "paypal.com." is the same server
 * as "paypal.com" and must not slip past the list.
 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/** Deny entries that cover `host`: the entry itself or a parent domain. Entries are returned as stored. */
export function denyEntriesFor(host: string, denyList: readonly string[]): string[] {
  const h = normalizeHost(host);
  return denyList.filter((entry) => {
    const e = normalizeHost(entry);
    return e.length > 0 && (h === e || h.endsWith(`.${e}`));
  });
}

/** Deny entries match the host itself and any subdomain. */
export function isHostDenied(host: string, denyList: readonly string[]): boolean {
  return denyEntriesFor(host, denyList).length > 0;
}

export type CaptureBlock = 'unsupported-scheme' | 'denied-site';

/** Why capture is not allowed on `url`, or null when it is. Scheme check first, then deny list. */
export function captureBlock(url: string, denyList: readonly string[]): CaptureBlock | null {
  const u = parseHttpUrl(url);
  if (!u) return 'unsupported-scheme';
  return isHostDenied(u.hostname, denyList) ? 'denied-site' : null;
}

/**
 * Stand-in address of sources that have none: a PDF opened from a file, highlights imported from a
 * file without a URL. `.invalid` is reserved (RFC 2606), so these never resolve and are never shown,
 * linked or indexed. Writers build theirs from this prefix; readers ask `isPlaceholderSourceUrl`.
 */
export const PLACEHOLDER_SOURCE_PREFIX = 'https://studyvault.invalid/';

export function isPlaceholderSourceUrl(url: string | null | undefined): boolean {
  const parsed = url ? parseHttpUrl(url) : null;
  return parsed !== null && parsed.hostname === 'studyvault.invalid';
}

/** The address to show, link or index: '' for a missing one and for a placeholder. */
export function visibleSourceUrl(url: string | null | undefined): string {
  return url && !isPlaceholderSourceUrl(url) ? url : '';
}
