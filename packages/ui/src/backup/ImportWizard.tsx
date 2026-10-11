import { useEffect, useRef, useState } from 'react';
import type { PreparedRestore, RestoreProgress, RestoreReport, RestoreResult } from '@backup';
import type { IntegrityReport } from '@storage';
import { Button } from '../Button';
import { InlineNotice } from '../Notice';
import { plural } from '../text';
import type { BackupDeps } from './deps';
import {
  SYNC_RESTORE_NOTE,
  describeIntegrityIssue,
  explainBackupError,
  type ErrorExplanation,
} from './explain';
import { formatBytes, tableLabel } from './format';
import {
  PassphraseSetup,
  emptyPassphrase,
  passphraseProblem,
  type PassphraseState,
} from './PassphraseSetup';
import { RestoreReportView } from './RestoreReportView';
import { BACKUP_HOLDS, BACKUP_LEAVES_OUT, BACKUP_TITLE } from './scope';

type Step =
  'idle' | 'working' | 'passphrase' | 'review' | 'blocked' | 'restoring' | 'done' | 'failed';

interface Loaded {
  name: string;
  bytes: Uint8Array;
}

interface Done {
  result: RestoreResult;
  integrity: IntegrityReport | null;
  integrityError: string | null;
  safetyFile: string | null;
}

const CONFIRM_WORD = 'REPLACE';

const ANNOUNCE: Record<Step, string> = {
  idle: '',
  working: 'Working.',
  passphrase: 'This backup is encrypted. Enter its passphrase.',
  review: 'Check complete. Review what would change before restoring.',
  blocked: 'Some items need your decision.',
  restoring: 'Restoring.',
  done: 'Restore finished.',
  failed: 'The restore could not continue.',
};

const PHASE: Record<RestoreProgress['phase'], string> = {
  decrypting: 'Unlocking the backup',
  verifying: 'Checking every item in the file',
  staging: 'Preparing the changes',
  committing: 'Applying the changes',
  done: 'Finishing',
};

/**
 * Restore wizard: file -> (passphrase) -> dry-run report -> merge or replace -> progress -> result.
 * Nothing is written until the final button; every failure before that leaves the vault untouched.
 */
