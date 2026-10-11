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
  DEFAULT_IMMUTABLE_FIELDS,
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
export { buildMigrationChain, migrateRow } from './migrate';
export { canonicalJson } from './canonical';
export { decide, type MergeDecision, type RowMeta } from './merge';

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
  importCsvHighlights,
  importMarkdownHighlights,
  type ImportLimits,
  type ImportOptions,
  type ImportRejection,
  type ImportRowSet,
  type ImportedHighlight,
} from './importExternal';

/** Zip a set of export files (e.g. Markdown per bank) into one archive. */
export { zipFiles } from './zipFiles';
