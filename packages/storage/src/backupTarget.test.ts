// @vitest-environment node
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  BackupError,
  buildMigrationChain,
  exportBackup,
  importCsvHighlights,
  importMarkdownHighlights,
  inspectBackup,
  prepareRestore,
  restoreBackup,
  type Row,
} from '@backup';
import {
  BACKUP_EXCLUDED_TABLES,
  BACKUP_MIGRATIONS,
  PRE_MIGRATION_DB,
  RESTORE_STAGING_DB,
  backupTableRegistry,
  clearRestoreStaging,
  createBackupTarget,
  createSnapshotSource,
  deletePreMigrationSnapshot,
  getPreMigrationInfo,
  importExternalHighlights,
  installPreMigrationSnapshot,
  listImportedNeedingReview,
  listLiveQuoteHashes,
  loadExportDataset,
  readPreMigrationSnapshot,
} from './backupTarget';
import { DB_VERSION, getDb, resetDbForTests } from './db';
import { checkIntegrity } from './registry';
import { listBanks, wipeAllData } from './repo';
import { listSearchDocuments } from './search';
import { dump, loadFixture, seedV1, trackEpochs } from './test-vault';

// Real exports and restores of thousands of rows: the default 5 s is too tight on a busy CI worker.
vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  await resetDbForTests();
  await deletePreMigrationSnapshot();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------------------------
// Seed: a realistic vault written straight into the tables
// ---------------------------------------------------------------------------------------------

const pad = (n: number, w = 6) => String(n).padStart(w, '0');
const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const KINDS = [
  'essential',
  'formula',
  'exception',
  'differential',
  'weak_area',
  'correction',
  'question',
];
const COLORS = ['amber', 'blue', 'red', 'purple', 'orange', 'green', 'teal'];
const meta = (i: number) => ({
  schemaVersion: 1,
  createdAt: at(i),
  updatedAt: at(i + 1),
  deletedAt: null,
});

const SECRET = 'sk-test-secret-value-1234567890';

interface SeedOptions {
  highlights: number;
  attachments?: boolean;
}

