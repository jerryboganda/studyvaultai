// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_MIGRATIONS, legacyRegistry } from './legacyModel';
import { buildMigrationChain, migrateRow } from './migrate';
import { inspectBackup, restoreBackup } from './restore';
import { MemoryVault, subtle } from './testkit';
import { BackupError } from './errors';
import type { Row } from './types';

interface Fixture {
  description: string;
  formatVersion: number;
  appSchemaVersion: number;
  encrypted: boolean;
  passphrase: string | null;
  manifestChecksum: string;
  counts: Record<string, number>;
  base64: string;
}

function fixture(name: string): { f: Fixture; bytes: Uint8Array } {
  const f = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')) as Fixture;
  return { f, bytes: new Uint8Array(Buffer.from(f.base64, 'base64')) };
}

const CURRENT = legacyRegistry(3);

async function restoreFixture(name: string, mode: 'merge' | 'replace' = 'replace') {
  const { f, bytes } = fixture(name);
  const target = new MemoryVault({}, { registry: CURRENT });
  const out = await restoreBackup(bytes, {
    target,
    mode,
    subtle,
    migrations: LEGACY_MIGRATIONS,
    ...(f.passphrase ? { passphrase: f.passphrase } : {}),
  });
  return { f, target, ...out };
}

describe('frozen archives written by the format-1 exporter', () => {
  it.each(['v1-plain.json', 'v2-plain.json', 'v3-encrypted.json'])(
    '%s is still readable and its manifest is intact',
    async (name) => {
      const { f, bytes } = fixture(name);
      expect(f.formatVersion).toBe(1);
      const info = await inspectBackup(bytes, {
        subtle,
        ...(f.passphrase ? { passphrase: f.passphrase } : {}),
      });
      expect(info.encrypted).toBe(f.encrypted);
      expect(info.manifest?.checksum).toBe(f.manifestChecksum);
      expect(info.manifest?.appSchemaVersion).toBe(f.appSchemaVersion);
      expect(Object.fromEntries(info.manifest!.tables.map((t) => [t.name, t.rowCount]))).toEqual(
        f.counts,
      );
    },
  );

  it('v1 (two versions behind) is migrated step by step and validates against the current schema', async () => {
    const { report, target } = await restoreFixture('v1-plain.json');
    expect(report.migratedFromVersion).toBe(1);
    expect(report.currentSchemaVersion).toBe(3);
    expect(report.totals.invalid).toBe(0);
    const hl = target.rows('highlights');
    expect(hl).toHaveLength(3);
    const second = hl.find((r) => r.id === 'hl-0002') as Row;
    expect(second).toMatchObject({ userComment: 'my note', priority: 3 });
    expect(second).not.toHaveProperty('comment');
    expect(second.quote).toBe('Quote with "quotes", a comma, and a\nnewline — üñîçødé');
    expect(target.rows('banks').every((b) => b.color === 'blue')).toBe(true);
    // provenance and timestamps are untouched by migration
    expect(hl.find((r) => r.id === 'hl-0003')).toMatchObject({
      quote: '日本語の引用',
      deletedAt: '2026-09-01T12:14:00.000Z',
      createdAt: '2026-09-01T12:12:00.000Z',
    });
  });

  it('v2 needs only the last step and keeps notes', async () => {
    const { report, target } = await restoreFixture('v2-plain.json');
    expect(report.migratedFromVersion).toBe(2);
    const notes = target.rows('notes');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ pinned: false, body: 'Remember the mechanism.' });
  });

  it('v3 (current, encrypted) needs the passphrase and no migration', async () => {
    const { report, target } = await restoreFixture('v3-encrypted.json');
    expect(report.migratedFromVersion).toBeNull();
    expect(target.rows('highlights')).toHaveLength(3);
    expect(target.rows('notes')[0]).toMatchObject({ pinned: true });
    const { bytes } = fixture('v3-encrypted.json');
    await expect(
      restoreBackup(bytes, { target: new MemoryVault({}, { registry: CURRENT }), subtle }),
    ).rejects.toMatchObject({ code: 'passphrase_required' });
  });

  it('merge of an old archive into current data uses migrated rows for comparison', async () => {
    const { target } = await restoreFixture('v1-plain.json');
    // restoring the same old archive again changes nothing: migrated rows are identical
    const again = await restoreFixture('v1-plain.json', 'merge');
    expect(again.report.totals).toMatchObject({ add: 3 + 2, update: 0 });
    const { f, bytes } = fixture('v1-plain.json');
    expect(f.appSchemaVersion).toBe(1);
    const second = await restoreBackup(bytes, {
      target,
      mode: 'merge',
      subtle,
      migrations: LEGACY_MIGRATIONS,
    });
    expect(second.report.totals).toMatchObject({
      add: 0,
      update: 0,
      skipIdentical: 5,
      conflict: 0,
    });
    expect(second.report.replaceImpact.tablesCleared).toEqual([]);
  });

  it('replace from an old archive also clears tables it has no data for', async () => {
    const target = new MemoryVault(legacyDataWithNotes(), { registry: CURRENT });
    const { bytes } = fixture('v1-plain.json');
    const { report } = await restoreBackup(bytes, {
      target,
      mode: 'replace',
      subtle,
      migrations: LEGACY_MIGRATIONS,
    });
    expect(report.replaceImpact.clearedWithoutArchiveData).toEqual(['notes']);
    expect(target.rows('notes')).toHaveLength(0);
  });
});

