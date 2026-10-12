// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INBOX_BANK_ID,
  MAX_SYLLABI,
  MAX_SYLLABUS_DEPTH,
  MAX_SYLLABUS_NODES,
  Syllabus,
  flattenSyllabus,
} from '@shared';
import { closeDb, getDb } from './db';
import { deleteBank } from './hierarchy';
import { createBank } from './repo';
import {
  checkSyllabi,
  createSyllabus,
  deleteSyllabus,
  getSyllabus,
  listSyllabi,
  purgeSyllabi,
  restoreSyllabus,
  updateSyllabus,
  type SyllabusNodeInput,
} from './syllabi';
import { createTag, deleteTag } from './tags';
import { freshDatabase, trackEpochs } from './test-vault';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** A chain of `depth` topics, one inside the other. */
const chain = (depth: number): SyllabusNodeInput[] => {
  let node: SyllabusNodeInput = { title: `Level ${depth}` };
  for (let level = depth - 1; level >= 1; level--) {
    node = { title: `Level ${level}`, children: [node] };
  }
  return [node];
};

describe('creating a syllabus', () => {
  it('stores the tree whole, fills ids and defaults, and keeps ids the caller gave', async () => {
    const bank = await createBank('Cardiology');
    const tag = (await createTag('Exam')).tag;
    const made = await createSyllabus({
      name: '  Cardiology exam  ',
      nodes: [
        {
          id: 'topic-given-0001',
          title: ' Heart failure ',
          weight: 2.5,
          bankIds: [bank.id, bank.id],
          tagIds: [tag.id],
          children: [{ title: 'Drugs' }, { title: 'Devices', weight: 1 }],
        },
        { title: 'Arrhythmias' },
      ],
    });
    expect(Syllabus.safeParse(made).success).toBe(true);
    expect(made.name).toBe('Cardiology exam');
    expect(made.nodes).toHaveLength(2);
    const [hf] = made.nodes;
    expect(hf).toMatchObject({
      id: 'topic-given-0001',
      title: 'Heart failure',
      weight: 2.5,
      bankIds: [bank.id],
      tagIds: [tag.id],
    });
    expect(hf!.children.map((c) => c.title)).toEqual(['Drugs', 'Devices']);
    expect(hf!.children[0]).toMatchObject({ bankIds: [], tagIds: [], children: [] });
    expect(hf!.children[0]).not.toHaveProperty('weight');
    const ids = flattenSyllabus(made.nodes).map((x) => x.node.id);
    expect(new Set(ids).size).toBe(4);
    expect(await getSyllabus(made.id)).toEqual(made);
    closeDb();
    expect(await getSyllabus(made.id)).toEqual(made);
  });

  it('accepts an empty outline and lists syllabi by name', async () => {
    await createSyllabus({ name: 'beta' });
    await createSyllabus({ name: 'Alpha' });
    expect((await listSyllabi()).map((s) => s.name)).toEqual(['Alpha', 'beta']);
    expect((await listSyllabi())[0]!.nodes).toEqual([]);
  });
});

