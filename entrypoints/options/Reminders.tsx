import { useEffect, useId, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Settings } from '@shared';
import { TIME_OF_DAY, nextReminderAt } from '@study';
import { Button, InlineNotice, useAction, useToast } from '@ui';
import { formatWhen, useNow, useStudySettings } from '@ui/review';
import type { Update } from './Preferences';

/**
 * Opt-in study reminders (docs/adr/019-reminders.md). Off by default. Turning the count on needs no
 * permission. A daily time needs the optional "alarms" permission, which is requested from the click
 * that saves the time (and only then); without it the time is kept and the page says why it is idle.
 */

/** Whether Chrome holds the optional "alarms" permission, kept current (it can change elsewhere). */
function useAlarmsPermission(): boolean | null {
  const [granted, setGranted] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      browser.permissions.contains({ permissions: ['alarms'] }).then(
        (g) => live && setGranted(g),
        () => live && setGranted(false),
      );
    };
    read();
    browser.permissions.onAdded.addListener(read);
    browser.permissions.onRemoved.addListener(read);
    return () => {
      live = false;
      browser.permissions.onAdded.removeListener(read);
      browser.permissions.onRemoved.removeListener(read);
    };
  }, []);
  return granted;
}

export function Reminders({ settings, update }: { settings: Settings; update: Update }) {
  const uid = useId();
  const { announce } = useToast();
  const { settings: study } = useStudySettings();
  const alarms = useAlarmsPermission();
  const { on, dailyAt } = settings.reminders;
  const timeZone = study?.timeZone ?? null;

  // What the person sees while a write is in flight: their choice, not the old value.
  const [pending, setPending] = useState<boolean | null>(null);
  const toggle = useAction(async (next: boolean) => {
    await update((s) => ({ ...s, reminders: { ...s.reminders, on: next } }));
    announce(next ? 'Toolbar count is on.' : 'Toolbar count is off.');
  });
  const shown = pending ?? on;

  const [draft, setDraft] = useState(dailyAt ?? '');
  const [declined, setDeclined] = useState(false);
  // A change from another window (or a restore of the default) replaces what is typed.
  const [seen, setSeen] = useState(dailyAt);
  if (seen !== dailyAt) {
    setSeen(dailyAt);
    setDraft(dailyAt ?? '');
  }
  const valid = TIME_OF_DAY.test(draft);

  const saveTime = useAction(async () => {
    if (!valid) throw new Error('Enter a time such as 18:30.');
    // First await of the click handler: Chrome's permission prompt needs the user gesture. It
    // answers true at once when the permission is already held.
    const granted = await browser.permissions.request({ permissions: ['alarms'] });
    setDeclined(!granted);
    await update((s) => ({ ...s, reminders: { ...s.reminders, dailyAt: draft } }));
    announce(
      granted
        ? `Daily reminder set for ${draft}.`
        : `Daily time ${draft} saved, but it needs the timer permission to work.`,
    );
  });
  const removeTime = useAction(async () => {
    setDeclined(false);
    await update((s) => ({ ...s, reminders: { ...s.reminders, dailyAt: null } }));
    announce('Daily reminder removed.');
  });
  const allow = useAction(async () => {
    const granted = await browser.permissions.request({ permissions: ['alarms'] });
    setDeclined(!granted);
    announce(
      granted
        ? 'Timer permission granted. The daily reminder is active.'
        : 'Chrome did not give it.',
    );
  });

  const now = useNow();
  const next = useMemo(() => {
    if (!on || dailyAt === null || timeZone === null) return null;
    try {
      return formatWhen(new Date(nextReminderAt(now, timeZone, dailyAt)).toISOString(), timeZone);
    } catch {
      return null;
    }
  }, [on, dailyAt, timeZone, now]);

  const timerActive = on && dailyAt !== null && alarms === true;
  const unchanged = draft === (dailyAt ?? '');
  const saveBlocker = !valid
    ? 'Choose a time first.'
    : unchanged && alarms === true
      ? 'That time is already set.'
      : undefined;
  const failure = toggle.error ?? saveTime.error ?? removeTime.error ?? allow.error;

  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`} data-testid="reminders-section">
      <h2 id={`${uid}-h`}>Study reminders (optional, off by default)</h2>
      <p>
        A reminder is a number on the StudyVault toolbar icon and a notice in the popup and side
        panel. Nothing is sent, nothing is shown outside the browser, and no system notification is
        used. It all stays on this device.
      </p>

      <div className="sv-check">
        <input
          id={`${uid}-on`}
          type="checkbox"
          role="switch"
          data-testid="reminders-toggle"
          checked={shown}
          aria-busy={toggle.busy || undefined}
          aria-describedby={`${uid}-on-hint`}
          onChange={(e) => {
            if (toggle.busy) return;
            const next = e.target.checked;
            setPending(next);
            void toggle.run(next).then(() => setPending(null));
          }}
        />
        <div>
          <label htmlFor={`${uid}-on`}>Show how many cards are due on the toolbar icon</label>
          <p id={`${uid}-on-hint`} className="sv-muted sv-small">
            The number is the one the popup shows. Chrome has to be running: nothing happens while
            it is closed. The icon is recounted when StudyVault starts, when your cards or study
            settings change, and at your daily time, so it can be behind while StudyVault has not
            run. To read it without sight, the icon&apos;s tooltip says the same thing in words.
          </p>
        </div>
      </div>

      <fieldset className="opt-fieldset" disabled={!on}>
        <legend>Daily reminder</legend>
        <div className="sv-field opt-narrow">
          <label className="sv-label" htmlFor={`${uid}-time`}>
            Remind me at
          </label>
          <input
            id={`${uid}-time`}
            className="sv-control"
            type="time"
            data-testid="reminders-time"
            value={draft}
            aria-describedby={`${uid}-time-hint`}
            aria-invalid={draft !== '' && !valid ? true : undefined}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p id={`${uid}-time-hint`} className="sv-muted sv-small">
            Local time{timeZone ? ` in your study time zone (${timeZone})` : ''}, set under Review
            and study day below. At that time the icon shows &ldquo;!&rdquo; and the popup and side
            panel say how many cards are due, until they are done, you dismiss it or the study day
            ends.
          </p>
        </div>
        <div className="sv-row">
          <Button
            variant="primary"
            busy={saveTime.busy}
            data-testid="reminders-save"
            {...(saveBlocker ? { disabledReason: saveBlocker } : {})}
            onClick={() => void saveTime.run()}
          >
            Set daily reminder
          </Button>
          {dailyAt !== null ? (
            <Button
              busy={removeTime.busy}
              data-testid="reminders-remove"
              onClick={() => void removeTime.run()}
            >
              Remove daily reminder
            </Button>
          ) : null}
        </div>
        {on ? null : (
          <p className="sv-muted sv-small">
            The daily reminder has no effect while the toolbar count is off.
          </p>
        )}
      </fieldset>

      <div className="sv-stack sv-stack--tight" data-testid="reminders-status">
        <p>
          <strong>Toolbar count:</strong>{' '}
          {on
            ? settings.features.review
              ? 'on.'
              : 'on, paused while review is turned off.'
            : 'off. Nothing is counted and nothing is scheduled.'}
        </p>
        <p>
          <strong>Daily reminder:</strong>{' '}
          {dailyAt === null
            ? 'none.'
            : timerActive
              ? `${dailyAt}${timeZone ? ` (${timeZone})` : ''}${next ? `, next ${next}` : ''}.`
              : on
                ? `${dailyAt} is saved but not active: Chrome has not given StudyVault the timer permission.`
                : `${dailyAt} is saved and starts once the toolbar count is on.`}
        </p>
      </div>

      {dailyAt !== null && on && alarms === false ? (
        <InlineNotice
          tone="warning"
          title="The daily time needs the timer permission"
          action={
            <Button
              busy={allow.busy}
              data-testid="reminders-allow"
              onClick={() => void allow.run()}
            >
              Allow the timer permission
            </Button>
          }
        >
          <p data-testid="reminders-permission-note">
            {declined ? 'Chrome did not give it, so nothing was changed. ' : ''}
            Chrome only lets an extension run at a set time with its &ldquo;alarms&rdquo;
            permission, and StudyVault does not have it until you allow it. Without it the count on
            the icon still works; only the daily notice cannot come. The permission is used for
            reminders (and for sync, if you turn that on), and you can take it back on the
            extension&apos;s details page or with Delete all data.
          </p>
        </InlineNotice>
      ) : null}

      <p className="sv-muted sv-small">
        Reminders are only shown while Chrome is running. If it is closed at your daily time there
        is no reminder afterwards, and StudyVault never sends system notifications or email.
      </p>

      {failure ? (
        <InlineNotice tone="error" title="Your change was not saved">
          {failure}
        </InlineNotice>
      ) : null}
    </section>
  );
}
