import {
  BackupError,
  FOLDER_ORIGIN,
  ensureFolderPermission,
  exportBackup,
  folderError,
  importCsvHighlights,
  importMarkdownHighlights,
  inspectBackup,
  looksLikeAnkiText,
  prepareRestore,
  writeFolderBackup,
  type ExportDataset,
  type ExportProgress,
  type ExportResult,
  type FolderDirectory,
  type FolderWriteResult,
  type ImportRowSet,
  type Manifest,
  type PreparedRestore,
  type RestoreProgress,
} from '@backup';
import { getSettings } from '@runtime';
import {
  BACKUP_MIGRATIONS,
  checkIntegrity,
  clearBackupFolder,
  clearCustomField,
  createBackupTarget,
  createSnapshotSource,
  deletePreMigrationSnapshot,
  getBackupFolder,
  getBackupFolderState,
  getPreMigrationInfo,
  getStorageUsage,
  importExternalHighlights,
  listBanksWithCounts,
  listImportedNeedingReview,
  listLiveQuoteHashes,
  loadExportDataset,
  readPreMigrationSnapshot,
  recordFolderBackup,
  setBackupFolder,
  undoExternalImport,
  updateBackupFolderPrefs,
  type BackupFolderPrefs,
  type BackupFolderState,
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
  /** Marks the file as one the backup-folder feature wrote (what lets it prune its own files). */
  origin?: 'backup-folder';
}

export interface FolderBackupRequest {
  includeCachedPdfs: boolean;
  passphrase?: string;
  signal?: AbortSignal;
  onProgress?(p: ExportProgress): void;
}

export interface FolderBackupOutcome {
  /** The folder's state with this backup recorded as the last one. */
  state: BackupFolderState;
  file: FolderWriteResult;
  sha256: string;
  encrypted: boolean;
  manifest: Manifest;
}

/** The backup folder (ADR-016): a folder the person picked, written only from a click. */
export interface FolderDeps {
  /** False where the browser has no folder picker: the screen explains and offers the download. */
  supported(): boolean;
  load(): Promise<BackupFolderState | null>;
  /** Opens the browser's folder picker (call from a click). null: the person closed it. */
  choose(): Promise<BackupFolderState | null>;
  /** Forget the folder and its state; files already in it stay. */
  forget(): Promise<void>;
  setPrefs(prefs: BackupFolderPrefs): Promise<BackupFolderState>;
  /**
   * Export, write into the folder, read the file back, prune. Call it from the click: Chrome only
   * lets a page write to the folder (or ask again after a restart) while it handles a gesture.
   */
  backupNow(request: FolderBackupRequest): Promise<FolderBackupOutcome>;
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

  /** Markdown, CSV, or (recognised by its header lines) an Anki plain-text export. */
  parseExternal(kind: 'markdown' | 'csv', text: string, fileName?: string): Promise<ImportRowSet>;
  /** DOCX, PPTX, EPUB, HTML (and refusals with a reason for .apkg, .doc, .ppt). Docs ADR-014. */
  parseDocument(name: string, bytes: Uint8Array): Promise<ImportRowSet>;
  importExternal(
    rowSet: Pick<ImportRowSet, 'highlights'>,
    options: { bankId: string | null },
  ): Promise<ImportExternalResult>;
  /** Undo one import: its highlights go to the Trash (the person can restore them from there). */
  undoImport(batchId: string): Promise<{ removed: number }>;
  listNeedsReview(): Promise<{ total: number; items: NeedsReviewItem[] }>;
  markReviewed(highlightId: string): Promise<void>;

  preMigration: {
    info(): Promise<PreMigrationInfo | null>;
    read(): Promise<{ info: PreMigrationInfo; bytes: Uint8Array } | null>;
    remove(): Promise<void>;
  };

