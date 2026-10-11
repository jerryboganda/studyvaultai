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

// Backup / restore (Dexie side of @backup's ports) and external highlight import
export * from './backupTarget';

// Optional AI features: results, cache port, settings, key and usage ledger (one line; see ai.ts)
export * from './ai';

// Retention: decks, knowledge points, cards, reviews, queue, session (one line; see study.ts)
export * from './study';

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
