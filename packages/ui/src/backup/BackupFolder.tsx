import { useEffect, useId, useRef, useState } from 'react';
import type { ExportProgress } from '@backup';
import { backupDue, type BackupFolderState } from '@storage';
import { Button } from '../Button';
import { useAsync, useDataEpoch } from '../hooks';
import { InlineNotice } from '../Notice';
import { errorMessage, plural } from '../text';
import { BACKUP_FOLDER_CHANGED, notifyBackupFolderChanged } from './BackupReminder';
import type { BackupDeps, FolderBackupOutcome } from './deps';
import { explainBackupError, type ErrorExplanation } from './explain';
import { ExportProgressView } from './ExportProgressView';
import { formatBytes, formatWhen } from './format';
import {
  PassphraseSetup,
  emptyPassphrase,
  passphraseProblem,
  type PassphraseState,
} from './PassphraseSetup';

type Run =
  | { step: 'idle' }
  | { step: 'working'; progress: ExportProgress | null }
  | { step: 'done'; outcome: FolderBackupOutcome }
  | { step: 'failed'; error: ErrorExplanation };

const KEEP_CHOICES = [1, 2, 3, 5, 10, 20, 50] as const;
const REMIND_CHOICES = [0, 1, 3, 7, 14, 30] as const;

/** The same words wherever the panel says what the permission is (and the privacy documents). */
export const FOLDER_PERMISSION_NOTE = [
  'When you choose a folder, Chrome asks you to let StudyVault edit files in it. You give that permission for that one folder, and you can take it back at any time in Chrome’s site settings, or here with “Stop using this folder”.',
  'StudyVault adds no extension permission for this and cannot reach any other folder. It writes only files named studyvault-DATE-TIME.zip (or .svbackup when encrypted). It removes only older files of that kind that it made itself, recognised by their name and by a marker inside the file: your other files are never opened for writing or deleted.',
  'Chrome only lets a page write to the folder while you press the button, and may ask you to allow it again after the browser restarts. So StudyVault cannot make backups on its own in the background; it can only remind you.',
] as const;

/**
 * Dated backups into a folder the person picked (File System Access API, ADR-016): "Back up now",
 * keep the newest N, a check of the written file, and an honest status. Where the browser has no
 * folder picker the panel says so and the regular download above stays the way to back up.
 */
