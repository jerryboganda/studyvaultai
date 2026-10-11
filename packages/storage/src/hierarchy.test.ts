// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOX_BANK_ID, MAX_FOLDER_DEPTH } from '@shared';
import { getDb } from './db';
import {
  createFolder,
  deleteBank,
  deleteFolder,
  listBankInfos,
  listFolderTree,
  mergeBanks,
  mergeFolders,
  moveFolder,
  renameBank,
  renameFolder,
  reorderBanks,
  reorderFolders,
  setBankColor,
  setBankIcon,
} from './hierarchy';
import { addToBank } from './membership';
import { createBank, listBanks, listBanksWithCounts } from './repo';
import { listHighlights } from './query';
import { restore } from './trash';
import { freshDatabase, save, trackEpochs } from './test-vault';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const memberships = async (highlightId: string) =>
  (await getDb().highlightBanks.where('highlightId').equals(highlightId).toArray()).sort((a, b) =>
    a.bankId.localeCompare(b.bankId),
  );

/** A chain of `n` nested folders in `bankId`; returns their ids outermost first. */
async function chain(bankId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < n; i++) {
    const f = await createFolder({ bankId, name: `Level ${i + 1}`, parentFolderId: parent });
    ids.push(f.id);
    parent = f.id;
  }
  return ids;
}

