// @vitest-environment node
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { STUDYVAULT_SYNC_POLICY } from '@sync/policy';
import {
  BackupError,
  exportBackup,
  importMarkdownHighlights,
  prepareRestore,
  restoreBackup,
  type Row,
} from '@backup';
import { StoredAiResultSchema } from './ai';
import {
  BACKUP_MIGRATIONS,
  RESTORE_LOCK_NAME,
  RESTORE_STAGING_DB,
  backupTableRegistry,
  clearRestoreStaging,
  createBackupTarget,
  createSnapshotSource,
  deletePreMigrationSnapshot,
  getPreMigrationInfo,
  importExternalHighlights,
  installPreMigrationSnapshot,
  readPreMigrationSnapshot,
  withRestoreLock,
} from './backupTarget';
import { DB_NAME, DB_VERSION, getDb, resetDbForTests } from './db';
import { listBanks, wipeAllData } from './repo';
import { RESTORE_REGROUND_NOTICE, immutableFieldsOf } from './restoreGuards';
import { dump, loadFixture, seedV1 } from './test-vault';

vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  await resetDbForTests();
  await deletePreMigrationSnapshot();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
const meta = (i: number) => ({
  schemaVersion: 1,
  createdAt: at(i),
  updatedAt: at(i + 1),
  deletedAt: null,
});
const FUTURE = '2031-01-01T00:00:00.000Z';
const hash = (c: string) => c.repeat(64);

// ---------------------------------------------------------------------------------------------
// A small vault written straight into the tables
// ---------------------------------------------------------------------------------------------

const QUOTE = 'Aspirin irreversibly inhibits cyclooxygenase in platelets.';

async function seed(): Promise<void> {
  const db = getDb();
  await db.open();
  await db.banks.bulkPut([
    { id: 'inbox-default', ...meta(0), name: 'Inbox', color: 'blue', position: 0, isInbox: true },
    {
      id: 'bank-000001',
      ...meta(1),
      name: 'Cardiology',
      color: 'red',
      position: 1,
      isInbox: false,
    },
    { id: 'bank-000002', ...meta(2), name: 'Renal', color: 'teal', position: 2, isInbox: false },
  ] as never);
  await db.folders.bulkPut([
    {
      id: 'folder-000001',
      ...meta(3),
      bankId: 'bank-000001',
      parentFolderId: null,
      name: 'Drugs',
      position: 0,
    },
  ] as never);
  await db.sources.bulkPut(
    [0, 1].map((i) => ({
      id: `src-00000${i}`,
      ...meta(i),
      type: 'web',
      urlKey: `https://example.com/p/${i}`,
      visitedKey: `https://example.com/p/${i}`,
      originalUrl: `https://example.com/p/${i}?utm=1`,
      canonicalUrl: null,
      host: 'example.com',
      title: `Page ${i}`,
    })) as never,
  );
  await db.highlights.bulkPut(
    [1, 2, 3, 4].map((i) => ({
      id: `hl-00000${i}`,
      ...meta(i),
      sourceId: `src-00000${i % 2}`,
      exactQuote: i === 1 ? QUOTE : `Fact ${i}: renal clearance depends on filtration ${i}.`,
      normalizedQuote: `fact ${i}`,
      quoteHash: hash(String(i)),
      anchorSet: {
        type: 'html',
        textAlgorithm: 'sv-text-v1',
        textQuote: { exact: `Fact ${i}`, prefix: 'a ', suffix: ' b' },
        textPosition: { start: i * 10, end: i * 10 + 7 },
        structuralPath: null,
        contentSignature: 'abc',
        documentTextLength: 5000,
      },
      kind: 'essential',
      color: 'amber',
      priority: 3,
      userComment: `comment ${i}`,
      headingContext: `Heading ${i}`,
      captureMethod: 'toolbar',
      capturedAt: at(i),
      resolveStatus: 'resolved',
      resolveConfidence: 0.9,
      lastResolvedAt: at(i + 2),
      capturedUrl: `https://example.com/p/${i % 2}`,
      capturedTitle: `Page ${i % 2}`,
    })) as never,
  );
  await db.highlightBanks.bulkPut(
    [1, 2, 3, 4].map((i) => ({
      highlightId: `hl-00000${i}`,
      bankId: 'bank-000001',
      folderId: null,
      addedAt: at(i),
    })) as never,
  );
  await db.decks.bulkPut([
    { id: 'deck-000001', ...meta(1), bankId: 'bank-000001', name: 'Deck' },
  ] as never);
  await db.cards.bulkPut([
    {
      id: 'card-000001',
      ...meta(1),
      deckId: 'deck-000001',
      highlightId: 'hl-000001',
      knowledgePointId: null,
      sourceQuote: 'The quote the card was made from.',
    },
  ] as never);
  await db.reviewLogs.bulkPut([
    { id: 'log-000001', cardId: 'card-000001', reviewedAt: at(5), rating: 3 },
  ] as never);
}

