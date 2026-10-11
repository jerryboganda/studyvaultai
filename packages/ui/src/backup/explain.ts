import { isBackupError, type BackupErrorCode, type InvalidRowInfo } from '@backup';
import { StudyVaultError } from '@shared';
import { tableLabel } from './format';

/**
 * Typed backup errors, mapped to what a person needs to hear: what happened, whether anything was
 * changed, and what they can do next. Codes come from @backup/errors.ts; messages from the engine
 * are English sentences meant for people, but they are only the fallback here.
 */

export type ErrorAction = 'enter_passphrase' | 'skip_invalid' | 'skip_orphans';

export interface ErrorExplanation {
  /** Stable machine code (for tests and bug reports). */
  code: string;
  title: string;
  body: string;
  /** Capped list of specifics (invalid rows, orphans ...). */
  lines: string[];
  /** A way forward the wizard can offer as a button. */
  action?: ErrorAction;
  /** Doing the same thing again may help. */
  retryable: boolean;
}

const UNCHANGED = 'Your StudyVault data was not changed.';

/** Shown on the restore screen while sync is on: what replacing the vault does to the account. */
export const SYNC_RESTORE_NOTE =
  'Sync is on. Replacing your data changes this device only: nothing is deleted from your sync account, so items that are not in the backup can come back on the next sync, and the restored items are sent to the account again.';

type Entry = Pick<ErrorExplanation, 'title' | 'body'> & { retryable?: boolean };

const BY_CODE: Record<BackupErrorCode, Entry> = {
  aborted: { title: 'Cancelled', body: `You cancelled. ${UNCHANGED}`, retryable: true },
  invalid_options: {
    title: 'That combination of options is not supported',
    body: `Change the options and try again. ${UNCHANGED}`,
  },
  crypto_unavailable: {
    title: 'Encryption is not available here',
    body: `This browser context does not provide the Web Crypto features needed for encrypted backups. ${UNCHANGED}`,
    retryable: false,
  },
  source_error: {
    title: 'StudyVault could not read your data',
    body: `Reading the local database failed part-way. ${UNCHANGED} Close other StudyVault tabs and try again.`,
    retryable: true,
  },
  limit_exceeded: {
    title: 'This file is larger than StudyVault will process',
    body: `The file, or what it expands to, is over the safety limit that protects your browser from damaged or malicious files. ${UNCHANGED}`,
    retryable: false,
  },
  not_a_backup: {
    title: 'This is not a StudyVault backup',
    body: `The file does not have the structure of a StudyVault backup. If it is a Markdown or CSV file of highlights, use "Import highlights from a Markdown or CSV file" instead. ${UNCHANGED}`,
    retryable: false,
  },
  corrupt_archive: {
    title: 'The backup file is damaged',
    body: `The file is incomplete or was changed after it was made, so it cannot be trusted. Try the original file or an older backup. ${UNCHANGED}`,
    retryable: false,
  },
  manifest_invalid: {
    title: 'The backup file is damaged',
    body: `The description at the start of the backup is malformed. ${UNCHANGED}`,
    retryable: false,
  },
  manifest_checksum_mismatch: {
    title: 'The backup was modified or damaged',
    body: `Its checksum does not match, which means something changed the file after StudyVault wrote it. ${UNCHANGED}`,
    retryable: false,
  },
  future_format_version: {
    title: 'This backup was made by a newer StudyVault',
    body: `The file format is newer than this version understands. Update the extension, then try again. ${UNCHANGED}`,
    retryable: false,
  },
  future_schema_version: {
    title: 'This backup comes from a newer version of your data',
    body: `It was made by a newer StudyVault and its data layout is not known here. Update the extension first. ${UNCHANGED}`,
    retryable: false,
  },
  migration_missing: {
    title: 'This backup is too old to upgrade',
    body: `This version has no upgrade path for the data version in the file. ${UNCHANGED}`,
    retryable: false,
  },
  passphrase_required: {
    title: 'This backup is encrypted',
    body: 'Enter the passphrase it was protected with.',
  },
  wrong_passphrase: {
    title: 'That passphrase did not open the backup',
    body: `Check for typing mistakes and capitals. There is no way to open an encrypted backup without its passphrase. ${UNCHANGED}`,
    retryable: true,
  },
  encrypted_payload_corrupt: {
    title: 'The encrypted backup is damaged',
    body: `The passphrase may be right, but the file was cut short or altered. ${UNCHANGED}`,
    retryable: false,
  },
  table_truncated: {
    title: 'The backup is incomplete',
    body: `Part of the file is missing (it may have been cut off during a download or copy). ${UNCHANGED}`,
    retryable: false,
  },
  table_corrupt: {
    title: 'The backup contains unreadable data',
    body: `A section of the file is not valid. ${UNCHANGED}`,
    retryable: false,
  },
  row_count_mismatch: {
    title: 'The backup does not match its own summary',
    body: `A section holds a different number of items than the file says it should. ${UNCHANGED}`,
    retryable: false,
  },
  table_checksum_mismatch: {
    title: 'The backup was modified or damaged',
    body: `A section fails its checksum, so its content is not what StudyVault wrote. ${UNCHANGED}`,
    retryable: false,
  },
  blob_corrupt: {
    title: 'An attached PDF in the backup is damaged',
    body: `A cached PDF fails its checksum. ${UNCHANGED}`,
    retryable: false,
  },
  row_invalid: {
    title: 'Some items in the backup do not match StudyVault’s data model',
    body: `They may come from a damaged file or a different program. You can stop here, or restore the valid items and leave these out. ${UNCHANGED}`,
  },
  import_invalid: {
    title: 'This file cannot be imported',
    body: 'The file is not in a form StudyVault can read as highlights.',
    retryable: false,
  },
  integrity_violation: {
    title: 'Some items point at data that does not exist',
    body: `For example a highlight whose page is missing. You can stop here, or restore the consistent items and leave these out. ${UNCHANGED}`,
  },
  safety_backup_failed: {
    title: 'The safety copy of your current data could not be saved',
    body: `Because of that, nothing was restored. ${UNCHANGED} Try again, or turn the safety copy off if you already have a recent backup.`,
    retryable: true,
  },
  restore_in_progress: {
    title: 'Another restore is already running',
    body: `A restore is in progress in another StudyVault tab or window. Wait for it to finish, then try again. ${UNCHANGED}`,
    retryable: true,
  },
  staging_failed: {
    title: 'StudyVault could not prepare the restore',
    body: `The staging area failed or the staged data did not pass the storage checks (for example, low disk space). ${UNCHANGED}`,
    retryable: true,
  },
  commit_failed: {
    title: 'The restore could not be applied',
    body: `The final step was refused and rolled back, so your data was left exactly as it was before. ${UNCHANGED}`,
    retryable: true,
  },
};

