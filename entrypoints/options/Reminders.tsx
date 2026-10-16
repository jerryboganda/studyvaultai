import { useEffect, useId, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlarmClock, Bell, Clock, Trash2 } from 'lucide-react';
import type { Settings } from '@shared';
import { TIME_OF_DAY, nextReminderAt } from '@study';
import { Button, InfoTip, InlineNotice, useAction, useToast } from '@ui';
import { formatWhen, useNow, useStudySettings } from '@ui/review';
import type { Update } from './Preferences';
import { Act, Card, SettingRow } from './ui';

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
  const reviewOn = settings.features.review;
  const timeZone = study?.timeZone ?? null;

  const toggle = useAction(async (next: boolean) => {
    await update((s) => ({ ...s, reminders: { ...s.reminders, on: next } }));
    announce(next ? 'Toolbar count is on.' : 'Toolbar count is off.');
  });

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

  const badgeState = on ? (reviewOn ? 'On' : 'Paused (review off)') : 'Off';
  // Short: the notice below the cards says why a saved time is not active.
  const dailyState =
    dailyAt === null
      ? 'None'
      : timerActive
        ? `${dailyAt}${timeZone ? ` (${timeZone})` : ''}${next ? `, next ${next}` : ''}`
        : on
          ? `${dailyAt} saved, not active`
          : `${dailyAt} saved, starts with the badge`;

  return (
    <div className="opt-stack" data-testid="reminders-section">
      <dl className="opt-status" data-testid="reminders-status">
        <div className={`opt-status__item${on ? ' is-on' : ''}`}>
          <dt>
            <Bell aria-hidden="true" strokeWidth={2.4} />
            Badge
          </dt>
          <dd>{badgeState}</dd>
        </div>
        <div className={`opt-status__item${timerActive ? ' is-on' : ''}`}>
          <dt>
            <AlarmClock aria-hidden="true" strokeWidth={2.4} />
            Daily time
          </dt>
          <dd>{dailyState}</dd>
        </div>
      </dl>

      <div className="opt-card opt-card--single">
        <SettingRow
          icon={Bell}
          tone="sun"
          label="Badge on icon"
          hint="Due cards as a number on the toolbar icon."
          info="The same number the popup shows, recounted when StudyVault starts, when cards change and at your daily time. Chrome has to be running. The icon's tooltip says it in words."
          checked={on}
          testId="reminders-toggle"
          onChange={(next) => toggle.run(next)}
        />
      </div>

      <Card
        title="Daily reminder"
        icon={AlarmClock}
        tone="sun"
        info="At this time the icon shows “!” and the popup and side panel say how many cards are due, until they are done, you dismiss it or the study day ends."
      >
        <fieldset className="opt-fieldset" disabled={!on}>
          <legend className="sv-vh">Daily reminder</legend>
          <div className="opt-timerow">
            <div className="sv-textfield opt-time">
              <label htmlFor={`${uid}-time`}>Remind me at</label>
              <input
                id={`${uid}-time`}
                type="time"
                data-testid="reminders-time"
                value={draft}
                aria-describedby={`${uid}-zone`}
                aria-invalid={draft !== '' && !valid ? true : undefined}
                onChange={(e) => setDraft(e.target.value)}
              />
            </div>
            <Act
              variant="primary"
              icon={Clock}
              busy={saveTime.busy}
              data-testid="reminders-save"
              {...(saveBlocker ? { disabledReason: saveBlocker } : {})}
              onClick={() => void saveTime.run()}
            >
              Set time
            </Act>
            {dailyAt !== null ? (
              <Act
                icon={Trash2}
                busy={removeTime.busy}
                data-testid="reminders-remove"
                onClick={() => void removeTime.run()}
              >
                Remove
              </Act>
            ) : null}
          </div>
          <p id={`${uid}-zone`} className="sv-muted sv-small">
            {on
              ? `Your study time zone${timeZone ? ` (${timeZone})` : ''}, set in Review.`
              : 'Turn on the badge first.'}
          </p>
        </fieldset>
      </Card>

      {dailyAt !== null && on && alarms === false ? (
        <InlineNotice
          tone="warning"
          title="Needs the timer permission"
          action={
            <Button
              busy={allow.busy}
              data-testid="reminders-allow"
              onClick={() => void allow.run()}
            >
              Allow timer
            </Button>
          }
        >
          <p data-testid="reminders-permission-note" className="opt-line">
            {declined ? 'Chrome did not give it. ' : ''}The count on the icon still works.
            <InfoTip label="About the timer permission" align="end">
              Chrome only lets an extension run at a set time with its &ldquo;alarms&rdquo;
              permission. Without it only the daily notice cannot come.
            </InfoTip>
          </p>
        </InlineNotice>
      ) : null}

      <p className="sv-muted sv-small opt-footnote">
        Only while Chrome is running. Never system notifications or email.
      </p>

      {failure ? (
        <InlineNotice tone="error" title="Your change was not saved">
          {failure}
        </InlineNotice>
      ) : null}
    </div>
  );
}
