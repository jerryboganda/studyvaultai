// @vitest-environment node
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { INBOX_BANK_ID } from '@shared';
import { DB_NAME, SCHEMA_V1, getDb, resetDbForTests } from './db';
import {
  createBank,
  getPageHighlights,
  listBanks,
  listBanksWithCounts,
  listRecentHighlights,
  reportResolutions,
  restoreHighlight,
  saveCapture,
  softDeleteHighlight,
  updateHighlight,
  wipeAllData,
} from './repo';
import { anchor, cap } from './test-fixtures';

type Row = Record<string, unknown>;
interface Snapshot {
  banks: Row[];
  sources: Row[];
  highlights: Row[];
  highlightBanks: Row[];
}

/** What the schema-version-1 build wrote. Frozen: see the `_note` inside. */
const V1: Snapshot & { _note: string } = JSON.parse(
  readFileSync(new URL('./fixtures/schema-v1.json', import.meta.url), 'utf8'),
);
const fresh = (): Snapshot => ({
  banks: structuredClone(V1.banks),
  sources: structuredClone(V1.sources),
  highlights: structuredClone(V1.highlights),
  highlightBanks: structuredClone(V1.highlightBanks),
});

const PAGE_URL = 'https://example.com/notes/pharm';
const ASPIRIN = 'hl-aspirin-0001';
const WARFARIN = 'hl-warfarin-0002';
const HEPARIN = 'hl-heparin-00003';

/** Write rows the way an older (or newer) build would have: straight into IndexedDB, version 1 stores. */
async function seed(data: Snapshot): Promise<void> {
  await resetDbForTests();
  const legacy = new Dexie(DB_NAME);
  legacy.version(1).stores(SCHEMA_V1);
  try {
    await legacy.open();
    await legacy.table('banks').bulkPut(data.banks);
    await legacy.table('sources').bulkPut(data.sources);
    await legacy.table('highlights').bulkPut(data.highlights);
    await legacy.table('highlightBanks').bulkPut(data.highlightBanks);
  } finally {
    legacy.close();
  }
}

