/**
 * Search-box helpers for compact surfaces (pure). The query grammar itself lives in @search; this
 * only builds and removes `key:"value"` tokens so a facet chip or a bank scope can narrow a query
 * without the person typing the syntax.
 */

export type FacetKey = 'bank' | 'folder' | 'tag' | 'kind' | 'host' | 'status';

const quoted = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** `bank:"Cardiology"` */
export function facetToken(key: FacetKey, value: string): string {
  return `${key}:${quoted(value)}`;
}

export function hasFacetToken(query: string, key: FacetKey, value: string): boolean {
  return query.includes(facetToken(key, value));
}

/** OR binds loosest: anything appended to a top-level OR must see the whole query grouped. */
const hasOr = (query: string): boolean => /(^|\s)OR(\s|$)/.test(query);

/** True when the whole query is one parenthesised group. */
function isGroup(query: string): boolean {
  const q = query.trim();
  if (!q.startsWith('(') || !q.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] === '(') depth++;
    else if (q[i] === ')') depth--;
    if (depth === 0 && i < q.length - 1) return false; // the first paren closes early
  }
  return true;
}

/** `query` with `tokens` ANDed on, grouping the typed text first when it contains a top-level OR. */
export function appendTokens(query: string, tokens: readonly string[]): string {
  const base = query.trim();
  const extra = tokens.filter((t) => t !== '').join(' ');
  if (extra === '') return base;
  if (base === '') return extra;
  return `${hasOr(base) && !isGroup(base) ? `(${base})` : base} ${extra}`;
}

/** `query` without `tokens` (and without the group that only existed to hold their siblings). */
export function removeTokens(query: string, tokens: readonly string[]): string {
  let rest = query;
  for (const token of tokens) rest = rest.replace(token, '');
  rest = rest.replace(/\s{2,}/g, ' ').trim();
  return isGroup(rest) ? rest.slice(1, -1).trim() : rest;
}

/** Add the facet token when it is absent; remove it (with its separating space) when present. */
export function toggleFacetToken(query: string, key: FacetKey, value: string): string {
  const token = facetToken(key, value);
  return query.includes(token) ? removeTokens(query, [token]) : appendTokens(query, [token]);
}

/** The tokens that confine a query to one bank (and optionally one folder inside it). */
export function scopeTokens(
  scope: { bankName: string; folderName: string | null } | null,
): string[] {
  if (!scope) return [];
  return [
    facetToken('bank', scope.bankName),
    ...(scope.folderName ? [facetToken('folder', scope.folderName)] : []),
  ];
}