async function seed({ highlights: n, attachments = true }: SeedOptions): Promise<void> {
  const db = getDb();
  await db.open();
  const banks: Row[] = Array.from({ length: 12 }, (_, i) => ({
    id: i === 0 ? 'inbox-default' : `bank-${pad(i)}`,
    ...meta(i),
    name: i === 0 ? 'Inbox' : `Bank ${i}`,
    color: COLORS[i % COLORS.length],
    position: i,
    isInbox: i === 0,
  }));
  const folders: Row[] = Array.from({ length: 40 }, (_, i) => ({
    id: `folder-${pad(i)}`,
    ...meta(i),
    bankId: `bank-${pad(1 + (i % 11))}`,
    parentFolderId: i >= 11 ? `folder-${pad(i - 11)}` : null,
    name: `Topic ${i}`,
    position: i,
  }));
  const nSources = Math.max(1, Math.ceil(n / 20));
  const sources: Row[] = Array.from({ length: nSources }, (_, i) => ({
    id: `src-${pad(i)}`,
    ...meta(i),
    type: 'web',
    urlKey: `https://example.com/p/${i}`,
    visitedKey: `https://example.com/p/${i}`,
    originalUrl: `https://example.com/p/${i}?utm=1`,
    canonicalUrl: null,
    host: 'example.com',
    title: `Page ${i} - notes`,
  }));
  const tags: Row[] = Array.from({ length: 30 }, (_, i) => ({
    id: `tag-${pad(i)}`,
    ...meta(i),
    name: `Tag ${i}`,
    nameKey: `tag ${i}`,
    color: i % 3 === 0 ? COLORS[i % COLORS.length] : null,
    aliases: i % 5 === 0 ? [`alias ${i}`] : [],
  }));
  const hls: Row[] = [];
  const memberships: Row[] = [];
  const links: Row[] = [];
  const notes: Row[] = [];
  for (let i = 0; i < n; i++) {
    const exact = `Fact ${i}: aspirin inhibits cyclooxygenase "${i}" 日本語 ünïcödé`;
    const start = (i * 37) % 50_000;
    hls.push({
      id: `hl-${pad(i)}`,
      ...meta(i),
      deletedAt: i % 97 === 0 ? at(i + 2) : null,
      sourceId: `src-${pad(i % nSources)}`,
      exactQuote: exact,
      normalizedQuote: exact.toLowerCase(),
      quoteHash: sha(exact),
      anchorSet: {
        type: 'html',
        textAlgorithm: 'sv-text-v1',
        textQuote: { exact, prefix: 'lead ', suffix: ' tail' },
        textPosition: { start, end: start + exact.length },
        structuralPath: i % 3 === 0 ? 'main article p:nth-of-type(3)' : null,
        contentSignature: 'abc123',
        documentTextLength: 120_000,
      },
      kind: KINDS[i % KINDS.length],
      color: COLORS[i % COLORS.length],
      priority: 1 + (i % 5),
      userComment: i % 4 === 0 ? `comment ${i}, "quoted"\nsecond line` : '',
      headingContext: i % 2 === 0 ? `Heading ${i % 17}` : null,
      captureMethod: 'toolbar',
      capturedAt: at(i),
      resolveStatus: i % 2 === 0 ? 'resolved' : 'unchecked',
      resolveConfidence: i % 2 === 0 ? 0.9 : null,
      lastResolvedAt: i % 2 === 0 ? at(i + 3) : null,
      capturedUrl: `https://example.com/p/${i % nSources}`,
      capturedTitle: `Page ${i % nSources}`,
      ...(i % 5 === 0 ? { customFields: { exam: 'high', n: i, flag: true } } : {}),
    });
    const folder = i % 7 === 0 ? (folders[i % 40] as Row) : null;
    memberships.push({
      highlightId: `hl-${pad(i)}`,
      bankId: folder ? folder.bankId : (banks[i % banks.length] as Row).id,
      folderId: folder ? folder.id : null,
      addedAt: at(i),
    });
    for (const t of [i % 30, (i * 7 + 3) % 30]) {
      if (links.some((l) => l.highlightId === `hl-${pad(i)}` && l.tagId === `tag-${pad(t)}`))
        continue;
      links.push({ highlightId: `hl-${pad(i)}`, tagId: `tag-${pad(t)}`, addedAt: at(i) });
    }
    if (i % 10 === 0) {
      notes.push({
        id: `note-${pad(i)}`,
        ...meta(i),
        highlightId: `hl-${pad(i)}`,
        sourceId: null,
        title: `Note ${i}`,
        body: `Body of note ${i}.\n\n- point`,
        pinned: i % 20 === 0,
      });
    }
  }
  const documents: Row[] = Array.from({ length: 3 }, (_, i) => ({
    id: `doc-${pad(i)}`,
    ...meta(i),
    title: `Paper ${i}`,
    pageCount: 10 + i,
    byteLength: 1000 + i,
    originalUrl: i === 0 ? 'https://example.com/paper.pdf' : null,
    textStatus: 'text',
  }));
  const ocrPages: Row[] = [1, 2, 3].map((p) => ({
    documentId: 'doc-000001',
    pageNumber: p,
    schemaVersion: 1,
    createdAt: at(p),
    updatedAt: at(p),
    text: `ocr text page ${p}`,
    correctedText: null,
    words: [],
    language: 'eng',
    engine: 'tesseract',
    confidence: 0.8,
  }));
  const decks: Row[] = [{ id: 'deck-000001', ...meta(1), bankId: 'bank-000001', name: 'Deck' }];
  const cards: Row[] = Array.from({ length: Math.min(20, n) }, (_, i) => ({
    id: `card-${pad(i)}`,
    ...meta(i),
    deckId: 'deck-000001',
    highlightId: `hl-${pad(i)}`,
    knowledgePointId: null,
    dueAt: at(i + 100),
    state: 'new',
    suspended: false,
  }));
  const reviewLogs: Row[] = [
    { id: 'log-000001', cardId: 'card-000001', reviewedAt: at(5), sessionId: 's1' },
  ];
  await db.banks.bulkPut(banks as never);
  await db.folders.bulkPut(folders as never);
  await db.sources.bulkPut(sources as never);
  await db.tags.bulkPut(tags as never);
  await db.highlights.bulkPut(hls as never);
  await db.highlightBanks.bulkPut(memberships as never);
  await db.highlightTags.bulkPut(links as never);
  await db.notes.bulkPut(notes as never);
  await db.documents.bulkPut(documents as never);
  await db.ocrPages.bulkPut(ocrPages as never);
  await db.decks.bulkPut(decks as never);
  await db.cards.bulkPut(cards as never);
  await db.reviewLogs.bulkPut(reviewLogs as never);
  if (attachments) {
    const bytes = new Uint8Array(4096).map((_, i) => (i * 31) & 0xff);
    await db.attachments.bulkPut([
      {
        id: 'att-000001',
        schemaVersion: 1,
        createdAt: at(1),
        documentId: 'doc-000000',
        sha256: sha('att'),
        mimeType: 'application/pdf',
        byteLength: bytes.length,
        blob: new Blob([bytes], { type: 'application/pdf' }),
      },
    ] as never);
  }
  // device state that must never leave the device
  await db.meta.bulkPut([{ key: 'aiKey', value: SECRET, updatedAt: at(1) }]);
  await db.syncOps.bulkPut([
    {
      id: 'op-000001',
      entityType: 'highlight',
      entityId: 'hl-000001',
      clientId: 'c',
      createdAt: at(1),
      sentAt: null,
    },
  ]);
}

