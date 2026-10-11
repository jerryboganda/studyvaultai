// @vitest-environment node
import 'fake-indexeddb/auto';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOX_BANK_ID, SCHEMA_VERSION } from '@shared';
import { DB_VERSION, SCHEMA_V2, getDb } from './db';
import { createFolder } from './hierarchy';
import { addToBank } from './membership';
import { createNote } from './notes';
import {
  checkIntegrity,
  getTableRegistry,
  registerTableSchema,
  tableRegistry,
  unregisteredTables,
} from './registry';
import { createBank } from './repo';
import { attachTags, createTag } from './tags';
import { dump, freshDatabase, loadFixture, save, seedV1 } from './test-vault';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('table registry', () => {
  it('lists exactly the tables of the Dexie schema, with matching primary keys', async () => {
    const registry = getTableRegistry();
    expect(registry.schemaVersion).toBe(DB_VERSION);
    // The registry describes the vault's tables: the sync bookkeeping tables of v3 are not in it.
    expect(registry.tables.map((t) => t.name).sort()).toEqual(
      [...Object.keys(SCHEMA_V2), 'filingRules', 'syllabi', 'relations'].sort(),
    );
    const db = getDb();
    await db.open();
    for (const spec of registry.tables) {
      const declared = db.table(spec.name).schema.primKey;
      const expected = Array.isArray(spec.primaryKey)
        ? `[${spec.primaryKey.join('+')}]`
        : (spec.primaryKey as string);
      expect(declared.name, spec.name).toBe(expected);
    }
  });

  it('describes soft deletion, references and local-only tables for backup and sync', () => {
    const byName = new Map(getTableRegistry().tables.map((t) => [t.name, t]));
    for (const soft of [
      'banks',
      'sources',
      'highlights',
      'folders',
      'tags',
      'notes',
      'documents',
    ]) {
      expect(byName.get(soft)!.softDelete, soft).toBe(true);
    }
    for (const plain of ['highlightBanks', 'highlightTags', 'attachments', 'ocrPages', 'meta']) {
      expect(byName.get(plain)!.softDelete, plain).toBe(false);
    }
    // The organisation records of schema v4 carry their real schemas from the start.
    for (const name of ['filingRules', 'syllabi', 'relations']) {
      expect(byName.get(name)!.softDelete, name).toBe(true);
      expect(unregisteredTables(), name).not.toContain(name);
    }
    expect(byName.get('attachments')!.localOnly).toBe(true);
    expect(byName.get('highlights')!.references).toEqual([{ field: 'sourceId', table: 'sources' }]);
    expect(byName.get('highlights')!.derivedFields).toContain('resolveStatus');
    // Every reference points at a table that exists.
    for (const spec of byName.values()) {
      for (const ref of spec.references ?? [])
        expect(byName.has(ref.table), `${spec.name}.${ref.field}`).toBe(true);
    }
  });

  it('validates real rows with the registered schemas', async () => {
    const h = await save('Registry row');
    await createNote({ highlightId: h.id, body: 'n' });
    const tag = (await createTag('t')).tag;
    await attachTags({ highlightIds: [h.id], tagIds: [tag.id] });
    const folder = await createFolder({ bankId: INBOX_BANK_ID, name: 'F' });
    await addToBank({ highlightId: h.id, bankId: INBOX_BANK_ID, folderId: folder.id });
    const data = await dump();
    for (const spec of getTableRegistry().tables) {
      for (const row of data[spec.name] ?? []) {
        expect(
          spec.schema.safeParse(row).success,
          `${spec.name} ${JSON.stringify(row).slice(0, 80)}`,
        ).toBe(true);
      }
    }
  });

  it('lets another module attach its schema, and refuses unknown table names', () => {
    expect(unregisteredTables()).toEqual(
      expect.arrayContaining(['cards', 'decks', 'knowledgePoints', 'reviewLogs', 'syncOps']),
    );
    // The AI repository is imported by the restore guards, so aiResults registers with the barrel.
    expect(unregisteredTables()).not.toContain('aiResults');
    const Card = z.object({ id: z.string(), deckId: z.string(), front: z.string() });
    registerTableSchema('cards', Card);
    const cards = getTableRegistry().tables.find((t) => t.name === 'cards')!;
    expect(cards.schema).toBe(Card);
    // The exported live view sees it too.
    expect(tableRegistry.tables.find((t) => t.name === 'cards')!.schema).toBe(Card);
    expect(tableRegistry.schemaVersion).toBe(DB_VERSION);
    expect(unregisteredTables()).not.toContain('cards');
    expect(() => registerTableSchema('carts', Card)).toThrow(/Unknown table/);
    // restore the placeholder for the other tests in this file
    registerTableSchema('cards', z.looseObject({ id: z.string().min(1) }));
  });
});

