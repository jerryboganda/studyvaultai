import 'fake-indexeddb/auto';
import { createHash, webcrypto } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { BACKUP_ERROR_CODES, BackupError, exportBackup, type Row } from '@backup';
import { StudyVaultError, defaultSettings } from '@shared';
import { backupTableRegistry, getDb, resetDbForTests, type PreMigrationInfo } from '@storage';
import { createBackupDeps, type BackupDeps, type DownloadFile } from './deps';
import { ExportPanel } from './ExportPanel';
import { ExternalImport } from './ExternalImport';
import { ImportWizard } from './ImportWizard';
import { ReadableExports } from './ReadableExports';
import { SafetyCopy } from './SafetyCopy';
import { SYNC_RESTORE_NOTE, explainBackupError } from './explain';
import { passphraseStrength } from './format';
import { BackupSection, INTRO_SYNC_OFF, INTRO_SYNC_ON, INTRO_SYNC_UNKNOWN } from './BackupSection';

// jsdom has no crypto.subtle; Node's is what a browser would provide.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const TIMEOUT = { timeout: 30_000 };
const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
const meta = (i: number) => ({
  schemaVersion: 1,
  createdAt: at(i),
  updatedAt: at(i + 1),
  deletedAt: null,
});

async function seed(highlights = 6): Promise<void> {
  const db = getDb();
  await db.open();
  await db.banks.bulkPut([
    { id: 'inbox-default', ...meta(0), name: 'Inbox', color: 'blue', position: 0, isInbox: true },
    {
      id: 'bank-cardio',
      ...meta(1),
      name: 'Cardiology',
      color: 'red',
      position: 1,
      isInbox: false,
    },
    { id: 'bank-renal', ...meta(2), name: 'Renal', color: 'teal', position: 2, isInbox: false },
  ] as never);
  await db.sources.bulkPut([
    {
      id: 'src-00000001',
      ...meta(1),
      type: 'web',
      urlKey: 'https://example.com/a',
      visitedKey: 'https://example.com/a',
      originalUrl: 'https://example.com/a',
      canonicalUrl: null,
      host: 'example.com',
      title: 'Aspirin',
    },
  ] as never);
  const rows: Row[] = [];
  const members: Row[] = [];
  for (let i = 0; i < highlights; i++) {
    const exact = `Quote number ${i} about drug ${i}`;
    rows.push({
      id: `hl-${String(i).padStart(8, '0')}`,
      ...meta(i),
      sourceId: 'src-00000001',
      exactQuote: exact,
      normalizedQuote: exact.toLowerCase(),
      quoteHash: createHash('sha256').update(exact.toLowerCase()).digest('hex'),
      anchorSet: {
        type: 'html',
        textAlgorithm: 'sv-text-v1',
        textQuote: { exact, prefix: '', suffix: '' },
        textPosition: { start: i * 100, end: i * 100 + exact.length },
        structuralPath: null,
        contentSignature: 'abc',
        documentTextLength: 5000,
      },
      kind: 'essential',
      color: 'amber',
      priority: 3,
      userComment: '',
      headingContext: null,
      captureMethod: 'toolbar',
      capturedAt: at(i),
      resolveStatus: 'unchecked',
      resolveConfidence: null,
      lastResolvedAt: null,
    });
    members.push({
      highlightId: `hl-${String(i).padStart(8, '0')}`,
      bankId: i % 2 === 0 ? 'bank-cardio' : 'bank-renal',
      folderId: null,
      addedAt: at(i),
    });
  }
  await db.highlights.bulkPut(rows as never);
  await db.highlightBanks.bulkPut(members as never);
}

interface Harness {
  deps: BackupDeps;
  downloads: DownloadFile[];
}

function harness(over: Partial<BackupDeps> = {}): Harness {
  const downloads: DownloadFile[] = [];
  const deps: BackupDeps = {
    ...createBackupDeps('0.0.0-test'),
    download: (f) => downloads.push(f),
    ...over,
  };
  return { deps, downloads };
}

async function makeBackup(passphrase?: string): Promise<Uint8Array> {
  const deps = createBackupDeps('0.0.0-test');
  return (
    await deps.exportFull({ includeCachedPdfs: false, ...(passphrase ? { passphrase } : {}) })
  ).bytes;
}

const asFile = (bytes: Uint8Array, name = 'backup.zip') =>
  new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/zip' });

vi.setConfig({ testTimeout: 60_000 });

type User = ReturnType<typeof userEvent.setup>;

/** The backup-file wizard: from step 1 ("Lock it?") through its last step, then "Back up now". */
async function backUpNow(user: User): Promise<void> {
  // Next until the final verb shows (one step without a passphrase, two with one).
  for (let i = 0; i < 3 && !screen.queryByTestId('backup-export-start'); i++) {
    await user.click(screen.getByTestId('backup-export-flow-next'));
  }
  await user.click(screen.getByTestId('backup-export-start'));
}

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

// ---------------------------------------------------------------------------------------------

