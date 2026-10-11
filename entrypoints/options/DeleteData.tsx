import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { callBackground } from '@runtime';
import { getStorageUsage, getWipeState, wipeAllData, type WipeState } from '@storage';
import { Button, ConfirmDialog, InlineNotice, clearLocalPrefs, useAction, useToast } from '@ui';

/**
 * "Delete all StudyVault data". `wipeAllData` removes the database and every other store, the
 * settings, session state and the site access Chrome granted; the worker is then asked to re-sync,
 * which can only unregister the always-on content script once nothing asks for it any more. Two
 * things are not reachable from the storage layer and are removed here, once the wipe is over: the
 * `localStorage` display preferences of the extension origin (`clearLocalPrefs`) and the optional
 * `identity` and `alarms` permissions. Both are best effort, and a failure is named in the report.
 *
 * The delete of the database cannot be taken back once requested, and another StudyVault window
 * (a dashboard, a side panel, a second settings tab) can hold it up. So the page shows the three
 * states `wipeAllData` reports, says what is waiting and what to do about it, and "Stop waiting"
 * only stops waiting: the deletion itself finishes by itself when that window closes.
 */

/** A failure that is "not finished yet", not "went wrong" (`WipePendingError`, @storage). */
const isPending = (err: unknown): boolean =>
  err instanceof Error && err.name === 'WipePendingError';

const STOP_NOTE =
  "Stopping does not cancel the deletion: it still finishes when that window closes, and StudyVault here can't read or save until then.";

/** The optional API permissions sync asks for (`optional_permissions` in the manifest). */
const OPTIONAL_API_PERMISSIONS = ['identity', 'alarms'] as const;

/** What could not be removed, as sentences for the report; empty when everything went. */
async function removeLeftovers(): Promise<string[]> {
  const problems: string[] = [];
  try {
    clearLocalPrefs();
  } catch {
    problems.push(
      "The display preferences StudyVault keeps in this browser (such as high contrast) could not be cleared; Chrome lists them under the extension's site data.",
    );
  }
  try {
    const { permissions = [] } = (await browser.permissions.getAll?.()) ?? {};
    const held = OPTIONAL_API_PERMISSIONS.filter((p) => permissions.includes(p));
    if (held.length > 0) {
      // Sync's timers go with the permission: an alarm left behind could not be cleared afterwards.
      await Promise.resolve(browser.alarms?.clearAll?.()).catch(() => undefined);
      if (!(await browser.permissions.remove({ permissions: held }))) throw new Error('refused');
    }
  } catch {
    problems.push(
      'Chrome did not let StudyVault give up its optional sign-in and timer permissions (identity, alarms); you can remove them on the extension details page.',
    );
  }
  return problems;
}

