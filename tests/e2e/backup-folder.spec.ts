import type { Locator, Page } from '@playwright/test';
import {
  chooseBackup,
  commitRestore,
  createBackup,
  deleteAllData,
  expectReview,
  expectSameVault,
  metaValue,
  openBackupPage,
  pageProblems,
  readArchive,
  setPassphrase,
  sha256Of,
  snapshotVault,
  wizard,
  writeDatasetKeepingInbox,
} from './helpers.backup';
import {
  FOLDER,
  folderNames,
  makeDiskFull,
  putFolderDirectory,
  putFolderFile,
  readFolderFile,
  removeFolder,
  setFolderPermission,
  storedHandle,
  stubFolderPicker,
  withoutFolderPicker,
} from './helpers.backupFolder';
import {
  DAY_MS,
  axeViolations,
  buildDataset,
  ensureVault,
  openControl,
  openDashboard,
  rawPut,
  type DatasetInput,
} from './helpers.dashboard';
import { test, type Env } from './helpers.pages';
import { expect } from './helpers.review';

test.describe.configure({ timeout: 240_000 });

/**
 * Backups into a folder the person picked (ADR-016), in the real built extension.
 *
 * Playwright cannot drive Chrome's native folder picker, so `window.showDirectoryPicker` is replaced
 * by a function that returns a directory of the extension origin's private file system (OPFS); see
 * helpers.backupFolder.ts. Everything after that is the shipped code on a real
 * FileSystemDirectoryHandle: it is stored in IndexedDB, read back from there, written with
 * createWritable, read back, listed and pruned with removeEntry.
 *
 * Not covered, and why:
 *  - Chrome's own permission prompt for a folder on a real disk (no automation can answer it): the
 *    answers it gives are replaced on the handle prototype (`setFolderPermission`);
 *  - a drive that is unplugged or really full: a deleted directory and a write that fails with the
 *    DOMException Chrome throws stand in for them;
 *  - a background write: there is none to test (the feature has no alarm, no worker path; the
 *    reminder test shows that nothing is written until the button is pressed).
 */

const PASSPHRASE = 'correct horse battery staple';
const QUOTES = [
  'Mitochondria produce ATP through oxidative phosphorylation in the inner membrane.',
  'The cell membrane is a selectively permeable phospholipid bilayer.',
];

const vaultInput = (env: Env): DatasetInput => ({
  banks: [{ key: 'physio', name: 'Physiology' }],
  tags: [{ key: 'exam', name: 'exam' }],
  sources: [{ key: 'a', url: `${env.origin}/dash-source-a.html`, title: 'Cell biology notes' }],
  highlights: [
    {
      key: 'atp',
      quote: QUOTES[0] as string,
      source: 'a',
      places: [{ bank: 'physio' }],
      tags: ['exam'],
      comment: 'Four complexes.',
    },
    { key: 'mem', quote: QUOTES[1] as string, source: 'a', priority: 4 },
  ],
});

async function seed(env: Env): Promise<Page> {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  await writeDatasetKeepingInbox(ctrl, buildDataset(vaultInput(env)));
  return ctrl;
}

const folderPanel = (page: Page): Locator => page.getByTestId('backup-folder');

async function chooseFolder(page: Page): Promise<void> {
  await stubFolderPicker(page);
  await folderPanel(page).getByTestId('backup-folder-choose').click();
  await expect(folderPanel(page).getByTestId('backup-folder-name')).toHaveText(FOLDER);
}

/** Press "Back up now", wait for the result and return the file name it reports. */
async function backUpNow(page: Page): Promise<string> {
  const panel = folderPanel(page);
  await panel.getByTestId('backup-folder-now').click();
  // a previous result stays on screen until this run replaces it: wait for the busy state to end
  await expect(panel.getByTestId('backup-folder-progress')).toHaveCount(0);
  const done = panel.getByTestId('backup-folder-done-file');
  await expect(done).toBeVisible();
  const text = ((await done.textContent()) ?? '').trim();
  return text.split(',')[0] as string;
}