describe('passphraseStrength', () => {
  it('rates short, weak and long phrases', () => {
    expect(passphraseStrength('abc').label).toBe('Too short');
    expect(passphraseStrength('aaaaaaaaaa').level).toBeLessThanOrEqual(1);
    expect(passphraseStrength('correct horse battery staple').label).toBe('Strong');
  });
});

describe('explainBackupError', () => {
  it('has a human explanation for every typed error code', () => {
    for (const code of BACKUP_ERROR_CODES) {
      const e = explainBackupError(new BackupError(code, 'engine message'));
      expect(e.code).toBe(code);
      expect(e.title.length).toBeGreaterThan(5);
      expect(e.body.length).toBeGreaterThan(10);
    }
  });

  it('offers a way forward for skippable problems and passphrases', () => {
    const invalid = explainBackupError(
      new BackupError('row_invalid', 'x', {
        invalidRows: {
          total: 12,
          items: [{ table: 'highlights', line: 3, reason: 'schema', message: 'm' }],
        },
      }),
    );
    expect(invalid.action).toBe('skip_invalid');
    expect(invalid.lines[0]).toMatch(/Highlights, line 3/);
    expect(invalid.lines.at(-1)).toMatch(/11 more/);
    expect(explainBackupError(new BackupError('integrity_violation', 'x')).action).toBe(
      'skip_orphans',
    );
    expect(explainBackupError(new BackupError('wrong_passphrase', 'x')).action).toBe(
      'enter_passphrase',
    );
    expect(
      explainBackupError(new StudyVaultError('storage_unavailable', 'newer data')).retryable,
    ).toBe(false);
  });
});

describe('what a backup says it holds', () => {
  const HOLDS = [
    'banks',
    'highlights',
    'notes',
    'tags',
    'folders',
    'flashcards',
    'AI drafts',
    'auto-filing rules',
    'syllabi',
    'links between items',
  ];
  const LEAVES_OUT = [
    'settings',
    'blocked sites',
    'appearance',
    'study-day',
    'study reminder',
    'AI provider',
    'key',
    'fallback providers and their keys',
    'sync account',
    'saved searches',
    'coverage thresholds of your syllabi',
    'exam in progress and your exam history',
    'backup folder you chose',
    'auto-filing suggestions that are waiting',
  ];

  it('the export panel names what is in the file and what is not, and never says "everything"', async () => {
    await seed();
    render(<ExportPanel deps={harness().deps} />);
    expect(screen.getByTestId('backup-export').textContent).not.toMatch(/everything/i);
    const holds = screen.getByTestId('backup-export-holds').textContent ?? '';
    for (const word of HOLDS) expect(holds, word).toContain(word);
    const leavesOut = screen.getByTestId('backup-export-leaves-out').textContent ?? '';
    expect(leavesOut).toMatch(/^Not in the file:/);
    for (const word of LEAVES_OUT) expect(leavesOut, word).toContain(word);

    await backUpNow(userEvent.setup());
    await screen.findByTestId('backup-export-done', {}, TIMEOUT);
    const after = screen.getByTestId('backup-export-done-leaves-out').textContent ?? '';
    for (const word of LEAVES_OUT) expect(after, word).toContain(word);
  });

  it('the restore wizard says it holds the same and does not touch settings, in both modes', async () => {
    await seed();
    const backup = await makeBackup();
    render(<ImportWizard deps={harness().deps} />);
    const scope = screen.getByTestId('backup-import-scope').textContent ?? '';
    for (const word of HOLDS) expect(scope, word).toContain(word);
    for (const word of LEAVES_OUT) expect(scope, word).toContain(word);
    expect(scope).toMatch(/does not read or change/);
    expect(screen.getByTestId('backup-import').textContent).not.toMatch(/everything/i);

    await userEvent.setup().upload(screen.getByTestId('backup-import-file'), asFile(backup));
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    const wizard = screen.getByTestId('backup-import');
    expect(wizard.textContent).not.toMatch(/everything/i);
    // the two picture cards, then one line for the chosen one
    expect(screen.getByTestId('backup-import-mode-replace')).toBeTruthy();
    expect(wizard.textContent).toMatch(/Your settings are not changed/);
    await userEvent.setup().click(screen.getByTestId('backup-import-mode-replace'));
    // the dry run runs again for the other mode; then the line names the chosen one
    await waitFor(
      () =>
        expect(screen.getByTestId('backup-import-mode-line').textContent).toMatch(
          /^Replace my study data with the backup: items not in it are deleted\. Your settings are not changed\.$/,
        ),
      TIMEOUT,
    );
  }, 60_000);

  it('readable exports point at the full backup by its real name', () => {
    render(<ReadableExports deps={harness().deps} />);
    expect(screen.getByTestId('backup-readable').textContent).toContain(
      '“Back up your study data”',
    );
    expect(screen.getByTestId('backup-readable').textContent).not.toMatch(/everything/i);
  });
});

