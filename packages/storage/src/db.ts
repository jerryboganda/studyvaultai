import Dexie, { type Table } from 'dexie';
import {
  StudyVaultError,
  type Bank,
  type Highlight,
  type HighlightBank,
  type Source,
} from '@shared';

export const DB_NAME = 'studyvault';

/**
 * Dexie store definitions of schema version 1. Exported so migration tests (and Phase 2's
 * `version(2)`) can build on the exact same strings instead of copying them.
 * Note: `isInbox` is a boolean and `deletedAt` is nullable; IndexedDB does not index such values,
 * so those two indexes are never used for lookups (live rows are filtered in code).
 */
export const SCHEMA_V1 = {
  banks: 'id, position, isInbox',
  sources: 'id, urlKey, visitedKey, updatedAt',
  highlights: 'id, sourceId, quoteHash, [sourceId+quoteHash], capturedAt, deletedAt, updatedAt',
  highlightBanks: '[highlightId+bankId], highlightId, bankId',
} as const;

export class StudyVaultDb extends Dexie {
  declare banks: Table<Bank, string>;
  declare sources: Table<Source, string>;
  declare highlights: Table<Highlight, string>;
  declare highlightBanks: Table<HighlightBank, [string, string]>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores(SCHEMA_V1);
  }
}

// Dexie errors that mean "the database cannot be used right now" rather than "a bug".
const UNAVAILABLE = new Set([
  'OpenFailedError',
  'DatabaseClosedError',
  'MissingAPIError',
  'VersionError',
  'UpgradeError',
  'BlockedError',
  'SecurityError',
  'UnknownError',
  'InvalidStateError',
]);

/** Map anything thrown by IndexedDB/Dexie to a StudyVaultError with a precise code. */
export function toStorageError(err: unknown): StudyVaultError {
  if (err instanceof StudyVaultError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Dexie wraps the original failure in `.inner`, so look through the chain.
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && cursor; depth++) {
    const name = (cursor as { name?: unknown }).name;
    if (name === 'QuotaExceededError') return new StudyVaultError('quota_exceeded', message);
    if (typeof name === 'string' && UNAVAILABLE.has(name)) {
      return new StudyVaultError('storage_unavailable', message);
    }
    cursor = (cursor as { inner?: unknown }).inner;
  }
  return new StudyVaultError('internal', message);
}

let instance: StudyVaultDb | null = null;

/** Lazy singleton. Not yet opened: use `withDb` so open failures are mapped. */
export function getDb(): StudyVaultDb {
  return (instance ??= new StudyVaultDb());
}

/** Open the shared database if needed, run `fn`, and surface every failure as a StudyVaultError. */
export async function withDb<T>(fn: (db: StudyVaultDb) => Promise<T>): Promise<T> {
  try {
    const db = getDb();
    if (!db.isOpen()) await db.open();
    return await fn(db);
  } catch (err) {
    throw toStorageError(err);
  }
}

/** Close the connection and forget the singleton; the next call reopens (simulates a restart). */
export function closeDb(): void {
  instance?.close();
  instance = null;
}

/** Test helper: close the connection and delete the whole database. */
export async function resetDbForTests(): Promise<void> {
  closeDb();
  await Dexie.delete(DB_NAME);
}
