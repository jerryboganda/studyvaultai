// Phase 1 contract (RepoApi)
export {
  saveCapture,
  getPageHighlights,
  updateHighlight,
  softDeleteHighlight,
  restoreHighlight,
  reportResolutions,
  getHighlightSource,
  listBanks,
  createBank,
  listRecentHighlights,
  listPageHighlights,
  listBanksWithCounts,
  wipeAllData,
  getWipeState,
  repo,
  type WipeOptions,
  type WipeState,
} from './repo';
export { observe, type Observable } from './observe';
export { normalizeQuote, quoteHash } from './normalize';
export {
  closeDb,
  resetDbForTests,
  getDb,
  withDb,
  withWritableDb,
  toStorageError,
  onBeforeMigrate,
  WipePendingError,
  DB_NAME,
  DB_VERSION,
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  type StudyVaultDb,
  type MigrationContext,
  type MigrationHook,
  type MetaRow,
  type ForeignRow,
} from './db';
/** For other modules repositories: call after a committed write so every viewer refreshes. */
export { signalChange as notifyDataChanged } from './core';

// Phase 2 vault (VaultApi)
export { vault } from './api';
export { addToBank, removeFromBank, moveHighlight } from './membership';
export {
  createFolder,
  renameFolder,
  moveFolder,
  reorderFolders,
  deleteFolder,
  mergeFolders,
  listFolderTree,
  listBankInfos,
  renameBank,
  reorderBanks,
  mergeBanks,
  deleteBank,
  setBankColor,
  setBankIcon,
} from './hierarchy';
export {
  createTag,
  renameTag,
  setTagColor,
  addAlias,
  removeAlias,
  mergeTags,
  deleteTag,
  attachTags,
  detachTags,
  listTags,
} from './tags';
export {
  createNote,
  updateNote,
  deleteNote,
  listNotes,
  setCustomFields,
  clearCustomField,
} from './notes';
export {
  bulkMove,
  bulkTag,
  bulkDelete,
  bulkRestore,
  bulkSetKind,
  bulkSetColor,
  bulkSetPriority,
} from './bulk';
export { listTrash, restore, purge, emptyTrash, purgeOlderThan, getLastPurgeAt } from './trash';
export {
  listHighlights,
  countHighlights,
  getCounts,
  getHighlightDetail,
  findDuplicateClusters,
} from './query';
export { listSearchDocuments, listSearchDocumentsChangedSince } from './search';
export {
  upsertDocument,
  getDocument,
  listDocuments,
  deleteDocument,
  savePdfHighlight,
  listPdfHighlights,
  cacheDocumentBytes,
  getDocumentBytes,
  removeDocumentBytes,
  saveOcrPage,
  replaceOcrPage,
  swapOcrReading,
  getOcrPages,
  clearOcr,
  setPdfWriteRestriction,
  assertPdfWriteAllowed,
  MAX_CACHED_PDF_BYTES,
} from './pdf';
export { getStorageUsage } from './usage';
export {
  getTableRegistry,
  tableRegistry,
  registerTableSchema,
  unregisteredTables,
  relationKey,
  checkIntegrity,
  type IntegrityIssue,
  type IntegrityIssueCode,
  type IntegrityReport,
} from './registry';
export type {
  Bank,
  BankInfo,
  BankWithCount,
  BulkResult,
  CachedDocumentInfo,
  DashboardItem,
  DocumentListItem,
  DuplicateCluster,
  DuplicateMember,
  FolderNode,
  FolderRef,
  HighlightDetail,
  HighlightListItem,
  HighlightPage,
  HighlightQuery,
  HighlightSortField,
  Location,
  PurgeResult,
  RepoApi,
  SaveOcrPageInput,
  SearchFeedOptions,
  StorageUsage,
  TagLite,
  TagWithCount,
  TrashItem,
  TrashKind,
  TrashRef,
  VaultApi,
  VaultCounts,
} from './types';

// Organisation records (schema v4, ADR-011): auto-filing rules, syllabi, relations
export type { SaveOutcome } from './organisation';
export {
  checkFilingRules,
  createFilingRule,
  deleteFilingRule,
  getFilingRule,
  listApplicableFilingRules,
  listFilingRules,
  purgeFilingRules,
  reorderFilingRules,
  restoreFilingRule,
  updateFilingRule,
  type FilingRuleInput,
  type FilingRulePatch,
  type FilingRuleProblem,
} from './rules';
// Applying rules to a new highlight: suggestion, auto-filing and undo (ADR-017)
export {
  FILING_PLAN_BUDGET_MS,
  acceptFiling,
  dismissFiling,
  filingAfterCapture,
  listFilingSuggestions,
  undoFiling,
  type FilingCapture,
  type FilingSessionPort,
} from './filing';
export {
  checkSyllabi,
  createSyllabus,
  deleteSyllabus,
  getSyllabus,
  listSyllabi,
  purgeSyllabi,
  restoreSyllabus,
  updateSyllabus,
  type SyllabusNodeInput,
  type SyllabusProblem,
} from './syllabi';
export {
  createRelation,
  deleteRelation,
  getRelation,
  listAllRelations,
  listRelationsFor,
  pruneDanglingRelations,
  purgeRelations,
  restoreRelation,
  updateRelationNote,
  type CreateRelationStatus,
  type RelationInput,
  type RelationRef,
} from './relations';
// The links screens (ADR-018): the other end of a link as text, and the set a graph draws
export {
  GRAPH_MAX_RELATIONS,
  describeEnds,
  findKnowledgePoints,
  listLinks,
  loadGraph,
  type LinkEnd,
  type LinkEntry,
} from './graph';

// Backup / restore (Dexie side of @backup's ports) and external highlight import
export * from './backupTarget';
// The folder the person picked for dated backups (handle and state in `meta`; ADR-016)
export * from './backupFolder';

// Optional AI features: results, cache port, settings, key and usage ledger (one line; see ai.ts)
export * from './ai';
export * from './chat';

// Retention: decks, knowledge points, cards, reviews, queue, session (one line; see study.ts)
export * from './study';

// Game layer (ADR-022): XP ledger state, backfill, daily goal, Game mode, celebrations (see game.ts).
// The session bonus is `completeStudySession` in study.ts.
export {
  GAME_BACKFILL_LOCK,
  claimCelebrations,
  getGameState,
  isGameModeOn,
  runGameBackfill,
  saveGameCache,
  setDailyGoal,
  setGameMode,
  type BackfillView,
  type GameBackfillOptions,
  type GameBackfillResult,
  type GameCacheUpdate,
  type GameState,
} from './game';

// Optional sync: Dexie outbox, state store, applier, write capture and reconcile (one statement; see sync.ts)
export {
  activeSyncPolicy,
  countSyncAttention,
  createDexieApplier,
  createDexieOpLog,
  createDexieStateStore,
  createSyncRuntime,
  ensureClientId,
  listSyncConflicts,
  listSyncQuarantine,
  resetSyncIdentity,
  startSyncCapture,
  stopSyncCapture,
  suppressSyncCapture,
  SyncPolicyDriftError,
  type ActiveSyncPolicy,
  type ReconcileResult,
  type SyncOpRow,
  type SyncRuntime,
  type SyncRuntimeOptions,
} from './sync';

// Privileged sync configuration and the authoritative settings copy, in `meta` (see syncPrivate.ts).
// Importing this module also registers the authoritative settings store with @runtime.
export { readSyncPrivate, writeSyncPrivate, type SyncPrivateKey } from './syncPrivate';
