import {
  exportBackup,
  importCsvHighlights,
  importMarkdownHighlights,
  inspectBackup,
  prepareRestore,
  type ExportDataset,
  type ExportProgress,
  type ExportResult,
  type ImportRowSet,
  type Manifest,
  type PreparedRestore,
  type RestoreProgress,
} from '@backup';
import { getSettings } from '@runtime';
import {
  BACKUP_MIGRATIONS,
  checkIntegrity,
  clearCustomField,
  createBackupTarget,
  createSnapshotSource,
  deletePreMigrationSnapshot,
  getPreMigrationInfo,
  getStorageUsage,
  importExternalHighlights,
  listBanksWithCounts,
  listImportedNeedingReview,
  listLiveQuoteHashes,
  loadExportDataset,
  readPreMigrationSnapshot,
  type ImportExternalResult,
  type IntegrityReport,
  type NeedsReviewItem,
  type PreMigrationInfo,
} from '@storage';

/**
 * Everything the backup screens do to the outside world, in one object, so a screen can be tested
 * with plain functions and so the real wiring is in one reviewable place.
 */

export interface DownloadFile {
  /** Already a safe file name. */
  name: string;
  data: Uint8Array | string;
  mime: string;
}

export interface FullExportRequest {
  includeCachedPdfs: boolean;
  passphrase?: string;
  signal?: AbortSignal;
  onProgress?(p: ExportProgress): void;
}

export interface PrepareRequest {
  mode: 'merge' | 'replace';
  passphrase?: string;
  /** What to do with rows that fail validation / point at nothing. */
  invalidRows: 'abort' | 'skip';
  orphans: 'abort' | 'skip';
  signal?: AbortSignal;
  onProgress?(p: RestoreProgress): void;
  /** When set, the current data is exported and handed to `sink` before anything is replaced. */
  safetyBackup?: {
    passphrase?: string;
    includeCachedPdfs: boolean;
    sink(file: ExportResult): Promise<void>;
  };
}

export interface BankChoice {
  id: string;
  name: string;
  count: number;
}

export interface BackupDeps {
  /** Written into backups so a later restore can tell which build made them. */
  appVersion: string;
  now(): Date;
  /** Hand a file to the user (Blob URL + <a download>). */
  download(file: DownloadFile): void;
  readBytes(file: Blob): Promise<Uint8Array>;
  readText(file: Blob): Promise<string>;
  sha256(bytes: Uint8Array): Promise<string>;

  listBanks(): Promise<BankChoice[]>;
  cachedPdfs(): Promise<{ count: number; bytes: number }>;
  exportFull(request: FullExportRequest): Promise<ExportResult>;
  loadDataset(bankIds?: readonly string[]): Promise<ExportDataset>;

  inspect(
    bytes: Uint8Array,
    passphrase?: string,
  ): Promise<{ encrypted: boolean; manifest: Manifest | null }>;
  prepare(bytes: Uint8Array, request: PrepareRequest): Promise<PreparedRestore>;
  integrity(): Promise<IntegrityReport>;
  /**
   * Whether optional sync is switched on, so the restore screen can say what a restore does to the
   * account (see `SYNC_RESTORE_NOTE`). Absent: treated as off.
   */
  syncActive?(): Promise<boolean>;

  parseExternal(kind: 'markdown' | 'csv', text: string): Promise<ImportRowSet>;
  importExternal(
    rowSet: Pick<ImportRowSet, 'highlights'>,
    options: { bankId: string | null },
  ): Promise<ImportExternalResult>;
  listNeedsReview(): Promise<{ total: number; items: NeedsReviewItem[] }>;
  markReviewed(highlightId: string): Promise<void>;

  preMigration: {
    info(): Promise<PreMigrationInfo | null>;
    read(): Promise<{ info: PreMigrationInfo; bytes: Uint8Array } | null>;
    remove(): Promise<void>;
  };
}

/** Blob URL + <a download>: the only way an extension page can write a file without `downloads`. */
export function saveFile({ name, data, mime }: DownloadFile): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // the browser needs the URL until the download has started; a minute is far more than enough
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createBackupDeps(appVersion: string): BackupDeps {
  return {
    appVersion,
    now: () => new Date(),
    download: saveFile,
    readBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
    readText: (file) => file.text(),
    sha256: sha256Hex,

    async listBanks() {
      return (await listBanksWithCounts()).map((b) => ({
        id: b.bank.id,
        name: b.bank.name,
        count: b.count,
      }));
    },
    async cachedPdfs() {
      const usage = await getStorageUsage();
      return { count: usage.cachedPdfCount, bytes: usage.cachedPdfBytes };
    },
    async exportFull({ includeCachedPdfs, passphrase, signal, onProgress }) {
      const source = await createSnapshotSource();
      return exportBackup(source, {
        appVersion,
        // cached PDFs are paged straight from disk: keep the pages small
        ...(includeCachedPdfs ? { includeLocalOnlyTables: ['attachments'], batchSize: 20 } : {}),
        ...(passphrase ? { passphrase } : {}),
        ...(signal ? { signal } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
    },
    loadDataset: (bankIds) => loadExportDataset(bankIds ? { bankIds } : {}),

    inspect: (bytes, passphrase) => inspectBackup(bytes, passphrase ? { passphrase } : {}),
    prepare(bytes, request) {
      const safety = request.safetyBackup;
      return prepareRestore(bytes, {
        target: createBackupTarget(),
        mode: request.mode,
        migrations: BACKUP_MIGRATIONS,
        invalidRows: request.invalidRows,
        orphans: request.orphans,
        ...(request.passphrase ? { passphrase: request.passphrase } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        ...(safety
          ? {
              preRestoreBackup: {
                sink: safety.sink,
                options: {
                  appVersion,
                  ...(safety.passphrase ? { passphrase: safety.passphrase } : {}),
                  ...(safety.includeCachedPdfs ? { includeLocalOnlyTables: ['attachments'] } : {}),
                },
              },
            }
          : {}),
      });
    },
    integrity: () => checkIntegrity(),
    syncActive: async () => (await getSettings()).features.sync,

    async parseExternal(kind, text) {
      const existingQuoteHashes = await listLiveQuoteHashes();
      return kind === 'csv'
        ? importCsvHighlights(text, { existingQuoteHashes })
        : importMarkdownHighlights(text, { existingQuoteHashes });
    },
    importExternal: (rowSet, options) => importExternalHighlights(rowSet, options),
    listNeedsReview: () => listImportedNeedingReview(),
    async markReviewed(id) {
      await clearCustomField(id, 'needsReview');
    },

    preMigration: {
      info: () => getPreMigrationInfo(),
      read: () => readPreMigrationSnapshot(),
      remove: () => deletePreMigrationSnapshot(),
    },
  };
}
