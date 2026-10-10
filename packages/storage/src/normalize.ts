/**
 * Quote normalisation used for duplicate detection and search. Never applied to `exactQuote`
 * (provenance stays verbatim). Must stay stable: changing it changes every stored `quoteHash`.
 */
export function normalizeQuote(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * SHA-256 hex of an already-normalised quote. Needs `crypto.subtle`, which exists in the service
 * worker, extension pages and Node, but not in content scripts on http: pages.
 */
export async function quoteHash(normalizedQuote: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedQuote));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
