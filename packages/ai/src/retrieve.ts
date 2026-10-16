// Local retrieval for "chat with your notes": a question becomes a search over the person's own
// index on this device, never a request. Pure; the caller supplies the index (the @search one) and
// resolves the ids it returns to the vault's immutable quote or note text.
import { contentTokens } from './candidates';
import { matchForm } from './text';

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

/** Study abbreviations a question may use that notes spell out (and the reverse is caught by stems). */
const ABBREVIATIONS: Readonly<Record<string, readonly string[]>> = {
  mi: ['myocardial', 'infarction'],
  htn: ['hypertension'],
  dm: ['diabetes', 'mellitus'],
  hf: ['heart', 'failure'],
  chf: ['heart', 'failure'],
  copd: ['chronic', 'obstructive', 'pulmonary'],
  ckd: ['chronic', 'kidney'],
  aki: ['acute', 'kidney', 'injury'],
  uti: ['urinary', 'tract', 'infection'],
  gerd: ['reflux'],
  ra: ['rheumatoid', 'arthritis'],
  sle: ['lupus'],
  ecg: ['electrocardiogram'],
  ekg: ['electrocardiogram'],
  bp: ['blood', 'pressure'],
  ace: ['angiotensin', 'converting', 'enzyme'],
  arb: ['angiotensin', 'receptor'],
  nsaid: ['anti', 'inflammatory'],
  cns: ['nervous', 'system'],
  pe: ['pulmonary', 'embolism'],
  dvt: ['deep', 'vein', 'thrombosis'],
  af: ['atrial', 'fibrillation'],
  mri: ['magnetic', 'resonance'],
  ct: ['tomography'],
};

/** Light English stemmer: enough that "inhibitors" finds "inhibitor" and "bleeding" finds "bleed". */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && /(sses|shes|ches|xes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us'))
    w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 6 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 6 && w.endsWith('ly')) w = w.slice(0, -2);
  return w;
}

/**
 * The question's terms plus their stems and the spelled-out form of known abbreviations, de-duplicated,
 * original words first. Plain words only, so no operator can come out of a question.
 */
export function expandTerms(terms: readonly string[], max = 20): string[] {
  // A two-letter abbreviation is replaced by its words: "mi" alone would match half the index.
  const out = new Set<string>(terms.filter((t) => !(t.length < 3 && ABBREVIATIONS[t])));
  for (const t of terms) {
    const s = stem(t);
    if (s.length >= 3) out.add(s);
    for (const extra of ABBREVIATIONS[t] ?? []) out.add(extra);
  }
  return [...out].slice(0, max);
}

/** Words of a question that are worth searching for, as plain lower-case terms (no operators). */
export function questionTerms(question: string, max = 12): string[] {
  const terms = [...contentTokens(question)];
  // contentTokens keeps words of 3+ letters; known two-letter abbreviations are kept too.
  for (const t of matchForm(question)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (t.length === 2 && ABBREVIATIONS[t] && !terms.includes(t)) terms.push(t);
  }
  return terms.slice(0, max);
}

/**
 * `(a OR b OR c) scope`: any of the question's words, ranked by how many match and how well, inside
 * the scope tokens of the search grammar (`bank:"X" tag:"Y"`). Null when nothing searchable is left.
 */
export function retrievalQuery(question: string, scope = ''): string | null {
  const base = questionTerms(question);
  if (base.length === 0) return null;
  const terms = expandTerms(base);
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
