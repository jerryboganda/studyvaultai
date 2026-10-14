import { useRef, useState } from 'react';
import { Archive, Download, FileArchive, Lock, LockOpen, ShieldCheck, X } from 'lucide-react';
import type { ExportProgress, ExportResult } from '@backup';
import { ChunkyButton } from '../design/Buttons';
import { useAsync } from '../hooks';
import type { BackupDeps } from './deps';
import { explainBackupError, type ErrorExplanation } from './explain';
import { ExportProgressView } from './ExportProgressView';
import { formatBytes, formatWhen, tableLabel } from './format';
import {
  Chip,
  Choices,
  Counts,
  Disclosure,
  Fact,
  Facts,
  Outcome,
  StepFlow,
  type FlowStep,
} from './kit';
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

/**
 * Full, lossless backup of the vault's tables (the file the Restore wizard reads), as a short wizard:
 * lock it or not, the passphrase, a last look (cached PDFs), then real progress and a summary of the
 * file. Settings are not part of it, and the copy says so (`scope.ts`). Selected-bank exports are the
 * readable formats in <ReadableExports>; dated copies into a folder are <BackupFolder>.
 */
export function ExportPanel({ deps }: { deps: BackupDeps }) {
  const [includePdfs, setIncludePdfs] = useState(false);
  const [pass, setPass] = useState<PassphraseState>(emptyPassphrase);
  const [index, setIndex] = useState(0);
  const [run, setRun] = useState<Run>({ step: 'idle' });
  const abort = useRef<AbortController | null>(null);
  /** The flow comes back after a run (cancel, Back, Done): its title takes focus then. */
  const ran = useRef(false);
  const pdfs = useAsync(() => deps.cachedPdfs(), []);

  async function start() {
    const controller = new AbortController();
    abort.current = controller;
    ran.current = true;
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

  function again() {
    setRun({ step: 'idle' });
    setPass(emptyPassphrase);
    setIncludePdfs(false);
    setIndex(0);
  }

  const cached = pdfs.data;
  const scope = (
    <Disclosure summary="What is in the file" icon={FileArchive} testId="backup-export-scope">
      <p data-testid="backup-export-holds">
        One file with {BACKUP_HOLDS}. It restores on this or another computer; it is made on this
        device and never uploaded.
      </p>
      <p data-testid="backup-export-leaves-out">
        <strong>Not in the file:</strong> {BACKUP_LEAVES_OUT}. Set them up again after restoring on
        another computer.
      </p>
    </Disclosure>
  );

  const steps: FlowStep[] = [
    {
      id: 'lock',
      title: 'Lock it?',
      content: (
        <>
          <Choices
            name="bk-export-lock"
            label="Lock the backup file"
            columns={2}
            value={pass.enabled ? 'yes' : 'no'}
            onChange={(v) =>
              setPass(v === 'yes' ? { ...emptyPassphrase, enabled: true } : emptyPassphrase)
            }
            options={[
              {
                value: 'no',
                label: 'No lock',
                hint: 'Anyone can open it',
                icon: LockOpen,
                tone: 'neutral',
                testId: 'backup-export-pass-off',
              },
              {
                value: 'yes',
                label: 'Passphrase',
                hint: 'Encrypted file',
                icon: Lock,
                tone: 'success',
                testId: 'backup-export-pass-enable',
              },
            ]}
          />
          {scope}
        </>
      ),
    },
    ...(pass.enabled
      ? [
          {
            id: 'pass',
            title: 'Passphrase',
            validate: () => passphraseProblem(pass),
            inlineError: true,
            content: ({ error, errorId }: { error: string | null; errorId: string }) => (
              <PassphraseSetup
                bare
                state={pass}
                onChange={setPass}
                idPrefix="bk-export"
                testId="backup-export-pass"
                error={error}
                errorId={errorId}
              />
            ),
          },
        ]
      : []),
    {
      id: 'check',
      title: 'Looks good?',
      content: (
        <>
          <div className="sd-row">
            {pass.enabled ? (
              <Chip icon={Lock} tone="success">
                Locked with your passphrase
              </Chip>
            ) : (
              <Chip icon={LockOpen} tone="warning">
                Not locked
              </Chip>
            )}
            <Chip icon={Download}>To your downloads</Chip>
          </div>
          <div className="sv-check">
            <input
              id="bk-include-pdfs"
              type="checkbox"
              checked={includePdfs}
              disabled={!cached || cached.count === 0}
              data-testid="backup-include-pdfs"
              aria-describedby="bk-include-pdfs-hint"
              onChange={(e) => setIncludePdfs(e.target.checked)}
            />
            <label htmlFor="bk-include-pdfs">Add cached PDFs</label>
          </div>
          <p id="bk-include-pdfs-hint" className="sd-line">
            {pdfs.loading
              ? 'Checking for cached PDFs…'
              : cached && cached.count > 0
                ? `${cached.count} cached PDF${cached.count === 1 ? '' : 's'}, ${formatBytes(cached.bytes)}: the file grows by that much.`
                : 'No PDFs are cached. Highlights made in PDFs are always in.'}
          </p>
          {scope}
        </>
      ),
    },
  ];

  const progress = run.step === 'working' ? run.progress : null;

  return (
    <div className="sd-stack" data-testid="backup-export">
      {run.step === 'idle' ? (
        <StepFlow
          label={BACKUP_TITLE}
          steps={steps}
          index={index}
          onIndex={setIndex}
          testId="backup-export-flow"
          autoFocus={ran.current}
          finish={{
            label: 'Back up now',
            icon: Archive,
            testId: 'backup-export-start',
            onClick: () => void start(),
          }}
        />
      ) : null}

      {run.step === 'working' ? (
        <div className="sd-card">
          <Outcome pose="think" title="Backing up…" line="Reading and packing your vault." />
          <ExportProgressView progress={progress} testId="backup-export-progress" />
          <div className="sd-row">
            <ChunkyButton
              icon={X}
              data-testid="backup-export-cancel"
              onClick={() => abort.current?.abort()}
            >
              Cancel
            </ChunkyButton>
          </div>
        </div>
      ) : null}

      {run.step === 'failed' ? (
        <div className="sd-card sd-card--danger" data-testid="backup-export-failed">
          <Outcome pose="think" title={run.error.title} line={run.error.body} />
          <div className="sd-row">
            {run.error.retryable ? (
              <ChunkyButton
                variant="primary"
                data-testid="backup-export-retry"
                onClick={() => void start()}
              >
                Try again
              </ChunkyButton>
            ) : null}
            <ChunkyButton onClick={() => setRun({ step: 'idle' })}>Back</ChunkyButton>
          </div>
        </div>
      ) : null}

      {run.step === 'done' ? (
        <div className="sd-card" data-testid="backup-export-done">
          <div role="status">
            <Outcome
              title="Backup file created"
              line="Saved to your downloads. Keep a copy off this computer."
            />
          </div>
          <Facts>
            <Fact icon={FileArchive} label="File name" testId="backup-export-filename" wide>
              {run.result.suggestedFilename}
            </Fact>
            <Fact icon={Archive} label="Size">
              {formatBytes(run.result.bytes.length)}
            </Fact>
            <Fact icon={Download} label="Created">
              {formatWhen(run.result.manifest.createdAt)}
            </Fact>
            <Fact icon={run.result.encrypted ? Lock : LockOpen} label="Protection">
              {run.result.encrypted ? 'Encrypted with your passphrase' : 'Not encrypted'}
            </Fact>
            <Fact icon={FileArchive} label="Cached PDFs">
              {run.result.manifest.options.includesAttachments
                ? `Included (${run.result.stats.blobs})`
                : 'Not included'}
            </Fact>
          </Facts>
          <Disclosure summary="What is inside" icon={ShieldCheck}>
            <Counts
              testId="backup-export-counts"
              items={run.result.manifest.tables.map((t) => ({
                label: tableLabel(t.name),
                value: t.rowCount,
              }))}
            />
            <Facts>
              <Fact
                icon={ShieldCheck}
                label="SHA-256 of the file"
                testId="backup-export-sha"
                mono
                wide
              >
                {run.sha}
              </Fact>
            </Facts>
            <p className="sd-line" data-testid="backup-export-done-leaves-out">
              Not included, by design: {BACKUP_LEAVES_OUT}.
            </p>
          </Disclosure>
          <div className="sd-row">
            <ChunkyButton
              variant="primary"
              icon={Download}
              data-testid="backup-export-again"
              onClick={() => save(run.result)}
            >
              Download again
            </ChunkyButton>
            <ChunkyButton variant="ghost" onClick={again}>
              Done
            </ChunkyButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