export function BackupFolder({ deps }: { deps: BackupDeps }) {
  const folder = deps.folder;
  const supported = folder.supported();
  const uid = useId();
  // undefined: not read yet; null: no folder chosen
  const [state, setState] = useState<BackupFolderState | null | undefined>(undefined);
  const [problem, setProblem] = useState<{ title: string; body: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [includePdfs, setIncludePdfs] = useState(false);
  const [pass, setPass] = useState<PassphraseState>(emptyPassphrase);
  const [run, setRun] = useState<Run>({ step: 'idle' });
  const abort = useRef<AbortController | null>(null);
  /** Move focus to the main button once a folder was chosen from this panel. */
  const focusNow = useRef(false);
  const pdfs = useAsync(() => deps.cachedPdfs(), []);
  // "Delete all data" or another window changed what is stored: read the folder state again.
  const epoch = useDataEpoch();

  useEffect(() => {
    if (!supported) return undefined;
    let live = true;
    const read = () => {
      folder.load().then(
        (next) => {
          if (!live) return;
          setState(next);
          setProblem(null);
        },
        (err: unknown) => {
          if (!live) return;
          setState((current) => current ?? null);
          setProblem({
            title: 'Could not read the backup folder setting',
            body: errorMessage(err, 'The vault database could not be read.'),
          });
        },
      );
    };
    read();
    window.addEventListener(BACKUP_FOLDER_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(BACKUP_FOLDER_CHANGED, read);
    };
  }, [folder, supported, epoch]);

  useEffect(() => {
    if (focusNow.current && state) {
      focusNow.current = false;
      document.getElementById(`${uid}-now`)?.focus();
    }
  }, [state, uid]);

  const working = run.step === 'working';
  const passProblem = passphraseProblem(pass);

  async function choose() {
    setProblem(null);
    setNotice(null);
    try {
      const next = await folder.choose();
      if (next) {
        focusNow.current = true;
        setState(next);
        setRun({ step: 'idle' });
        notifyBackupFolderChanged();
      }
    } catch (err) {
      setProblem(explainBackupError(err));
    }
  }

  async function forget() {
    const name = state?.folderName ?? '';
    setProblem(null);
    try {
      await folder.forget();
      setState(null);
      setRun({ step: 'idle' });
      setNotice(
        `StudyVault no longer uses “${name}”. The backups already in it were not touched, and the permission Chrome gave stays listed until you remove it in Chrome’s site settings.`,
      );
      notifyBackupFolderChanged();
    } catch (err) {
      setProblem(explainBackupError(err));
    }
  }

  async function start() {
    const controller = new AbortController();
    abort.current = controller;
    setNotice(null);
    setRun({ step: 'working', progress: null });
    try {
      const outcome = await folder.backupNow({
        includeCachedPdfs: includePdfs,
        ...(pass.enabled ? { passphrase: pass.value } : {}),
        signal: controller.signal,
        onProgress: (progress) => setRun({ step: 'working', progress }),
      });
      setState(outcome.state);
      setRun({ step: 'done', outcome });
      notifyBackupFolderChanged();
    } catch (err) {
      const error = explainBackupError(err);
      setRun(error.code === 'aborted' ? { step: 'idle' } : { step: 'failed', error });
    } finally {
      abort.current = null;
    }
  }

  async function savePrefs(
    change: Partial<Pick<BackupFolderState, 'keepLast' | 'remindAfterDays'>>,
  ) {
    if (!state) return;
    setProblem(null);
    try {
      const next = await folder.setPrefs({
        keepLast: state.keepLast,
        remindAfterDays: state.remindAfterDays,
        ...change,
      });
      setState(next);
      notifyBackupFolderChanged();
    } catch (err) {
      setProblem(explainBackupError(err));
    }
  }

  if (!supported) {
    return (
      <div className="sv-stack" data-testid="backup-folder">
        <h3>Back up to a folder</h3>
        <div data-testid="backup-folder-unsupported">
          <InlineNotice tone="info" title="Saving into a folder you choose is not available here">
            This browser does not give extensions a folder picker (the File System Access API), so
            StudyVault cannot write into a folder of your choice. Use “Create backup file” above:
            the file goes to your browser’s download location, and you can move it from there.
          </InlineNotice>
        </div>
      </div>
    );
  }

  const cached = pdfs.data;
  const due = state ? backupDue(state, deps.now()) : null;
  const last = state?.last ?? null;

  return (
    <div className="sv-stack" data-testid="backup-folder">
      <h3>Back up to a folder</h3>
      <p>
        Pick a folder once (an external drive, a folder your cloud-drive app keeps in sync, a USB
        stick) and StudyVault saves dated backup files into it each time you press the button.
        Nothing is uploaded by StudyVault: the files are written to that folder on this computer. If
        another program syncs or shares that folder, protect the backup with a passphrase below:
        anyone who can open the folder can read an unencrypted file.
      </p>

      <details data-testid="backup-folder-permission-note">
        <summary>What permission this uses, and what StudyVault will and will not do</summary>
        <div className="sv-stack sv-stack--tight">
          {FOLDER_PERMISSION_NOTE.map((paragraph) => (
            <p key={paragraph} className="sv-small">
              {paragraph}
            </p>
          ))}
        </div>
      </details>

      {problem ? (
        <InlineNotice tone="error" title={problem.title}>
          {problem.body}
        </InlineNotice>
      ) : null}
      {notice ? (
        <InlineNotice tone="info" live>
          {notice}
        </InlineNotice>
      ) : null}

      {state === undefined ? (
        <p className="sv-muted" role="status">
          Checking for a backup folder…
        </p>
      ) : state === null ? (
        <div>
          <Button
            variant="primary"
            data-testid="backup-folder-choose"
            onClick={() => void choose()}
          >
            Choose a backup folder…
          </Button>
        </div>
      ) : (
        <>
          <dl className="bk-facts">
            <div>
              <dt>Folder</dt>
              <dd className="sv-wrap" data-testid="backup-folder-name">
                {state.folderName}
              </dd>
            </div>
            <div>
              <dt>Last backup</dt>
              <dd data-testid="backup-folder-last">
                {last
                  ? `${formatWhen(last.at)} (${due && due.days > 0 ? `${plural(due.days, 'day')} ago` : 'today'})`
                  : 'None yet to this folder'}
              </dd>
            </div>
            {last ? (
              <>
                <div>
                  <dt>File</dt>
                  <dd className="sv-wrap" data-testid="backup-folder-last-file">
                    {last.fileName}, {formatBytes(last.bytes)},{' '}
                    {last.encrypted ? 'encrypted' : 'not encrypted'}; read back and checked after
                    writing
                  </dd>
                </div>
                <div>
                  <dt>SHA-256 of the file</dt>
                  <dd className="bk-mono sv-wrap" data-testid="backup-folder-sha">
                    {last.sha256}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
          <p className="sv-small sv-muted">
            Chrome tells StudyVault the folder’s name, not where it is, so only the name is shown.
          </p>

          <div className="sv-field">
            <label className="sv-label" htmlFor={`${uid}-keep`}>
              Newest backups to keep in this folder
            </label>
            <select
              id={`${uid}-keep`}
              className="sv-control"
              value={state.keepLast}
              aria-describedby={`${uid}-keep-hint`}
              disabled={working}
              data-testid="backup-folder-keep"
              onChange={(e) => void savePrefs({ keepLast: Number(e.target.value) })}
            >
              {[...new Set([...KEEP_CHOICES, state.keepLast])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
            </select>
            <p id={`${uid}-keep-hint`} className="sv-small sv-muted">
              After a backup is saved and checked, older files StudyVault itself made in this folder
              are removed down to this number. Other files are never removed.
            </p>
          </div>

          <div className="sv-field">
            <label className="sv-label" htmlFor={`${uid}-remind`}>
              Remind me when the last backup is older than
            </label>
            <select
              id={`${uid}-remind`}
              className="sv-control"
              value={state.remindAfterDays}
              aria-describedby={`${uid}-remind-hint`}
              data-testid="backup-folder-remind"
              onChange={(e) => void savePrefs({ remindAfterDays: Number(e.target.value) })}
            >
              {[...new Set([...REMIND_CHOICES, state.remindAfterDays])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'Never remind me' : plural(n, 'day')}
                  </option>
                ))}
            </select>
            <p id={`${uid}-remind-hint`} className="sv-small sv-muted">
              The reminder appears on the dashboard and in settings. StudyVault does not back up by
              itself in the background: Chrome only lets it write to the folder while you press
              “Back up now”.
              {due?.due ? ' This backup is overdue by that rule.' : ''}
            </p>
          </div>

          <div className="sv-check">
            <input
              id={`${uid}-pdfs`}
              type="checkbox"
              checked={includePdfs}
              disabled={working || !cached || cached.count === 0}
              data-testid="backup-folder-include-pdfs"
              onChange={(e) => setIncludePdfs(e.target.checked)}
            />
            <label htmlFor={`${uid}-pdfs`}>
              Include cached PDF files
              {cached && cached.count > 0
                ? ` (${plural(cached.count, 'file')}, ${formatBytes(cached.bytes)})`
                : ' (none are cached)'}
            </label>
          </div>

          <PassphraseSetup
            state={pass}
            onChange={setPass}
            idPrefix={`${uid}-pass`}
            testId="backup-folder-pass"
          />
          {pass.enabled ? (
            <p className="sv-small sv-muted">
              The passphrase is not stored: enter it again after reloading this page.
            </p>
          ) : null}

          <div className="sv-row">
            <Button
              id={`${uid}-now`}
              variant="primary"
              busy={working}
              {...(passProblem ? { disabledReason: passProblem } : {})}
              data-testid="backup-folder-now"
              onClick={() => void start()}
            >
              {`Back up now to “${state.folderName}”`}
            </Button>
            {working ? (
              <Button data-testid="backup-folder-cancel" onClick={() => abort.current?.abort()}>
                Cancel
              </Button>
            ) : (
              <>
                <Button data-testid="backup-folder-change" onClick={() => void choose()}>
                  Choose another folder…
                </Button>
                <Button data-testid="backup-folder-forget" onClick={() => void forget()}>
                  Stop using this folder
                </Button>
              </>
            )}
          </div>
          {passProblem && !working ? (
            <p className="sv-small sv-muted" data-testid="backup-folder-problem">
              {passProblem}
            </p>
          ) : null}

          {working ? (
            <ExportProgressView
              progress={run.step === 'working' ? run.progress : null}
              testId="backup-folder-progress"
            />
          ) : null}

          {run.step === 'failed' ? (
            <div data-testid="backup-folder-failed">
              <InlineNotice
                tone="error"
                title={run.error.title}
                action={
                  run.error.code === 'folder_missing' ? (
                    <Button data-testid="backup-folder-retry" onClick={() => void choose()}>
                      Choose a folder…
                    </Button>
                  ) : run.error.retryable ? (
                    <Button data-testid="backup-folder-retry" onClick={() => void start()}>
                      {run.error.code === 'folder_permission' ? 'Allow and try again' : 'Try again'}
                    </Button>
                  ) : undefined
                }
              >
                <p>{run.error.body}</p>
                {run.error.lines.map((line) => (
                  <p key={line} className="sv-small">
                    {line}
                  </p>
                ))}
              </InlineNotice>
            </div>
          ) : null}

          {run.step === 'done' ? (
            <div className="sv-stack sv-stack--tight" data-testid="backup-folder-done">
              <InlineNotice
                tone="success"
                live
                title={`Backup saved to “${run.outcome.state.folderName}”`}
              >
                <p data-testid="backup-folder-done-file">
                  {run.outcome.file.fileName}, {formatBytes(run.outcome.file.bytes)},{' '}
                  {run.outcome.encrypted ? 'encrypted with your passphrase' : 'not encrypted'}.
                </p>
                <p>
                  Checked: StudyVault read the file back from the folder and it matches what was
                  written, byte for byte.
                </p>
                {run.outcome.file.pruned.length > 0 ? (
                  <p data-testid="backup-folder-pruned">
                    Removed {plural(run.outcome.file.pruned.length, 'older backup')} that StudyVault
                    made, keeping the newest {run.outcome.state.keepLast}.
                  </p>
                ) : null}
              </InlineNotice>
              {run.outcome.file.pruneFailed.length > 0 ? (
                <InlineNotice tone="warning" title="Some older backups could not be removed">
                  {run.outcome.file.pruneFailed.join(', ')} could not be deleted (is it open in
                  another program?). The new backup is safe.
                </InlineNotice>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
