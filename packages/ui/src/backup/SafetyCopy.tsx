import { useState } from 'react';
import {
  ArchiveRestore,
  CalendarClock,
  Download,
  HardDrive,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Button } from '../Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { InfoTip } from '../design/InfoTip';
import { useAsync } from '../hooks';
import { InlineNotice } from '../Notice';
import type { BackupDeps } from './deps';
import { explainBackupError } from './explain';
import { formatBytes, formatWhen, tableLabel } from './format';
import { Chip, Fact, Facts } from './kit';

/**
 * The automatic copy StudyVault takes of your data right before it upgrades its database. Shown
 * only when one exists; it can be saved as a file, restored through the wizard, or deleted.
 */
export function SafetyCopy({
  deps,
  onRestore,
}: {
  deps: BackupDeps;
  onRestore(file: { name: string; bytes: Uint8Array }): void;
}) {
  const [epoch, setEpoch] = useState(0);
  const info = useAsync(() => deps.preMigration.info(), [], [epoch]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const data = info.data;
  if (!data) return null;

  async function withBytes(handle: (file: { name: string; bytes: Uint8Array }) => void) {
    setBusy(true);
    setError(null);
    try {
      const kept = await deps.preMigration.read();
      if (!kept) {
        setError('The saved copy is no longer there.');
        setEpoch((n) => n + 1);
        return;
      }
      handle({ name: kept.info.filename, bytes: kept.bytes });
    } catch (err) {
      setError(explainBackupError(err).body);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setAsking(false);
    setBusy(true);
    setError(null);
    try {
      await deps.preMigration.remove();
      setEpoch((n) => n + 1);
    } catch (err) {
      setError(explainBackupError(err).body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sd-card sd-card--warn" data-testid="backup-safety-copy">
      <div className="sd-row">
        <span className="sd-tile sd-tile--sm sv-art--violet" aria-hidden="true">
          <ShieldCheck strokeWidth={2.4} />
        </span>
        <h3 className="sd-card__title sd-grow">Copy from before the update</h3>
        <Chip>
          version {data.fromVersion} to {data.toVersion}
        </Chip>
      </div>
      {data.status === 'kept' ? (
        <>
          <p className="sd-line">
            Kept on this device until you delete it.{' '}
            <InfoTip label="About this copy">
              StudyVault saved it right before upgrading its database, so an update can never cost
              you work.
            </InfoTip>
          </p>
          <Facts>
            <Fact icon={CalendarClock} label="Made">
              {formatWhen(data.createdAt)}
            </Fact>
            <Fact icon={HardDrive} label="Size">
              {formatBytes(data.byteLength)}
            </Fact>
            <Fact icon={ArchiveRestore} label="Contents" wide>
              {Object.entries(data.tables)
                .map(([name, n]) => `${n} ${tableLabel(name).toLowerCase()}`)
                .join(', ')}
            </Fact>
            {data.sha256 ? (
              <Fact icon={ShieldCheck} label="SHA-256" mono wide>
                {data.sha256}
              </Fact>
            ) : null}
          </Facts>
          <div className="sd-row">
            <Button
              variant="primary"
              busy={busy}
              data-testid="backup-safety-restore"
              onClick={() => void withBytes(onRestore)}
            >
              Review and restore…
            </Button>
            <Button
              busy={busy}
              data-testid="backup-safety-download"
              onClick={() =>
                void withBytes((f) =>
                  deps.download({ name: f.name, data: f.bytes, mime: 'application/zip' }),
                )
              }
            >
              <Download aria-hidden="true" className="bk-btnicon" /> Save as a file
            </Button>
            <Button
              variant="danger"
              busy={busy}
              data-testid="backup-safety-delete"
              onClick={() => setAsking(true)}
            >
              <Trash2 aria-hidden="true" className="bk-btnicon" /> Delete this copy…
            </Button>
          </div>
        </>
      ) : (
        <>
          <InlineNotice
            tone="warning"
            title={
              data.status === 'too_large'
                ? 'No copy was kept before the last update'
                : 'The copy before the last update could not be made'
            }
          >
            {data.reason ??
              'Your data was upgraded without a separate copy. The upgrade itself is all-or-nothing.'}
          </InlineNotice>
          <div>
            <Button busy={busy} data-testid="backup-safety-delete" onClick={() => void remove()}>
              Dismiss this note
            </Button>
          </div>
        </>
      )}
      {error ? (
        <InlineNotice tone="error" title="Could not finish">
          {error}
        </InlineNotice>
      ) : null}
      {asking ? (
        <ConfirmDialog
          title="Delete the copy made before the update?"
          confirmLabel="Delete the copy"
          danger
          onCancel={() => setAsking(false)}
          onConfirm={() => void remove()}
        >
          <p>This removes the automatic copy from this device. Your current data is not touched.</p>
          <p>
            <strong>This cannot be undone.</strong> If you want to keep it, save it as a file first.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
