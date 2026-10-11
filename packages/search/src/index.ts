export { SearchDocumentSchema, SEARCH_FIELDS, FIELD_WEIGHTS } from './schema';
export type { SearchDocument, SearchField } from './schema';

export { createSearchIndex, deserializeSearchIndex } from './searchIndex';
export type {
  ApplyAsyncOptions,
  ApplyResult,
  DidYouMean,
  Facets,
  FacetValue,
  FieldHighlight,
  IndexStats,
  LoadFailure,
  LoadResult,
  SearchHit,
  SearchIndex,
  SearchIndexOptions,
  SearchOptions,
  SearchResult,
  SortMode,
  UpsertResult,
  UpsertStatus,
} from './searchIndex';

export { parseQuery, QUERY_SYNTAX, MAX_QUERY_LENGTH, MAX_QUERY_TERMS } from './query';
export type {
  Comparator,
  FilterKey,
  ParsedQuery,
  QueryNode,
  QueryWarning,
  WarningCode,
} from './query';

export { buildSnippet, matchedSpans } from './snippets';
export type { Segment, Snippet, Span } from './snippets';

export {
  analyzeWords,
  foldText,
  indexTerms,
  ANALYZER_VERSION,
  DEFAULT_STOP_WORDS,
} from './analyzer';
export type { Word } from './analyzer';

export {
  SavedSearchSchema,
  createSavedSearch,
  deserializeSavedSearches,
  parseSavedSearch,
  serializeSavedSearches,
} from './savedSearch';
export type {
  LoadedSavedSearches,
  NewSavedSearch,
  SavedSearch,
  SavedSearchResult,
} from './savedSearch';
