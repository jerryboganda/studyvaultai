/**
 * Offline full-text + fuzzy search over `SearchDocument`s, built on MiniSearch 7.2.0.
 *
 * Memory choice: MiniSearch is created with `storeFields: []`, so the inverted index holds only ids and
 * term frequencies. The one and only in-memory copy of every text field is the (frozen) document kept in
 * `docs`; it also serves filters, facets, snippets, phrase verification and exact removal. The persisted
 * blob (`serialize`) is a derived cache: docs once + postings; it can be dropped and rebuilt any time.
 *
 * How a query runs: `parseQuery` -> boolean tree. Each word is one MiniSearch lookup (exact, plus
 * prefix and fuzzy when allowed); AND/OR/NOT combine the id->score maps in JS; phrases are the AND of
 * their exact terms verified for adjacency against the stored text; filters are predicates over the
 * candidate set (or a scan of the corpus when there is no text to narrow it). Fuzzy and prefix matches
 * are down-weighted by MiniSearch, so exact beats prefix beats fuzzy; the top window is additionally
 * boosted when the query words occur adjacently.
 *
 * Documents versus highlights: a note document repeats its highlight's quote and facets, so one
 * highlight can match through several documents. By default every document is a hit; with
 * `collapseNotes` the candidates are folded to one entry per highlight BEFORE sorting, so `total`,
 * the page boundaries and the facet counts all count highlights.
 */
import MiniSearch from 'minisearch';
import type { AsPlainObject, MatchInfo, Options } from 'minisearch';
import { z } from 'zod';
import {
  ANALYZER_VERSION,
  MAX_TERM_LENGTH,
  analyzeWords,
  foldText,
  indexTerms,
  partSequence,
  stopSet,
} from './analyzer';
import { collectLeaves, parseQuery } from './query';
import type { ParsedQuery, QueryNode, QueryWarning } from './query';
import {
  COMMON_TERM_FLOOR,
  COMMON_TERM_FRACTION,
  RELATED_DEFAULT_LIMIT,
  RELATED_DEFAULT_TERMS,
  RELATED_FIELDS,
  RELATED_MAX_LIMIT,
  RELATED_MAX_TERMS,
  contentFields,
  explainShared,
  highlightOf,
  relatedTerms,
  sourceKeyOf,
} from './related';
import type { RelatedHit, RelatedOptions, RelatedResult } from './related';
import { FIELD_WEIGHTS, SEARCH_FIELDS, SearchDocumentSchema } from './schema';
import type { SearchDocument, SearchField } from './schema';
import { buildSnippet, matchedSpans } from './snippets';
import type { Snippet } from './snippets';

const FORMAT = 'studyvault-search-index';
const FORMAT_VERSION = 1;
const PHRASE_BONUS = 1.5;
const BONUS_WINDOW = 100;
const FACET_LIMIT = 50;

export interface SearchIndexOptions {
  /** Droppable function words; `false` disables stop-word handling. Default: small English list. */
  stopWords?: readonly string[] | false;
}

export type SortMode = 'relevance' | 'updated' | 'priority';

export interface SearchOptions {
  /** Page size, 1..500 (default 50). */
  limit?: number;
  offset?: number;
  /** Include soft-deleted documents (trash search). Default false. */
  includeDeleted?: boolean;
  /** `relevance` (default; recency breaks ties), `updated` (newest first) or `priority` (high first). */
  sort?: SortMode;
  /** Word-start matching, default true. */
  prefix?: boolean;
  /** Typo tolerance, default true (terms of 4+ letters, no digits). */
  fuzzy?: boolean;
  /**
   * One hit per highlight, default false (one hit per document). A highlight that matches through
   * its own document and through note documents is a single hit: the best-scoring document leads
   * (a tie goes to the highlight itself, so a note leads only when the words matched inside it),
   * scores merge as their maximum and the matches are united. `total`, paging and facets then count
   * highlights. A note attached to nothing is its own hit.
   */
  collapseNotes?: boolean;
  /** Compute facet counts over all matches, default true. */
  facets?: boolean;
  /** Compute a "did you mean" correction, default true. */
  suggest?: boolean;
  /** Snippet window in characters (default 180); `Infinity` returns whole fields. */
  snippetLength?: number;
}

export interface FieldHighlight extends Snippet {
  field: SearchField;
  /** Element index for list fields (tags, banks, folderPath). */
  index?: number;
}

