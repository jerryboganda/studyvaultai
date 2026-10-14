import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { BackupError } from '@backup';
import { getBackupFolder, getBackupFolderState, resetDbForTests } from '@storage';
import type { BackupFolderPrefs, BackupFolderState } from '@storage';
import { BackupFolder } from './BackupFolder';
import { BACKUP_FOLDER_CHANGED, BackupReminder } from './BackupReminder';
import { BackupSection } from './BackupSection';
import {
  createBackupDeps,
  type BackupDeps,
  type FolderBackupOutcome,
  type FolderBackupRequest,
  type FolderDeps,
} from './deps';
import { explainBackupError } from './explain';

const NOW = new Date('2026-10-20T12:00:00.000Z');
// the folder panel is a lazy chunk inside the section: the first import transforms the module
const LAZY = { timeout: 30_000 };

const stateOf = (over: Partial<BackupFolderState> = {}): BackupFolderState => ({
  folderName: 'Study backups',
  chosenAt: '2026-10-01T09:00:00.000Z',
  keepLast: 5,
  remindAfterDays: 7,
  last: null,
  ...over,
});

const lastOf = (at: string, over: Partial<NonNullable<BackupFolderState['last']>> = {}) => ({
  at,
  fileName: 'studyvault-20261011-083000.zip',
  bytes: 4096,
  sha256: 'a'.repeat(64),
  encrypted: false,
  pruned: 0,
  ...over,
});

/** A scripted stand-in for the folder dependency: records calls, answers from queues. */
function scripted(initial: BackupFolderState | null, options: { supported?: boolean } = {}) {
  let state = initial;
  const calls = {
    choose: 0,
    forget: 0,
    prefs: [] as BackupFolderPrefs[],
    backups: [] as FolderBackupRequest[],
  };
  const picks: Array<BackupFolderState | null | Error> = [];
  const results: Array<
    Error | { encryptedSuffix?: boolean; pruned?: string[]; pruneFailed?: string[] }
  > = [];
  const folder: FolderDeps = {
    supported: () => options.supported ?? true,
    load: () => Promise.resolve(state),
    choose() {
      calls.choose++;
      const next = picks.shift() ?? null;
      if (next instanceof Error) return Promise.reject(next);
      if (next) state = next;
      return Promise.resolve(next);
    },
    forget() {
      calls.forget++;
      state = null;
      return Promise.resolve();
    },
    setPrefs(prefs) {
      calls.prefs.push(prefs);
      state = { ...(state as BackupFolderState), ...prefs };
      return Promise.resolve(state);
    },
    backupNow(request) {
      calls.backups.push(request);
      const next = results.shift() ?? {};
      if (next instanceof Error) return Promise.reject(next);
      request.onProgress?.({
        phase: 'reading',
        table: 'highlights',
        tablesDone: 1,
        tablesTotal: 4,
        rowsDone: 5,
        rowsTotal: 10,
      });
      const encrypted = request.passphrase !== undefined;
      const fileName = `studyvault-20261020-120000.${encrypted ? 'svbackup' : 'zip'}`;
      state = {
        ...(state as BackupFolderState),
        last: lastOf('2026-10-20T12:00:00.000Z', {
          fileName,
          encrypted,
          bytes: 2048,
          sha256: 'b'.repeat(64),
        }),
      };
      const outcome: FolderBackupOutcome = {
        state,
        file: {
          fileName,
          bytes: 2048,
          pruned: next.pruned ?? [],
          pruneFailed: next.pruneFailed ?? [],
          inFolder: 3,
        },
        sha256: 'b'.repeat(64),
        encrypted,
        manifest: {} as never,
      };
      return Promise.resolve(outcome);
    },
  };
  return {
    folder,
    calls,
    picks,
    results,
    get state() {
      return state;
    },
  };
}

function depsWith(folder: FolderDeps, over: Partial<BackupDeps> = {}): BackupDeps {
  return {
    ...createBackupDeps('0.0.0-test'),
    now: () => NOW,
    cachedPdfs: () => Promise.resolve({ count: 0, bytes: 0 }),
    syncActive: () => Promise.resolve(false),
    folder,
    ...over,
  };
}

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

