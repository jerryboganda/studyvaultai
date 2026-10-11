import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { watchDataEpoch } from '@runtime';
import { backupDue, getBackupFolderState, type BackupFolderState } from '@storage';
import { Button } from '../Button';
import { InlineNotice } from '../Notice';
import { plural } from '../text';
import { settingsPath } from '../shell/paths';

/** Fired on `window` by the backup folder panel after it changed the folder or made a backup. */
export const BACKUP_FOLDER_CHANGED = 'studyvault:backup-folder-changed';

export const notifyBackupFolderChanged = (): void => {
  window.dispatchEvent(new Event(BACKUP_FOLDER_CHANGED));
};

const realNow = (): Date => new Date();

/**
 * A notice when the last backup to the chosen folder is older than the interval the person set.
 * It is only a notice: nothing is written in the background (Chrome lets a page write to the
 * folder only from a click). Renders nothing when no folder is chosen, the reminder is off, the
 * backup is recent, or the state cannot be read.
 *
 * Light on purpose (no @backup, no stylesheet): the dashboard and the settings page mount it.
 */
export function BackupReminder({
  load = getBackupFolderState,
  now = realNow,
}: {
  load?: () => Promise<BackupFolderState | null>;
  now?: () => Date;
}) {
  const [shown, setShown] = useState<{ state: BackupFolderState; days: number } | null>(null);

  useEffect(() => {
    let live = true;
    const read = () => {
      load().then(
        (state) => {
          if (!live) return;
          const due = state ? backupDue(state, now()) : null;
          setShown(state && due?.due ? { state, days: due.days } : null);
        },
        () => live && setShown(null),
      );
    };
    read();
    window.addEventListener(BACKUP_FOLDER_CHANGED, read);
    window.addEventListener('focus', read);
    // "Delete all data", a restore or another window changed the vault
    const stop = watchDataEpoch(read);
    return () => {
      live = false;
      stop();
      window.removeEventListener(BACKUP_FOLDER_CHANGED, read);
      window.removeEventListener('focus', read);
    };
  }, [load, now]);

  if (!shown) return null;
  const { state, days } = shown;
  const here = window.location.pathname.endsWith('/options.html');

  const go = () => {
    if (here) {
      document.getElementById('backup')?.scrollIntoView?.({ block: 'start' });
      document.querySelector<HTMLElement>('[data-testid="backup-folder-now"]')?.focus();
    } else {
      void browser.tabs.create({
        url: browser.runtime.getURL(`/${settingsPath('backup')}` as never),
      });
    }
  };

  return (
    <div data-testid="backup-reminder">
      <InlineNotice
        tone="warning"
        title="Time to back up your study data"
        action={
          <Button data-testid="backup-reminder-go" onClick={go}>
            {here ? 'Go to the backup section' : 'Open backup settings'}
          </Button>
        }
      >
        {state.last
          ? `Your last backup to “${state.folderName}” was ${plural(days, 'day')} ago; you asked to be reminded after ${plural(state.remindAfterDays, 'day')}.`
          : `No backup has been made to “${state.folderName}” yet; you chose it ${plural(days, 'day')} ago.`}{' '}
        StudyVault cannot back up by itself in the background: press “Back up now” to write one.
      </InlineNotice>
    </div>
  );
}
