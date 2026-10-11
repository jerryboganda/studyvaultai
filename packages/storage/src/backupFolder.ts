import { z } from 'zod';
import { IsoDate, StudyVaultError } from '@shared';
import { withDb, withWritableDb, type MetaRow } from './db';

/**
 * The folder the person picked for dated backups (ADR-016), kept in the `meta` table of the vault
 * database:
 *
 *  - `backupFolder.handle`  the FileSystemDirectoryHandle (structured-cloneable; it is only a
 *                           reference. The grant itself lives in Chrome's site settings);
 *  - `backupFolder.state`   the folder's name, the person's two preferences and the last backup.
 *
 * `meta` is never exported, never restored and never synced, so a backup file cannot carry the
 * handle to another device, and "Delete all data" removes it with the database. A restore
 * (replace or merge) does not touch these rows.
 */

const KEY_HANDLE = 'backupFolder.handle';
const KEY_STATE = 'backupFolder.state';

export const DEFAULT_KEEP_LAST = 5;
/** Days after which the reminder shows; 0 turns it off. */
export const DEFAULT_REMIND_AFTER_DAYS = 7;
export const MAX_KEEP_LAST = 100;

/**
 * Built on first use, not at import: this module is loaded by the service worker too (through the
 * storage barrel), where a top-level schema would be kept in the bundle although nothing there uses
 * it.
 */
const buildState = () =>
  z.object({
    /** Chrome shares the folder's name, not its path: this is all that can be shown. */
    folderName: z.string().min(1).max(255),
    chosenAt: IsoDate,
    keepLast: z.number().int().min(1).max(MAX_KEEP_LAST),
    remindAfterDays: z.number().int().min(0).max(365),
    last: z
      .object({
        at: IsoDate,
        fileName: z.string().min(1).max(255),
        bytes: z.number().int().min(0),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        encrypted: z.boolean(),
        /** Older backups removed by that run. */
        pruned: z.number().int().min(0),
      })
      .nullable(),
  });
let built: ReturnType<typeof buildState> | undefined;
const stateSchema = () => (built ??= buildState());
export type BackupFolderState = z.infer<ReturnType<typeof buildState>>;
export type FolderBackupRecord = NonNullable<BackupFolderState['last']>;
export type BackupFolderPrefs = Pick<BackupFolderState, 'keepLast' | 'remindAfterDays'>;

const row = (key: string, value: unknown): MetaRow => ({
  key,
  value,
  updatedAt: new Date().toISOString(),
});

function parseState(value: unknown): BackupFolderState | null {
  const parsed = stateSchema().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The folder's name, preferences and last backup; null when no folder is chosen. No handle. */
export async function getBackupFolderState(): Promise<BackupFolderState | null> {
  return withDb(async (db) => parseState((await db.meta.get(KEY_STATE))?.value));
}

/** State and handle, for the one place that writes (a user gesture on an extension page). */
export async function getBackupFolder(): Promise<{
  handle: unknown;
  state: BackupFolderState;
} | null> {
  return withDb(async (db) => {
    const [handle, state] = await Promise.all([db.meta.get(KEY_HANDLE), db.meta.get(KEY_STATE)]);
    const parsed = parseState(state?.value);
    return handle && parsed ? { handle: handle.value, state: parsed } : null;
  });
}

/**
 * Remember a freshly picked folder. The preferences carry over from the previous folder; the last
 * backup does not (it was made to another place).
 */
export async function setBackupFolder(
  handle: unknown,
  folderName: string,
  now: Date = new Date(),
): Promise<BackupFolderState> {
  return withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      const before = parseState((await db.meta.get(KEY_STATE))?.value);
      const state = stateSchema().parse({
        folderName: folderName.slice(0, 255) || 'Backup folder',
        chosenAt: now.toISOString(),
        keepLast: before?.keepLast ?? DEFAULT_KEEP_LAST,
        remindAfterDays: before?.remindAfterDays ?? DEFAULT_REMIND_AFTER_DAYS,
        last: null,
      });
      await db.meta.bulkPut([row(KEY_HANDLE, handle), row(KEY_STATE, state)]);
      return state;
    }),
  );
}

async function change(
  mutate: (state: BackupFolderState) => BackupFolderState,
): Promise<BackupFolderState> {
  return withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      const state = parseState((await db.meta.get(KEY_STATE))?.value);
      if (!state) throw new StudyVaultError('not_found', 'No backup folder is chosen.');
      const next = stateSchema().parse(mutate(state));
      await db.meta.put(row(KEY_STATE, next));
      return next;
    }),
  );
}

/** The person's two choices. Out-of-range values are refused, not clamped. */
export function updateBackupFolderPrefs(prefs: BackupFolderPrefs): Promise<BackupFolderState> {
  return change((state) => ({ ...state, ...prefs }));
}

/** What the last successful backup to the folder was (the "Last backup" line and the reminder). */
export function recordFolderBackup(last: FolderBackupRecord): Promise<BackupFolderState> {
  return change((state) => ({ ...state, last }));
}

/** Stop using the folder: the handle and the state go; files already in the folder stay. */
export async function clearBackupFolder(): Promise<void> {
  await withWritableDb((db) => db.meta.bulkDelete([KEY_HANDLE, KEY_STATE]));
}

export interface BackupDue {
  /** Whole days since the last backup (or since the folder was chosen when there is none). */
  days: number;
  /** Past the person's interval; false when the reminder is off. */
  due: boolean;
  /** No backup was ever made to this folder. */
  never: boolean;
}

/** Pure: is the reminder due? The clock counts from the last backup, else from choosing the folder. */
export function backupDue(state: BackupFolderState, now: Date = new Date()): BackupDue {
  const since = Date.parse(state.last?.at ?? state.chosenAt);
  const days = Number.isFinite(since)
    ? Math.max(0, Math.floor((now.getTime() - since) / 86_400_000))
    : 0;
  return {
    days,
    due: state.remindAfterDays > 0 && days >= state.remindAfterDays,
    never: state.last === null,
  };
}
