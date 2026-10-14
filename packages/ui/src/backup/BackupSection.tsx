import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, FileDown, FileInput } from 'lucide-react';
import { watchSettings } from '@runtime';
import './backup.css';
import { BackupFolder } from './BackupFolder';
import { BACKUP_SHOW } from './BackupReminder';
import { createBackupDeps, type BackupDeps } from './deps';
import { ExportPanel } from './ExportPanel';
import { ExternalImport } from './ExternalImport';
import { ImportWizard } from './ImportWizard';
import { Choices, SectionHead } from './kit';
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

/** Where the data lives depends on optional sync, so the sentence follows `deps.syncActive()`. */
export const INTRO_SYNC_ON =
  'Your study data is on this device and, because you turned on sync, on the sync server you configured. A backup file is a copy you keep yourself.';
export const INTRO_SYNC_OFF =
  'Your highlights live only on this device. A backup file is how you move them to another computer or get them back after something goes wrong. StudyVault never uploads them.';
/** Shown until the setting is read, and when it cannot be read: true whichever way it is set. */
export const INTRO_SYNC_UNKNOWN =
  'Your study data lives on this device. A backup file is how you move it to another computer or get it back after something goes wrong. StudyVault uploads it only if you turned on sync.';

type Task = 'backup' | 'restore' | 'import' | 'export';

/**
 * Backup and restore for the Options page: one picture-card choice of what to do (back up, restore,
 * import from another app, export a readable copy), then that tool. Every tool stays mounted while
 * another is shown, so a restore that is half way keeps its file and choices. Self-contained: it
 * reads and writes through @storage and @backup.
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
  const [task, setTask] = useState<Task>('backup');
  /** The reminder asked for the folder backup: focus its button once the panel shows. */
  const focusFolder = useRef(false);

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

  useEffect(() => {
    const show = () => {
      focusFolder.current = true;
      setTask('backup');
    };
    window.addEventListener(BACKUP_SHOW, show);
    return () => window.removeEventListener(BACKUP_SHOW, show);
  }, []);
  useEffect(() => {
    if (task !== 'backup' || !focusFolder.current) return;
    focusFolder.current = false;
    const now = document.querySelector<HTMLElement>('[data-testid="backup-folder-now"]');
    (now ?? document.querySelector<HTMLElement>('[data-testid="backup-folder-choose"]'))?.focus();
  });

  return (
    <section className="sd-section bk" aria-labelledby="bk-title" data-testid="backup-section">
      <SectionHead
        icon={Archive}
        id="bk-title"
        title="Backup and restore"
        line={
          syncOn === null
            ? 'On this device'
            : syncOn
              ? 'On this device and your sync server'
              : 'Only on this device'
        }
        tipLabel="Where your data lives"
        tip={
          <span data-testid="backup-intro">
            {syncOn === null ? INTRO_SYNC_UNKNOWN : syncOn ? INTRO_SYNC_ON : INTRO_SYNC_OFF}
          </span>
        }
      />
      <SafetyCopy
        deps={deps}
        onRestore={(file) => {
          setPreload({ ...file, nonce: Date.now() });
          setTask('restore');
          document.getElementById('bk-title')?.scrollIntoView?.({ block: 'start' });
        }}
      />
      <Choices<Task>
        name="bk-task"
        label="What do you want to do?"
        columns={4}
        value={task}
        onChange={setTask}
        testId="backup-tasks"
        options={[
          {
            value: 'backup',
            label: 'Back up',
            hint: 'Save a copy',
            icon: Archive,
            tone: 'primary',
            testId: 'backup-task-backup',
          },
          {
            value: 'restore',
            label: 'Restore',
            hint: 'From a backup',
            icon: ArchiveRestore,
            tone: 'success',
            testId: 'backup-task-restore',
          },
          {
            value: 'import',
            label: 'Import',
            hint: 'From other apps',
            icon: FileInput,
            tone: 'violet',
            testId: 'backup-task-import',
          },
          {
            value: 'export',
            label: 'Export',
            hint: 'Markdown, CSV, Anki',
            icon: FileDown,
            tone: 'sun',
            testId: 'backup-task-export',
          },
        ]}
      />
      <div className="sd-stack" hidden={task !== 'backup'} data-testid="backup-panel-backup">
        <ExportPanel deps={deps} />
        <BackupFolder deps={deps} />
      </div>
      <div hidden={task !== 'restore'} data-testid="backup-panel-restore">
        <ImportWizard
          key={preload ? `preload-${preload.nonce}` : 'manual'}
          deps={deps}
          preload={preload}
          {...(onRestored ? { onRestored } : {})}
        />
      </div>
      <div hidden={task !== 'import'} data-testid="backup-panel-import">
        <ExternalImport deps={deps} />
      </div>
      <div hidden={task !== 'export'} data-testid="backup-panel-export">
        <ReadableExports deps={deps} />
      </div>
    </section>
  );
}
