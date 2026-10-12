import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { watchSettings } from '@runtime';
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

// Loaded when the section shows, not with the page: the folder panel and the File System Access
// code are only needed here.
const BackupFolder = lazy(() =>
  import('./BackupFolder').then((m) => ({ default: m.BackupFolder })),
);

/** Where the data lives depends on optional sync, so the sentence follows `deps.syncActive()`. */
export const INTRO_SYNC_ON =
  'Your study data is on this device and, because you turned on sync, on the sync server you configured. A backup file is a copy you keep yourself.';
export const INTRO_SYNC_OFF =
  'Your highlights live only on this device. A backup file is how you move them to another computer or get them back after something goes wrong. StudyVault never uploads them.';
/** Shown until the setting is read, and when it cannot be read: true whichever way it is set. */
export const INTRO_SYNC_UNKNOWN =
  'Your study data lives on this device. A backup file is how you move it to another computer or get it back after something goes wrong. StudyVault uploads it only if you turned on sync.';

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
  const [syncOn, setSyncOn] = useState<boolean | null>(null);

  useEffect(() => {
    let current = true;
    deps.syncActive?.().then(
      // A change that raced the first read is newer than the read.
      (on) => current && setSyncOn((now) => now ?? on),
      () => undefined, // stays "unknown": the sentence then says what is true either way
    );
    // The Sync section on the same page switches it on and off: follow it.
    const stop = watchSettings((s) => setSyncOn(s.features.sync));
    return () => {
      current = false;
      stop();
    };
  }, [deps]);

  return (
    <section className="sv-stack bk" aria-labelledby="bk-title" data-testid="backup-section">
      <h2 id="bk-title">Backup and restore</h2>
      <p className="sv-muted" data-testid="backup-intro">
        {syncOn === null ? INTRO_SYNC_UNKNOWN : syncOn ? INTRO_SYNC_ON : INTRO_SYNC_OFF}
      </p>
      <ExportPanel deps={deps} />
      <hr className="bk-rule" />
      <Suspense fallback={<p className="sv-muted">Loading the backup folder options…</p>}>
        <BackupFolder deps={deps} />
      </Suspense>
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
