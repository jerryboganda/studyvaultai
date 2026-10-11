import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { z } from 'zod';
import {
  Highlight as HighlightSchema,
  INBOX_BANK_ID,
  PDF_TEXT_ALGORITHM,
  PdfDocument as PdfDocumentSchema,
  SCHEMA_VERSION,
  Source as SourceSchema,
  DEFAULT_PALETTE,
  type TableRegistry,
  type TableSpec,
} from '@shared';
import { exportBackup } from '@backup';
import { MemoryVault, subtle, unpack, withTable } from '../../packages/backup/src/testkit';
import { rawPut, readTable, type Dataset } from './helpers.dashboard';
import type { Env } from './helpers.pages';
import { expect } from './helpers.review';

/**
 * Helpers for backup.spec.ts: export, "Delete all data" and restore driven through the real
 * Options page of the real built extension (no Chrome API and no product module is mocked).
 *
 * WHAT IS READ AND WRITTEN OUTSIDE THE UI, AND WHY
 *  - `snapshotVault` READS the vault's IndexedDB tables from an extension page (same origin as the
 *    worker). It never writes and never upgrades (opened without a version).
 *  - `seedPdfSourcedHighlight` WRITES one document + source + highlight row set with the
 *    extension-origin raw writer of helpers.dashboard.ts. Every row is validated in Node with the
 *    product's own Zod schemas first. The PDF reader is not driven here (pdf.spec.ts does that);
 *    this only gives the backup a row whose anchor kind is "pdf".
 *  - Archives are forged or damaged in Node on the bytes of a real download, with the backup
 *    package's own test kit (packages/backup/src/testkit.ts: unpack / withTable / reseal).
 *
 * Nothing here writes `settings` into chrome.storage.local (the worker keeps a trusted copy).
 */

// -----------------------------------------------------------------------------------------------
// What a backup holds
// -----------------------------------------------------------------------------------------------

/** The registry's tables minus `meta` and `syncOps` (packages/storage backupTarget.ts). */
export const BACKUP_TABLES = [
  'banks',
  'folders',
  'tags',
  'sources',
  'highlights',
  'highlightBanks',
  'highlightTags',
  'notes',
  'knowledgePoints',
  'decks',
  'cards',
  'reviewLogs',
  'aiResults',
  'documents',
  'ocrPages',
  // Rows hold Blob values: compared by size and type.
  'attachments',
] as const;

export type VaultSnapshot = Record<string, string[]>;

/**
 * Canonical JSON of every row of every backup table, sorted: two snapshots are equal exactly when
 * the vault holds the same rows. Raw read, opened without a version, nothing is written.
 */
export async function snapshotVault(page: Page): Promise<VaultSnapshot> {
  return page.evaluate(async (tables) => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) return {};
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const present = new Set(Array.from(db.objectStoreNames));
      const canon = (v: unknown): unknown => {
        if (v instanceof Blob) return { $blob: v.size, type: v.type };
        if (Array.isArray(v)) return v.map(canon);
        if (v !== null && typeof v === 'object') {
          return Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canon(x)]),
          );
        }
        return v;
      };
      const out: Record<string, string[]> = {};
      for (const name of tables) {
        if (!present.has(name)) {
          out[name] = [];
          continue;
        }
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(name, 'readonly').objectStore(name).getAll();
          req.onsuccess = () => resolve(req.result as unknown[]);
          req.onerror = () => reject(req.error);
        });
        out[name] = rows.map((row) => JSON.stringify(canon(row))).sort();
      }
      return out;
    } finally {
      db.close();
    }
  }, BACKUP_TABLES);
}

/** Table by table: what `expected` has and `actual` lacks, and the reverse (empty when equal). */
export function differences(actual: VaultSnapshot, expected: VaultSnapshot): string[] {
  const out: string[] = [];
  for (const table of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    const have = new Set(actual[table] ?? []);
    const want = new Set(expected[table] ?? []);
    const missing = [...want].filter((row) => !have.has(row));
    const extra = [...have].filter((row) => !want.has(row));
    if (missing.length > 0) {
      out.push(`${table}: ${missing.length} row(s) missing, e.g. ${missing[0]?.slice(0, 240)}`);
    }
    if (extra.length > 0) {
      out.push(`${table}: ${extra.length} row(s) unexpected, e.g. ${extra[0]?.slice(0, 240)}`);
    }
  }
  return out;
}

