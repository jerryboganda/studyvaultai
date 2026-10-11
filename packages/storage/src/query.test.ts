// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HIGHLIGHT_KINDS, INBOX_BANK_ID, SearchDocument, type HighlightKind } from '@shared';
import { getDb } from './db';
import { createFolder } from './hierarchy';
import { addToBank } from './membership';
import { createNote, deleteNote, updateNote } from './notes';
import {
  countHighlights,
  findDuplicateClusters,
  getCounts,
  getHighlightDetail,
  listHighlights,
} from './query';
import { createBank, saveCapture, softDeleteHighlight } from './repo';
import { listSearchDocuments, listSearchDocumentsChangedSince } from './search';
import { seedId, seedVault, type SeedSummary } from './seed';
import { attachTags, createTag, renameTag } from './tags';
import { cap, anchor } from './test-fixtures';
import { freshDatabase, loadFixture, save, saveOn, seedV1 } from './test-vault';
import type { HighlightQuery } from './types';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

type HRow = {
  id: string;
  deletedAt: string | null;
  kind: string;
  priority: number;
  resolveStatus: string;
  sourceId: string;
  capturedAt: string;
  updatedAt: string;
};

/** Reference implementation: the same question answered by brute force over the raw tables. */
async function expected(query: HighlightQuery = {}): Promise<string[]> {
  const db = getDb();
  const rows = (await db.highlights.toArray()) as unknown as HRow[];
  const members = await db.highlightBanks.toArray();
  const links = await db.highlightTags.toArray();
  const notes = (await db.notes.toArray()).filter((n) => n.deletedAt === null);
  const folders = await db.folders.toArray();
  let ids = new Set(rows.filter((r) => r.deletedAt === null).map((r) => r.id));
  const keep = (set: Set<string>) => (ids = new Set([...ids].filter((id) => set.has(id))));

  if (typeof query.folderId === 'string') {
    const folder = folders.find((f) => f.id === query.folderId)!;
    const tree = new Set<string>([folder.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of folders) {
        if (f.parentFolderId && tree.has(f.parentFolderId) && !tree.has(f.id)) {
          tree.add(f.id);
          grew = true;
        }
      }
    }
    keep(
      new Set(
        members
          .filter((m) => m.bankId === folder.bankId && m.folderId && tree.has(m.folderId))
          .map((m) => m.highlightId),
      ),
    );
  } else if (query.bankId) {
    keep(
      new Set(
        members
          .filter(
            (m) => m.bankId === query.bankId && (query.folderId !== null || m.folderId === null),
          )
          .map((m) => m.highlightId),
      ),
    );
  }
  if (query.tagIds?.length) {
    const per = query.tagIds.map(
      (t) => new Set(links.filter((l) => l.tagId === t).map((l) => l.highlightId)),
    );
    keep(
      query.tagMode === 'all'
        ? new Set([...ids].filter((id) => per.every((s) => s.has(id))))
        : new Set(per.flatMap((s) => [...s])),
    );
  }
  const by = <K extends keyof HRow>(field: K, values?: unknown[]) => {
    if (values?.length)
      keep(new Set(rows.filter((r) => values.includes(r[field])).map((r) => r.id)));
  };
  by('kind', query.kinds);
  by('priority', query.priorities);
  by('resolveStatus', query.resolveStatuses);
  if (query.sourceId) by('sourceId', [query.sourceId]);
  if (query.hasNote !== undefined) {
    const withNote = new Set(notes.map((n) => n.highlightId).filter((x): x is string => !!x));
    keep(new Set([...ids].filter((id) => withNote.has(id) === query.hasNote)));
  }
  if (query.dateRange) {
    const field = query.dateRange.field ?? 'capturedAt';
    const { from, to } = query.dateRange;
    keep(
      new Set(
        rows
          .filter(
            (r) => (from === undefined || r[field] >= from) && (to === undefined || r[field] <= to),
          )
          .map((r) => r.id),
      ),
    );
  }
  const sortBy = query.sort?.by ?? 'capturedAt';
  const sign = (query.sort?.dir ?? 'desc') === 'desc' ? -1 : 1;
  const key = (r: HRow): Array<string | number> =>
    sortBy === 'priority' ? [r.priority, r.capturedAt, r.id] : [r[sortBy], r.id];
  return rows
    .filter((r) => ids.has(r.id))
    .sort((a, b) => {
      const x = key(a);
      const y = key(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return sign * (x[i]! < y[i]! ? -1 : 1);
      return 0;
    })
    .map((r) => r.id);
}

/** All pages of a query, concatenated. */
async function walk(query: HighlightQuery, limit: number): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 2000; guard++) {
    const page = await listHighlights({ ...query, limit, cursor });
    out.push(...page.items.map((i) => i.highlight.id));
    cursor = page.nextCursor;
    if (cursor === null) return out;
  }
  throw new Error('pagination did not terminate');
}