/** Every backed-up table as comparable data (Blobs by type and content). */
async function state(): Promise<Record<string, unknown>> {
  const db = getDb();
  if (!db.isOpen()) await db.open();
  const out: Record<string, unknown> = {};
  for (const spec of backupTableRegistry.tables) {
    const rows = (await db.table(spec.name).toArray()) as Row[];
    out[spec.name] = await Promise.all(
      rows.map(async (row) => {
        const copy: Row = { ...row };
        for (const [k, v] of Object.entries(copy)) {
          if (v instanceof Blob)
            copy[k] = { blob: v.type, text: Buffer.from(await v.arrayBuffer()).toString('hex') };
        }
        return copy;
      }),
    );
  }
  return out;
}

const hasStagingDb = async (): Promise<boolean> =>
  (await indexedDB.databases()).some((d) => d.name?.startsWith(RESTORE_STAGING_DB));

const baseOptions = { includeLocalOnlyTables: ['attachments'] as string[], appVersion: 'test' };

// ---------------------------------------------------------------------------------------------

describe('registry and migrations', () => {
  it('never exposes meta or syncOps to a backup', () => {
    const names = backupTableRegistry.tables.map((t) => t.name);
    for (const t of BACKUP_EXCLUDED_TABLES) expect(names).not.toContain(t);
    expect(names).toContain('attachments');
    expect(backupTableRegistry.schemaVersion).toBe(DB_VERSION);
  });

  it('has a migration step for every version below the current one', () => {
    // fails when DB_VERSION is raised without extending BACKUP_MIGRATIONS
    expect(() => buildMigrationChain(1, DB_VERSION, BACKUP_MIGRATIONS)).not.toThrow();
  });
});

describe('Dexie source', () => {
  it('pages every table by primary key, compound keys included, from both source kinds', async () => {
    await seed({ highlights: 300, attachments: false });
    const target = createBackupTarget();
    const snapshot = await createSnapshotSource();
    for (const source of [target, snapshot]) {
      for (const name of ['highlightBanks', 'highlights', 'ocrPages']) {
        const seen: unknown[] = [];
        let after: Row | undefined;
        for (;;) {
          const page = (await source.readTable(name, {
            limit: 7,
            ...(after ? { afterKey: after as never } : {}),
          })) as readonly Row[];
          seen.push(...page);
          if (page.length < 7) break;
          const last = page[page.length - 1] as Row;
          const spec = backupTableRegistry.tables.find((t) => t.name === name)!;
          after = (
            typeof spec.primaryKey === 'string'
              ? last[spec.primaryKey]
              : spec.primaryKey.map((f) => last[f])
          ) as never;
        }
        const all = (await getDb().table(name).toArray()) as Row[];
        expect(seen, name).toHaveLength(all.length);
        expect(JSON.stringify(seen)).toBe(JSON.stringify(all));
      }
    }
    const counts = await target.counts();
    expect(counts.highlights).toBe(300);
    expect(counts.meta).toBeUndefined();
  });
});

