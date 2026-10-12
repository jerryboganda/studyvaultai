/**
 * @backup: lossless export/import, versioned backups, restore with integrity checks, and format
 * integrations (Markdown, CSV, Anki). Pure: talks to data only through the ports in types.ts.
 */
export * from './errors';
export type * from './types';

export {
  exportBackup,
  exportJson,
  selectTables,
  type ExportJsonOptions,
  type ExportOptions,
  type ExportResult,
} from './export';
export {
  inspectBackup,
  prepareRestore,
  restoreBackup,
  type Capped,
  type ConflictInfo,
  type InvalidRowInfo,
  type OrphanInfo,
  type OverwriteInfo,
  type PreparedRestore,
  type RestoreOptions,
  type RestoreReport,
  type RestoreResult,
  type TableReport,
} from './restore';
export {
  APP_NAME,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_JSON_FORMAT,
  DEFAULT_RESTORE_LIMITS,
  Manifest,
  type RestoreLimits,
} from './format';
export { DEFAULT_KDF_ITERATIONS, isEncryptedContainer, type Subtle } from './crypto';
// Backups written into a folder the person chose (File System Access port)
export {
  FOLDER_ORIGIN,
  ensureFolderPermission,
  folderError,
  hasFolderMarker,
  isFolderBackupName,
  writeFolderBackup,
  type FolderDirectory,
  type FolderEntry,
  type FolderFileHandle,
  type FolderPermissionState,
  type FolderWritable,
  type FolderWriteResult,
} from './folder';
export { buildMigrationChain, migrateRow } from './migrate';
export { canonicalJson } from './canonical';
export { ALL_FIELDS, decide, type MergeDecision, type RowMeta } from './merge';

// Human-readable exports (pure functions over plain row arrays)
export { buildHighlightViews, type ExportDataset, type HighlightView } from './views';
export {
  escapeMarkdown,
  exportMarkdown,
  markdownTag,
  type ExportFile,
  type MarkdownOptions,
} from './markdown';
export {
  HIGHLIGHT_CSV_COLUMNS,
  csvCell,
  exportHighlightsCsv,
  exportHighlightsJson,
  parseCsv,
  toCsv,
  type CsvOptions,
} from './csv';
export {
  exportAnki,
  toAnkiCloze,
  type AnkiColumn,
  type AnkiExport,
  type AnkiOptions,
} from './anki';
export { safeFilename, uniquePaths } from './filenames';
export { normalizeQuote, quoteHash, safeHttpUrl } from './text';

// Import of external (untrusted) formats
export {
  DEFAULT_IMPORT_LIMITS,
  MAX_DOCUMENT_BYTES,
  importCsvHighlights,
  importMarkdownHighlights,
  looksLikeAnkiText,
  type ImportFormat,
  type ImportLimits,
  type ImportOptions,
  type ImportRejection,
  type ImportRowSet,
  type ImportedHighlight,
} from './importExternal';
// DOCX, PPTX, EPUB, HTML and Anki text: the implementation (`@backup/importDocs`) is loaded with
// import() by the import screen so it stays out of the page's first chunk; only types are here.
export type { DocumentFile, DocumentImportOptions, DocumentLimits } from './importDocs';

/** Zip a set of export files (e.g. Markdown per bank) into one archive. */
export { zipFiles } from './zipFiles';