async function snapshot(): Promise<Snapshot> {
  const db = getDb();
  await db.open();
  return {
    banks: await db.banks.toArray(),
    sources: await db.sources.toArray(),
    highlights: await db.highlights.toArray(),
    highlightBanks: await db.highlightBanks.toArray(),
  };
}
/** A capture touching a page refreshes its source's updatedAt (provenance fields stay as first seen). */
const stable = (rows: Row[]) => rows.map(({ updatedAt: _updatedAt, ...rest }) => rest);
const byId = (rows: Row[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the frozen schema-version-1 fixture, read and extended through the repo', () => {
  beforeEach(() => seed(fresh()));

  it('is what it claims to be', () => {
    expect(V1.banks.every((r) => r.schemaVersion === 1)).toBe(true);
    expect(V1.highlights.every((r) => !('capturedUrl' in r) && !('capturedTitle' in r))).toBe(true);
  });

  it('reads pages, banks and recent highlights', async () => {
    const page = await getPageHighlights(PAGE_URL, null);
    expect(page.sourceId).toBe('src-pharm-0001');
    expect(page.highlights.map((h) => [h.id, h.resolveStatus, h.bankIds])).toEqual([
      [ASPIRIN, 'resolved', [INBOX_BANK_ID]],
      [WARFARIN, 'orphaned', ['bank-cardiology-01']],
    ]);
    expect(page.highlights[0]).toMatchObject({
      exactQuote: 'Aspirin irreversibly inhibits cyclooxygenase.',
      userComment: 'COX-1 and COX-2',
      headingContext: 'Antiplatelets',
      kind: 'essential',
    });

    expect((await listBanks()).map((b) => b.name)).toEqual(['Inbox', 'Cardiology']);
    expect((await listBanksWithCounts()).map((b) => [b.bank.name, b.count])).toEqual([
      ['Inbox', 1],
      ['Cardiology', 1],
    ]);
    expect((await listRecentHighlights(10)).map((i) => i.highlight.id)).toEqual([
      WARFARIN,
      ASPIRIN,
    ]);
  });

  it('recognises its own quotes as duplicates and its deleted one as restorable, writing nothing new', async () => {
    const before = await snapshot();
    const same = await saveCapture(cap());
    expect(same).toMatchObject({ status: 'duplicate', addedToBank: false });
    expect(same.highlight.id).toBe(ASPIRIN);
    expect(await snapshot()).toEqual(before);

    const heparin = 'Heparin potentiates antithrombin III.';
    const restored = await saveCapture(
      cap(heparin, 1800, { anchorSet: anchor(heparin, 1800, 'class: ', ' note') }),
    );
    expect(restored).toMatchObject({ status: 'restored', addedToBank: false });
    expect(restored.highlight.id).toBe(HEPARIN);
    const after = await snapshot();
    expect(after.highlights.find((r) => r.id === HEPARIN)).toMatchObject({ deletedAt: null });
    expect(stable(after.sources)).toEqual(stable(before.sources));
    expect(after.banks).toEqual(before.banks);
  });

  it('adds new rows beside the old ones without a second Inbox or Source, and leaves old rows as written', async () => {
    const before = await snapshot();
    const created = await saveCapture(cap('Clopidogrel blocks the P2Y12 receptor.', 3000));
    expect(created.status).toBe('created');

    const after = await snapshot();
    expect(after.banks).toEqual(before.banks); // the same Inbox row, not a new one
    expect(stable(after.sources)).toEqual(stable(before.sources));
    expect(after.highlights).toHaveLength(before.highlights.length + 1);
    for (const old of before.highlights) {
      expect(after.highlights.find((r) => r.id === old.id)).toEqual(old);
    }
    const added = after.highlights.find((r) => r.id === created.highlight.id)!;
    expect(added).toMatchObject({
      schemaVersion: 1,
      sourceId: 'src-pharm-0001',
      capturedUrl: 'https://example.com/notes/pharm?utm_source=newsletter',
      capturedTitle: 'Pharmacology notes',
    });
  });

  it('edits, deletes and restores an old row without disturbing what it does not touch', async () => {
    const [old] = (await snapshot()).highlights.filter((r) => r.id === ASPIRIN);
    await updateHighlight(ASPIRIN, { priority: 5, userComment: 'edited' });
    await softDeleteHighlight(ASPIRIN);
    await restoreHighlight(ASPIRIN);
    await reportResolutions([{ id: ASPIRIN, status: 'changed', confidence: 0.7 }]);

    const row = (await snapshot()).highlights.find((r) => r.id === ASPIRIN)!;
    expect(row).toMatchObject({
      priority: 5,
      userComment: 'edited',
      deletedAt: null,
      resolveStatus: 'changed',
      resolveConfidence: 0.7,
    });
    for (const key of ['exactQuote', 'normalizedQuote', 'quoteHash', 'anchorSet', 'sourceId']) {
      expect(row[key], key).toEqual(old![key]);
    }
    expect(await createBank('Renal')).toMatchObject({ name: 'Renal', isInbox: false });
  });
});