describe('limits', () => {
  it(`allows ${MAX_SYLLABUS_DEPTH} levels and refuses a seventh, in words`, async () => {
    const ok = await createSyllabus({ name: 'Six', nodes: chain(MAX_SYLLABUS_DEPTH) });
    expect(flattenSyllabus(ok.nodes).at(-1)!.depth).toBe(MAX_SYLLABUS_DEPTH);
    await expect(
      createSyllabus({ name: 'Seven', nodes: chain(MAX_SYLLABUS_DEPTH + 1) }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/at most 500 topics, nested at most 6 levels/),
    });
  });

  it(`allows ${MAX_SYLLABUS_NODES} topics in all and refuses one more`, async () => {
    const wide = (n: number): SyllabusNodeInput[] =>
      Array.from({ length: n }, (_, i) => ({ title: `Topic ${i}` }));
    // 5 chapters x 100 sections = 500 topics with the chapters themselves counted
    const grouped = (sections: number): SyllabusNodeInput[] =>
      Array.from({ length: 5 }, (_, i) => ({ title: `Chapter ${i}`, children: wide(sections) }));
    const ok = await createSyllabus({ name: 'Full', nodes: grouped(99) });
    expect(flattenSyllabus(ok.nodes)).toHaveLength(500);
    await expect(createSyllabus({ name: 'Over', nodes: grouped(100) })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/at most 500 topics/),
    });
  });

  it('a hostile, absurdly deep input is refused without recursing into it', async () => {
    const deep = chain(1);
    let cursor = deep[0]!;
    for (let i = 0; i < 20_000; i++) {
      const next: SyllabusNodeInput = { title: 'x' };
      cursor.children = [next];
      cursor = next;
    }
    await expect(createSyllabus({ name: 'Deep', nodes: deep })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await listSyllabi({ includeDeleted: true })).toEqual([]);
  });

  it('refuses repeated topic ids, weights that are not positive and empty titles', async () => {
    await expect(
      createSyllabus({
        name: 'Dupes',
        nodes: [
          { id: 'topic-same-0001', title: 'A' },
          { id: 'topic-same-0001', title: 'B' },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/share an id/),
    });
    for (const weight of [0, -1, Number.NaN]) {
      await expect(
        createSyllabus({ name: 'W', nodes: [{ title: 'A', weight }] }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(createSyllabus({ name: 'T', nodes: [{ title: '   ' }] })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(createSyllabus({ name: '' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it(`allows at most ${MAX_SYLLABI} live syllabi`, async () => {
    const first = await createSyllabus({ name: 'first' });
    await getDb().syllabi.bulkAdd(
      Array.from({ length: MAX_SYLLABI - 1 }, (_, i) => ({
        ...first,
        id: `syllabus-bulk-${String(i).padStart(4, '0')}`,
        name: `bulk ${i}`,
      })),
    );
    await expect(createSyllabus({ name: 'one too many' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await deleteSyllabus(first.id);
    await expect(createSyllabus({ name: 'fits' })).resolves.toMatchObject({ name: 'fits' });
    await expect(restoreSyllabus(first.id)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('references', () => {
  it('must exist when they are new, and are left alone when they were already there', async () => {
    const bank = await createBank('Cardiology');
    const tag = (await createTag('Pearl')).tag;
    await expect(
      createSyllabus({ name: 'x', nodes: [{ title: 'A', bankIds: ['bank-does-not-exist'] }] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createSyllabus({ name: 'x', nodes: [{ title: 'A', tagIds: ['tag-does-not-exist'] }] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const made = await createSyllabus({
      name: 'Exam',
      nodes: [{ title: 'A', bankIds: [bank.id, INBOX_BANK_ID], tagIds: [tag.id] }],
    });
    await deleteBank(bank.id);
    await deleteTag(tag.id);
    // the outline is still editable although its targets are gone
    const renamed = await updateSyllabus(made.id, { name: 'Exam 2' });
    expect(renamed.row.name).toBe('Exam 2');
    const edited = await updateSyllabus(made.id, {
      nodes: [{ ...made.nodes[0]!, title: 'A renamed' }],
    });
    expect(edited.row.nodes[0]!.title).toBe('A renamed');
    // a bank the tree already pointed at stays allowed, wherever in the tree it is used
    await expect(
      updateSyllabus(made.id, { nodes: [{ title: 'B', bankIds: [bank.id] }, ...made.nodes] }),
    ).resolves.toMatchObject({ status: 'saved' });
    // but pointing a topic at something new that is gone is refused
    const gone = (await createBank('Gone')).id;
    await deleteBank(gone);
    await expect(
      updateSyllabus(made.id, { nodes: [{ title: 'C', bankIds: [gone] }] }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('are reported when they are missing or in the trash', async () => {
    const bank = await createBank('Cardiology');
    const tag = (await createTag('Pearl')).tag;
    const made = await createSyllabus({
      name: 'Exam',
      nodes: [{ id: 'topic-a-000001', title: 'A', bankIds: [bank.id], tagIds: [tag.id] }],
    });
    expect(await checkSyllabi()).toEqual([]);
    await deleteBank(bank.id);
    await deleteTag(tag.id);
    expect(await checkSyllabi()).toEqual(
      expect.arrayContaining([
        {
          syllabusId: made.id,
          nodeId: 'topic-a-000001',
          field: 'bankIds',
          id: bank.id,
          problem: 'deleted',
        },
        {
          syllabusId: made.id,
          nodeId: 'topic-a-000001',
          field: 'tagIds',
          id: tag.id,
          problem: 'deleted',
        },
      ]),
    );
    const { purge } = await import('./trash');
    await purge([
      { kind: 'bank', id: bank.id },
      { kind: 'tag', id: tag.id },
    ]);
    expect((await checkSyllabi()).map((p) => p.problem)).toEqual(['missing', 'missing']);
    // the person's outline is not rewritten behind their back
    expect((await getSyllabus(made.id))!.nodes[0]).toMatchObject({
      bankIds: [bank.id],
      tagIds: [tag.id],
    });
  });
});

describe('updating', () => {
  it('replaces the whole tree, keeps topic ids, and is optimistic', async () => {
    const made = await createSyllabus({
      name: 'Exam',
      nodes: [{ title: 'A', children: [{ title: 'A1' }] }, { title: 'B' }],
    });
    const a = made.nodes[0]!;
    const out = await updateSyllabus(
      made.id,
      { nodes: [{ id: a.id, title: 'A (renamed)', children: a.children }] },
      { expectedVersion: made.updatedAt },
    );
    expect(out.status).toBe('saved');
    expect(out.row.nodes).toHaveLength(1);
    expect(out.row.nodes[0]!.id).toBe(a.id);
    expect(out.row.nodes[0]!.children[0]!.id).toBe(a.children[0]!.id);
    // a second editor that still holds the first version
    const late = await updateSyllabus(
      made.id,
      { name: 'Mine' },
      { expectedVersion: made.updatedAt },
    );
    expect(late).toMatchObject({ status: 'stale', row: { name: 'Exam' } });
    expect((await getSyllabus(made.id))!.name).toBe('Exam');
  });

  it('writes nothing for a change that changes nothing', async () => {
    const made = await createSyllabus({ name: 'Exam', nodes: [{ title: 'A' }] });
    const epochs = trackEpochs();
    const same = await updateSyllabus(made.id, { name: 'Exam', nodes: made.nodes });
    expect(same.row).toEqual(made);
    expect(epochs).toHaveLength(0);
  });

  it('rejects a bad tree before touching the stored one', async () => {
    const made = await createSyllabus({ name: 'Exam', nodes: [{ title: 'A' }] });
    await expect(
      updateSyllabus(made.id, { nodes: chain(MAX_SYLLABUS_DEPTH + 1) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(updateSyllabus('syllabus-does-not-exist', { name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await getSyllabus(made.id)).toEqual(made);
  });
});

describe('delete, restore, purge', () => {
  it('soft-deletes with undo and purges only deleted syllabi', async () => {
    const a = await createSyllabus({ name: 'A' });
    const b = await createSyllabus({ name: 'B' });
    await deleteSyllabus(a.id);
    await deleteSyllabus(a.id);
    expect((await listSyllabi()).map((s) => s.name)).toEqual(['B']);
    expect(await getSyllabus(a.id)).toBeNull();
    expect((await listSyllabi({ includeDeleted: true })).map((s) => s.name)).toEqual(['A', 'B']);
    await expect(updateSyllabus(a.id, { name: 'x' })).rejects.toMatchObject({ code: 'not_found' });

    const back = await restoreSyllabus(a.id);
    expect(back).toMatchObject({ name: 'A', deletedAt: null });
    expect(back.updatedAt > a.updatedAt).toBe(true);

    await expect(purgeSyllabi([b.id])).rejects.toMatchObject({ code: 'invalid_request' });
    await deleteSyllabus(b.id);
    expect(await purgeSyllabi([b.id])).toBe(1);
    expect(await getDb().syllabi.get(b.id)).toBeUndefined();
    await deleteSyllabus(a.id);
    expect(await purgeSyllabi()).toBe(1);
    expect(await listSyllabi({ includeDeleted: true })).toEqual([]);
  });
});