/** The vault holds exactly the rows of `expected` (compared as canonical JSON, table by table). */
export function expectSameVault(
  actual: VaultSnapshot,
  expected: VaultSnapshot,
  what = 'the vault',
): void {
  expect(differences(actual, expected), `${what} must hold exactly the expected rows`).toEqual([]);
}

export const countsOf = (snap: VaultSnapshot): Record<string, number> =>
  Object.fromEntries(Object.entries(snap).map(([table, rows]) => [table, rows.length]));

export const rowsOf = <T = Record<string, unknown>>(snap: VaultSnapshot, table: string): T[] =>
  (snap[table] ?? []).map((json) => JSON.parse(json) as T);

/** A snapshot without the given tables (for comparisons that must ignore, say, the Inbox row). */
export function without(snap: VaultSnapshot, ...tables: string[]): VaultSnapshot {
  return Object.fromEntries(Object.entries(snap).filter(([table]) => !tables.includes(table)));
}

/** The value of one `meta` row (settings and secrets live there), or undefined. */
export async function metaValue(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (wanted) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const req = db.transaction('meta', 'readonly').objectStore('meta').get(wanted);
        req.onsuccess = () => resolve((req.result as { value?: unknown } | undefined)?.value);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, key);
}

// -----------------------------------------------------------------------------------------------
// A PDF-sourced highlight (raw rows, validated with the product's schemas)
// -----------------------------------------------------------------------------------------------

export const PDF_QUOTE = 'Systemic vascular resistance falls when arterioles dilate.';

/** Document, source (type "pdf"), highlight (anchor kind "pdf") and its Inbox membership. */
export async function seedPdfSourcedHighlight(
  ctrl: Page,
  options: { key?: string; quote?: string; page?: number } = {},
): Promise<{ documentId: string; sourceId: string; highlightId: string; quote: string }> {
  const key = options.key ?? 'pdf1';
  const quote = options.quote ?? PDF_QUOTE;
  const documentId = `e2e-doc-${key}-0000000000000000000000000000000000000000000000000000`.slice(
    0,
    64,
  );
  const sourceId = `e2e-src-${key}`;
  const highlightId = `e2e-hl-${key}`;
  const at = new Date(Date.UTC(2026, 1, 3, 9, 30)).toISOString();
  const meta = { schemaVersion: SCHEMA_VERSION, createdAt: at, updatedAt: at, deletedAt: null };
  const documentRow = {
    ...meta,
    id: documentId,
    title: 'Haemodynamics lecture handout',
    pageCount: 12,
    byteLength: 48_213,
    originalUrl: null,
    textStatus: 'text',
  };
  const sourceRow = {
    ...meta,
    id: sourceId,
    type: 'pdf',
    documentId,
    urlKey: `pdf:${documentId}`,
    visitedKey: `pdf:${documentId}`,
    originalUrl: `https://studyvault.invalid/pdf/${documentId}`,
    canonicalUrl: null,
    host: '',
    title: documentRow.title,
  };
  const highlightRow = {
    ...meta,
    id: highlightId,
    sourceId,
    exactQuote: quote,
    normalizedQuote: quote.toLowerCase(),
    quoteHash: createHash('sha256').update(quote.toLowerCase()).digest('hex'),
    anchorSet: {
      type: 'pdf',
      textAlgorithm: PDF_TEXT_ALGORITHM,
      documentFingerprint: documentId,
      pageNumber: options.page ?? 7,
      rotation: 0,
      rects: [
        { x: 0.1, y: 0.22, w: 0.62, h: 0.03 },
        { x: 0.1, y: 0.25, w: 0.2, h: 0.03 },
      ],
      textQuote: { exact: quote, prefix: '', suffix: '' },
      textPosition: { start: 120, end: 120 + quote.length },
      contentSignature: 'e2e-pdf',
      documentTextLength: 4_000,
    },
    kind: 'essential',
    color: DEFAULT_PALETTE.essential,
    priority: 4,
    userComment: 'From the handout, page 7.',
    headingContext: null,
    captureMethod: 'toolbar',
    capturedAt: at,
    resolveStatus: 'unchecked',
    resolveConfidence: null,
    lastResolvedAt: null,
    capturedTitle: documentRow.title,
  };
  PdfDocumentSchema.parse(documentRow);
  SourceSchema.parse(sourceRow);
  HighlightSchema.parse(highlightRow);
  await rawPut(ctrl, {
    documents: [documentRow],
    sources: [sourceRow],
    highlights: [highlightRow],
    highlightBanks: [{ highlightId, bankId: INBOX_BANK_ID, folderId: null, addedAt: at }],
  });
  return { documentId, sourceId, highlightId, quote };
}

