import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { pack, reseal, unpack } from '../../packages/backup/src/testkit';
import {
  LABEL,
  archiveAsDataVersion1,
  chooseAnother,
  chooseBackup,
  commitRestore,
  countsOf,
  createBackup,
  deleteAllData,
  downloadOf,
  expectReview,
  expectSameVault,
  flippedTableByte,
  forgedZip64,
  metaValue,
  openBackupPage,
  openWipeDialog,
  readArchive,
  refusal,
  rewriteTable,
  rowsOf,
  seedPdfSourcedHighlight,
  selectReplace,
  setPassphrase,
  sha256Of,
  snapshotVault,
  truncated,
  wipeDialog,
  without,
  wizard,
  writeDatasetKeepingInbox,
} from './helpers.backup';
import {
  axeViolations,
  buildDataset,
  captureQuote,
  createBankRpc,
  dialogOf,
  ensureVault,
  expectList,
  expectTotal,
  openControl,
  openDashboard,
  readTable,
  type DatasetInput,
  type StoredHighlight,
} from './helpers.dashboard';
import {
  launchSession,
  newUserDataDir,
  openExtensionPage,
  recordRequests,
  removeDir,
  expectPaintedExactly,
  type Session,
} from './helpers.lifecycle';
import { bgData, highlightsOf, openFixture, storedSettings, test, type Env } from './helpers.pages';
import {
  answerAll,
  captureHighlights,
  countedLogs,
  createBasicCards,
  expect,
  expectDue,
  gotoTab,
  openHighlightInAuthor,
  openReview,
  readStudyDb,
  saveEditor,
  startAll,
} from './helpers.review';

test.describe.configure({ timeout: 300_000 });

/**
 * Backup, "Delete all data" and restore in a real loaded extension: real Chromium, the real built
 * extension, every action through the Options page's own controls (file downloads are Playwright
 * download events; restore files go through the wizard's real file input).
 *
 * Data reaches the vault through the product wherever a UI or an RPC exists (toolbar capture,
 * capture.save, bank.create, the review page's author view and study session). Rows no UI can make
 * without a PDF or an AI provider are written with the extension-origin raw writer after they were
 * validated with the product's own schemas (see helpers.backup.ts). Nothing mocks a Chrome API.
 *
 * What is NOT covered here: a real incognito window, a second window holding the database while
 * a restore commits, and a backup larger than a few hundred rows (unit and stress tests cover
 * those at the engine level).
 */

const CARDIO_QUOTE = 'Cardiac output equals heart rate multiplied by stroke volume.';
const PHYSIO_ATP =
  'Mitochondria produce ATP through oxidative phosphorylation in the inner membrane.';
const PHYSIO_MEMBRANE = 'The cell membrane is a selectively permeable phospholipid bilayer.';
const PHYSIO_PUMP =
  'Sodium potassium ATPase moves three sodium ions out for two potassium ions in.';
const TRASHED = 'This fact was in the trash when the backup was made.';

const PASSPHRASE = 'correct horse battery staple';
const UNCHANGED = 'Your StudyVault data was not changed.';

const sourceA = (env: Env) => `${env.origin}/dash-source-a.html`;
const sourceB = (env: Env) => `${env.origin}/dash-source-b.html`;

/** Banks, folders (two levels), tags, notes, custom fields, a trashed row, on two sources. */
function richInput(env: Env): DatasetInput {
  return {
    banks: [{ key: 'physio', name: 'Physiology', color: 'teal' }],
    folders: [
      { key: 'hemo', bank: 'physio', name: 'Haemodynamics' },
      { key: 'press', bank: 'physio', parent: 'hemo', name: 'Pressure' },
    ],
    tags: [
      { key: 'exam', name: 'exam' },
      { key: 'formula', name: 'formula' },
    ],
    sources: [{ key: 'cell', url: sourceA(env), title: 'Cell biology notes' }],
    highlights: [
      {
        key: 'atp',
        quote: PHYSIO_ATP,
        source: 'cell',
        places: [{ bank: 'physio', folder: 'press' }, { bank: 'inbox' }],
        kind: 'formula',
        priority: 5,
        comment: 'Know the four complexes.',
        heading: 'Energy',
        tags: ['exam', 'formula'],
        notes: [
          {
            title: 'Electron transport',
            body: '## Complexes\n\n1. NADH dehydrogenase\n2. Succinate dehydrogenase\n',
            pinned: true,
          },
        ],
        fields: { 'Exam weight': 3, Reviewed: true },
      },
      {
        key: 'mem',
        quote: PHYSIO_MEMBRANE,
        source: 'cell',
        places: [{ bank: 'physio' }],
        kind: 'exception',
        priority: 2,
        status: 'resolved',
      },
      { key: 'gone', quote: TRASHED, source: 'cell', trashed: true },
    ],
  };
}

/** Two sources, a bank, tags and notes; no folders, no cards (the shape a v1 backup can hold). */
function smallInput(env: Env): DatasetInput {
  return {
    banks: [{ key: 'cardio', name: 'Cardiology' }],
    tags: [{ key: 'exam', name: 'exam' }],
    sources: [
      { key: 'a', url: sourceA(env), title: 'Cell biology notes' },
      { key: 'b', url: sourceB(env), title: 'Membranes' },
    ],
    highlights: [
      {
        key: 'a1',
        quote: PHYSIO_ATP,
        source: 'a',
        places: [{ bank: 'cardio' }],
        tags: ['exam'],
        comment: 'Four complexes.',
        notes: [{ title: 'Gradient', body: 'Remember the proton gradient.' }],
      },
      { key: 'a2', quote: PHYSIO_MEMBRANE, source: 'a', priority: 4 },
      {
        key: 'b1',
        quote: PHYSIO_PUMP,
        source: 'b',
        places: [{ bank: 'cardio' }, { bank: 'inbox' }],
        kind: 'formula',
      },
      { key: 'gone', quote: TRASHED, source: 'a', trashed: true },
    ],
  };
}

async function seedSmall(env: Env, input: DatasetInput = smallInput(env)) {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  const ds = buildDataset(input);
  await writeDatasetKeepingInbox(ctrl, ds);
  return { ctrl, ds };
}

const noExternalRequests = (urls: readonly string[], fixtureOrigin: string): string[] =>
  urls.filter((u) => /^(https?|wss?):/i.test(u) && !u.startsWith(fixtureOrigin));

interface FrozenFixture {
  base64: string;
  counts: Record<string, number>;
  encrypted: boolean;
  passphrase: string | null;
}

