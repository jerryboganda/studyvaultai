// @vitest-environment node
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from './db';
import { createFolder } from './hierarchy';
import { addToBank } from './membership';
import { attachTags, renameTag, createTag } from './tags';
import { createBank, saveCapture } from './repo';
import { listSearchDocuments, listSearchDocumentsChangedSince } from './search';
import { cap } from './test-fixtures';
import { freshDatabase, save } from './test-vault';

/**
 * The feed's paging contract (what SearchHost relies on): a page holds `limit` documents unless the
 * feed ended, so a short page is the last one. Rows that cannot be read, and ids that name no row,
 * are passed over; the unreadable ones are reported through `onSkipped`.
 */

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
});

const pad = (n: number) => String(n).padStart(5, '0');

/** `count` readable highlights cloned from one real row; returns their ids in id order. */
async function seedRows(count: number): Promise<string[]> {
  const base = await save('Seed quote for cloning');
  const db = getDb();
  const row = (await db.highlights.get(base.id))!;
  const rows = Array.from({ length: count }, (_, i) => ({
    ...row,
    id: `sv-${pad(i)}`,
    exactQuote: `Warfarin fact ${pad(i)}.`,
    normalizedQuote: `warfarin fact ${pad(i)}.`,
    quoteHash: pad(i).padStart(64, 'a'),
  }));
  await db.highlights.bulkPut(rows);
  return rows.map((r) => r.id);
}

/** Every page of `read`, stopping at the first short one, as SearchHost does. */
async function drain(
  limit: number,
  read: (o: {
    afterId?: string;
    limit: number;
    onSkipped: (n: number) => void;
  }) => Promise<Array<{ id: string }>>,
) {
  const pages: string[][] = [];
  let skipped = 0;
  let afterId: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await read({
      afterId,
      limit,
      onSkipped: (n) => {
        skipped += n;
      },
    });
    pages.push(page.map((d) => d.id));
    if (page.length < limit) break;
    afterId = page[page.length - 1]!.id;
  }
  return { pages, skipped, ids: pages.flat() };
}

