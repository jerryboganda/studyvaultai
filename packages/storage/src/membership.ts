import { Folder, INBOX_BANK_ID, StudyVaultError } from '@shared';
import {
  ensureInbox,
  isDeleted,
  liveBank,
  liveHighlight,
  now,
  parseRow,
  readBanks,
  requireId,
  signalChange,
  touchHighlights,
} from './core';
import { withWritableDb, type StudyVaultDb } from './db';

/**
 * Filing a highlight in banks and folders. One highlight has at most one membership per bank
 * (`[highlightId+bankId]`) and any number of banks, so it is never duplicated by filing it twice.
 * The primitives below run inside a caller's transaction over
 * `banks, folders, highlightBanks, highlights`; bulk operations reuse them.
 */

export const MEMBERSHIP_TABLES = (db: StudyVaultDb) => [
  db.banks,
  db.folders,
  db.highlightBanks,
  db.highlights,
];

/** The folder must exist, be live and belong to `bankId`. */
export async function assertFolderInBank(
  db: StudyVaultDb,
  folderId: string,
  bankId: string,
): Promise<void> {
  const row = await db.folders.get(folderId);
  const folder = row && !isDeleted(row) ? parseRow(Folder, row, 'folder') : null;
  if (!folder) throw new StudyVaultError('not_found', 'Folder not found');
  if (folder.bankId !== bankId) {
    throw new StudyVaultError('invalid_request', 'That folder is not in that bank');
  }
}

/**
 * Make `highlightId` a member of `bankId`. `folderId` undefined leaves an existing membership's
 * folder alone (null: file at the bank root). Returns whether anything changed.
 */
export async function fileInBank(
  db: StudyVaultDb,
  highlightId: string,
  bankId: string,
  folderId: string | null | undefined,
  ts: string,
): Promise<{ added: boolean; changed: boolean }> {
  const existing = await db.highlightBanks.get([highlightId, bankId]);
  if (!existing) {
    await db.highlightBanks.put({ highlightId, bankId, folderId: folderId ?? null, addedAt: ts });
    return { added: true, changed: true };
  }
  if (folderId !== undefined && existing.folderId !== folderId) {
    await db.highlightBanks.update([highlightId, bankId], { folderId });
    return { added: false, changed: true };
  }
  return { added: false, changed: false };
}

/**
 * Remove the membership. A highlight is never left in no bank: when this was the last live one it
 * is filed in the Inbox instead, and removing it from the Inbox itself is refused.
 */
export async function unfileFromBank(
  db: StudyVaultDb,
  highlightId: string,
  bankId: string,
  ts: string,
): Promise<{ removed: boolean; rehomedToInbox: boolean }> {
  if (!(await db.highlightBanks.get([highlightId, bankId]))) {
    return { removed: false, rehomedToInbox: false };
  }
  const liveIds = new Set((await readBanks(db)).map((b) => b.id));
  const others = (
    await db.highlightBanks.where('highlightId').equals(highlightId).toArray()
  ).filter((m) => m.bankId !== bankId && liveIds.has(m.bankId));
  let rehomedToInbox = false;
  if (others.length === 0) {
    if (bankId === INBOX_BANK_ID) {
      throw new StudyVaultError(
        'invalid_request',
        'A highlight must stay filed in at least one bank. Move it to another bank instead.',
      );
    }
    const inbox = await ensureInbox(db, ts);
    await db.highlightBanks.put({ highlightId, bankId: inbox.id, folderId: null, addedAt: ts });
    rehomedToInbox = true;
  }
  await db.highlightBanks.delete([highlightId, bankId]);
  return { removed: true, rehomedToInbox };
}

/** Move a membership: `from` is replaced by `to` (kept as is when the highlight is already there). */
export async function moveMembership(
  db: StudyVaultDb,
  highlightId: string,
  fromBankId: string,
  toBankId: string,
  folderId: string | null | undefined,
  ts: string,
): Promise<boolean> {
  const from = await db.highlightBanks.get([highlightId, fromBankId]);
  if (!from) {
    throw new StudyVaultError('invalid_request', 'The highlight is not filed in the source bank');
  }
  if (fromBankId === toBankId) {
    const next = folderId ?? null;
    if (from.folderId === next) return false;
    await db.highlightBanks.update([highlightId, fromBankId], { folderId: next });
    return true;
  }
  await fileInBank(db, highlightId, toBankId, folderId, ts);
  await db.highlightBanks.delete([highlightId, fromBankId]);
  return true;
}

export async function addToBank(input: {
  highlightId: string;
  bankId: string;
  folderId?: string | null;
}): Promise<{ added: boolean; changed: boolean }> {
  requireId(input.highlightId);
  requireId(input.bankId);
  if (input.folderId) requireId(input.folderId);
  const result = await withWritableDb((db) =>
    db.transaction('rw', MEMBERSHIP_TABLES(db), async () => {
      const ts = now();
      const highlight = await liveHighlight(db, input.highlightId);
      const bank = await liveBank(db, input.bankId);
      if (input.folderId) await assertFolderInBank(db, input.folderId, bank.id);
      const outcome = await fileInBank(db, highlight.id, bank.id, input.folderId, ts);
      if (outcome.changed) await touchHighlights(db, [highlight.id], ts);
      return outcome;
    }),
  );
  if (result.changed) await signalChange();
  return result;
}

export async function removeFromBank(input: {
  highlightId: string;
  bankId: string;
}): Promise<{ removed: boolean; rehomedToInbox: boolean }> {
  requireId(input.highlightId);
  requireId(input.bankId);
  const result = await withWritableDb((db) =>
    db.transaction('rw', MEMBERSHIP_TABLES(db), async () => {
      const ts = now();
      const highlight = await liveHighlight(db, input.highlightId);
      const outcome = await unfileFromBank(db, highlight.id, input.bankId, ts);
      if (outcome.removed) await touchHighlights(db, [highlight.id], ts);
      return outcome;
    }),
  );
  if (result.removed) await signalChange();
  return result;
}

export async function moveHighlight(input: {
  highlightId: string;
  fromBankId: string;
  toBankId: string;
  folderId?: string | null;
}): Promise<{ changed: boolean }> {
  requireId(input.highlightId);
  requireId(input.fromBankId);
  requireId(input.toBankId);
  if (input.folderId) requireId(input.folderId);
  const result = await withWritableDb((db) =>
    db.transaction('rw', MEMBERSHIP_TABLES(db), async () => {
      const ts = now();
      const highlight = await liveHighlight(db, input.highlightId);
      const to = await liveBank(db, input.toBankId);
      if (input.folderId) await assertFolderInBank(db, input.folderId, to.id);
      const changed = await moveMembership(
        db,
        highlight.id,
        input.fromBankId,
        to.id,
        input.folderId,
        ts,
      );
      if (changed) await touchHighlights(db, [highlight.id], ts);
      return { changed };
    }),
  );
  if (result.changed) await signalChange();
  return result;
}