/** An archive the format-1 exporter wrote and the repository froze (packages/backup/src/fixtures). */
const frozen = (name: string): FrozenFixture =>
  JSON.parse(
    fs.readFileSync(path.resolve('packages/backup/src/fixtures', name), 'utf8'),
  ) as FrozenFixture;

// ===============================================================================================
// 1. Round trip
// ===============================================================================================

test.describe('export, Delete all data, restore', () => {
  test('a full backup brings back exactly the same vault after "Delete all data", and the highlights paint again', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);

    // ---- a realistic vault -------------------------------------------------------------------
    // Two pages through the real toolbar and bank composer.
    const cardio = await captureHighlights(env, '/article.html', ['#quote', '#p-multiline'], {
      bank: 'Cardiology',
    });
    const pharm = await captureHighlights(env, '/review-pharmacology.html', ['#rv-halflife'], {
      bank: 'Pharmacology',
    });
    expect(cardio.map((c) => c.quote)).toContain(CARDIO_QUOTE);
    expect(pharm).toHaveLength(1);
    // Folders, tags, notes, custom fields, a trashed row, and one highlight of a PDF.
    const ds = buildDataset(richInput(env));
    await writeDatasetKeepingInbox(ctrl, ds);
    const pdf = await seedPdfSourcedHighlight(ctrl);
    // A flashcard made from a highlight, a typed one, and review history from a real session.
    const review = await openReview(env);
    await openHighlightInAuthor(review, cardio[0]!.id);
    await saveEditor(
      review,
      {
        t: 'basic',
        question: 'What does cardiac output equal?',
        answer: 'Heart rate multiplied by stroke volume.',
      },
      1,
    );
    await createBasicCards(review, [
      ['What is preload?', 'The stretch of the ventricle at the end of diastole.'],
    ]);
    await gotoTab(review, 'Study');
    await expectDue(review, 2);
    await startAll(review);
    await answerAll(review, [3, 1], { max: 2 });
    await expect
      .poll(async () => countedLogs(await readStudyDb(review)).length, {
        message: 'both answers are in the review history',
      })
      .toBe(2);
    await review.close();

    const before = await snapshotVault(ctrl);
    const counts = countsOf(before);
    expect(counts).toMatchObject({
      banks: 4, // Inbox, Cardiology, Pharmacology, Physiology
      sources: 4, // two pages, the seeded page, the PDF
      highlights: 7, // 3 captured, 3 seeded (one in the trash), 1 PDF
      highlightBanks: 8,
      folders: 2,
      tags: 2,
      highlightTags: 2,
      notes: 1,
      cards: 2,
      reviewLogs: 2,
      documents: 1,
    });
    expect(counts.decks).toBeGreaterThan(0);

    // ---- export ------------------------------------------------------------------------------
    const page = await openBackupPage(env);
    // Before anything is pressed the panel already says what is and is not in the file.
    const holds = page.getByTestId('backup-export-holds');
    await expect(holds).toContainText('banks, folders, tags, highlights');
    await expect(holds).toContainText('flashcards with their review history');
    await expect(holds).toContainText('Nothing is uploaded');
    const leavesOut = page.getByTestId('backup-export-leaves-out');
    await expect(leavesOut).toContainText('Not in the file:');
    await expect(leavesOut).toContainText('your settings');
    await expect(leavesOut).toContainText('the AI provider, address, key and usage');
    await expect(leavesOut).toContainText('the sync account and its queue');

    const file = await createBackup(page);
    expect(file.name).toMatch(/^studyvault-backup-\d{8}-\d{6}\.zip$/);
    expect(file.ui.fileName, 'the panel shows the name the browser saved').toBe(file.name);
    expect(file.bytes.length).toBeGreaterThan(2_000);
    expect([...file.bytes.subarray(0, 4)], 'ZIP signature').toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(file.ui.sha256, 'the SHA-256 the panel prints is the file hash').toBe(
      sha256Of(file.bytes),
    );
    expect(file.ui.protection).toMatch(/^Not encrypted/);
    await expect(page.getByTestId('backup-export-done-leaves-out')).toContainText(
      'Not included, by design',
    );
    // The "what is inside" list is the vault's own row counts.
    expect(file.ui.counts).toMatchObject({
      [LABEL.banks]: counts.banks,
      [LABEL.sources]: counts.sources,
      [LABEL.highlights]: counts.highlights,
      [LABEL.highlightBanks]: counts.highlightBanks,
      [LABEL.folders]: counts.folders,
      [LABEL.tags]: counts.tags,
      [LABEL.notes]: counts.notes,
      [LABEL.cards]: counts.cards,
      [LABEL.reviewLogs]: counts.reviewLogs,
      [LABEL.documents]: counts.documents,
    });
    // ... and the file really contains them.
    const archive = readArchive(file.bytes);
    expect(archive.manifest).toMatchObject({
      format: 'studyvault-backup',
      formatVersion: 1,
      options: { encrypted: false, includesAttachments: false },
    });
    const tableNames = archive.manifest.tables.map((t) => t.name);
    for (const never of ['meta', 'syncOps', 'attachments']) {
      expect(tableNames, `${never} is never in a backup unless asked for`).not.toContain(never);
    }
    for (const t of archive.manifest.tables) {
      expect(t.rowCount, `manifest row count of ${t.name}`).toBe(counts[t.name] ?? 0);
      expect(archive.tables[t.name], `rows of ${t.name} in the file`).toHaveLength(t.rowCount);
    }
    expect(new Set(archive.tables.highlights?.map((h) => h.exactQuote))).toEqual(
      new Set(rowsOf<StoredHighlight>(before, 'highlights').map((h) => h.exactQuote)),
    );
    expectSameVault(await snapshotVault(ctrl), before, 'the vault after a backup was made');

    // ---- Delete all data (the Options page's own confirmation) -------------------------------
    await deleteAllData(page);
    const wiped = await snapshotVault(ctrl);
    for (const table of [
      'highlights',
      'highlightBanks',
      'sources',
      'notes',
      'folders',
      'tags',
      'highlightTags',
      'cards',
      'decks',
      'reviewLogs',
      'documents',
    ]) {
      expect(wiped[table], `${table} after Delete all data`).toEqual([]);
    }
    expect(rowsOf<{ id: string }>(wiped, 'banks').every((b) => b.id === 'inbox-default')).toBe(
      true,
    );
    expect(await storedSettings(page), 'settings are back to their defaults').toBeUndefined();
    const empty = await openDashboard(env, {}, { settle: false });
    await expect(empty.getByText('Your vault is empty')).toBeVisible();
    await empty.close();

    // ---- restore: read the dry run, choose replace, commit -----------------------------------
    await chooseBackup(page, file);
    await expectReview(page);
    const w = wizard(page);
    await expect(w.getByTestId('restore-archive-facts')).toContainText('Not encrypted');
    await expect(w.getByTestId('restore-archive-facts')).toContainText('Cached PDFs');
    await expect(w.getByTestId('restore-summary')).toContainText('new items will be added');
    await expect(w.getByTestId('restore-conflict')).toContainText('No conflicts.');
    await selectReplace(page);
    const total = archive.manifest.tables.reduce((n, t) => n + t.rowCount, 0);
    await expect(w.getByTestId('restore-summary')).toContainText(
      `Your vault becomes the backup: ${total} items from the file.`,
    );
    await expect(w.getByTestId('restore-removed')).toContainText(
      '0 items that exist only in your vault will be deleted.',
    );
    await expect(
      w.getByTestId('backup-import-safety'),
      'replace recommends a safety copy of the current data',
    ).toBeChecked();
    const safety = await downloadOf(page, () => commitRestore(page, { mode: 'replace' }));
    expect(safety.name).toMatch(/^studyvault-before-restore-\d{8}-\d{6}\.zip$/);
    const done = w.getByTestId('backup-import-done');
    await expect(done).toContainText('Your data was replaced');
    await expect(done).toContainText(`${total} items written.`);
    await expect(w.getByTestId('backup-import-safety-file')).toContainText(safety.name);
    await expect(done.getByText('Integrity check passed')).toBeVisible();
    expect(readArchive(safety.bytes).manifest.format, 'the safety copy is a backup too').toBe(
      'studyvault-backup',
    );

    // ---- the same vault, row for row ---------------------------------------------------------
    const after = await snapshotVault(ctrl);
    expectSameVault(after, before, 'the vault after Delete all data and a restore');
    const highlights = rowsOf<StoredHighlight>(after, 'highlights');
    const byId = (id: string) => highlights.find((h) => h.id === id)!;
    // quote and anchor kind (web and PDF)
    expect(byId(cardio[0]!.id)).toMatchObject({
      exactQuote: cardio[0]!.quote,
      deletedAt: null,
      anchorSet: { type: 'html', textQuote: { exact: cardio[0]!.quote } },
    });
    expect(byId(pdf.highlightId)).toMatchObject({
      exactQuote: pdf.quote,
      anchorSet: { type: 'pdf', pageNumber: 7, documentFingerprint: pdf.documentId },
    });
    // the trashed row stays in the trash
    expect(byId(ds.id.hl('gone')).deletedAt).not.toBeNull();
    // bank and folder membership
    const memberships = rowsOf<{ highlightId: string; bankId: string; folderId: string | null }>(
      after,
      'highlightBanks',
    );
    expect(memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          highlightId: ds.id.hl('atp'),
          bankId: ds.id.bank('physio'),
          folderId: ds.id.folder('press'),
        }),
        expect.objectContaining({
          highlightId: ds.id.hl('atp'),
          bankId: 'inbox-default',
          folderId: null,
        }),
      ]),
    );
    // note body, tags, custom fields
    const notes = rowsOf<{ highlightId: string; body: string; pinned: boolean }>(after, 'notes');
    expect(notes).toEqual([
      expect.objectContaining({
        highlightId: ds.id.hl('atp'),
        body: '## Complexes\n\n1. NADH dehydrogenase\n2. Succinate dehydrogenase\n',
        pinned: true,
      }),
    ]);
    expect(byId(ds.id.hl('atp')).customFields).toEqual({ 'Exam weight': 3, Reviewed: true });
    // a card: due date, state and review history
    const cardsBefore = rowsOf<{ front: string; dueAt: string; fsrs: { state: string } }>(
      before,
      'cards',
    );
    const cardsAfter = rowsOf<{ front: string; dueAt: string; fsrs: { state: string } }>(
      after,
      'cards',
    );
    expect(cardsAfter.map((c) => [c.front, c.dueAt, c.fsrs.state]).sort()).toEqual(
      cardsBefore.map((c) => [c.front, c.dueAt, c.fsrs.state]).sort(),
    );
    expect(cardsAfter.some((c) => c.fsrs.state !== 'new')).toBe(true);
    expect(after.reviewLogs).toHaveLength(2);

    // ---- the library, search and the original page -------------------------------------------
    const dash = await openDashboard(env);
    await expectTotal(dash, 6);
    await dash.close();
    const article = await openFixture(env, '/article.html');
    await expectPaintedExactly(
      article,
      cardio.map((c) => c.quote),
    );
    const fromWorker = await highlightsOf(ctrl, `${env.origin}/article.html`);
    expect(fromWorker.map((h) => h.id).sort()).toEqual(cardio.map((c) => c.id).sort());
  });

  // =============================================================================================
  // 2. Encrypted export
  // =============================================================================================

  test('an encrypted backup shows nothing without its passphrase, refuses a wrong one and restores with the right one', async ({
    env,
  }) => {
    const { ctrl, ds } = await seedSmall(env);
    const before = await snapshotVault(ctrl);
    const page = await openBackupPage(env);

    // Turning encryption on without a matching passphrase and the acknowledgement is not possible.
    const panel = page.getByTestId('backup-export');
    await panel.getByTestId('backup-export-pass-enable').check();
    await expect(page.getByTestId('backup-export-problem')).toContainText('at least 8 characters');
    await expect(panel.getByTestId('backup-export-start')).toHaveAttribute('aria-disabled', 'true');
    await panel.getByTestId('backup-export-pass-enable').uncheck();

    const file = await createBackup(page, { passphrase: PASSPHRASE });
    expect(file.name).toMatch(/^studyvault-backup-\d{8}-\d{6}\.svbackup$/);
    expect(file.ui.protection).toMatch(/Encrypted with your passphrase/);
    expect(file.bytes.subarray(0, 8).toString('latin1')).toBe('SVBKENC1');
    expect(file.ui.sha256).toBe(sha256Of(file.bytes));
    for (const quote of [PHYSIO_ATP, PHYSIO_MEMBRANE, PHYSIO_PUMP]) {
      expect(
        file.bytes.includes(Buffer.from(quote)),
        `"${quote}" is not readable in the file`,
      ).toBe(false);
    }

    await deleteAllData(page);
    const emptied = await snapshotVault(ctrl);
    expect(emptied.highlights).toEqual([]);

    // A wrong passphrase: a specific message, still asking, nothing changed.
    await chooseBackup(page, file);
    const w = wizard(page);
    const ask = w.getByTestId('backup-import-passphrase');
    await expect(ask).toContainText('This backup is encrypted');
    await ask.getByTestId('backup-import-pass').fill('this is not the passphrase');
    await ask.getByTestId('backup-import-unlock').click();
    await expect(ask).toContainText('That passphrase did not open the backup');
    await expect(ask).toContainText(
      'There is no way to open an encrypted backup without its passphrase',
    );
    await expect(ask).toContainText(UNCHANGED);
    expectSameVault(await snapshotVault(ctrl), emptied, 'the vault after a wrong passphrase');
    expect(await metaValue(ctrl, 'lastRestore')).toBeUndefined();

    // The right one: unlocked, checked, merged.
    await ask.getByTestId('backup-import-pass').fill(PASSPHRASE);
    await ask.getByTestId('backup-import-unlock').click();
    await expectReview(page);
    await expect(w.getByTestId('restore-archive-facts')).toContainText('Encrypted (unlocked)');
    await commitRestore(page);
    await expect(w.getByTestId('backup-import-done')).toContainText('Backup merged');
    const after = await snapshotVault(ctrl);
    // merge into a new empty vault: every row of the backup is there (the Inbox row exists in both)
    expectSameVault(without(after, 'banks'), without(before, 'banks'));
    expect(
      rowsOf<{ id: string; name: string }>(after, 'banks')
        .map((b) => b.name)
        .sort(),
    ).toEqual(
      rowsOf<{ id: string; name: string }>(before, 'banks')
        .map((b) => b.name)
        .sort(),
    );
    expect(rowsOf<StoredHighlight>(after, 'highlights').map((h) => h.id)).toEqual(
      expect.arrayContaining([ds.id.hl('a1'), ds.id.hl('a2'), ds.id.hl('b1')]),
    );
  });

  // =============================================================================================
  // 3. Merge keeps local edits and provenance, adds missing rows, makes no duplicates
  // =============================================================================================

  test('merge keeps local edits and capture provenance, adds what is missing and duplicates nothing', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const url = `${env.origin}/article.html`;
    const cardiology = await createBankRpc(ctrl, 'Cardiology');
    const h1 = await captureQuote(ctrl, {
      url,
      title: 'Cardiovascular physiology',
      quote: 'Stroke volume is the volume of blood ejected by one ventricle per beat.',
      bankId: cardiology,
      comment: 'original comment',
      at: 10,
    });
    const h2 = await captureQuote(ctrl, {
      url,
      title: 'Cardiovascular physiology',
      quote: 'Preload is the stretch of the ventricle at the end of diastole.',
      bankId: cardiology,
      at: 200,
    });
    const h3 = await captureQuote(ctrl, {
      url,
      title: 'Cardiovascular physiology',
      quote: 'Afterload is the resistance the ventricle must overcome to eject blood.',
      at: 400,
    });
    const page = await openBackupPage(env);
    const backup = await createBackup(page);
    const archive = readArchive(backup.bytes);
    const original = archive.tables.highlights!.find((h) => h.id === h1.id)!;

    // ---- local changes after the backup ------------------------------------------------------
    await bgData(ctrl, 'highlight.update', {
      id: h1.id,
      patch: { userComment: 'my local edit, made after the backup' },
    });
    await bgData(ctrl, 'highlight.delete', { id: h2.id });
    const dash = await openDashboard(env);
    await dash.getByTestId('view-trash').click();
    await dash.getByTestId('trash-kind').selectOption('highlight');
    await dash.getByTestId('trash-select-all').click();
    await dash.getByTestId('trash-purge').click();
    await dialogOf(dash, /^Permanently delete 1 item/)
      .getByTestId('dialog-confirm')
      .click();
    await expect(dash.getByTestId('trash-outcome')).toContainText(
      'Permanently deleted 1 highlight',
    );
    await dash.close();
    const h4 = await captureQuote(ctrl, {
      url,
      title: 'Cardiovascular physiology',
      quote: 'Compliance describes how easily a chamber stretches under pressure.',
      at: 600,
    });
    const local = await snapshotVault(ctrl);
    const localIds = rowsOf<StoredHighlight>(local, 'highlights').map((h) => h.id);
    expect(localIds).toEqual(expect.arrayContaining([h1.id, h3.id, h4.id]));
    expect(localIds, 'h2 was deleted for good').not.toContain(h2.id);

    // ---- merge the old backup back in, with a safety copy of what is here now -----------------
    await chooseBackup(page, backup);
    await expectReview(page);
    const w = wizard(page);
    await expect(w.getByTestId('restore-add')).toContainText(/[1-9]\d* new items?/);
    await expect(w.getByTestId('restore-summary')).toContainText('already identical');
    await expect(w.getByTestId('restore-summary')).toContainText(
      'will stay as they are because your version is newer',
    );
    await expect(w.getByTestId('restore-summary')).toContainText('merging never deletes anything');
    const safety = await downloadOf(page, () => commitRestore(page, { safety: true }));
    expect(
      readArchive(safety.bytes).tables.highlights?.find((h) => h.id === h1.id)?.userComment,
      'the safety copy holds what the vault had just before the restore',
    ).toBe('my local edit, made after the backup');

    const merged = await snapshotVault(ctrl);
    const rows = rowsOf<StoredHighlight>(merged, 'highlights');
    const row = (id: string) => rows.find((h) => h.id === id);
    // the local edit won over the older copy; capture provenance is what it was
    expect(row(h1.id)).toMatchObject({ userComment: 'my local edit, made after the backup' });
    for (const field of ['exactQuote', 'quoteHash', 'anchorSet', 'capturedAt', 'sourceId']) {
      expect(row(h1.id)?.[field as keyof StoredHighlight], `h1.${field}`).toEqual(original[field]);
    }
    // the deleted row came back, the local-only rows stayed, and nothing was duplicated
    expect(row(h2.id)).toMatchObject({
      exactQuote: 'Preload is the stretch of the ventricle at the end of diastole.',
      deletedAt: null,
    });
    expect(row(h4.id)).toBeDefined();
    expect(rows.filter((h) => h.deletedAt === null)).toHaveLength(4);
    expect(new Set(rows.map((h) => h.quoteHash)).size).toBe(rows.length);
    expect(
      rowsOf<{ highlightId: string; bankId: string }>(merged, 'highlightBanks').filter(
        (m) => m.highlightId === h2.id && m.bankId === cardiology,
      ),
    ).toHaveLength(1);
    expect(rowsOf(merged, 'sources')).toHaveLength(1);

    // ---- a forged archive that rewrites provenance is refused row by row ---------------------
    const forgedHighlight = rewriteTable(
      backup.bytes,
      'highlights',
      (r) =>
        r.id === h3.id
          ? {
              ...r,
              exactQuote: 'FORGED: a quote this page never contained.',
              anchorSet: {
                ...(r.anchorSet as object),
                textQuote: {
                  exact: 'FORGED: a quote this page never contained.',
                  prefix: '',
                  suffix: '',
                },
              },
              userComment: 'forged comment',
              updatedAt: '2099-01-01T00:00:00.000Z',
            }
          : r,
      true,
    );
    const forged = rewriteTable(
      forgedHighlight,
      'sources',
      (r) => ({
        ...r,
        originalUrl: 'https://evil.example/phishing',
        urlKey: 'https://evil.example/phishing',
        updatedAt: '2099-01-01T00:00:00.000Z',
      }),
      true,
    );
    const beforeForged = await snapshotVault(ctrl);
    await chooseAnother(page);
    await chooseBackup(page, { name: 'studyvault-backup-forged.zip', bytes: forged });
    await expectReview(page);
    await expect(w.getByTestId('restore-conflict')).toContainText(
      '2 conflicts: your version is kept',
    );
    await w.getByTestId('restore-conflicts').locator('summary').click();
    await expect(w.getByTestId('restore-conflicts')).toContainText(
      'the saved quote, where it came from, or how it was captured differs',
    );
    await expect(w.getByTestId('restore-conflicts')).toContainText('your copy is kept');
    await commitRestore(page);
    expectSameVault(
      await snapshotVault(ctrl),
      beforeForged,
      'the vault after a merge of a forged archive',
    );
    const afterForged = rowsOf<StoredHighlight>(await snapshotVault(ctrl), 'highlights');
    expect(afterForged.find((h) => h.id === h3.id)?.exactQuote).toBe(
      'Afterload is the resistance the ventricle must overcome to eject blood.',
    );
  });

  // =============================================================================================
  // 4. Corruption
  // =============================================================================================

  test('damaged, truncated, forged and foreign files are refused in plain words and change nothing', async ({
    env,
  }) => {
    const { ctrl } = await seedSmall(env);
    const page = await openBackupPage(env);
    const good = await createBackup(page);
    const baseline = await snapshotVault(ctrl);

    const cases: Array<{ label: string; name: string; bytes: Uint8Array; title: RegExp }> = [
      {
        label: 'cut off half way',
        name: 'studyvault-backup-cut.zip',
        bytes: truncated(good.bytes, 0.5),
        title: /backup file is damaged/,
      },
      {
        label: 'one byte flipped inside a table',
        name: 'studyvault-backup-flipped.zip',
        bytes: flippedTableByte(good.bytes, 'highlights'),
        title: /damaged|modified|unreadable|incomplete/,
      },
      {
        label: 'a quote edited by hand (checksums no longer match)',
        name: 'studyvault-backup-edited.zip',
        bytes: rewriteTable(
          good.bytes,
          'highlights',
          (r) => ({ ...r, exactQuote: 'edited by hand' }),
          false,
        ),
        title: /modified or damaged/,
      },
      {
        label: 'a forged ZIP64 header',
        name: 'studyvault-backup-zip64.zip',
        bytes: forgedZip64(),
        title: /backup file is damaged/,
      },
      {
        label: 'a manifest from a newer StudyVault',
        name: 'studyvault-backup-future.zip',
        bytes: reseal(unpack(good.bytes), (m) => {
          m.formatVersion = 2;
        }),
        title: /made by a newer StudyVault/,
      },
      {
        label: 'a ZIP that is not a backup',
        name: 'photos.zip',
        bytes: pack({ 'readme.md': new TextEncoder().encode('# not a backup') }),
        title: /This is not a StudyVault backup/,
      },
      {
        label: 'a JSON file that is not a backup',
        name: 'settings.json',
        bytes: new TextEncoder().encode('{"hello":"world"}'),
        title: /This is not a StudyVault backup/,
      },
      {
        label: 'a plain text file',
        name: 'diary.txt',
        bytes: new TextEncoder().encode('Dear diary, today I studied the heart.'),
        title: /This is not a StudyVault backup/,
      },
      {
        label: 'an empty file',
        name: 'empty.zip',
        bytes: new Uint8Array(0),
        title: /This is not a StudyVault backup/,
      },
    ];

    for (const c of cases) {
      await test.step(c.label, async () => {
        await chooseBackup(page, { name: c.name, bytes: c.bytes });
        const text = await refusal(page);
        expect.soft(text, `${c.label}: title`).toMatch(c.title);
        expect.soft(text, `${c.label}: says nothing was changed`).toContain(UNCHANGED);
        expectSameVault(await snapshotVault(ctrl), baseline, `the vault after: ${c.label}`);
        expect(await metaValue(ctrl, 'lastRestore'), `${c.label}: no restore marker`).toBe(
          undefined,
        );
        await chooseAnother(page);
      });
    }
  });

  // =============================================================================================
  // 5. Older archives
  // =============================================================================================

  test('a backup written by the exporter of data version 1 is upgraded on restore to exactly the vault it came from', async ({
    env,
  }) => {
    // Banks, sources, highlights and memberships only, no folders: what version 1 could hold.
    const { ctrl } = await seedSmall(env, {
      banks: [{ key: 'cardio', name: 'Cardiology' }],
      sources: smallInput(env).sources,
      highlights: smallInput(env).highlights.map(({ tags: _t, notes: _n, ...h }) => h),
    });
    const original = await snapshotVault(ctrl);
    const v1 = await archiveAsDataVersion1({
      banks: rowsOf(original, 'banks'),
      sources: rowsOf(original, 'sources'),
      highlights: rowsOf(original, 'highlights'),
      highlightBanks: rowsOf(original, 'highlightBanks'),
    });
    expect(
      unzipSync(v1)['tables/sources.ndjson'] &&
        strFromU8(unzipSync(v1)['tables/sources.ndjson']!).includes('"type"'),
      'the archive really lacks the field data version 2 added',
    ).toBe(false);

    const page = await openBackupPage(env);
    await deleteAllData(page);
    await chooseBackup(page, { name: 'studyvault-backup-old.zip', bytes: v1 });
    await expectReview(page);
    const w = wizard(page);
    await expect(w.getByTestId('restore-archive-facts')).toContainText(
      /Upgraded from version 1 to \d+/,
    );
    await expect(w.getByTestId('restore-archive-facts')).toContainText('0.1.0-data-v1-e2e');
    await commitRestore(page);
    await expect(
      w.getByTestId('backup-import-done').getByText('Integrity check passed'),
    ).toBeVisible();
    const after = await snapshotVault(ctrl);
    expectSameVault(without(after, 'banks'), without(original, 'banks'), 'the upgraded vault');
    expect(rowsOf<{ type: string }>(after, 'sources').every((s) => s.type === 'web')).toBe(true);
    expect(
      rowsOf<{ folderId: string | null }>(after, 'highlightBanks').every(
        (m) => m.folderId === null,
      ),
    ).toBe(true);
  });

  test('a file in a different data model is reported item by item and can be left alone', async ({
    env,
  }) => {
    const { ctrl } = await seedSmall(env);
    const baseline = await snapshotVault(ctrl);
    const fixture = frozen('v1-plain.json');
    const bytes = Buffer.from(fixture.base64, 'base64');
    const page = await openBackupPage(env);

    await chooseBackup(page, { name: 'frozen-v1.zip', bytes });
    const text = await refusal(page);
    expect(text).toMatch(/do not match StudyVault.s data model/);
    expect(text).toContain(UNCHANGED);
    const w = wizard(page);
    const lines = w.getByTestId('backup-import-blocked-lines');
    await expect(lines).toContainText('Banks, line 1');
    await expect(lines).toContainText('Highlights, line 1');
    expectSameVault(await snapshotVault(ctrl), baseline, 'the vault while the report is open');

    // "Restore the rest": the report says what would be left out, still nothing is written.
    await w.getByTestId('backup-import-skip').click();
    await expectReview(page);
    const left = Object.values(fixture.counts).reduce((a, b) => a + b, 0);
    await expect(w.getByTestId('restore-invalid-count')).toContainText(
      `${left} items in the file did not match the data model and will be left out.`,
    );
    await w.getByTestId('backup-import-discard').click();
    await expect(w.getByTestId('backup-import-file')).toBeVisible();
    expectSameVault(await snapshotVault(ctrl), baseline, 'the vault after cancelling');

    // The other frozen archives, the newest one encrypted: same plain refusal, same untouched vault.
    for (const name of ['v2-plain.json', 'v3-encrypted.json']) {
      const old = frozen(name);
      await chooseBackup(page, {
        name: name.replace('.json', '.zip'),
        bytes: Buffer.from(old.base64, 'base64'),
      });
      if (old.encrypted) {
        await w.getByTestId('backup-import-pass').fill(old.passphrase ?? '');
        await w.getByTestId('backup-import-unlock').click();
      }
      const again = await refusal(page);
      expect(again, name).toMatch(/do not match StudyVault.s data model/);
      expect(again, name).toContain(UNCHANGED);
      await chooseAnother(page);
      expectSameVault(await snapshotVault(ctrl), baseline, `the vault after ${name}`);
    }
    expect(await metaValue(ctrl, 'lastRestore')).toBeUndefined();
  });

  // =============================================================================================
  // 6. Markdown / CSV import
  // =============================================================================================

  test('Markdown and CSV imports make imported highlights of their own, searchable, never attached to a captured page', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const articleUrl = `${env.origin}/article.html`;
    const real = await captureQuote(ctrl, {
      url: articleUrl,
      title: 'Cardiovascular physiology',
      quote: CARDIO_QUOTE,
      at: 10,
    });
    const realSource = (await readTable<StoredHighlight>(ctrl, 'highlights')).find(
      (h) => h.id === real.id,
    )!.sourceId;

    const markdown = [
      '# Lecture notes',
      '',
      '> The Frank-Starling mechanism states that stroke volume rises with end-diastolic volume.',
      '',
      `— [Lecture 4 slides](${articleUrl}) · captured 2026-02-01 · essential`,
      '',
      '#physiology #e2e-import',
      '',
      '**Comment:** Check this against the textbook.',
      '',
      '> Poiseuille law relates flow to the fourth power of the vessel radius.',
      '',
      '— [Course wiki](https://example.org/wiki/poiseuille) · captured 2026-02-02',
      '',
      `> ${CARDIO_QUOTE}`,
      '',
      `— [Same page](${articleUrl})`,
      '',
    ].join('\n');
    const csv = [
      'quote,comment,source_url,tags',
      '"The Nernst equation gives the equilibrium potential of one ion.",E2E csv note,' +
        `${articleUrl},"ions; membrane"`,
      '"Poiseuille law relates flow to the fourth power of the vessel radius.",same as the markdown one,,',
      '',
    ].join('\n');

    const page = await openBackupPage(env);
    const ext = page.getByTestId('backup-external');

    await ext.getByTestId('backup-external-file').setInputFiles({
      name: 'lecture-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(markdown),
    });
    await expect(ext.getByTestId('backup-external-stats')).toContainText(
      /lecture-notes\.md read as Markdown: 3 records, 2 can be imported, 1 duplicate skipped, 0 rejected/,
    );
    await expect(ext.getByTestId('backup-external-rows')).toContainText('Frank-Starling');
    // nothing is written until the list is confirmed
    expect(await readTable(ctrl, 'highlights')).toHaveLength(1);
    await ext.getByTestId('backup-external-commit').click();
    await expect(ext.getByTestId('backup-external-result')).toContainText('2 highlights added');
    await expect(ext.getByTestId('backup-needs-review')).toContainText(
      'Imported, needs review (2)',
    );

    await ext.getByTestId('backup-external-file').setInputFiles({
      name: 'concepts.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await expect(ext.getByTestId('backup-external-stats')).toContainText(
      /concepts\.csv read as CSV: 2 records, 1 can be imported, 1 duplicate skipped, 0 rejected/,
    );
    await ext.getByTestId('backup-external-commit').click();
    await expect(ext.getByTestId('backup-external-result')).toContainText('1 highlight added');
    await expect(ext.getByTestId('backup-needs-review')).toContainText(
      'Imported, needs review (3)',
    );

    const rows = await readTable<StoredHighlight>(ctrl, 'highlights');
    const sources = await readTable<{
      id: string;
      urlKey: string;
      originalUrl: string;
      type: string;
    }>(ctrl, 'sources');
    const imported = rows.filter((h) => h.id !== real.id) as Array<
      StoredHighlight & { captureMethod: string }
    >;
    expect(imported).toHaveLength(3);
    for (const h of imported) {
      expect(h.captureMethod, `${h.exactQuote}: how it came to be`).toBe('import');
      expect(h.customFields).toMatchObject({ needsReview: true });
      expect(h.sourceId, 'never the Source a capture made').not.toBe(realSource);
      const source = sources.find((s) => s.id === h.sourceId)!;
      expect(source.urlKey, 'a key no page can ever match').toMatch(/^imported:/);
      expect(source.type).toBe('web');
    }
    // The file's address is shown as the claim it is.
    const claimed = imported.find((h) => h.exactQuote.startsWith('The Frank-Starling'))!;
    expect(sources.find((s) => s.id === claimed.sourceId)?.originalUrl).toBe(articleUrl);
    // The real page still has exactly its own capture.
    expect((await highlightsOf(ctrl, articleUrl)).map((h) => h.id)).toEqual([real.id]);

    // Searchable in the library.
    const dash = await openDashboard(env, { q: 'Poiseuille' });
    const poiseuille = imported.find((h) => h.exactQuote.startsWith('Poiseuille'))!;
    await expectList(dash, [poiseuille.id]);
    await dash.close();

    // Mark reviewed clears the marker and leaves the quote alone.
    await page.getByTestId(`backup-review-${poiseuille.id}`).click();
    await expect(page.getByTestId('backup-needs-review')).toContainText(
      'Imported, needs review (2)',
    );
    const reviewed = (await readTable<StoredHighlight>(ctrl, 'highlights')).find(
      (h) => h.id === poiseuille.id,
    )!;
    expect(reviewed.customFields?.needsReview).toBeUndefined();
    expect(reviewed.exactQuote).toBe(poiseuille.exactQuote);
  });

  // =============================================================================================
  // 7. Readable exports; no AI key in anything
  // =============================================================================================

  test('Markdown, CSV and Anki exports carry the quotes and leave out the trash, and no backup holds the AI key', async ({
    env,
  }) => {
    const { ctrl, ds } = await seedSmall(env);
    const review = await openReview(env);
    await createBasicCards(review, [
      ['What does the sodium potassium pump move?', 'Three sodium out, two potassium in.'],
    ]);
    await review.close();

    const page = await openBackupPage(env);
    const readable = page.getByTestId('backup-readable');
    const prepare = async () => {
      await readable.getByTestId('readable-prepare').click();
      await expect(readable.getByTestId('readable-result')).toBeVisible();
    };
    const download = () =>
      downloadOf(page, () => readable.getByTestId('readable-download').click());
    const live = [PHYSIO_ATP, PHYSIO_MEMBRANE, PHYSIO_PUMP];

    // Markdown, one combined file
    await readable.getByTestId('readable-layout-single').check();
    await prepare();
    await expect(readable.getByTestId('readable-summary')).toContainText('3 highlights in 1 file.');
    const single = await download();
    expect(single.name).toMatch(/\.md$/);
    const singleText = single.bytes.toString('utf8');
    for (const quote of live) expect(singleText).toContain(quote);
    expect(singleText, 'the trash is not exported').not.toContain(TRASHED);
    expect(singleText).toContain('Remember the proton gradient.');

    // Markdown, one file per bank, zipped
    await readable.getByTestId('readable-layout-per-bank').check();
    await prepare();
    await expect(readable.getByTestId('readable-files')).toContainText('.md');
    const zipped = await download();
    expect(zipped.name).toMatch(/^studyvault-markdown-\d{8}-\d{6}\.zip$/);
    const members = unzipSync(zipped.bytes);
    expect(Object.keys(members).sort().length).toBeGreaterThanOrEqual(2);
    const memberText = Object.values(members)
      .map((u) => strFromU8(u))
      .join('\n');
    for (const quote of live) expect(memberText).toContain(quote);
    expect(memberText).not.toContain(TRASHED);

    // Markdown for one chosen bank only
    await readable.getByTestId('readable-scope-banks').check();
    await readable.getByTestId(`readable-bank-${ds.id.bank('cardio')}`).check();
    await readable.getByTestId('readable-layout-single').check();
    await prepare();
    await expect(readable.getByTestId('readable-summary')).toContainText('2 highlights in 1 file.');
    const cardioOnly = (await download()).bytes.toString('utf8');
    expect(cardioOnly).toContain(PHYSIO_ATP);
    expect(cardioOnly).toContain(PHYSIO_PUMP);
    expect(cardioOnly).not.toContain(PHYSIO_MEMBRANE);
    await readable.getByTestId('readable-scope-all').check();

    // CSV, with the byte order mark for spreadsheets
    await readable.getByTestId('readable-format-csv').check();
    await readable.getByTestId('readable-bom').check();
    await prepare();
    const csv = await download();
    expect(csv.name).toMatch(/^studyvault-highlights-\d{8}-\d{6}\.csv$/);
    expect([...csv.bytes.subarray(0, 3)], 'UTF-8 byte order mark').toEqual([0xef, 0xbb, 0xbf]);
    const csvText = csv.bytes.toString('utf8');
    expect(csvText.split('\n')[0]).toContain('quote');
    for (const quote of live) expect(csvText).toContain(quote);
    expect(csvText).not.toContain(TRASHED);

    // Anki: the field mapping is shown before the download
    await readable.getByTestId('readable-format-anki').check();
    await prepare();
    await expect(readable.getByTestId('readable-anki-mapping')).toContainText('Becomes in Anki');
    await expect(readable.getByTestId('readable-summary')).toContainText(
      '1 flashcard note will be exported.',
    );
    const anki = await download();
    expect(anki.bytes.toString('utf8')).toContain('What does the sodium potassium pump move?');

    // The AI key is set through the real settings, then no backup carries it.
    const KEY = 'sk-e2e-canary-0123456789abcdef';
    // The switch follows the stored setting (a worker round trip): click, then wait for it.
    await page.getByTestId('ai-enable').click();
    await expect(page.getByTestId('ai-enable')).toBeChecked();
    await page.getByRole('button', { name: 'Use OpenAI' }).click();
    await page.getByTestId('ai-save-settings').click();
    await page.getByTestId('ai-key-input').fill(KEY);
    await page.getByTestId('ai-key-save').click();
    await expect(page.getByTestId('ai-key-mask')).toBeVisible();
    expect(
      await metaValue(ctrl, 'aiKey'),
      'the key is stored (in meta, outside backups)',
    ).toMatchObject({ apiKey: KEY });

    const full = await createBackup(page);
    const archive = readArchive(full.bytes);
    expect(archive.everything).not.toContain(KEY);
    expect(archive.everything).not.toContain('apiKey');
    expect(archive.manifest.tables.map((t) => t.name)).not.toContain('meta');
    const encrypted = await createBackup(page, { passphrase: PASSPHRASE });
    expect(encrypted.bytes.includes(Buffer.from(KEY))).toBe(false);

    // A restore changes only what a backup holds: the key and the AI switch stay.
    await page.getByTestId('backup-export-done').getByRole('button', { name: 'Done' }).click();
    await chooseBackup(page, full);
    await commitRestore(page, { mode: 'replace', safety: false });
    expect(await metaValue(ctrl, 'aiKey')).toMatchObject({ apiKey: KEY });
    expect(((await storedSettings(page))?.features as { ai?: boolean }).ai).toBe(true);
  });

  // =============================================================================================
  // 8. Offline and restart
  // =============================================================================================

  test('restore works offline with nothing sent anywhere, and the restored data survives a browser restart', async ({
    fixtureServer,
  }) => {
    test.setTimeout(420_000);
    const dir = newUserDataDir();
    let session: Session | null = null;
    const envOf = (s: Session): Env => ({
      context: s.context,
      extensionId: s.extensionId,
      serviceWorker: s.context.serviceWorkers()[0]!,
      origin: fixtureServer.origin,
      altOrigin: fixtureServer.altOrigin,
    });
    try {
      session = await launchSession(dir);
      const env = envOf(session);
      const { ctrl } = await seedSmall(env);
      const before = await snapshotVault(ctrl);
      const page = await openBackupPage(env);
      const file = await createBackup(page, { passphrase: PASSPHRASE });
      await deleteAllData(page);
      expect((await snapshotVault(ctrl)).highlights).toEqual([]);

      await session.context.setOffline(true);
      const traffic = recordRequests(session.context);
      await chooseBackup(page, file);
      await page.getByTestId('backup-import-pass').fill(PASSPHRASE);
      await page.getByTestId('backup-import-unlock').click();
      await commitRestore(page, { mode: 'replace', safety: false });
      traffic.stop();
      expect(
        noExternalRequests(traffic.urls, fixtureServer.origin),
        'a restore sends nothing anywhere',
      ).toEqual([]);
      const restored = await snapshotVault(ctrl);
      expectSameVault(restored, before, 'the vault restored while offline');
      await session.context.setOffline(false);

      // ---- a new browser process on the same profile -----------------------------------------
      await session.context.close();
      session = null;
      let second: Session | null = null;
      for (let attempt = 0; attempt < 6 && !second; attempt++) {
        try {
          second = await launchSession(dir);
        } catch {
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
      if (!second) throw new Error('the profile could not be reopened');
      session = second;
      const env2 = envOf(second);
      const ctrl2 = await openExtensionPage(second.context, second.extensionId);
      expectSameVault(await snapshotVault(ctrl2), before, 'the vault after a browser restart');
      expect(await metaValue(ctrl2, 'lastRestore')).toMatchObject({ mode: 'replace' });
      const dash = await openDashboard(env2);
      await expectTotal(dash, 3);
    } finally {
      await session?.context.close().catch(() => undefined);
      removeDir(dir);
    }
  });

  // =============================================================================================
  // 9. Accessibility
  // =============================================================================================

  test('the backup section, every step of the restore wizard and the delete confirmation pass axe (WCAG 2.2 AA)', async ({
    env,
  }) => {
    const { ctrl } = await seedSmall(env);
    const page = await openBackupPage(env);
    const section = '[data-testid="backup-section"]';
    const checkAxe = async (state: string, include: string | undefined = section) => {
      expect.soft(await axeViolations(page, include), `axe violations: ${state}`).toBe('');
    };
    const w = wizard(page);

    await checkAxe('backup section at rest');

    // export: passphrase fields open, then the finished export with its facts and counts
    await page.getByTestId('backup-export-pass-enable').check();
    await checkAxe('export with the passphrase fields open');
    await page.getByTestId('backup-export-pass-enable').uncheck();
    const plain = await createBackup(page);
    await checkAxe('export finished');
    await page.getByTestId('backup-export-done').getByRole('button', { name: 'Done' }).click();
    const encrypted = await createBackup(page, { passphrase: PASSPHRASE });

    // restore: encrypted file -> passphrase -> wrong passphrase -> review (merge, replace) -> done
    await chooseBackup(page, encrypted);
    await expect(w.getByTestId('backup-import-passphrase')).toBeVisible();
    await checkAxe('restore: asking for the passphrase');
    await w.getByTestId('backup-import-pass').fill('wrong wrong wrong');
    await w.getByTestId('backup-import-unlock').click();
    await expect(w.getByTestId('backup-import-passphrase')).toContainText(
      'That passphrase did not open the backup',
    );
    await checkAxe('restore: wrong passphrase');
    await w.getByTestId('backup-import-pass').fill(PASSPHRASE);
    await w.getByTestId('backup-import-unlock').click();
    await expectReview(page);
    await checkAxe('restore: review, merge');
    await selectReplace(page);
    await setPassphrase(w, 'backup-import-safety-pass', PASSPHRASE);
    await checkAxe('restore: review, replace with confirmation and safety passphrase');
    await w.getByTestId('backup-import-discard').click();

    await chooseBackup(page, plain);
    await commitRestore(page);
    await checkAxe('restore: finished');
    await w.getByTestId('backup-import-again').click();

    // refusals: a file in another data model (blocked, with a list) and a plain text file
    const foreign = frozen('v1-plain.json');
    await chooseBackup(page, {
      name: 'frozen-v1.zip',
      bytes: Buffer.from(foreign.base64, 'base64'),
    });
    await refusal(page);
    await checkAxe('restore: items that need a decision');
    await chooseAnother(page);
    await chooseBackup(page, { name: 'diary.txt', bytes: Buffer.from('not a backup') });
    await refusal(page);
    await checkAxe('restore: refused file');
    await chooseAnother(page);

    // readable exports and external import
    const readable = page.getByTestId('backup-readable');
    await readable.getByTestId('readable-format-anki').check();
    await readable.getByTestId('readable-prepare').click();
    await expect(readable.getByTestId('readable-result')).toBeVisible();
    await checkAxe('readable export: Anki preview');
    await readable.getByTestId('readable-scope-banks').check();
    await expect(readable.getByTestId('readable-banks')).toBeVisible();
    await checkAxe('readable export: choosing banks');

    const ext = page.getByTestId('backup-external');
    await ext.getByTestId('backup-external-file').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        '# Notes\n\n> A fact that came from another program.\n\n— [Wiki](https://example.org/a)\n',
      ),
    });
    await expect(ext.getByTestId('backup-external-review')).toBeVisible();
    await checkAxe('import from Markdown: list to confirm');
    await ext.getByTestId('backup-external-commit').click();
    await expect(ext.getByTestId('backup-needs-review')).toBeVisible();
    await checkAxe('import from Markdown: imported, needs review');

    // the destructive confirmation (the whole page: the dialog is modal)
    await openWipeDialog(page);
    await expect(wipeDialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect.soft(await axeViolations(page), 'axe violations: Delete all data dialog').toBe('');
    await page.keyboard.press('Escape');
    await expect(wipeDialog(page)).toHaveCount(0);
    expect(
      ((await snapshotVault(ctrl)).highlights ?? []).length,
      'cancelling the dialog deleted nothing',
    ).toBeGreaterThan(0);
  });
});