  folder: FolderDeps;
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

/** `window.showDirectoryPicker` (File System Access): not in the TypeScript DOM library. */
type DirectoryPicker = (options: {
  id?: string;
  mode?: 'read' | 'readwrite';
}) => Promise<FolderDirectory>;
const pickerOf = (): DirectoryPicker | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

function createFolderDeps(exportFull: BackupDeps['exportFull']): FolderDeps {
  return {
    supported: () => typeof pickerOf() === 'function',
    load: () => getBackupFolderState(),

    async choose() {
      const pick = pickerOf();
      if (!pick) return null;
      let dir: FolderDirectory;
      try {
        dir = await pick.call(window, { id: 'studyvault-backups', mode: 'readwrite' });
      } catch (err) {
        if ((err as { name?: unknown } | null)?.name === 'AbortError') return null; // closed the picker
        throw folderError(err);
      }
      return setBackupFolder(dir, dir.name);
    },

    forget: () => clearBackupFolder(),
    setPrefs: (prefs) => updateBackupFolderPrefs(prefs),

    async backupNow({ includeCachedPdfs, passphrase, signal, onProgress }) {
      const stored = await getBackupFolder();
      const dir = stored?.handle as FolderDirectory | undefined;
      if (!stored || !dir || typeof dir.getFileHandle !== 'function') {
        throw new BackupError('folder_missing', 'No backup folder is chosen.');
      }
      // First, while the click's user activation is alive: Chrome asks again here after a restart.
      await ensureFolderPermission(dir);
      const result = await exportFull({
        includeCachedPdfs,
        origin: FOLDER_ORIGIN,
        ...(passphrase ? { passphrase } : {}),
        ...(signal ? { signal } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
      const file = await writeFolderBackup(dir, result, { keepLast: stored.state.keepLast });
      const sha256 = await sha256Hex(result.bytes);
      const state = await recordFolderBackup({
        at: result.manifest.createdAt,
        fileName: file.fileName,
        bytes: file.bytes,
        sha256,
        encrypted: result.encrypted,
        pruned: file.pruned.length,
      });
      return { state, file, sha256, encrypted: result.encrypted, manifest: result.manifest };
    },
  };
}

export function createBackupDeps(appVersion: string): BackupDeps {
  const exportFull: BackupDeps['exportFull'] = async ({
    includeCachedPdfs,
    passphrase,
    signal,
    onProgress,
    origin,
  }) => {
    const source = await createSnapshotSource();
    return exportBackup(source, {
      appVersion,
      // cached PDFs are paged straight from disk: keep the pages small
      ...(includeCachedPdfs ? { includeLocalOnlyTables: ['attachments'], batchSize: 20 } : {}),
      ...(passphrase ? { passphrase } : {}),
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
      ...(origin ? { origin } : {}),
    });
  };
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
    exportFull,
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

    async parseExternal(kind, text, fileName) {
      const existingQuoteHashes = await listLiveQuoteHashes();
      if (looksLikeAnkiText(text)) {
        // loaded on first use: the document readers are not part of the page's first chunk
        const { importAnkiHighlights } = await import('@backup/importDocs');
        return importAnkiHighlights(text, {
          existingQuoteHashes,
          ...(fileName ? { name: fileName } : {}),
        });
      }
      return kind === 'csv'
        ? importCsvHighlights(text, { existingQuoteHashes })
        : importMarkdownHighlights(text, { existingQuoteHashes });
    },
    async parseDocument(name, bytes) {
      const existingQuoteHashes = await listLiveQuoteHashes();
      const { importDocument } = await import('@backup/importDocs');
      return importDocument({ name, bytes }, { existingQuoteHashes });
    },
    importExternal: (rowSet, options) => importExternalHighlights(rowSet, options),
    undoImport: (batchId) => undoExternalImport(batchId),
    listNeedsReview: () => listImportedNeedingReview(),
    async markReviewed(id) {
      await clearCustomField(id, 'needsReview');
    },

    preMigration: {
      info: () => getPreMigrationInfo(),
      read: () => readPreMigrationSnapshot(),
      remove: () => deletePreMigrationSnapshot(),
    },

    folder: createFolderDeps(exportFull),
  };
}
