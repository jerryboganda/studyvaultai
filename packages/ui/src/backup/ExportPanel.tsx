import { useRef, useState } from 'react';
import type { ExportProgress, ExportResult } from '@backup';
import { Button } from '../Button';
import { useAsync } from '../hooks';
import { InlineNotice } from '../Notice';
import type { BackupDeps } from './deps';
import { explainBackupError, type ErrorExplanation } from './explain';
import { formatBytes, formatWhen, tableLabel } from './format';
import {
  PassphraseSetup,
  emptyPassphrase,
  passphraseProblem,
  type PassphraseState,
} from './PassphraseSetup';
import { BACKUP_HOLDS, BACKUP_LEAVES_OUT, BACKUP_TITLE } from './scope';

type Run =
  | { step: 'idle' }
  | { step: 'working'; progress: ExportProgress | null }
  | { step: 'done'; result: ExportResult; sha: string }
  | { step: 'failed'; error: ErrorExplanation };

const PHASE: Record<ExportProgress['phase'], string> = {
  reading: 'Reading',
  compressing: 'Compressing',
  encrypting: 'Encrypting',
  done: 'Finishing',
};

/**
 * Full, lossless backup of the vault's tables (the file the Restore wizard reads). Settings are not
 * part of it, and the copy says so (`scope.ts`). Selected-bank exports are the readable formats in
 * <ReadableExports>.
 */
