import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '../Button';
import { InlineNotice } from '../Notice';
import { useAction } from '../hooks';
import {
  isRaised,
  readReminderFlag,
  reminderText,
  watchReminderFlag,
  writeReminderFlag,
  type ReminderFlag,
} from './reminders';
import { useNow } from './useNow';

/**
 * Whether the daily reminder time came and was not dismissed, kept current across contexts (the
 * service worker raises it, any page may dismiss it). Counts until the study day it was raised in
 * ends; the minute tick makes that expiry show without a reload.
 */
export function useReminderRaised() {
  const [flag, setFlag] = useState<ReminderFlag | null>(null);
  const now = useNow();

  useEffect(() => {
    let live = true;
    let changed = false;
    const stop = watchReminderFlag((next) => {
      changed = true;
      setFlag(next);
    });
    // A change that raced the first read is newer than the read.
    readReminderFlag().then(
      (first) => {
        if (live && !changed) setFlag(first);
      },
      () => undefined, // no notice is better than a broken popup
    );
    return () => {
      live = false;
      stop();
    };
  }, []);

  const dismiss = useCallback(async () => {
    await writeReminderFlag(null);
    setFlag(null);
  }, []);

  return { raised: isRaised(flag, now), dismiss };
}

/**
 * "Time to review: N cards due", with a way to dismiss it. Nothing when the daily time has not
 * come, when it was dismissed, or when nothing is due. `action` is the page's own way to start
 * (the popup has a button for it already; the side panel passes one that opens its review tab).
 */
export function ReminderNotice({
  count,
  action,
  onDismissed,
}: {
  /** Cards due now, from `useDueCount`; null while it is not known. */
  count: number | null;
  action?: ReactNode;
  /** Called once the notice is gone: the caller owns where keyboard focus goes next. */
  onDismissed?: () => void;
}) {
  const { raised, dismiss } = useReminderRaised();
  const close = useAction(async () => {
    await dismiss();
    onDismissed?.();
  });
  if (!raised || count === null || count <= 0) return null;
  return (
    <InlineNotice
      tone="info"
      live
      title={reminderText(count)}
      action={
        <div className="sv-row">
          {action}
          <Button busy={close.busy} onClick={() => void close.run()}>
            Dismiss
          </Button>
        </div>
      }
    >
      {close.error ? (
        <p>Could not dismiss it: {close.error}</p>
      ) : (
        <p>Your daily reminder time came.</p>
      )}
    </InlineNotice>
  );
}