const now = () => screen.findByTestId('backup-folder-now');

describe('BackupFolder: where the browser has no folder picker', () => {
  it('says so, offers no dead button, and leaves the regular download in the section', async () => {
    const s = scripted(null, { supported: false });
    render(<BackupSection appVersion="1.2.3" deps={depsWith(s.folder)} />);
    const note = await screen.findByTestId('backup-folder-unsupported', {}, LAZY);
    expect(note.textContent).toMatch(/no folder picker for extensions/);
    expect(note.textContent).toMatch(/Back up now/);
    expect(screen.queryByTestId('backup-folder-choose')).toBeNull();
    expect(screen.queryByTestId('backup-folder-now')).toBeNull();
    // the backup-file wizard is still there
    expect(screen.getByTestId('backup-export-flow')).toBeTruthy();
  });
});

describe('BackupFolder: choosing the folder', () => {
  it('starts without one, explains the permission, and asks only from the button', async () => {
    const s = scripted(null);
    render(<BackupFolder deps={depsWith(s.folder)} />);
    await screen.findByTestId('backup-folder-choose');
    expect(s.calls.choose).toBe(0);
    const note = screen.getByTestId('backup-folder-permission-note').textContent ?? '';
    expect(note).toMatch(/one folder/);
    expect(note).toMatch(/take it back at any time in Chrome’s site settings/);
    expect(note).toMatch(/adds no extension permission/);
    expect(note).toMatch(/cannot make backups on its own in the background/);
    expect(screen.queryByTestId('backup-folder-now')).toBeNull();
  });

  it('shows the folder name and the "Back up now" button after the picker returns, and moves focus there', async () => {
    const s = scripted(null);
    s.picks.push(stateOf());
    render(<BackupFolder deps={depsWith(s.folder)} />);
    await userEvent.setup().click(await screen.findByTestId('backup-folder-choose'));
    const button = await now();
    expect(button.textContent).toBe('Back up now to “Study backups”');
    expect(screen.getByTestId('backup-folder-name').textContent).toBe('Study backups');
    expect(screen.getByTestId('backup-folder-last').textContent).toBe('None yet to this folder');
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('closing the picker is not an error', async () => {
    const s = scripted(null);
    s.picks.push(null);
    render(<BackupFolder deps={depsWith(s.folder)} />);
    await userEvent.setup().click(await screen.findByTestId('backup-folder-choose'));
    await waitFor(() => expect(s.calls.choose).toBe(1));
    expect(screen.getByTestId('backup-folder-choose')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a picker that fails shows the reason', async () => {
    const s = scripted(null);
    s.picks.push(new BackupError('folder_permission', 'no'));
    render(<BackupFolder deps={depsWith(s.folder)} />);
    await userEvent.setup().click(await screen.findByTestId('backup-folder-choose'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not allowed to write to the backup folder/);
  });

  it('"Stop using this folder" forgets it, says the files stay, and brings the chooser back', async () => {
    const s = scripted(stateOf({ last: lastOf('2026-10-19T09:00:00.000Z') }));
    render(<BackupFolder deps={depsWith(s.folder)} />);
    await userEvent.setup().click(await screen.findByTestId('backup-folder-forget'));
    await screen.findByTestId('backup-folder-choose');
    expect(s.calls.forget).toBe(1);
    expect(screen.getByRole('status').textContent).toMatch(
      /backups already in it were not touched/,
    );
  });
});

describe('BackupFolder: backing up now', () => {
  it('writes, reports the checked file, shows real progress and updates "Last backup"', async () => {
    const s = scripted(stateOf());
    s.results.push({
      pruned: ['studyvault-20261001-080000.zip', 'studyvault-20261002-080000.zip'],
    });
    render(<BackupFolder deps={depsWith(s.folder)} />);
    const user = userEvent.setup();
    await user.click(await now());

    const done = await screen.findByTestId('backup-folder-done');
    expect(s.calls.backups).toHaveLength(1);
    expect(s.calls.backups[0]).toMatchObject({ includeCachedPdfs: false });
    expect(s.calls.backups[0]?.passphrase).toBeUndefined();
    expect(within(done).getByTestId('backup-folder-done-file').textContent).toMatch(
      /^studyvault-20261020-120000\.zip, 2\.0 KB, not encrypted\./,
    );
    expect(done.textContent).toMatch(/Read back and checked, byte for byte/);
    expect(within(done).getByTestId('backup-folder-pruned').textContent).toBe(
      'Removed 2 older backups that StudyVault made, keeping the newest 5.',
    );
    expect(screen.getByTestId('backup-folder-last').textContent).toMatch(
      /^2026-10-20 \d\d:\d\d \(today\)$/,
    );
    expect(screen.getByTestId('backup-folder-sha').textContent).toBe('b'.repeat(64));
  });

  it('names a file that could not be removed and says the new backup is safe', async () => {
    const s = scripted(stateOf());
    s.results.push({ pruneFailed: ['studyvault-20261001-080000.zip'] });
    render(<BackupFolder deps={depsWith(s.folder)} />);
    await userEvent.setup().click(await now());
    const done = await screen.findByTestId('backup-folder-done');
    expect(done.textContent).toMatch(/studyvault-20261001-080000\.zip could not be deleted/);
    expect(done.textContent).toMatch(/new backup is safe/);
  });

  it('an encrypted backup needs a valid passphrase first and sends it with the request', async () => {
    const s = scripted(stateOf());
    render(<BackupFolder deps={depsWith(s.folder)} />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('backup-folder-pass-enable'));
    expect((await now()).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('backup-folder-problem').textContent).toMatch(
      /at least 8 characters/,
    );

    await user.type(screen.getByTestId('backup-folder-pass-value'), 'correct horse battery');
    await user.type(screen.getByTestId('backup-folder-pass-confirm'), 'correct horse battery');
    await user.click(screen.getByTestId('backup-folder-pass-ack'));
    await waitFor(() =>
      expect(
        (screen.getByTestId('backup-folder-now') as HTMLElement).getAttribute('aria-disabled'),
      ).toBeNull(),
    );
    await user.click(screen.getByTestId('backup-folder-now'));

    const done = await screen.findByTestId('backup-folder-done');
    expect(s.calls.backups[0]?.passphrase).toBe('correct horse battery');
    expect(done.textContent).toMatch(/\.svbackup, 2\.0 KB, encrypted with your passphrase/);
  });

  it('a lapsed permission can be asked again from the same button', async () => {
    const s = scripted(stateOf());
    s.results.push(new BackupError('folder_permission', 'denied'));
    render(<BackupFolder deps={depsWith(s.folder)} />);
    const user = userEvent.setup();
    await user.click(await now());
    const failed = await screen.findByTestId('backup-folder-failed');
    expect(failed.textContent).toMatch(/not allowed to write to the backup folder/);
    expect(screen.queryByTestId('backup-folder-done')).toBeNull();

    await user.click(within(failed).getByRole('button', { name: 'Allow and try again' }));
    await screen.findByTestId('backup-folder-done');
    expect(s.calls.backups).toHaveLength(2);
    expect(screen.queryByTestId('backup-folder-failed')).toBeNull();
  });

  it('a removed folder offers to choose another one; nothing says the backup was made', async () => {
    const s = scripted(stateOf());
    s.results.push(new BackupError('folder_missing', 'gone'));
    s.picks.push(stateOf({ folderName: 'New place' }));
    render(<BackupFolder deps={depsWith(s.folder)} />);
    const user = userEvent.setup();
    await user.click(await now());
    const failed = await screen.findByTestId('backup-folder-failed');
    expect(failed.textContent).toMatch(/cannot be found/);
    await user.click(within(failed).getByRole('button', { name: 'Choose a folder…' }));
    await waitFor(() =>
      expect(screen.getByTestId('backup-folder-name').textContent).toBe('New place'),
    );
    expect(screen.queryByTestId('backup-folder-failed')).toBeNull();
  });

  it.each([
    ['disk_full', /not enough free space/],
    ['folder_write_failed', /could not be saved to the folder/],
    ['folder_verify_failed', /did not pass the check, so it was removed/],
  ] as const)(
    '%s is explained, keeps the old "Last backup" and offers to try again',
    async (code, title) => {
      const previous = lastOf('2026-10-19T09:00:00.000Z');
      const s = scripted(stateOf({ last: previous }));
      s.results.push(new BackupError(code, 'specific cause'));
      render(<BackupFolder deps={depsWith(s.folder)} />);
      await userEvent.setup().click(await now());
      const failed = await screen.findByTestId('backup-folder-failed');
      expect(failed.textContent).toMatch(title);
      expect(failed.textContent).toMatch(/Your StudyVault data was not changed/);
      expect(within(failed).getByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(screen.getByTestId('backup-folder-last-file').textContent).toContain(
        previous.fileName,
      );
    },
  );

  it('Cancel stops a running backup and leaves the page idle', async () => {
    const s = scripted(stateOf());
    s.folder.backupNow = (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(new BackupError('aborted', 'cancelled')),
        );
      });
    render(<BackupFolder deps={depsWith(s.folder)} />);
    const user = userEvent.setup();
    await user.click(await now());
    await user.click(await screen.findByTestId('backup-folder-cancel'));
    await waitFor(() => expect(screen.queryByTestId('backup-folder-cancel')).toBeNull());
    expect(screen.queryByTestId('backup-folder-failed')).toBeNull();
    expect(screen.queryByTestId('backup-folder-done')).toBeNull();
  });
});

describe('BackupFolder: the two choices', () => {
  it('saves how many to keep and when to remind, and says nothing runs in the background', async () => {
    const s = scripted(stateOf());
    render(<BackupFolder deps={depsWith(s.folder)} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId('backup-folder-keep'), '10');
    await waitFor(() => expect(s.calls.prefs).toEqual([{ keepLast: 10, remindAfterDays: 7 }]));
    await user.selectOptions(screen.getByTestId('backup-folder-remind'), '0');
    await waitFor(() => expect(s.calls.prefs[1]).toEqual({ keepLast: 10, remindAfterDays: 0 }));
    expect(s.state).toMatchObject({ keepLast: 10, remindAfterDays: 0 });
    const hint = document.getElementById(
      screen.getByTestId('backup-folder-remind').getAttribute('aria-describedby') ?? '',
    );
    expect(hint?.textContent).toMatch(/nothing runs in the background/);
  });

  it('flags an overdue backup in the status text', async () => {
    const s = scripted(stateOf({ last: lastOf('2026-10-01T09:00:00.000Z'), remindAfterDays: 7 }));
    render(<BackupFolder deps={depsWith(s.folder)} />);
    expect((await screen.findByTestId('backup-folder-last')).textContent).toMatch(/19 days ago/);
    expect(document.body.textContent).toMatch(/This backup is overdue by that rule/);
  });
});

describe('BackupReminder', () => {
  const at = (iso: string) => ({ now: () => new Date(iso) });

  it('shows a notice naming the folder and the age when the last backup is past the interval', async () => {
    const state = stateOf({ last: lastOf('2026-10-05T09:00:00.000Z'), remindAfterDays: 7 });
    render(<BackupReminder load={() => Promise.resolve(state)} {...at('2026-10-20T12:00:00Z')} />);
    const box = await screen.findByTestId('backup-reminder');
    expect(box.textContent).toMatch(/last backup to “Study backups” was 15 days ago/);
    expect(box.textContent).toMatch(/reminded after 7 days/);
    expect(box.textContent).toMatch(/cannot back up by itself in the background/);
  });

  it('says so when no backup was ever made to the folder', async () => {
    const state = stateOf({ remindAfterDays: 3 });
    render(<BackupReminder load={() => Promise.resolve(state)} {...at('2026-10-20T12:00:00Z')} />);
    expect((await screen.findByTestId('backup-reminder')).textContent).toMatch(
      /No backup has been made to “Study backups” yet; you chose it 19 days ago/,
    );
  });

  it.each([
    ['a recent backup', stateOf({ last: lastOf('2026-10-19T09:00:00.000Z') })],
    ['the reminder turned off', stateOf({ remindAfterDays: 0 })],
    ['no folder', null],
  ])('shows nothing for %s', async (_what, state) => {
    const load = vi.fn(() => Promise.resolve(state));
    render(<BackupReminder load={load} {...at('2026-10-20T12:00:00Z')} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByTestId('backup-reminder')).toBeNull();
  });

  it('shows nothing when the state cannot be read', async () => {
    const load = vi.fn(() => Promise.reject(new Error('database is being deleted')));
    render(<BackupReminder load={load} {...at('2026-10-20T12:00:00Z')} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByTestId('backup-reminder')).toBeNull();
  });

  it('goes away when a backup is made on the same page', async () => {
    let state = stateOf({ last: lastOf('2026-10-05T09:00:00.000Z') });
    render(<BackupReminder load={() => Promise.resolve(state)} {...at('2026-10-20T12:00:00Z')} />);
    await screen.findByTestId('backup-reminder');
    state = stateOf({ last: lastOf('2026-10-20T11:59:00.000Z') });
    act(() => {
      window.dispatchEvent(new Event(BACKUP_FOLDER_CHANGED));
    });
    await waitFor(() => expect(screen.queryByTestId('backup-reminder')).toBeNull());
  });

  it('outside the settings page its button opens the backup section in a tab', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never);
    const state = stateOf({ remindAfterDays: 3 });
    render(<BackupReminder load={() => Promise.resolve(state)} {...at('2026-10-20T12:00:00Z')} />);
    await userEvent.setup().click(await screen.findByTestId('backup-reminder-go'));
    expect(create).toHaveBeenCalledWith({ url: expect.stringMatching(/options\.html#backup$/) });
  });
});

describe('the real wiring (createBackupDeps)', () => {
  type Picker = (o: unknown) => Promise<unknown>;
  const setPicker = (fn: Picker | undefined) => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: fn,
      configurable: true,
      writable: true,
    });
  };
  afterEach(() => setPicker(undefined));

  it('is supported only where the browser has the picker', () => {
    const deps = createBackupDeps('t');
    setPicker(undefined);
    expect(deps.folder.supported()).toBe(false);
    setPicker(() => Promise.resolve({}));
    expect(deps.folder.supported()).toBe(true);
  });

  it('keeps the picked folder and the two choices in the vault database, and forgets them', async () => {
    const deps = createBackupDeps('t');
    // a plain object stands in for the handle: fake-indexeddb can only store cloneable data
    setPicker(() => Promise.resolve({ kind: 'directory', name: 'External drive' }));
    const chosen = await deps.folder.choose();
    expect(chosen).toMatchObject({ folderName: 'External drive', keepLast: 5, remindAfterDays: 7 });
    expect((await getBackupFolder())?.handle).toEqual({
      kind: 'directory',
      name: 'External drive',
    });

    expect(await deps.folder.setPrefs({ keepLast: 2, remindAfterDays: 30 })).toMatchObject({
      keepLast: 2,
      remindAfterDays: 30,
    });
    expect(await deps.folder.load()).toMatchObject({ keepLast: 2 });

    await deps.folder.forget();
    expect(await getBackupFolderState()).toBeNull();
  });

  it('a closed picker (AbortError) chooses nothing; a refused one is a typed error', async () => {
    const deps = createBackupDeps('t');
    setPicker(() => Promise.reject(new DOMException('closed', 'AbortError')));
    expect(await deps.folder.choose()).toBeNull();
    setPicker(() => Promise.reject(new DOMException('no', 'SecurityError')));
    await expect(deps.folder.choose()).rejects.toMatchObject({ code: 'folder_permission' });
    expect(await getBackupFolderState()).toBeNull();
  });

  it('refuses to back up when the stored handle is not a folder (nothing is written)', async () => {
    const deps = createBackupDeps('t');
    setPicker(() => Promise.resolve({ kind: 'directory', name: 'Plain object' }));
    await deps.folder.choose();
    const err = await deps.folder.backupNow({ includeCachedPdfs: false }).catch((e: unknown) => e);
    expect(explainBackupError(err)).toMatchObject({ code: 'folder_missing' });
    expect((await getBackupFolderState())?.last).toBeNull();
  });
});