describe('real round trip through the Dexie target', () => {
  it('2400 highlights with tags, notes, folders, PDFs and cards survive export -> replace unchanged', async () => {
    await seed({ highlights: 2400 });
    const before = await state();
    const epochs = trackEpochs();

    const out = await exportBackup(await createSnapshotSource(), baseOptions);
    expect(out.manifest.tables.find((t) => t.name === 'highlights')?.rowCount).toBe(2400);
    expect(out.manifest.options.includesAttachments).toBe(true);

    // an unrelated vault state: the restore must replace it, not blend with it
    await getDb().highlights.update('hl-000001', { userComment: 'edited after the backup' });
    await getDb().banks.put({
      id: 'bank-local-only',
      ...meta(999),
      name: 'Local only',
      color: 'blue',
      position: 99,
      isInbox: false,
    } as never);

    const { report, result } = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(result).not.toBeNull();
    expect(report.totals.invalid).toBe(0);
    expect(report.replaceImpact.removedLiveOnlyRows).toBeGreaterThan(0);
    expect(await state()).toEqual(before);

    // post-commit duties: viewers notified, search index flagged, integrity clean, staging gone
    expect(epochs.length).toBeGreaterThan(0);
    const db = getDb();
    expect((await db.meta.get('searchIndexStale'))?.value).toEqual(expect.any(String));
    expect((await db.meta.get('lastRestore'))?.value).toMatchObject({ mode: 'replace' });
    expect(await db.meta.get('sync.dirty')).toBeDefined(); // sync reconciles instead of echoing
    expect((await checkIntegrity()).ok).toBe(true);
    expect(await hasStagingDb()).toBe(false);
  }, 180_000);

  it('a merge of the same archive into the same vault changes nothing', async () => {
    await seed({ highlights: 200 });
    const before = await state();
    const out = await exportBackup(await createSnapshotSource(), baseOptions);
    const { report, result } = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.totals.add + report.totals.update).toBe(0);
    expect(result?.written).toBeDefined();
    expect(await state()).toEqual(before);
    // nothing to write: no marker either
    expect(await getDb().meta.get('lastRestore')).toBeUndefined();
  });

  it('the reading a re-recognition replaced stays on this device: not in the archive, kept by a merge, gone after a replace', async () => {
    await seed({ highlights: 10 });
    const db = getDb();
    const slot = {
      text: 'tbe earlier reading',
      correctedText: null,
      words: [],
      language: 'eng',
      engine: 'tesseract',
      confidence: 0.5,
      replacedAt: at(50),
    };
    await db.ocrPages.update(['doc-000001', 2], { previousReading: slot } as never);
    expect((await db.ocrPages.get(['doc-000001', 2]))?.previousReading).toBeDefined();

    const out = await exportBackup(await createSnapshotSource(), baseOptions);
    // the table is in the archive whole, its rows are not carrying the slot
    const files = unzipSync(out.bytes);
    const name = Object.keys(files).find((n) => /ocrPages/.test(n))!;
    const rows = strFromU8(files[name]!)
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !('previousReading' in r))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('tbe earlier reading');
    expect(out.manifest.tables.find((t) => t.name === 'ocrPages')?.rowCount).toBe(3);

    // merging the same archive leaves the vault, slot included, exactly as it was
    const merged = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(merged.report.totals.add + merged.report.totals.update).toBe(0);
    expect((await db.ocrPages.get(['doc-000001', 2]))?.previousReading).toEqual(slot);

    // replacing from it writes the archive's rows: the device's step back is not part of them
    const replaced = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(replaced.report.totals.invalid).toBe(0);
    const back = await db.ocrPages.get(['doc-000001', 2]);
    expect(back?.text).toBe('ocr text page 2');
    expect(back?.previousReading).toBeUndefined();
    expect((await checkIntegrity()).ok).toBe(true);
  });

  it('cached PDFs are left out unless the user opts in', async () => {
    await seed({ highlights: 20 });
    const without = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    expect(without.manifest.tables.map((t) => t.name)).not.toContain('attachments');
    expect(without.manifest.options.includesAttachments).toBe(false);
    const withPdf = await exportBackup(await createSnapshotSource(), baseOptions);
    expect(withPdf.stats.blobs).toBe(1);
  });

  it('keeps secrets out of the archive and out of reach of a forged one', async () => {
    await seed({ highlights: 30 });
    const out = await exportBackup(await createSnapshotSource(), baseOptions);
    const files = unzipSync(out.bytes);
    expect(Object.keys(files).some((f) => /meta|syncOps/.test(f))).toBe(false);
    for (const bytes of Object.values(files)) expect(strFromU8(bytes)).not.toContain(SECRET);

    // a forged archive that carries a `meta` table with a different key
    const { getTableRegistry } = await import('./registry');
    const full = getTableRegistry();
    const forged = await exportBackup(
      {
        registry: full,
        counts: () => Promise.resolve({}),
        readTable: (name, o) =>
          Promise.resolve(
            name === 'meta' && o.afterKey === undefined
              ? [{ key: 'aiKey', value: 'attacker-key', updatedAt: at(1) }]
              : [],
          ),
      },
      { includeLocalOnlyTables: ['meta'] },
    );
    const { report } = await restoreBackup(forged.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.skippedTables).toContain('meta');
    expect((await getDb().meta.get('aiKey'))?.value).toBe(SECRET);
    expect(await getDb().syncOps.count()).toBe(1);
  });

  it('encrypted backups round trip and a wrong passphrase touches nothing', async () => {
    await seed({ highlights: 50, attachments: false });
    const before = await state();
    const out = await exportBackup(await createSnapshotSource(), {
      passphrase: 'correct horse battery',
      kdfIterations: 1000,
    });
    expect(out.encrypted).toBe(true);
    expect(await inspectBackup(out.bytes)).toMatchObject({ encrypted: true, manifest: null });
    await expect(
      restoreBackup(out.bytes, {
        target: createBackupTarget(),
        passphrase: 'nope',
        migrations: BACKUP_MIGRATIONS,
      }),
    ).rejects.toMatchObject({ code: 'wrong_passphrase' });
    expect(await state()).toEqual(before);
    const ok = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      passphrase: 'correct horse battery',
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(ok.report.totals.invalid).toBe(0);
    expect(await state()).toEqual(before);
  });
});