const OWN = /^studyvault-\d{8}-\d{6}(-\d+)?\.(zip|svbackup)$/;

test.describe('backup folder', () => {
  test('dated backups go into the chosen folder, are checked, restore through the wizard, and Delete all data forgets the folder', async ({
    env,
  }) => {
    const ctrl = await seed(env);
    const before = await snapshotVault(ctrl);
    const page = await openBackupPage(env);
    const panel = folderPanel(page);

    // ---- before a folder is chosen: what it is, said first; nothing asked ----------------------
    await expect(panel.getByTestId('backup-folder-choose')).toBeVisible();
    const note = panel.getByTestId('backup-folder-permission-note');
    await expect(note).toContainText('You give that permission for that one folder');
    await expect(note).toContainText('take it back at any time in Chrome’s site settings');
    await expect(note).toContainText('adds no extension permission');
    await expect(note).toContainText('cannot make backups on its own in the background');
    expect
      .soft(await axeViolations(page, '[data-testid="backup-folder"]'), 'axe: no folder')
      .toBe('');

    // ---- choose -------------------------------------------------------------------------------
    await chooseFolder(page);
    await expect(panel.getByTestId('backup-folder-last')).toHaveText('None yet to this folder');
    await expect(panel.getByTestId('backup-folder-now')).toHaveText(`Back up now to “${FOLDER}”`);
    await expect(panel.getByTestId('backup-folder-now')).toBeFocused();
    expect(await storedHandle(page), 'the directory handle is in the vault database').toEqual({
      kind: 'directory',
      name: FOLDER,
      isHandle: true,
    });
    expect(await folderNames(page), 'choosing a folder writes nothing into it').toEqual([]);
    expect.soft(await axeViolations(page, '[data-testid="backup-folder"]'), 'axe: chosen').toBe('');

    // ---- back up now --------------------------------------------------------------------------
    const file = await backUpNow(page);
    expect(file).toMatch(/^studyvault-\d{8}-\d{6}\.zip$/);
    expect(await folderNames(page)).toEqual([file]);
    const bytes = await readFolderFile(page, file);
    expect([...bytes.subarray(0, 4)], 'ZIP signature').toEqual([0x50, 0x4b, 0x03, 0x04]);
    const archive = readArchive(bytes);
    expect(archive.manifest).toMatchObject({
      format: 'studyvault-backup',
      origin: 'backup-folder',
      options: { encrypted: false },
    });
    for (const t of archive.manifest.tables) {
      expect(archive.tables[t.name], `rows of ${t.name} in the file`).toHaveLength(t.rowCount);
    }
    expect(archive.manifest.tables.map((t) => t.name)).not.toContain('meta');
    expect(archive.everything, 'the folder setting is in no backup').not.toContain('backupFolder');
    for (const quote of QUOTES) expect(archive.everything).toContain(quote);

    const done = panel.getByTestId('backup-folder-done');
    await expect(done).toContainText('read the file back from the folder and it matches');
    await expect(panel.getByTestId('backup-folder-sha')).toHaveText(sha256Of(bytes));
    await expect(panel.getByTestId('backup-folder-last-file')).toContainText(file);
    await expect(panel.getByTestId('backup-folder-last-file')).toContainText('not encrypted');
    await expect(panel.getByTestId('backup-folder-last')).toContainText('(today)');
    expect.soft(await axeViolations(page, '[data-testid="backup-folder"]'), 'axe: done').toBe('');
    expectSameVault(await snapshotVault(ctrl), before, 'the vault after a folder backup');
    expect(await metaValue(page, 'backupFolder.state')).toMatchObject({
      folderName: FOLDER,
      keepLast: 5,
      last: { fileName: file, bytes: bytes.length, sha256: sha256Of(bytes), encrypted: false },
    });

    // ---- the status survives a reload ----------------------------------------------------------
    await page.reload();
    await expect(panel.getByTestId('backup-folder-last-file')).toContainText(file);
    await expect(panel.getByTestId('backup-folder-name')).toHaveText(FOLDER);

    // ---- Delete all data: the handle and the status go; the folder is not StudyVault's to empty -
    await deleteAllData(page);
    await expect(
      panel.getByTestId('backup-folder-choose'),
      'the panel follows the deletion without a reload',
    ).toBeVisible();
    expect(await storedHandle(page)).toBeNull();
    expect(await metaValue(page, 'backupFolder.state')).toBeUndefined();
    expect(await folderNames(page), 'the files in the folder are untouched').toEqual([file]);

    // ---- restore from the file in the folder with the ordinary wizard --------------------------
    await chooseBackup(page, { name: file, bytes: await readFolderFile(page, file) });
    await expectReview(page);
    await expect(wizard(page).getByTestId('restore-archive-facts')).toContainText('Not encrypted');
    await commitRestore(page, { mode: 'replace', safety: false });
    expectSameVault(await snapshotVault(ctrl), before, 'the vault restored from the folder file');
    expect(await storedHandle(page), 'a restore does not bring the folder back').toBeNull();
    expect(pageProblems(page), 'no exception or console error on the Options page').toEqual([]);
  });

  test('keeps the newest N of its own backups and never deletes any other file', async ({
    env,
  }) => {
    await seed(env);
    const page = await openBackupPage(env);
    const panel = folderPanel(page);

    // What must survive: a manual export, a file with the right name but no marker, a file with the
    // right name that is not a ZIP, a note, and a sub-folder named like a backup.
    const manual = await createBackup(page);
    await stubFolderPicker(page);
    await putFolderFile(page, manual.name, manual.bytes);
    await putFolderFile(page, 'studyvault-20200101-000000.zip', manual.bytes);
    await putFolderFile(page, 'studyvault-20200102-000000.zip', 'this is not a zip file');
    await putFolderFile(page, 'notes.txt', 'my study plan');
    await putFolderDirectory(page, 'studyvault-20190101-000000.zip');
    const foreign = await folderNames(page);
    expect(foreign).toHaveLength(5);

    await panel.getByTestId('backup-folder-choose').click();
    await expect(panel.getByTestId('backup-folder-name')).toHaveText(FOLDER);
    await panel.getByTestId('backup-folder-keep').selectOption('2');
    await expect
      .poll(
        async () =>
          ((await metaValue(page, 'backupFolder.state')) as { keepLast: number }).keepLast,
      )
      .toBe(2);

    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push(await backUpNow(page));
    expect(new Set(made).size, 'three different files').toBe(3);
    for (const name of made) expect(name).toMatch(OWN);

    await expect(panel.getByTestId('backup-folder-pruned')).toContainText(
      'Removed 1 older backup that StudyVault made, keeping the newest 2.',
    );
    expect(await folderNames(page)).toEqual([...foreign, ...made.slice(1)].sort());
    expect(await readFolderFile(page, manual.name)).toEqual(manual.bytes);
    expect(await readFolderFile(page, 'notes.txt')).toEqual(Buffer.from('my study plan'));
    expect(
      (await metaValue(page, 'backupFolder.state')) as { last: { pruned: number } },
    ).toMatchObject({ last: { pruned: 1 } });
    expect(pageProblems(page), 'no exception or console error on the Options page').toEqual([]);
  });

  test('an encrypted backup in the folder is a .svbackup that shows nothing, prunes plain ones, and restores with its passphrase', async ({
    env,
  }) => {
    const ctrl = await seed(env);
    const before = await snapshotVault(ctrl);
    const page = await openBackupPage(env);
    const panel = folderPanel(page);
    await chooseFolder(page);

    const plain = await backUpNow(page);
    expect(plain).toMatch(/\.zip$/);

    // Encryption needs a confirmed passphrase and the acknowledgement; keep 1 so the plain one goes.
    await panel.getByTestId('backup-folder-keep').selectOption('1');
    await panel.getByTestId('backup-folder-pass-enable').check();
    await expect(panel.getByTestId('backup-folder-now')).toHaveAttribute('aria-disabled', 'true');
    await expect(panel.getByTestId('backup-folder-problem')).toContainText('at least 8 characters');
    await setPassphrase(panel, 'backup-folder-pass', PASSPHRASE);
    const file = await backUpNow(page);
    expect(file).toMatch(/^studyvault-\d{8}-\d{6}(-\d+)?\.svbackup$/);

    const bytes = await readFolderFile(page, file);
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('SVBKENC1');
    expect(bytes.toString('latin1'), 'the marker is readable without the passphrase').toContain(
      '"origin":"backup-folder"',
    );
    for (const quote of QUOTES) expect(bytes.includes(Buffer.from(quote))).toBe(false);
    await expect(panel.getByTestId('backup-folder-done-file')).toContainText(
      'encrypted with your passphrase',
    );
    expect(await folderNames(page), 'the plain backup was pruned by the encrypted one').toEqual([
      file,
    ]);

    // Restore: wrong passphrase refused, right one restores exactly the vault.
    await deleteAllData(page);
    await chooseBackup(page, { name: file, bytes });
    const ask = wizard(page).getByTestId('backup-import-passphrase');
    await ask.getByTestId('backup-import-pass').fill('this is not the passphrase');
    await ask.getByTestId('backup-import-unlock').click();
    await expect(ask).toContainText('That passphrase did not open the backup');
    await ask.getByTestId('backup-import-pass').fill(PASSPHRASE);
    await ask.getByTestId('backup-import-unlock').click();
    await expectReview(page);
    await commitRestore(page, { mode: 'replace', safety: false });
    expectSameVault(
      await snapshotVault(ctrl),
      before,
      'the vault restored from the encrypted file',
    );
  });

  test('a lapsed permission, a full drive and a removed folder are each explained, change nothing, and can be retried', async ({
    env,
  }) => {
    const ctrl = await seed(env);
    const before = await snapshotVault(ctrl);
    const page = await openBackupPage(env);
    const panel = folderPanel(page);
    const failed = panel.getByTestId('backup-folder-failed');
    await chooseFolder(page);

    // ---- permission: Chrome asks again, the person says no, then yes ---------------------------
    await setFolderPermission(page, 'prompt', 'denied');
    await panel.getByTestId('backup-folder-now').click();
    await expect(failed).toContainText('StudyVault is not allowed to write to the backup folder');
    await expect(failed).toContainText('Your StudyVault data was not changed.');
    expect(await folderNames(page)).toEqual([]);
    expect.soft(await axeViolations(page, '[data-testid="backup-folder"]'), 'axe: failed').toBe('');

    await setFolderPermission(page, 'prompt', 'granted');
    await failed.getByRole('button', { name: 'Allow and try again' }).click();
    await expect(panel.getByTestId('backup-folder-done')).toBeVisible();
    await expect(failed).toHaveCount(0);
    const first = (await folderNames(page))[0] as string;
    expect(first).toMatch(OWN);

    // ---- a full drive: nothing left behind, older backups kept, the old status still shown -----
    await makeDiskFull(page);
    await panel.getByTestId('backup-folder-now').click();
    await expect(failed).toContainText('There is not enough free space for the backup');
    await expect(failed).toContainText('older backups there were not removed');
    expect(await folderNames(page), 'no empty or partial file, nothing pruned').toEqual([first]);
    await expect(panel.getByTestId('backup-folder-last-file')).toContainText(first);

    // the person frees space: a reload drops the patched write, the same button works
    await page.reload();
    const second = await backUpNow(page);
    expect(await folderNames(page)).toEqual([first, second].sort());

    // ---- the folder is gone: said plainly, and choosing another one is one button ---------------
    await removeFolder(page);
    await panel.getByTestId('backup-folder-now').click();
    await expect(failed).toContainText('The backup folder cannot be found');
    await stubFolderPicker(page);
    await failed.getByRole('button', { name: 'Choose a folder…' }).click();
    await expect(failed).toHaveCount(0);
    const third = await backUpNow(page);
    expect(await folderNames(page)).toEqual([third]);

    expectSameVault(await snapshotVault(ctrl), before, 'the vault after every failure');
  });

  test('the reminder shows on settings and the dashboard once the last backup is older than the interval, and writes nothing by itself', async ({
    env,
  }) => {
    const ctrl = await seed(env);
    const page = await openBackupPage(env);
    const panel = folderPanel(page);
    await chooseFolder(page);

    // A 3-day interval, and a folder that was chosen ten days ago without a backup.
    await panel.getByTestId('backup-folder-remind').selectOption('3');
    await expect
      .poll(
        async () =>
          ((await metaValue(page, 'backupFolder.state')) as { remindAfterDays: number })
            .remindAfterDays,
      )
      .toBe(3);
    const state = (await metaValue(page, 'backupFolder.state')) as Record<string, unknown>;
    await rawPut(ctrl, {
      meta: [
        {
          key: 'backupFolder.state',
          value: { ...state, chosenAt: new Date(Date.now() - 10 * DAY_MS - 60_000).toISOString() },
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    await page.reload();
    const reminder = page.getByTestId('backup-reminder');
    await expect(reminder).toContainText(
      `No backup has been made to “${FOLDER}” yet; you chose it 10 days ago.`,
    );
    await expect(reminder).toContainText('cannot back up by itself in the background');
    expect
      .soft(await axeViolations(page, '[data-testid="backup-reminder"]'), 'axe: reminder')
      .toBe('');
    // The same notice on the dashboard.
    const dash = await openDashboard(env);
    await expect(dash.getByTestId('backup-reminder')).toBeVisible();
    expect
      .soft(await axeViolations(dash, '[data-testid="backup-reminder"]'), 'axe: dashboard')
      .toBe('');

    // Nothing was written while the reminder was showing; it is the button that writes.
    expect(await folderNames(page)).toEqual([]);

    // The reminder's own button takes the person to the button that does it.
    await reminder.getByTestId('backup-reminder-go').click();
    await expect(panel.getByTestId('backup-folder-now')).toBeFocused();

    const file = await backUpNow(page);
    await expect(page.getByTestId('backup-reminder')).toHaveCount(0);
    await expect(panel.getByTestId('backup-folder-last-file')).toContainText(file);

    // The dashboard follows (it re-reads on focus and on a data change).
    await dash.reload();
    await expect(dash.getByTestId('dashboard')).toBeVisible();
    await expect(dash.getByTestId('backup-reminder')).toHaveCount(0);

    // A reminder turned off stays quiet however old the backup is.
    await panel.getByTestId('backup-folder-remind').selectOption('0');
    await expect
      .poll(
        async () =>
          ((await metaValue(page, 'backupFolder.state')) as { remindAfterDays: number })
            .remindAfterDays,
      )
      .toBe(0);
    await page.reload();
    await expect(panel.getByTestId('backup-folder-name')).toHaveText(FOLDER);
    await expect(page.getByTestId('backup-reminder')).toHaveCount(0);
  });

  test('a browser without the folder picker says so and keeps the ordinary download working', async ({
    env,
  }) => {
    await seed(env);
    const page = await env.context.newPage();
    await withoutFolderPicker(page);
    await page.goto(`chrome-extension://${env.extensionId}/options.html#backup`);
    await expect(page.getByTestId('backup-section')).toBeVisible();

    const note = page.getByTestId('backup-folder-unsupported');
    await expect(note).toContainText('does not give extensions a folder picker');
    await expect(note).toContainText('Create backup file');
    await expect(page.getByTestId('backup-folder-choose')).toHaveCount(0);
    await expect(page.getByTestId('backup-folder-now')).toHaveCount(0);
    expect
      .soft(await axeViolations(page, '[data-testid="backup-folder"]'), 'axe: unsupported')
      .toBe('');

    const file = await createBackup(page);
    expect(file.name).toMatch(/^studyvault-backup-\d{8}-\d{6}\.zip$/);
    expect([...file.bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(
      readArchive(file.bytes).manifest,
      'a manual export carries no folder marker',
    ).not.toHaveProperty('origin');
  });
});
