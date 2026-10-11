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
  repo,
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
  StorageUsage,
  TagLite,
  TagWithCount,
  TrashItem,
  TrashKind,
  TrashRef,
  VaultApi,
  VaultCounts,
} from './types';
