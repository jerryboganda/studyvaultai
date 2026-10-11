// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOX_BANK_ID } from '@shared';
import { closeDb, getDb } from './db';
import {
  createFolder,
  deleteFolder,
  listFolderTree,
  mergeFolders,
  renameFolder,
} from './hierarchy';
import { addToBank } from './membership';
import { createNote, listNotes, setCustomFields } from './notes';
import { getCounts, getHighlightDetail, listHighlights } from './query';
import { checkIntegrity } from './registry';
import { createBank, listBanks, listBanksWithCounts } from './repo';
import { upsertDocument } from './pdf';
import { attachTags, createTag, listTags, renameTag } from './tags';
import { bulkMove, bulkTag } from './bulk';
import { listTrash, restore } from './trash';
import { dump, freshDatabase, save } from './test-vault';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const T = '2026-01-01T00:00:00.000Z';

describe('rows that cannot be read are never written over', () => {
  it('leaves corrupt folder, tag, note and document rows byte for byte as stored', async () => {
    const bank = await createBank('Cardiology');
    const h = await save('A healthy highlight', { bankId: bank.id });
    const db = getDb();
    const corrupt = {
      folder: {
        id: 'folder-corrupt-1',
        bankId: bank.id,
        parentFolderId: null,
        name: '',
        position: 'x',
      },
      tag: { id: 'tag-corrupt-0001', schemaVersion: 1, name: 42, nameKey: 'corrupt' },
      note: { id: 'note-corrupt-001', schemaVersion: 'one', highlightId: h.id, body: 7 },
      doc: { id: 'd'.repeat(64), schemaVersion: 1, title: {}, pageCount: 'many' },
    };
    await db.folders.put(corrupt.folder as never);
    await db.tags.put(corrupt.tag as never);
    await db.notes.put(corrupt.note as never);
    await db.documents.put(corrupt.doc as never);

    // A representative spread of writes and reads around them.
    const folder = await createFolder({ bankId: bank.id, name: 'Healthy folder' });
    await renameFolder(folder.id, 'Healthy folder renamed');
    await addToBank({ highlightId: h.id, bankId: bank.id, folderId: folder.id });
    const tag = (await createTag('Healthy tag')).tag;
    await attachTags({ highlightIds: [h.id], tagIds: [tag.id] });
    await renameTag(tag.id, 'Healthy tag 2');
    await createNote({ highlightId: h.id, body: 'healthy note' });
    await setCustomFields(h.id, { a: 1 });
    await listTags();
    await listNotes();
    await listFolderTree(bank.id);
    await getCounts();
    await listTrash();

    expect(await db.folders.get('folder-corrupt-1')).toEqual(corrupt.folder);
    expect(await db.tags.get('tag-corrupt-0001')).toEqual(corrupt.tag);
    expect(await db.notes.get('note-corrupt-001')).toEqual(corrupt.note);
    expect(await db.documents.get('d'.repeat(64))).toEqual(corrupt.doc);

    // Writing to an unreadable record by id is refused, not "repaired".
    await expect(renameFolder('folder-corrupt-1', 'Fixed')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(renameTag('tag-corrupt-0001', 'Fixed')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      upsertDocument({
        id: 'd'.repeat(64),
        title: 'New',
        pageCount: 1,
        byteLength: 1,
        originalUrl: null,
        textStatus: 'text',
      }),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await db.documents.get('d'.repeat(64))).toEqual(corrupt.doc);

    // And the integrity check names them.
    const report = await checkIntegrity();
    const invalid = report.issues
      .filter((i) => i.code === 'invalid_row')
      .map((i) => `${i.table}:${i.key}`);
    expect(invalid).toEqual(
      expect.arrayContaining([
        'folders:folder-corrupt-1',
        'tags:tag-corrupt-0001',
        'notes:note-corrupt-001',
        `documents:${'d'.repeat(64)}`,
      ]),
    );
  });
});

describe('a restart changes nothing', () => {
  it('every vault entity and every query answer survives closing and reopening the database', async () => {
    const cardio = await createBank('Cardiology');
    const renal = await createBank('Renal');
    const top = await createFolder({ bankId: cardio.id, name: 'Drugs' });
    const sub = await createFolder({
      bankId: cardio.id,
      name: 'Antiplatelets',
      parentFolderId: top.id,
    });
    const a = await save('Restart quote a', { bankId: cardio.id, kind: 'formula', priority: 5 });
    const b = await save('Restart quote b', { bankId: renal.id });
    await addToBank({ highlightId: a.id, bankId: cardio.id, folderId: sub.id });
    await addToBank({ highlightId: a.id, bankId: renal.id });
    const tag = (await createTag('exam')).tag;
    await attachTags({ highlightIds: [a.id, b.id], tagIds: [tag.id] });
    await createNote({ highlightId: a.id, title: 'T', body: 'persisted note', pinned: true });
    await setCustomFields(a.id, { system: 'cardiac', frequency: 3 });
    const { softDeleteHighlight } = await import('./repo');
    await softDeleteHighlight(b.id);

    const answers = async () => ({
      list: await listHighlights({ limit: 50 }),
      detail: await getHighlightDetail(a.id),
      counts: await getCounts(),
      banks: await listBanksWithCounts(),
      tags: await listTags(),
      tree: await listFolderTree(cardio.id),
      trash: await listTrash(),
      notes: await listNotes(),
    });
    const before = await answers();
    const rows = await dump();

    closeDb();
    expect(await dump()).toEqual(rows);
    expect(await answers()).toEqual(before);
    expect((await checkIntegrity()).ok).toBe(true);
  });
});

describe('concurrent callers', () => {
  it('a burst of mixed writes from several contexts leaves a consistent database', async () => {
    const bank = await createBank('Busy');
    const other = await createBank('Other');
    const seeds = [];
    for (let i = 0; i < 6; i++) seeds.push(await save(`Busy fact ${i}`, { bankId: bank.id }));
    const ids = seeds.map((s) => s.id);
    const tagA = (await createTag('alpha')).tag;
    const f1 = await createFolder({ bankId: bank.id, name: 'One' });
    const f2 = await createFolder({ bankId: bank.id, name: 'Two' });

    // Independent connections in one process behave like several extension contexts.
    const results = await Promise.allSettled([
      attachTags({ highlightIds: ids, tagIds: [tagA.id] }),
      bulkMove({ highlightIds: ids.slice(0, 3), toBankId: other.id }),
      bulkTag({ highlightIds: ids.slice(3), addTagIds: [tagA.id] }),
      addToBank({ highlightId: ids[0]!, bankId: bank.id, folderId: f1.id }),
      createFolder({ bankId: bank.id, name: 'Three' }),
      mergeFolders({ sourceId: f2.id, targetId: f1.id }),
      createTag('alpha'),
      createTag('beta'),
      renameFolder(f1.id, 'One renamed'),
      deleteFolder(f1.id),
      createNote({ highlightId: ids[1]!, body: 'parallel note' }),
      setCustomFields(ids[2]!, { k: 'v' }),
    ]);
    // Each call either completed or failed cleanly (for example a folder deleted by another call).
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(['not_found', 'invalid_request']).toContain((r.reason as { code: string }).code);
      }
    }
    const report = await checkIntegrity();
    expect(report.issues).toEqual([]);
    const tags = await listTags();
    expect(tags.filter((t) => t.tag.nameKey === 'alpha')).toHaveLength(1);
    const banks = await listBanks();
    expect(banks.filter((b) => b.isInbox)).toHaveLength(1);
    expect(banks.map((b) => b.id)).toContain(INBOX_BANK_ID);
  });
});

