// @vitest-environment node
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { INBOX_BANK_ID } from '@shared';
import {
  closeDb,
  DB_NAME,
  DB_VERSION,
  getDb,
  META_SCHEMA_KEY,
  onBeforeMigrate,
  resetDbForTests,
  SCHEMA_V1,
  SCHEMA_V2,
  StudyVaultDb,
  upgradeV1ToV2,
} from './db';
import { getPageHighlights, listBanks, listBanksWithCounts, saveCapture } from './repo';
import { cap } from './test-fixtures';
import { dump, loadFixture, seedV1, type FixtureName, type Row } from './test-vault';

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const indexNames = (db: Dexie, table: string) =>
  db
    .table(table)
    .schema.indexes.map((i) => i.name)
    .sort();
const declared = (spec: string) =>
  spec
    .split(',')
    .slice(1)
    .map((s) => s.trim())
    .sort();

describe('schema version 1 (frozen strings)', () => {
  it('creates the v1 tables and indexes from an empty database', async () => {
    const db = new Dexie('studyvault-v1-shape');
    db.version(1).stores(SCHEMA_V1);
    try {
      await db.open();
      expect(db.verno).toBe(1);
      expect(db.tables.map((t) => t.name).sort()).toEqual(Object.keys(SCHEMA_V1).sort());
      expect(indexNames(db, 'banks')).toEqual(['isInbox', 'position']);
      expect(indexNames(db, 'highlightBanks')).toEqual(['bankId', 'highlightId']);
      expect(db.table('highlightBanks').schema.primKey.name).toBe('[highlightId+bankId]');
    } finally {
      db.close();
      await Dexie.delete('studyvault-v1-shape');
    }
  });
});