function legacyDataWithNotes(): Record<string, Row[]> {
  return {
    banks: [],
    highlights: [],
    notes: [
      {
        id: 'note-zzz',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
        highlightId: 'hl-gone',
        body: 'stale',
        wordCount: 1,
        pinned: false,
      },
    ],
  };
}

describe('migration chain', () => {
  it('orders steps and refuses gaps and duplicates', () => {
    expect(buildMigrationChain(1, 3, LEGACY_MIGRATIONS).map((s) => s.from)).toEqual([1, 2]);
    expect(buildMigrationChain(3, 3, LEGACY_MIGRATIONS)).toEqual([]);
    expect(() => buildMigrationChain(1, 4, LEGACY_MIGRATIONS)).toThrow(BackupError);
    expect(() => buildMigrationChain(1, 3, [...LEGACY_MIGRATIONS, { from: 1 }])).toThrow(
      /duplicate/,
    );
  });

  it('steps may drop rows (reported) and a throwing step marks the row invalid', async () => {
    const { bytes } = fixture('v1-plain.json');
    const drop = [
      ...LEGACY_MIGRATIONS.slice(1),
      {
        from: 1,
        tables: {
          highlights: (row: Row) =>
            row.id === 'hl-0003' ? null : { ...row, userComment: row.comment },
        },
      },
    ].sort((a, b) => a.from - b.from);
    const t1 = new MemoryVault({}, { registry: CURRENT });
    const r1 = await restoreBackup(bytes, {
      target: t1,
      mode: 'replace',
      subtle,
      migrations: drop,
    });
    expect(r1.report.tables.highlights?.droppedByMigration).toBe(1);
    expect(t1.rows('highlights')).toHaveLength(2);

    const boom = [
      ...LEGACY_MIGRATIONS.slice(1),
      {
        from: 1,
        tables: {
          highlights: (row: Row) => {
            if (row.id === 'hl-0002') throw new Error('cannot convert');
            return { ...row, userComment: row.comment };
          },
        },
      },
    ].sort((a, b) => a.from - b.from);
    const t2 = new MemoryVault({}, { registry: CURRENT });
    const err = await restoreBackup(bytes, {
      target: t2,
      mode: 'replace',
      subtle,
      migrations: boom,
    }).catch((e) => e);
    expect(err.code).toBe('row_invalid');
    expect(err.details.invalidRows.items[0].reason).toBe('migration_failed');
    expect(t2.liveWrites).toBe(0);
  });

  it('migrateRow applies only the tables a step lists', () => {
    const row = { id: 'x', comment: 'c' };
    expect(migrateRow('someOtherTable', row, LEGACY_MIGRATIONS)).toBe(row);
    expect(migrateRow('highlights', row, LEGACY_MIGRATIONS)).toEqual({
      id: 'x',
      userComment: 'c',
      priority: 3,
    });
  });
});
