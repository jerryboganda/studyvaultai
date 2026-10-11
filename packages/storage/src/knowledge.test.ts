// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOX_BANK_ID } from '@shared';
import { getDb } from './db';
import { createFolder } from './hierarchy';
import { addToBank, moveHighlight, removeFromBank } from './membership';
import {
  clearCustomField,
  createNote,
  deleteNote,
  listNotes,
  setCustomFields,
  updateNote,
} from './notes';
import { listHighlights, getCounts, getHighlightDetail } from './query';
import { createBank, getPageHighlights, softDeleteHighlight } from './repo';
import {
  addAlias,
  attachTags,
  createTag,
  deleteTag,
  detachTags,
  listTags,
  mergeTags,
  removeAlias,
  renameTag,
  setTagColor,
} from './tags';
import { freshDatabase, save, saveOn, trackEpochs } from './test-vault';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const rowOf = async (id: string) => (await getDb().highlights.get(id))!;
const memberIds = async (highlightId: string) =>
  (await getDb().highlightBanks.where('highlightId').equals(highlightId).toArray())
    .map((m) => m.bankId)
    .sort();

describe('membership', () => {
  it('files one highlight in several banks without duplicating it', async () => {
    const a = await createBank('Cardiology');
    const b = await createBank('Pharmacology');
    const h = await save('One fact, two banks', { bankId: a.id });

    expect(await addToBank({ highlightId: h.id, bankId: b.id })).toEqual({
      added: true,
      changed: true,
    });
    expect(await getDb().highlights.count()).toBe(1);
    expect(await memberIds(h.id)).toEqual([a.id, b.id].sort());

    // Both banks list the same highlight; the page view reports both banks.
    for (const bankId of [a.id, b.id]) {
      const page = await listHighlights({ bankId });
      expect(page.items.map((i) => i.highlight.id)).toEqual([h.id]);
    }
    const [view] = (await getPageHighlights('https://example.com/notes/pharm', null)).highlights;
    expect(view!.bankIds.sort()).toEqual([a.id, b.id].sort());

    // Adding again is a no-op and does not signal.
    const epochs = trackEpochs();
    expect(await addToBank({ highlightId: h.id, bankId: b.id })).toEqual({
      added: false,
      changed: false,
    });
    expect(epochs).toHaveLength(0);
  });

  it('adding with a folder files it there; the folder must belong to the bank', async () => {
    const a = await createBank('Cardiology');
    const b = await createBank('Pharmacology');
    const folder = await createFolder({ bankId: a.id, name: 'Drugs' });
    const h = await save('Folder test', { bankId: a.id });
    await expect(
      addToBank({ highlightId: h.id, bankId: b.id, folderId: folder.id }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await memberIds(h.id)).toEqual([a.id]);
    const r = await addToBank({ highlightId: h.id, bankId: a.id, folderId: folder.id });
    expect(r).toEqual({ added: false, changed: true });
    const detail = await getHighlightDetail(h.id);
    expect(detail.locations.map((l) => [l.bank.name, l.folderPath.map((f) => f.name)])).toEqual([
      ['Cardiology', ['Drugs']],
    ]);
    await expect(addToBank({ highlightId: 'nope-nope-nope', bankId: a.id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('removing the last non-Inbox membership re-files it in the Inbox; the Inbox itself cannot be emptied', async () => {
    const a = await createBank('Cardiology');
    const b = await createBank('Pharmacology');
    const h = await save('Removal test', { bankId: a.id });
    await addToBank({ highlightId: h.id, bankId: b.id });

    expect(await removeFromBank({ highlightId: h.id, bankId: a.id })).toEqual({
      removed: true,
      rehomedToInbox: false,
    });
    expect(await removeFromBank({ highlightId: h.id, bankId: b.id })).toEqual({
      removed: true,
      rehomedToInbox: true,
    });
    expect(await memberIds(h.id)).toEqual([INBOX_BANK_ID]);
    await expect(
      removeFromBank({ highlightId: h.id, bankId: INBOX_BANK_ID }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await removeFromBank({ highlightId: h.id, bankId: a.id })).toEqual({
      removed: false,
      rehomedToInbox: false,
    });
  });

  it('moveHighlight moves between banks, into a folder, and within a bank', async () => {
    const a = await createBank('Cardiology');
    const b = await createBank('Pharmacology');
    const folder = await createFolder({ bankId: b.id, name: 'Drugs' });
    const h = await save('Move test', { bankId: a.id });

    await moveHighlight({
      highlightId: h.id,
      fromBankId: a.id,
      toBankId: b.id,
      folderId: folder.id,
    });
    const m = await getDb().highlightBanks.where('highlightId').equals(h.id).toArray();
    expect(m.map((x) => [x.bankId, x.folderId])).toEqual([[b.id, folder.id]]);

    // Within the bank: back to the root.
    expect(
      await moveHighlight({ highlightId: h.id, fromBankId: b.id, toBankId: b.id, folderId: null }),
    ).toEqual({ changed: true });
    expect(
      (await getDb().highlightBanks.where('highlightId').equals(h.id).toArray())[0]!.folderId,
    ).toBeNull();

    await expect(
      moveHighlight({ highlightId: h.id, fromBankId: a.id, toBankId: b.id }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('is atomic when the second write fails', async () => {
    const a = await createBank('Cardiology');
    const b = await createBank('Pharmacology');
    const h = await save('Atomic move', { bankId: a.id });
    const db = getDb();
    const before = await db.highlightBanks.toArray();
    const boom = () => {
      throw new Error('injected');
    };
    db.highlightBanks.hook('deleting', boom);
    try {
      await expect(
        moveHighlight({ highlightId: h.id, fromBankId: a.id, toBankId: b.id }),
      ).rejects.toMatchObject({ code: 'internal' });
    } finally {
      db.highlightBanks.hook('deleting').unsubscribe(boom);
    }
    expect(await db.highlightBanks.toArray()).toEqual(before);
  });

  it('bumps the highlight updatedAt so incremental indexing sees the change', async () => {
    const a = await createBank('Cardiology');
    const h = await save('Touch test');
    const before = (await rowOf(h.id)).updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await addToBank({ highlightId: h.id, bankId: a.id });
    expect((await rowOf(h.id)).updatedAt > before).toBe(true);
  });
});

describe('tags', () => {
  it('normalises names: case, spacing and width variants are one tag', async () => {
    const first = await createTag('  Beta   Blockers ');
    expect(first.created).toBe(true);
    expect(first.tag).toMatchObject({ name: 'Beta Blockers', nameKey: 'beta blockers' });
    const again = await createTag('beta blockers');
    expect(again).toMatchObject({ created: false });
    expect(again.tag.id).toBe(first.tag.id);
    const wide = await createTag('ＢＥＴＡ blockers');
    expect(wide.tag.id).toBe(first.tag.id);
    await expect(createTag('   ')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createTag('x'.repeat(51))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('creating the same tag concurrently yields one row', async () => {
    const made = await Promise.all(Array.from({ length: 10 }, () => createTag('Parallel')));
    expect(new Set(made.map((m) => m.tag.id)).size).toBe(1);
    expect(made.filter((m) => m.created)).toHaveLength(1);
    expect(await getDb().tags.count()).toBe(1);
  });

  it('rename, colour, aliases and their conflicts', async () => {
    const a = (await createTag('Cardiology')).tag;
    const b = (await createTag('Pharm')).tag;
    expect((await renameTag(a.id, 'Cardio')).nameKey).toBe('cardio');
    await expect(renameTag(a.id, 'PHARM')).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/Merge/),
    });
    expect((await setTagColor(a.id, 'red')).color).toBe('red');

    const withAlias = await addAlias(b.id, 'Pharmacology');
    expect(withAlias.aliases).toEqual(['Pharmacology']);
    // An alias is a name: nobody else may take it, as a tag or as an alias.
    await expect(createTag('pharmacology')).resolves.toMatchObject({ created: false });
    await expect(addAlias(a.id, 'PHARMACOLOGY')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(addAlias(b.id, 'Pharm')).rejects.toMatchObject({ code: 'invalid_request' });
    // Same alias twice is a no-op.
    expect((await addAlias(b.id, 'pharmacology')).aliases).toEqual(['Pharmacology']);
    expect((await removeAlias(b.id, 'PHARMACOLOGY')).aliases).toEqual([]);

    for (let i = 0; i < 20; i++) await addAlias(b.id, `alias ${i}`);
    await expect(addAlias(b.id, 'one too many')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('attaches and detaches in one transaction; unknown tags change nothing', async () => {
    const h1 = await save('Tag me one');
    const h2 = await save('Tag me two');
    const t1 = (await createTag('One')).tag;
    const t2 = (await createTag('Two')).tag;
    expect(await attachTags({ highlightIds: [h1.id, h2.id], tagIds: [t1.id, t2.id] })).toEqual({
      linked: 4,
    });
    expect(await attachTags({ highlightIds: [h1.id], tagIds: [t1.id] })).toEqual({ linked: 0 });
    await expect(
      attachTags({ highlightIds: [h1.id, h2.id], tagIds: [t1.id, 'tag-missing-001'] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await getDb().highlightTags.count()).toBe(4);

    expect(await detachTags({ highlightIds: [h1.id], tagIds: [t1.id, t2.id] })).toEqual({
      unlinked: 2,
    });
    const detail = await getHighlightDetail(h2.id);
    expect(detail.tags.map((t) => t.name)).toEqual(['One', 'Two']);
  });

  it('lists tags with live counts (trashed highlights do not count)', async () => {
    const h1 = await save('Counted one');
    const h2 = await save('Counted two');
    const h3 = await save('Counted three');
    const t = (await createTag('Counted')).tag;
    const unused = (await createTag('Unused')).tag;
    await attachTags({ highlightIds: [h1.id, h2.id, h3.id], tagIds: [t.id] });
    await softDeleteHighlight(h3.id);
    const list = await listTags();
    expect(list.map((x) => [x.tag.name, x.count])).toEqual([
      ['Counted', 2],
      ['Unused', 0],
    ]);
    expect((await getCounts()).tags).toEqual({ [t.id]: 2 });
    expect(unused).toBeDefined();
  });

  it('merges: links move without duplicates, names become aliases, the source goes to the trash', async () => {
    const h1 = await save('Merge one');
    const h2 = await save('Merge two');
    const keep = (await createTag('Antiplatelet')).tag;
    const gone = (await createTag('Anti-platelet')).tag;
    await addAlias(gone.id, 'APT');
    await attachTags({ highlightIds: [h1.id, h2.id], tagIds: [gone.id] });
    await attachTags({ highlightIds: [h1.id], tagIds: [keep.id] });

    expect(await mergeTags({ sourceId: gone.id, targetId: keep.id })).toEqual({ relinked: 1 });
    const links = await getDb().highlightTags.toArray();
    expect(links.map((l) => `${l.highlightId}:${l.tagId}`).sort()).toEqual(
      [`${h1.id}:${keep.id}`, `${h2.id}:${keep.id}`].sort(),
    );
    const target = (await listTags()).map((x) => x.tag).find((t) => t.id === keep.id)!;
    expect(target.aliases.sort()).toEqual(['APT', 'Anti-platelet']);
    expect((await listTags()).map((x) => x.tag.id)).toEqual([keep.id]);
    await expect(mergeTags({ sourceId: keep.id, targetId: keep.id })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    // The merged-away spelling now finds the surviving tag.
    expect((await createTag('apt')).tag.id).toBe(keep.id);
  });

  it('deleting a tag hides it from filters and lists, and it can come back', async () => {
    const h = await save('Tagged then untagged');
    const t = (await createTag('Temp')).tag;
    await attachTags({ highlightIds: [h.id], tagIds: [t.id] });
    await deleteTag(t.id);
    expect(await listTags()).toEqual([]);
    expect((await getHighlightDetail(h.id)).tags).toEqual([]);
    expect((await listHighlights({ tagIds: [t.id] })).items).toEqual([]);

    const revived = await createTag('temp');
    expect(revived.tag.id).toBe(t.id);
    expect((await getHighlightDetail(h.id)).tags.map((x) => x.name)).toEqual(['temp']);
  });
});

describe('notes', () => {
  it('links to a highlight (and its source) without touching the quote', async () => {
    const h = await save('The immutable quote', { userComment: 'my comment' });
    const before = await rowOf(h.id);
    const note = await createNote({
      highlightId: h.id,
      title: 'Why it matters',
      body: '## Mine\n- one',
    });
    expect(note).toMatchObject({
      highlightId: h.id,
      sourceId: before.sourceId,
      pinned: false,
      deletedAt: null,
    });

    await updateNote(note.id, { body: 'edited body', pinned: true });
    await deleteNote(note.id);
    const after = await rowOf(h.id);
    expect(after.exactQuote).toBe(before.exactQuote);
    expect(after.normalizedQuote).toBe(before.normalizedQuote);
    expect(after.quoteHash).toBe(before.quoteHash);
    expect(after.anchorSet).toEqual(before.anchorSet);
    expect(after.userComment).toBe('my comment');
    expect(after.updatedAt > before.updatedAt).toBe(true);
  });

  it('creates source-only and standalone notes, and validates links', async () => {
    const h = await save('Source of a note');
    const source = await rowOf(h.id);
    const sourceNote = await createNote({ sourceId: source.sourceId, body: 'about the page' });
    expect(sourceNote).toMatchObject({ highlightId: null, sourceId: source.sourceId });
    const standalone = await createNote({ body: 'free thought' });
    expect(standalone).toMatchObject({ highlightId: null, sourceId: null });

    await expect(createNote({ highlightId: 'missing-highlight', body: 'x' })).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
    await expect(createNote({ sourceId: 'missing-source-id', body: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const other = await saveOn('https://example.com/other', 'A quote on another page');
    await expect(
      createNote({ highlightId: other.id, sourceId: source.sourceId, body: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createNote({ body: 'x'.repeat(100_001) })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('lists live notes, pinned first, filtered by highlight / source / pinned', async () => {
    const h = await save('Listing notes');
    const n1 = await createNote({ highlightId: h.id, body: 'first' });
    const n2 = await createNote({ highlightId: h.id, body: 'second', pinned: true });
    const n3 = await createNote({ body: 'standalone' });
    await deleteNote(n3.id);

    expect((await listNotes()).map((n) => n.id)).toEqual([n2.id, n1.id]);
    expect((await listNotes({ highlightId: h.id })).map((n) => n.id)).toEqual([n2.id, n1.id]);
    expect((await listNotes({ pinned: true })).map((n) => n.id)).toEqual([n2.id]);
    expect((await listNotes({ sourceId: n1.sourceId! })).map((n) => n.id)).toEqual([n2.id, n1.id]);
    await expect(deleteNote('missing-note-id-1')).rejects.toMatchObject({ code: 'not_found' });
    await deleteNote(n3.id); // idempotent
    await expect(updateNote(n3.id, { body: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('shows up in the detail and the note count of the dashboard row', async () => {
    const h = await save('Row with notes');
    await createNote({ highlightId: h.id, body: 'a' });
    await createNote({ highlightId: h.id, body: 'b' });
    const page = await listHighlights({ hasNote: true });
    expect(page.items.map((i) => [i.highlight.id, i.noteCount])).toEqual([[h.id, 2]]);
    expect((await getHighlightDetail(h.id)).notes).toHaveLength(2);
  });
});

describe('custom fields', () => {
  it('merges, overwrites, clears and leaves the quote alone', async () => {
    const h = await save('Fielded quote');
    const quote = (await rowOf(h.id)).exactQuote;
    expect(
      await setCustomFields(h.id, { modality: 'MRI', 'exam frequency': 4, reviewed: false }),
    ).toEqual({
      modality: 'MRI',
      'exam frequency': 4,
      reviewed: false,
    });
    expect(await setCustomFields(h.id, { modality: 'CT' })).toEqual({
      modality: 'CT',
      'exam frequency': 4,
      reviewed: false,
    });
    expect(await clearCustomField(h.id, 'reviewed')).toEqual({
      modality: 'CT',
      'exam frequency': 4,
    });
    expect(await clearCustomField(h.id, 'never set')).toEqual({
      modality: 'CT',
      'exam frequency': 4,
    });
    expect((await rowOf(h.id)).exactQuote).toBe(quote);
    expect((await getHighlightDetail(h.id)).customFields).toEqual({
      modality: 'CT',
      'exam frequency': 4,
    });
  });

  it('validates keys, values and the 32-field limit, changing nothing on failure', async () => {
    const h = await save('Strict fields');
    await setCustomFields(h.id, { keep: 'me' });
    const reject = (fields: Record<string, unknown>) =>
      expect(setCustomFields(h.id, fields as never)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    await reject({ ['k'.repeat(65)]: 'x' });
    await reject({ '': 'x' });
    await reject({ ' padded ': 'x' });
    await reject({ ['bad\nkey']: 'x' });
    await reject(JSON.parse('{"__proto__": "x"}'));
    await reject({ long: 'v'.repeat(501) });
    await reject({ nested: { a: 1 } });
    await reject({ nan: Number.NaN });
    await reject({ list: ['a'] });
    await setCustomFields(h.id, { ['k'.repeat(64)]: 'v'.repeat(500) });

    // 32 fields in total are allowed, the 33rd is not.
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, i]));
    await setCustomFields(h.id, many); // keep + 'k..' + 30 = 32
    await reject({ one_more: 1 });
    expect(Object.keys((await rowOf(h.id)).customFields!)).toHaveLength(32);
    expect((await rowOf(h.id)).customFields!.keep).toBe('me');
  });

  it('does not signal when nothing changed and rejects unknown highlights', async () => {
    const h = await save('Quiet fields');
    await setCustomFields(h.id, { a: 1 });
    const epochs = trackEpochs();
    await setCustomFields(h.id, { a: 1 });
    expect(epochs).toHaveLength(0);
    await expect(setCustomFields('missing-highlight', { a: 1 })).rejects.toMatchObject({
      code: 'not_found',
    });
    await softDeleteHighlight(h.id);
    await expect(setCustomFields(h.id, { a: 2 })).rejects.toMatchObject({ code: 'not_found' });
  });
});