describe('merge and replace semantics', () => {
  it('merge never deletes and never lets older data beat newer edits; replace makes the vault equal', async () => {
    await seed({ highlights: 60, attachments: false });
    const db = getDb();
    const out = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });

    // after the backup: edit one highlight (newer), add a local-only one, lose another row
    await db.highlights.update('hl-000001', {
      userComment: 'newer local edit',
      updatedAt: '2030-01-01T00:00:00.000Z',
    });
    const localOnly = {
      ...((await db.highlights.get('hl-000002')) as Row),
      id: 'hl-local-only',
      exactQuote: 'Only here',
      normalizedQuote: 'only here',
      quoteHash: sha('only here'),
    };
    await db.highlights.put(localOnly as never);
    await db.highlightBanks.put({
      highlightId: 'hl-local-only',
      bankId: 'inbox-default',
      folderId: null,
      addedAt: at(1),
    });
    await db.notes.delete('note-000010'); // present in the archive only
    await db.highlightBanks.delete(['hl-000005', 'bank-000005']); // compound primary key

    const merged = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(merged.report.mode).toBe('merge');
    expect(await db.notes.get('note-000010')).toBeDefined(); // came back
    expect(await db.highlightBanks.get(['hl-000005', 'bank-000005'])).toBeDefined();
    expect((await db.highlights.get('hl-000001'))?.userComment).toBe('newer local edit'); // kept
    expect(await db.highlights.get('hl-local-only')).toBeDefined(); // never deleted

    const replaced = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(replaced.report.replaceImpact.overwrittenNewerLiveRows).toBeGreaterThan(0);
    expect(await db.highlights.get('hl-local-only')).toBeUndefined();
    expect((await db.highlights.get('hl-000001'))?.userComment).not.toBe('newer local edit');
    expect(await db.highlights.count()).toBe(60);
  });
});

