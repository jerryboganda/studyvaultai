/**
 * Every way a backup operation can fail, as a stable string. Restore failures that happen before the
 * commit step never touch live data (see restore.ts); the code tells the UI which message to show.
 */
export const BACKUP_ERROR_CODES = [
  'aborted',
  'invalid_options',
  'crypto_unavailable',
  'source_error',
  'limit_exceeded',
  // archive container / manifest
  'not_a_backup',
  'corrupt_archive',
  'manifest_invalid',
  'manifest_checksum_mismatch',
  'future_format_version',
  'future_schema_version',
  'migration_missing',
  // encryption
  'passphrase_required',
  'wrong_passphrase',
  'encrypted_payload_corrupt',
  // tables
  'table_truncated',
  'table_corrupt',
  'row_count_mismatch',
  'table_checksum_mismatch',
  'blob_corrupt',
  // content
  'row_invalid',
  'import_invalid',
  'integrity_violation',
  // commit
  'restore_in_progress',
  'safety_backup_failed',
  'staging_failed',
  'commit_failed',
  // backup folder (File System Access): nothing in the vault changes in any of these
  'folder_permission',
  'folder_missing',
  'disk_full',
  'folder_write_failed',
  'folder_verify_failed',
] as const;

export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  /** Structured context for the UI (table name, counts, a capped issue list ...). Never secrets. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: BackupErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BackupError';
    this.code = code;
    this.details = details;
  }
}

export function isBackupError(e: unknown): e is BackupError {
  return e instanceof BackupError;
}

/** Throws `aborted` when the caller's signal fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BackupError('aborted', 'The operation was cancelled.');
}
