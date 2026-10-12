// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { exportBackup, restoreBackup, type Row } from '@backup';
import {
  INBOX_BANK_ID,
  type FilingRule,
  type Relation,
  type Syllabus,
  type TableRegistry,
} from '@shared';
import {
  BACKUP_MIGRATIONS,
  backupTableRegistry,
  createBackupTarget,
  createSnapshotSource,
  deletePreMigrationSnapshot,
} from './backupTarget';
import { getDb, resetDbForTests } from './db';
import { createNote } from './notes';
import { createRelation, deleteRelation } from './relations';
import { checkIntegrity } from './registry';
import { createBank, softDeleteHighlight, wipeAllData } from './repo';
import { createFilingRule, deleteFilingRule, updateFilingRule } from './rules';
import { createSyllabus, deleteSyllabus, updateSyllabus } from './syllabi';
import { createSyncRuntime, type SyncRuntime } from './sync';
import { createTag } from './tags';
import { save } from './test-vault';
import { purge } from './trash';
import { getStorageUsage } from './usage';

const NEW_TABLES = ['filingRules', 'syllabi', 'relations'] as const;

beforeEach(async () => {
  await resetDbForTests();
  await deletePreMigrationSnapshot();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** Rows of the three tables, as stored. */
async function organisation(): Promise<{
  filingRules: FilingRule[];
  syllabi: Syllabus[];
  relations: Relation[];
}> {
  const db = getDb();
  if (!db.isOpen()) await db.open();
  return {
    filingRules: await db.filingRules.toArray(),
    syllabi: await db.syllabi.toArray(),
    relations: await db.relations.toArray(),
  };
}

/** Every table a backup holds, as stored. */
async function everything(): Promise<Record<string, unknown[]>> {
  const db = getDb();
  if (!db.isOpen()) await db.open();
  const out: Record<string, unknown[]> = {};
  for (const spec of backupTableRegistry.tables)
    out[spec.name] = await db.table(spec.name).toArray();
  return out;
}

async function seed() {
  const bank = await createBank('Cardiology');
  const tag = (await createTag('Pearl')).tag;
  const h1 = await save('Aspirin irreversibly inhibits cyclooxygenase.');
  const h2 = await save('Clopidogrel blocks the P2Y12 receptor.');
  const note = await createNote({ highlightId: h1.id, body: 'Both are antiplatelets.' });
  const rule = await createFilingRule({
    name: 'Cardio sites',
    match: { hosts: ['example.com'], kinds: ['essential'] },
    action: { bankId: bank.id, addTagIds: [tag.id] },
  });
  const quiet = await createFilingRule({
    name: 'Quiet one',
    enabled: false,
    match: { quoteContains: ['aspirin'] },
    action: { bankId: INBOX_BANK_ID },
    requireConfirm: false,
  });
  const removedRule = await createFilingRule({
    name: 'Removed',
    match: { hosts: ['gone.example'] },
    action: { bankId: bank.id },
  });
  await deleteFilingRule(removedRule.id);
  const syllabus = await createSyllabus({
    name: 'Exam',
    nodes: [
      {
        title: 'Antiplatelets',
        weight: 2,
        bankIds: [bank.id],
        tagIds: [tag.id],
        children: [{ title: 'Drugs' }],
      },
    ],
  });
  const removedSyllabus = await createSyllabus({ name: 'Old exam' });
  await deleteSyllabus(removedSyllabus.id);
  const link = (
    await createRelation({
      fromKind: 'highlight',
      fromId: h1.id,
      toKind: 'highlight',
      toId: h2.id,
      type: 'contradicts',
      note: 'different targets',
    })
  ).relation;
  const removedLink = (
    await createRelation({
      fromKind: 'note',
      fromId: note.id,
      toKind: 'highlight',
      toId: h2.id,
      type: 'example',
    })
  ).relation;
  await deleteRelation(removedLink.id);
  return {
    bank,
    tag,
    h1,
    h2,
    note,
    rule,
    quiet,
    removedRule,
    syllabus,
    removedSyllabus,
    link,
    removedLink,
  };
}

const options = { appVersion: 'test' };

describe('backup and restore', () => {
  it('exports the three tables with their checksums and restores them exactly, replace mode', async () => {
    const w = await seed();
    const before = await everything();
    const out = await exportBackup(await createSnapshotSource(), options);
    const counts = Object.fromEntries(out.manifest.tables.map((t) => [t.name, t.rowCount]));
    expect(counts).toMatchObject({ filingRules: 3, syllabi: 2, relations: 2 });
    for (const name of NEW_TABLES) {
      expect(out.manifest.tables.find((t) => t.name === name)!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // the vault moves on: an edit, a new rule, a deletion, a purge
    await updateFilingRule(w.rule.id, { name: 'Edited later' });
    await createFilingRule({
      name: 'Newer',
      match: { hosts: ['new.example'] },
      action: { bankId: INBOX_BANK_ID },
    });
    await deleteSyllabus(w.syllabus.id);
    await deleteRelation(w.link.id);

    const { report } = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.totals.invalid).toBe(0);
    expect(report.orphans.total).toBe(0);
    expect(report.tables.filingRules).toMatchObject({ archiveRows: 3, valid: 3 });
    expect(await everything()).toEqual(before);
    expect((await checkIntegrity()).ok).toBe(true);
  });

  it('a merge keeps newer live edits and live deletions, and brings back what the vault lacks', async () => {
    const w = await seed();
    const out = await exportBackup(await createSnapshotSource(), options);
    await updateFilingRule(w.rule.id, { name: 'Edited after the backup' }); // live is newer
    await deleteFilingRule(w.quiet.id); // live tombstone is newer
    await updateSyllabus(w.syllabus.id, { name: 'Exam, renamed' });
    // a purged rule is simply not in the vault any more
    await purgeRuleCompletely(w.removedRule.id);
    const live = await organisation();

    const { report } = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.tables.filingRules).toMatchObject({ add: 1, skipLiveNewer: 2 });
    expect(report.tables.syllabi).toMatchObject({ skipLiveNewer: 1 });
    const after = await organisation();
    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
    const rules = byId(after.filingRules);
    expect(rules.get(w.rule.id)!.name).toBe('Edited after the backup');
    expect(rules.get(w.quiet.id)!.deletedAt).not.toBeNull();
    expect(rules.has(w.removedRule.id)).toBe(true); // merge never deletes, and adds what is missing
    expect(byId(after.syllabi).get(w.syllabus.id)!.name).toBe('Exam, renamed');
    // everything the vault already held is as it was
    for (const row of live.filingRules) expect(rules.get(row.id)).toEqual(row);
  });

  it('a merge refuses to change what a relation connects, whatever the archive says', async () => {
    const w = await seed();
    const out = await exportBackup(await createSnapshotSource(), options);
    // the vault's own row now says something else about the same id (an older archive must not win)
    const db = getDb();
    const other = await save('A third, unrelated highlight about heparin.');
    await db.relations.update(w.link.id, { toId: other.id });
    const before = await organisation();
    const { report } = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.conflicts.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'relations',
          reason: 'immutable_field_changed',
        }),
      ]),
    );
    expect((await organisation()).relations).toEqual(before.relations);
  });

  it('an archive written before schema v4 restores: replace empties the new tables, merge leaves them', async () => {
    const w = await seed();
    const v3: TableRegistry = {
      schemaVersion: 3,
      tables: backupTableRegistry.tables.filter(
        (t) => !(NEW_TABLES as readonly string[]).includes(t.name),
      ),
    };
    const source = await createSnapshotSource();
    const old = await exportBackup({ ...source, registry: v3 }, options);
    expect(old.manifest.appSchemaVersion).toBe(3);
    expect(old.manifest.tables.map((t) => t.name)).not.toContain('relations');
    const before = await organisation();

    const merged = await restoreBackup(old.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(merged.report.migratedFromVersion).toBe(3);
    expect(await organisation()).toEqual(before);

    const replaced = await restoreBackup(old.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(replaced.report.replaceImpact.clearedWithoutArchiveData).toEqual(
      expect.arrayContaining([...NEW_TABLES]),
    );
    expect(await organisation()).toEqual({ filingRules: [], syllabi: [], relations: [] });
    // the rows the archive does hold came back
    expect(await getDb().highlights.get(w.h1.id)).toBeDefined();
  });

  it('a row that does not validate is reported by the restore, not stored', async () => {
    const w = await seed();
    const source = await createSnapshotSource();
    const broken = await exportBackup(
      {
        ...source,
        readTable: async (name, o) => {
          const rows = (await source.readTable(name, o)) as readonly Row[];
          return name === 'filingRules'
            ? rows.map((r) => ({ ...r, match: { hosts: ['NOT A HOST'] } }))
            : rows;
        },
      },
      options,
    );
    const kept = await organisation();
    await expect(
      restoreBackup(broken.bytes, {
        target: createBackupTarget(),
        mode: 'replace',
        migrations: BACKUP_MIGRATIONS,
      }),
    ).rejects.toMatchObject({ code: 'row_invalid' });
    expect(await organisation()).toEqual(kept); // nothing was written
    const { report } = await restoreBackup(broken.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
      invalidRows: 'skip',
    });
    expect(report.tables.filingRules).toMatchObject({ invalid: 3, valid: 0 });
    expect((await organisation()).filingRules).toEqual([]);
    expect((await organisation()).syllabi).toHaveLength(2);
    expect(w.rule.id).toBeDefined();
  });
});

