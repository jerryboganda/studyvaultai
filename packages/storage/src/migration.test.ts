// @vitest-environment node
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDb, DB_NAME, resetDbForTests, SCHEMA_V1, StudyVaultDb } from './db';
import { getPageHighlights, listBanks, saveCapture } from './repo';
import { cap } from './test-fixtures';

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
});

describe('schema version 1', () => {
  it('creates the expected tables and indexes from an empty database', async () => {
    const db = new StudyVaultDb('studyvault-fresh');
    try {
      await db.open();
      expect(db.verno).toBe(1);
      expect(db.tables.map((t) => t.name).sort()).toEqual(Object.keys(SCHEMA_V1).sort());
      const index = (table: keyof typeof SCHEMA_V1) =>
        db
          .table(table)
          .schema.indexes.map((i) => i.name)
          .sort();
      expect(index('banks')).toEqual(['isInbox', 'position']);
      expect(index('sources')).toEqual(['updatedAt', 'urlKey', 'visitedKey']);
      expect(index('highlights')).toEqual(
        [
          '[sourceId+quoteHash]',
          'capturedAt',
          'deletedAt',
          'quoteHash',
          'sourceId',
          'updatedAt',
        ].sort(),
      );
      expect(index('highlightBanks')).toEqual(['bankId', 'highlightId']);
      expect(db.highlightBanks.schema.primKey.name).toBe('[highlightId+bankId]');
    } finally {
      db.close();
      await Dexie.delete('studyvault-fresh');
    }
  });

  it('can be opened by two connections at once and by a second connection later', async () => {
    const a = new StudyVaultDb();
    const b = new StudyVaultDb();
    try {
      await Promise.all([a.open(), b.open()]);
      await a.banks.put({
        id: 'bank-from-a',
        schemaVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
        name: 'From A',
        color: 'blue',
        position: 3,
        isInbox: false,
      });
      expect((await b.banks.get('bank-from-a'))?.name).toBe('From A');
    } finally {
      a.close();
      b.close();
    }
    // Reopen after a "restart": the shared singleton sees the same data.
    expect((await listBanks()).map((x) => x.id)).toContain('bank-from-a');
  });
});

describe('migration readiness (what Phase 2 will do)', () => {
  it('keeps version-1 data and applies an upgrade function when version 2 is declared', async () => {
    const saved = await saveCapture(cap());
    closeDb();

    const upgraded = new Dexie(DB_NAME);
    upgraded.version(1).stores(SCHEMA_V1);
    upgraded
      .version(2)
      .stores({ notes: 'id, highlightId' })
      .upgrade((tx) =>
        tx
          .table('highlights')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            row.tagIds = [];
          }),
      );
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(2);
      const highlights = await upgraded.table('highlights').toArray();
      expect(highlights).toHaveLength(1);
      expect(highlights[0]).toMatchObject({
        id: saved.highlight.id,
        exactQuote: saved.highlight.exactQuote,
        tagIds: [],
      });
      expect(await upgraded.table('banks').count()).toBe(1);
      expect(await upgraded.table('highlightBanks').count()).toBe(1);
      await upgraded.table('notes').put({ id: 'note-1', highlightId: saved.highlight.id });
      expect(await upgraded.table('notes').count()).toBe(1);
    } finally {
      upgraded.close();
    }
  });

  it('lets the version-1 code keep reading a database upgraded by a newer additive version', async () => {
    // Downgrade safety: Dexie 4 opens a database whose declared version is newer, so a rolled-back
    // extension build still reads its data instead of failing at startup.
    await saveCapture(cap());
    closeDb();
    const newer = new Dexie(DB_NAME);
    newer.version(1).stores(SCHEMA_V1);
    newer.version(2).stores({ notes: 'id' });
    await newer.open();
    newer.close();

    const page = await getPageHighlights('https://example.com/notes/pharm', null);
    expect(page.highlights).toHaveLength(1);
  });
});