describe('atomic commit', () => {
  it('a failure in the middle of the commit leaves every live row as it was', async () => {
    await seed({ highlights: 120, attachments: false });
    const out = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    await getDb().highlights.update('hl-000003', { userComment: 'live edit' });
    await getDb().banks.put({
      id: 'bank-extra',
      ...meta(5),
      name: 'Extra',
      color: 'red',
      position: 50,
      isInbox: false,
    } as never);
    const before = await state();

    // banks .. highlightTags are cleared and refilled before `notes` is reached
    vi.spyOn(getDb().table('notes'), 'bulkAdd').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(
      restoreBackup(out.bytes, {
        target: createBackupTarget(),
        mode: 'replace',
        migrations: BACKUP_MIGRATIONS,
      }),
    ).rejects.toMatchObject({ code: 'commit_failed' });

    vi.restoreAllMocks();
    expect(await state()).toEqual(before);
    expect(await getDb().meta.get('lastRestore')).toBeUndefined();
    expect(await hasStagingDb()).toBe(false);
  });

  it('a stale staging database from a crash is removed before the next restore', async () => {
    await seed({ highlights: 10, attachments: false });
    const out = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    const stale = new (await import('dexie')).default(RESTORE_STAGING_DB);
    stale.version(1).stores({ leftovers: 'id' });
    await stale.open();
    await stale.table('leftovers').put({ id: 'x' });
    stale.close();
    expect(await hasStagingDb()).toBe(true);
    await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(await hasStagingDb()).toBe(false);
    await clearRestoreStaging(); // idempotent
  });

  it('refuses an archive in which one id names rows of two different tables', async () => {
    await seed({ highlights: 5, attachments: false });
    const db = getDb();
    const bank = (await db.banks.get('bank-000001')) as Row;
    const hl = (await db.highlights.get('hl-000001')) as Row;
    const source = (await db.sources.get('src-000000')) as Row;
    const rows: Record<string, Row[]> = {
      banks: [{ ...bank, id: 'clash-00000001' }],
      sources: [source],
      highlights: [{ ...hl, id: 'clash-00000001' }],
    };
    const forged = await exportBackup(
      {
        registry: backupTableRegistry,
        counts: () => Promise.resolve({}),
        readTable: (name, o) => Promise.resolve(o.afterKey === undefined ? (rows[name] ?? []) : []),
      },
      { appVersion: 'forged' },
    );
    const before = await state();
    await expect(
      restoreBackup(forged.bytes, {
        target: createBackupTarget(),
        mode: 'merge',
        migrations: BACKUP_MIGRATIONS,
      }),
    ).rejects.toMatchObject({ code: 'staging_failed' });
    expect(await state()).toEqual(before);
  });
});

describe('corrupted archives never reach live data', () => {
  it.each([
    ['not a backup at all', (b: Uint8Array) => strToU8('hello world, not an archive' + b.length)],
    ['truncated file', (b: Uint8Array) => b.slice(0, Math.floor(b.length / 2))],
    [
      'a table file changed after export',
      (b: Uint8Array) => {
        const files = unzipSync(b);
        const name = 'tables/highlights.ndjson';
        files[name] = strToU8(strFromU8(files[name] as Uint8Array).replace('aspirin', 'ASPIRIN'));
        return zipSync(files);
      },
    ],
    [
      'a bit flipped inside the file',
      (b: Uint8Array) => {
        const copy = b.slice();
        copy[Math.floor(copy.length / 2)] = (copy[Math.floor(copy.length / 2)] as number) ^ 0xff;
        return copy;
      },
    ],
  ])('%s', async (_label, damage) => {
    await seed({ highlights: 40, attachments: false });
    const before = await state();
    const out = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    const bad = damage(out.bytes);
    const target = createBackupTarget();
    const createStaging = vi.spyOn(target, 'createStaging');
    let caught: unknown;
    try {
      const prepared = await prepareRestore(bad, {
        target,
        mode: 'replace',
        migrations: BACKUP_MIGRATIONS,
      });
      await prepared.commit();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BackupError);
    expect(createStaging).not.toHaveBeenCalled(); // detected during the dry run
    expect(await state()).toEqual(before);
    expect(await hasStagingDb()).toBe(false);
  });
});