describe('listSearchDocuments: unreadable rows', () => {
  it('fills every page around rows it cannot read and reports them; only the last page is short', async () => {
    const ids = await seedRows(25); // plus the base highlight: 26 rows
    const db = getDb();
    // one in the middle of a page, one at a page boundary, one after the last readable row
    for (const id of [ids[2]!, ids[10]!, ids[24]!])
      await db.highlights.update(id, { exactQuote: '' });

    const { pages, skipped, ids: seen } = await drain(10, (o) => listSearchDocuments(o));

    expect(pages.map((p) => p.length)).toEqual([10, 10, 3]);
    expect(skipped).toBe(3);
    expect(new Set(seen).size).toBe(23);
    expect(seen).toEqual([...seen].sort());
    for (const id of [ids[2]!, ids[10]!, ids[24]!]) expect(seen).not.toContain(id);
  });

  it('does not stop at a whole page of unreadable rows', async () => {
    await seedRows(12); // 13 rows in all
    const db = getDb();
    const sorted = (await db.highlights.orderBy(':id').primaryKeys()) as string[];
    for (const id of sorted.slice(0, 10)) await db.highlights.update(id, { exactQuote: '' });

    const first = await listSearchDocuments({
      limit: 3,
      onSkipped: (n) => expect(n).toBe(10),
    });
    expect(first.map((d) => d.id)).toEqual(sorted.slice(10, 13));
  });

  it('reports nothing when every row is readable', async () => {
    await seedRows(4);
    const onSkipped = vi.fn();
    const docs = await listSearchDocuments({ limit: 50, onSkipped });
    expect(docs).toHaveLength(5);
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('counts a trailing unreadable row even when no document follows it', async () => {
    const ids = await seedRows(3);
    await getDb().highlights.update(ids[2]!, { exactQuote: '' });
    const onSkipped = vi.fn();
    const docs = await listSearchDocuments({ limit: 50, onSkipped });
    expect(docs).toHaveLength(3);
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith(1);
  });
});

describe('listSearchDocumentsChangedSince: unreadable rows and ids without a row', () => {
  it('fills its pages around both, so nothing after them is lost', async () => {
    const ids = await seedRows(30);
    const db = getDb();
    const tag = (await createTag('exam')).tag;
    // links left behind by purged highlights: ids in the changed set that name no row
    await db.highlightTags.bulkPut(
      ['aaa-gone-00001', 'aaa-gone-00002', 'aaa-gone-00003'].map((highlightId) => ({
        highlightId,
        tagId: tag.id,
        addedAt: '2026-10-11T10:00:00.000Z',
      })),
    );
    await renameTag(tag.id, 'exam-2'); // moves the tag's updatedAt: its links are now "changed"
    for (const id of [ids[1]!, ids[17]!]) await db.highlights.update(id, { exactQuote: '' });

    const {
      pages,
      skipped,
      ids: seen,
    } = await drain(8, (o) =>
      listSearchDocumentsChangedSince({ since: '2000-01-01T00:00:00.000Z', ...o }),
    );

    expect(skipped).toBe(2);
    expect(seen).toHaveLength(31 - 2); // 30 seeded + the base row, minus the unreadable two
    expect(pages.slice(0, -1).every((p) => p.length === 8)).toBe(true);
    expect(seen.filter((id) => id.startsWith('aaa-gone'))).toEqual([]);
    expect(seen).toContain(ids[29]!);
  });
});

describe('writers stamp when their transaction holds its lock', () => {
  it('a capture that waited behind another writer is stamped after the wait', async () => {
    // Date only: the real timers keep driving IndexedDB.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T10:00:00.000Z'));
    const db = getDb();
    // A first write on this connection also runs the one-off "no newer rows" scan; after it, the
    // capture below goes straight to its transaction and queues behind the holder.
    await save('Warm up the connection');

    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
    const holder = db.transaction(
      'rw',
      [db.banks, db.sources, db.highlights, db.highlightBanks],
      async () => {
        await db.banks.count(); // resolves once the transaction has started: it now owns the lock
        lockAcquired();
        await Dexie.waitFor(holding);
      },
    );
    await acquired;

    const waiting = saveCapture(cap('Waited behind a long restore.', 100));
    // let the capture reach its (queued) transaction, then let a long wait pass
    await new Promise((resolve) => setTimeout(resolve, 100));
    vi.setSystemTime(new Date('2026-10-11T10:00:30.000Z'));
    held();
    await holder;
    const saved = await waiting;

    const row = (await db.highlights.get(saved.highlight.id))!;
    expect(row.updatedAt >= '2026-10-11T10:00:30.000Z').toBe(true);
    // so a catch-up that started at 10:00:20 (since = 10:00:15) still sees it
    const changed = await listSearchDocumentsChangedSince({ since: '2026-10-11T10:00:15.000Z' });
    expect(changed.map((d) => d.id)).toContain(saved.highlight.id);
  });
});

describe('listSearchDocuments: bank, folder and tag facets', () => {
  it('names a deep folder chain, several banks and tags; a trashed parent cuts the path', async () => {
    const cardio = await createBank('Cardiology');
    const neuro = await createBank('Neurology');
    const a = await createFolder({ bankId: cardio.id, name: 'A' });
    const b = await createFolder({ bankId: cardio.id, name: 'B', parentFolderId: a.id });
    const c = await createFolder({ bankId: cardio.id, name: 'C', parentFolderId: b.id });
    const lone = await createFolder({ bankId: neuro.id, name: 'Lone' });
    const tag = (await createTag('exam')).tag;

    const deep = await save('Deep quote', { bankId: cardio.id });
    await addToBank({ highlightId: deep.id, bankId: cardio.id, folderId: c.id });
    await addToBank({ highlightId: deep.id, bankId: neuro.id, folderId: lone.id });
    await attachTags({ highlightIds: [deep.id], tagIds: [tag.id] });
    const plain = await save('Plain quote');

    const read = async () => {
      const docs = await listSearchDocuments();
      return {
        deep: docs.find((d) => d.id === deep.id)!,
        plain: docs.find((d) => d.id === plain.id)!,
      };
    };

    let docs = await read();
    expect([...docs.deep.banks].sort()).toEqual(['Cardiology', 'Neurology']);
    expect([...docs.deep.folderPath].sort()).toEqual(['A', 'B', 'C', 'Lone']);
    const at = docs.deep.folderPath.indexOf('A');
    expect(docs.deep.folderPath.slice(at, at + 3)).toEqual(['A', 'B', 'C']);
    expect(docs.deep.tags).toEqual(['exam']);
    expect(docs.plain.folderPath).toEqual([]);
    expect(docs.plain.tags).toEqual([]);

    // A trashed parent ends the path at the folder below it; a trashed bank is no facet.
    const db = getDb();
    const ts = new Date().toISOString();
    await db.folders.update(b.id, { deletedAt: ts });
    await db.banks.update(neuro.id, { deletedAt: ts });
    docs = await read();
    expect(docs.deep.banks).toEqual(['Cardiology']);
    expect([...docs.deep.folderPath].sort()).toEqual(['C', 'Lone']);
  });
});