describe('rows written by a newer build (schemaVersion 2)', () => {
  /** Inbox, source and one highlight were last written by a build that knows schema 2. */
  function newer(): Snapshot {
    const data = fresh();
    const upgrade = (row: Row) => Object.assign(row, { schemaVersion: 2, futureField: { x: 1 } });
    upgrade(data.banks[0]!);
    data.banks[0]!.name = 'Inbox (schema 2)';
    upgrade(data.sources[0]!);
    upgrade(data.highlights[1]!); // WARFARIN
    return data;
  }

  it('still reads them: the Inbox is the stored row, not a virtual or a second one', async () => {
    await seed(newer());
    expect((await listBanks()).map((b) => [b.id, b.name])).toEqual([
      [INBOX_BANK_ID, 'Inbox (schema 2)'],
      ['bank-cardiology-01', 'Cardiology'],
    ]);
    const page = await getPageHighlights(PAGE_URL, null);
    expect(page.highlights.map((h) => h.id)).toEqual([ASPIRIN, WARFARIN]);
    expect((await listRecentHighlights(10)).map((i) => i.source.id)).toEqual([
      'src-pharm-0001',
      'src-pharm-0001',
    ]);
  });

  it('refuses every write with storage_unavailable and changes nothing', async () => {
    const seeded = newer();
    await seed(seeded);
    const before = await snapshot();
    const refused = {
      code: 'storage_unavailable',
      message: expect.stringMatching(/newer version/),
    };

    await expect(saveCapture(cap())).rejects.toMatchObject(refused);
    await expect(
      saveCapture(cap('A brand new quote on the same page.', 4000)),
    ).rejects.toMatchObject(refused);
    await expect(updateHighlight(ASPIRIN, { priority: 1 })).rejects.toMatchObject(refused);
    await expect(softDeleteHighlight(ASPIRIN)).rejects.toMatchObject(refused);
    await expect(restoreHighlight(HEPARIN)).rejects.toMatchObject(refused);
    await expect(
      reportResolutions([{ id: ASPIRIN, status: 'resolved', confidence: 1 }]),
    ).rejects.toMatchObject(refused);
    await expect(createBank('Renal')).rejects.toMatchObject(refused);

    const after = await snapshot();
    expect({ ...after, banks: byId(after.banks) }).toEqual({
      ...before,
      banks: byId(before.banks),
    });
    // Byte for byte what the newer build wrote, unknown fields included.
    expect(byId(after.banks).find((r) => r.id === INBOX_BANK_ID)).toEqual(seeded.banks[0]);
    expect(after.highlights.find((r) => r.id === WARFARIN)).toEqual(seeded.highlights[1]);
  });

  it('wiping the data is the way out', async () => {
    await seed(newer());
    await expect(saveCapture(cap())).rejects.toMatchObject({ code: 'storage_unavailable' });
    await wipeAllData();
    expect((await saveCapture(cap())).status).toBe('created');
    const after = await snapshot();
    expect(after.banks).toHaveLength(1);
    expect(after.sources).toHaveLength(1);
  });
});

describe('rows that exist but cannot be read are never written over', () => {
  it('an unreadable Inbox stops a capture into it instead of being replaced', async () => {
    const data = fresh();
    Object.assign(data.banks[0]!, { color: 'chartreuse' }); // schemaVersion 1, invalid colour
    await seed(data);
    const before = await snapshot();

    await expect(saveCapture(cap('Needs the Inbox.', 5000))).rejects.toMatchObject({
      code: 'storage_unavailable',
      message: expect.stringMatching(/Inbox/),
    });
    await expect(createBank('Renal')).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await snapshot()).toEqual(before);

    // A bank that can be read is still usable, and the Inbox row stays as it was.
    const elsewhere = await saveCapture(
      cap('Goes to Cardiology.', 5000, { bankId: 'bank-cardiology-01' }),
    );
    expect(elsewhere.status).toBe('created');
    const after = await snapshot();
    expect(after.banks).toEqual(before.banks);
    expect(after.highlights).toHaveLength(before.highlights.length + 1);
  });

  it('an unreadable source row is left alone, not replaced', async () => {
    const data = fresh();
    Object.assign(data.sources[0]!, { schemaVersion: 'one' });
    await seed(data);
    const result = await saveCapture(cap('Quote beside an unreadable source.', 6000));
    expect(result.status).toBe('created');
    const after = await snapshot();
    expect(after.sources.find((r) => r.id === 'src-pharm-0001')).toEqual(data.sources[0]);
    expect(after.sources).toHaveLength(2);
  });
});
