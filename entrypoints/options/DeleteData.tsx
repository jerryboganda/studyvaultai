import { useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { callBackground } from '@runtime';
import { wipeAllData } from '@storage';
import { Button, ConfirmDialog, InlineNotice, useAction, useToast } from '@ui';

/**
 * "Delete all StudyVault data". `wipeAllData` removes the database, the settings, session state and
 * the site access Chrome granted; the worker is then asked to re-sync, which can only unregister the
 * always-on content script once nothing asks for it any more. A failure part-way leaves a Retry
 * that repeats every step (all are idempotent).
 */
export function DeleteData() {
  const { announce } = useToast();
  const heading = useRef<HTMLHeadingElement>(null);
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const wipe = useAction(async () => {
    setDone(null);
    await wipeAllData();
    await callBackground('site.sync', {});
    // Required host permissions (developer builds) cannot be removed: do not claim otherwise.
    const { origins = [] } = (await browser.permissions.getAll?.()) ?? {};
    setDone(
      `All StudyVault data was deleted from this device and settings are back to their defaults.${
        origins.length > 0
          ? ' Chrome still lists some site access for StudyVault that it does not let the extension remove; review it on the extension details page.'
          : ''
      }`,
    );
    announce('All StudyVault data was deleted.');
    heading.current?.focus();
  });

  return (
    <div className="sv-stack sv-stack--tight">
      <h3 ref={heading} tabIndex={-1}>
        Delete all StudyVault data
      </h3>
      <p>
        Deleting one highlight hides it and keeps a copy on this device so Undo works. Deleted
        highlights stay on this device until you delete all data here.
      </p>
      <div>
        <Button variant="danger" busy={wipe.busy} onClick={() => setAsking(true)}>
          Delete all StudyVault data…
        </Button>
      </div>
      {wipe.busy ? <p className="sv-muted">Deleting…</p> : null}
      {done ? <InlineNotice tone="success">{done}</InlineNotice> : null}
      {wipe.error ? (
        <InlineNotice
          tone="error"
          title="Deleting your data did not finish"
          action={
            wipe.retryable ? (
              <Button busy={wipe.busy} onClick={wipe.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {wipe.error}
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
          <p>
            This permanently removes your highlights, notes, banks, settings and site access from
            this device:
          </p>
          <ul className="opt-bullets">
            <li>every saved highlight with its note, including ones you already deleted,</li>
            <li>your banks and the pages your highlights came from,</li>
            <li>your settings: theme, colours, deny list and the sites you enabled,</li>
            <li>the access Chrome gave StudyVault to those sites, so it stops starting on them.</li>
          </ul>
          <p>
            <strong>This cannot be undone.</strong> StudyVault has no server, so there is no copy to
            get back.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