describe('pre-migration snapshot', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });

  async function seedLegacy() {
    const v1 = loadFixture('schema-v1.json');
    // a v1 build wrote neither field
    v1.sources = v1.sources.map(({ type: _t, ...rest }) => rest);
    v1.highlightBanks = v1.highlightBanks.map(({ folderId: _f, ...rest }) => rest);
    await seedV1(v1);
    return v1;
  }

  it('keeps a restorable copy of the old data, exactly what the upgrade produced', async () => {
    const v1 = await seedLegacy();
    off = installPreMigrationSnapshot({ appVersion: 'test' });
    expect(await getPreMigrationInfo()).toBeNull();

    await listBanks(); // first contact: opens the database and upgrades it
    const upgraded = await dump();

    const info = await getPreMigrationInfo();
    expect(info).toMatchObject({ status: 'kept', fromVersion: 1, toVersion: DB_VERSION });
    expect(info?.tables.highlights).toBe(v1.highlights.length);
    expect(info?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const kept = await readPreMigrationSnapshot();
    expect(kept?.bytes.length).toBe(info?.byteLength);
    expect((await inspectBackup(kept!.bytes)).manifest?.appSchemaVersion).toBe(1);

    // wipe, then restore the snapshot through the normal import path
    await resetDbForTests();
    const { report } = await restoreBackup(kept!.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.migratedFromVersion).toBe(1);
    const restored = await dump();
    for (const name of ['banks', 'sources', 'highlights', 'highlightBanks']) {
      expect(restored[name], name).toEqual(upgraded[name]);
    }
  });

  it('records "too large" instead of keeping an oversized copy, and can be deleted', async () => {
    await seedLegacy();
    off = installPreMigrationSnapshot({ maxBytes: 100 });
    await listBanks();
    const info = await getPreMigrationInfo();
    expect(info?.status).toBe('too_large');
    expect(info?.reason).toMatch(/limit/);
    expect(await readPreMigrationSnapshot()).toBeNull();
    // upgrade itself was not affected
    expect((await dump()).highlights?.length).toBeGreaterThan(0);

    await deletePreMigrationSnapshot();
    expect(await getPreMigrationInfo()).toBeNull();
    expect((await indexedDB.databases()).some((d) => d.name === PRE_MIGRATION_DB)).toBe(false);
  });

  it('Delete all data also removes the pre-update copy and a crashed restore staging database', async () => {
    await seedLegacy();
    off = installPreMigrationSnapshot({ appVersion: 'test' });
    await listBanks(); // upgrades the v1 database and keeps a copy of the old data
    expect((await getPreMigrationInfo())?.status).toBe('kept');
    // what a restore that died half-way leaves behind: staged rows, never released
    const stale = new (await import('dexie')).default(RESTORE_STAGING_DB);
    stale.version(1).stores({ leftovers: 'id' });
    await stale.open();
    await stale.table('leftovers').put({ id: 'x', quote: 'private text' });
    stale.close();
    const names = async () => (await indexedDB.databases()).map((d) => d.name);
    expect(await names()).toEqual(expect.arrayContaining([PRE_MIGRATION_DB, RESTORE_STAGING_DB]));

    await wipeAllData();

    expect(await names()).not.toContain(PRE_MIGRATION_DB);
    expect(await names()).not.toContain(RESTORE_STAGING_DB);
    expect(await getPreMigrationInfo()).toBeNull();
  });

  it('does nothing for a database that is already current', async () => {
    off = installPreMigrationSnapshot();
    await seed({ highlights: 3, attachments: false });
    await listBanks();
    expect(await getPreMigrationInfo()).toBeNull();
  });
});

