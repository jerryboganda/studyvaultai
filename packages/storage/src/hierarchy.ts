import { uuidv7 } from 'uuidv7';
import {
  Bank,
  BankIcon,
  ColorId,
  Folder,
  INBOX_BANK_ID,
  MAX_FOLDER_DEPTH,
  SCHEMA_VERSION,
  StudyVaultError,
  type BankRecord,
} from '@shared';
import {
  cmp,
  ensureInbox,
  rowsWhereIn,
  isDeleted,
  liveBank,
  now,
  parseInput,
  parseRow,
  readBanks,
  requireId,
  signalChange,
  touchHighlights,
  unique,
} from './core';
import { withDb, withWritableDb, type StudyVaultDb } from './db';
import type { BankInfo, FolderNode } from './types';

/**
 * Bank and folder hierarchy. Bank > Folder > Topic > Subtopic is one nested `folders` table
 * (max depth 8). Every write is one transaction and signals once after it commits.
 */

const byOrder = (a: Folder, b: Folder) =>
  a.position - b.position || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);

/** Live, readable folders of one bank by id. Unreadable rows are skipped, never rewritten. */
export async function loadFolders(db: StudyVaultDb, bankId: string): Promise<Map<string, Folder>> {
  const out = new Map<string, Folder>();
  for (const row of await db.folders.where('bankId').equals(bankId).toArray()) {
    if (isDeleted(row)) continue;
    const folder = parseRow(Folder, row, 'folder');
    if (folder) out.set(folder.id, folder);
  }
  return out;
}

export function childrenIndex(folders: ReadonlyMap<string, Folder>): Map<string | null, Folder[]> {
  const out = new Map<string | null, Folder[]>();
  for (const folder of folders.values()) {
    // A parent that is missing (deleted, unreadable) must not hide its children: they surface at the root.
    const key =
      folder.parentFolderId !== null && folders.has(folder.parentFolderId)
        ? folder.parentFolderId
        : null;
    const list = out.get(key) ?? [];
    list.push(folder);
    out.set(key, list);
  }
  for (const list of out.values()) list.sort(byOrder);
  return out;
}

/** 1 for a top-level folder. Stops at a cycle in corrupt data instead of looping. */
export function depthOf(folders: ReadonlyMap<string, Folder>, id: string): number {
  let depth = 0;
  let cursor: string | null = id;
  while (cursor !== null && depth <= MAX_FOLDER_DEPTH * 4) {
    const folder = folders.get(cursor);
    if (!folder) break;
    depth++;
    cursor = folder.parentFolderId;
  }
  return depth;
}

/** `id` and every folder below it. */
export function subtreeIds(children: ReadonlyMap<string | null, Folder[]>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    for (const child of children.get(next) ?? []) stack.push(child.id);
  }
  return out;
}

/** Levels in the subtree rooted at `id` (1 for a leaf). */
function subtreeHeight(children: ReadonlyMap<string | null, Folder[]>, id: string): number {
  let height = 0;
  let level = [id];
  const seen = new Set<string>();
  while (level.length > 0 && height <= MAX_FOLDER_DEPTH * 4) {
    height++;
    const next: string[] = [];
    for (const node of level) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const child of children.get(node) ?? []) next.push(child.id);
    }
    level = next;
  }
  return height;
}