describe('ExportPanel', () => {
  it('creates an unencrypted backup, shows what is inside with its SHA-256 and downloads it', async () => {
    await seed();
    const { deps, downloads } = harness();
    render(<ExportPanel deps={deps} />);
    const user = userEvent.setup();
    // step 1 is the lock choice, "No lock" already chosen; the last step is the review
    expect(screen.getByRole('heading', { name: 'Lock it?' })).toBeTruthy();
    expect((screen.getByTestId('backup-export-pass-off') as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByTestId('backup-export-flow-next'));
    expect(screen.getByRole('heading', { name: 'Looks good?' })).toBeTruthy();
    expect(screen.getByText('Not locked')).toBeTruthy();
    await user.click(screen.getByTestId('backup-export-start'));
    await screen.findByTestId('backup-export-done', {}, TIMEOUT);

    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toMatch(/^studyvault-backup-\d{8}-\d{6}\.zip$/);
    expect(screen.getByTestId('backup-export-sha').textContent).toMatch(/^[0-9a-f]{64}$/);
    const counts = screen.getByTestId('backup-export-counts');
    expect(within(counts).getByText('Highlights').nextSibling?.textContent).toBe('6');
    // the secrets table is not listed
    expect(counts.textContent).not.toMatch(/meta|sync/i);
    expect(screen.getByText(/Not encrypted/)).toBeTruthy();
  });

  it('encrypts only with a confirmed passphrase and an acknowledged warning', async () => {
    await seed();
    const { deps, downloads } = harness();
    render(<ExportPanel deps={deps} />);
    const user = userEvent.setup();
    const next = () => user.click(screen.getByTestId('backup-export-flow-next'));

    await user.click(screen.getByTestId('backup-export-pass-enable'));
    await next();
    expect(screen.getByRole('heading', { name: 'Passphrase' })).toBeTruthy();
    expect(screen.getByText(/Lose it, lose the backup/)).toBeTruthy();
    // Next validates the step and stays on it, with the reason
    await next();
    expect(screen.getByRole('alert').textContent).toMatch(/at least 8 characters/);
    expect(screen.queryByTestId('backup-export-start')).toBeNull();
    // The error sits with the field it names, and focus goes there (UX_DESIGN 6.9).
    const value = screen.getByTestId('backup-export-pass-value');
    expect(value.getAttribute('aria-invalid')).toBe('true');
    expect(value.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
    expect(document.activeElement).toBe(value);

    await user.type(screen.getByTestId('backup-export-pass-value'), 'correct horse battery');
    expect(screen.getByTestId('backup-export-pass-strength').textContent).toMatch(/Strong|Fair/);
    await user.type(screen.getByTestId('backup-export-pass-confirm'), 'correct horse batter');
    expect(
      (await screen.findAllByText('The two passphrases do not match.')).length,
    ).toBeGreaterThan(0);
    // Next on a mismatch: one alert (not the field's and the step's), under the second field.
    await next();
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toMatch(/do not match/);
    const confirm = screen.getByTestId('backup-export-pass-confirm');
    expect(confirm.getAttribute('aria-describedby')).toBe(alerts[0]!.id);
    expect(document.activeElement).toBe(confirm);
    await user.type(screen.getByTestId('backup-export-pass-confirm'), 'y');
    await next();
    expect(screen.getByRole('alert').textContent).toMatch(/lost passphrase cannot be recovered/);
    await user.click(screen.getByTestId('backup-export-pass-ack'));
    await next();
    expect(screen.getByText('Locked with your passphrase')).toBeTruthy();
    // Back keeps every answer
    await user.click(screen.getByTestId('backup-export-flow-back'));
    expect((screen.getByTestId('backup-export-pass-value') as HTMLInputElement).value).toBe(
      'correct horse battery',
    );
    await next();

    await user.click(screen.getByTestId('backup-export-start'));
    await screen.findByTestId('backup-export-done', {}, TIMEOUT);
    expect(downloads[0]?.name).toMatch(/\.svbackup$/);
    expect(screen.getByText(/Encrypted with your passphrase/)).toBeTruthy();
    // the file really is encrypted: no readable zip entry
    expect(() => unzipSync(downloads[0]?.data as Uint8Array)).toThrow();
  }, 60_000);

  it('can be cancelled and leaves no file', async () => {
    const { deps, downloads } = harness({
      exportFull: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new BackupError('aborted', 'The operation was cancelled.')),
          );
        }),
    });
    render(<ExportPanel deps={deps} />);
    const user = userEvent.setup();
    await backUpNow(user);
    await user.click(await screen.findByTestId('backup-export-cancel'));
    await waitFor(() => expect(screen.queryByTestId('backup-export-progress')).toBeNull());
    expect(downloads).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    // back on the wizard's last step, its title focused (focus never falls to the page)
    expect(document.activeElement?.textContent).toBe('Looks good?');
  });

  it('explains a failure and offers to try again', async () => {
    const { deps } = harness({
      exportFull: () => Promise.reject(new BackupError('source_error', 'raw')),
    });
    render(<ExportPanel deps={deps} />);
    await backUpNow(userEvent.setup());
    expect(await screen.findByText('StudyVault could not read your data')).toBeTruthy();
    expect(screen.getByTestId('backup-export-retry')).toBeTruthy();
  });

  it('offers cached PDFs only when there are some, with their size', async () => {
    const { deps } = harness({
      cachedPdfs: () => Promise.resolve({ count: 2, bytes: 5 * 1024 * 1024 }),
    });
    render(<ExportPanel deps={deps} />);
    await userEvent.setup().click(screen.getByTestId('backup-export-flow-next'));
    expect(await screen.findByText(/2 cached PDFs, 5\.0 MB/)).toBeTruthy();
    expect((screen.getByTestId('backup-include-pdfs') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('ImportWizard', () => {
  async function upload(bytes: Uint8Array, name = 'backup.zip') {
    await userEvent.setup().upload(screen.getByTestId('backup-import-file'), asFile(bytes, name));
  }

  it('merge: shows the dry run in plain language, then restores only what is missing', async () => {
    await seed();
    const backup = await makeBackup();
    await getDb().highlights.delete('hl-00000002');
    await getDb().highlights.update('hl-00000003', {
      userComment: 'newer local note',
      updatedAt: '2031-01-01T00:00:00.000Z',
    });
    // its membership went with it in this scenario
    await getDb().highlightBanks.delete(['hl-00000002', 'bank-cardio']);

    const { deps } = harness();
    render(<ImportWizard deps={deps} />);
    await upload(backup);
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);

    expect(screen.getByTestId('restore-add').textContent).toBe('2 new items will be added.');
    expect(screen.getByTestId('restore-conflict').textContent).toBe('No conflicts.');
    expect(screen.getByText(/Merging never deletes|merging never deletes/)).toBeTruthy();
    expect(screen.getByTestId('restore-table').textContent).toContain('Highlights');
    // nothing is written before the button
    expect(await getDb().highlights.get('hl-00000002')).toBeUndefined();

    await userEvent.setup().click(screen.getByTestId('backup-import-restore'));
    await screen.findByTestId('backup-import-done', {}, TIMEOUT);
    expect(await getDb().highlights.get('hl-00000002')).toBeDefined();
    expect((await getDb().highlights.get('hl-00000003'))?.userComment).toBe('newer local note');
    expect(screen.getByText('Integrity check passed')).toBeTruthy();
  }, 60_000);

  it('replace: spells out what is deleted, needs the typed word, and saves a safety backup first', async () => {
    await seed();
    const backup = await makeBackup();
    // after the backup: one extra highlight that only exists locally
    const extra = { ...((await getDb().highlights.get('hl-00000001')) as Row) };
    await getDb().highlights.put({
      ...extra,
      id: 'hl-local-only',
      exactQuote: 'Only local',
      normalizedQuote: 'only local',
      quoteHash: 'ab'.repeat(32),
    } as never);

    const { deps, downloads } = harness();
    render(<ImportWizard deps={deps} />);
    await upload(backup);
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('backup-import-mode-replace'));
    await waitFor(() => expect(screen.getByTestId('restore-removed')).toBeTruthy(), TIMEOUT);
    expect(screen.getByTestId('restore-removed').textContent).toMatch(
      /1 item only in your vault will be deleted/,
    );
    // safety backup is on by default for replace, and the word gates the button
    expect((screen.getByTestId('backup-import-safety') as HTMLInputElement).checked).toBe(true);
    const go = screen.getByTestId('backup-import-restore');
    expect(go.getAttribute('aria-disabled')).toBe('true');
    await user.type(screen.getByTestId('backup-import-confirm-word'), 'replace');
    expect(go.getAttribute('aria-disabled')).toBe('true'); // case matters
    await user.clear(screen.getByTestId('backup-import-confirm-word'));
    await user.type(screen.getByTestId('backup-import-confirm-word'), 'REPLACE');
    expect(go.getAttribute('aria-disabled')).toBeNull();

    await user.click(go);
    await screen.findByTestId('backup-import-done', {}, TIMEOUT);
    expect(await getDb().highlights.get('hl-local-only')).toBeUndefined();
    expect(await getDb().highlights.count()).toBe(6);
    // the safety copy was produced before the data changed and contains the local-only row
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toMatch(/^studyvault-before-restore-/);
    const files = unzipSync(downloads[0]?.data as Uint8Array);
    expect(strFromU8(files['tables/highlights.ndjson'] as Uint8Array)).toContain('hl-local-only');
    expect(screen.getByTestId('backup-import-safety-file').textContent).toContain(
      'studyvault-before-restore-',
    );
  }, 90_000);

  it('says what replacing does to the sync account, only while sync is on and only for replace', async () => {
    await seed();
    const backup = await makeBackup();
    const { deps } = harness({ syncActive: async () => true });
    render(<ImportWizard deps={deps} />);
    await upload(backup);
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    const user = userEvent.setup();

    expect(screen.queryByTestId('backup-import-sync-note')).toBeNull(); // merge: nothing is deleted
    await user.click(screen.getByTestId('backup-import-mode-replace'));
    expect((await screen.findByTestId('backup-import-sync-note', {}, TIMEOUT)).textContent).toBe(
      SYNC_RESTORE_NOTE,
    );
    await user.click(screen.getByTestId('backup-import-mode-merge'));
    await waitFor(() => expect(screen.queryByTestId('backup-import-sync-note')).toBeNull());
  }, 90_000);

  it('shows no sync note when sync is off', async () => {
    await seed();
    const backup = await makeBackup();
    const { deps } = harness({ syncActive: async () => false });
    render(<ImportWizard deps={deps} />);
    await upload(backup);
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    await userEvent.setup().click(screen.getByTestId('backup-import-mode-replace'));
    await screen.findByTestId('backup-import-confirm-word', {}, TIMEOUT); // replace is showing
    expect(screen.queryByTestId('backup-import-sync-note')).toBeNull();
  }, 90_000);

  it('asks for the passphrase of an encrypted backup and says when it is wrong', async () => {
    await seed();
    const backup = await makeBackup('correct horse battery');
    const { deps } = harness();
    render(<ImportWizard deps={deps} />);
    const user = userEvent.setup();
    await upload(backup, 'backup.svbackup');
    await screen.findByTestId('backup-import-passphrase', {}, TIMEOUT);

    await user.type(screen.getByTestId('backup-import-pass'), 'wrong one');
    await user.click(screen.getByTestId('backup-import-unlock'));
    expect(
      await screen.findByText('That passphrase did not open the backup', {}, TIMEOUT),
    ).toBeTruthy();

    await user.clear(screen.getByTestId('backup-import-pass'));
    await user.type(screen.getByTestId('backup-import-pass'), 'correct horse battery');
    await user.click(screen.getByTestId('backup-import-unlock'));
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    expect(screen.getByText('Encrypted (unlocked)')).toBeTruthy();
  }, 90_000);

  it.each([
    ['not a backup', () => strToU8('just some text'), 'This is not a StudyVault backup'],
    [
      'a modified table',
      async () => {
        const files = unzipSync(await makeBackup());
        const name = 'tables/highlights.ndjson';
        files[name] = strToU8(
          strFromU8(files[name] as Uint8Array).replace('Quote number 1', 'Quote number X'),
        );
        return zipSync(files);
      },
      'The backup was modified or damaged',
    ],
    ['a truncated file', async () => (await makeBackup()).slice(0, 300), undefined],
  ])('%s: explains it and changes nothing', async (_label, make, title) => {
    await seed();
    const before = await getDb().highlights.toArray();
    const bytes = await make();
    const { deps } = harness();
    render(<ImportWizard deps={deps} />);
    await upload(bytes);
    const failed = await screen.findByTestId('backup-import-failed', {}, TIMEOUT);
    if (title) expect(within(failed).getByText(title)).toBeTruthy();
    expect(screen.queryByTestId('backup-import-review')).toBeNull();
    expect(await getDb().highlights.toArray()).toEqual(before);
    // and a way out
    await userEvent.setup().click(screen.getByTestId('backup-import-reset'));
    expect(screen.getByTestId('backup-import-file')).toBeTruthy();
  });

  it('lists invalid items and lets the user restore the rest', async () => {
    await seed();
    const rows = (await getDb().highlights.toArray()) as unknown as Row[];
    const registry = backupTableRegistry;
    const bad = rows.map((r) => (r.id === 'hl-00000001' ? { ...r, priority: 99 } : r));
    const forged = await exportBackup(
      {
        registry,
        counts: () => Promise.resolve({}),
        readTable: async (name, o) => {
          if (o.afterKey !== undefined) return [];
          if (name === 'highlights') return bad;
          return (await getDb().table(name).toArray()) as Row[];
        },
      },
      { appVersion: 'forged' },
    );
    await getDb().highlights.clear();
    await getDb().highlightBanks.clear();

    const { deps } = harness();
    render(<ImportWizard deps={deps} />);
    await upload(forged.bytes);
    const blocked = await screen.findByTestId('backup-import-blocked', {}, TIMEOUT);
    expect(within(blocked).getByText(/do not match StudyVault.s data model/)).toBeTruthy();
    expect(screen.getByTestId('backup-import-blocked-lines').textContent).toMatch(
      /Highlights, line/,
    );
    expect(await getDb().highlights.count()).toBe(0);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('backup-import-skip'));
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    expect(screen.getByTestId('restore-invalid-count').textContent).toMatch(/1 item/);
    // the membership of the left-out highlight depends on it and is left out with it
    expect(screen.getByTestId('restore-excluded-count').textContent).toMatch(/1 item/);
    await user.click(screen.getByTestId('backup-import-restore'));
    await screen.findByTestId('backup-import-done', {}, TIMEOUT);
    expect(await getDb().highlights.count()).toBe(5);
    expect(await getDb().highlightBanks.count()).toBe(5);
    expect(await getDb().highlights.get('hl-00000001')).toBeUndefined();
  }, 90_000);

  it('accepts a backup file dropped onto the box', async () => {
    await seed();
    const backup = await makeBackup();
    await getDb().highlights.delete('hl-00000004');
    const { deps } = harness();
    render(<ImportWizard deps={deps} />);
    fireEvent.drop(screen.getByTestId('backup-import-drop'), {
      dataTransfer: { files: [asFile(backup)] },
    });
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    expect(screen.getByTestId('restore-add').textContent).toBe('1 new item will be added.');
  });

  it('cancel in the review discards the file and writes nothing', async () => {
    await seed();
    const backup = await makeBackup();
    await getDb().highlights.delete('hl-00000004');
    const { deps } = harness();
    render(<ImportWizard deps={deps} />);
    await upload(backup);
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    await userEvent.setup().click(screen.getByTestId('backup-import-discard'));
    expect(screen.getByTestId('backup-import-file')).toBeTruthy();
    expect(await getDb().highlights.get('hl-00000004')).toBeUndefined();
  });

  it('starts from a file the page already holds (the pre-update copy)', async () => {
    await seed();
    const backup = await makeBackup();
    const { deps } = harness();
    render(<ImportWizard deps={deps} preload={{ name: 'before-update.zip', bytes: backup }} />);
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    expect(screen.getByText(/before-update\.zip/)).toBeTruthy();
  });
});

describe('ReadableExports', () => {
  it('shows the explicit Anki field mapping before anything is downloaded', async () => {
    await seed();
    await getDb().decks.put({
      id: 'deck-0001',
      ...meta(1),
      bankId: 'bank-cardio',
      name: 'Cardio',
    } as never);
    await getDb().cards.put({
      id: 'card-0001',
      ...meta(2),
      deckId: 'deck-0001',
      highlightId: 'hl-00000000',
      knowledgePointId: null,
      cardType: 'basic',
      front: 'What does aspirin inhibit?',
      back: 'COX-1',
      tags: [],
      suspended: false,
    } as never);
    const { deps, downloads } = harness();
    render(<ReadableExports deps={deps} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('readable-format-anki'));
    await user.click(screen.getByTestId('readable-prepare'));
    const mapping = await screen.findByTestId('readable-anki-mapping', {}, TIMEOUT);
    expect(downloads).toHaveLength(0);
    expect(within(mapping).getByText('GUID')).toBeTruthy();
    expect(within(mapping).getByText(/Front \(Basic\)/)).toBeTruthy();
    expect(screen.getByTestId('readable-summary').textContent).toMatch(/1 flashcard note/);
    await user.click(screen.getByTestId('readable-download'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toBe('studyvault-anki-import.txt');
    expect(String(downloads[0]?.data)).toContain('What does aspirin inhibit?');
  });

  it('exports only the selected banks as CSV', async () => {
    await seed();
    const { deps, downloads } = harness();
    render(<ReadableExports deps={deps} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('readable-format-csv'));
    await user.click(screen.getByTestId('readable-scope-banks'));
    const prepare = screen.getByTestId('readable-prepare');
    expect(prepare.getAttribute('aria-disabled')).toBe('true'); // no bank chosen yet
    await user.click(await screen.findByTestId('readable-bank-bank-renal'));
    await user.click(prepare);
    await screen.findByTestId('readable-result', {}, TIMEOUT);
    await user.click(screen.getByTestId('readable-download'));
    const csv = String(downloads[0]?.data);
    expect(csv).toContain('Quote number 1 about drug 1');
    expect(csv).not.toContain('Quote number 0 about drug 0');
    expect(downloads[0]?.name).toMatch(/\.csv$/);
  });

  it('exports JSON for scripts: the same scope choice, one entry per highlight, nothing deleted', async () => {
    await seed();
    await getDb().highlights.update('hl-00000005', { deletedAt: at(99) } as never);
    const { deps, downloads } = harness();
    render(<ReadableExports deps={deps} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('readable-format-json'));
    // everything: five live highlights (one of six is in the trash)
    await user.click(screen.getByTestId('readable-prepare'));
    await screen.findByTestId('readable-result', {}, TIMEOUT);
    expect(screen.getByTestId('readable-summary').textContent).toBe('5 highlights in 1 file.');
    await user.click(screen.getByTestId('readable-download'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toMatch(/^studyvault-highlights-\d{8}-\d{6}\.json$/);
    expect(downloads[0]?.mime).toMatch(/^application\/json/);
    const all = JSON.parse(String(downloads[0]?.data)) as Array<{
      id: string;
      quote: string;
      deleted: boolean;
      source: { title: string; url: string | null; type: string };
      banks: { name: string; folder: string[] }[];
      quoteHash: string;
    }>;
    expect(all.map((h) => h.id)).toEqual([
      'hl-00000000',
      'hl-00000001',
      'hl-00000002',
      'hl-00000003',
      'hl-00000004',
    ]);
    expect(all[0]).toMatchObject({
      quote: 'Quote number 0 about drug 0',
      deleted: false,
      source: { title: 'Aspirin', url: 'https://example.com/a', type: 'web' },
      banks: [{ name: 'Cardiology', folder: [] }],
    });
    expect(all[0]?.quoteHash).toMatch(/^[0-9a-f]{64}$/);

    // selected banks: only Renal's highlights
    await user.click(screen.getByTestId('readable-scope-banks'));
    await user.click(await screen.findByTestId('readable-bank-bank-renal'));
    await user.click(screen.getByTestId('readable-prepare'));
    await screen.findByTestId('readable-result', {}, TIMEOUT);
    await user.click(screen.getByTestId('readable-download'));
    const renal = JSON.parse(String(downloads[1]?.data)) as Array<{ id: string }>;
    expect(renal.map((h) => h.id)).toEqual(['hl-00000001', 'hl-00000003']);
  });

  it('packs several Markdown files into one zip, one per bank', async () => {
    await seed();
    const { deps, downloads } = harness();
    render(<ReadableExports deps={deps} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('readable-prepare'));
    await screen.findByTestId('readable-result', {}, TIMEOUT);
    expect(screen.getByTestId('readable-files').textContent).toMatch(/Cardiology/);
    await user.click(screen.getByTestId('readable-download'));
    expect(downloads[0]?.name).toMatch(/^studyvault-markdown-.*\.zip$/);
    expect(
      Object.keys(unzipSync(downloads[0]?.data as Uint8Array))
        .sort()
        .join(),
    ).toMatch(/Cardiology.*Renal/);
  });
});

describe('ExternalImport', () => {
  const MD = [
    '# Cardiology',
    '',
    '> Beta blockers reduce mortality after MI.',
    '',
    '— [Cardio notes](https://example.org/cardio) · captured 2026-02-01',
    '',
    '#drugs',
    '',
    '> A second quote with no source.',
    '',
    '> Quote number 1 about drug 1',
    '',
  ].join('\n');

  it('shows what was read, writes only the ticked rows, marks them needs-review and lets the user confirm', async () => {
    await seed();
    const { deps } = harness();
    render(<ExternalImport deps={deps} />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByTestId('backup-external-file'),
      new File([MD], 'notes.md', { type: 'text/markdown' }),
    );
    const review = await screen.findByTestId('backup-external-review', {}, TIMEOUT);
    expect(screen.getByTestId('backup-external-stats').textContent).toMatch(
      /3 records, 2 can be imported, 1 duplicate skipped, 0 rejected/,
    );
    expect(within(review).getByText('Beta blockers reduce mortality after MI.')).toBeTruthy();
    expect(await getDb().highlights.count()).toBe(6); // nothing written yet

    // leave out the second quote
    await user.click(screen.getByTestId('backup-external-row-9'));
    await user.click(screen.getByTestId('backup-external-commit'));
    await screen.findByTestId('backup-external-result', {}, TIMEOUT);
    expect(await getDb().highlights.count()).toBe(7);
    const added = (await getDb().highlights.toArray()).find(
      (h) => h.exactQuote === 'Beta blockers reduce mortality after MI.',
    );
    expect(added?.customFields).toMatchObject({ importedFrom: 'markdown', needsReview: true });

    // surfaced, then confirmed
    const list = await screen.findByTestId('backup-needs-review', {}, TIMEOUT);
    expect(within(list).getByText(/Imported, needs review \(1\)/)).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(screen.queryByTestId('backup-needs-review')).toBeNull(), TIMEOUT);
    const after = await getDb().highlights.get(added!.id);
    // the flag is gone, the provenance of where it came from stays
    expect(after?.customFields).toEqual({ importedFrom: 'markdown', importedBank: 'Cardiology' });
  }, 60_000);

  it('rejects a CSV without a quote column with a plain explanation', async () => {
    const { deps } = harness();
    render(<ExternalImport deps={deps} />);
    await userEvent
      .setup()
      .upload(
        screen.getByTestId('backup-external-file'),
        new File(['a,b\n1,2\n'], 'x.csv', { type: 'text/csv' }),
      );
    expect(await screen.findByText('This file cannot be imported', {}, TIMEOUT)).toBeTruthy();
  });
});

describe('SafetyCopy', () => {
  const info: PreMigrationInfo = {
    createdAt: '2026-10-01T10:00:00.000Z',
    fromVersion: 1,
    toVersion: 2,
    status: 'kept',
    reason: null,
    rows: 12,
    tables: { highlights: 10, banks: 2 },
    byteLength: 2048,
    sha256: 'a'.repeat(64),
    filename: 'studyvault-before-update-20261001-100000.zip',
  };

  it('is absent when there is no copy', async () => {
    const { deps } = harness({
      preMigration: { info: () => Promise.resolve(null), read: vi.fn(), remove: vi.fn() },
    });
    const { container } = render(<SafetyCopy deps={deps} onRestore={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('can be saved, restored through the wizard, and deleted after a confirmation', async () => {
    let current: PreMigrationInfo | null = info;
    const remove = vi.fn(() => {
      current = null;
      return Promise.resolve();
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const { deps, downloads } = harness({
      preMigration: {
        info: () => Promise.resolve(current),
        read: () => Promise.resolve(current ? { info, bytes } : null),
        remove,
      },
    });
    const onRestore = vi.fn();
    render(<SafetyCopy deps={deps} onRestore={onRestore} />);
    const user = userEvent.setup();
    expect(await screen.findByText(/version 1 to 2/)).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();

    await user.click(screen.getByTestId('backup-safety-download'));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]?.name).toBe(info.filename);

    await user.click(screen.getByTestId('backup-safety-restore'));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith({ name: info.filename, bytes }));

    await user.click(screen.getByTestId('backup-safety-delete'));
    expect(remove).not.toHaveBeenCalled(); // asks first
    await user.click(await screen.findByRole('button', { name: 'Delete the copy' }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('backup-safety-copy')).toBeNull());
  });

  it('says honestly when no copy could be kept', async () => {
    const { deps } = harness({
      preMigration: {
        info: () =>
          Promise.resolve({
            ...info,
            status: 'too_large' as const,
            reason: 'The copy would be too big.',
            sha256: null,
          }),
        read: () => Promise.resolve(null),
        remove: () => Promise.resolve(),
      },
    });
    render(<SafetyCopy deps={deps} onRestore={vi.fn()} />);
    expect(await screen.findByText('No copy was kept before the last update')).toBeTruthy();
    expect(screen.getByText('The copy would be too big.')).toBeTruthy();
  });
});

describe('BackupSection', () => {
  it('renders every part and wires a restore of the safety copy into the wizard', async () => {
    await seed();
    const backup = await makeBackup();
    const { deps } = harness({
      preMigration: {
        info: () =>
          Promise.resolve({
            createdAt: '2026-10-01T10:00:00.000Z',
            fromVersion: 1,
            toVersion: 2,
            status: 'kept' as const,
            reason: null,
            rows: 1,
            tables: { highlights: 6 },
            byteLength: backup.length,
            sha256: 'b'.repeat(64),
            filename: 'before.zip',
          }),
        read: () =>
          Promise.resolve({
            info: {
              createdAt: '2026-10-01T10:00:00.000Z',
              fromVersion: 1,
              toVersion: 2,
              status: 'kept' as const,
              reason: null,
              rows: 1,
              tables: {},
              byteLength: backup.length,
              sha256: null,
              filename: 'before.zip',
            },
            bytes: backup,
          }),
        remove: () => Promise.resolve(),
      },
    });
    render(<BackupSection appVersion="1.2.3" deps={deps} />);
    expect(screen.getByRole('heading', { name: 'Backup and restore' })).toBeTruthy();
    for (const id of ['backup-export', 'backup-import', 'backup-readable', 'backup-external']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // one tool at a time: "Back up" first, the others are a picture card away (and stay mounted)
    const panel = (task: string) => screen.getByTestId(`backup-panel-${task}`);
    expect(panel('backup').hidden).toBe(false);
    for (const task of ['restore', 'import', 'export']) expect(panel(task).hidden).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('backup-task-export'));
    expect(panel('export').hidden).toBe(false);
    expect(panel('backup').hidden).toBe(true);

    // restoring the safety copy switches to the restore tool with the file loaded
    await user.click(await screen.findByTestId('backup-safety-restore'));
    await screen.findByTestId('backup-import-review', {}, TIMEOUT);
    expect(panel('restore').hidden).toBe(false);
    expect((screen.getByTestId('backup-task-restore') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/before\.zip/)).toBeTruthy();
  }, 60_000);

  // U-2: the introduction follows the sync setting instead of promising "only on this device".
  describe('where it says your data is', () => {
    const intro = () => screen.getByTestId('backup-intro').textContent;

    it('with sync on, says it is also on the sync server and that a backup is a copy you keep', async () => {
      const { deps } = harness({ syncActive: async () => true });
      render(<BackupSection appVersion="1.2.3" deps={deps} />);
      await waitFor(() => expect(intro()).toBe(INTRO_SYNC_ON));
      expect(intro()).toBe(
        'Your study data is on this device and, because you turned on sync, on the sync server you configured. A backup file is a copy you keep yourself.',
      );
      expect(intro()).not.toMatch(/only on this device|never uploads/);
    }, 60_000);

    it('with sync off, keeps saying it lives only on this device', async () => {
      const { deps } = harness({ syncActive: async () => false });
      render(<BackupSection appVersion="1.2.3" deps={deps} />);
      await waitFor(() => expect(intro()).toBe(INTRO_SYNC_OFF));
      expect(intro()).toMatch(/live only on this device/);
    }, 60_000);

    it('follows the setting while the page is open (the Sync section is on the same page)', async () => {
      const { deps } = harness({ syncActive: async () => false });
      render(<BackupSection appVersion="1.2.3" deps={deps} />);
      await waitFor(() => expect(intro()).toBe(INTRO_SYNC_OFF));

      const on = { ...defaultSettings(), features: { ...defaultSettings().features, sync: true } };
      await act(async () => {
        await fakeBrowser.storage.local.set({ settings: on });
      });
      await waitFor(() => expect(intro()).toBe(INTRO_SYNC_ON));

      await act(async () => {
        await fakeBrowser.storage.local.set({ settings: defaultSettings() });
      });
      await waitFor(() => expect(intro()).toBe(INTRO_SYNC_OFF));
    }, 60_000);

    it('says only what is true either way until the setting is known, and when it cannot be read', async () => {
      const failing = harness({
        syncActive: () => Promise.reject(new Error('settings unreadable')),
      });
      render(<BackupSection appVersion="1.2.3" deps={failing.deps} />);
      expect(intro()).toBe(INTRO_SYNC_UNKNOWN);
      // Give the rejected read every chance to (wrongly) change the sentence.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(intro()).toBe(INTRO_SYNC_UNKNOWN);
      expect(intro()).toMatch(/only if you turned on sync/);
      expect(intro()).not.toMatch(/only on this device/);
    }, 60_000);
  });
});