describe('importExternalHighlights', () => {
  const MD = [
    '# Cardiology',
    '',
    '> Aspirin irreversibly inhibits COX-1.',
    '',
    '— [Aspirin notes](https://example.org/aspirin) · captured 2026-03-04 · formula',
    '',
    '#pharm #high-yield',
    '',
    '**Comment:** low dose is antiplatelet',
    '',
    '> A quote with no source at all.',
    '',
  ].join('\n');

  it('writes reviewed rows with the needs-review marker, placeholder sources and tags', async () => {
    await seed({ highlights: 5, attachments: false });
    const set = await importMarkdownHighlights(MD, {
      existingQuoteHashes: await listLiveQuoteHashes(),
    });
    expect(set.highlights).toHaveLength(2);

    const res = await importExternalHighlights(set, { bankId: 'bank-000002' });
    expect(res).toMatchObject({
      created: 2,
      duplicates: 0,
      bankId: 'bank-000002',
      sourcesCreated: 2,
    });
    expect(res.tagsCreated).toBe(2);

    const db = getDb();
    const withUrl = (await db.highlights.get(res.highlightIds[0]!)) as Row & {
      customFields: Record<string, unknown>;
    };
    expect(withUrl.customFields).toMatchObject({
      importedFrom: 'markdown',
      needsReview: true,
      importedBank: 'Cardiology',
    });
    // not a capture gesture: the provenance says "imported" (and the marker says from what)
    expect(withUrl.captureMethod).toBe('import');
    expect(withUrl.exactQuote).toBe('Aspirin irreversibly inhibits COX-1.');
    expect(withUrl.kind).toBe('formula');
    expect(withUrl.userComment).toBe('low dose is antiplatelet');
    const s1 = (await db.sources.get(withUrl.sourceId as string)) as Row;
    expect(s1).toMatchObject({
      type: 'web',
      originalUrl: 'https://example.org/aspirin',
      title: 'Aspirin notes',
    });
    const bare = (await db.highlights.get(res.highlightIds[1]!)) as Row;
    const s2 = (await db.sources.get(bare.sourceId as string)) as Row;
    expect(String(s2.originalUrl)).toMatch(/^https:\/\/studyvault\.invalid\/imported\//);
    expect(bare.captureMethod).toBe('import');
    // the stand-in address never reaches the search feed; a real one does
    const feed = await listSearchDocuments({});
    expect(feed.find((d) => d.id === res.highlightIds[1])?.url).toBe('');
    expect(feed.find((d) => d.id === res.highlightIds[0])?.url).toBe('https://example.org/aspirin');
    expect(await db.highlightBanks.get([res.highlightIds[0]!, 'bank-000002'])).toBeDefined();
    expect(await db.highlightTags.where('highlightId').equals(res.highlightIds[0]!).count()).toBe(
      2,
    );

    const review = await listImportedNeedingReview();
    expect(review.total).toBe(2);
    expect((await checkIntegrity()).ok).toBe(true);

    // the same file again adds nothing
    const again = await importMarkdownHighlights(MD, {
      existingQuoteHashes: await listLiveQuoteHashes(),
    });
    expect(again.highlights).toHaveLength(0);
    const forced = await importExternalHighlights(set, { bankId: null });
    expect(forced).toMatchObject({ created: 0, duplicates: 2 });
  });

  it('imports CSV rows, falls back to the Inbox for a missing bank and rejects forged rows', async () => {
    const csv =
      'quote,tags,url\n"Beta blockers reduce mortality",cardio;drugs,https://example.org/bb\n';
    const set = await importCsvHighlights(csv);
    const res = await importExternalHighlights(set, { bankId: 'bank-does-not-exist' });
    expect(res.bankId).toBe('inbox-default');
    expect(res.created).toBe(1);
    const row = (await getDb().highlights.get(res.highlightIds[0]!)) as Row & {
      customFields: Record<string, unknown>;
    };
    expect(row.customFields.importedFrom).toBe('csv');

    await expect(
      importExternalHighlights(
        { highlights: [{ ...set.highlights[0]!, quote: '' }] },
        { bankId: null },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('loadExportDataset', () => {
  it('limits the dataset to the selected banks and what belongs to them', async () => {
    await seed({ highlights: 120, attachments: false });
    const all = await loadExportDataset();
    expect(all.highlights).toHaveLength(120);
    const some = await loadExportDataset({ bankIds: ['bank-000003'] });
    expect(some.banks.map((b) => b.id)).toEqual(['bank-000003']);
    const ids = new Set(some.highlightBanks.map((m) => m.highlightId));
    expect(some.highlights.length).toBe(ids.size);
    expect(some.highlights.length).toBeGreaterThan(0);
    expect(some.highlights.every((h) => ids.has(h.id))).toBe(true);
    expect(some.sources.length).toBeGreaterThan(0);
    expect(some.highlightBanks.every((m) => m.bankId === 'bank-000003')).toBe(true);
  });
});
