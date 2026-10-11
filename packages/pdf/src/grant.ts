/**
 * Lifecycle of the per-origin host grants a web PDF needs. The reader asks for one origin, from a
 * click, to fetch one file; once the fetch is over the grant is handed back, unless the person
 * already had access to that site some other way (a standing grant, the "sites you enabled" list, an
 * all-sites grant, the manifest). Free of Chrome types: the reader passes `browser.permissions`.
 */

export interface PermissionsPort {
  contains(query: { origins: string[] }): Promise<boolean>;
  request(query: { origins: string[] }): Promise<boolean>;
  remove(query: { origins: string[] }): Promise<boolean>;
}

/** `https://host[:port]/*`: exactly one origin. Anything with a wildcard host is not ours to remove. */
export function isSingleOriginPattern(pattern: string): boolean {
  return /^https?:\/\/[^*/]+\/\*$/.test(pattern);
}

/** scheme, host (a port is ignored: a pattern without one covers every port) of `scheme://host/*`. */
const PATTERN = /^(https?|\*):\/\/([^/:]+)(?::\d+)?\/\*$/;

/**
 * Whether one of `granted` (match patterns) already gives access to the origin pattern `pattern`:
 * the same origin, an all-sites pattern for its scheme, or a `*.suffix` wildcard over its host.
 */
export function isCoveredBy(pattern: string, granted: readonly string[]): boolean {
  const own = PATTERN.exec(pattern);
  if (!own) return false;
  const [, scheme = '', host = ''] = own;
  return granted.some((g) => {
    if (g === '<all_urls>') return true;
    const m = PATTERN.exec(g);
    if (!m) return false;
    const [, gScheme = '', gHost = ''] = m;
    if (gScheme !== '*' && gScheme !== scheme) return false;
    if (gHost === '*' || gHost === host) return true;
    // `*.example.org` matches example.org itself and every subdomain
    return gHost.startsWith('*.') && (host === gHost.slice(2) || host.endsWith(gHost.slice(1)));
  });
}

export interface RequestOutcome {
  granted: boolean;
  /** Patterns this request is what made accessible: the ones to hand back afterwards. */
  fresh: string[];
}

/**
 * Ask for `patterns` in one prompt. Call it synchronously from the click that explains the request:
 * both calls are issued before any await (the user gesture still counts), and `contains` is answered
 * before `request` can change the answer. A pattern whose state cannot be read counts as already
 * granted, so it is never withdrawn on a guess.
 */
export function requestOrigins(port: PermissionsPort, patterns: string[]): Promise<RequestOutcome> {
  const had = Promise.all(patterns.map((p) => port.contains({ origins: [p] }).catch(() => true)));
  const asked = port.request({ origins: patterns });
  return Promise.all([had, asked]).then(([before, granted]) => ({
    granted,
    fresh: granted ? patterns.filter((_, i) => before[i] === false) : [],
  }));
}

/**
 * Hand back what a fetch needed. Removes a pattern only when it is exactly one origin and nothing in
 * `keep` (the person's standing site list and the manifest's host permissions) already covers it.
 * Best effort: a refusal to remove is not an error of the fetch. Returns the patterns removed.
 */
export async function withdrawOrigins(
  port: Pick<PermissionsPort, 'remove'>,
  patterns: Iterable<string>,
  keep: readonly string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const pattern of new Set(patterns)) {
    if (!isSingleOriginPattern(pattern) || isCoveredBy(pattern, keep)) continue;
    try {
      if (await port.remove({ origins: [pattern] })) removed.push(pattern);
    } catch {
      /* Chrome refused (for example the grant is already gone): nothing more to do */
    }
  }
  return removed;
}
