import { useMemo, useState } from 'react';
import './backup.css';
import { createBackupDeps, type BackupDeps } from './deps';
import { ExportPanel } from './ExportPanel';
import { ExternalImport } from './ExternalImport';
import { ImportWizard } from './ImportWizard';
import { ReadableExports } from './ReadableExports';
import { SafetyCopy } from './SafetyCopy';

export interface BackupSectionProps {
  /** Written into backups (`manifest.createdBy.version`); pass the extension version. */
  appVersion: string;
  /** Replace parts of the real wiring (tests, previews). */
  deps?: Partial<BackupDeps>;
  /** Called after a restore was committed, e.g. to refresh counts elsewhere on the page. */
  onRestored?(): void;
}

/**
 * Backup and restore for the Options page and the Dashboard: full backup, readable exports, the
 * restore wizard, Markdown/CSV import and the pre-update safety copy. Self-contained: it reads and
 * writes through @storage and @backup, and needs no provider other than the page's ToastProvider
 * being absent or present.
 */
export function BackupSection({ appVersion, deps: override, onRestored }: BackupSectionProps) {
  const deps = useMemo<BackupDeps>(
    () => ({ ...createBackupDeps(appVersion), ...override }),
    [appVersion, override],
  );
  const [preload, setPreload] = useState<{ name: string; bytes: Uint8Array; nonce: number } | null>(
    null,
  );

  return (
    <section className="sv-stack bk" aria-labelledby="bk-title" data-testid="backup-section">
      <h2 id="bk-title">Backup and restore</h2>
      <p className="sv-muted">
        Your highlights live only on this device. A backup file is how you move them to another
        computer or get them back after something goes wrong. StudyVault never uploads them.
      </p>
      <ExportPanel deps={deps} />
      <hr className="bk-rule" />
      <ImportWizard
        key={preload ? `preload-${preload.nonce}` : 'manual'}
        deps={deps}
        preload={preload}
        {...(onRestored ? { onRestored } : {})}
      />
      <hr className="bk-rule" />
      <SafetyCopy
        deps={deps}
        onRestore={(file) => {
          setPreload({ ...file, nonce: Date.now() });
          document.getElementById('bk-title')?.scrollIntoView?.({ block: 'start' });
        }}
      />
      <hr className="bk-rule" />
      <ReadableExports deps={deps} />
      <hr className="bk-rule" />
      <ExternalImport deps={deps} />
    </section>
  );
}