describe('schema version 2', () => {
  it('declares every planned table with exactly the planned indexes', async () => {
    const db = new StudyVaultDb('studyvault-fresh');
    try {
      await db.open();
      expect(db.verno).toBe(DB_VERSION);
      expect(db.tables.map((t) => t.name).sort()).toEqual(Object.keys(SCHEMA_V2).sort());
      for (const [table, spec] of Object.entries(SCHEMA_V2)) {
        expect(indexNames(db, table), table).toEqual(declared(spec));
        expect(db.table(table).schema.primKey.name, table).toBe(spec.split(',')[0]!.trim());
      }
      // The brief's database plan, spot-checked by name.
      expect(indexNames(db, 'folders')).toContain('[bankId+parentFolderId]');
      expect(indexNames(db, 'cards')).toContain('[deckId+dueAt]');
      expect(db.table('ocrPages').schema.primKey.name).toBe('[documentId+pageNumber]');
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
    expect((await listBanks()).map((x) => x.id)).toContain('bank-from-a');
  });
});

const FIXTURES: Array<[string, FixtureName]> = [
  ['the saved-pages fixture', 'schema-v1.json'],
  ['the empty-database fixture', 'schema-v1-empty.json'],
  ['the trash / bank-less fixture', 'schema-v1-trash.json'],
];

describe('upgrading frozen version-1 fixtures through the real repo', () => {
  it.each(FIXTURES)(
    '%s: opens at v2, keeps every row byte for byte, adds a meta marker',
    async (_label, name) => {
      const v1 = loadFixture(name);
      await seedV1(v1);

      // First contact with the database is a normal repo call: it performs the upgrade.
      await listBanks();
      expect(getDb().verno).toBe(2);

      const after = await dump();
      for (const table of ['banks', 'sources', 'highlights', 'highlightBanks'] as const) {
        const key =
          table === 'highlightBanks'
            ? (r: Row) => `${r.highlightId}|${r.bankId}`
            : (r: Row) => String(r.id);
        const sorted = (rows: Row[]) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
        expect(sorted(after[table]!), table).toEqual(sorted(v1[table]));
      }
      // Everything new starts empty, except the marker.
      for (const table of Object.keys(SCHEMA_V2)) {
        if (table in SCHEMA_V1 || table === 'meta') continue;
        expect(after[table], table).toEqual([]);
      }
      expect(after.meta).toHaveLength(1);
      expect(after.meta![0]).toMatchObject({
        key: META_SCHEMA_KEY,
        value: {
          dbVersion: 2,
          recordSchemaVersion: 1,
          migratedFrom: 1,
          highlightBanksFixed: 0,
          sourcesFixed: 0,
          skipped: 0,
        },
      });
    },
  );

  it.each(FIXTURES)(
    '%s: re-opening is idempotent (a restart changes nothing)',
    async (_label, name) => {
      await seedV1(loadFixture(name));
      await listBanks();
      const first = await dump();
      closeDb();
      await listBanks();
      closeDb();
      await getPageHighlights('https://example.com/notes/pharm', null);
      expect(await dump()).toEqual(first);
    },
  );

  it('two connections opening a v1 database at the same time both end up on v2, upgraded once', async () => {
    const v1 = loadFixture('schema-v1.json');
    await seedV1(v1);
    closeDb();
    const a = new StudyVaultDb();
    const b = new StudyVaultDb();
    try {
      await Promise.all([a.open(), b.open()]);
      expect(a.verno).toBe(2);
      expect(b.verno).toBe(2);
      expect(await a.table('highlights').count()).toBe(v1.highlights.length);
      expect(await b.table('meta').count()).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });

  it('the empty database still works end to end after the upgrade', async () => {
    await seedV1(loadFixture('schema-v1-empty.json'));
    expect(await listBanksWithCounts()).toEqual([
      { bank: expect.objectContaining({ id: INBOX_BANK_ID }), count: 0 },
    ]);
    const saved = await saveCapture(cap());
    expect(saved.status).toBe('created');
    expect(getDb().verno).toBe(2);
  });

  it('the trash fixture keeps its trash, its bank-less highlight and its deleted bank', async () => {
    await seedV1(loadFixture('schema-v1-trash.json'));
    const { listTrash } = await import('./trash');
    const { listHighlights } = await import('./query');
    const trash = await listTrash();
    expect(trash.map((t) => [t.kind, t.id]).sort()).toEqual(
      [
        ['bank', 'bank-gone-00001'],
        ['highlight', 'hl-trashed-0001'],
        ['highlight', 'hl-trashed-0002'],
      ].sort(),
    );
    // The bank-less highlight is still a live highlight: reads do not drop it.
    const page = await listHighlights({});
    expect(page.items.map((i) => i.highlight.id).sort()).toEqual([
      'hl-bankless-001',
      'hl-live-0000001',
      'hl-repeat-00001',
    ]);
    const bankless = page.items.find((i) => i.highlight.id === 'hl-bankless-001')!;
    expect(bankless.banks).toEqual([]);
    expect(bankless.locations).toEqual([]);
  });

  it('fills the fields v1 left implicit and never rewrites a row that would not validate', async () => {
    const v1 = loadFixture('schema-v1.json');
    const noFolder = {
      highlightId: 'hl-aspirin-0001',
      bankId: 'bank-cardiology-01',
      addedAt: '2026-10-01T09:06:00.000Z',
    };
    // Same, but the highlightId is not a valid id: it must be left exactly as stored.
    const unreadable = {
      highlightId: '',
      bankId: INBOX_BANK_ID,
      addedAt: '2026-10-01T09:07:00.000Z',
    };
    const noType: Row = {
      ...structuredClone(v1.sources[0]!),
      id: 'src-no-type-001',
      urlKey: 'https://example.com/b',
      visitedKey: 'https://example.com/b',
    };
    delete noType.type;
    v1.highlightBanks.push(noFolder, unreadable);
    v1.sources.push(noType);
    await seedV1(v1);

    await listBanks();
    const after = await dump();
    expect(after.highlightBanks).toContainEqual({ ...noFolder, folderId: null });
    expect(after.highlightBanks).toContainEqual(unreadable);
    expect(after.sources!.find((s) => s.id === 'src-no-type-001')).toMatchObject({ type: 'web' });
    expect(after.meta![0]!.value).toMatchObject({
      highlightBanksFixed: 1,
      sourcesFixed: 1,
      skipped: 1,
    });
  });
});

describe('the upgrade is transactional', () => {
  it('a failure inside the upgrade leaves the database at v1 with every row intact', async () => {
    const v1 = loadFixture('schema-v1.json');
    await seedV1(v1);

    const failing = new Dexie(DB_NAME);
    failing.version(1).stores(SCHEMA_V1);
    failing
      .version(2)
      .stores(SCHEMA_V2)
      .upgrade(async (tx) => {
        await upgradeV1ToV2(tx); // the real step ran and wrote its marker ...
        throw new Error('injected upgrade failure'); // ... then the build fails
      });
    await expect(failing.open()).rejects.toThrow(/injected upgrade failure/);
    failing.close();

    const probe = new Dexie(DB_NAME);
    await probe.open();
    try {
      expect(probe.verno).toBe(1);
      expect(probe.tables.map((t) => t.name).sort()).toEqual(Object.keys(SCHEMA_V1).sort());
      expect(await probe.table('highlights').count()).toBe(v1.highlights.length);
    } finally {
      probe.close();
    }
    // And the real build can still upgrade it afterwards.
    expect((await listBanks()).map((b) => b.id)).toContain('bank-cardiology-01');
    expect(getDb().verno).toBe(2);
  });
});

describe('onBeforeMigrate', () => {
  it('hands the old data to the hook before the upgrade runs, once', async () => {
    const v1 = loadFixture('schema-v1.json');
    await seedV1(v1);
    const seen: Array<{ from: number; to: number; highlights: number; hasMeta: boolean }> = [];
    const off = onBeforeMigrate(async (ctx) => {
      const data = await ctx.snapshot();
      seen.push({
        from: ctx.fromVersion,
        to: ctx.toVersion,
        highlights: data.highlights?.length ?? -1,
        hasMeta: 'meta' in data,
      });
    });
    try {
      await Promise.all([
        listBanks(),
        listBanks(),
        getPageHighlights('https://example.com/x', null),
      ]);
      expect(seen).toEqual([{ from: 1, to: 2, highlights: v1.highlights.length, hasMeta: false }]);
      expect(getDb().verno).toBe(2);

      // Already current: nothing to protect, the hook stays quiet.
      closeDb();
      await listBanks();
      expect(seen).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('is not called for a brand-new database', async () => {
    const hook = vi.fn();
    const off = onBeforeMigrate(hook);
    try {
      await listBanks();
      expect(hook).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('a failing hook is logged and the upgrade still happens', async () => {
    await seedV1(loadFixture('schema-v1.json'));
    const off = onBeforeMigrate(() => {
      throw new Error('backup target is full');
    });
    try {
      expect((await listBanks()).length).toBeGreaterThan(0);
      expect(getDb().verno).toBe(2);
    } finally {
      off();
    }
  });

  it('a required hook that fails stops the upgrade: the database stays at v1', async () => {
    await seedV1(loadFixture('schema-v1.json'));
    const off = onBeforeMigrate(
      () => {
        throw new Error('backup target is full');
      },
      { required: true },
    );
    try {
      await expect(listBanks()).rejects.toMatchObject({
        code: 'storage_unavailable',
        message: expect.stringMatching(/backup that must precede the upgrade failed/),
      });
    } finally {
      off();
    }
    closeDb();
    const probe = new Dexie(DB_NAME);
    await probe.open();
    expect(probe.verno).toBe(1);
    probe.close();
    // With the hook gone the same data upgrades.
    expect((await listBanks()).length).toBeGreaterThan(0);
  });
});

describe('a database written by a newer build', () => {
  it('is still read by this build (additive newer version)', async () => {
    await saveCapture(cap());
    closeDb();
    const newer = new Dexie(DB_NAME);
    newer.version(1).stores(SCHEMA_V1);
    newer.version(2).stores(SCHEMA_V2);
    newer.version(3).stores({ somethingNew: 'id' });
    await newer.open();
    newer.close();

    const page = await getPageHighlights('https://example.com/notes/pharm', null);
    expect(page.highlights).toHaveLength(1);
  });

  it('refuses writes while a vault row carries a schemaVersion this build does not know', async () => {
    const { createFolder } = await import('./hierarchy');
    const { createTag } = await import('./tags');
    await saveCapture(cap());
    const db = getDb();
    await db.tags.put({
      id: 'tag-from-the-future',
      schemaVersion: 2 as unknown as 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      name: 'future',
      nameKey: 'future',
      color: null,
      aliases: [],
    });
    closeDb();
    await expect(createTag('new tag')).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(createFolder({ bankId: INBOX_BANK_ID, name: 'x' })).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
  });
});