const INVALID_REASONS: Record<InvalidRowInfo['reason'], string> = {
  not_an_object: 'is not a record',
  forbidden_key: 'contains a field name that is not allowed',
  migration_failed: 'could not be upgraded to the current data version',
  schema: 'does not match the expected fields',
  duplicate_key: 'repeats another item’s identity',
  missing_key: 'has no usable identity',
  binary_unavailable: 'refers to an attached file that is missing or damaged',
};

export const describeInvalidRow = (r: Pick<InvalidRowInfo, 'table' | 'line' | 'reason'>): string =>
  `${tableLabel(r.table)}, line ${r.line}: ${INVALID_REASONS[r.reason]}`;

const CONFLICT_REASONS = {
  immutable_field_changed:
    'the saved quote, where it came from, or how it was captured differs between the backup and your vault (your copy is kept)',
  same_timestamp_different_content:
    'both copies were last changed at the same moment but differ (your copy is kept)',
  no_timestamp_different_content:
    'the copies differ and neither says when it changed (your copy is kept)',
} as const;

export const describeConflict = (reason: keyof typeof CONFLICT_REASONS): string =>
  CONFLICT_REASONS[reason];

const IMPORT_REJECTIONS = {
  empty_quote: 'has no quote text',
  quote_too_long: 'has a quote longer than the limit',
  comment_too_long: 'has a comment longer than the limit',
  too_many_tags: 'has too many tags',
} as const;

export const describeRejection = (reason: keyof typeof IMPORT_REJECTIONS): string =>
  IMPORT_REJECTIONS[reason];

const INTEGRITY_ISSUES: Record<string, string> = {
  invalid_row: 'does not match its expected shape',
  newer_schema: 'was written by a newer version of StudyVault',
  bad_schema_version: 'has a missing or unusable version marker',
  orphan_reference: 'points at something that is not there',
  duplicate_id: 'shares an identity with a different kind of item',
  duplicate_tag_name: 'has the same name as another tag (merge them in the tag manager)',
  multiple_inbox: 'is one of several banks marked as the Inbox',
};

export const describeIntegrityIssue = (code: string): string =>
  INTEGRITY_ISSUES[code] ?? 'needs attention';

interface Capped<T> {
  total: number;
  items: T[];
}

function cappedLines(details: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = details[key] as Capped<Record<string, unknown>> | undefined;
  if (!value || !Array.isArray(value.items)) return [];
  const lines = value.items.slice(0, 10).map((item) => {
    if (key === 'invalidRows') return describeInvalidRow(item as unknown as InvalidRowInfo);
    const t = String(item.table ?? '');
    const field = String(item.field ?? '');
    return `${tableLabel(t)}: ${field} refers to a missing ${tableLabel(String(item.refTable ?? ''))} item`;
  });
  if (value.total > lines.length) lines.push(`…and ${value.total - lines.length} more`);
  return lines;
}

/** Whatever a backup/restore call threw, as something the screen can show. */
export function explainBackupError(err: unknown): ErrorExplanation {
  if (isBackupError(err)) {
    const entry = BY_CODE[err.code];
    const lines =
      err.code === 'row_invalid'
        ? cappedLines(err.details, 'invalidRows')
        : err.code === 'integrity_violation'
          ? cappedLines(err.details, 'orphans')
          : [];
    const action: ErrorAction | undefined =
      err.code === 'passphrase_required' || err.code === 'wrong_passphrase'
        ? 'enter_passphrase'
        : err.code === 'row_invalid'
          ? 'skip_invalid'
          : err.code === 'integrity_violation'
            ? 'skip_orphans'
            : undefined;
    return {
      code: err.code,
      title: entry.title,
      body: entry.body,
      lines,
      retryable: entry.retryable ?? true,
      ...(action ? { action } : {}),
    };
  }
  if (err instanceof StudyVaultError) {
    return {
      code: err.code,
      title: 'StudyVault could not finish',
      body: err.message,
      lines: [],
      retryable: err.code !== 'storage_unavailable',
    };
  }
  return {
    code: 'unknown',
    title: 'Something went wrong',
    body: `${err instanceof Error && err.message ? err.message : 'An unexpected error occurred.'} ${UNCHANGED}`,
    lines: [],
    retryable: true,
  };
}
