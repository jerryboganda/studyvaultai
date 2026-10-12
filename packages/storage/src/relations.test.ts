// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RELATION_NOTE_CHARS, Relation, type HighlightView } from '@shared';
import { closeDb, getDb } from './db';
import { createNote, deleteNote } from './notes';
import {
  createRelation,
  deleteRelation,
  dropRelationsOf,
  getRelation,
  listAllRelations,
  listRelationsFor,
  pruneDanglingRelations,
  purgeRelations,
  restoreRelation,
  updateRelationNote,
  type RelationInput,
} from './relations';
import { checkIntegrity, relationKey } from './registry';
import { restoreHighlight, softDeleteHighlight } from './repo';
import { createKnowledgePoint } from './study';
import { freshDatabase, save, trackEpochs } from './test-vault';
import { purge } from './trash';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

interface World {
  h1: HighlightView;
  h2: HighlightView;
  note: { id: string };
  kp: { id: string };
}

async function world(): Promise<World> {
  const h1 = await save('Aspirin irreversibly inhibits cyclooxygenase in platelets.');
  const h2 = await save('Clopidogrel blocks the P2Y12 receptor on platelets.');
  const note = await createNote({ highlightId: h1.id, body: 'Both are antiplatelets.' });
  const kp = await createKnowledgePoint({ highlightId: h1.id, shortOneLiner: 'COX-1 block' });
  return { h1, h2, note, kp };
}

const link = (w: World, over: Partial<RelationInput> = {}): RelationInput => ({
  fromKind: 'highlight',
  fromId: w.h1.id,
  toKind: 'highlight',
  toId: w.h2.id,
  type: 'contradicts',
  ...over,
});