/**
 * Write a dataset, keeping an Inbox row that already exists. The product creates the Inbox the
 * first time something is filed in it, so a vault that was only opened (ensureVault) may not have
 * one yet; rows that name it would then point at nothing (a restore rightly refuses that), so the
 * dataset's own Inbox row is written in that case.
 */
export async function writeDatasetKeepingInbox(ctrl: Page, ds: Dataset): Promise<void> {
  const haveInbox = (await readTable<{ id: string }>(ctrl, 'banks')).some(
    (b) => b.id === INBOX_BANK_ID,
  );
  const banks = haveInbox
    ? ds.rows.banks.filter((b) => (b as { id: string }).id !== INBOX_BANK_ID)
    : ds.rows.banks;
  for (const [table, rows] of Object.entries({ ...ds.rows, banks })) {
    if (rows.length > 0) await rawPut(ctrl, { [table]: rows } as Parameters<typeof rawPut>[1]);
  }
}

// -----------------------------------------------------------------------------------------------
// The Options page
// -----------------------------------------------------------------------------------------------

const PROBLEMS = new WeakMap<Page, string[]>();

/** Uncaught exceptions and console errors of a page opened by `openBackupPage`. */
export const pageProblems = (page: Page): string[] => PROBLEMS.get(page) ?? [];

/** The Options page with its Backup section rendered (an extension page, same origin as the vault). */
export async function openBackupPage(env: Env): Promise<Page> {
  const page = await env.context.newPage();
  const problems: string[] = [];
  PROBLEMS.set(page, problems);
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  await page.goto(`chrome-extension://${env.extensionId}/options.html#backup`);
  await expect(page.getByTestId('backup-section')).toBeVisible();
  return page;
}

export const exportPanel = (page: Page) => page.getByTestId('backup-export');
export const wizard = (page: Page) => page.getByTestId('backup-import');

// -----------------------------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------------------------

export interface BackupFile {
  /** The name the browser saved the download under. */
  name: string;
  bytes: Buffer;
  /** What the panel itself said about the file. */
  ui: { fileName: string; sha256: string; counts: Record<string, number>; protection: string };
}

/** Wait for a download triggered by `trigger` and read the saved file. */
export async function downloadOf(
  page: Page,
  trigger: () => Promise<unknown>,
): Promise<{ name: string; bytes: Buffer }> {
  const pending = page.waitForEvent('download');
  await trigger();
  const download = await pending;
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(path) };
}

/** Labels of the export panel's count list (copied from packages/ui/src/backup/format.ts). */
export const LABEL = {
  banks: 'Banks',
  sources: 'Sources (pages)',
  highlights: 'Highlights',
  highlightBanks: 'Highlights filed in banks',
  folders: 'Folders and topics',
  tags: 'Tags',
  highlightTags: 'Tags on highlights',
  notes: 'Notes',
  decks: 'Flashcard decks',
  cards: 'Flashcards',
  reviewLogs: 'Review history',
  documents: 'PDF documents',
} as const;

/** Tick "protect with a passphrase" and fill the two fields and the acknowledgement. */
export async function setPassphrase(
  scope: Locator,
  testId: string,
  passphrase: string,
): Promise<void> {
  await scope.getByTestId(`${testId}-enable`).check();
  await scope.getByTestId(`${testId}-value`).fill(passphrase);
  await scope.getByTestId(`${testId}-confirm`).fill(passphrase);
  await scope.getByTestId(`${testId}-ack`).check();
}