describe('trash round trips', () => {
  it('restores a note, a document and a folder whose parent is still trashed (at the bank root)', async () => {
    const bank = await createBank('Cardiology');
    const parent = await createFolder({ bankId: bank.id, name: 'Parent' });
    const child = await createFolder({ bankId: bank.id, name: 'Child', parentFolderId: parent.id });
    const h = await save('Round trip');
    const note = await createNote({ highlightId: h.id, body: 'n' });
    const { deleteNote } = await import('./notes');
    const { deleteDocument } = await import('./pdf');
    await upsertDocument({
      id: 'e'.repeat(64),
      title: 'Doc',
      pageCount: 1,
      byteLength: 1,
      originalUrl: null,
      textStatus: 'text',
    });
    await deleteNote(note.id);
    await deleteDocument('e'.repeat(64));
    // Trash the child, then the parent: the child's parent is gone when the child comes back first.
    const db = getDb();
    await db.folders.update(child.id, { deletedAt: T, updatedAt: T });
    await db.folders.update(parent.id, { deletedAt: T, updatedAt: T });

    expect(
      await restore([
        { kind: 'note', id: note.id },
        { kind: 'document', id: 'e'.repeat(64) },
        { kind: 'folder', id: child.id },
      ]),
    ).toEqual({ restored: 3 });
    expect((await db.folders.get(child.id))!.parentFolderId).toBeNull();
    expect((await listNotes()).map((n) => n.id)).toEqual([note.id]);
    expect((await db.documents.get('e'.repeat(64)))!.deletedAt).toBeNull();
    expect((await checkIntegrity()).ok).toBe(true);
  });

  it('refuses to restore a folder while its bank is in the trash', async () => {
    const bank = await createBank('Doomed');
    const folder = await createFolder({ bankId: bank.id, name: 'F' });
    await deleteFolder(folder.id);
    const { deleteBank } = await import('./hierarchy');
    await deleteBank(bank.id);
    await expect(restore([{ kind: 'folder', id: folder.id }])).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('tag names', () => {
  it('survives characters that expand a lot under NFKC', async () => {
    const name = 'ﷺ'.repeat(50); // one character -> 18 after normalisation
    const { tag } = await createTag(name);
    expect(tag.nameKey.length).toBeGreaterThan(50);
    expect((await listTags()).map((t) => t.tag.id)).toEqual([tag.id]);
  });
});

describe('live queries (observe) over the vault reads', () => {
  it('re-run after the writes that affect them, without errors', async () => {
    const { observe } = await import('./observe');
    const errors: unknown[] = [];
    const stops: Array<() => void> = [];
    const watch = <T>(query: () => Promise<T>, seen: T[]) =>
      stops.push(
        observe(query).subscribe(
          (v) => seen.push(v),
          (e) => errors.push(e),
        ),
      );
    try {
      const bank = await createBank('Watched');
      const h = await save('Watched quote', { bankId: bank.id });
      const listSeen: number[] = [];
      const tagSeen: number[] = [];
      const countSeen: number[] = [];
      const treeSeen: number[] = [];
      watch(async () => (await listHighlights({ tagIds: [] })).items.length, listSeen);
      watch(async () => (await listTags()).reduce((n, t) => n + t.count, 0), tagSeen);
      watch(async () => (await getCounts()).total, countSeen);
      watch(async () => (await listFolderTree(bank.id)).length, treeSeen);
      await vi.waitFor(() => expect(listSeen.at(-1)).toBe(1));

      const tag = (await createTag('live')).tag;
      await attachTags({ highlightIds: [h.id], tagIds: [tag.id] });
      await vi.waitFor(() => expect(tagSeen.at(-1)).toBe(1));

      await save('A second watched quote', { bankId: bank.id });
      await vi.waitFor(() => expect(listSeen.at(-1)).toBe(2));
      await vi.waitFor(() => expect(countSeen.at(-1)).toBe(2));

      await createFolder({ bankId: bank.id, name: 'Watched folder' });
      await vi.waitFor(() => expect(treeSeen.at(-1)).toBe(1));
      expect(errors).toEqual([]);
    } finally {
      for (const stop of stops) stop();
    }
  });
});
