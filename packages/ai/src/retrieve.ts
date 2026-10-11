// Local retrieval for "chat with your notes": a question becomes a search over the person's own
// index on this device, never a request. Pure; the caller supplies the index (the @search one) and
// resolves the ids it returns to the vault's immutable quote or note text.
import { contentTokens } from './candidates';

/** The part of @search's index this needs (kept structural so @ai does not depend on @search). */
export interface PassageSearch {
  search(
    query: string,
    options?: { limit?: number; collapseNotes?: boolean; facets?: boolean; suggest?: boolean },
  ): { total: number; hits: readonly { doc: { id: string; docType: 'highlight' | 'note' } }[] };
}

export interface PassageRef {
  id: string;
  kind: 'highlight' | 'note';
}

/** Words of a question that are worth searching for, as plain lower-case terms (no operators). */
export function questionTerms(question: string, max = 12): string[] {
  return [...contentTokens(question)].slice(0, max);
}

/**
 * `(a OR b OR c) scope`: any of the question's words, ranked by how many match and how well, inside
 * the scope tokens of the search grammar (`bank:"X" tag:"Y"`). Null when nothing searchable is left.
 */
export function retrievalQuery(question: string, scope = ''): string | null {
  const terms = questionTerms(question);
  if (terms.length === 0) return null;
  const any = terms.length === 1 ? terms[0]! : `(${terms.join(' OR ')})`;
  return scope.trim() ? `${any} ${scope.trim()}` : any;
}

/** The best `topK` passages (one per highlight or note) and how many matched in all. */
export function searchPassages(
  index: PassageSearch,
  query: string,
  topK: number,
): { refs: PassageRef[]; total: number } {
  const result = index.search(query, {
    limit: Math.min(100, Math.max(topK * 2, topK)),
    collapseNotes: true,
    facets: false,
    suggest: false,
  });
  const seen = new Set<string>();
  const refs: PassageRef[] = [];
  for (const hit of result.hits) {
    if (seen.has(hit.doc.id)) continue;
    seen.add(hit.doc.id);
    refs.push({ id: hit.doc.id, kind: hit.doc.docType });
    if (refs.length >= topK) break;
  }
  return { refs, total: result.total };
}