/** "Create backup file" in the Backup section, optionally encrypted; returns the saved file. */
export async function createBackup(
  page: Page,
  options: { passphrase?: string } = {},
): Promise<BackupFile> {
  const panel = exportPanel(page);
  if (options.passphrase !== undefined) {
    await setPassphrase(panel, 'backup-export-pass', options.passphrase);
  }
  const saved = await downloadOf(page, () => panel.getByTestId('backup-export-start').click());
  // A previous run's result stays on screen until this one replaces it: wait for the busy state to end.
  await expect(panel.getByTestId('backup-export-progress')).toHaveCount(0);
  const done = panel.getByTestId('backup-export-done');
  await expect(done).toBeVisible();
  const counts: Record<string, number> = {};
  for (const li of await done.getByTestId('backup-export-counts').locator('li').all()) {
    const [label, value] = await li.locator('span').allTextContents();
    counts[label ?? ''] = Number(value);
  }
  const protection = await done
    .locator('dt', { hasText: 'Protection' })
    .locator('xpath=following-sibling::dd')
    .innerText();
  return {
    name: saved.name,
    bytes: saved.bytes,
    ui: {
      fileName: ((await done.getByTestId('backup-export-filename').textContent()) ?? '').trim(),
      sha256: ((await done.getByTestId('backup-export-sha').textContent()) ?? '').trim(),
      counts,
      protection: protection.trim(),
    },
  };
}

export const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export interface ArchiveContents {
  files: string[];
  manifest: {
    format: string;
    formatVersion: number;
    appSchemaVersion: number;
    tables: Array<{ name: string; rowCount: number }>;
    options: { includesAttachments: boolean; encrypted: boolean };
  };
  /** Rows per table, parsed from the NDJSON members. */
  tables: Record<string, Array<Record<string, unknown>>>;
  /** Every member as text, joined (for "this string appears nowhere in the file" checks). */
  everything: string;
}

/** Open an unencrypted backup the way a person with an unzip tool would. */
export function readArchive(bytes: Uint8Array): ArchiveContents {
  const members = unzipSync(bytes);
  const files = Object.keys(members).sort();
  const manifest = JSON.parse(
    strFromU8(members['manifest.json'] as Uint8Array),
  ) as ArchiveContents['manifest'];
  const tables: ArchiveContents['tables'] = {};
  for (const file of files) {
    const match = /^tables\/(.+)\.ndjson$/.exec(file);
    if (!match) continue;
    tables[match[1] as string] = strFromU8(members[file] as Uint8Array)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  const everything = files.map((f) => strFromU8(members[f] as Uint8Array)).join('\n');
  return { files, manifest, tables, everything };
}

// -----------------------------------------------------------------------------------------------
// Delete all data
// -----------------------------------------------------------------------------------------------

export const wipeDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Delete all StudyVault data?' });

export async function openWipeDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Delete all StudyVault data…' }).click();
  await expect(wipeDialog(page)).toBeVisible();
}

/** "Delete all StudyVault data…" -> confirm dialog -> wait for the success notice. */
export async function deleteAllData(page: Page): Promise<void> {
  await openWipeDialog(page);
  await wipeDialog(page).getByRole('button', { name: 'Delete everything' }).click();
  await expect(
    page.getByText(/All StudyVault data was deleted from this device/),
    'the page reports that the deletion finished',
  ).toBeVisible({ timeout: 60_000 });
}

// -----------------------------------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------------------------------

/** Hand a file to the restore wizard's file input (a real change event on the real input). */
export async function chooseBackup(
  page: Page,
  file: { name: string; bytes: Uint8Array | Buffer },
): Promise<void> {
  await wizard(page)
    .getByTestId('backup-import-file')
    .setInputFiles({
      name: file.name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(file.bytes),
    });
}

/** The wizard shows its dry-run report (nothing has been written yet). */
export async function expectReview(page: Page): Promise<void> {
  await expect(wizard(page).getByTestId('backup-import-review')).toBeVisible({ timeout: 60_000 });
  await expect(wizard(page).getByTestId('restore-report')).toBeVisible();
}