describe('listHighlights filters (small, real writes)', () => {
  async function build() {
    const cardio = await createBank('Cardiology');
    const renal = await createBank('Renal');
    const drugs = await createFolder({ bankId: cardio.id, name: 'Drugs' });
    const antiplatelets = await createFolder({
      bankId: cardio.id,
      name: 'Antiplatelets',
      parentFolderId: drugs.id,
    });
    const h = {
      aspirin: await save('Aspirin inhibits COX', {
        bankId: cardio.id,
        kind: 'essential',
        priority: 5,
      }),
      warfarin: await save('Warfarin inhibits VKOR', {
        bankId: cardio.id,
        kind: 'formula',
        priority: 2,
      }),
      loop: await save('Loop diuretics block NKCC2', {
        bankId: renal.id,
        kind: 'exception',
        priority: 4,
      }),
      other: await saveOn('https://example.com/other', 'A quote on another page', {
        bankId: renal.id,
        kind: 'essential',
        priority: 1,
      }),
    };
    await addToBank({ highlightId: h.aspirin.id, bankId: cardio.id, folderId: antiplatelets.id });
    await addToBank({ highlightId: h.warfarin.id, bankId: cardio.id, folderId: drugs.id });
    const t1 = (await createTag('exam')).tag;
    const t2 = (await createTag('pharm')).tag;
    await attachTags({ highlightIds: [h.aspirin.id, h.loop.id], tagIds: [t1.id] });
    await attachTags({ highlightIds: [h.aspirin.id], tagIds: [t2.id] });
    await createNote({ highlightId: h.warfarin.id, body: 'note' });
    return { cardio, renal, drugs, antiplatelets, h, t1, t2 };
  }

  it('each filter agrees with brute force', async () => {
    const { cardio, renal, drugs, antiplatelets, h, t1, t2 } = await build();
    const queries: HighlightQuery[] = [
      {},
      { bankId: cardio.id },
      { bankId: renal.id },
      { bankId: cardio.id, folderId: null },
      { folderId: drugs.id }, // subtree: includes the nested folder
      { folderId: antiplatelets.id },
      { tagIds: [t1.id] },
      { tagIds: [t1.id, t2.id], tagMode: 'any' },
      { tagIds: [t1.id, t2.id], tagMode: 'all' },
      { kinds: ['essential'] },
      { kinds: ['essential', 'formula'], priorities: [5, 2] },
      { resolveStatuses: ['unchecked'] },
      { resolveStatuses: ['resolved'] },
      { sourceId: (await getDb().highlights.get(h.other.id))!.sourceId },
      { hasNote: true },
      { hasNote: false },
      { bankId: cardio.id, tagIds: [t1.id], kinds: ['essential'] },
      { sort: { by: 'priority', dir: 'desc' } },
      { sort: { by: 'priority', dir: 'asc' } },
      { sort: { by: 'updatedAt', dir: 'asc' } },
    ];
    for (const q of queries) {
      expect(
        (await listHighlights(q)).items.map((i) => i.highlight.id),
        JSON.stringify(q),
      ).toEqual(await expected(q));
      expect(await countHighlights({ ...q, sort: undefined } as never), JSON.stringify(q)).toBe(
        (await expected(q)).length,
      );
    }
    // Spot checks of the shape.
    expect(
      (await listHighlights({ folderId: drugs.id })).items.map((i) => i.highlight.id).sort(),
    ).toEqual([h.aspirin.id, h.warfarin.id].sort());
    expect((await listHighlights({ bankId: cardio.id, folderId: null })).items).toEqual([]);
  });

  it('filters by date range on either timestamp and ignores trashed highlights', async () => {
    const a = await save('First in time');
    await new Promise((r) => setTimeout(r, 15));
    const cut = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    const b = await save('Second in time');
    const c = await save('Third in time');
    await softDeleteHighlight(c.id);

    const after = await listHighlights({ dateRange: { from: cut } });
    expect(after.items.map((i) => i.highlight.id)).toEqual([b.id]);
    const before = await listHighlights({ dateRange: { to: cut } });
    expect(before.items.map((i) => i.highlight.id)).toEqual([a.id]);
    const byUpdated = await listHighlights({
      dateRange: { field: 'updatedAt', from: cut },
      sort: { by: 'updatedAt' },
    });
    expect(byUpdated.items.map((i) => i.highlight.id)).toEqual([b.id]);
    expect(await countHighlights({ dateRange: { from: cut } })).toBe(1);
    expect(await countHighlights({})).toBe(2);
  });

  it('returns joined rows: tags, locations with folder paths, note counts, custom fields', async () => {
    const { cardio, antiplatelets, h, t1, t2 } = await build();
    const { setCustomFields } = await import('./notes');
    await setCustomFields(h.aspirin.id, { system: 'cardiovascular' });
    const page = await listHighlights({ bankId: cardio.id, sort: { by: 'priority' } });
    const first = page.items[0]!;
    expect(first.highlight.id).toBe(h.aspirin.id);
    expect(first.tags.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    expect(first.locations).toEqual([
      {
        bank: expect.objectContaining({ id: cardio.id, name: 'Cardiology' }),
        folderPath: [
          { id: expect.any(String), name: 'Drugs' },
          { id: antiplatelets.id, name: 'Antiplatelets' },
        ],
      },
    ]);
    expect(first.customFields).toEqual({ system: 'cardiovascular' });
    expect(first.source).toMatchObject({ title: 'Pharmacology notes', host: 'example.com' });
    expect(page.items[1]!.noteCount).toBe(1);
  });

  it('validates the query', async () => {
    const bad = (q: unknown) =>
      expect(listHighlights(q as never)).rejects.toMatchObject({ code: 'invalid_request' });
    await bad({ limit: 0 });
    await bad({ limit: 501 });
    await bad({ kinds: ['nonsense'] });
    await bad({ priorities: [6] });
    await bad({ folderId: null }); // needs a bank
    await bad({ unknownKey: 1 });
    await bad({ cursor: 'garbage' });
    await bad({ dateRange: { from: 'yesterday' } });
    const first = await save('Cursor owner');
    await save('Second one');
    const page = await listHighlights({ limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    // A cursor belongs to its sort order.
    await bad({ cursor: page.nextCursor, sort: { by: 'updatedAt' } });
    await bad({ cursor: page.nextCursor, sort: { by: 'capturedAt', dir: 'asc' } });
    expect(first).toBeDefined();
  });

  it('answers empty for unknown banks, folders, tags and deleted banks', async () => {
    await save('Something exists');
    const { deleteBank } = await import('./hierarchy');
    const gone = await createBank('Gone');
    await deleteBank(gone.id);
    for (const q of [
      { bankId: 'no-such-bank' },
      { bankId: gone.id },
      { folderId: 'no-such-folder' },
      { tagIds: ['no-such-tag-1'] },
      { tagIds: ['no-such-tag-1'], tagMode: 'all' as const },
    ]) {
      expect((await listHighlights(q)).items, JSON.stringify(q)).toEqual([]);
    }
  });
});

describe('pagination and ordering on a seeded vault', () => {
  let seeded: SeedSummary;

  beforeEach(async () => {
    const db = getDb();
    await db.open();
    seeded = await seedVault(db, {
      highlights: 400,
      banks: 5,
      tags: 8,
      foldersPerBank: 10,
      seed: 7,
    });
  });

  const sorts: Array<NonNullable<HighlightQuery['sort']>> = [
    { by: 'capturedAt', dir: 'desc' },
    { by: 'capturedAt', dir: 'asc' },
    { by: 'updatedAt', dir: 'desc' },
    { by: 'updatedAt', dir: 'asc' },
    { by: 'priority', dir: 'desc' },
    { by: 'priority', dir: 'asc' },
  ];

  it.each(sorts)('walks every page of the whole vault in order (%o)', async (sort) => {
    const all = await walk({ sort }, 37);
    expect(all).toEqual(await expected({ sort }));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(seeded.liveHighlights);
  });

  it.each(sorts)('walks a filtered candidate set page by page (%o)', async (sort) => {
    const q: HighlightQuery = {
      bankId: seeded.bankIds[1]!,
      kinds: ['essential', 'formula', 'question'],
      sort,
    };
    expect(await walk(q, 5)).toEqual(await expected(q));
    const tagged: HighlightQuery = { tagIds: seeded.tagIds.slice(0, 3), sort };
    expect(await walk(tagged, 11)).toEqual(await expected(tagged));
  });

  it('a folder id lists its subtree, a bank id with folderId null the bank root only', async () => {
    const db = getDb();
    const folders = await db.folders.toArray();
    const parent = folders.find((f) => folders.some((c) => c.parentFolderId === f.id))!;
    const q: HighlightQuery = { folderId: parent.id };
    expect(await walk(q, 9)).toEqual(await expected(q));
    const root: HighlightQuery = { bankId: parent.bankId, folderId: null };
    expect(await walk(root, 9)).toEqual(await expected(root));
  });

  it('getCounts agrees with brute force for banks, folders, tags, kinds, priorities and statuses', async () => {
    const db = getDb();
    const counts = await getCounts();
    const rows = (await db.highlights.toArray()).filter((r) => r.deletedAt === null);
    const live = new Set(rows.map((r) => r.id));
    expect(counts.total).toBe(rows.length);

    const tally = <T>(items: T[], key: (x: T) => string | null) => {
      const out: Record<string, number> = {};
      for (const item of items) {
        const k = key(item);
        if (k !== null) out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    };
    const members = (await db.highlightBanks.toArray()).filter((m) => live.has(m.highlightId));
    const banks = tally(members, (m) => m.bankId);
    for (const id of seeded.bankIds) expect(counts.banks[id] ?? 0, id).toBe(banks[id] ?? 0);
    expect(counts.folders).toEqual(tally(members, (m) => m.folderId));
    const links = (await db.highlightTags.toArray()).filter((l) => live.has(l.highlightId));
    expect(counts.tags).toEqual(tally(links, (l) => l.tagId));
    expect(counts.kinds).toEqual(tally(rows, (r) => r.kind));
    expect(counts.priorities).toEqual(tally(rows, (r) => String(r.priority)));
    expect(counts.resolveStatuses).toEqual(tally(rows, (r) => r.resolveStatus));
    for (const kind of Object.keys(counts.kinds))
      expect(HIGHLIGHT_KINDS).toContain(kind as HighlightKind);
    expect(await countHighlights({ kinds: ['essential'] })).toBe(counts.kinds.essential ?? 0);
  });
});

describe('the index-walking path (candidate sets larger than a page fetch)', () => {
  it('orders and pages correctly when more than 1000 candidates match', async () => {
    const db = getDb();
    await db.open();
    await seedVault(db, {
      highlights: 2300,
      banks: 4,
      tags: 5,
      foldersPerBank: 5,
      trashEvery: 40,
      seed: 3,
    });
    const everyKind: HighlightQuery = { kinds: [...HIGHLIGHT_KINDS] };
    for (const sort of [
      { by: 'capturedAt', dir: 'desc' },
      { by: 'priority', dir: 'desc' },
      { by: 'updatedAt', dir: 'asc' },
    ] as const) {
      const q = { ...everyKind, sort };
      const first = await listHighlights({ ...q, limit: 40 });
      const want = await expected(q);
      expect(first.items.map((i) => i.highlight.id)).toEqual(want.slice(0, 40));
      // Resume from a cursor in the middle of the order.
      const second = await listHighlights({ ...q, limit: 40, cursor: first.nextCursor });
      expect(second.items.map((i) => i.highlight.id)).toEqual(want.slice(40, 80));
    }
    const ranged: HighlightQuery = {
      kinds: [...HIGHLIGHT_KINDS],
      dateRange: { from: '2026-01-02T00:00:00.000Z', to: '2026-01-02T12:00:00.000Z' },
      hasNote: false,
    };
    expect(await walk(ranged, 100)).toEqual(await expected(ranged));
    expect(await countHighlights(ranged)).toBe((await expected(ranged)).length);
  }, 60_000);
});

describe('getHighlightDetail and duplicate hints', () => {
  it('returns the highlight with its source, locations, tags, notes and cross-page repeats', async () => {
    await seedV1(loadFixture('schema-v1-trash.json'));
    const detail = await getHighlightDetail('hl-live-0000001');
    expect(detail).toMatchObject({
      deletedAt: null,
      source: { title: 'Endocrine notes', host: 'example.org' },
      captureMethod: 'toolbar',
    });
    expect(detail.locations.map((l) => l.bank.id).sort()).toEqual(
      [INBOX_BANK_ID, 'bank-renal-0001'].sort(),
    );
    expect(detail.duplicates).toHaveLength(1);
    expect(detail.duplicates[0]).toMatchObject({
      highlightId: 'hl-repeat-00001',
      sourceTitle: 'Diabetes overview',
      sourceType: 'web',
    });

    await expect(getHighlightDetail('hl-trashed-0001')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await getHighlightDetail('hl-trashed-0001', { includeDeleted: true })).deletedAt).toBe(
      '2026-09-21T10:00:00.000Z',
    );
    await expect(getHighlightDetail('missing-id-here')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('clusters the same quote saved from different pages, never merging anything', async () => {
    await seedV1(loadFixture('schema-v1-trash.json'));
    const before = await getDb().highlights.toArray();
    const clusters = await findDuplicateClusters();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      quote: 'Metformin lowers hepatic glucose output.',
      sourceCount: 2,
    });
    expect(clusters[0]!.members.map((m) => m.highlightId).sort()).toEqual([
      'hl-live-0000001',
      'hl-repeat-00001',
    ]);
    expect(await getDb().highlights.toArray()).toEqual(before);
  });

  it('a repeat on the same page at a different place is a hint; the same place is not; trash is ignored', async () => {
    const quote = 'Repeated sentence on one page.';
    await save(quote, {}, 100);
    // Same page, same quote, different place and context -> a distinct highlight.
    await saveCapture(
      cap(quote, 2400, { anchorSet: anchor(quote, 2400, 'other lead ', ' other tail') }),
    );
    const clusters = await findDuplicateClusters();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(2);
    expect(clusters[0]!.sourceCount).toBe(1);

    // Two rows at exactly one place (e.g. from an import) are one anchor: no hint.
    const db = getDb();
    const rows = await db.highlights.toArray();
    const twin = { ...rows[0]!, id: 'hl-twin-00000001' };
    await db.highlights.put(twin);
    await db.highlights.delete(rows[1]!.id);
    expect(await findDuplicateClusters()).toEqual([]);

    // A deleted twin elsewhere does not count.
    await db.highlights.put({
      ...rows[1]!,
      deletedAt: '2026-10-01T00:00:00.000Z',
      anchorSet: anchor(quote, 2400, 'other lead ', ' other tail'),
    });
    expect(await findDuplicateClusters()).toEqual([]);
  });
});

describe('search documents', () => {
  it('streams highlight and note documents in id order, in pages, with facets', async () => {
    const bank = await createBank('Cardiology');
    const folder = await createFolder({ bankId: bank.id, name: 'Drugs' });
    const h = await save('Searchable quote', {
      bankId: bank.id,
      userComment: 'my words',
      headingContext: 'Heading X',
    });
    await addToBank({ highlightId: h.id, bankId: bank.id, folderId: folder.id });
    const tag = (await createTag('exam')).tag;
    await attachTags({ highlightIds: [h.id], tagIds: [tag.id] });
    const note = await createNote({ highlightId: h.id, title: 'Title', body: 'Body text' });
    await save('Second quote');

    const all: SearchDocument[] = [];
    let afterId: string | undefined;
    for (;;) {
      const page = await listSearchDocuments({ afterId, limit: 2 });
      if (page.length === 0) break;
      all.push(...page);
      afterId = page.at(-1)!.id;
    }
    expect(all.map((d) => d.id)).toEqual([...all.map((d) => d.id)].sort());
    expect(all).toHaveLength(3);
    for (const doc of all) expect(() => SearchDocument.parse(doc)).not.toThrow();

    const hDoc = all.find((d) => d.id === h.id)!;
    expect(hDoc).toMatchObject({
      docType: 'highlight',
      highlightId: h.id,
      title: 'Pharmacology notes',
      host: 'example.com',
      quote: 'Searchable quote',
      comment: 'my words',
      headingContext: 'Heading X',
      tags: ['exam'],
      banks: ['Cardiology'],
      folderPath: ['Drugs'],
      kind: 'essential',
      priority: 3,
      resolveStatus: 'unchecked',
      deletedAt: null,
    });
    const nDoc = all.find((d) => d.id === note.id)!;
    expect(nDoc).toMatchObject({
      docType: 'note',
      highlightId: h.id,
      quote: 'Searchable quote',
      comment: 'Title\nBody text',
      tags: ['exam'],
      banks: ['Cardiology'],
    });
  });

  it('changedSince reports edits, renames, filing, notes and trash; and an unchanged vault reports nothing', async () => {
    const bank = await createBank('Cardiology');
    const h1 = await save('One', { bankId: bank.id });
    const h2 = await save('Two');
    const h3 = await save('Three');
    const tag = (await createTag('exam')).tag;
    await attachTags({ highlightIds: [h1.id], tagIds: [tag.id] });
    const folder = await createFolder({ bankId: bank.id, name: 'Drugs' });
    await addToBank({ highlightId: h1.id, bankId: bank.id, folderId: folder.id });
    const note = await createNote({ highlightId: h3.id, body: 'n' });

    const mark = async () => {
      await new Promise((r) => setTimeout(r, 8));
      const t = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 8));
      return t;
    };
    const ids = async (since: string) =>
      (await listSearchDocumentsChangedSince({ since })).map((d) => d.id).sort();

    let since = await mark();
    expect(await ids(since)).toEqual([]);

    await renameTag(tag.id, 'exam-2');
    expect(await ids(since)).toEqual([h1.id]);

    since = await mark();
    const { renameBank } = await import('./hierarchy');
    await renameBank(bank.id, 'Cardio');
    expect(await ids(since)).toContain(h1.id);
    expect(
      (await listSearchDocumentsChangedSince({ since })).find((d) => d.id === h1.id)!.banks,
    ).toEqual(['Cardio']);

    since = await mark();
    const { renameFolder } = await import('./hierarchy');
    await renameFolder(folder.id, 'Drugs 2');
    expect(
      (await listSearchDocumentsChangedSince({ since })).find((d) => d.id === h1.id)!.folderPath,
    ).toEqual(['Drugs 2']);

    since = await mark();
    await updateNote(note.id, { body: 'edited' });
    expect(await ids(since)).toEqual([h3.id, note.id].sort());

    since = await mark();
    await softDeleteHighlight(h2.id);
    const trashed = (await listSearchDocumentsChangedSince({ since })).find((d) => d.id === h2.id)!;
    expect(trashed.deletedAt).not.toBeNull();

    since = await mark();
    await deleteNote(note.id);
    const deletedNote = (await listSearchDocumentsChangedSince({ since })).find(
      (d) => d.id === note.id,
    )!;
    expect(deletedNote.deletedAt).not.toBeNull();

    // Paging through the changed set by afterId.
    const everything = await listSearchDocumentsChangedSince({
      since: '2000-01-01T00:00:00.000Z',
      limit: 2,
    });
    expect(everything).toHaveLength(2);
    const rest = await listSearchDocumentsChangedSince({
      since: '2000-01-01T00:00:00.000Z',
      afterId: everything.at(-1)!.id,
      limit: 50,
    });
    expect(rest.every((d) => d.id > everything.at(-1)!.id)).toBe(true);
    await expect(listSearchDocumentsChangedSince({ since: 'last week' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('feeds a highlight whose id is the largest and keeps trashed ones flagged', async () => {
    const h = await save('Will be trashed');
    await softDeleteHighlight(h.id);
    const docs = await listSearchDocuments({});
    expect(docs).toHaveLength(1);
    expect(docs[0]!.deletedAt).not.toBeNull();
    expect(seedId('hl', 1)).toBe('hl-00000001');
  });
});
