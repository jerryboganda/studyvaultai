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
  SCHEMA_V3,
  SCHEMA_V4,
  StudyVaultDb,
  upgradeV1ToV2,
  upgradeV3ToV4,
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

describe('schema version 4 (current)', () => {
  it('declares every planned table with exactly the planned indexes', async () => {
    const db = new StudyVaultDb('studyvault-fresh');
    try {
      await db.open();
      expect(db.verno).toBe(DB_VERSION);
      expect(DB_VERSION).toBe(4);
      expect(db.tables.map((t) => t.name).sort()).toEqual(Object.keys(SCHEMA_V4).sort());
      for (const [table, spec] of Object.entries(SCHEMA_V4)) {
        expect(indexNames(db, table), table).toEqual(declared(spec));
        expect(db.table(table).schema.primKey.name, table).toBe(spec.split(',')[0]!.trim());
      }
      // The brief's database plan, spot-checked by name.
      expect(indexNames(db, 'folders')).toContain('[bankId+parentFolderId]');
      expect(indexNames(db, 'cards')).toContain('[deckId+dueAt]');
      expect(db.table('ocrPages').schema.primKey.name).toBe('[documentId+pageNumber]');
      // Sync (v3): the outbox gains its order/pending indexes, three device-local tables appear.
      expect(indexNames(db, 'syncOps')).toEqual(expect.arrayContaining(['seq', '[pending+seq]']));
      expect(db.table('syncEntityMeta').schema.primKey.name).toBe('[entityType+entityId]');
      expect(indexNames(db, 'syncEntityMeta')).toContain('tombstoneAt');
    } finally {
      db.close();
      await Dexie.delete('studyvault-fresh');
    }
  });

  it('v3 only adds to v2: every v2 table keeps its exact definition except the syncOps outbox', () => {
    for (const [table, spec] of Object.entries(SCHEMA_V2)) {
      if (table === 'syncOps') continue;
      expect(SCHEMA_V3[table as keyof typeof SCHEMA_V3], table).toBe(spec);
    }
    expect(SCHEMA_V3.syncOps.startsWith(SCHEMA_V2.syncOps)).toBe(true);
  });

  it('v4 only adds to v3: every v3 table keeps its exact definition, three tables appear', () => {
    for (const [table, spec] of Object.entries(SCHEMA_V3)) {
      expect(SCHEMA_V4[table as keyof typeof SCHEMA_V4], table).toBe(spec);
    }
    expect(
      Object.keys(SCHEMA_V4)
        .filter((t) => !(t in SCHEMA_V3))
        .sort(),
    ).toEqual(['filingRules', 'relations', 'syllabi']);
  });

  it('declares the indexes the organisation queries use', async () => {
    const db = new StudyVaultDb('studyvault-v4-shape');
    try {
      await db.open();
      expect(indexNames(db, 'filingRules')).toEqual(['deletedAt', 'order', 'updatedAt']);
      expect(indexNames(db, 'syllabi')).toEqual(['deletedAt', 'updatedAt']);
      expect(indexNames(db, 'relations')).toEqual(
        expect.arrayContaining(['[fromKind+fromId]', '[toKind+toId]', 'fromId', 'toId']),
      );
    } finally {
      db.close();
      await Dexie.delete('studyvault-v4-shape');
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
    '%s: opens at the current version, keeps every row byte for byte, adds a meta marker',
    async (_label, name) => {
      const v1 = loadFixture(name);
      await seedV1(v1);

      // First contact with the database is a normal repo call: it performs the upgrade.
      await listBanks();
      expect(getDb().verno).toBe(DB_VERSION);

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
      for (const table of Object.keys(SCHEMA_V4)) {
        if (table in SCHEMA_V1 || table === 'meta') continue;
        expect(after[table], table).toEqual([]);
      }
      expect(after.meta).toHaveLength(1);
      expect(after.meta![0]).toMatchObject({
        key: META_SCHEMA_KEY,
        value: {
          dbVersion: DB_VERSION,
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

  it('two connections opening a v1 database at the same time both end up on the current version, upgraded once', async () => {
    const v1 = loadFixture('schema-v1.json');
    await seedV1(v1);
    closeDb();
    const a = new StudyVaultDb();
    const b = new StudyVaultDb();
    try {
      await Promise.all([a.open(), b.open()]);
      expect(a.verno).toBe(DB_VERSION);
      expect(b.verno).toBe(DB_VERSION);
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
    expect(getDb().verno).toBe(DB_VERSION);
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
    expect(getDb().verno).toBe(DB_VERSION);
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
      expect(seen).toEqual([
        { from: 1, to: DB_VERSION, highlights: v1.highlights.length, hasMeta: false },
      ]);
      expect(getDb().verno).toBe(DB_VERSION);

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
      expect(getDb().verno).toBe(DB_VERSION);
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
    newer.version(3).stores(SCHEMA_V3);
    newer.version(4).stores(SCHEMA_V4);
    newer.version(5).stores({ somethingNew: 'id' });
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

describe('upgrading a version-2 database to version 3', () => {
  /** A v2 database as the previous build left it, with a marker and a legacy outbox row. */
  async function seedV2() {
    const v1 = loadFixture('schema-v1.json');
    await resetDbForTests();
    const legacy = new Dexie(DB_NAME);
    legacy.version(1).stores(SCHEMA_V1);
    legacy.version(2).stores(SCHEMA_V2);
    try {
      await legacy.open();
      for (const table of ['banks', 'sources', 'highlights', 'highlightBanks'] as const) {
        await legacy.table(table).bulkPut(v1[table]);
      }
      await legacy.table('meta').put({
        key: META_SCHEMA_KEY,
        value: { dbVersion: 2, recordSchemaVersion: 1, migratedFrom: 1, skipped: 0 },
        updatedAt: '2026-10-01T00:00:00.000Z',
      });
      await legacy.table('syncOps').bulkPut([
        { id: 'op-legacy-0002', createdAt: '2026-10-02T00:00:00.000Z', sentAt: null },
        { id: 'op-legacy-0001', createdAt: '2026-10-01T00:00:00.000Z', sentAt: 1_700_000_000_000 },
      ]);
    } finally {
      legacy.close();
    }
    return v1;
  }

  it('keeps every row, orders a legacy outbox row set, and advances the marker without losing history', async () => {
    const v1 = await seedV2();
    await listBanks(); // performs the upgrade
    const db = getDb();
    expect(db.verno).toBe(DB_VERSION);
    const after = await dump();
    for (const table of ['banks', 'sources', 'highlights', 'highlightBanks'] as const) {
      const key =
        table === 'highlightBanks'
          ? (r: Row) => `${r.highlightId}|${r.bankId}`
          : (r: Row) => String(r.id);
      const sorted = (rows: Row[]) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
      expect(sorted(after[table]!), table).toEqual(sorted(v1[table]));
    }
    // New tables exist and are empty.
    for (const t of ['syncEntityMeta', 'syncConflicts', 'syncQuarantine']) {
      expect(after[t], t).toEqual([]);
    }
    const ops = [...after.syncOps!].sort((a, b) => Number(a.seq) - Number(b.seq));
    expect(ops.map((o) => [o.id, o.seq, o.pending])).toEqual([
      ['op-legacy-0001', 1, 0], // oldest first, already sent: not pending
      ['op-legacy-0002', 2, 1],
    ]);
    expect(after.meta!.find((m) => m.key === META_SCHEMA_KEY)).toMatchObject({
      value: { dbVersion: DB_VERSION, migratedFrom: 1, v3OpsFixed: 2 },
    });
  });

  it('re-opening after the upgrade changes nothing', async () => {
    await seedV2();
    await listBanks();
    const first = await dump();
    closeDb();
    await listBanks();
    expect(await dump()).toEqual(first);
  });

  it('a failure inside the v3 step leaves the v2 database untouched', async () => {
    await seedV2();
    const failing = new Dexie(DB_NAME);
    failing.version(1).stores(SCHEMA_V1);
    failing.version(2).stores(SCHEMA_V2);
    failing
      .version(3)
      .stores(SCHEMA_V3)
      .upgrade(async (tx) => {
        const { upgradeV2ToV3 } = await import('./db');
        await upgradeV2ToV3(tx);
        throw new Error('injected v3 failure');
      });
    await expect(failing.open()).rejects.toThrow(/injected v3 failure/);
    failing.close();
    const probe = new Dexie(DB_NAME);
    await probe.open();
    try {
      expect(probe.verno).toBe(2);
      expect(await probe.table('syncOps').toArray()).toEqual(
        expect.arrayContaining([expect.not.objectContaining({ seq: expect.anything() })]),
      );
    } finally {
      probe.close();
    }
    expect((await listBanks()).length).toBeGreaterThan(0); // the real build still upgrades it
    expect(getDb().verno).toBe(DB_VERSION);
  });
});

describe('upgrading a version-3 database to version 4', () => {
  const TS = '2026-10-05T10:00:00.000Z';
  const envelope = { schemaVersion: 1, createdAt: TS, updatedAt: TS, deletedAt: null };

  /**
   * A database exactly as the v3 build left it: the real v1, v2 and v3 store strings, a row in every
   * v3 table (the sync bookkeeping ones included) and the marker the earlier upgrades write. Returns
   * what is stored, read back from that connection, so "untouched" means byte for byte.
   */
  async function seedV3(): Promise<Record<string, Row[]>> {
    const v1 = loadFixture('schema-v1.json');
    await resetDbForTests();
    const legacy = new Dexie(DB_NAME);
    legacy.version(1).stores(SCHEMA_V1);
    legacy.version(2).stores(SCHEMA_V2);
    legacy.version(3).stores(SCHEMA_V3);
    const rows: Record<string, Row[]> = {
      banks: v1.banks,
      sources: v1.sources,
      highlights: v1.highlights,
      highlightBanks: v1.highlightBanks,
      folders: [
        {
          id: 'folder-v3-0001',
          ...envelope,
          bankId: 'bank-cardiology-01',
          parentFolderId: null,
          name: 'Drugs',
          position: 1,
        },
      ],
      tags: [
        {
          id: 'tag-v3-000001',
          ...envelope,
          name: 'High yield',
          nameKey: 'high yield',
          color: null,
          aliases: [],
        },
      ],
      highlightTags: [{ highlightId: 'hl-aspirin-0001', tagId: 'tag-v3-000001', addedAt: TS }],
      notes: [
        {
          id: 'note-v3-00001',
          ...envelope,
          highlightId: 'hl-aspirin-0001',
          sourceId: null,
          title: 't',
          body: 'b',
          pinned: false,
        },
      ],
      knowledgePoints: [
        {
          id: 'kp-v3-0000001',
          ...envelope,
          highlightId: 'hl-aspirin-0001',
          shortOneLiner: 'COX inhibitor',
        },
      ],
      decks: [{ id: 'deck-v3-00001', ...envelope, bankId: null, name: 'General', settings: {} }],
      cards: [
        {
          id: 'card-v3-00001',
          ...envelope,
          deckId: 'deck-v3-00001',
          knowledgePointId: 'kp-v3-0000001',
          highlightId: 'hl-aspirin-0001',
          dueAt: TS,
          fsrs: { state: 'new', due: TS },
          suspended: false,
          front: 'Q',
          back: 'A',
        },
      ],
      reviewLogs: [
        { id: 'log-v3-000001', cardId: 'card-v3-00001', reviewedAt: TS, sessionId: 's-1' },
      ],
      aiResults: [
        {
          id: 'ai-v3-0000001',
          inputFingerprint: 'f'.repeat(16),
          highlightId: 'hl-aspirin-0001',
          kind: 'summary',
          createdAt: TS,
          acceptedAt: null,
        },
      ],
      documents: [
        { id: 'doc-v3-0000001', ...envelope, title: 'Notes.pdf', pageCount: 3, textStatus: 'text' },
      ],
      ocrPages: [{ documentId: 'doc-v3-0000001', pageNumber: 1, text: 'page one' }],
      syncOps: [
        {
          id: 'op-v3-00000001',
          entityType: 'notes',
          entityId: 'note-v3-00001',
          clientId: 'c-1',
          createdAt: TS,
          sentAt: null,
          seq: 1,
          pending: 1,
          attempts: 0,
        },
      ],
      syncEntityMeta: [
        { entityType: 'notes', entityId: 'note-v3-00001', clocks: {}, tombstoneAt: null },
      ],
      syncConflicts: [
        {
          id: 'conf-v3-00001',
          entityType: 'notes',
          entityId: 'note-v3-00001',
          kind: 'text',
          detectedAt: TS,
        },
      ],
      syncQuarantine: [
        { id: 'quar-v3-00001', entityType: 'notes', entityId: 'x', reason: 'row_invalid', at: TS },
      ],
      meta: [
        {
          key: META_SCHEMA_KEY,
          value: {
            dbVersion: 3,
            recordSchemaVersion: 1,
            migratedFrom: 1,
            v3MigratedAt: TS,
            v3OpsFixed: 0,
            skipped: 0,
          },
          updatedAt: TS,
        },
        { key: 'aiSettings', value: { provider: 'none' }, updatedAt: TS },
        { key: 'lastPurgeAt', value: TS, updatedAt: TS },
      ],
    };
    try {
      await legacy.open();
      for (const [table, list] of Object.entries(rows)) await legacy.table(table).bulkPut(list);
      const stored: Record<string, Row[]> = {};
      for (const table of legacy.tables) stored[table.name] = (await table.toArray()) as Row[];
      return stored;
    } finally {
      legacy.close();
    }
  }

  it('keeps every row of every v3 table exactly as stored and starts the new tables empty', async () => {
    const before = await seedV3();
    expect(Object.keys(before).sort()).toEqual(Object.keys(SCHEMA_V3).sort());
    await listBanks(); // performs the upgrade
    expect(getDb().verno).toBe(4);
    const after = await dump();
    for (const [table, rows] of Object.entries(before)) {
      if (table === 'meta') continue;
      expect(after[table], table).toEqual(rows);
    }
    for (const table of ['filingRules', 'syllabi', 'relations']) {
      expect(after[table], table).toEqual([]);
    }
    // meta: the marker moved on, every other key is untouched
    expect(after.meta!.filter((m) => m.key !== META_SCHEMA_KEY)).toEqual(
      before.meta!.filter((m) => m.key !== META_SCHEMA_KEY),
    );
    expect(after.meta!.find((m) => m.key === META_SCHEMA_KEY)!.value).toMatchObject({
      dbVersion: 4,
      migratedFrom: 1,
      v3MigratedAt: TS,
      v3OpsFixed: 0,
      v4MigratedAt: expect.any(String),
    });
  });

  it('the three new tables work straight after the upgrade, and the old data is still readable', async () => {
    await seedV3();
    const { createFilingRule } = await import('./rules');
    const { createSyllabus } = await import('./syllabi');
    const { createRelation } = await import('./relations');
    const rule = await createFilingRule({
      name: 'Cardiology sites',
      match: { hosts: ['example.com'] },
      action: { bankId: 'bank-cardiology-01' },
    });
    const syllabus = await createSyllabus({ name: 'Exam', nodes: [{ title: 'Drugs' }] });
    const link = await createRelation({
      fromKind: 'highlight',
      fromId: 'hl-aspirin-0001',
      toKind: 'knowledgePoint',
      toId: 'kp-v3-0000001',
      type: 'supports',
    });
    expect(link.status).toBe('created');
    const after = await dump();
    expect(after.filingRules!.map((r) => r.id)).toEqual([rule.id]);
    expect(after.syllabi!.map((r) => r.id)).toEqual([syllabus.id]);
    expect(after.relations).toHaveLength(1);
    expect((await listBanks()).map((b) => b.id)).toContain('bank-cardiology-01');
  });

  it('re-opening after the upgrade changes nothing', async () => {
    await seedV3();
    await listBanks();
    const first = await dump();
    closeDb();
    await listBanks();
    expect(await dump()).toEqual(first);
  });

  it('the step itself is idempotent: running it again keeps the marker and every row', async () => {
    await seedV3();
    await listBanks();
    const db = getDb();
    const before = await dump();
    await db.transaction('rw', db.meta, async (tx) => {
      await upgradeV3ToV4(tx);
      await upgradeV3ToV4(tx);
    });
    const after = await dump();
    const marker = (rows: Record<string, Row[]>) =>
      rows.meta!.find((m) => m.key === META_SCHEMA_KEY)!.value;
    expect(marker(after)).toEqual(marker(before));
    for (const table of Object.keys(before)) {
      if (table !== 'meta') expect(after[table], table).toEqual(before[table]);
    }
  });

  it('a failure inside the v4 step leaves the v3 database untouched', async () => {
    const before = await seedV3();
    const failing = new Dexie(DB_NAME);
    failing.version(1).stores(SCHEMA_V1);
    failing.version(2).stores(SCHEMA_V2);
    failing.version(3).stores(SCHEMA_V3);
    failing
      .version(4)
      .stores(SCHEMA_V4)
      .upgrade(async (tx) => {
        await upgradeV3ToV4(tx);
        throw new Error('injected v4 failure');
      });
    await expect(failing.open()).rejects.toThrow(/injected v4 failure/);
    failing.close();
    const probe = new Dexie(DB_NAME);
    await probe.open();
    try {
      expect(probe.verno).toBe(3);
      expect(probe.tables.map((t) => t.name).sort()).toEqual(Object.keys(SCHEMA_V3).sort());
      for (const [table, rows] of Object.entries(before)) {
        expect(await probe.table(table).toArray(), table).toEqual(rows);
      }
    } finally {
      probe.close();
    }
    expect((await listBanks()).length).toBeGreaterThan(0); // the real build still upgrades it
    expect(getDb().verno).toBe(4);
  });

  it('hands the old data to the pre-update hook once, at version 3', async () => {
    await seedV3();
    const seen: Array<{ from: number; to: number; tables: string[] }> = [];
    const off = onBeforeMigrate(async (ctx) => {
      seen.push({
        from: ctx.fromVersion,
        to: ctx.toVersion,
        tables: Object.keys(await ctx.counts()),
      });
    });
    try {
      await Promise.all([listBanks(), listBanks()]);
    } finally {
      off();
    }
    expect(seen).toEqual([
      { from: 3, to: DB_VERSION, tables: expect.not.arrayContaining(['filingRules']) },
    ]);
  });
});