/** "Replace my study data with the backup" -> typed confirmation. Leaves the safety copy as is. */
export async function selectReplace(page: Page): Promise<void> {
  const w = wizard(page);
  await w.getByTestId('backup-import-mode-replace').check();
  await expect(w.getByTestId('restore-summary')).toContainText('Your vault becomes the backup');
  await w.getByTestId('backup-import-confirm-word').fill('REPLACE');
}

export interface CommitOptions {
  mode?: 'merge' | 'replace';
  /** Tick (true) or clear (false) "Download a safety backup first". Default: what the wizard chose. */
  safety?: boolean;
}

/** Choose the mode, press the final button and wait for the "done" step. */
export async function commitRestore(page: Page, options: CommitOptions = {}): Promise<void> {
  const w = wizard(page);
  await expectReview(page);
  if (options.mode === 'replace') await selectReplace(page);
  if (options.safety !== undefined)
    await w.getByTestId('backup-import-safety').setChecked(options.safety);
  await w.getByTestId('backup-import-restore').click();
  await expect(w.getByTestId('backup-import-done')).toBeVisible({ timeout: 90_000 });
}

/** The visible title and body of the wizard's failure (or "needs your decision") notice. */
export async function refusal(page: Page): Promise<string> {
  const w = wizard(page);
  const shown = w.locator(
    '[data-testid="backup-import-failed"], [data-testid="backup-import-blocked"]',
  );
  await expect(shown).toBeVisible({ timeout: 60_000 });
  return ((await shown.innerText()) ?? '').replace(/\s+/g, ' ').trim();
}

/** After a refusal (or from the review step): back to the file chooser, nothing written. */
export async function chooseAnother(page: Page): Promise<void> {
  const w = wizard(page);
  await w
    .getByRole('button', {
      name: /^(Choose another file|Stop, change nothing|Cancel|Restore another file)$/,
    })
    .first()
    .click();
  await expect(w.getByTestId('backup-import-file')).toBeVisible();
}

// -----------------------------------------------------------------------------------------------
// Damaged and forged archives (Node side, on the bytes of a real download)
// -----------------------------------------------------------------------------------------------

/** First `n` bytes only: a download that stopped half way. */
export const truncated = (bytes: Uint8Array, keep = 0.5): Uint8Array =>
  Uint8Array.from(bytes.subarray(0, Math.max(30, Math.floor(bytes.length * keep))));

/**
 * One bit flipped in the middle of the stored bytes of a table member (found through the central
 * directory, so the flip lands in data and never in a header field the reader does not use).
 */
export function flippedTableByte(bytes: Uint8Array, table = 'highlights'): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = strFromU8(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name === `tables/${table}.ndjson`) {
      const dataStart =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      // a copy (Buffer#slice would share memory with the caller's bytes)
      const out = Uint8Array.from(bytes);
      const target = dataStart + Math.floor(compressed / 2);
      out[target] = (out[target] ?? 0) ^ 0x5a;
      return out;
    }
    at += 46 + nameLength + extra + comment;
  }
  throw new Error(`no ${table} member`);
}

/** A tiny file with a ZIP64 end record: what a forged "huge archive" header looks like. */
export function forgedZip64(): Uint8Array {
  const out = new Uint8Array(4 + 22);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true); // local file header signature, so it "looks like a zip"
  const eocd = 4;
  view.setUint32(eocd, 0x06054b50, true);
  view.setUint16(eocd + 8, 0xffff, true); // entries on this disk
  view.setUint16(eocd + 10, 0xffff, true); // total entries
  view.setUint32(eocd + 12, 0xffffffff, true); // directory size
  view.setUint32(eocd + 16, 0xffffffff, true); // directory offset
  return out;
}

type Row = Record<string, unknown>;

/**
 * Rewrite rows of one table of an UNENCRYPTED backup. With `sealed` the manifest's row count,
 * table checksum and manifest checksum are recomputed, i.e. a forgery that is internally
 * consistent (what an attacker who read the format would write); without it the table no longer
 * matches its checksum (what damage or a hand edit looks like).
 */