describe('folders', () => {
  it('creates nested folders with increasing positions and a tree to match', async () => {
    const bank = await createBank('Cardiology');
    const a = await createFolder({ bankId: bank.id, name: 'Pharmacology' });
    const b = await createFolder({ bankId: bank.id, name: 'Physiology' });
    const child = await createFolder({
      bankId: bank.id,
      name: 'Antiplatelets',
      parentFolderId: a.id,
    });
    expect(b.position).toBeGreaterThan(a.position);
    expect(child).toMatchObject({ bankId: bank.id, parentFolderId: a.id, deletedAt: null });

    const tree = await listFolderTree(bank.id);
    expect(tree.map((n) => [n.folder.name, n.depth, n.children.map((c) => c.folder.name)])).toEqual(
      [
        ['Pharmacology', 1, ['Antiplatelets']],
        ['Physiology', 1, []],
      ],
    );
    expect(tree[0]!.children[0]!.depth).toBe(2);
  });

  it('refuses unknown banks and parents, bad names, and parents from another bank', async () => {
    const bank = await createBank('Cardiology');
    const other = await createBank('Renal');
    const inOther = await createFolder({ bankId: other.id, name: 'Elsewhere' });
    await expect(createFolder({ bankId: 'no-such-bank', name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      createFolder({ bankId: bank.id, name: 'x', parentFolderId: 'no-such-folder' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createFolder({ bankId: bank.id, name: 'x', parentFolderId: inOther.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(createFolder({ bankId: bank.id, name: '   ' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(createFolder({ bankId: bank.id, name: 'x'.repeat(81) })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await getDb().folders.count()).toBe(1);
  });

  it('stops at the maximum depth', async () => {
    const bank = await createBank('Deep');
    const ids = await chain(bank.id, MAX_FOLDER_DEPTH);
    await expect(
      createFolder({ bankId: bank.id, name: 'too deep', parentFolderId: ids.at(-1)! }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
    });
    expect(await getDb().folders.count()).toBe(MAX_FOLDER_DEPTH);
  });

  it('creates concurrently without duplicate positions', async () => {
    const bank = await createBank('Busy');
    const made = await Promise.all(
      Array.from({ length: 12 }, (_, i) => createFolder({ bankId: bank.id, name: `F${i}` })),
    );
    expect(new Set(made.map((f) => f.position)).size).toBe(12);
  });

  it('renames, and does not signal when nothing changed', async () => {
    const bank = await createBank('Cardiology');
    const f = await createFolder({ bankId: bank.id, name: 'Old' });
    const epochs = trackEpochs();
    expect((await renameFolder(f.id, 'New')).name).toBe('New');
    expect(epochs).toHaveLength(1);
    await renameFolder(f.id, 'New');
    expect(epochs).toHaveLength(1);
    await expect(renameFolder(f.id, '')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(renameFolder('missing-folder-id', 'x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  describe('moveFolder', () => {
    it('reparents inside a bank and places the folder at an index', async () => {
      const bank = await createBank('Cardiology');
      const a = await createFolder({ bankId: bank.id, name: 'A' });
      const b = await createFolder({ bankId: bank.id, name: 'B' });
      const c = await createFolder({ bankId: bank.id, name: 'C', parentFolderId: a.id });
      const d = await createFolder({ bankId: bank.id, name: 'D', parentFolderId: a.id });

      await moveFolder({ id: d.id, parentFolderId: b.id });
      await moveFolder({ id: c.id, parentFolderId: b.id, index: 0 });
      const tree = await listFolderTree(bank.id);
      expect(tree.map((n) => [n.folder.name, n.children.map((x) => x.folder.name)])).toEqual([
        ['A', []],
        ['B', ['C', 'D']],
      ]);
      // And back to the root, first.
      await moveFolder({ id: d.id, parentFolderId: null, index: 0 });
      expect((await listFolderTree(bank.id)).map((n) => n.folder.name)).toEqual(['D', 'A', 'B']);
    });

    it('rejects a cycle: into itself or any descendant', async () => {
      const bank = await createBank('Cardiology');
      const [a, b, c] = await chain(bank.id, 3);
      await expect(moveFolder({ id: a!, parentFolderId: a! })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await expect(moveFolder({ id: a!, parentFolderId: c! })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect((await getDb().folders.get(a!))!.parentFolderId).toBeNull();
      expect((await getDb().folders.get(b!))!.parentFolderId).toBe(a);
    });

    it('rejects a move whose subtree would end up deeper than the maximum', async () => {
      const bank = await createBank('Deep');
      const deep = await chain(bank.id, MAX_FOLDER_DEPTH - 1);
      const sub = await createFolder({ bankId: bank.id, name: 'Subtree root' });
      await createFolder({ bankId: bank.id, name: 'Subtree child', parentFolderId: sub.id });
      await expect(moveFolder({ id: sub.id, parentFolderId: deep.at(-1)! })).rejects.toMatchObject({
        code: 'invalid_request',
        message: `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
      });
      // A leaf fits at exactly the maximum depth.
      const leaf = await createFolder({ bankId: bank.id, name: 'Leaf' });
      await moveFolder({ id: leaf.id, parentFolderId: deep.at(-1)! });
      expect((await getDb().folders.get(leaf.id))!.parentFolderId).toBe(deep.at(-1));
    });

    it('moves a subtree to another bank together with its highlights, without duplicating them', async () => {
      const from = await createBank('From');
      const to = await createBank('To');
      const top = await createFolder({ bankId: from.id, name: 'Top' });
      const sub = await createFolder({ bankId: from.id, name: 'Sub', parentFolderId: top.id });
      const h1 = await save('Filed in the sub folder');
      const h2 = await save('Filed in the top folder and also already in the target bank');
      await addToBank({ highlightId: h1.id, bankId: from.id, folderId: sub.id });
      await addToBank({ highlightId: h2.id, bankId: from.id, folderId: top.id });
      await addToBank({ highlightId: h2.id, bankId: to.id });
      const before = (await getDb().highlights.get(h1.id))!.updatedAt;

      const moved = await moveFolder({ id: top.id, parentFolderId: null, bankId: to.id });
      expect(moved.bankId).toBe(to.id);
      const rows = await getDb().folders.toArray();
      expect(
        rows
          .filter((f) => f.bankId === to.id)
          .map((f) => f.name)
          .sort(),
      ).toEqual(['Sub', 'Top']);

      expect((await memberships(h1.id)).map((m) => [m.bankId, m.folderId])).toEqual(
        [
          [INBOX_BANK_ID, null],
          [to.id, sub.id],
        ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      // One membership per bank: the highlight already in the target took the folder it was unfiled in.
      const m2 = (await memberships(h2.id)).filter((m) => m.bankId === to.id);
      expect(m2).toHaveLength(1);
      expect(m2[0]!.folderId).toBe(top.id);
      expect((await memberships(h2.id)).some((m) => m.bankId === from.id)).toBe(false);
      expect((await getDb().highlights.get(h1.id))!.updatedAt >= before).toBe(true);
    });

    it('is atomic: an injected failure while moving memberships changes nothing', async () => {
      const from = await createBank('From');
      const to = await createBank('To');
      const top = await createFolder({ bankId: from.id, name: 'Top' });
      const h = await save('Atomic move quote');
      await addToBank({ highlightId: h.id, bankId: from.id, folderId: top.id });
      const db = getDb();
      const foldersBefore = await db.folders.toArray();
      const membersBefore = await db.highlightBanks.toArray();
      const boom = () => {
        throw new Error('injected membership failure');
      };
      db.highlightBanks.hook('creating', boom);
      try {
        await expect(
          moveFolder({ id: top.id, parentFolderId: null, bankId: to.id }),
        ).rejects.toMatchObject({ code: 'internal' });
      } finally {
        db.highlightBanks.hook('creating').unsubscribe(boom);
      }
      expect(await db.folders.toArray()).toEqual(foldersBefore);
      expect(await db.highlightBanks.toArray()).toEqual(membersBefore);
    });
  });

  it('reorderFolders applies the order, keeps unlisted siblings after it and rejects strangers', async () => {
    const bank = await createBank('Cardiology');
    const [a, b, c] = await Promise.all(
      ['A', 'B', 'C'].map((name) => createFolder({ bankId: bank.id, name })),
    ).then((rows) => rows.sort((x, y) => x.name.localeCompare(y.name)));
    const other = await createFolder({ bankId: bank.id, name: 'Child', parentFolderId: a!.id });

    const result = await reorderFolders({
      bankId: bank.id,
      parentFolderId: null,
      orderedIds: [c!.id, a!.id],
    });
    expect(result.map((f) => f.name)).toEqual(['C', 'A', 'B']);
    expect((await listFolderTree(bank.id)).map((n) => n.folder.name)).toEqual(['C', 'A', 'B']);
    await expect(
      reorderFolders({ bankId: bank.id, parentFolderId: null, orderedIds: [other.id] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(b).toBeDefined();
  });

  describe('deleteFolder', () => {
    it('re-homes child folders and highlights to the parent (or the bank root) and can be restored', async () => {
      const bank = await createBank('Cardiology');
      const [top, mid] = await chain(bank.id, 2);
      const leaf = await createFolder({ bankId: bank.id, name: 'Leaf', parentFolderId: mid! });
      const inMid = await save('Filed in the middle folder');
      const inTop = await save('Filed in the top folder');
      await addToBank({ highlightId: inMid.id, bankId: bank.id, folderId: mid! });
      await addToBank({ highlightId: inTop.id, bankId: bank.id, folderId: top! });

      const result = await deleteFolder(mid!);
      expect(result).toEqual({ rehomedFolders: 1, rehomedHighlights: 1 });
      expect((await getDb().folders.get(leaf.id))!.parentFolderId).toBe(top);
      expect((await memberships(inMid.id)).find((m) => m.bankId === bank.id)!.folderId).toBe(top);

      // Deleting a top-level folder re-homes to the bank root.
      await deleteFolder(top!);
      expect((await getDb().folders.get(leaf.id))!.parentFolderId).toBeNull();
      expect((await memberships(inTop.id)).find((m) => m.bankId === bank.id)!.folderId).toBeNull();

      // Highlights are not deleted; the folder is in the trash and restorable (empty).
      const page = await listHighlights({ bankId: bank.id });
      expect(page.items.map((i) => i.highlight.id).sort()).toEqual([inMid.id, inTop.id].sort());
      expect((await restore([{ kind: 'folder', id: mid! }])).restored).toBe(1);
      expect((await getDb().folders.get(mid!))!.deletedAt).toBeNull();
    });

    it('is atomic: an injected failure leaves folders and memberships as they were', async () => {
      const bank = await createBank('Cardiology');
      const [top, mid] = await chain(bank.id, 2);
      const h = await save('Atomic delete quote');
      await addToBank({ highlightId: h.id, bankId: bank.id, folderId: mid! });
      const db = getDb();
      const before = {
        folders: await db.folders.toArray(),
        members: await db.highlightBanks.toArray(),
      };
      const boom = () => {
        throw new Error('injected');
      };
      db.folders.hook('updating', boom);
      try {
        await expect(deleteFolder(top!)).rejects.toMatchObject({ code: 'internal' });
      } finally {
        db.folders.hook('updating').unsubscribe(boom);
      }
      expect({
        folders: await db.folders.toArray(),
        members: await db.highlightBanks.toArray(),
      }).toEqual(before);
    });
  });

  describe('mergeFolders', () => {
    it('moves children and highlights into the target and trashes the source', async () => {
      const bank = await createBank('Cardiology');
      const src = await createFolder({ bankId: bank.id, name: 'Source' });
      const dst = await createFolder({ bankId: bank.id, name: 'Target' });
      const child = await createFolder({ bankId: bank.id, name: 'Child', parentFolderId: src.id });
      const h = await save('Merged quote');
      await addToBank({ highlightId: h.id, bankId: bank.id, folderId: src.id });

      expect(await mergeFolders({ sourceId: src.id, targetId: dst.id })).toEqual({
        movedFolders: 1,
        movedHighlights: 1,
      });
      expect((await getDb().folders.get(child.id))!.parentFolderId).toBe(dst.id);
      expect((await memberships(h.id)).find((m) => m.bankId === bank.id)!.folderId).toBe(dst.id);
      expect((await getDb().folders.get(src.id))!.deletedAt).not.toBeNull();
      const tree = await listFolderTree(bank.id);
      expect(tree.map((n) => [n.folder.name, n.count, n.totalCount])).toEqual([['Target', 1, 1]]);
    });

    it('rejects merging into a descendant, across banks, onto itself, or past the depth limit', async () => {
      const bank = await createBank('Cardiology');
      const other = await createBank('Renal');
      const [a, b] = await chain(bank.id, 2);
      const elsewhere = await createFolder({ bankId: other.id, name: 'Elsewhere' });
      await expect(mergeFolders({ sourceId: a!, targetId: b! })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await expect(mergeFolders({ sourceId: a!, targetId: elsewhere.id })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await expect(mergeFolders({ sourceId: a!, targetId: a! })).rejects.toMatchObject({
        code: 'invalid_request',
      });

      const deep = await chain(bank.id, MAX_FOLDER_DEPTH - 1);
      const src = await createFolder({ bankId: bank.id, name: 'S' });
      const c1 = await createFolder({ bankId: bank.id, name: 'S1', parentFolderId: src.id });
      await createFolder({ bankId: bank.id, name: 'S2', parentFolderId: c1.id });
      await expect(
        mergeFolders({ sourceId: src.id, targetId: deep.at(-1)! }),
      ).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect((await getDb().folders.get(src.id))!.deletedAt).toBeNull();
    });
  });

  it('counts exclude trashed highlights and roll up exactly', async () => {
    const bank = await createBank('Cardiology');
    const [top, mid] = await chain(bank.id, 2);
    const a = await save('Count a');
    const b = await save('Count b');
    const c = await save('Count c');
    await addToBank({ highlightId: a.id, bankId: bank.id, folderId: top! });
    await addToBank({ highlightId: b.id, bankId: bank.id, folderId: mid! });
    await addToBank({ highlightId: c.id, bankId: bank.id, folderId: mid! });
    const { softDeleteHighlight } = await import('./repo');
    await softDeleteHighlight(c.id);
    const [root] = await listFolderTree(bank.id);
    expect([root!.count, root!.totalCount, root!.children[0]!.count]).toEqual([1, 2, 1]);
  });
});

describe('banks', () => {
  it('renames, recolours and sets an icon; none of it touches highlights', async () => {
    const bank = await createBank('Cardiology');
    expect((await renameBank(bank.id, 'Cardiology 2')).name).toBe('Cardiology 2');
    expect((await setBankColor(bank.id, 'purple')).color).toBe('purple');
    expect((await setBankIcon(bank.id, '❤️')).icon).toBe('❤️');
    expect((await setBankIcon(bank.id, null)).icon).toBeNull();
    await expect(renameBank(bank.id, '')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(setBankIcon(bank.id, 'x'.repeat(33))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(renameBank('no-such-bank', 'x')).rejects.toMatchObject({ code: 'not_found' });
    const info = (await listBankInfos()).find((b) => b.id === bank.id)!;
    expect(info).toMatchObject({ name: 'Cardiology 2', color: 'purple', icon: null });
    // An icon is optional on the stored row: v1 readers still validate it.
    expect((await listBanks()).map((b) => b.name)).toContain('Cardiology 2');
  });

  it('can rename the Inbox but keeps it first when reordering', async () => {
    const a = await createBank('A');
    const b = await createBank('B');
    const c = await createBank('C');
    const result = await reorderBanks([c.id, INBOX_BANK_ID, a.id]);
    expect(result.map((x) => x.name)).toEqual(['Inbox', 'C', 'A', 'B']);
    expect((await listBanks()).map((x) => x.name)).toEqual(['Inbox', 'C', 'A', 'B']);
    await expect(reorderBanks(['no-such-bank'])).rejects.toMatchObject({ code: 'not_found' });
    expect(b).toBeDefined();
  });

  describe('deleteBank', () => {
    it('re-homes highlights that would be left bank-less to the Inbox, in one transaction', async () => {
      const bank = await createBank('Doomed');
      const keep = await createBank('Keeper');
      const only = await save('Only in the doomed bank', { bankId: bank.id });
      const shared = await save('Also in the keeper', { bankId: bank.id });
      await addToBank({ highlightId: shared.id, bankId: keep.id });
      const folder = await createFolder({ bankId: bank.id, name: 'Folder' });

      const result = await deleteBank(bank.id);
      expect(result).toEqual({ rehomedHighlights: 1 });
      expect((await listBanks()).map((b) => b.id)).not.toContain(bank.id);
      expect((await memberships(only.id)).map((m) => m.bankId)).toContain(INBOX_BANK_ID);
      expect((await memberships(shared.id)).map((m) => m.bankId)).not.toContain(INBOX_BANK_ID);
      // Nothing is lost: both highlights are still listed, with live banks only.
      const page = await listHighlights({});
      const byId = new Map(page.items.map((i) => [i.highlight.id, i]));
      expect(byId.get(only.id)!.banks.map((b) => b.id)).toEqual([INBOX_BANK_ID]);
      expect(byId.get(shared.id)!.banks.map((b) => b.id)).toEqual([keep.id]);
      expect((await getDb().folders.get(folder.id))!.deletedAt).not.toBeNull();

      const counts = await listBanksWithCounts();
      expect(counts.find((c) => c.bank.id === INBOX_BANK_ID)!.count).toBe(1);
    });

    it('never deletes the Inbox', async () => {
      await save('Quote so the Inbox exists');
      await expect(deleteBank(INBOX_BANK_ID)).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringMatching(/Inbox/),
      });
      expect((await listBanks()).map((b) => b.id)).toContain(INBOX_BANK_ID);
    });

    it('restoring the bank brings back its folders and removes the Inbox copy made for it', async () => {
      const bank = await createBank('Doomed');
      const h = await save('Round trip through the trash', { bankId: bank.id });
      const folder = await createFolder({ bankId: bank.id, name: 'F' });
      await addToBank({ highlightId: h.id, bankId: bank.id, folderId: folder.id });
      await deleteBank(bank.id);
      expect((await memberships(h.id)).map((m) => m.bankId).sort()).toEqual(
        [bank.id, INBOX_BANK_ID].sort(),
      );

      await restore([{ kind: 'bank', id: bank.id }]);
      expect((await listBanks()).map((b) => b.id)).toContain(bank.id);
      expect((await getDb().folders.get(folder.id))!.deletedAt).toBeNull();
      expect((await memberships(h.id)).map((m) => [m.bankId, m.folderId])).toEqual([
        [bank.id, folder.id],
      ]);
    });

    it('is atomic: an injected failure leaves the bank and its memberships alone', async () => {
      const bank = await createBank('Doomed');
      await save('Quote in doomed bank', { bankId: bank.id });
      const db = getDb();
      const before = {
        banks: await db.banks.toArray(),
        members: await db.highlightBanks.toArray(),
      };
      const boom = () => {
        throw new Error('injected');
      };
      db.highlightBanks.hook('creating', boom);
      try {
        await expect(deleteBank(bank.id)).rejects.toMatchObject({ code: 'internal' });
      } finally {
        db.highlightBanks.hook('creating').unsubscribe(boom);
      }
      expect({
        banks: await db.banks.toArray(),
        members: await db.highlightBanks.toArray(),
      }).toEqual(before);
    });
  });

  describe('mergeBanks', () => {
    it('moves folders and highlights into the target, deduplicating memberships', async () => {
      const src = await createBank('Source');
      const dst = await createBank('Target');
      const folder = await createFolder({ bankId: src.id, name: 'Folder' });
      const sub = await createFolder({ bankId: src.id, name: 'Sub', parentFolderId: folder.id });
      const targetFolder = await createFolder({ bankId: dst.id, name: 'Existing' });
      const a = await save('In the source only', { bankId: src.id });
      const both = await save('In both banks', { bankId: src.id });
      await addToBank({ highlightId: both.id, bankId: dst.id });
      await addToBank({ highlightId: a.id, bankId: src.id, folderId: sub.id });

      const result = await mergeBanks({ sourceId: src.id, targetId: dst.id });
      expect(result.movedHighlights).toBe(2);
      expect((await listBanks()).map((b) => b.id)).not.toContain(src.id);
      for (const h of [a, both]) {
        const m = await memberships(h.id);
        expect(m.filter((x) => x.bankId === dst.id)).toHaveLength(1);
        expect(m.some((x) => x.bankId === src.id)).toBe(false);
      }
      const folders = await getDb().folders.toArray();
      expect(folders.every((f) => f.bankId === dst.id)).toBe(true);
      const tree = await listFolderTree(dst.id);
      expect(tree.map((n) => n.folder.name)).toEqual(['Existing', 'Folder']);
      expect(tree[1]!.children.map((c) => c.folder.name)).toEqual(['Sub']);
      expect(tree[1]!.children[0]!.count).toBe(1);
      expect(targetFolder).toBeDefined();
    });

    it('refuses the Inbox as the source and a bank into itself', async () => {
      const bank = await createBank('Cardiology');
      await expect(
        mergeBanks({ sourceId: INBOX_BANK_ID, targetId: bank.id }),
      ).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await expect(mergeBanks({ sourceId: bank.id, targetId: bank.id })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      // Merging a bank into the Inbox is fine.
      const h = await save('Goes to the inbox', { bankId: bank.id });
      await mergeBanks({ sourceId: bank.id, targetId: INBOX_BANK_ID });
      expect((await memberships(h.id)).map((m) => m.bankId)).toEqual([INBOX_BANK_ID]);
    });
  });
});