export interface SearchHit {
  id: string;
  /** Relative to this query only; not comparable across queries. */
  score: number;
  /** The indexed document (frozen; do not mutate). */
  doc: Readonly<SearchDocument>;
  /** Fields in which a query term matched, heaviest first. */
  matchedFields: SearchField[];
  /** Index terms that matched (folded; may differ from the query word on prefix/fuzzy hits). */
  matchedTerms: string[];
  /** Quote snippet first (matched or plain), then other fields that matched. Render as text nodes. */
  highlights: FieldHighlight[];
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface Facets {
  bank: FacetValue[];
  tag: FacetValue[];
  kind: FacetValue[];
  host: FacetValue[];
  status: FacetValue[];
}

export interface DidYouMean {
  /** The corrected query string, ready to search. */
  query: string;
  changes: { from: string; to: string }[];
}

export interface SearchResult {
  hits: SearchHit[];
  /**
   * Matches across all pages (after filters and the deleted rule): documents, or highlights when
   * `collapseNotes` is set. Always the unit `hits`, `offset` and `limit` count.
   */
  total: number;
  offset: number;
  limit: number;
  warnings: QueryWarning[];
  /** Counts over ALL matches, not just this page; null when `facets: false`. */
  facets: Facets | null;
  didYouMean: DidYouMean | null;
  /** Wall-clock milliseconds spent in `search`. */
  took: number;
}

export type UpsertStatus = 'added' | 'replaced' | 'unchanged' | 'rejected';

export interface UpsertResult {
  id: string | null;
  status: UpsertStatus;
  reason?: string;
}

export interface ApplyResult {
  added: number;
  replaced: number;
  unchanged: number;
  removed: number;
  rejected: { id: string | null; reason: string }[];
}

export interface ApplyAsyncOptions {
  snapshot?: boolean;
  /** Documents per chunk (default 250). */
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface IndexStats {
  documents: number;
  deleted: number;
  terms: number;
}

export interface SearchIndex {
  /** Number of indexed documents, soft-deleted ones included. */
  readonly size: number;
  has(id: string): boolean;
  get(id: string): Readonly<SearchDocument> | undefined;
  /** Add or replace one document by id. Invalid input is reported, never thrown. */
  upsert(doc: unknown): UpsertResult;
  /** Remove by id; false when absent. */
  remove(id: string): boolean;
  /**
   * Idempotent bulk sync. Unchanged documents are skipped (deep compare), changed ones replaced.
   * With `snapshot: true`, `docs` is the complete current set and every other id is removed.
   */
  applyChanges(docs: Iterable<unknown>, options?: { snapshot?: boolean }): ApplyResult;
  /**
   * Same result as `applyChanges`, but works in chunks and yields to the event loop between them so a
   * 10k-document first build does not freeze the side panel; `onProgress` reports real counts.
   * Every chunk is applied whole, so aborting (`signal`) leaves a consistent index, and running the
   * same call again converges. Rejects with the signal's reason when aborted.
   */
  applyChangesAsync(docs: readonly unknown[], options?: ApplyAsyncOptions): Promise<ApplyResult>;
  clear(): void;
  search(query: string, options?: SearchOptions): SearchResult;
  /**
   * The highlights of the vault that share the most telling words with this document (a highlight or
   * a note), from the same lexical index: no network, no model. The document's own highlight, trashed
   * highlights (unless asked for) and notes attached to nothing are never returned. See related.ts.
   */
  related(id: string, options?: RelatedOptions): RelatedResult;
  /** The same for free text, such as a knowledge point: nothing is excluded as "its own". */
  relatedToText(text: string, options?: RelatedOptions): RelatedResult;
  stats(): IndexStats;
  /** Versioned JSON text for the meta table; restore with `deserializeSearchIndex`. */
  serialize(): string;
}

export type LoadFailure = 'corrupt' | 'version' | 'analyzer';

export type LoadResult =
  { ok: true; index: SearchIndex } | { ok: false; reason: LoadFailure; detail: string };

// ---------------------------------------------------------------------------------------------

interface Stored {
  doc: SearchDocument;
  bank: string[];
  folder: string[];
  tag: string[];
  kind: string;
  host: string;
  status: string;
}

interface Hit {
  score: number;
  matches: MatchInfo[];
}
type Scores = Map<string, Hit>;
/** A phrase whose adjacency check is deferred until cheaper filters have thinned the candidates. */
interface Pending {
  parts: string[];
  candidates: string[];
}
type Res = { set: Scores; pending: Pending[] } | { pred: (s: Stored) => boolean };

interface Ctx {
  prefix: boolean;
  fuzzy: boolean;
}

function fieldText(d: SearchDocument, field: string): string {
  switch (field) {
    case 'id':
      return d.id;
    case 'quote':
      return d.quote;
    case 'comment':
      return d.comment;
    case 'title':
      return d.title;
    case 'headingContext':
      return d.headingContext ?? '';
    case 'host':
      return d.host ?? '';
    case 'tags':
      return d.tags.join('\n');
    case 'banks':
      return d.banks.join('\n');
    case 'folderPath':
      return d.folderPath.join('\n');
    default:
      return '';
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameDoc(a: SearchDocument, b: SearchDocument): boolean {
  return (
    a.id === b.id &&
    a.docType === b.docType &&
    a.highlightId === b.highlightId &&
    a.title === b.title &&
    a.url === b.url &&
    a.host === b.host &&
    a.quote === b.quote &&
    a.comment === b.comment &&
    a.headingContext === b.headingContext &&
    a.kind === b.kind &&
    a.priority === b.priority &&
    a.resolveStatus === b.resolveStatus &&
    a.updatedAt === b.updatedAt &&
    a.deletedAt === b.deletedAt &&
    sameList(a.tags, b.tags) &&
    sameList(a.banks, b.banks) &&
    sameList(a.folderPath, b.folderPath)
  );
}

function freezeDoc(d: SearchDocument): SearchDocument {
  Object.freeze(d.tags);
  Object.freeze(d.banks);
  Object.freeze(d.folderPath);
  return Object.freeze(d);
}

function toStored(doc: SearchDocument): Stored {
  return {
    doc,
    bank: doc.banks.map(foldText),
    folder: doc.folderPath.map(foldText),
    tag: doc.tags.map(foldText),
    kind: foldText(doc.kind),
    host: foldText(doc.host ?? ''),
    status: foldText(doc.resolveStatus),
  };
}

function textUnits(d: SearchDocument): string[] {
  const units = [d.quote, d.comment, d.title, d.headingContext ?? '', d.host ?? ''];
  for (const list of [d.tags, d.banks, d.folderPath]) for (const x of list) units.push(x);
  return units.filter((u) => u !== '');
}

function containsSeq(seq: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= seq.length; i++) {
    for (let j = 0; j < needle.length; j++) if (seq[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function fuzzyDistance(term: string): number {
  return term.length < 4 ? 0 : term.length < 8 ? 1 : 2;
}

const q6 = (n: number): number => Math.round(n * 1e6);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One candidate row of a search: a document, or (collapsed) every matching document of a highlight. */
interface Entry {
  s: Stored;
  score: number;
  matches: MatchInfo[];
  /** Recency key: the document's `updatedAt`, or the newest one of a collapsed highlight. */
  at: string;
}

const byRecency = (a: Entry, b: Entry): number =>
  cmpStr(b.at, a.at) || cmpStr(a.s.doc.id, b.s.doc.id);

/** Negative when `a` is the better document to stand for its highlight than `b`. */
function leads(a: Entry, b: Entry): number {
  const ta = a.s.doc.docType;
  const tb = b.s.doc.docType;
  return (
    q6(b.score) - q6(a.score) || (ta === tb ? 0 : ta === 'highlight' ? -1 : 1) || byRecency(a, b)
  );
}

/**
 * One entry per highlight (documents with no `highlightId` stand for themselves). The lead is the
 * best-scoring document: a note document repeats its highlight's quote and facets, so it outscores
 * the highlight only when the words also matched inside the note, which is exactly when its text is
 * the snippet worth showing. The group's score is the best of its documents (the same evidence is
 * not added up), its matches are united and it is as recent as its newest document.
 */
function collapseByHighlight(entries: readonly Entry[]): Entry[] {
  const groups = new Map<string, Omit<Entry, 's'> & { lead: Entry }>();
  for (const e of entries) {
    const key = e.s.doc.highlightId ?? e.s.doc.id;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { lead: e, score: e.score, matches: e.matches, at: e.at });
      continue;
    }
    if (leads(e, g.lead) < 0) g.lead = e;
    g.score = Math.max(g.score, e.score);
    g.matches = g.matches.concat(e.matches);
    if (e.at > g.at) g.at = e.at;
  }
  return [...groups.values()].map((g) => ({
    s: g.lead.s,
    score: g.score,
    matches: g.matches,
    at: g.at,
  }));
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function coreOptions(stop: ReadonlySet<string>): Options<SearchDocument> {
  return {
    fields: [...SEARCH_FIELDS],
    idField: 'id',
    storeFields: [],
    extractField: fieldText,
    tokenize: (text) => indexTerms(analyzeWords(text, stop)),
    processTerm: (term) => term,
    logger: () => undefined,
    autoVacuum: false,
  };
}

type Postings = Map<number, Map<number, number>>;
interface CoreInternals {
  _index: { fetch(term: string, initial: () => Postings): Postings };
}

/**
 * Bulk-load speed-up. MiniSearch resolves every token through a radix-tree descent, and a real corpus
 * has ~40x more tokens than distinct terms. This subclass keeps a term -> postings Map in front of the
 * tree (the same postings objects, so memory is unchanged) and drops an entry whenever MiniSearch
 * removes that term. It reaches two private methods of the exactly-pinned minisearch 7.2.0; when they
 * are not there it silently falls back to stock behaviour (slower, identical results).
 * `searchCoreIsAccelerated()` lets the test suite fail loudly if a dependency bump disables it.
 */
class SearchCore extends MiniSearch<SearchDocument> {}
const stockProto = MiniSearch.prototype as unknown as { addTerm?: unknown; removeTerm?: unknown };
const termCache = new WeakMap<object, Map<string, Postings>>();
let accelerated = false;
if (typeof stockProto.addTerm === 'function' && typeof stockProto.removeTerm === 'function') {
  const stockRemove = stockProto.removeTerm as (
    this: unknown,
    fieldId: number,
    docId: number,
    term: string,
  ) => void;
  Object.defineProperty(SearchCore.prototype, 'addTerm', {
    configurable: true,
    writable: true,
    value(this: CoreInternals, fieldId: number, docId: number, term: string): void {
      let cache = termCache.get(this);
      if (!cache) termCache.set(this, (cache = new Map()));
      let postings = cache.get(term);
      if (postings === undefined) {
        postings = this._index.fetch(term, () => new Map());
        cache.set(term, postings);
      }
      const field = postings.get(fieldId);
      if (field === undefined) postings.set(fieldId, new Map([[docId, 1]]));
      else field.set(docId, (field.get(docId) ?? 0) + 1);
    },
  });
  Object.defineProperty(SearchCore.prototype, 'removeTerm', {
    configurable: true,
    writable: true,
    value(this: object, fieldId: number, docId: number, term: string): void {
      termCache.get(this)?.delete(term);
      stockRemove.call(this, fieldId, docId, term);
    },
  });
  accelerated = true;
}

/** @internal exported for the test suite only */
export function searchCoreIsAccelerated(): boolean {
  return accelerated;
}

function newCore(stop: ReadonlySet<string>): MiniSearch<SearchDocument> {
  return new SearchCore(coreOptions(stop));
}

/** A core restored by `MiniSearch.loadJS` is a stock instance; give it the same fast path. */
function accelerate(core: MiniSearch<SearchDocument>): MiniSearch<SearchDocument> {
  return accelerated ? Object.setPrototypeOf(core, SearchCore.prototype) : core;
}

const LEAF_OPTIONS = {
  boost: FIELD_WEIGHTS as Record<string, number>,
  combineWith: 'OR' as const,
  // A word start (plural, suffix) is a better match than a misspelling; both rank below exact (1).
  weights: { fuzzy: 0.3, prefix: 0.4 },
  // Query terms arrive already analysed; do not re-tokenize them.
  tokenize: (t: string) => [t],
  processTerm: (t: string) => t,
};

/** Minimal view of MiniSearch's internal radix tree (version-pinned; feature-detected). */
interface Vocabulary {
  has(key: string): boolean;
  /** field id -> (internal document id -> frequency) of one exact term. */
  get(key: string): Map<number, Map<number, number>> | undefined;
  atPrefix(prefix: string): { keys(): { next(): { done?: boolean } } };
  fuzzyGet(key: string, maxEditDistance: number): Map<string, [unknown, number]>;
}

function vocabularyOf(core: MiniSearch<SearchDocument>): Vocabulary | null {
  const v = (core as unknown as { _index?: Partial<Vocabulary> })._index;
  return v &&
    typeof v.has === 'function' &&
    typeof v.get === 'function' &&
    typeof v.atPrefix === 'function' &&
    typeof v.fuzzyGet === 'function'
    ? (v as Vocabulary)
    : null;
}

const RELATED_FIELD_IDS = RELATED_FIELDS.map((f) => SEARCH_FIELDS.indexOf(f));

const clampInt = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(max, Math.max(1, Math.floor(value ?? fallback)));

/** Documents holding `term` in a related field. */
function docFreq(vocab: Vocabulary, term: string): number {
  const data = vocab.get(term);
  if (!data) return 0;
  const lists: Array<Map<number, number>> = [];
  for (const id of RELATED_FIELD_IDS) {
    const m = data.get(id);
    if (m) lists.push(m);
  }
  if (lists.length <= 1) return lists[0]?.size ?? 0;
  const ids = new Set<number>();
  for (const m of lists) for (const id of m.keys()) ids.add(id);
  return ids.size;
}

function intersect(maps: Scores[]): Scores {
  const sorted = [...maps].sort((a, b) => a.size - b.size);
  const [base, ...rest] = sorted;
  const out: Scores = new Map();
  if (!base) return out;
  for (const [id, h] of base) {
    let score = h.score;
    let matches = h.matches;
    let ok = true;
    for (const m of rest) {
      const o = m.get(id);
      if (!o) {
        ok = false;
        break;
      }
      score += o.score;
      matches = matches.concat(o.matches);
    }
    if (ok) out.set(id, { score, matches });
  }
  return out;
}

function union(maps: Scores[], mode: 'sum' | 'max'): Scores {
  const out: Scores = new Map();
  for (const m of maps) {
    for (const [id, h] of m) {
      const cur = out.get(id);
      if (!cur) out.set(id, { score: h.score, matches: h.matches });
      else {
        cur.score = mode === 'sum' ? cur.score + h.score : Math.max(cur.score, h.score);
        cur.matches = cur.matches.concat(h.matches);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

class Index implements SearchIndex {
  private readonly stop: ReadonlySet<string>;
  readonly analyzerKey: string;
  private core: MiniSearch<SearchDocument>;
  private readonly docs = new Map<string, Stored>();
  /** highlightId -> live note documents attached to it (for `has:note`). */
  private readonly noteRefs = new Map<string, number>();
  /** highlightId -> every note document attached to it, trashed or not (for `related`). */
  private readonly notesOf = new Map<string, Set<string>>();

  constructor(options: SearchIndexOptions, core?: MiniSearch<SearchDocument>) {
    this.stop = stopSet(options.stopWords);
    this.analyzerKey = `${ANALYZER_VERSION}:${fnv1a([...this.stop].sort().join(','))}`;
    this.core = core ? accelerate(core) : newCore(this.stop);
  }

  get size(): number {
    return this.docs.size;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  get(id: string): Readonly<SearchDocument> | undefined {
    return this.docs.get(id)?.doc;
  }

  /** Re-attach a document that MiniSearch already holds (deserialization). */
  adopt(doc: SearchDocument): void {
    const stored = toStored(freezeDoc(doc));
    this.docs.set(doc.id, stored);
    this.track(stored.doc, 1);
  }

  private track(doc: SearchDocument, delta: 1 | -1): void {
    if (doc.docType !== 'note' || doc.highlightId === null) return;
    let notes = this.notesOf.get(doc.highlightId);
    if (delta > 0) {
      if (!notes) this.notesOf.set(doc.highlightId, (notes = new Set()));
      notes.add(doc.id);
    } else if (notes?.delete(doc.id) && notes.size === 0) this.notesOf.delete(doc.highlightId);
    if (doc.deletedAt !== null) return;
    const next = (this.noteRefs.get(doc.highlightId) ?? 0) + delta;
    if (next > 0) this.noteRefs.set(doc.highlightId, next);
    else this.noteRefs.delete(doc.highlightId);
  }

  upsert(raw: unknown): UpsertResult {
    const parsed = SearchDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
          ? (raw as { id: string }).id
          : null;
      const issue = parsed.error.issues[0];
      return {
        id,
        status: 'rejected',
        reason: issue ? `${issue.path.join('.') || 'document'}: ${issue.message}` : 'invalid',
      };
    }
    const doc = parsed.data;
    const existing = this.docs.get(doc.id);
    if (existing && sameDoc(existing.doc, doc)) return { id: doc.id, status: 'unchanged' };
    if (existing) this.removeStored(existing);
    const stored = toStored(freezeDoc(doc));
    this.core.add(stored.doc);
    this.docs.set(doc.id, stored);
    this.track(stored.doc, 1);
    return { id: doc.id, status: existing ? 'replaced' : 'added' };
  }

  private removeStored(s: Stored): void {
    this.core.remove(s.doc);
    this.docs.delete(s.doc.id);
    this.track(s.doc, -1);
  }

  remove(id: string): boolean {
    const s = this.docs.get(id);
    if (!s) return false;
    this.removeStored(s);
    return true;
  }

  private applyInto(docs: Iterable<unknown>, result: ApplyResult, seen: Set<string> | null): void {
    for (const raw of docs) {
      const r = this.upsert(raw);
      if (r.id !== null) seen?.add(r.id); // a rejected update keeps the previous indexed version
      if (r.status === 'rejected')
        result.rejected.push({ id: r.id, reason: r.reason ?? 'invalid' });
      else result[r.status]++;
    }
  }

  private dropMissing(seen: Set<string>, result: ApplyResult): void {
    for (const id of [...this.docs.keys()]) {
      if (!seen.has(id) && this.remove(id)) result.removed++;
    }
  }

  applyChanges(docs: Iterable<unknown>, options: { snapshot?: boolean } = {}): ApplyResult {
    const result: ApplyResult = { added: 0, replaced: 0, unchanged: 0, removed: 0, rejected: [] };
    const seen = options.snapshot ? new Set<string>() : null;
    this.applyInto(docs, result, seen);
    if (seen) this.dropMissing(seen, result);
    return result;
  }

  async applyChangesAsync(
    docs: readonly unknown[],
    options: ApplyAsyncOptions = {},
  ): Promise<ApplyResult> {
    const size = Math.max(1, Math.floor(options.chunkSize ?? 250));
    const result: ApplyResult = { added: 0, replaced: 0, unchanged: 0, removed: 0, rejected: [] };
    const seen = options.snapshot ? new Set<string>() : null;
    for (let i = 0; i < docs.length; i += size) {
      options.signal?.throwIfAborted();
      this.applyInto(docs.slice(i, i + size), result, seen);
      options.onProgress?.(Math.min(docs.length, i + size), docs.length);
      if (i + size < docs.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    options.signal?.throwIfAborted();
    if (seen) this.dropMissing(seen, result);
    return result;
  }

  clear(): void {
    this.core = newCore(this.stop);
    this.docs.clear();
    this.noteRefs.clear();
    this.notesOf.clear();
  }

  stats(): IndexStats {
    let deleted = 0;
    for (const s of this.docs.values()) if (s.doc.deletedAt !== null) deleted++;
    return { documents: this.docs.size, deleted, terms: this.core.termCount };
  }

  serialize(): string {
    const docs = JSON.stringify([...this.docs.values()].map((s) => s.doc));
    const index = JSON.stringify(this.core.toJSON());
    const head =
      `{"format":${JSON.stringify(FORMAT)},"version":${FORMAT_VERSION},` +
      `"analyzer":${JSON.stringify(this.analyzerKey)},`;
    return `${head}"checksum":${JSON.stringify(fnv1a(docs + '|' + index))},"docs":${docs},"index":${index}}`;
  }

  // --- query evaluation -------------------------------------------------------------------

  private leaf(term: string, prefix: boolean, fuzzy: number): Scores {
    const out: Scores = new Map();
    for (const r of this.core.search(term, {
      ...LEAF_OPTIONS,
      prefix,
      fuzzy: fuzzy > 0 ? fuzzy : false,
    })) {
      out.set(r.id as string, { score: r.score, matches: [r.match] });
    }
    return out;
  }

  private hasPhrase(doc: SearchDocument, needle: readonly string[], skipStop: boolean): boolean {
    for (const unit of textUnits(doc)) {
      if (containsSeq(partSequence(analyzeWords(unit, this.stop), skipStop), needle)) return true;
    }
    return false;
  }

  /** Text units of `d` limited to the given index fields (all units when `fields` is null). */
  private unitsIn(d: SearchDocument, fields: ReadonlySet<string> | null): string[] {
    if (fields === null) return textUnits(d);
    const out: string[] = [];
    for (const f of fields) {
      if (f === 'tags') out.push(...d.tags);
      else if (f === 'banks') out.push(...d.banks);
      else if (f === 'folderPath') out.push(...d.folderPath);
      else {
        const t = fieldText(d, f);
        if (t !== '') out.push(t);
      }
    }
    return out;
  }

  /**
   * Does the phrase occur adjacently? Only fields in which EVERY candidate term matched can hold it,
   * which usually narrows the check to a single field.
   */
  private verify(s: Stored, h: Hit, p: Pending): boolean {
    let fields: Set<string> | null = null;
    for (const term of p.candidates) {
      const here = new Set<string>();
      for (const m of h.matches) for (const f of m[term] ?? []) here.add(f);
      if (fields === null) fields = here;
      else for (const f of [...fields]) if (!here.has(f)) fields.delete(f);
      if (fields.size === 0) return false;
    }
    for (const unit of this.unitsIn(s.doc, fields)) {
      if (containsSeq(partSequence(analyzeWords(unit, this.stop)), p.parts)) return true;
    }
    return false;
  }

  private settle(set: Scores, pending: readonly Pending[]): Scores {
    if (pending.length === 0) return set;
    for (const [id, h] of set) {
      const s = this.docs.get(id);
      if (!s || !pending.every((p) => this.verify(s, h, p))) set.delete(id);
    }
    return set;
  }

  private evalPhrase(parts: string[], candidates: string[]): Res {
    if (candidates.length === 0) {
      // nothing to look up in the index (only function words): scan and verify
      return { pred: (s) => this.hasPhrase(s.doc, parts, false) };
    }
    const maps: Scores[] = [];
    for (const t of candidates) {
      const m = this.leaf(t, false, 0);
      if (m.size === 0) return { set: new Map(), pending: [] };
      maps.push(m);
    }
    const set = maps.length === 1 ? maps[0]! : intersect(maps);
    return { set, pending: parts.length > 1 ? [{ parts, candidates }] : [] };
  }

  private evalTerm(node: Extract<QueryNode, { type: 'term' }>, ctx: Ctx): Res {
    const w = node.word;
    const digits = /\d/.test(w.whole);
    const direct = this.leaf(
      w.whole,
      ctx.prefix && !digits && w.whole.length >= 2,
      ctx.fuzzy && !digits ? fuzzyDistance(w.whole) : 0,
    );
    if (w.parts.length === 1) return { set: direct, pending: [] };
    // "5mg" must also be found by "5 mg": accept the parts as an adjacent phrase.
    const alt = this.evalPhrase(
      w.parts,
      w.parts.filter((p) => p.length <= MAX_TERM_LENGTH),
    );
    if (!('set' in alt)) return { set: direct, pending: [] };
    return { set: union([direct, this.settle(alt.set, alt.pending)], 'max'), pending: [] };
  }

  private filterPred(node: Extract<QueryNode, { type: 'filter' }>): (s: Stored) => boolean {
    const v = node.value;
    const any = (list: readonly string[]): boolean =>
      node.prefix ? list.some((x) => x.startsWith(v)) : list.includes(v);
    switch (node.key) {
      case 'bank':
        return (s) => any(s.bank);
      case 'folder':
        return (s) => any(s.folder);
      case 'tag':
        return (s) => any(s.tag);
      case 'kind':
        return (s) => any([s.kind]);
      case 'status':
        return (s) => any([s.status]);
      case 'host':
        return (s) =>
          node.prefix ? s.host.startsWith(v) : s.host === v || s.host.endsWith(' ' + v);
      case 'type':
        return (s) => s.doc.docType === v;
      case 'priority': {
        const n = node.num ?? 0;
        const c = node.cmp ?? '=';
        return (s) => {
          const p = s.doc.priority;
          return c === '>'
            ? p > n
            : c === '>='
              ? p >= n
              : c === '<'
                ? p < n
                : c === '<='
                  ? p <= n
                  : p === n;
        };
      }
      case 'has':
        return (s) => {
          if (v === 'tag') return s.doc.tags.length > 0;
          if (v === 'bank') return s.doc.banks.length > 0;
          if (v === 'heading') return (s.doc.headingContext ?? '') !== '';
          return (
            s.doc.docType === 'note' ||
            s.doc.comment.trim() !== '' ||
            (this.noteRefs.get(s.doc.id) ?? 0) > 0 ||
            (s.doc.highlightId !== null && (this.noteRefs.get(s.doc.highlightId) ?? 0) > 0)
          );
        };
    }
  }

  private evalNode(node: QueryNode, ctx: Ctx): Res {
    switch (node.type) {
      case 'term':
        return this.evalTerm(node, ctx);
      case 'phrase':
        return this.evalPhrase(node.parts, node.candidates);
      case 'filter':
        return { pred: this.filterPred(node) };
      case 'not': {
        const r = this.evalNode(node.child, ctx);
        if (!('set' in r)) return { pred: (s) => !r.pred(s) };
        const set = this.settle(r.set, r.pending);
        return { pred: (s) => !set.has(s.doc.id) };
      }
      case 'and': {
        // Function words are optional next to real terms (the index does not hold them).
        const live = node.children.filter((k) => !(k.type === 'term' && k.word.stop));
        const kids = live.some((k) => k.type !== 'not') ? live : node.children;
        const results = kids.map((k) => this.evalNode(k, ctx));
        const sets: Scores[] = [];
        const pending: Pending[] = [];
        const preds: Array<(s: Stored) => boolean> = [];
        for (const r of results) {
          if ('set' in r) {
            sets.push(r.set);
            pending.push(...r.pending);
          } else preds.push(r.pred);
        }
        if (sets.length === 0) return { pred: (s) => preds.every((p) => p(s)) };
        const merged = sets.length === 1 ? sets[0]! : intersect(sets);
        // cheapest checks first: filters, then the (text-scanning) phrase verification
        if (preds.length > 0) {
          for (const id of [...merged.keys()]) {
            const s = this.docs.get(id);
            if (!s || !preds.every((p) => p(s))) merged.delete(id);
          }
        }
        return { set: this.settle(merged, pending), pending: [] };
      }
      case 'or': {
        const results = node.children.map((k) => this.evalNode(k, ctx));
        const sets = results.map((r) => {
          if ('set' in r) return this.settle(r.set, r.pending);
          const m: Scores = new Map();
          for (const s of this.docs.values())
            if (r.pred(s)) m.set(s.doc.id, { score: 0, matches: [] });
          return m;
        });
        return { set: union(sets, 'sum'), pending: [] };
      }
    }
  }

  /**
   * Content words of a plain conjunction ("a b \"c d\"" -> a b c d), used for a soft boost when they
   * occur adjacently. Null for anything with OR/NOT at the top, or with fewer than two text parts.
   */
  private bonusSequence(root: QueryNode): string[] | null {
    const kids = root.type === 'and' ? root.children : [root];
    const seq: string[] = [];
    let leaves = 0;
    for (const k of kids) {
      if (k.type === 'phrase') {
        leaves++;
        seq.push(...k.contentParts);
      } else if (k.type === 'term') {
        leaves++;
        if (!k.word.stop) seq.push(...k.word.parts);
      }
    }
    return leaves >= 2 && seq.length >= 2 ? seq : null;
  }

  search(query: string, options: SearchOptions = {}): SearchResult {
    const t0 = nowMs();
    const parsed = parseQuery(query);
    const ctx: Ctx = { prefix: options.prefix !== false, fuzzy: options.fuzzy !== false };
    const includeDeleted = options.includeDeleted === true;
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const sort: SortMode = options.sort ?? 'relevance';

    let entries: Entry[] = [];
    const visible = (s: Stored): boolean => includeDeleted || s.doc.deletedAt === null;
    const add = (s: Stored, score: number, matches: MatchInfo[]): void => {
      entries.push({ s, score, matches, at: s.doc.updatedAt });
    };

    if (parsed.root === null) {
      for (const s of this.docs.values()) if (visible(s)) add(s, 0, []);
    } else {
      const res = this.evalNode(parsed.root, ctx);
      if ('set' in res) {
        for (const [id, h] of this.settle(res.set, res.pending)) {
          const s = this.docs.get(id);
          if (s && visible(s)) add(s, h.score, h.matches);
        }
      } else {
        for (const s of this.docs.values()) {
          if (visible(s) && res.pred(s)) add(s, 0, []);
        }
      }
    }

    // Before sorting, so the order, the page boundaries, `total` and the facets all count highlights.
    if (options.collapseNotes === true) entries = collapseByHighlight(entries);

    if (sort === 'updated') entries.sort(byRecency);
    else if (sort === 'priority') {
      entries.sort((a, b) => b.s.doc.priority - a.s.doc.priority || byRecency(a, b));
    } else {
      const byScore = (a: Entry, b: Entry): number => q6(b.score) - q6(a.score) || byRecency(a, b);
      entries.sort(byScore);
      const seq = parsed.root ? this.bonusSequence(parsed.root) : null;
      if (seq && entries.length > 1) {
        const k = Math.max(BONUS_WINDOW, offset + limit);
        const head = entries.slice(0, k);
        for (const e of head) {
          if (this.hasPhrase(e.s.doc, seq, true)) e.score *= PHRASE_BONUS;
        }
        head.sort(byScore);
        entries = head.concat(entries.slice(k));
      }
    }

    const page = entries.slice(offset, offset + limit);
    const snippetLength = options.snippetLength ?? 180;
    const hits = page.map((e) => this.toHit(e.s, e.score, e.matches, snippetLength));

    return {
      hits,
      total: entries.length,
      offset,
      limit,
      warnings: parsed.warnings,
      facets: options.facets === false ? null : this.facets(entries.map((e) => e.s)),
      didYouMean: options.suggest === false ? null : this.didYouMean(parsed),
      took: nowMs() - t0,
    };
  }

  private toHit(s: Stored, score: number, matches: MatchInfo[], maxLen: number): SearchHit {
    const byField = new Map<string, Set<string>>();
    const terms = new Set<string>();
    for (const m of matches) {
      for (const term of Object.keys(m)) {
        terms.add(term);
        for (const f of m[term]!) {
          let set = byField.get(f);
          if (!set) byField.set(f, (set = new Set()));
          set.add(term);
        }
      }
    }
    const d = s.doc;
    const highlights: FieldHighlight[] = [];
    for (const field of ['quote', 'comment', 'title', 'headingContext'] as const) {
      const text = fieldText(d, field);
      if (text === '') continue;
      const spans = matchedSpans(text, byField.get(field) ?? new Set(), this.stop);
      if (field !== 'quote' && spans.length === 0) continue;
      highlights.push({ field, ...buildSnippet(text, spans, maxLen) });
    }
    const lists: Array<[SearchField, readonly string[]]> = [
      ['tags', d.tags],
      ['banks', d.banks],
      ['folderPath', d.folderPath],
      ['host', d.host ? [d.host] : []],
    ];
    for (const [field, list] of lists) {
      const set = byField.get(field);
      if (!set) continue;
      let shown = 0;
      for (let i = 0; i < list.length && shown < 5; i++) {
        const spans = matchedSpans(list[i]!, set, this.stop);
        if (spans.length === 0) continue;
        shown++;
        highlights.push({ field, index: i, ...buildSnippet(list[i]!, spans, maxLen) });
      }
    }
    return {
      id: d.id,
      score,
      doc: d,
      matchedFields: SEARCH_FIELDS.filter((f) => byField.has(f)),
      matchedTerms: [...terms],
      highlights,
    };
  }

  // --- related highlights (method and limits: related.ts) -----------------------------------

  related(id: string, options: RelatedOptions = {}): RelatedResult {
    const s = this.docs.get(id);
    if (!s) return { found: false, hits: [], total: 0, terms: [], took: 0 };
    const d = s.doc;
    return this.relatedFrom(contentFields(d), highlightOf(d) ?? d.id, sourceKeyOf(d), options);
  }

  relatedToText(text: string, options: RelatedOptions = {}): RelatedResult {
    return this.relatedFrom([['quote', text]], null, null, options);
  }

  /** Content terms of one highlight's documents (it and its notes), counted per document. */
  private ownTermCounts(group: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of [group, ...(this.notesOf.get(group) ?? [])]) {
      const s = this.docs.get(id);
      if (!s) continue;
      for (const term of relatedTerms(contentFields(s.doc), this.stop).keys()) {
        out.set(term, (out.get(term) ?? 0) + 1);
      }
    }
    return out;
  }

  private relatedFrom(
    fields: ReadonlyArray<readonly [SearchField, string]>,
    group: string | null,
    sourceKey: string | null,
    options: RelatedOptions,
  ): RelatedResult {
    const t0 = nowMs();
    const limit = clampInt(options.limit, RELATED_DEFAULT_LIMIT, RELATED_MAX_LIMIT);
    const maxTerms = clampInt(options.maxTerms, RELATED_DEFAULT_TERMS, RELATED_MAX_TERMS);
    const includeDeleted = options.includeDeleted === true;
    const sameSource = options.excludeSameSource === true && sourceKey !== null;

    // Terms are judged by the documents OTHER than the source's own highlight: its notes repeat its
    // quote, so counting them would make its rarest words look shared (and then match nothing).
    const own = group === null ? null : this.ownTermCounts(group);
    const vocab = vocabularyOf(this.core);
    const n = this.docs.size;
    const common = Math.max(COMMON_TERM_FLOOR, Math.ceil(n * COMMON_TERM_FRACTION));
    const ranked: Array<{ term: string; weight: number; shown: string; rank: number }> = [];
    for (const [term, w] of relatedTerms(fields, this.stop)) {
      const df = vocab ? docFreq(vocab, term) - (own?.get(term) ?? 0) : 1;
      if (df < 1 || df > common) continue; // held by no other document, or by far too many
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      ranked.push({ term, weight: w.weight, shown: w.shown, rank: w.weight * idf });
    }
    ranked.sort((a, b) => q6(b.rank) - q6(a.rank) || cmpStr(a.term, b.term));
    const used = ranked.slice(0, maxTerms);
    const terms = used.map((u) => u.shown);
    if (used.length === 0) return { found: true, hits: [], total: 0, terms, took: nowMs() - t0 };

    const boost = new Map(used.map((u) => [u.term, u.weight] as const));
    const order = new Map(used.map((u, i) => [u.term, i] as const));
    const shown = new Map(used.map((u) => [u.term, u.shown] as const));
    const found = this.core.search(used.map((u) => u.term).join(' '), {
      fields: [...RELATED_FIELDS],
      boost: FIELD_WEIGHTS as Record<string, number>,
      combineWith: 'OR',
      prefix: false,
      fuzzy: false,
      tokenize: (t) => t.split(' '),
      processTerm: (t) => t,
      boostTerm: (t) => boost.get(t) ?? 1,
      filter: (r) => {
        const d = this.docs.get(r.id as string)?.doc;
        if (!d || d.quote === '') return false; // a note whose highlight is gone cannot be opened
        const h = highlightOf(d);
        if (h === null || h === group) return false; // free-standing note, or the source's own
        if (!includeDeleted && d.deletedAt !== null) return false;
        return !(sameSource && sourceKeyOf(d) === sourceKey);
      },
    });

    const cands = found.map((r) => ({
      s: this.docs.get(r.id as string)!,
      k: q6(r.score),
      score: r.score,
      terms: r.terms as string[],
    }));
    // Best score first; on a tie the highlight leads its notes, then the newer, then the id.
    cands.sort(
      (a, b) =>
        b.k - a.k ||
        (a.s.doc.docType === b.s.doc.docType ? 0 : a.s.doc.docType === 'highlight' ? -1 : 1) ||
        cmpStr(b.s.doc.updatedAt, a.s.doc.updatedAt) ||
        cmpStr(a.s.doc.id, b.s.doc.id),
    );
    // One hit per highlight: the best-scoring of its documents stands for it (as in `collapseNotes`).
    const seen = new Set<string>();
    const hits: RelatedHit[] = [];
    for (const c of cands) {
      const h = highlightOf(c.s.doc)!;
      if (seen.has(h)) continue;
      seen.add(h);
      if (hits.length >= limit) continue;
      const shared = c.terms
        .filter((t) => order.has(t))
        .sort((a, b) => order.get(a)! - order.get(b)!)
        .map((t) => shown.get(t)!);
      hits.push({
        highlightId: h,
        doc: c.s.doc,
        score: c.score,
        sharedTerms: shared,
        explanation: explainShared(shared),
      });
    }
    return { found: true, hits, total: seen.size, terms, took: nowMs() - t0 };
  }

  private facets(stored: Stored[]): Facets {
    const make = (): Map<string, FacetValue> => new Map();
    const maps = { bank: make(), tag: make(), kind: make(), host: make(), status: make() };
    const bump = (
      m: Map<string, FacetValue>,
      keys: readonly string[],
      shown: readonly string[],
    ): void => {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (k === '' || keys.indexOf(k) !== i) continue; // count once per document
        const cur = m.get(k);
        if (cur) cur.count++;
        else m.set(k, { value: shown[i]!, count: 1 });
      }
    };
    for (const s of stored) {
      bump(maps.bank, s.bank, s.doc.banks);
      bump(maps.tag, s.tag, s.doc.tags);
      bump(maps.kind, [s.kind], [s.doc.kind]);
      bump(maps.host, [s.host], [s.doc.host ?? '']);
      bump(maps.status, [s.status], [s.doc.resolveStatus]);
    }
    const out = (m: Map<string, FacetValue>): FacetValue[] =>
      [...m.values()]
        .sort((a, b) => b.count - a.count || cmpStr(a.value, b.value))
        .slice(0, FACET_LIMIT);
    return {
      bank: out(maps.bank),
      tag: out(maps.tag),
      kind: out(maps.kind),
      host: out(maps.host),
      status: out(maps.status),
    };
  }

  private didYouMean(parsed: ParsedQuery): DidYouMean | null {
    const vocab = vocabularyOf(this.core);
    if (!vocab || !parsed.root) return null;
    const changes: Array<{ start: number; end: number; from: string; to: string }> = [];
    for (const { node, negated } of collectLeaves(parsed.root)) {
      if (node.type !== 'term' || negated) continue;
      const w = node.word;
      const t = w.whole;
      if (w.stop || w.parts.length !== 1 || t.length < 4 || /\d/.test(t)) continue;
      if (vocab.has(t) || vocab.atPrefix(t).keys().next().done === false) continue;
      let best: { term: string; dist: number; df: number } | null = null;
      for (const [term, [data, dist]] of vocab.fuzzyGet(t, t.length < 8 ? 1 : 2)) {
        if (dist === 0 || /\d/.test(term)) continue;
        let df = 0;
        if (data instanceof Map)
          for (const m of data.values()) df += (m as Map<unknown, unknown>).size;
        if (
          !best ||
          dist < best.dist ||
          (dist === best.dist && (df > best.df || (df === best.df && term < best.term)))
        ) {
          best = { term, dist, df };
        }
      }
      if (best) {
        changes.push({
          start: w.start,
          end: w.end,
          from: parsed.source.slice(w.start, w.end),
          to: best.term,
        });
      }
    }
    if (changes.length === 0) return null;
    let corrected = parsed.source;
    for (const c of [...changes].sort((a, b) => b.start - a.start)) {
      corrected = corrected.slice(0, c.start) + c.to + corrected.slice(c.end);
    }
    return { query: corrected, changes: changes.map(({ from, to }) => ({ from, to })) };
  }
}

// ---------------------------------------------------------------------------------------------

export function createSearchIndex(options: SearchIndexOptions = {}): SearchIndex {
  return new Index(options);
}

/**
 * Integrity tag over the payload (compact JSON of docs + index). It is recomputed from the parsed
 * values on load, so any altered character, truncated-then-repaired blob, or docs/index pair from
 * different saves is rejected before MiniSearch ever sees it.
 */
export function integrityChecksum(docs: unknown, index: unknown): string {
  return fnv1a(JSON.stringify(docs) + '|' + JSON.stringify(index));
}

/**
 * The same tag computed from the serialised text itself, without re-stringifying 15 MB of parsed JSON.
 * Relies on the layout `serialize()` writes: `..."docs":[...],"index":{...}}`. A `],"index":` that is not
 * the real boundary cannot occur inside a JSON string (its quotes would be escaped), so a mismatch here
 * only ever means "not our output" and falls back to a rebuild.
 */
function textChecksum(text: string): string | null {
  const start = text.indexOf('"docs":');
  const split = text.indexOf('],"index":', start);
  if (start < 0 || split < 0 || !text.endsWith('}')) return null;
  const docs = text.slice(start + 7, split + 1);
  const index = text.slice(split + 10, text.length - 1);
  return fnv1a(docs + '|' + index);
}

const EnvelopeSchema = z.object({
  format: z.string(),
  version: z.number(),
  analyzer: z.string(),
  checksum: z.string(),
  docs: z.array(z.unknown()),
  index: z.unknown(),
});

const PlainHeadSchema = z.object({
  documentCount: z.number().int().nonnegative(),
  nextId: z.number().int().nonnegative(),
  documentIds: z.record(z.string(), z.string()),
  fieldIds: z.record(z.string(), z.number().int()),
  fieldLength: z.record(z.string(), z.array(z.number())),
  storedFields: z.record(z.string(), z.unknown()),
  averageFieldLength: z.array(z.number()),
  dirtCount: z.number().int().nonnegative().optional(),
  serializationVersion: z.literal(2),
  index: z.array(z.unknown()),
});

/** Returns a description of the first structural problem, or null when MiniSearch can safely load it. */
function plainProblem(plain: unknown, docIds: ReadonlySet<string>): string | null {
  const head = PlainHeadSchema.safeParse(plain);
  if (!head.success) return `index header: ${head.error.issues[0]?.message ?? 'invalid'}`;
  const p = head.data;
  if (p.documentCount !== docIds.size) return 'index document count does not match documents';
  if (p.dirtCount) return 'index has un-vacuumed documents';
  const shortIds = Object.keys(p.documentIds);
  if (shortIds.length !== docIds.size) return 'index document ids do not match documents';
  for (const sid of shortIds) {
    if (!/^[0-9]+$/.test(sid)) return 'malformed document key';
    if (!docIds.has(p.documentIds[sid]!)) return 'index references an unknown document';
    const lens = p.fieldLength[sid];
    if (!lens || lens.length !== SEARCH_FIELDS.length) return 'missing field lengths';
  }
  for (const [i, f] of SEARCH_FIELDS.entries()) {
    if (p.fieldIds[f] !== i) return 'index field layout differs';
  }
  if (Object.keys(p.fieldIds).length !== SEARCH_FIELDS.length) return 'index field layout differs';
  const avgOk =
    docIds.size === 0
      ? p.averageFieldLength.length <= SEARCH_FIELDS.length
      : p.averageFieldLength.length === SEARCH_FIELDS.length;
  if (!avgOk) return 'index field layout differs';
  if (Object.keys(p.fieldLength).length !== shortIds.length)
    return 'field length for an unknown document';
  const fieldIdSet = new Set(Object.values(p.fieldIds).map(String));
  for (const entry of p.index) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      return 'malformed term entry';
    }
    const data = entry[1] as unknown;
    if (typeof data !== 'object' || data === null || Array.isArray(data))
      return 'malformed postings';
    for (const fid in data as Record<string, unknown>) {
      if (!fieldIdSet.has(fid)) return 'postings for an unknown field';
      const posting = (data as Record<string, unknown>)[fid];
      if (typeof posting !== 'object' || posting === null || Array.isArray(posting)) {
        return 'malformed postings';
      }
      for (const sid in posting as Record<string, unknown>) {
        const freq = (posting as Record<string, unknown>)[sid];
        if (!Object.hasOwn(p.documentIds, sid)) return 'postings for an unknown document';
        if (typeof freq !== 'number' || !(freq > 0) || !Number.isFinite(freq)) {
          return 'invalid term frequency';
        }
      }
    }
  }
  return null;
}

/**
 * Restore an index persisted by `serialize()`. Anything unexpected (bad JSON, other format/version,
 * changed analyzer, documents that disagree with the postings) returns `{ ok: false }`: the caller
 * rebuilds from the vault. Never throws.
 */
export function deserializeSearchIndex(
  input: unknown,
  options: SearchIndexOptions = {},
): LoadResult {
  const fail = (reason: LoadFailure, detail: string): LoadResult => ({ ok: false, reason, detail });
  try {
    const data: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    const env = EnvelopeSchema.safeParse(data);
    if (!env.success) return fail('corrupt', 'not a search index envelope');
    if (env.data.format !== FORMAT) return fail('corrupt', 'unknown format');
    if (env.data.version !== FORMAT_VERSION) return fail('version', `version ${env.data.version}`);
    const probe = new Index(options);
    if (env.data.analyzer !== probe.analyzerKey) return fail('analyzer', env.data.analyzer);
    const expected =
      typeof input === 'string'
        ? textChecksum(input)
        : integrityChecksum(env.data.docs, env.data.index);
    if (expected === null || env.data.checksum !== expected) {
      return fail('corrupt', 'checksum mismatch');
    }

    const docs: SearchDocument[] = [];
    const ids = new Set<string>();
    for (const raw of env.data.docs) {
      const d = SearchDocumentSchema.safeParse(raw);
      if (!d.success) return fail('corrupt', 'invalid document');
      if (ids.has(d.data.id)) return fail('corrupt', 'duplicate document id');
      ids.add(d.data.id);
      docs.push(d.data);
    }
    const problem = plainProblem(env.data.index, ids);
    if (problem) return fail('corrupt', problem);

    const stop = stopSet(options.stopWords);
    const core = MiniSearch.loadJS<SearchDocument>(
      env.data.index as AsPlainObject,
      coreOptions(stop),
    );
    const index = new Index(options, core);
    for (const d of docs) index.adopt(d);
    return { ok: true, index };
  } catch (error) {
    return fail('corrupt', error instanceof Error ? error.message : 'unreadable');
  }
}
