// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOX_BANK_ID } from '@shared';
import {
  bulkDelete,
  bulkMove,
  bulkRestore,
  bulkSetColor,
  bulkSetKind,
  bulkSetPriority,
  bulkTag,
} from './bulk';
import { getDb } from './db';
import { createFolder, deleteBank, deleteFolder } from './hierarchy';
import { addToBank } from './membership';
import { createNote } from './notes';
import { listHighlights } from './query';
import { createBank, listBanks, softDeleteHighlight } from './repo';
import { attachTags, createTag } from './tags';
import { emptyTrash, getLastPurgeAt, listTrash, purge, purgeOlderThan, restore } from './trash';
import { dump, freshDatabase, save, saveOn, trackEpochs } from './test-vault';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const rowOf = async (id: string) => (await getDb().highlights.get(id))!;

async function makeFive() {
  const out = [];
  for (let i = 0; i < 5; i++) out.push(await save(`Bulk subject number ${i}`));
  return out;
}

describe('bulk edits', () => {
  it('sets kind, colour and priority on every selected highlight in one call', async () => {
    const hs = await makeFive();
    const ids = hs.map((h) => h.id);
    expect(await bulkSetKind(ids, 'formula')).toEqual({ requested: 5, changed: 5 });
    expect(await bulkSetColor(ids, 'green')).toEqual({ requested: 5, changed: 5 });
    expect(await bulkSetPriority(ids, 5)).toEqual({ requested: 5, changed: 5 });
    expect(await bulkSetPriority(ids, 5)).toEqual({ requested: 5, changed: 0 });
    for (const id of ids) {
      expect(await rowOf(id)).toMatchObject({ kind: 'formula', color: 'green', priority: 5 });
    }
    await expect(bulkSetPriority(ids, 9 as never)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(bulkSetKind(['not a valid id!!'], 'formula')).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('is all-or-nothing: one unknown id changes nothing', async () => {
    const hs = await makeFive();
    const before = await dump();
    const ids = [...hs.map((h) => h.id), 'missing-highlight-id'];
    await expect(bulkSetKind(ids, 'formula')).rejects.toMatchObject({ code: 'not_found' });
    await expect(bulkDelete(ids)).rejects.toMatchObject({ code: 'not_found' });
    await expect(bulkMove({ highlightIds: ids, toBankId: INBOX_BANK_ID })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await dump()).toEqual(before);
  });

  it('is all-or-nothing under an injected write failure half way', async () => {
    const hs = await makeFive();
    const db = getDb();
    const before = await db.highlights.toArray();
    let calls = 0;
    const boom = () => {
      if (++calls === 3) throw new Error('injected on the third write');
    };
    db.highlights.hook('updating', boom);
    try {
      await expect(
        bulkSetKind(
          hs.map((h) => h.id),
          'weak_area',
        ),
      ).rejects.toMatchObject({
        code: 'internal',
      });
    } finally {
      db.highlights.hook('updating').unsubscribe(boom);
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(await db.highlights.toArray()).toEqual(before);
  });

  it('bulkMove with a source bank moves only that membership; without one it files exclusively', async () => {
    const a = await createBank('A');
    const b = await createBank('B');
    const c = await createBank('C');
    const folder = await createFolder({ bankId: c.id, name: 'Target folder' });
    const h1 = await save('Move one', { bankId: a.id });
    const h2 = await save('Move two', { bankId: a.id });
    await addToBank({ highlightId: h1.id, bankId: b.id });

    expect(
      await bulkMove({
        highlightIds: [h1.id, h2.id],
        fromBankId: a.id,
        toBankId: c.id,
        folderId: folder.id,
      }),
    ).toEqual({ requested: 2, changed: 2 });
    const members = async (id: string) =>
      (await getDb().highlightBanks.where('highlightId').equals(id).toArray())
        .map((m) => `${m.bankId}${m.folderId ? '/f' : ''}`)
        .sort();
    expect(await members(h1.id)).toEqual([b.id, `${c.id}/f`].sort());
    expect(await members(h2.id)).toEqual([`${c.id}/f`]);

    expect(await bulkMove({ highlightIds: [h1.id], toBankId: a.id })).toEqual({
      requested: 1,
      changed: 1,
    });
    expect(await members(h1.id)).toEqual([a.id]);
    // Folder of another bank is refused and nothing moves.
    await expect(
      bulkMove({ highlightIds: [h1.id], toBankId: a.id, folderId: folder.id }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await members(h1.id)).toEqual([a.id]);
  });

  it('bulkTag adds and removes tags together', async () => {
    const hs = await makeFive();
    const ids = hs.map((h) => h.id);
    const t1 = (await createTag('First')).tag;
    const t2 = (await createTag('Second')).tag;
    await attachTags({ highlightIds: ids, tagIds: [t1.id] });
    expect(await bulkTag({ highlightIds: ids, addTagIds: [t2.id], removeTagIds: [t1.id] })).toEqual(
      {
        requested: 5,
        changed: 5,
      },
    );
    const links = await getDb().highlightTags.toArray();
    expect(links.every((l) => l.tagId === t2.id)).toBe(true);
    expect(links).toHaveLength(5);
    expect(await bulkTag({ highlightIds: ids, addTagIds: [t2.id] })).toEqual({
      requested: 5,
      changed: 0,
    });
    await expect(
      bulkTag({ highlightIds: ids, addTagIds: ['tag-missing-0001'] }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('bulkDelete then bulkRestore round-trips and the tail of an interrupted call never half-applies', async () => {
    const hs = await makeFive();
    const ids = hs.map((h) => h.id);
    expect(await bulkDelete(ids.slice(0, 3))).toEqual({ requested: 3, changed: 3 });
    expect(await bulkDelete(ids.slice(0, 3))).toEqual({ requested: 3, changed: 0 });
    expect((await listHighlights({})).items).toHaveLength(2);
    expect(await bulkRestore(ids)).toEqual({ requested: 5, changed: 3 });
    expect((await listHighlights({})).items).toHaveLength(5);
  });

  it('refuses an oversized selection', async () => {
    const ids = Array.from({ length: 20_001 }, (_, i) => `id-${String(i).padStart(8, '0')}`);
    await expect(bulkDelete(ids)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('trash', () => {
  it('lists every kind, newest deletion first, with readable labels', async () => {
    const bank = await createBank('Doomed bank');
    const h = await save('A quote that will be deleted', { bankId: bank.id });
    const note = await createNote({ highlightId: h.id, title: 'My note', body: 'b' });
    const folder = await createFolder({ bankId: bank.id, name: 'Doomed folder' });
    const tag = (await createTag('Doomed tag')).tag;
    const { deleteTag } = await import('./tags');
    const { deleteNote } = await import('./notes');
    const { upsertDocument, deleteDocument } = await import('./pdf');
    await upsertDocument({
      id: 'a'.repeat(64),
      title: 'Doomed pdf',
      pageCount: 3,
      byteLength: 10,
      originalUrl: null,
      textStatus: 'text',
    });

    await softDeleteHighlight(h.id);
    await deleteNote(note.id);
    await deleteFolder(folder.id);
    await deleteTag(tag.id);
    await deleteDocument('a'.repeat(64));
    await deleteBank(bank.id);

    const trash = await listTrash();
    expect(trash.map((t) => t.kind).sort()).toEqual([
      'bank',
      'document',
      'folder',
      'highlight',
      'note',
      'tag',
    ]);
    expect(trash.find((t) => t.kind === 'highlight')).toMatchObject({
      id: h.id,
      label: 'A quote that will be deleted',
      context: 'Pharmacology notes',
    });
    // The folder went to the trash together with its bank (and once on its own before).
    expect(trash.find((t) => t.kind === 'folder')).toMatchObject({ id: folder.id });
    expect(trash.find((t) => t.kind === 'bank')).toMatchObject({ label: 'Doomed bank' });
    for (let i = 1; i < trash.length; i++) {
      expect(trash[i - 1]!.deletedAt >= trash[i]!.deletedAt).toBe(true);
    }
    expect((await listTrash({ kinds: ['tag', 'note'] })).map((t) => t.kind).sort()).toEqual([
      'note',
      'tag',
    ]);
    await expect(listTrash({ kinds: ['nope' as never] })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('restoring a highlight revives it and files it somewhere visible', async () => {
    const bank = await createBank('Only home');
    const h = await save('Homeless after restore', { bankId: bank.id });
    await softDeleteHighlight(h.id);
    await deleteBank(bank.id);
    // Remove the Inbox copy a bank deletion would have made, to force the "no live bank" case.
    await getDb().highlightBanks.delete([h.id, INBOX_BANK_ID]);

    expect(await restore([h.id])).toEqual({ restored: 1 });
    const page = await listHighlights({});
    expect(page.items.map((i) => [i.highlight.id, i.banks.map((b) => b.id)])).toEqual([
      [h.id, [INBOX_BANK_ID]],
    ]);
    // Restoring something that is not in the trash is a no-op; unknown ids are an error.
    expect(await restore([h.id])).toEqual({ restored: 0 });
    await expect(restore(['missing-item-id'])).rejects.toMatchObject({ code: 'not_found' });
  });

  it('restoring a tag whose name is taken is refused', async () => {
    const { deleteTag } = await import('./tags');
    const t = (await createTag('Name')).tag;
    await deleteTag(t.id);
    const newer = (await createTag('Name')).tag; // revives t itself: same row
    expect(newer.id).toBe(t.id);
    await deleteTag(t.id);
    // Force a clash: a different live tag with the same key.
    await getDb().tags.put({
      ...(await getDb().tags.get(t.id))!,
      id: 'tag-other-0001',
      deletedAt: null,
    });
    await expect(restore([{ kind: 'tag', id: t.id }])).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  describe('purge', () => {
    async function seedFamily() {
      const keep = await save('A quote that stays');
      const doomed = await save('A quote that will be purged', { kind: 'question' });
      const other = await saveOn('https://example.com/lonely', 'The only quote of a lonely page');
      const tag = (await createTag('Linked')).tag;
      await attachTags({ highlightIds: [doomed.id, keep.id], tagIds: [tag.id] });
      const note = await createNote({ highlightId: doomed.id, body: 'goes with it' });
      const db = getDb();
      await db.knowledgePoints.put({ id: 'kp-0000000001', highlightId: doomed.id });
      await db.cards.bulkPut([
        { id: 'card-0000001', highlightId: doomed.id, deckId: 'deck-0000001' },
        { id: 'card-0000002', knowledgePointId: 'kp-0000000001', deckId: 'deck-0000001' },
        { id: 'card-0000003', highlightId: keep.id, deckId: 'deck-0000001' },
      ]);
      await db.reviewLogs.bulkPut([
        { id: 'log-0000001', cardId: 'card-0000001' },
        { id: 'log-0000002', cardId: 'card-0000002' },
        { id: 'log-0000003', cardId: 'card-0000003' },
      ]);
      await db.aiResults.bulkPut([
        { id: 'ai-0000001', highlightId: doomed.id },
        { id: 'ai-0000002', highlightId: keep.id },
      ]);
      await bulkDelete([doomed.id, other.id]);
      return { keep, doomed, other, tag, note };
    }

    it('removes the highlight and everything that hangs off it, and nothing else', async () => {
      const { keep, doomed, other, tag, note } = await seedFamily();
      const db = getDb();
      const result = await purge([doomed.id]);
      expect(result.purged).toMatchObject({ highlight: 1, note: 0 });
      expect(result.related).toMatchObject({
        memberships: 1,
        tagLinks: 1,
        notes: 1,
        cards: 2,
        reviewLogs: 2,
        knowledgePoints: 1,
        aiResults: 1,
        sources: 0, // the source still has the kept highlight
      });
      expect(await db.highlights.get(doomed.id)).toBeUndefined();
      expect(await db.notes.get(note.id)).toBeUndefined();
      expect((await db.cards.toArray()).map((c) => c.id)).toEqual(['card-0000003']);
      expect((await db.reviewLogs.toArray()).map((c) => c.id)).toEqual(['log-0000003']);
      expect((await db.aiResults.toArray()).map((c) => c.id)).toEqual(['ai-0000002']);
      expect(await db.knowledgePoints.count()).toBe(0);
      expect((await db.highlightTags.toArray()).map((l) => l.highlightId)).toEqual([keep.id]);
      expect(await db.tags.get(tag.id)).toBeDefined();
      expect(await db.highlights.get(other.id)).toBeDefined(); // still in the trash
      expect(await getLastPurgeAt()).not.toBeNull();
    });

    it('drops a source only when nothing live or trashed refers to it any more', async () => {
      const { other, keep } = await seedFamily();
      const db = getDb();
      const otherSource = (await db.highlights.get(other.id))!.sourceId;
      const keepSource = (await db.highlights.get(keep.id))!.sourceId;
      const result = await purge([other.id]);
      expect(result.related.sources).toBe(1);
      expect(await db.sources.get(otherSource)).toBeUndefined();
      expect(await db.sources.get(keepSource)).toBeDefined();
    });

    it('refuses live items, leaving everything as it was', async () => {
      const { keep, doomed } = await seedFamily();
      const before = await dump();
      await expect(purge([doomed.id, keep.id])).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringMatching(/Only items in the trash/),
      });
      expect(await dump()).toEqual(before);
    });

    it('is idempotent for ids that are already gone', async () => {
      const { doomed } = await seedFamily();
      await purge([doomed.id]);
      const again = await purge([doomed.id]);
      expect(Object.values(again.purged).every((n) => n === 0)).toBe(true);
    });

    it('is atomic under an injected failure part way through the cleanup', async () => {
      const { doomed } = await seedFamily();
      const db = getDb();
      const before = await dump();
      const boom = () => {
        throw new Error('injected');
      };
      db.reviewLogs.hook('deleting', boom);
      try {
        await expect(purge([doomed.id])).rejects.toMatchObject({ code: 'internal' });
      } finally {
        db.reviewLogs.hook('deleting').unsubscribe(boom);
      }
      expect(await dump()).toEqual(before);
    });

    it('purging a bank keeps its highlights (already re-homed) and removes its folders', async () => {
      const bank = await createBank('Purged bank');
      const folder = await createFolder({ bankId: bank.id, name: 'F' });
      const h = await save('Survives the bank', { bankId: bank.id });
      await addToBank({ highlightId: h.id, bankId: bank.id, folderId: folder.id });
      await deleteBank(bank.id);

      const result = await purge([{ kind: 'bank', id: bank.id }]);
      expect(result.purged.bank).toBe(1);
      expect(await getDb().folders.get(folder.id)).toBeUndefined();
      expect((await listBanks()).map((b) => b.id)).toEqual([INBOX_BANK_ID]);
      const page = await listHighlights({});
      expect(page.items.map((i) => [i.highlight.id, i.banks.map((b) => b.id)])).toEqual([
        [h.id, [INBOX_BANK_ID]],
      ]);
      await expect(purge([{ kind: 'bank', id: INBOX_BANK_ID }])).rejects.toMatchObject({
        code: 'invalid_request',
      });
    });

    it('purging a document removes its bytes and OCR text but keeps the highlights made in it', async () => {
      const { upsertDocument, deleteDocument, cacheDocumentBytes, saveOcrPage, savePdfHighlight } =
        await import('./pdf');
      const id = 'f'.repeat(64);
      await upsertDocument({
        id,
        title: 'Paper',
        pageCount: 2,
        byteLength: 4,
        originalUrl: null,
        textStatus: 'scanned',
      });
      await cacheDocumentBytes(id, new Blob(['%PDF'], { type: 'application/pdf' }));
      await saveOcrPage({
        documentId: id,
        pageNumber: 1,
        text: 'hello',
        language: 'eng',
        engine: 't',
      });
      const saved = await savePdfHighlight({
        documentId: id,
        anchorSet: {
          type: 'pdf',
          textAlgorithm: 'sv-pdf-text-v1',
          documentFingerprint: id,
          pageNumber: 1,
          rotation: 0,
          rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.05 }],
          textQuote: { exact: 'hello', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 5 },
          contentSignature: 'sig',
          documentTextLength: 5,
        },
        exactQuote: 'hello',
        kind: 'essential',
        color: 'amber',
        bankId: null,
        userComment: '',
        priority: 3,
        captureMethod: 'toolbar',
      });
      await deleteDocument(id);
      const result = await purge([{ kind: 'document', id }]);
      expect(result.purged.document).toBe(1);
      expect(result.related).toMatchObject({ attachments: 1, ocrPages: 1 });
      const db = getDb();
      expect(await db.documents.count()).toBe(0);
      expect(await db.attachments.count()).toBe(0);
      expect(await db.ocrPages.count()).toBe(0);
      expect(await db.highlights.get(saved.highlight.id)).toBeDefined();
    });
  });

  it('emptyTrash purges everything trashed (optionally only some kinds) and only that', async () => {
    const a = await save('Trashed highlight');
    const b = await save('Live highlight');
    const tag = (await createTag('Trashed tag')).tag;
    const { deleteTag } = await import('./tags');
    await deleteTag(tag.id);
    await softDeleteHighlight(a.id);

    const partial = await emptyTrash(['tag']);
    expect(partial.purged).toMatchObject({ tag: 1, highlight: 0 });
    expect(await getDb().highlights.get(a.id)).toBeDefined();

    const rest = await emptyTrash();
    expect(rest.purged.highlight).toBe(1);
    expect(await listTrash()).toEqual([]);
    expect(await getDb().highlights.get(b.id)).toBeDefined();
    expect(await getDb().highlights.get(a.id)).toBeUndefined();
  });

  it('purgeOlderThan keeps recent deletions and purges old ones', async () => {
    const old = await save('Deleted long ago');
    const recent = await save('Deleted just now');
    await softDeleteHighlight(old.id);
    await softDeleteHighlight(recent.id);
    // Age one of them by rewriting its deletion time.
    const db = getDb();
    const longAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await db.highlights.update(old.id, { deletedAt: longAgo });

    const nothing = await purgeOlderThan(60);
    expect(Object.values(nothing.purged).every((n) => n === 0)).toBe(true);
    const result = await purgeOlderThan(30);
    expect(result.purged.highlight).toBe(1);
    expect(await db.highlights.get(old.id)).toBeUndefined();
    expect(await db.highlights.get(recent.id)).toBeDefined();

    // A fixed clock makes the cutoff explicit.
    const later = await purgeOlderThan(1, { now: new Date(Date.now() + 2 * 86_400_000) });
    expect(later.purged.highlight).toBe(1);
    await expect(purgeOlderThan(-1)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('does not signal when a purge removes nothing', async () => {
    await save('Live only');
    const epochs = trackEpochs();
    await emptyTrash();
    expect(epochs).toHaveLength(0);
  });
});