export function ExportPanel({ deps }: { deps: BackupDeps }) {
  const [includePdfs, setIncludePdfs] = useState(false);
  const [pass, setPass] = useState<PassphraseState>(emptyPassphrase);
  const [run, setRun] = useState<Run>({ step: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const pdfs = useAsync(() => deps.cachedPdfs(), []);

  const problem = passphraseProblem(pass);
  const working = run.step === 'working';

  async function start() {
    const controller = new AbortController();
    abort.current = controller;
    setRun({ step: 'working', progress: null });
    try {
      const result = await deps.exportFull({
        includeCachedPdfs: includePdfs,
        ...(pass.enabled ? { passphrase: pass.value } : {}),
        signal: controller.signal,
        onProgress: (progress) => setRun({ step: 'working', progress }),
      });
      const sha = await deps.sha256(result.bytes);
      setRun({ step: 'done', result, sha });
      save(result);
    } catch (err) {
      const error = explainBackupError(err);
      setRun(error.code === 'aborted' ? { step: 'idle' } : { step: 'failed', error });
    } finally {
      abort.current = null;
    }
  }

  function save(result: ExportResult) {
    deps.download({
      name: result.suggestedFilename,
      data: result.bytes,
      mime: result.encrypted ? 'application/octet-stream' : 'application/zip',
    });
  }

  const cached = pdfs.data;
  const progress = run.step === 'working' ? run.progress : null;

  return (
    <div className="sv-stack" data-testid="backup-export">
      <h3>{BACKUP_TITLE}</h3>
      <p data-testid="backup-export-holds">
        Saves one file with {BACKUP_HOLDS}. It can be restored on this or another computer. Nothing
        is uploaded: the file is created on this device.
      </p>
      <p data-testid="backup-export-leaves-out">
        <strong>Not in the file:</strong> {BACKUP_LEAVES_OUT}. They stay on this device, so after
        restoring on another computer set them up again.
      </p>

      <div className="sv-check">
        <input
          id="bk-include-pdfs"
          type="checkbox"
          checked={includePdfs}
          disabled={working || !cached || cached.count === 0}
          data-testid="backup-include-pdfs"
          aria-describedby="bk-include-pdfs-hint"
          onChange={(e) => setIncludePdfs(e.target.checked)}
        />
        <label htmlFor="bk-include-pdfs">Include cached PDF files</label>
      </div>
      <p id="bk-include-pdfs-hint" className="sv-small sv-muted bk-indent">
        {pdfs.loading
          ? 'Checking for cached PDFs…'
          : cached && cached.count > 0
            ? `${cached.count} cached PDF${cached.count === 1 ? '' : 's'}, ${formatBytes(
                cached.bytes,
              )}. They make the backup file about that much larger. Your highlights and quotes are always included; PDFs are only needed to reopen the document offline.`
            : 'No PDFs are cached on this device, so there is nothing to add. Highlights made in PDFs are always included.'}
      </p>

      <PassphraseSetup
        state={pass}
        onChange={setPass}
        idPrefix="bk-export"
        testId="backup-export-pass"
      />

      <div className="sv-row">
        <Button
          variant="primary"
          busy={working}
          disabledReason={problem ?? undefined}
          data-testid="backup-export-start"
          onClick={() => void start()}
        >
          Create backup file
        </Button>
        {working ? (
          <Button data-testid="backup-export-cancel" onClick={() => abort.current?.abort()}>
            Cancel
          </Button>
        ) : null}
      </div>
      {problem && !working ? (
        <p className="sv-small sv-muted" data-testid="backup-export-problem">
          {problem}
        </p>
      ) : null}

      {working ? (
        <div
          className="sv-stack sv-stack--tight"
          role="status"
          data-testid="backup-export-progress"
        >
          <progress
            aria-label="Backup progress"
            className="bk-progress"
            {...(progress && progress.rowsTotal > 0
              ? { value: progress.rowsDone, max: progress.rowsTotal }
              : {})}
          />
          <p className="sv-small">
            {progress
              ? `${PHASE[progress.phase]}${
                  progress.table ? ` ${tableLabel(progress.table).toLowerCase()}` : ''
                }… ${progress.rowsDone} of ${progress.rowsTotal} items`
              : 'Starting…'}
          </p>
        </div>
      ) : null}

      {run.step === 'failed' ? (
        <InlineNotice
          tone="error"
          title={run.error.title}
          action={
            run.error.retryable ? (
              <Button data-testid="backup-export-retry" onClick={() => void start()}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {run.error.body}
        </InlineNotice>
      ) : null}

      {run.step === 'done' ? (
        <div className="sv-stack" data-testid="backup-export-done">
          <InlineNotice tone="success" live title="Backup file created">
            The file is saved to your browser’s download location. Keep it somewhere that is not
            only on this computer.
          </InlineNotice>
          <dl className="bk-facts">
            <div>
              <dt>File name</dt>
              <dd className="sv-wrap" data-testid="backup-export-filename">
                {run.result.suggestedFilename}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(run.result.bytes.length)}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatWhen(run.result.manifest.createdAt)}</dd>
            </div>
            <div>
              <dt>Protection</dt>
              <dd>
                {run.result.encrypted
                  ? 'Encrypted with your passphrase (AES-256-GCM)'
                  : 'Not encrypted: anyone with the file can read it'}
              </dd>
            </div>
            <div>
              <dt>Cached PDFs</dt>
              <dd>
                {run.result.manifest.options.includesAttachments
                  ? `Included (${run.result.stats.blobs})`
                  : 'Not included'}
              </dd>
            </div>
            <div>
              <dt>SHA-256 of the file</dt>
              <dd className="bk-mono sv-wrap" data-testid="backup-export-sha">
                {run.sha}
              </dd>
            </div>
          </dl>
          <div>
            <h4 className="bk-subhead">What is inside</h4>
            <ul className="bk-counts" data-testid="backup-export-counts">
              {run.result.manifest.tables.map((t) => (
                <li key={t.name}>
                  <span>{tableLabel(t.name)}</span>
                  <span>{t.rowCount}</span>
                </li>
              ))}
            </ul>
            <p className="sv-small sv-muted" data-testid="backup-export-done-leaves-out">
              Not included, by design: {BACKUP_LEAVES_OUT}.
            </p>
          </div>
          <div className="sv-row">
            <Button data-testid="backup-export-again" onClick={() => save(run.result)}>
              Download again
            </Button>
            <Button variant="ghost" onClick={() => setRun({ step: 'idle' })}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
