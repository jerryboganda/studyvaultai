/**
 * Related highlights without embeddings. Pure helpers; `SearchIndex.related` / `relatedToText` in
 * searchIndex.ts run the query.
 *
 * Method: take the words of the document itself (quote, your comment, tags, heading), weight each
 * distinct term by where it occurs and how often (field weight x (1 + ln tf)), rank the terms by that
 * weight times their inverse document frequency in the vault, drop function words and terms that are
 * everywhere, keep the best few, and look them up in the existing lexical index as one weighted OR
 * query. The score is MiniSearch's BM25 with the query-side weights as term boosts, so a highlight
 * that shares several telling terms outranks one that shares a single common one.
 *
 * Limits (stated, not hidden): terms are matched exactly, with no stemming, so "valve" does not find
 * "valves"; what is related is what shares words, not what means the same thing.
 */
import { analyzeWords, wordIndexTerms } from './analyzer';
import { FIELD_WEIGHTS } from './schema';
import type { SearchDocument, SearchField } from './schema';

/** The fields two documents are related through: what was captured and written, not where it lives. */
export const RELATED_FIELDS: readonly SearchField[] = [
  'quote',
  'comment',
  'tags',
  'headingContext',
];

export const RELATED_DEFAULT_LIMIT = 10;
export const RELATED_MAX_LIMIT = 50;
export const RELATED_DEFAULT_TERMS = 16;
export const RELATED_MAX_TERMS = 32;
/** A term held by more than this share of the vault (and at least the floor) says nothing. */
export const COMMON_TERM_FRACTION = 0.1;
export const COMMON_TERM_FLOOR = 8;
/** Longest stretch of one field that is analysed (a quote is at most 10,000 characters). */
const MAX_FIELD_CHARS = 10_000;
const SHOWN_TERMS = 5;

export interface RelatedOptions {
  /** Most related highlights returned, 1..50 (default 10). */
  limit?: number;
  /** Leave out highlights from the same source (same site and title) as the document. Default false. */
  excludeSameSource?: boolean;
  /** Include trashed highlights. Default false. */
  includeDeleted?: boolean;
  /** Most query terms used, 1..32 (default 16). */
  maxTerms?: number;
}

export interface RelatedHit {
  /** The related highlight (never the document's own highlight, never a note attached to nothing). */
  highlightId: string;
  /** The document that matched best: the highlight itself, or one of its notes. */
  doc: Readonly<SearchDocument>;
  /** Relative to this query only. */
  score: number;
  /** Every word both documents hold, as the source wrote them, most telling first. */
  sharedTerms: string[];
  /** One line for people, such as "shares: warfarin, INR, bleeding +2". */
  explanation: string;
}

export interface RelatedResult {
  /** False when the document is not in the index (nothing was compared). */
  found: boolean;
  /** Most related first; ties go to the more recently updated, then by id, so the order is stable. */
  hits: RelatedHit[];
  /** Related highlights found, which can be more than `hits` (`limit`). */
  total: number;
  /** The words the document was compared by, most telling first. Empty: nothing distinctive to compare. */
  terms: string[];
  /** Wall-clock milliseconds. */
  took: number;
}

/** The highlight a document stands for: its own id for a highlight, null for a free-standing note. */
export const highlightOf = (d: SearchDocument): string | null =>
  d.highlightId ?? (d.docType === 'highlight' ? d.id : null);

/** Documents of one source share it; unknown when there is no title, site or address. */
export function sourceKeyOf(d: SearchDocument): string | null {
  if (d.host || d.title) return `${d.host ?? ''}\n${d.title}`;
  return d.url ? d.url : null;
}

export function contentFields(d: SearchDocument): Array<readonly [SearchField, string]> {
  return [
    ['quote', d.quote],
    ['comment', d.comment],
    ['tags', d.tags.join('\n')],
    ['headingContext', d.headingContext ?? ''],
  ];
}

export interface TermWeight {
  /** Sum over fields of field weight x (1 + ln term frequency in that field). */
  weight: number;
  /** The word as first written (an acronym keeps its capitals). */
  shown: string;
}

/**
 * Distinct index terms of the given fields. Single characters and bare numbers are not concepts and
 * are left out, as are function words (the analyzer already drops them from the index).
 */
export function relatedTerms(
  fields: ReadonlyArray<readonly [SearchField, string]>,
  stop: ReadonlySet<string>,
): Map<string, TermWeight> {
  const out = new Map<string, TermWeight>();
  for (const [field, raw] of fields) {
    if (raw === '') continue;
    const text = raw.length > MAX_FIELD_CHARS ? raw.slice(0, MAX_FIELD_CHARS) : raw;
    const tf = new Map<string, number>();
    for (const word of analyzeWords(text, stop)) {
      for (const term of wordIndexTerms(word)) {
        if (term.length < 2 || /^\d+$/.test(term)) continue;
        tf.set(term, (tf.get(term) ?? 0) + 1);
        if (!out.has(term)) {
          out.set(term, {
            weight: 0,
            shown: term === word.whole ? text.slice(word.start, word.end) : term,
          });
        }
      }
    }
    for (const [term, n] of tf) out.get(term)!.weight += FIELD_WEIGHTS[field] * (1 + Math.log(n));
  }
  return out;
}

/** "shares: a, b, c +2" for the terms most worth showing. */
export function explainShared(shared: readonly string[]): string {
  if (shared.length === 0) return '';
  const more = shared.length - SHOWN_TERMS;
  return `shares: ${shared.slice(0, SHOWN_TERMS).join(', ')}${more > 0 ? ` +${more}` : ''}`;
}