describe('checkIntegrity', () => {
  it('reports a clean database as ok and does not write', async () => {
    const bank = await createBank('Cardiology');
    const h = await save('Fine row', { bankId: bank.id });
    await createNote({ highlightId: h.id, body: 'n' });
    const before = await dump();
    const report = await checkIntegrity();
    expect(report).toMatchObject({ ok: true, issues: [], truncated: false });
    expect(report.tables.highlights).toEqual({ rows: 1, invalid: 0, newer: 0 });
    expect(await dump()).toEqual(before);
  });

  it('passes the frozen v1 fixtures after their upgrade', async () => {
    for (const name of [
      'schema-v1.json',
      'schema-v1-empty.json',
      'schema-v1-trash.json',
    ] as const) {
      await seedV1(loadFixture(name));
      const report = await checkIntegrity();
      // The trash fixture deliberately holds a membership of a deleted bank: soft-deleted rows still exist.
      expect(report.issues, name).toEqual([]);
    }
  });

  it('finds orphans, invalid rows, newer schemas, id collisions, duplicate tags and a second Inbox', async () => {
    const h = await save('Row to damage');
    const db = getDb();
    const source = (await db.highlights.get(h.id))!.sourceId;

    await db.highlightBanks.put({
      highlightId: 'ghost-highlight-1',
      bankId: INBOX_BANK_ID,
      folderId: null,
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    await db.highlightBanks.put({
      highlightId: h.id,
      bankId: 'ghost-bank-0001',
      folderId: 'ghost-folder-1',
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    await db.highlights.put({
      ...(await db.highlights.get(h.id))!,
      id: 'hl-no-source-01',
      sourceId: 'ghost-source-1',
    });
    await db.notes.put({
      id: 'note-orphan-01',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      highlightId: 'ghost-highlight-2',
      sourceId: source,
      title: '',
      body: 'b',
      pinned: false,
    });
    await db.banks.put({
      id: 'bank-broken-001',
      schemaVersion: 1,
      name: '',
      color: 'nope',
    } as never);
    await db.banks.put({
      id: 'bank-future-001',
      schemaVersion: 7 as never,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      name: 'From the future',
      color: 'blue',
      position: 9,
      isInbox: false,
    });
    await db.banks.put({
      id: 'bank-second-inbox',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      name: 'Fake inbox',
      color: 'blue',
      position: 3,
      isInbox: true,
    });
    // The same id in two entity tables.
    await db.tags.put({
      id: h.id,
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      name: 'clash',
      nameKey: 'clash',
      color: null,
      aliases: [],
    });
    await db.tags.put({
      id: 'tag-clash-0001',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      name: 'Clash',
      nameKey: 'clash',
      color: null,
      aliases: [],
    });
    // Missing schemaVersion on a versioned table.
    await db.folders.put({
      id: 'folder-nover-01',
      bankId: INBOX_BANK_ID,
      parentFolderId: null,
      name: 'x',
      position: 1,
    } as never);

    const before = await dump();
    const report = await checkIntegrity();
    expect(await dump()).toEqual(before); // read-only

    const has = (table: string, code: string, key?: string) =>
      report.issues.some(
        (i) => i.table === table && i.code === code && (key === undefined || i.key === key),
      );
    expect(report.ok).toBe(false);
    expect(has('highlightBanks', 'orphan_reference', 'ghost-highlight-1+inbox-default')).toBe(true);
    expect(has('highlightBanks', 'orphan_reference', `${h.id}+ghost-bank-0001`)).toBe(true);
    expect(has('highlights', 'orphan_reference', 'hl-no-source-01')).toBe(true);
    expect(has('notes', 'orphan_reference', 'note-orphan-01')).toBe(true);
    expect(has('banks', 'invalid_row', 'bank-broken-001')).toBe(true);
    expect(has('banks', 'newer_schema', 'bank-future-001')).toBe(true);
    expect(has('banks', 'multiple_inbox')).toBe(true);
    expect(has('tags', 'duplicate_id', h.id)).toBe(true);
    expect(has('tags', 'duplicate_tag_name')).toBe(true);
    expect(has('folders', 'bad_schema_version', 'folder-nover-01')).toBe(true);
    expect(report.tables.banks).toMatchObject({ invalid: expect.any(Number), newer: 1 });
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('caps the list per table and says so', async () => {
    const db = getDb();
    await db.open();
    const rows = Array.from({ length: 260 }, (_, i) => ({
      highlightId: `ghost-${String(i).padStart(6, '0')}`,
      bankId: INBOX_BANK_ID,
      folderId: null,
      addedAt: '2026-01-01T00:00:00.000Z',
    }));
    await db.highlightBanks.bulkPut(rows);
    const report = await checkIntegrity();
    expect(report.truncated).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.issues.filter((i) => i.table === 'highlightBanks')).toHaveLength(200);
  });
});