export function rewriteTable(
  bytes: Uint8Array,
  table: string,
  change: (row: Row) => Row | null,
  sealed: boolean,
): Uint8Array {
  const files = unpack(bytes);
  const member = files[`tables/${table}.ndjson`];
  if (!member) throw new Error(`the archive has no ${table} table`);
  const lines = strFromU8(member)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      const next = change(JSON.parse(line) as Row);
      return next === null ? [] : [JSON.stringify(next)];
    });
  return withTable(files, table, `${lines.join('\n')}\n`, sealed);
}

// -----------------------------------------------------------------------------------------------
// An archive written by an older exporter: data version 1 (no source type, no folder column)
// -----------------------------------------------------------------------------------------------

const v1Spec = (name: string, primaryKey: string | readonly string[]): TableSpec => ({
  name,
  primaryKey,
  schema: z.unknown(),
  softDelete: name !== 'highlightBanks',
});

/**
 * Re-export live rows as the exporter of data version 1 wrote them: `sources` without `type`,
 * `highlightBanks` without `folderId`, manifest `appSchemaVersion` 1. The restore must upgrade
 * them back (BACKUP_MIGRATIONS 1 -> 2 -> 3) to exactly what the vault held.
 */
export async function archiveAsDataVersion1(rows: {
  banks: Row[];
  sources: Row[];
  highlights: Row[];
  highlightBanks: Row[];
}): Promise<Uint8Array> {
  const registry: TableRegistry = {
    schemaVersion: 1,
    tables: [
      v1Spec('banks', 'id'),
      v1Spec('sources', 'id'),
      v1Spec('highlights', 'id'),
      v1Spec('highlightBanks', ['highlightId', 'bankId']),
    ],
  };
  const strip = (row: Row, field: string): Row => {
    const { [field]: _dropped, ...rest } = row;
    return rest;
  };
  const vault = new MemoryVault(
    {
      banks: rows.banks,
      sources: rows.sources.map((r) => strip(r, 'type')),
      highlights: rows.highlights,
      highlightBanks: rows.highlightBanks.map((r) => strip(r, 'folderId')),
    },
    { registry },
  );
  const out = await exportBackup(vault, {
    subtle,
    appVersion: '0.1.0-data-v1-e2e',
    now: () => new Date('2026-02-01T10:00:00.000Z'),
  });
  expect(out.manifest.appSchemaVersion).toBe(1);
  return out.bytes;
}

// -----------------------------------------------------------------------------------------------
// The automatic copy taken before a database upgrade
// -----------------------------------------------------------------------------------------------

/**
 * Plant the record the product keeps in its `studyvault-premigration` database (one row, id
 * "latest") with `bytes` as the archive. A real one is made by an upgrade of the database
 * (packages/storage lifecycle tests cover that); a loaded extension cannot be made to upgrade a
 * database on demand, so this is what the Options page is shown in that situation. Written from
 * an extension page, in the shape the product's own reader (`getPreMigrationInfo`) parses.
 */
export async function seedPreUpdateCopy(
  page: Page,
  bytes: Uint8Array,
  filename = 'studyvault-before-update-20260301-120000.zip',
): Promise<{ sha256: string; filename: string }> {
  const sha256 = sha256Of(bytes);
  const tables: Record<string, number> = {};
  let rows = 0;
  for (const t of readArchive(bytes).manifest.tables) {
    if (t.rowCount > 0) tables[t.name] = t.rowCount;
    rows += t.rowCount;
  }
  await page.evaluate(
    async (record) => {
      await new Promise<void>((resolve, reject) => {
        // Dexie's version(1) is IndexedDB version 10.
        const open = indexedDB.open('studyvault-premigration', 10);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains('snapshots')) {
            open.result.createObjectStore('snapshots', { keyPath: 'id' });
          }
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('snapshots', 'readwrite');
          tx.objectStore('snapshots').put(record);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    {
      id: 'latest',
      createdAt: '2026-03-01T12:00:00.000Z',
      fromVersion: 20,
      toVersion: 30,
      status: 'kept',
      reason: null,
      rows,
      tables,
      byteLength: bytes.length,
      sha256,
      filename,
      bytes: new Uint8Array(bytes),
    },
  );
  return { sha256, filename };
}

/** Names of the IndexedDB databases of this extension origin. */
export async function databaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases()).flatMap((d) => (d.name === undefined ? [] : [d.name])),
  );
}