/** Remove a deleted rule the way "delete for good" does. */
async function purgeRuleCompletely(id: string): Promise<void> {
  const { purgeFilingRules } = await import('./rules');
  await purgeFilingRules([id]);
}

describe('Delete all data', () => {
  it('empties the three tables with everything else, and the new database is writable', async () => {
    await seed();
    expect((await getStorageUsage()).rows).toMatchObject({
      filingRules: 3,
      syllabi: 2,
      relations: 2,
    });
    await wipeAllData();
    const usage = await getStorageUsage();
    expect(usage.rows).toMatchObject({ filingRules: 0, syllabi: 0, relations: 0 });
    const bank = await createBank('After the wipe');
    const rule = await createFilingRule({
      name: 'Fresh',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
    });
    expect(rule.order).toBe(0);
  });
});

describe('optional sync', () => {
  let rt: SyncRuntime;
  beforeEach(async () => {
    rt = await createSyncRuntime({ isEnabled: () => true });
    rt.startCapture();
  });

  const pendingOps = async () => (await rt.log.pending(10_000)).map((p) => p.op);

  it('puts rules, syllabi and relations in the outbox, and a purge sends tombstones for relations', async () => {
    const w = await seed();
    const ops = await pendingOps();
    const types = new Set(ops.map((o) => o.entityType));
    expect([...types]).toEqual(expect.arrayContaining([...NEW_TABLES]));
    const relationOps = ops.filter((o) => o.entityType === 'relations');
    expect(relationOps.length).toBeGreaterThan(0);
    // the identity of a link is never sent as an edit: only the creation carries it
    const fieldsSet = relationOps.flatMap((o) =>
      Object.keys((o.payload as { set?: Record<string, unknown> }).set ?? {}),
    );
    expect(fieldsSet).toEqual(expect.arrayContaining(['fromId', 'toId', 'type']));

    await softDeleteHighlight(w.h2.id);
    await purge([{ kind: 'highlight', id: w.h2.id }]);
    const after = await pendingOps();
    const gone = after.filter((o) => o.entityType === 'relations' && o.opType === 'delete');
    expect(gone.map((o) => o.entityId).sort()).toEqual([w.link.id, w.removedLink.id].sort());
    expect(await getDb().relations.count()).toBe(0);
  });
});
