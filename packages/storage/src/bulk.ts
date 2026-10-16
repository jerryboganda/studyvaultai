import {
  ColorId,
  Highlight,
  HighlightKind,
  Priority,
  StudyVaultError,
  type HighlightPatch,
} from '@shared';
import {
  isDeleted,
  liveBank,
  now,
  parseInput,
  parseRow,
  requireId,
  signalChange,
  unique,
} from './core';
import { withWritableDb, type StudyVaultDb } from './db';
import { revokeQuickSave } from './game';
import { assertFolderInBank, fileInBank, MEMBERSHIP_TABLES, moveMembership } from './membership';
import { assertLiveTags, linkTags, unlinkTags } from './tags';
import { reviveHighlights } from './trash';
import type { BulkResult } from './types';

/**
 * Bulk edits. Each call is ONE transaction: every id is checked before the first write, so a bad id
 * (unknown, or deleted where a live one is needed) fails the whole call and changes nothing.
 */

export const MAX_BULK_IDS = 20_000;

function idList(ids: readonly string[]): string[] {
  const out = unique(ids.map(requireId));
  if (out.length > MAX_BULK_IDS) {
    throw new StudyVaultError('invalid_request', `At most ${MAX_BULK_IDS} highlights per call.`);
  }
  return out;
}

/** Live, readable highlights for every id, or not_found naming how many were missing. */
async function requireLive(db: StudyVaultDb, ids: readonly string[]): Promise<Highlight[]> {
  const rows = await db.highlights.bulkGet([...ids]);
  const out: Highlight[] = [];
  let missing = 0;
  for (const row of rows) {
    const parsed = row && !isDeleted(row) ? parseRow(Highlight, row, 'highlight') : null;
    if (parsed) out.push(parsed);
    else missing++;
  }
  if (missing > 0) {
    throw new StudyVaultError(
      'not_found',
      `${missing} of the selected highlights no longer exist; nothing was changed.`,
    );
  }
  return out;
}

async function patchMany(ids: string[], changes: HighlightPatch): Promise<BulkResult> {
  const result = await withWritableDb((db) =>
    db.transaction('rw', db.highlights, async () => {
      const rows = await requireLive(db, ids);
      const ts = now();
      let changed = 0;
      for (const row of rows) {
        const differs = (Object.keys(changes) as Array<keyof HighlightPatch>).some(
          (k) => row[k] !== changes[k],
        );
        if (!differs) continue;
        await db.highlights.update(row.id, { ...changes, updatedAt: ts });
        changed++;
      }
      return { requested: ids.length, changed };
    }),
  );
  if (result.changed > 0) await signalChange();
  return result;
}

export const bulkSetKind = async (highlightIds: string[], kind: HighlightKind) =>
  patchMany(idList(highlightIds), { kind: parseInput(HighlightKind, kind, 'kind') });

export const bulkSetColor = async (highlightIds: string[], color: ColorId) =>
  patchMany(idList(highlightIds), { color: parseInput(ColorId, color, 'color') });

export const bulkSetPriority = async (highlightIds: string[], priority: Priority) =>
  patchMany(idList(highlightIds), { priority: parseInput(Priority, priority, 'priority') });

export async function bulkDelete(highlightIds: string[]): Promise<BulkResult> {
  const ids = idList(highlightIds);
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.highlights, db.gameFacts], async () => {
      const rows = await db.highlights.bulkGet(ids);
      if (rows.some((r) => r === undefined)) {
        throw new StudyVaultError(
          'not_found',
          'Some of the selected highlights no longer exist; nothing was changed.',
        );
      }
      const ts = now();
      let changed = 0;
      for (const row of rows) {
        if (!row || isDeleted(row)) continue;
        await db.highlights.update(row.id, { deletedAt: ts, updatedAt: ts });
        await revokeQuickSave(db, row, ts); // same rule as the single delete
        changed++;
      }
      return { requested: ids.length, changed };
    }),
  );
  if (result.changed > 0) await signalChange();
  return result;
}

export async function bulkRestore(highlightIds: string[]): Promise<BulkResult> {
  const ids = idList(highlightIds);
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.banks, db.sources, db.highlights, db.highlightBanks], async () => ({
      requested: ids.length,
      changed: await reviveHighlights(db, ids, now()),
    })),
  );
  if (result.changed > 0) await signalChange();
  return result;
}

export async function bulkMove(input: {
  highlightIds: string[];
  toBankId: string;
  folderId?: string | null;
  fromBankId?: string;
}): Promise<BulkResult> {
  const ids = idList(input.highlightIds);
  requireId(input.toBankId);
  if (input.fromBankId !== undefined) requireId(input.fromBankId);
  if (input.folderId) requireId(input.folderId);
  const result = await withWritableDb((db) =>
    db.transaction('rw', MEMBERSHIP_TABLES(db), async () => {
      const ts = now();
      const rows = await requireLive(db, ids);
      const to = await liveBank(db, input.toBankId);
      if (input.folderId) await assertFolderInBank(db, input.folderId, to.id);
      let changed = 0;
      const touched: string[] = [];
      for (const row of rows) {
        let did = false;
        if (input.fromBankId !== undefined) {
          const from = await db.highlightBanks.get([row.id, input.fromBankId]);
          if (from) {
            did = await moveMembership(db, row.id, input.fromBankId, to.id, input.folderId, ts);
          } else {
            did = (await fileInBank(db, row.id, to.id, input.folderId, ts)).changed;
          }
        } else {
          // "Move to": the highlight ends up filed here and nowhere else.
          const all = await db.highlightBanks.where('highlightId').equals(row.id).toArray();
          for (const m of all) {
            if (m.bankId === to.id) continue;
            await db.highlightBanks.delete([row.id, m.bankId]);
            did = true;
          }
          did = (await fileInBank(db, row.id, to.id, input.folderId ?? null, ts)).changed || did;
        }
        if (did) {
          changed++;
          touched.push(row.id);
        }
      }
      for (const id of touched) await db.highlights.update(id, { updatedAt: ts });
      return { requested: ids.length, changed };
    }),
  );
  if (result.changed > 0) await signalChange();
  return result;
}

export async function bulkTag(input: {
  highlightIds: string[];
  addTagIds?: string[];
  removeTagIds?: string[];
}): Promise<BulkResult> {
  const ids = idList(input.highlightIds);
  const add = unique((input.addTagIds ?? []).map(requireId));
  const remove = unique((input.removeTagIds ?? []).map(requireId));
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.tags, db.highlightTags, db.highlights], async () => {
      await requireLive(db, ids);
      await assertLiveTags(db, add);
      const ts = now();
      const touched = new Set<string>();
      for (const id of (await unlinkTags(db, ids, remove, ts)).touched) touched.add(id);
      for (const id of (await linkTags(db, ids, add, ts)).touched) touched.add(id);
      return { requested: ids.length, changed: touched.size };
    }),
  );
  if (result.changed > 0) await signalChange();
  return result;
}
