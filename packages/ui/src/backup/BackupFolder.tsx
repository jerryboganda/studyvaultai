import { useEffect, useId, useRef, useState } from 'react';
import {
  Archive,
  CalendarClock,
  CircleCheck,
  FileArchive,
  FolderOpen,
  FolderSync,
  History,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ExportProgress } from '@backup';
import { backupDue, type BackupFolderState } from '@storage';
import { Button } from '../Button';
import { ChunkyButton } from '../design/Buttons';
import { useAsync, useDataEpoch } from '../hooks';
import { InlineNotice } from '../Notice';
import { errorMessage, plural } from '../text';
import { BACKUP_FOLDER_CHANGED, notifyBackupFolderChanged } from './BackupReminder';
import type { BackupDeps, FolderBackupOutcome } from './deps';
import { explainBackupError, type ErrorExplanation } from './explain';
import { ExportProgressView } from './ExportProgressView';
import { formatBytes, formatWhen } from './format';
import { Chip, Disclosure, Fact, Facts, Outcome } from './kit';
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
 * Dated backups into a folder the person picked (File System Access API, ADR-016): one click on
 * "Back up now", keep the newest N, a check of the written file, and an honest status. Where the
 * browser has no folder picker the card says so and the backup file above stays the way to back up.
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
        `StudyVault no longer uses “${name}”. The backups already in it were not touched. Chrome lists its permission until you remove it in site settings.`,
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

  const due = state ? backupDue(state, deps.now()) : null;
  const last = state?.last ?? null;
  const cached = pdfs.data;

  const head = (
    <div className="sd-row">
      <span className="sd-tile sd-tile--sm sv-art--sun" aria-hidden="true">
        <FolderSync strokeWidth={2.4} />
      </span>
      <h3 className="sd-card__title sd-grow">Backup folder</h3>
      {state ? (
        due?.due ? (
          <Chip icon={TriangleAlert} tone="warning" testId="backup-folder-status">
            Backup due
          </Chip>
        ) : last ? (
          <Chip icon={CircleCheck} tone="success" testId="backup-folder-status">
            Up to date
          </Chip>
        ) : (
          <Chip icon={History} testId="backup-folder-status">
            No backup yet
          </Chip>
        )
      ) : null}
    </div>
  );

  const permission = (
    <Disclosure
      summary="What Chrome allows"
      icon={ShieldCheck}
      testId="backup-folder-permission-note"
    >
      {FOLDER_PERMISSION_NOTE.map((paragraph) => (
        <p key={paragraph} className="sv-small">
          {paragraph}
        </p>
      ))}
    </Disclosure>
  );

  if (!supported) {
    return (
      <div className="sd-card" data-testid="backup-folder">
        {head}
        <div data-testid="backup-folder-unsupported">
          <InlineNotice tone="info" title="Not available in this browser">
            It has no folder picker for extensions. Use “Back up now” above and move the file from
            your downloads.
          </InlineNotice>
        </div>
      </div>
    );
  }

  return (
    <div className="sd-card" data-testid="backup-folder">
      {head}

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
        <p className="sd-line" role="status">
          Checking for a backup folder…
        </p>
      ) : state === null ? (
        <>
          <p className="sd-line">Pick a folder once; each click saves a dated copy into it.</p>
          <div className="sd-row">
            <ChunkyButton
              variant="primary"
              icon={FolderOpen}
              data-testid="backup-folder-choose"
              onClick={() => void choose()}
            >
              Choose a folder
            </ChunkyButton>
          </div>
          {permission}
        </>
      ) : (
        <>
          <Facts>
            <Fact icon={FolderOpen} label="Folder" testId="backup-folder-name">
              {state.folderName}
            </Fact>
            <Fact icon={CalendarClock} label="Last backup" testId="backup-folder-last">
              {last
                ? `${formatWhen(last.at)} (${due && due.days > 0 ? `${plural(due.days, 'day')} ago` : 'today'})`
                : 'None yet to this folder'}
            </Fact>
          </Facts>

          <div className="sd-row">
            <ChunkyButton
              id={`${uid}-now`}
              variant="primary"
              size="lg"
              icon={Archive}
              aria-busy={working || undefined}
              {...(passProblem ? { disabledReason: passProblem } : {})}
              data-testid="backup-folder-now"
              onClick={working ? undefined : () => void start()}
            >
              Back up now
              {/* Visible label first, the folder after it (WCAG 2.5.3); the name is shown above. */}
              <span className="sv-vh">{` to “${state.folderName}”`}</span>
            </ChunkyButton>
            {working ? (
              <ChunkyButton
                icon={X}
                data-testid="backup-folder-cancel"
                onClick={() => abort.current?.abort()}
              >
                Cancel
              </ChunkyButton>
            ) : (
              <>
                <ChunkyButton
                  variant="ghost"
                  icon={FolderOpen}
                  data-testid="backup-folder-change"
                  onClick={() => void choose()}
                >
                  Change folder
                </ChunkyButton>
                <ChunkyButton
                  variant="ghost"
                  data-testid="backup-folder-forget"
                  onClick={() => void forget()}
                >
                  Stop using this folder
                </ChunkyButton>
              </>
            )}
          </div>
          {passProblem && !working ? (
            <p className="sd-line" data-testid="backup-folder-problem">
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
            <div className="sd-stack" data-testid="backup-folder-done" role="status">
              <Outcome
                focus={false}
                title={`Backup saved to “${run.outcome.state.folderName}”`}
                line={
                  <>
                    <span data-testid="backup-folder-done-file">
                      {run.outcome.file.fileName}, {formatBytes(run.outcome.file.bytes)},{' '}
                      {run.outcome.encrypted ? 'encrypted with your passphrase' : 'not encrypted'}.
                    </span>{' '}
                    Read back and checked, byte for byte.
                  </>
                }
              />
              {run.outcome.file.pruned.length > 0 ? (
                <p className="sd-line" data-testid="backup-folder-pruned">
                  Removed {plural(run.outcome.file.pruned.length, 'older backup')} that StudyVault
                  made, keeping the newest {run.outcome.state.keepLast}.
                </p>
              ) : null}
              {run.outcome.file.pruneFailed.length > 0 ? (
                <InlineNotice tone="warning" title="Some older backups could not be removed">
                  {run.outcome.file.pruneFailed.join(', ')} could not be deleted (is it open in
                  another program?). The new backup is safe.
                </InlineNotice>
              ) : null}
            </div>
          ) : null}

          <Disclosure
            summary={pass.enabled ? 'Options: locked' : 'Options'}
            icon={SlidersHorizontal}
            testId="backup-folder-options"
          >
            <div className="bk-prefs">
              <div className="sv-field">
                <label className="sv-label" htmlFor={`${uid}-keep`}>
                  Copies to keep
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
                  Older StudyVault files go; others never.
                </p>
              </div>
              <div className="sv-field">
                <label className="sv-label" htmlFor={`${uid}-remind`}>
                  Remind me after
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
                  Only a reminder: nothing runs in the background.
                  {due?.due ? ' This backup is overdue by that rule.' : ''}
                </p>
              </div>
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
                Add cached PDFs
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
              <p className="sd-line">Not stored: enter it again after reloading this page.</p>
            ) : null}
          </Disclosure>

          {last ? (
            <Disclosure summary="Last file" icon={FileArchive}>
              <Facts>
                <Fact icon={FileArchive} label="File" testId="backup-folder-last-file" wide>
                  {last.fileName}, {formatBytes(last.bytes)},{' '}
                  {last.encrypted ? 'encrypted' : 'not encrypted'}; read back and checked after
                  writing
                </Fact>
                <Fact
                  icon={ShieldCheck}
                  label="SHA-256 of the file"
                  testId="backup-folder-sha"
                  mono
                  wide
                >
                  {last.sha256}
                </Fact>
              </Facts>
              <p className="sd-line">Chrome shares the folder’s name only, not where it is.</p>
            </Disclosure>
          ) : null}
          {permission}
        </>
      )}
    </div>
  );
}