const tooDeep = () =>
  new StudyVaultError(
    'invalid_request',
    `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
  );

async function liveFolder(db: StudyVaultDb, id: string): Promise<Folder> {
  const row = await db.folders.get(id);
  const folder = row && !isDeleted(row) ? parseRow(Folder, row, 'folder') : null;
  if (!folder) throw new StudyVaultError('not_found', 'Folder not found');
  return folder;
}

async function bumpFolders(db: StudyVaultDb, ids: readonly string[], ts: string): Promise<void> {
  for (const id of ids) await db.folders.update(id, { updatedAt: ts });
}

// ---------------------------------------------------------------------------------------------
// folders
// ---------------------------------------------------------------------------------------------

export async function createFolder(input: {
  bankId: string;
  name: string;
  parentFolderId?: string | null;
}): Promise<Folder> {
  const name = parseInput(Folder.shape.name, input.name, 'folder name');
  const bankId = requireId(input.bankId);
  const parentId = input.parentFolderId ?? null;
  if (parentId !== null) requireId(parentId);
  const folder = await withWritableDb((db) =>
    db.transaction('rw', [db.banks, db.folders], async () => {
      const ts = now();
      const bank = await liveBank(db, bankId);
      const folders = await loadFolders(db, bank.id);
      if (parentId !== null) {
        if (!folders.has(parentId))
          throw new StudyVaultError('not_found', 'Parent folder not found');
        if (depthOf(folders, parentId) + 1 > MAX_FOLDER_DEPTH) throw tooDeep();
      }
      const siblings = [...folders.values()].filter((f) => f.parentFolderId === parentId);
      const position = Math.floor(Math.max(0, ...siblings.map((f) => f.position))) + 1;
      const row: Folder = {
        id: uuidv7(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        bankId: bank.id,
        parentFolderId: parentId,
        name,
        position,
      };
      await db.folders.put(row);
      return row;
    }),
  );
  await signalChange();
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<Folder> {
  requireId(id);
  const next = parseInput(Folder.shape.name, name, 'folder name');
  const { folder, changed } = await withWritableDb((db) =>
    db.transaction('rw', [db.folders], async () => {
      const row = await liveFolder(db, id);
      if (row.name === next) return { folder: row, changed: false };
      const ts = now();
      const folders = await loadFolders(db, row.bankId);
      // Descendants' search paths change with the name: bump them so incremental indexing sees them.
      await bumpFolders(db, subtreeIds(childrenIndex(folders), id), ts);
      await db.folders.update(id, { name: next });
      return { folder: { ...row, name: next, updatedAt: ts }, changed: true };
    }),
  );
  if (changed) await signalChange();
  return folder;
}

export async function moveFolder(input: {
  id: string;
  parentFolderId: string | null;
  bankId?: string;
  index?: number;
}): Promise<Folder> {
  requireId(input.id);
  if (input.parentFolderId !== null) requireId(input.parentFolderId);
  if (input.bankId !== undefined) requireId(input.bankId);
  if (input.index !== undefined && (!Number.isInteger(input.index) || input.index < 0)) {
    throw new StudyVaultError('invalid_request', 'index must be a non-negative integer');
  }
  const folder = await withWritableDb((db) =>
    db.transaction('rw', [db.banks, db.folders, db.highlightBanks, db.highlights], async () => {
      const ts = now();
      const row = await liveFolder(db, input.id);
      const sourceBankId = row.bankId;

      let targetBankId = input.bankId ?? sourceBankId;
      if (input.parentFolderId !== null) {
        const parent = await liveFolder(db, input.parentFolderId);
        if (input.bankId !== undefined && input.bankId !== parent.bankId) {
          throw new StudyVaultError(
            'invalid_request',
            'The target folder is not in the target bank',
          );
        }
        targetBankId = parent.bankId;
      }
      const targetBank = await liveBank(db, targetBankId);
      targetBankId = targetBank.id;

      const sourceFolders = await loadFolders(db, sourceBankId);
      const sourceChildren = childrenIndex(sourceFolders);
      const moving = subtreeIds(sourceChildren, row.id);
      const height = subtreeHeight(sourceChildren, row.id);

      const targetFolders =
        targetBankId === sourceBankId ? sourceFolders : await loadFolders(db, targetBankId);
      if (input.parentFolderId !== null) {
        if (!targetFolders.has(input.parentFolderId)) {
          throw new StudyVaultError('not_found', 'Parent folder not found');
        }
        if (targetBankId === sourceBankId && moving.includes(input.parentFolderId)) {
          throw new StudyVaultError(
            'invalid_request',
            'A folder cannot be moved into itself or one of its own subfolders.',
          );
        }
      }
      const parentDepth =
        input.parentFolderId === null ? 0 : depthOf(targetFolders, input.parentFolderId);
      if (parentDepth + height > MAX_FOLDER_DEPTH) throw tooDeep();

      // New sibling order: the moved folder goes to `index` (default last).
      const movingSet = new Set(moving);
      const siblings = [...targetFolders.values()]
        .filter((f) => f.parentFolderId === input.parentFolderId && !movingSet.has(f.id))
        .sort(byOrder);
      const at = Math.min(input.index ?? siblings.length, siblings.length);
      const ordered = [...siblings.slice(0, at), row, ...siblings.slice(at)];
      for (const [i, f] of ordered.entries()) {
        const position = i + 1;
        if (f.id === row.id) continue;
        if (f.position !== position) await db.folders.update(f.id, { position, updatedAt: ts });
      }
      await db.folders.update(row.id, {
        parentFolderId: input.parentFolderId,
        bankId: targetBankId,
        position: at + 1,
        updatedAt: ts,
      });

      // Descendants keep their parent; their search path (and bank) changes with this move.
      const rest = moving.filter((id) => id !== row.id);
      for (const id of rest) {
        await db.folders.update(id, { bankId: targetBankId, updatedAt: ts });
      }

      if (targetBankId !== sourceBankId) {
        const touched = await moveMembershipsBetweenBanks(db, {
          folderIds: moving,
          fromBankId: sourceBankId,
          toBankId: targetBankId,
          ts,
        });
        await touchHighlights(db, touched, ts);
      }
      return { ...row, parentFolderId: input.parentFolderId, bankId: targetBankId, updatedAt: ts };
    }),
  );
  await signalChange();
  return folder;
}

/**
 * Memberships of highlights filed in `folderIds` of `fromBankId` follow the folders into
 * `toBankId`. A highlight already in the target bank keeps that membership (and takes the folder
 * only when it was unfiled there): one highlight, one membership per bank.
 */
async function moveMembershipsBetweenBanks(
  db: StudyVaultDb,
  args: { folderIds: string[]; fromBankId: string; toBankId: string; ts: string },
): Promise<string[]> {
  const touched: string[] = [];
  const rows = await rowsWhereIn(db.highlightBanks, 'folderId', args.folderIds);
  for (const m of rows) {
    if (m.bankId !== args.fromBankId) continue;
    const existing = await db.highlightBanks.get([m.highlightId, args.toBankId]);
    if (existing) {
      if (existing.folderId === null) {
        await db.highlightBanks.update([m.highlightId, args.toBankId], { folderId: m.folderId });
      }
    } else {
      await db.highlightBanks.put({
        highlightId: m.highlightId,
        bankId: args.toBankId,
        folderId: m.folderId,
        addedAt: m.addedAt,
      });
    }
    await db.highlightBanks.delete([m.highlightId, m.bankId]);
    touched.push(m.highlightId);
  }
  return touched;
}

export async function reorderFolders(input: {
  bankId: string;
  parentFolderId: string | null;
  orderedIds: string[];
}): Promise<Folder[]> {
  requireId(input.bankId);
  if (input.parentFolderId !== null) requireId(input.parentFolderId);
  const ordered = unique(input.orderedIds.map(requireId));
  const { result, changed } = await withWritableDb((db) =>
    db.transaction('rw', [db.folders], async () => {
      const folders = await loadFolders(db, input.bankId);
      const siblings = [...folders.values()]
        .filter((f) => f.parentFolderId === input.parentFolderId)
        .sort(byOrder);
      const byId = new Map(siblings.map((f) => [f.id, f]));
      for (const id of ordered) {
        if (!byId.has(id)) {
          throw new StudyVaultError('invalid_request', 'Folder is not a child of that parent');
        }
      }
      // Ids not mentioned (created meanwhile in another window) keep their order after the listed ones.
      const next = [
        ...ordered.map((id) => byId.get(id)!),
        ...siblings.filter((f) => !ordered.includes(f.id)),
      ];
      const ts = now();
      let changed = false;
      const result: Folder[] = [];
      for (const [i, f] of next.entries()) {
        const position = i + 1;
        if (f.position !== position) {
          await db.folders.update(f.id, { position, updatedAt: ts });
          result.push({ ...f, position, updatedAt: ts });
          changed = true;
        } else result.push(f);
      }
      return { result, changed };
    }),
  );
  if (changed) await signalChange();
  return result;
}

export async function deleteFolder(
  id: string,
): Promise<{ rehomedFolders: number; rehomedHighlights: number }> {
  requireId(id);
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.folders, db.highlightBanks, db.highlights], async () => {
      const ts = now();
      const row = await liveFolder(db, id);
      const folders = await loadFolders(db, row.bankId);
      const children = (childrenIndex(folders).get(id) ?? []).sort(byOrder);
      // Children take the deleted folder's place: same parent, positions inside its slot.
      for (const [i, child] of children.entries()) {
        await db.folders.update(child.id, {
          parentFolderId: row.parentFolderId,
          position: row.position + (i + 1) / (children.length + 1),
          updatedAt: ts,
        });
      }
      const members = (await db.highlightBanks.where('folderId').equals(id).toArray()).filter(
        (m) => m.bankId === row.bankId,
      );
      for (const m of members) {
        await db.highlightBanks.update([m.highlightId, m.bankId], {
          folderId: row.parentFolderId,
        });
      }
      await touchHighlights(
        db,
        members.map((m) => m.highlightId),
        ts,
      );
      await db.folders.update(id, { deletedAt: ts, updatedAt: ts });
      return { rehomedFolders: children.length, rehomedHighlights: members.length };
    }),
  );
  await signalChange();
  return result;
}

export async function mergeFolders(input: {
  sourceId: string;
  targetId: string;
}): Promise<{ movedFolders: number; movedHighlights: number }> {
  requireId(input.sourceId);
  requireId(input.targetId);
  if (input.sourceId === input.targetId) {
    throw new StudyVaultError('invalid_request', 'Choose two different folders to merge.');
  }
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.folders, db.highlightBanks, db.highlights], async () => {
      const ts = now();
      const source = await liveFolder(db, input.sourceId);
      const target = await liveFolder(db, input.targetId);
      if (source.bankId !== target.bankId) {
        throw new StudyVaultError('invalid_request', 'Folders can only be merged within one bank.');
      }
      const folders = await loadFolders(db, source.bankId);
      const children = childrenIndex(folders);
      if (subtreeIds(children, source.id).includes(target.id)) {
        throw new StudyVaultError(
          'invalid_request',
          'A folder cannot be merged into one of its own subfolders.',
        );
      }
      const targetDepth = depthOf(folders, target.id);
      const moved = children.get(source.id) ?? [];
      for (const child of moved) {
        if (targetDepth + subtreeHeight(children, child.id) > MAX_FOLDER_DEPTH) throw tooDeep();
      }
      const existing = children.get(target.id) ?? [];
      let position = Math.floor(Math.max(0, ...existing.map((f) => f.position)));
      for (const child of moved) {
        position += 1;
        await db.folders.update(child.id, { parentFolderId: target.id, position, updatedAt: ts });
      }
      const members = (
        await db.highlightBanks.where('folderId').equals(source.id).toArray()
      ).filter((m) => m.bankId === source.bankId);
      for (const m of members) {
        await db.highlightBanks.update([m.highlightId, m.bankId], { folderId: target.id });
      }
      await touchHighlights(
        db,
        members.map((m) => m.highlightId),
        ts,
      );
      await db.folders.update(source.id, { deletedAt: ts, updatedAt: ts });
      await db.folders.update(target.id, { updatedAt: ts });
      return { movedFolders: moved.length, movedHighlights: members.length };
    }),
  );
  await signalChange();
  return result;
}

export async function listFolderTree(bankId: string): Promise<FolderNode[]> {
  requireId(bankId);
  return withDb((db) =>
    db.transaction('r', [db.folders, db.highlightBanks, db.highlights], async () => {
      const folders = await loadFolders(db, bankId);
      const children = childrenIndex(folders);
      // Counts: index keys only, minus members whose highlight sits in the trash.
      const deleted = new Set<string>(
        (await db.highlights.where('deletedAt').above('').primaryKeys()) as string[],
      );
      const counts = new Map<string, number>();
      for (const folder of folders.values()) {
        const keys = await db.highlightBanks.where('folderId').equals(folder.id).primaryKeys();
        const live = keys.filter((k) => !deleted.has((k as [string, string])[0])).length;
        if (live > 0) counts.set(folder.id, live);
      }
      const build = (folder: Folder, depth: number, seen: Set<string>): FolderNode => {
        seen.add(folder.id);
        const kids = (children.get(folder.id) ?? [])
          .filter((c) => !seen.has(c.id))
          .map((c) => build(c, depth + 1, seen));
        const count = counts.get(folder.id) ?? 0;
        return {
          folder,
          depth,
          count,
          totalCount: count + kids.reduce((n, k) => n + k.totalCount, 0),
          children: kids,
        };
      };
      const seen = new Set<string>();
      return (children.get(null) ?? []).map((f) => build(f, 1, seen));
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// banks
// ---------------------------------------------------------------------------------------------

const toInfo = (b: BankRecord): BankInfo => ({
  id: b.id,
  name: b.name,
  color: b.color,
  isInbox: b.isInbox,
  icon: b.icon ?? null,
  position: b.position,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

export async function listBankInfos(): Promise<BankInfo[]> {
  return withDb(async (db) => (await readBanks(db)).map(toInfo));
}

async function updateBank(
  id: string,
  change: Partial<Pick<BankRecord, 'name' | 'color' | 'icon'>>,
): Promise<BankInfo> {
  requireId(id);
  const { bank, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.banks, async () => {
      const row = await liveBank(db, id);
      const differs = (Object.keys(change) as Array<keyof typeof change>).some(
        (k) => (row[k] ?? null) !== (change[k] ?? null),
      );
      if (!differs) return { bank: row, changed: false };
      const ts = now();
      await db.banks.update(row.id, { ...change, updatedAt: ts });
      return { bank: { ...row, ...change, updatedAt: ts }, changed: true };
    }),
  );
  if (changed) await signalChange();
  return toInfo(bank);
}

export const renameBank = async (id: string, name: string) =>
  updateBank(id, { name: parseInput(Bank.shape.name, name, 'bank name') });

export const setBankColor = async (id: string, color: ColorId) =>
  updateBank(id, { color: parseInput(ColorId, color, 'bank color') });

export const setBankIcon = async (id: string, icon: string | null) =>
  updateBank(id, { icon: icon === null ? null : parseInput(BankIcon, icon, 'bank icon') });

export async function reorderBanks(orderedIds: string[]): Promise<BankInfo[]> {
  const ordered = unique(orderedIds.map(requireId));
  const banks = await withWritableDb((db) =>
    db.transaction('rw', db.banks, async () => {
      const ts = now();
      await ensureInbox(db, ts);
      const live = await readBanks(db);
      const byId = new Map(live.map((b) => [b.id, b]));
      for (const id of ordered) {
        if (!byId.has(id)) throw new StudyVaultError('not_found', 'Bank not found');
      }
      // The Inbox always leads; the listed banks follow, then any bank created meanwhile.
      const rest = ordered.filter((id) => id !== INBOX_BANK_ID);
      const next = [
        byId.get(INBOX_BANK_ID)!,
        ...rest.map((id) => byId.get(id)!),
        ...live.filter((b) => b.id !== INBOX_BANK_ID && !rest.includes(b.id)),
      ];
      const result: BankRecord[] = [];
      for (const [position, b] of next.entries()) {
        if (b.position !== position) {
          await db.banks.update(b.id, { position, updatedAt: ts });
          result.push({ ...b, position, updatedAt: ts });
        } else result.push(b);
      }
      return result;
    }),
  );
  await signalChange();
  return banks.map(toInfo);
}

export async function mergeBanks(input: {
  sourceId: string;
  targetId: string;
}): Promise<{ movedFolders: number; movedHighlights: number }> {
  requireId(input.sourceId);
  requireId(input.targetId);
  if (input.sourceId === input.targetId) {
    throw new StudyVaultError('invalid_request', 'Choose two different banks to merge.');
  }
  if (input.sourceId === INBOX_BANK_ID) {
    throw new StudyVaultError('invalid_request', 'The Inbox cannot be merged into another bank.');
  }
  const result = await withWritableDb((db) =>
    db.transaction(
      'rw',
      [db.banks, db.folders, db.highlightBanks, db.highlights, db.decks],
      async () => {
        const ts = now();
        const source = await liveBank(db, input.sourceId);
        const target = await liveBank(db, input.targetId);
        // Decks that studied the source bank study the target now, so none is left pointing at a bank
        // that is deleted here and may later be purged.
        for (const deckId of await db.decks.where('bankId').equals(source.id).primaryKeys()) {
          await db.decks.update(deckId, { bankId: target.id, updatedAt: ts });
        }
        // Every folder row of the source bank, deleted ones included, so nothing keeps pointing at it.
        const sourceRows = await db.folders.where('bankId').equals(source.id).toArray();
        const targetTop = (await loadFolders(db, target.id)).values();
        let position = Math.floor(
          Math.max(
            0,
            ...[...targetTop].filter((f) => f.parentFolderId === null).map((f) => f.position),
          ),
        );
        const topLevel = sourceRows
          .filter((f) => f.parentFolderId === null)
          .sort((a, b) => a.position - b.position || cmp(a.id, b.id));
        for (const f of topLevel) {
          position += 1;
          await db.folders.update(f.id, { position });
        }
        for (const f of sourceRows)
          await db.folders.update(f.id, { bankId: target.id, updatedAt: ts });

        const members = await db.highlightBanks.where('bankId').equals(source.id).toArray();
        for (const m of members) {
          const existing = await db.highlightBanks.get([m.highlightId, target.id]);
          if (existing) {
            if (existing.folderId === null && m.folderId !== null) {
              await db.highlightBanks.update([m.highlightId, target.id], { folderId: m.folderId });
            }
          } else {
            await db.highlightBanks.put({
              highlightId: m.highlightId,
              bankId: target.id,
              folderId: m.folderId,
              addedAt: m.addedAt,
            });
          }
          await db.highlightBanks.delete([m.highlightId, source.id]);
        }
        await touchHighlights(
          db,
          members.map((m) => m.highlightId),
          ts,
        );
        await db.banks.update(source.id, { deletedAt: ts, updatedAt: ts });
        await db.banks.update(target.id, { updatedAt: ts });
        return { movedFolders: sourceRows.length, movedHighlights: members.length };
      },
    ),
  );
  await signalChange();
  return result;
}

export async function deleteBank(id: string): Promise<{ rehomedHighlights: number }> {
  requireId(id);
  if (id === INBOX_BANK_ID) {
    throw new StudyVaultError('invalid_request', 'The Inbox cannot be deleted.');
  }
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.banks, db.folders, db.highlightBanks, db.highlights], async () => {
      const ts = now();
      const bank = await liveBank(db, id);
      if (bank.isInbox) {
        throw new StudyVaultError('invalid_request', 'The Inbox cannot be deleted.');
      }
      const inbox = await ensureInbox(db, ts);
      const liveIds = new Set((await readBanks(db)).map((b) => b.id));
      liveIds.delete(bank.id);

      // Memberships stay on the deleted bank (restoring it restores them); a highlight that would
      // be left in no live bank is also filed in the Inbox, in this same transaction.
      const members = await db.highlightBanks.where('bankId').equals(bank.id).toArray();
      const elsewhere = new Set<string>();
      for (const o of await rowsWhereIn(
        db.highlightBanks,
        'highlightId',
        members.map((m) => m.highlightId),
      )) {
        if (o.bankId !== bank.id && liveIds.has(o.bankId)) elsewhere.add(o.highlightId);
      }
      let rehomed = 0;
      for (const m of members) {
        if (elsewhere.has(m.highlightId)) continue;
        await db.highlightBanks.put({
          highlightId: m.highlightId,
          bankId: inbox.id,
          folderId: null,
          addedAt: ts,
        });
        rehomed++;
      }
      // The bank's folders go to the trash with it (same timestamp: restoring the bank restores them).
      for (const row of await db.folders.where('bankId').equals(bank.id).toArray()) {
        if (!isDeleted(row)) await db.folders.update(row.id, { deletedAt: ts, updatedAt: ts });
      }
      await touchHighlights(
        db,
        members.map((m) => m.highlightId),
        ts,
      );
      await db.banks.update(bank.id, { deletedAt: ts, updatedAt: ts });
      return { rehomedHighlights: rehomed };
    }),
  );
  await signalChange();
  return result;
}