describe('creating a relation', () => {
  it('links any two of the three kinds and stores a valid row', async () => {
    const w = await world();
    const made = await createRelation(link(w, { note: '  same drug class  ', type: 'related' }));
    expect(made.status).toBe('created');
    expect(Relation.safeParse(made.relation).success).toBe(true);
    expect(made.relation).toMatchObject({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'related',
      note: 'same drug class',
      deletedAt: null,
      schemaVersion: 1,
    });
    const kinds = await createRelation({
      fromKind: 'knowledgePoint',
      fromId: w.kp.id,
      toKind: 'note',
      toId: w.note.id,
      type: 'supports',
    });
    expect(kinds.status).toBe('created');
    expect(kinds.relation).not.toHaveProperty('note'); // no note, no key
    expect(await getRelation(made.relation.id)).toEqual(made.relation);
    closeDb();
    expect(await getRelation(made.relation.id)).toEqual(made.relation);
  });

  it('refuses a link to itself, an unknown end, an end in the trash, and a long note', async () => {
    const w = await world();
    await expect(createRelation(link(w, { toId: w.h1.id }))).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/itself/),
    });
    await expect(
      createRelation(link(w, { toId: 'highlight-does-not-exist' })),
    ).rejects.toMatchObject({ code: 'not_found' });
    // the right id of the wrong kind is not found either
    await expect(createRelation(link(w, { toKind: 'note', toId: w.h2.id }))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      createRelation(link(w, { note: 'n'.repeat(MAX_RELATION_NOTE_CHARS + 1) })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createRelation(link(w, { type: 'friends' as never }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(createRelation(link(w, { toKind: 'bank' as never }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await softDeleteHighlight(w.h2.id);
    await expect(createRelation(link(w))).rejects.toMatchObject({ code: 'not_found' });
    expect(await getDb().relations.count()).toBe(0);
  });

  it('is unique by (from, to, type): a repeat returns the link that exists', async () => {
    const w = await world();
    const first = await createRelation(link(w));
    const epochs = trackEpochs();
    const again = await createRelation(link(w, { note: 'ignored for an existing link' }));
    expect(again.status).toBe('existing');
    expect(again.relation).toEqual(first.relation);
    expect(epochs).toHaveLength(0);
    // another type, or the other direction of a directed type, is another link
    expect((await createRelation(link(w, { type: 'supports' }))).status).toBe('created');
    expect((await createRelation(link(w, { fromId: w.h2.id, toId: w.h1.id }))).status).toBe(
      'created',
    );
    expect(await getDb().relations.count()).toBe(3);
  });

  it('"related" has no direction: A to B and B to A are one link', async () => {
    const w = await world();
    const ab = await createRelation(link(w, { type: 'related' }));
    const ba = await createRelation(link(w, { type: 'related', fromId: w.h2.id, toId: w.h1.id }));
    expect(ba.status).toBe('existing');
    expect(ba.relation.id).toBe(ab.relation.id);
    expect(await getDb().relations.count()).toBe(1);
    expect(
      relationKey({
        fromKind: 'highlight',
        fromId: 'a',
        toKind: 'note',
        toId: 'b',
        type: 'related',
      }),
    ).toBe(
      relationKey({
        fromKind: 'note',
        fromId: 'b',
        toKind: 'highlight',
        toId: 'a',
        type: 'related',
      }),
    );
    expect(
      relationKey({ fromKind: 'highlight', fromId: 'a', toKind: 'note', toId: 'b', type: 'cause' }),
    ).not.toBe(
      relationKey({ fromKind: 'note', fromId: 'b', toKind: 'highlight', toId: 'a', type: 'cause' }),
    );
  });

  it('two creations at once leave one row', async () => {
    const w = await world();
    const [a, b] = await Promise.all([createRelation(link(w)), createRelation(link(w))]);
    expect([a.status, b.status].sort()).toEqual(['created', 'existing']);
    expect(await getDb().relations.count()).toBe(1);
  });
});

describe('reading', () => {
  it('lists what touches an item by direction and type, oldest first', async () => {
    const w = await world();
    const out = await createRelation(link(w, { type: 'supports' }));
    const inbound = await createRelation(
      link(w, { fromId: w.h2.id, toId: w.h1.id, type: 'cause' }),
    );
    const other = await createRelation({
      fromKind: 'note',
      fromId: w.note.id,
      toKind: 'highlight',
      toId: w.h1.id,
      type: 'example',
    });
    const ref = { kind: 'highlight' as const, id: w.h1.id };
    expect((await listRelationsFor(ref)).map((r) => r.id)).toEqual([
      out.relation.id,
      inbound.relation.id,
      other.relation.id,
    ]);
    expect((await listRelationsFor(ref, { direction: 'from' })).map((r) => r.id)).toEqual([
      out.relation.id,
    ]);
    expect((await listRelationsFor(ref, { direction: 'to' })).map((r) => r.id)).toEqual([
      inbound.relation.id,
      other.relation.id,
    ]);
    expect(
      (await listRelationsFor(ref, { types: ['cause', 'example'] })).map((r) => r.type),
    ).toEqual(['cause', 'example']);
    expect(await listRelationsFor({ kind: 'knowledgePoint', id: w.kp.id })).toEqual([]);
    expect((await listAllRelations()).map((r) => r.id)).toHaveLength(3);
    expect((await listAllRelations({ limit: 2 })).map((r) => r.id)).toHaveLength(2);
    expect((await listAllRelations({ types: ['supports'] })).map((r) => r.id)).toEqual([
      out.relation.id,
    ]);
  });

  it('hides a relation while an end is in the trash and shows it again when that end is restored', async () => {
    const w = await world();
    const made = await createRelation(link(w));
    await softDeleteHighlight(w.h2.id);
    expect(await listRelationsFor({ kind: 'highlight', id: w.h1.id })).toEqual([]);
    expect(await listAllRelations()).toEqual([]);
    // the relation row itself was not touched: there is nothing to un-delete
    expect((await getDb().relations.get(made.relation.id))!.deletedAt).toBeNull();
    await restoreHighlight(w.h2.id);
    expect((await listRelationsFor({ kind: 'highlight', id: w.h1.id })).map((r) => r.id)).toEqual([
      made.relation.id,
    ]);
    // a note in the trash hides links to the note, too
    const viaNote = await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'note',
      toId: w.note.id,
      type: 'example',
    });
    await deleteNote(w.note.id);
    expect((await listAllRelations()).map((r) => r.id)).toEqual([made.relation.id]);
    expect(viaNote.relation.id).toBeDefined();
  });

  it('folds two rows of one link into one (what two synced devices can produce) and reports them', async () => {
    const w = await world();
    const first = await createRelation(link(w));
    const copy: Relation = {
      ...first.relation,
      id: 'relation-copy-0001',
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    await getDb().relations.add(copy);
    const listed = await listRelationsFor({ kind: 'highlight', id: w.h1.id });
    expect(listed.map((r) => r.id)).toEqual([first.relation.id]); // the older one
    const report = await checkIntegrity();
    expect(report.issues.filter((i) => i.table === 'relations')).toEqual([
      expect.objectContaining({ code: 'duplicate_relation', key: copy.id }),
    ]);
  });
});

describe('note, delete, restore, purge', () => {
  it('sets, replaces and clears a note, and is optimistic', async () => {
    const w = await world();
    const made = (await createRelation(link(w))).relation;
    const set = await updateRelationNote(made.id, '  because platelets  ');
    expect(set).toMatchObject({ status: 'saved', row: { note: 'because platelets' } });
    const stale = await updateRelationNote(made.id, 'mine', { expectedVersion: made.updatedAt });
    expect(stale).toMatchObject({ status: 'stale', row: { note: 'because platelets' } });
    const cleared = await updateRelationNote(made.id, '', { expectedVersion: set.row.updatedAt });
    expect(cleared.status).toBe('saved');
    expect(cleared.row).not.toHaveProperty('note');
    const epochs = trackEpochs();
    await updateRelationNote(made.id, ''); // already empty: no write
    expect(epochs).toHaveLength(0);
    await expect(updateRelationNote(made.id, 'x'.repeat(501))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(updateRelationNote('relation-does-not-exist', 'x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('deletes softly, undoes, and creating the same link again revives the deleted row', async () => {
    const w = await world();
    const made = (await createRelation(link(w, { note: 'keep me' }))).relation;
    await deleteRelation(made.id);
    await deleteRelation(made.id); // not an error
    expect(await getRelation(made.id)).toBeNull();
    expect(await listAllRelations()).toEqual([]);
    const back = await restoreRelation(made.id);
    expect(back).toMatchObject({ id: made.id, deletedAt: null, note: 'keep me' });
    expect((await listAllRelations()).map((r) => r.id)).toEqual([made.id]);

    await deleteRelation(made.id);
    const again = await createRelation(link(w));
    expect(again).toMatchObject({ status: 'restored', relation: { id: made.id, note: 'keep me' } });
    await deleteRelation(made.id);
    const renoted = await createRelation(link(w, { note: 'new words' }));
    expect(renoted).toMatchObject({ status: 'restored', relation: { note: 'new words' } });
    expect(await getDb().relations.count()).toBe(1);
  });

  it('purges only deleted relations', async () => {
    const w = await world();
    const a = (await createRelation(link(w, { type: 'supports' }))).relation;
    const b = (await createRelation(link(w, { type: 'cause' }))).relation;
    await expect(purgeRelations([a.id])).rejects.toMatchObject({ code: 'invalid_request' });
    await deleteRelation(a.id);
    expect(await purgeRelations([a.id, 'relation-already-gone'])).toBe(1);
    await deleteRelation(b.id);
    expect(await purgeRelations()).toBe(1);
    expect(await getDb().relations.count()).toBe(0);
  });
});

describe('when an end is purged', () => {
  it('removes every relation that touches it, in the same transaction, and nothing else', async () => {
    const w = await world();
    const h3 = await save('Heparin potentiates antithrombin III.');
    const onH1 = await createRelation(link(w, { type: 'supports' }));
    const viaNote = await createRelation({
      fromKind: 'note',
      fromId: w.note.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'example',
    });
    const viaKp = await createRelation({
      fromKind: 'highlight',
      fromId: w.h2.id,
      toKind: 'knowledgePoint',
      toId: w.kp.id,
      type: 'cause',
    });
    const unrelated = await createRelation({
      fromKind: 'highlight',
      fromId: w.h2.id,
      toKind: 'highlight',
      toId: h3.id,
      type: 'related',
    });
    // a deleted relation that touches the end goes too
    const deleted = await createRelation(link(w, { type: 'prerequisite' }));
    await deleteRelation(deleted.relation.id);

    // h1 owns the note and the knowledge point: all three ends disappear with it
    await softDeleteHighlight(w.h1.id);
    await purge([{ kind: 'highlight', id: w.h1.id }]);

    const left = (await getDb().relations.toArray()).map((r) => r.id);
    expect(left).toEqual([unrelated.relation.id]);
    expect([onH1, viaNote, viaKp, deleted].map((r) => r.relation.id)).not.toContain(left[0]);
    expect((await checkIntegrity()).issues.filter((i) => i.table === 'relations')).toEqual([]);
  });

  it('a purged note takes its relations; the highlight it was written on keeps its own', async () => {
    const w = await world();
    const toNote = await createRelation({
      fromKind: 'highlight',
      fromId: w.h2.id,
      toKind: 'note',
      toId: w.note.id,
      type: 'example',
    });
    const between = await createRelation(link(w));
    await deleteNote(w.note.id);
    await purge([{ kind: 'note', id: w.note.id }]);
    const left = (await getDb().relations.toArray()).map((r) => r.id);
    expect(left).toEqual([between.relation.id]);
    expect(left).not.toContain(toNote.relation.id);
  });

  it('dropRelationsOf finds links by either end', async () => {
    const w = await world();
    const a = await createRelation(link(w));
    const b = await createRelation(link(w, { fromId: w.h2.id, toId: w.h1.id, type: 'cause' }));
    const db = getDb();
    const removed = await db.transaction('rw', db.relations, () => dropRelationsOf(db, [w.h2.id]));
    expect(removed.sort()).toEqual([a.relation.id, b.relation.id].sort());
    expect(await db.relations.count()).toBe(0);
  });
});

describe('dangling relations', () => {
  it('are reported by the integrity check and removed by pruneDanglingRelations', async () => {
    const w = await world();
    const ok = await createRelation(link(w));
    const db = getDb();
    const orphan: Relation = {
      ...ok.relation,
      id: 'relation-orphan-001',
      type: 'cause',
      toId: 'highlight-vanished-01',
    };
    await db.relations.add(orphan);
    const report = await checkIntegrity();
    expect(report.issues).toEqual([
      expect.objectContaining({
        table: 'relations',
        key: orphan.id,
        code: 'orphan_reference',
        message: expect.stringMatching(/toId references a missing highlights row/),
      }),
    ]);
    expect(await pruneDanglingRelations()).toBe(1);
    expect((await db.relations.toArray()).map((r) => r.id)).toEqual([ok.relation.id]);
    expect((await checkIntegrity()).ok).toBe(true);
    expect(await pruneDanglingRelations()).toBe(0);
  });

  it('an end that is only in the trash is not dangling', async () => {
    const w = await world();
    await createRelation(link(w));
    await softDeleteHighlight(w.h2.id);
    expect((await checkIntegrity()).issues).toEqual([]);
    expect(await pruneDanglingRelations()).toBe(0);
  });
});