/** Every backed-up table as comparable data. */
async function state(): Promise<Record<string, unknown>> {
  const db = getDb();
  if (!db.isOpen()) await db.open();
  const out: Record<string, unknown> = {};
  for (const spec of backupTableRegistry.tables)
    out[spec.name] = await db.table(spec.name).toArray();
  return out;
}

/** An archive made from rows given here (not from the live vault): what a forger controls. */
function archiveOf(rows: Record<string, Row[]>, schemaVersion = DB_VERSION, tables?: string[]) {
  const registry = {
    schemaVersion,
    tables: backupTableRegistry.tables.filter((t) =>
      (tables ?? Object.keys(rows)).includes(t.name),
    ),
  };
  return exportBackup(
    {
      registry,
      counts: () => Promise.resolve({}),
      readTable: (name, o) => Promise.resolve(o.afterKey === undefined ? (rows[name] ?? []) : []),
    },
    { appVersion: 'forged' },
  );
}

const stagingDatabases = async (): Promise<string[]> =>
  (await indexedDB.databases())
    .map((d) => d.name ?? '')
    .filter((n) => n.startsWith(RESTORE_STAGING_DB));

// ---------------------------------------------------------------------------------------------

describe('the provenance a merge may not change is the sync policy’s list', () => {
  it('matches STUDYVAULT_SYNC_POLICY for every table: immutable fields, or "*" when append-only', () => {
    const fields = immutableFieldsOf(backupTableRegistry);
    const tables = new Set(backupTableRegistry.tables.map((t) => t.name));
    for (const [table, p] of Object.entries(STUDYVAULT_SYNC_POLICY)) {
      if (!tables.has(table)) continue;
      const expected = p.appendOnly === true ? ['*'] : [...(p.immutable ?? [])];
      expect(fields[table] ?? [], table).toEqual(expected);
    }
    // the fields the security review found unprotected
    expect(fields.highlights).toEqual(
      expect.arrayContaining(['capturedUrl', 'capturedTitle', 'normalizedQuote', 'headingContext']),
    );
    expect(fields.sources).toEqual(
      expect.arrayContaining([
        'type',
        'urlKey',
        'visitedKey',
        'originalUrl',
        'canonicalUrl',
        'host',
      ]),
    );
    expect(fields.cards).toEqual(expect.arrayContaining(['sourceQuote']));
    expect(fields.reviewLogs).toEqual(['*']);
    // and it is what the restore target hands to the engine
    expect(createBackupTarget().immutableFields()).toEqual(fields);
  });

  it('a forged archive cannot change any of them on a row the vault has (merge keeps the local value)', async () => {
    await seed();
    const before = await state();
    const live = (name: string, id: string) =>
      ((before[name] as Row[]).find((r) => r.id === id) ?? {}) as Row;
    const forgeries: [string, Row, string][] = [
      ['sources', { ...live('sources', 'src-000000'), type: 'pdf' }, 'type'],
      ['sources', { ...live('sources', 'src-000000'), urlKey: 'https://evil.example/k' }, 'urlKey'],
      [
        'sources',
        { ...live('sources', 'src-000001'), visitedKey: 'https://evil.example/v' },
        'visitedKey',
      ],
      [
        'sources',
        { ...live('sources', 'src-000001'), originalUrl: 'https://evil.example/page' },
        'originalUrl',
      ],
      [
        'sources',
        { ...live('sources', 'src-000001'), canonicalUrl: 'https://evil.example/c' },
        'canonicalUrl',
      ],
      ['sources', { ...live('sources', 'src-000001'), host: 'evil.example' }, 'host'],
      ['folders', { ...live('folders', 'folder-000001'), bankId: 'bank-000002' }, 'bankId'],
      ['highlights', { ...live('highlights', 'hl-000001'), sourceId: 'src-000000' }, 'sourceId'],
      [
        'highlights',
        { ...live('highlights', 'hl-000002'), exactQuote: 'Nobody saved this' },
        'exactQuote',
      ],
      [
        'highlights',
        { ...live('highlights', 'hl-000003'), normalizedQuote: 'forged' },
        'normalizedQuote',
      ],
      ['highlights', { ...live('highlights', 'hl-000004'), quoteHash: hash('e') }, 'quoteHash'],
      [
        'highlights',
        {
          ...live('highlights', 'hl-000001'),
          capturedUrl: 'https://evil.example/cited',
        },
        'capturedUrl',
      ],
      [
        'highlights',
        { ...live('highlights', 'hl-000002'), capturedTitle: 'Forged title' },
        'capturedTitle',
      ],
      [
        'highlights',
        { ...live('highlights', 'hl-000003'), headingContext: 'Forged heading' },
        'headingContext',
      ],
      [
        'highlights',
        { ...live('highlights', 'hl-000004'), captureMethod: 'import' },
        'captureMethod',
      ],
      ['highlights', { ...live('highlights', 'hl-000001'), capturedAt: at(900) }, 'capturedAt'],
      [
        'highlights',
        {
          ...live('highlights', 'hl-000002'),
          anchorSet: {
            ...(live('highlights', 'hl-000002').anchorSet as Row),
            textPosition: { start: 1, end: 3 },
          },
        },
        'anchorSet',
      ],
      [
        'cards',
        { ...live('cards', 'card-000001'), sourceQuote: 'A quote nobody saved' },
        'sourceQuote',
      ],
      ['reviewLogs', { ...live('reviewLogs', 'log-000001'), rating: 1 }, 'rating'],
    ];
    // newer than anything local, so an ordinary edit would win
    const rows: Record<string, Row[]> = {};
    for (const [table, row] of forgeries) {
      const forged: Row = {
        ...row,
        userComment: 'rides along',
        ...(table === 'reviewLogs' ? {} : { updatedAt: FUTURE }),
      };
      if (table !== 'highlights') delete forged.userComment;
      (rows[table] ??= []).push(forged);
    }
    // each victim may appear once per table: keep the first forgery of a row, the rest are the
    // same row with another field changed (the archive is one file, ids are unique in it)
    for (const [table, list] of Object.entries(rows)) {
      const seen = new Set<unknown>();
      rows[table] = list.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
    }
    const forged = await archiveOf(rows);
    const { report } = await restoreBackup(forged.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    const total = Object.values(rows).reduce((n, list) => n + list.length, 0);
    expect(report.conflicts.total).toBe(total);
    expect(new Set(report.conflicts.items.map((c) => c.reason))).toEqual(
      new Set(['immutable_field_changed']),
    );
    expect(await state()).toEqual(before);
  });

  it('each forged field is held on its own, one row per field', async () => {
    await seed();
    const before = await state();
    const hl = (before.highlights as Row[])[0] as Row;
    const fields = immutableFieldsOf(backupTableRegistry).highlights ?? [];
    const alt: Record<string, unknown> = {
      sourceId: 'src-000000',
      exactQuote: 'forged quote',
      normalizedQuote: 'forged quote',
      quoteHash: hash('d'),
      anchorSet: { ...(hl.anchorSet as Row), documentTextLength: 1 },
      headingContext: 'forged',
      captureMethod: 'shortcut',
      capturedAt: at(901),
      capturedUrl: 'https://evil.example/c',
      capturedTitle: 'forged',
    };
    for (const field of fields) {
      expect(alt[field], `no forgery written for ${field}`).toBeDefined();
      expect(alt[field]).not.toEqual(hl[field]);
      const forged = await archiveOf({
        highlights: [{ ...hl, [field]: alt[field], updatedAt: FUTURE }],
      });
      const { report } = await restoreBackup(forged.bytes, {
        target: createBackupTarget(),
        mode: 'merge',
        migrations: BACKUP_MIGRATIONS,
      });
      expect(report.conflicts.total, field).toBe(1);
      expect(await state(), field).toEqual(before);
    }
  });

  it('replace into an empty vault still imports an archive with those same values', async () => {
    await seed();
    const rows = (await state()) as Record<string, Row[]>;
    (rows.highlights as Row[])[0] = {
      ...(rows.highlights as Row[])[0],
      capturedUrl: 'https://evil.example/cited',
    } as Row;
    const bytes = (await archiveOf(rows, DB_VERSION, Object.keys(rows))).bytes;
    await resetDbForTests();
    await restoreBackup(bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    const restored = (await getDb().highlights.get('hl-000001')) as Row;
    expect(restored.capturedUrl).toBe('https://evil.example/cited');
  });
});

// ---------------------------------------------------------------------------------------------

describe('AI results are re-grounded on restore', () => {
  const ai = (over: Record<string, unknown>) => ({
    id: 'airesult-0001',
    kind: 'exam_pearl',
    inputSourceIds: ['hl-000001'],
    inputFingerprint: 'a'.repeat(64),
    provider: 'p',
    model: 'm',
    templateVersion: 'v1',
    output: {
      oneLiner: 'Aspirin blocks COX.',
      why: 'Because it acetylates the enzyme.',
      sourceQuoteId: 'hl-000001',
      sourceQuote: 'irreversibly inhibits cyclooxygenase',
    },
    citations: [{ highlightId: 'hl-000001', quote: 'irreversibly inhibits cyclooxygenase' }],
    verificationState: 'source_supported',
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: null },
    createdAt: at(10),
    acceptedByUserAt: at(11),
    consentRef: 'consent-0001',
    grounding: {
      checked: 1,
      supported: 1,
      unsupported: 0,
      claims: [{ path: '/sourceQuote', quoteId: 'hl-000001', supported: true, reason: 'ok' }],
    },
    notices: ['AI draft'],
    // review state
    schemaVersion: 1,
    highlightId: 'hl-000001',
    acceptedAt: at(11),
    items: { '': { state: 'accepted', at: at(11), edited: false, targets: [] } },
    ...over,
  });

  async function roundTrip(...rows: Row[]) {
    await seed();
    await getDb().aiResults.bulkPut(rows as never);
    const out = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    await getDb().aiResults.clear();
    const { report } = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    return { report, restored: (id: string) => getDb().aiResults.get(id) as Promise<Row> };
  }

  it('keeps a result whose citations are in the vault exactly as it was', async () => {
    const genuine = ai({}) as Row;
    const { report, restored } = await roundTrip(genuine);
    expect(await restored('airesult-0001')).toEqual(genuine);
    expect(report.warnings.join(' ')).not.toMatch(/AI result/);
  });

  it('demotes a source_supported claim whose cited text is not in the highlight', async () => {
    const forged = ai({
      id: 'airesult-0002',
      output: {
        oneLiner: 'Aspirin cures everything.',
        why: 'Trust me.',
        sourceQuoteId: 'hl-000001',
        sourceQuote: 'aspirin cures every known disease',
      },
      citations: [{ highlightId: 'hl-000001', quote: 'aspirin cures every known disease' }],
    }) as Row;
    const { report, restored } = await roundTrip(forged, ai({}) as Row);
    const got = await restored('airesult-0002');
    expect(got.verificationState).toBe('unverified');
    expect(got.citations).toEqual([]);
    expect(got.grounding).toMatchObject({ checked: 1, supported: 0, unsupported: 1 });
    expect((got.grounding as { claims: { supported: boolean }[] }).claims[0]?.supported).toBe(
      false,
    );
    expect(got.notices).toContain(RESTORE_REGROUND_NOTICE);
    // review state and acceptance are the person's: untouched
    expect(got.acceptedByUserAt).toBe(at(11));
    expect(got.items).toEqual(forged.items);
    expect(StoredAiResultSchema.safeParse(got).success).toBe(true);
    // the genuine one beside it is unchanged
    expect((await restored('airesult-0001')).verificationState).toBe('source_supported');
    expect(report.warnings.join(' ')).toMatch(/1 AI result/);
  });

  it('a result that cites a highlight the archive does not hold is demoted too', async () => {
    const orphanCite = ai({
      id: 'airesult-0003',
      citations: [{ highlightId: 'hl-missing-1', quote: 'irreversibly inhibits cyclooxygenase' }],
      grounding: {
        checked: 1,
        supported: 1,
        unsupported: 0,
        claims: [{ path: '/sourceQuote', quoteId: 'hl-missing-1', supported: true, reason: 'ok' }],
      },
      output: {
        oneLiner: 'x',
        why: 'y',
        sourceQuoteId: 'hl-missing-1',
        sourceQuote: 'irreversibly inhibits cyclooxygenase',
      },
    }) as Row;
    const { restored } = await roundTrip(orphanCite);
    const got = await restored('airesult-0003');
    expect(got.verificationState).toBe('unverified');
    expect(got.citations).toEqual([]);
  });

  it('a fact-check verdict whose evidence is not in the vault goes back to not_checked', async () => {
    const forged = ai({
      id: 'airesult-0004',
      kind: 'fact_check',
      output: {
        externallyVerified: false,
        checks: [
          {
            claimId: 'claim_1',
            claim: 'Aspirin cures everything',
            label: 'source_supported',
            explanation: 'Stated in the source.',
            evidence: [{ quoteId: 'hl-000001', text: 'aspirin cures every known disease' }],
          },
        ],
      },
      citations: [{ highlightId: 'hl-000001', quote: 'aspirin cures every known disease' }],
      grounding: {
        checked: 1,
        supported: 1,
        unsupported: 0,
        claims: [
          {
            path: '/checks/0/evidence/0/text',
            quoteId: 'hl-000001',
            supported: true,
            reason: 'ok',
          },
        ],
      },
    }) as Row;
    const { restored } = await roundTrip(forged);
    const got = await restored('airesult-0004');
    expect(got.verificationState).toBe('unverified');
    expect((got.output as { checks: { label: string }[] }).checks[0]?.label).toBe('not_checked');
    expect(StoredAiResultSchema.safeParse(got).success).toBe(true);
  });

  it('a result that was never accepted cannot keep the source_supported label', async () => {
    const forged = ai({ id: 'airesult-0005', acceptedByUserAt: null, acceptedAt: null }) as Row;
    const { restored } = await roundTrip(forged);
    expect((await restored('airesult-0005')).verificationState).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------------------------

describe('merging an archive that lacks entity tables', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });

  /** The automatic pre-update copy of a v1 database: an archive of four tables at version 1. */
  async function preUpdateCopy() {
    const v1 = loadFixture('schema-v1.json');
    v1.sources = v1.sources.map(({ type: _t, ...rest }) => rest);
    v1.highlightBanks = v1.highlightBanks.map(({ folderId: _f, ...rest }) => rest);
    await seedV1(v1);
    off = installPreMigrationSnapshot({ appVersion: 'test' });
    await listBanks(); // first contact: upgrades the database and keeps the copy
    const kept = await readPreMigrationSnapshot();
    expect((await getPreMigrationInfo())?.status).toBe('kept');
    off();
    off = null;
    return { bytes: (kept as { bytes: Uint8Array }).bytes, upgraded: await dump(), v1 };
  }

  it('the pre-update copy of a v1 database merges into an empty current vault', async () => {
    const { bytes, upgraded } = await preUpdateCopy();
    await resetDbForTests();
    const { report, result } = await restoreBackup(bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.archive.tables.map((t) => t.name).sort()).toEqual(
      ['banks', 'highlightBanks', 'highlights', 'sources'].sort(),
    );
    expect(result?.written.highlights).toBe(upgraded.highlights?.length);
    const restored = await dump();
    for (const name of ['banks', 'sources', 'highlights', 'highlightBanks']) {
      expect(restored[name], name).toEqual(upgraded[name]);
    }
  });

  it('...and into a vault with later edits: adds what is missing, keeps what is newer', async () => {
    const { bytes, upgraded } = await preUpdateCopy();
    const db = getDb();
    const first = (upgraded.highlights as Row[])[0] as Row;
    const second = (upgraded.highlights as Row[])[1] as Row;
    await db.highlights.update(first.id as string, {
      userComment: 'edited after the copy',
      updatedAt: FUTURE,
    });
    await db.highlights.delete(second.id as string); // gone from the live vault
    const localOnly = { ...first, id: 'hl-local-only', quoteHash: hash('9') };
    await db.highlights.put(localOnly as never);
    await db.highlightBanks.put({
      highlightId: 'hl-local-only',
      bankId: 'inbox-default',
      folderId: null,
      addedAt: at(1),
    } as never);

    const { report } = await restoreBackup(bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.totals.add).toBeGreaterThan(0);
    expect((await db.highlights.get(first.id as string))?.userComment).toBe(
      'edited after the copy',
    );
    expect(await db.highlights.get(second.id as string)).toEqual(second);
    expect(await db.highlights.get('hl-local-only')).toBeDefined();
  });

  it('an id that already names a row of a table the archive lacks fails safely', async () => {
    await seed();
    const before = await state();
    const v1 = loadFixture('schema-v1.json');
    // a highlight that takes the id of a live FOLDER (the archive has no folders table)
    const clashing = {
      ...(v1.highlights[0] as Row),
      id: 'folder-000001',
      sourceId: v1.sources[0]?.id,
    };
    const forged = await archiveOf(
      {
        banks: v1.banks,
        sources: v1.sources,
        highlights: [clashing, ...v1.highlights.slice(1)],
        highlightBanks: [
          { ...(v1.highlightBanks[0] as Row), highlightId: 'folder-000001' },
          ...v1.highlightBanks.slice(1),
        ],
      },
      1,
    );
    const err = await restoreBackup(forged.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('commit_failed');
    // the id collision was found by the check, not by a missing table in the transaction
    expect((err.cause as Error).message).toMatch(/already used by a row of "folders"/);
    expect(await state()).toEqual(before);
    expect(await getDb().meta.get('lastRestore')).toBeUndefined();
    expect(await stagingDatabases()).toEqual([]);
  });

  it('an archive limited to a few registry tables merges at the current version', async () => {
    await seed();
    const db = getDb();
    const rows = (await state()) as Record<string, Row[]>;
    await db.highlights.delete('hl-000002');
    await db.sources.update('src-000001', { title: 'Locally renamed', updatedAt: FUTURE });
    const limited = await archiveOf(
      {
        banks: rows.banks as Row[],
        sources: rows.sources as Row[],
        highlights: rows.highlights as Row[],
      },
      DB_VERSION,
    );
    const { report } = await restoreBackup(limited.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.tables.highlights?.add).toBe(1);
    expect(await db.highlights.get('hl-000002')).toBeDefined();
    expect((await db.sources.get('src-000001'))?.title).toBe('Locally renamed');
    expect(await db.cards.count()).toBe(1); // tables the archive lacks are left alone
  });
});

// ---------------------------------------------------------------------------------------------

describe('one restore at a time, each in its own staging database', () => {
  it('a second restore while one runs is refused, and the lock is released afterwards', async () => {
    let release!: () => void;
    const held = withRestoreLock(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('first');
        }),
    );
    const second = await withRestoreLock(() => Promise.resolve('second')).catch((e) => e);
    expect(second).toBeInstanceOf(BackupError);
    expect(second.code).toBe('restore_in_progress');
    release();
    expect(await held).toBe('first');
    expect(await withRestoreLock(() => Promise.resolve('third'))).toBe('third');
  });

  it('honours a Web Lock held by another extension page', async () => {
    const asked: unknown[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, options: unknown, cb: (lock: unknown) => unknown) => {
          asked.push([name, options]);
          return Promise.resolve().then(() => cb(null)); // ifAvailable: not available
        },
      },
    });
    const err = await withRestoreLock(() => Promise.resolve('ran')).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('restore_in_progress');
    expect(asked).toEqual([[RESTORE_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }]]);

    vi.stubGlobal('navigator', {
      locks: {
        request: (_n: string, _o: unknown, cb: (lock: unknown) => unknown) =>
          Promise.resolve().then(() => cb({ name: RESTORE_LOCK_NAME })),
      },
    });
    expect(await withRestoreLock(() => Promise.resolve('ran'))).toBe('ran');
  });

  it('two commits started together: one restores, the other is refused, nothing is mixed', async () => {
    await seed();
    const out = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    await getDb().highlights.update('hl-000001', { userComment: 'local edit' });
    const target = createBackupTarget();
    const a = await prepareRestore(out.bytes, {
      target,
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    const b = await prepareRestore(out.bytes, {
      target,
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    const outcomes = await Promise.allSettled([a.commit(), b.commit()]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
    expect(((outcomes[1] as PromiseRejectedResult).reason as BackupError).code).toBe(
      'restore_in_progress',
    );
    expect((await getDb().highlights.get('hl-000001'))?.userComment).toBe('comment 1');
    expect(await stagingDatabases()).toEqual([]);
  });

  it('stages into a database of its own, removed on success and on failure', async () => {
    const target = createBackupTarget();
    const staging = await target.createStaging({ tables: ['banks'], expectedRows: { banks: 1 } });
    const during = await stagingDatabases();
    expect(during).toHaveLength(1);
    expect(during[0]).not.toBe(RESTORE_STAGING_DB);
    expect(during[0]).toMatch(/^studyvault-restore-staging-[0-9a-f-]{36}$/);
    await staging.discard();
    expect(await stagingDatabases()).toEqual([]);

    // failure: the commit cannot name an unknown table; rollback releases the database too
    const again = await target.createStaging({ tables: ['banks'], expectedRows: { banks: 0 } });
    await expect(again.commit({ mode: 'replace', tables: ['nope'] })).rejects.toThrow();
    await again.rollback();
    expect(await stagingDatabases()).toEqual([]);
  });

  it('the sweep removes the fixed-name database of older builds and any leftover, nothing else', async () => {
    await seed();
    for (const name of [RESTORE_STAGING_DB, `${RESTORE_STAGING_DB}-crashed-1234`]) {
      const stale = new Dexie(name);
      stale.version(1).stores({ leftovers: 'id' });
      await stale.open();
      await stale.table('leftovers').put({ id: 'x', quote: 'private text' });
      stale.close();
    }
    expect(await stagingDatabases()).toHaveLength(2);
    await clearRestoreStaging();
    expect(await stagingDatabases()).toEqual([]);
    expect((await indexedDB.databases()).map((d) => d.name)).toContain(DB_NAME);

    // "Delete all data" goes through the same sweep
    for (const name of [RESTORE_STAGING_DB, `${RESTORE_STAGING_DB}-crashed-5678`]) {
      const stale = new Dexie(name);
      stale.version(1).stores({ leftovers: 'id' });
      await stale.open();
      stale.close();
    }
    await wipeAllData();
    expect(await stagingDatabases()).toEqual([]);
  });

  it('the next restore removes the leftover of a crashed one before it stages', async () => {
    await seed();
    const out = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    const stale = new Dexie(`${RESTORE_STAGING_DB}-crashed-0001`);
    stale.version(1).stores({ leftovers: 'id' });
    await stale.open();
    stale.close();
    await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(await stagingDatabases()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('imported highlights never join a Source that a capture made', () => {
  const MD = [
    '# Cardiology',
    '',
    '> A claim that says it came from a page the person really captured.',
    '',
    '— [Not the real title](https://example.com/p/0) · captured 2026-03-04',
    '',
    '> A second claim from the same address.',
    '',
    '— [Another title](https://example.com/p/0)',
    '',
  ].join('\n');

  it('creates its own Source per import and leaves the captured one untouched', async () => {
    await seed();
    const db = getDb();
    const realSources = (await db.sources.toArray()) as Row[];
    const set = await importMarkdownHighlights(MD);
    expect(set.highlights).toHaveLength(2);

    const res = await importExternalHighlights(set, { bankId: 'bank-000001' });
    expect(res).toMatchObject({ created: 2, sourcesCreated: 1 }); // one claimed address, one Source
    const [a, b] = await Promise.all(res.highlightIds.map((id) => db.highlights.get(id)));
    expect(a?.sourceId).toBe(b?.sourceId);
    expect(realSources.map((s) => s.id)).not.toContain(a?.sourceId);

    const made = (await db.sources.get(a?.sourceId as string)) as Row;
    expect(made).toMatchObject({
      type: 'web',
      originalUrl: 'https://example.com/p/0', // the claim is shown ...
      canonicalUrl: null,
    });
    expect(String(made.urlKey)).toMatch(/^imported:/); // ... but no page can ever match it
    expect(made.visitedKey).toBe(made.urlKey);

    // the captured Source rows are exactly what they were
    expect(await db.sources.bulkGet(realSources.map((s) => s.id as string))).toEqual(realSources);
    expect(a?.captureMethod).toBe('import');

    // importing the same file again adds nothing, and a different file makes a new Source
    const another = await importMarkdownHighlights(
      '> Yet another claim about it.\n\n— [T](https://example.com/p/0)\n',
    );
    const res2 = await importExternalHighlights(another, { bankId: null });
    expect(res2.sourcesCreated).toBe(1);
    expect(res2.highlightIds).toHaveLength(1);
    const c = await db.highlights.get(res2.highlightIds[0] as string);
    expect(c?.sourceId).not.toBe(a?.sourceId);
  });
});