export function DeleteData({ syncOn }: { syncOn: boolean }) {
  const { announce } = useToast();
  const heading = useRef<HTMLHeadingElement>(null);
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  /** What the running wipe is doing; a wipe already running when this page mounted shows too. */
  const [state, setState] = useState<WipeState | null>(() => getWipeState());
  /** The person stopped waiting: the wipe is still queued. A warning, not a failure. */
  const [stopped, setStopped] = useState(false);
  const controller = useRef<AbortController | null>(null);
  /** Whether sync was on when the wipe started (the settings are gone when it ends). */
  const hadSync = useRef(syncOn);

  const finished = async () => {
    setState(null);
    setStopped(false);
    const left = await removeLeftovers();
    // Required host permissions (developer builds) cannot be removed: do not claim otherwise.
    const { origins = [] } = (await browser.permissions.getAll?.()) ?? {};
    setDone(
      `All StudyVault data was deleted from this device and settings are back to their defaults.${
        origins.length > 0
          ? ' Chrome still lists some site access for StudyVault that it does not let the extension remove; review it on the extension details page.'
          : ''
      }${left.length > 0 ? ` ${left.join(' ')}` : ''}${
        hadSync.current
          ? ' The copy on your sync server was not touched: it is separate, and StudyVault is no longer signed in to remove it.'
          : ''
      }`,
    );
    announce('All StudyVault data was deleted.');
    heading.current?.focus();
  };

  /** Wait for the (new or already running) wipe; the outcome is reported either way. */
  const wait = async () => {
    const mine = new AbortController();
    controller.current = mine;
    setStopped(false);
    try {
      await wipeAllData({ onState: setState, signal: mine.signal });
    } catch (err) {
      if (isPending(err)) {
        setStopped(true);
        setState(null);
        return;
      }
      setState(null);
      throw err;
    } finally {
      if (controller.current === mine) controller.current = null;
    }
    await callBackground('site.sync', {});
    await finished();
  };

  const wipe = useAction(async () => {
    setDone(null);
    hadSync.current = syncOn;
    await wait();
  });

  /**
   * Look again without starting anything new: a delete is only joined while it is still running.
   * Once it is not, the data itself says whether it finished (starting another wipe here could
   * delete what was saved since).
   */
  const check = useAction(async () => {
    if (getWipeState() !== null) {
      await wait();
      return;
    }
    const usage = await getStorageUsage();
    // One bookkeeping row (the search-index marker) is written into the new, empty database.
    const left = Object.entries(usage.rows).reduce(
      (n, [table, rows]) => n + (table === 'meta' ? 0 : rows),
      0,
    );
    if (left === 0) {
      await callBackground('site.sync', {});
      await finished();
    } else {
      setStopped(false);
      throw new Error(
        `The deletion is no longer running, but ${left} items are still stored. Press Delete again to finish it.`,
      );
    }
  });

  const stopWaiting = () => controller.current?.abort();
  const busy = wipe.busy || check.busy;
  const waiting = state !== null || stopped;

  // These notices appear long after the click that started the wipe, and they are the only way to
  // learn that something outside this page is holding it up (WCAG 4.1.3).
  useEffect(() => {
    if (state === 'blocked') announce('Deleting is held up: another StudyVault window is open.');
  }, [state, announce]);
  useEffect(() => {
    if (stopped) announce('Deleting is still queued. It finishes when the other window closes.');
  }, [stopped, announce]);

  return (
    <div className="sv-stack sv-stack--tight">
      <h3 ref={heading} tabIndex={-1}>
        Delete all StudyVault data
      </h3>
      <p>
        Deleting a highlight moves it to the trash on this device, so Undo works; it stays there
        until you empty the trash or delete all data here.
      </p>
      <div>
        <Button
          variant="danger"
          busy={wipe.busy}
          {...(waiting ? { disabledReason: 'Deleting is already under way.' } : {})}
          onClick={() => setAsking(true)}
        >
          Delete all StudyVault data…
        </Button>
      </div>

      {state === 'deleting' ? <p className="sv-muted">Deleting…</p> : null}
      {state === 'cleaning' ? (
        <p className="sv-muted">
          The database is gone. Removing the pre-update copy, your settings and the site access
          Chrome granted…
        </p>
      ) : null}
      {state === 'blocked' ? (
        <InlineNotice
          tone="warning"
          title="Waiting for another StudyVault window"
          action={
            <div className="sv-row">
              <Button onClick={stopWaiting}>Stop waiting</Button>
              <Button busy={check.busy} onClick={() => void check.run()}>
                Check again
              </Button>
            </div>
          }
        >
          <p>
            Close every other StudyVault tab, dashboard and side panel. Your data is deleted the
            moment they are closed; you don&apos;t need to click again.
          </p>
          <p>{STOP_NOTE}</p>
        </InlineNotice>
      ) : null}
      {stopped ? (
        <InlineNotice
          tone="warning"
          title="Deleting is not finished"
          action={
            <Button busy={check.busy} onClick={() => void check.run()}>
              Check again
            </Button>
          }
        >
          <p>{STOP_NOTE}</p>
        </InlineNotice>
      ) : null}

      {done ? <InlineNotice tone="success">{done}</InlineNotice> : null}
      {wipe.error ? (
        <InlineNotice
          tone="error"
          title="Deleting your data did not finish"
          action={
            wipe.retryable ? (
              <Button busy={busy} onClick={wipe.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {wipe.error}
        </InlineNotice>
      ) : null}
      {check.error ? (
        <InlineNotice tone="error" title="Could not confirm that deleting finished">
          {check.error}
        </InlineNotice>
      ) : null}

      {asking ? (
        <ConfirmDialog
          title="Delete all StudyVault data?"
          confirmLabel="Delete everything"
          danger
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void wipe.run();
          }}
        >
          <p>This permanently removes everything StudyVault keeps on this device:</p>
          <ul className="opt-bullets">
            <li>
              every saved highlight with its note, including the ones in the trash, and your banks,
              folders and tags;
            </li>
            <li>
              the pages and PDFs they came from, any text recognised from scans, and kept PDF
              copies;
            </li>
            <li>flashcards and review history;</li>
            <li>AI drafts, your provider settings and your API key;</li>
            <li>
              sync settings, the sign-in and the records of what was sent, and the automatic copy
              StudyVault made before its last update;
            </li>
            <li>
              your settings (theme, colours, deny list) and the access Chrome gave StudyVault to
              websites, so it stops starting on them;
            </li>
            <li>
              the optional sign-in and timer permissions (identity, alarms) and the display
              preferences StudyVault pages keep in this browser, such as high contrast.
            </li>
          </ul>
          <p>
            <strong>This cannot be undone.</strong> It does not remove files you exported or backed
            up, anything on your other devices, or{' '}
            {syncOn
              ? 'the copy on your sync server. That one is separate, and StudyVault will no longer be signed in to remove it afterwards: use "Delete my data from the server" in the Sync section first if you want it gone.'
              : 'a copy on a sync server, if you ever used sync: that is separate.'}
          </p>
          <p>
            Afterwards Chrome&apos;s own page for this extension&apos;s stored data shows no
            highlights, notes, settings or preferences: the database it still lists is empty apart
            from one marker that holds no study data.
          </p>
          <p className="sv-muted sv-small">
            If another StudyVault window is open it can hold the deletion up. This page then tells
            you, and the deletion finishes by itself when that window is closed.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