export function ImportWizard({
  deps,
  preload = null,
  onRestored,
}: {
  deps: BackupDeps;
  /** A file the page already has (e.g. the automatic pre-update copy). Starts the wizard with it. */
  preload?: Loaded | null;
  onRestored?(): void;
}) {
  const [step, setStep] = useState<Step>(preload ? 'working' : 'idle');
  const [file, setFile] = useState<Loaded | null>(preload);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [problem, setProblem] = useState<ErrorExplanation | null>(null);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [skip, setSkip] = useState({ invalid: false, orphans: false });
  const [safety, setSafety] = useState(false);
  const [safetyPass, setSafetyPass] = useState<PassphraseState>(emptyPassphrase);
  const [typed, setTyped] = useState('');
  const [dragging, setDragging] = useState(false);
  const [syncActive, setSyncActive] = useState(false);
  const live = useRef<{
    controller: AbortController | null;
    prepared: PreparedRestore | null;
    passphrase: string | undefined;
  }>({ controller: null, prepared: null, passphrase: undefined });

  useEffect(() => {
    let current = true;
    deps.syncActive?.().then(
      (on) => current && setSyncActive(on),
      () => undefined, // the note is an extra: a failed settings read must not block a restore
    );
    return () => {
      current = false;
    };
  }, [deps]);

  // Releases the decrypted archive and stops work when the wizard goes away.
  useEffect(() => {
    const state = live.current;
    return () => {
      state.controller?.abort();
      state.prepared?.discard();
    };
  }, []);

  function release() {
    live.current.prepared?.discard();
    live.current.prepared = null;
  }

  function reset() {
    release();
    live.current.controller = null;
    live.current.passphrase = undefined;
    setStep('idle');
    setFile(null);
    setReport(null);
    setProblem(null);
    setProgress(null);
    setDone(null);
    setPassphrase('');
    setSkip({ invalid: false, orphans: false });
    setSafety(false);
    setSafetyPass(emptyPassphrase);
    setTyped('');
    setMode('merge');
  }

  function fail(err: unknown) {
    const explained = explainBackupError(err);
    if (explained.code === 'aborted') {
      reset();
      return;
    }
    setProblem(explained);
    if (explained.action === 'enter_passphrase') setStep('passphrase');
    else if (explained.action === 'skip_invalid' || explained.action === 'skip_orphans') {
      setStep('blocked');
    } else setStep('failed');
  }

  async function prepare(
    loaded: Loaded,
    options: { mode: 'merge' | 'replace'; passphrase?: string; invalid: boolean; orphans: boolean },
  ) {
    release();
    const controller = new AbortController();
    live.current.controller = controller;
    live.current.passphrase = options.passphrase;
    setProblem(null);
    setProgress(null);
    setStep('working');
    try {
      const prepared = await deps.prepare(loaded.bytes, {
        mode: options.mode,
        invalidRows: options.invalid ? 'skip' : 'abort',
        orphans: options.orphans ? 'skip' : 'abort',
        signal: controller.signal,
        onProgress: setProgress,
        ...(options.passphrase ? { passphrase: options.passphrase } : {}),
      });
      live.current.prepared = prepared;
      setReport(prepared.report);
      setStep('review');
    } catch (err) {
      fail(err);
    }
  }

  async function open(bytes: Uint8Array, name: string) {
    release();
    const loaded = { name, bytes };
    setFile(loaded);
    setMode('merge');
    setSkip({ invalid: false, orphans: false });
    setTyped('');
    setSafety(false);
    setPassphrase('');
    setProblem(null);
    setStep('working');
    try {
      const info = await deps.inspect(bytes);
      if (info.encrypted) {
        setStep('passphrase');
        return;
      }
      await prepare(loaded, { mode: 'merge', invalid: false, orphans: false });
    } catch (err) {
      fail(err);
    }
  }

  async function chosen(picked: File | undefined) {
    if (!picked) return;
    setStep('working');
    try {
      await open(await deps.readBytes(picked), picked.name);
    } catch (err) {
      fail(err);
    }
  }

  // The preloaded file starts the wizard once.
  const started = useRef(false);
  useEffect(() => {
    if (preload && !started.current) {
      started.current = true;
      void open(preload.bytes, preload.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the file given at mount
  }, []);

  function changeMode(next: 'merge' | 'replace') {
    if (!file || next === mode) return;
    setMode(next);
    setTyped('');
    setSafety(next === 'replace');
    void prepare(file, {
      mode: next,
      invalid: skip.invalid,
      orphans: skip.orphans,
      ...(live.current.passphrase ? { passphrase: live.current.passphrase } : {}),
    });
  }

  function continueSkipping(which: 'invalid' | 'orphans') {
    if (!file) return;
    // items left out because they were invalid take their dependants with them
    const next =
      which === 'invalid' ? { invalid: true, orphans: true } : { ...skip, orphans: true };
    setSkip(next);
    void prepare(file, {
      mode,
      invalid: next.invalid,
      orphans: next.orphans,
      ...(live.current.passphrase ? { passphrase: live.current.passphrase } : {}),
    });
  }

  const safetyProblem = safety ? passphraseProblem(safetyPass) : null;
  const confirmProblem =
    mode === 'replace' && typed !== CONFIRM_WORD
      ? `Type ${CONFIRM_WORD} to confirm.`
      : safetyProblem;

  async function restore() {
    const loaded = file;
    const first = live.current.prepared;
    if (!loaded || !first) return;
    const controller = new AbortController();
    live.current.controller = controller;
    setProgress(null);
    setStep('restoring');
    let safetyFile: string | null = null;
    try {
      let prepared = first;
      if (safety) {
        // The safety copy is produced inside the restore, right before the commit; so the final
        // restore object is built with it. A fresh dry run also sees edits made in the meantime.
        first.discard();
        prepared = await deps.prepare(loaded.bytes, {
          mode,
          invalidRows: skip.invalid ? 'skip' : 'abort',
          orphans: skip.orphans ? 'skip' : 'abort',
          signal: controller.signal,
          onProgress: setProgress,
          ...(live.current.passphrase ? { passphrase: live.current.passphrase } : {}),
          safetyBackup: {
            includeCachedPdfs: report?.replaceImpact.tablesCleared.includes('attachments') ?? false,
            ...(safetyPass.enabled ? { passphrase: safetyPass.value } : {}),
            sink: (backup) => {
              safetyFile = backup.suggestedFilename.replace(
                'studyvault-backup',
                'studyvault-before-restore',
              );
              deps.download({
                name: safetyFile,
                data: backup.bytes,
                mime: backup.encrypted ? 'application/octet-stream' : 'application/zip',
              });
              return Promise.resolve();
            },
          },
        });
        live.current.prepared = prepared;
      }
      const result = await prepared.commit();
      live.current.prepared = null;
      let integrity: IntegrityReport | null = null;
      let integrityError: string | null = null;
      try {
        integrity = await deps.integrity();
      } catch (err) {
        integrityError = explainBackupError(err).body;
      }
      setDone({ result, integrity, integrityError, safetyFile });
      setStep('done');
      onRestored?.();
    } catch (err) {
      live.current.prepared = null;
      fail(err);
    }
  }

  const working = step === 'working' || step === 'restoring';
  const committing = progress?.phase === 'committing';

  return (
    <div className="sv-stack" data-testid="backup-import">
      <h3>Restore from a backup file</h3>
      <p>
        Choose a StudyVault backup. StudyVault first checks the whole file and shows you what would
        change; nothing is written until you confirm.
      </p>
      <p className="sv-small sv-muted" data-testid="backup-import-scope">
        A backup holds {BACKUP_HOLDS}. Restoring changes only those: it does not read or change{' '}
        {BACKUP_LEAVES_OUT}.
      </p>

      <p className="sv-sr" role="status" data-testid="backup-import-announce">
        {ANNOUNCE[step]}
      </p>

      {step === 'idle' ? (
        <div
          className={`bk-drop${dragging ? ' bk-drop--active' : ''}`}
          data-testid="backup-import-drop"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void chosen(e.dataTransfer?.files?.[0]);
          }}
        >
          <label className="sv-label" htmlFor="bk-import-file">
            Backup file
          </label>
          <input
            id="bk-import-file"
            type="file"
            accept=".zip,.svbackup,.json,application/zip,application/json,application/octet-stream"
            data-testid="backup-import-file"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = '';
              void chosen(picked);
            }}
          />
          <p className="sv-small sv-muted">
            Or drag a backup file onto this box. Files made by “{BACKUP_TITLE}” end in .zip or
            .svbackup.
          </p>
        </div>
      ) : null}

      {working ? (
        <div
          className="sv-stack sv-stack--tight"
          role="status"
          data-testid="backup-import-progress"
        >
          <progress
            aria-label="Restore progress"
            className="bk-progress"
            {...(progress && progress.rowsTotal > 0
              ? { value: progress.rowsDone, max: progress.rowsTotal }
              : {})}
          />
          <p className="sv-small">
            {progress ? PHASE[progress.phase] : 'Opening the file'}
            {progress && progress.rowsTotal > 0
              ? `… ${progress.rowsDone} of ${progress.rowsTotal} items`
              : '…'}
          </p>
          {committing ? (
            <p className="sv-small sv-muted">
              Applying the change in one step. It can no longer be cancelled; it either completes
              fully or changes nothing.
            </p>
          ) : (
            <div>
              <Button
                data-testid="backup-import-cancel"
                onClick={() => live.current.controller?.abort()}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {step === 'passphrase' && file ? (
        <form
          className="sv-stack sv-stack--tight"
          data-testid="backup-import-passphrase"
          onSubmit={(e) => {
            e.preventDefault();
            if (passphrase)
              void prepare(file, { mode, passphrase, invalid: false, orphans: false });
          }}
        >
          <InlineNotice
            tone={problem ? 'error' : 'info'}
            title={problem?.title ?? 'This backup is encrypted'}
          >
            {problem?.body ?? `Enter the passphrase for ${file.name}.`}
          </InlineNotice>
          <div className="sv-field">
            <label className="sv-label" htmlFor="bk-import-pass">
              Passphrase
            </label>
            <input
              id="bk-import-pass"
              className="sv-control"
              type="password"
              autoComplete="off"
              value={passphrase}
              data-testid="backup-import-pass"
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
          <div className="sv-row">
            <Button
              variant="primary"
              disabledReason={passphrase ? undefined : 'Enter the passphrase.'}
              data-testid="backup-import-unlock"
              onClick={() => {
                if (passphrase) {
                  void prepare(file, { mode, passphrase, invalid: false, orphans: false });
                }
              }}
            >
              Unlock and check
            </Button>
            <Button onClick={reset}>Choose another file</Button>
          </div>
        </form>
      ) : null}

      {step === 'blocked' && problem ? (
        <div className="sv-stack" data-testid="backup-import-blocked">
          <InlineNotice tone="warning" title={problem.title}>
            {problem.body}
          </InlineNotice>
          {problem.lines.length > 0 ? (
            <ul className="bk-files" data-testid="backup-import-blocked-lines">
              {problem.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}
          <div className="sv-row">
            <Button
              variant="primary"
              data-testid="backup-import-skip"
              onClick={() =>
                continueSkipping(problem.action === 'skip_invalid' ? 'invalid' : 'orphans')
              }
            >
              Restore the rest, leave these items out
            </Button>
            <Button onClick={reset}>Stop, change nothing</Button>
          </div>
        </div>
      ) : null}

      {step === 'review' && report && file ? (
        <div className="sv-stack" data-testid="backup-import-review">
          <p className="sv-small sv-muted">
            File: <span className="sv-wrap">{file.name}</span> ({formatBytes(file.bytes.length)}).
            Verified: every checksum matches.
          </p>
          <fieldset className="bk-fieldset">
            <legend className="sv-label">How should it be restored?</legend>
            <div className="sv-check">
              <input
                id="bk-mode-merge"
                type="radio"
                name="bk-mode"
                checked={mode === 'merge'}
                data-testid="backup-import-mode-merge"
                onChange={() => changeMode('merge')}
              />
              <div>
                <label htmlFor="bk-mode-merge">Merge into what I have (recommended)</label>
                <p className="sv-small sv-muted">
                  Adds what is missing and takes newer versions from the backup. Never deletes
                  anything you have.
                </p>
              </div>
            </div>
            <div className="sv-check">
              <input
                id="bk-mode-replace"
                type="radio"
                name="bk-mode"
                checked={mode === 'replace'}
                data-testid="backup-import-mode-replace"
                onChange={() => changeMode('replace')}
              />
              <div>
                <label htmlFor="bk-mode-replace">Replace my study data with the backup</label>
                <p className="sv-small sv-muted">
                  Makes your banks, highlights, notes and study data identical to the backup. Items
                  that are not in it are deleted. Your settings are not changed.
                </p>
              </div>
            </div>
          </fieldset>

          <RestoreReportView report={report} />

          <div className="sv-stack sv-stack--tight">
            <div className="sv-check">
              <input
                id="bk-safety"
                type="checkbox"
                checked={safety}
                data-testid="backup-import-safety"
                onChange={(e) => setSafety(e.target.checked)}
              />
              <label htmlFor="bk-safety">
                Download a safety backup of my current data first
                {mode === 'replace' ? ' (recommended before replacing)' : ''}
              </label>
            </div>
            {safety ? (
              <div className="bk-indent">
                <p className="sv-small sv-muted">
                  If the safety backup cannot be saved, nothing is restored.
                </p>
                <PassphraseSetup
                  state={safetyPass}
                  onChange={setSafetyPass}
                  idPrefix="bk-safety-pass"
                  label="Encrypt the safety backup with a passphrase"
                  testId="backup-import-safety-pass"
                />
              </div>
            ) : null}
          </div>

          {mode === 'replace' && syncActive ? (
            <InlineNotice tone="warning">
              <span data-testid="backup-import-sync-note">{SYNC_RESTORE_NOTE}</span>
            </InlineNotice>
          ) : null}

          {mode === 'replace' ? (
            <div className="sv-field">
              <label className="sv-label" htmlFor="bk-confirm-word">
                Type {CONFIRM_WORD} to confirm that your current data will be replaced
              </label>
              <input
                id="bk-confirm-word"
                className="sv-control"
                type="text"
                autoComplete="off"
                value={typed}
                data-testid="backup-import-confirm-word"
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          ) : null}

          <div className="sv-row">
            <Button
              variant={mode === 'replace' ? 'danger' : 'primary'}
              disabledReason={confirmProblem ?? undefined}
              data-testid="backup-import-restore"
              onClick={() => void restore()}
            >
              {mode === 'replace'
                ? 'Replace my data with this backup'
                : 'Merge this backup into my data'}
            </Button>
            <Button data-testid="backup-import-discard" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'failed' && problem ? (
        <div className="sv-stack" data-testid="backup-import-failed">
          <InlineNotice
            tone="error"
            title={problem.title}
            action={
              problem.retryable && file ? (
                <Button
                  data-testid="backup-import-retry"
                  onClick={() =>
                    void prepare(file, {
                      mode,
                      invalid: skip.invalid,
                      orphans: skip.orphans,
                      ...(live.current.passphrase ? { passphrase: live.current.passphrase } : {}),
                    })
                  }
                >
                  Check the file again
                </Button>
              ) : undefined
            }
          >
            {problem.body}
          </InlineNotice>
          <div>
            <Button data-testid="backup-import-reset" onClick={reset}>
              Choose another file
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'done' && done ? (
        <div className="sv-stack" data-testid="backup-import-done">
          <InlineNotice
            tone="success"
            live
            title={done.result.mode === 'replace' ? 'Your data was replaced' : 'Backup merged'}
          >
            {plural(
              Object.values(done.result.written).reduce((a, b) => a + b, 0),
              'item',
            )}{' '}
            written. Search is marked out of date so it can be rebuilt from the restored data.
          </InlineNotice>
          {done.safetyFile ? (
            <p data-testid="backup-import-safety-file">
              Your previous data was saved first as{' '}
              <strong className="sv-wrap">{done.safetyFile}</strong>.
            </p>
          ) : null}
          <ul className="bk-counts" data-testid="backup-import-written">
            {Object.entries(done.result.written)
              .filter(([, n]) => n > 0)
              .map(([name, n]) => (
                <li key={name}>
                  <span>{tableLabel(name)}</span>
                  <span>{n}</span>
                </li>
              ))}
          </ul>
          {done.integrity ? (
            done.integrity.ok ? (
              <InlineNotice tone="success" title="Integrity check passed">
                Every item is valid and nothing refers to missing data.
              </InlineNotice>
            ) : (
              <InlineNotice
                tone="warning"
                title={`Integrity check found ${plural(done.integrity.issues.length, 'issue')}${
                  done.integrity.truncated ? ' or more' : ''
                }`}
              >
                <ul className="bk-files" data-testid="backup-import-integrity-issues">
                  {done.integrity.issues.slice(0, 10).map((i) => (
                    <li key={`${i.table}:${i.key}:${i.code}`}>
                      {tableLabel(i.table)} <code className="bk-mono">{i.key.slice(0, 40)}</code>{' '}
                      {describeIntegrityIssue(i.code)}
                    </li>
                  ))}
                </ul>
              </InlineNotice>
            )
          ) : (
            <InlineNotice tone="warning" title="The integrity check could not run">
              {done.integrityError ?? 'Try again from the storage section.'}
            </InlineNotice>
          )}
          <div>
            <Button data-testid="backup-import-again" onClick={reset}>
              Restore another file
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
