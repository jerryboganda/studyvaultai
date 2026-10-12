import type { Page } from '@playwright/test';
import { bgData, errorsOf, openExt, test, type Env } from './helpers.pages';
import { stopWorker, wakeWorker, workerState } from './helpers.lifecycle';
import {
  answerWith,
  createBasicCards,
  expectDue,
  gotoTab,
  openReview,
  startAll,
} from './helpers.review';
import {
  ALARM_NAME,
  DEFAULT_TITLE,
  alarmsOf,
  expect,
  expectAccessible,
  holdsAlarmsPermission,
  noticeFlag,
  openReminderSettings,
  section,
  statusOf,
  storedReminders,
  switchOf,
  toolbar,
  utcTime,
} from './helpers.reminders';

test.describe.configure({ timeout: 240_000 });

/**
 * Opt-in study reminders (docs/adr/019-reminders.md) in a real loaded extension: the toolbar count
 * that follows the due cards, the daily time and its optional "alarms" permission, the notice in
 * the popup and side panel, and Delete all data.
 *
 * What is REAL: the settings page controls, Chrome's `chrome.permissions` (the optional "alarms"
 * permission is granted without a prompt in this build, as in sync.spec.ts), the worker's real
 * `chrome.action` badge, real `chrome.alarms`, real review answers. What is not: the wall clock
 * does not reach the daily time (nobody waits for 07:30), so the alarm that fires is one the test
 * creates under the extension's own alarm name, a few seconds ahead; every other step is the
 * worker's own code.
 */

const CARDS = [
  ['What does stroke volume measure?', 'Blood ejected by a ventricle per beat.'],
  ['What is cardiac output?', 'Heart rate multiplied by stroke volume.'],
  ['What is preload?', 'Ventricular wall stretch at the end of filling.'],
] as const;

const UTC_DAY = { timeZone: 'UTC', rolloverHour: 4 } as const;
const DAY = 86_400_000;

/** A review page with three cards due, the study day pinned to UTC so a time of day is exact. */
async function withThreeDueCards(env: Env): Promise<Page> {
  const review = await openReview(env, { settings: UTC_DAY });
  await createBasicCards(review, CARDS);
  await gotoTab(review, 'Study');
  await expectDue(review, 3);
  return review;
}

const cardsDue = (n: number) => ({ text: String(n), title: `${DEFAULT_TITLE}: ${n} cards due` });

/** Set a daily time through the page: the click that asks Chrome for the timer permission. */
async function setDailyTime(options: Page, time: string): Promise<void> {
  await section(options).getByTestId('reminders-time').fill(time);
  await section(options).getByTestId('reminders-save').click();
}

test.describe('the toolbar count', () => {
  test('is off until asked, then shows the number of cards due, follows an answer, and clears when switched off', async ({
    env,
  }) => {
    const review = await withThreeDueCards(env);
    const options = await openReminderSettings(env);

    // Off by default: nothing on the icon, nothing stored, nothing scheduled, no permission asked.
    expect(await toolbar(options)).toEqual({ text: '', title: DEFAULT_TITLE });
    await expect(switchOf(options)).not.toBeChecked();
    expect(await storedReminders(options)).toEqual({ on: false, dailyAt: null });
    await expect(statusOf(options)).toContainText('Toolbar count: off.');
    expect(await holdsAlarmsPermission(options)).toBe(false);

    // On: the number the popup would show, in words in the tooltip, and no permission was needed.
    await switchOf(options).check();
    await expect.poll(() => toolbar(options)).toEqual(cardsDue(3));
    await expect(switchOf(options)).not.toHaveAttribute('aria-busy', 'true');
    await expect(statusOf(options)).toContainText('Toolbar count: on.');
    expect(await storedReminders(options)).toEqual({ on: true, dailyAt: null });
    expect(await holdsAlarmsPermission(options)).toBe(false);
    expect(await alarmsOf(options)).toEqual([]);

    // It follows the data: an easy answer sends a card days away, and the icon says two.
    await review.bringToFront();
    await startAll(review);
    await answerWith(review, 4);
    await expect.poll(() => toolbar(options)).toEqual(cardsDue(2));

    // Off again: the icon, the tooltip and the stored choice all go back.
    await options.bringToFront();
    await switchOf(options).uncheck();
    await expect.poll(() => toolbar(options)).toEqual({ text: '', title: DEFAULT_TITLE });
    expect(await storedReminders(options)).toMatchObject({ on: false });
    expect(errorsOf(options)).toEqual([]);
  });

  test('review being turned off pauses the count and keeps the choice', async ({ env }) => {
    await withThreeDueCards(env);
    const options = await openReminderSettings(env);
    await switchOf(options).check();
    await expect.poll(() => toolbar(options)).toEqual(cardsDue(3));

    // Review off: the count and the section go quiet, and the stored choice is kept.
    await options.getByRole('checkbox', { name: 'Show review in StudyVault' }).uncheck();
    await expect.poll(() => toolbar(options)).toEqual({ text: '', title: DEFAULT_TITLE });
    await expect(options.getByText(/paused until review is back on/)).toBeVisible();
    expect(await storedReminders(options)).toEqual({ on: true, dailyAt: null });

    await options.getByRole('checkbox', { name: 'Show review in StudyVault' }).check();
    await expect.poll(() => toolbar(options)).toEqual(cardsDue(3));
  });
});

test.describe('the daily time', () => {
  test('is set from a click that asks Chrome for the timer permission; when it comes, the icon, the popup and the side panel say what is due, and Dismiss clears every one', async ({
    env,
  }) => {
    await withThreeDueCards(env);
    const options = await openReminderSettings(env);
    await switchOf(options).check();
    await expect.poll(() => toolbar(options)).toEqual(cardsDue(3));
    expect(await holdsAlarmsPermission(options)).toBe(false);

    await setDailyTime(options, '07:30');
    await expect.poll(() => holdsAlarmsPermission(options)).toBe(true);
    await expect
      .poll(async () => (await alarmsOf(options)).map((a) => a.name))
      .toEqual([ALARM_NAME]);
    const [alarm] = await alarmsOf(options);
    expect(utcTime(alarm!.scheduledTime)).toBe('07:30');
    expect(alarm!.scheduledTime).toBeGreaterThan(Date.now());
    expect(alarm!.scheduledTime - Date.now()).toBeLessThanOrEqual(DAY);
    expect(await storedReminders(options)).toEqual({ on: true, dailyAt: '07:30' });
    await expect(statusOf(options)).toContainText('Daily reminder: 07:30 (UTC), next ');

    // The worker that handled the grant is stopped and started again by a message: only a listener
    // added during a worker's initial evaluation is one Chrome remembers across stops
    // (docs/adr/010-module-seams.md, amendment 3). Stopped again, only the alarm can wake it.
    await stopWorker(env.context, env.extensionId, options);
    await wakeWorker(options, env.context, env.extensionId);
    await stopWorker(env.context, env.extensionId, options);
    expect(await workerState(env.context, env.extensionId)).toBeNull();
    await options.evaluate(
      (name) => chrome.alarms.create(name, { when: Date.now() + 1500 }),
      ALARM_NAME,
    );

    // The alarm woke it; the icon says "!" and the tooltip says it in words.
    await expect
      .poll(() => toolbar(options), {
        timeout: 45_000,
        message: 'the alarm should raise the notice',
      })
      .toEqual({ text: '!', title: `${DEFAULT_TITLE}: Time to review: 3 cards due` });
    expect(await noticeFlag(options)).toMatchObject({ at: expect.any(Number) });
    // The next one is already set: the worker re-armed the alarm for the same time of day.
    await expect
      .poll(async () => (await alarmsOf(options)).map((a) => utcTime(a.scheduledTime)))
      .toEqual(['07:30']);

    const popup = await openExt(env, 'popup');
    await expect(popup.getByTestId('popup-due')).toBeVisible();
    await expect(popup.getByText('Time to review: 3 cards due')).toBeVisible();
    await expectAccessible(popup, '.popup__study', 'popup with the daily notice');
    const panel = await openExt(env, 'sidepanel');
    await expect(panel.getByText('Time to review: 3 cards due')).toBeVisible();
    await expectAccessible(panel, '.panel__reminder', 'side panel with the daily notice');

    // Dismissed in one place, gone in every place, and the icon is a plain count again.
    await popup.getByRole('button', { name: 'Dismiss' }).click();
    await expect(popup.getByText(/Time to review/)).toHaveCount(0);
    await expect(panel.getByText(/Time to review/)).toHaveCount(0);
    await expect.poll(() => toolbar(options)).toEqual(cardsDue(3));
    expect(await noticeFlag(options)).toBeUndefined();
    expect(errorsOf(popup)).toEqual([]);
    expect(errorsOf(panel)).toEqual([]);
  });

  test('without the permission the count still works and the page says why the time is idle; allowing it brings the alarm', async ({
    env,
  }) => {
    await withThreeDueCards(env);
    const options = await openReminderSettings(env);
    await switchOf(options).check();
    await setDailyTime(options, '18:15');
    await expect.poll(async () => (await alarmsOf(options)).length).toBe(1);
    await expectAccessible(
      options,
      '[data-testid="reminders-section"]',
      'time set, permission held',
    );

    // Chrome (or the person, on the extension's details page) takes the permission away.
    await options.evaluate(() => chrome.permissions.remove({ permissions: ['alarms'] }));
    const note = section(options).getByTestId('reminders-permission-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('only lets an extension run at a set time');
    await expect(statusOf(options)).toContainText('18:15 is saved but not active');
    expect(await alarmsOf(options)).toEqual([]);
    expect(await toolbar(options)).toEqual(cardsDue(3)); // the count needs no permission
    expect(await storedReminders(options)).toEqual({ on: true, dailyAt: '18:15' });
    await expectAccessible(
      options,
      '[data-testid="reminders-section"]',
      'time set, permission missing',
    );

    // From its own button: Chrome grants it, the note goes, the worker sets the alarm again.
    await section(options).getByTestId('reminders-allow').click();
    await expect(note).toHaveCount(0);
    await expect
      .poll(async () => (await alarmsOf(options)).map((a) => utcTime(a.scheduledTime)))
      .toEqual(['18:15']);

    // Removing the time takes the alarm with it and leaves the count.
    await section(options).getByTestId('reminders-remove').click();
    await expect.poll(() => alarmsOf(options)).toEqual([]);
    expect(await storedReminders(options)).toEqual({ on: true, dailyAt: null });
    expect(await toolbar(options)).toEqual(cardsDue(3));
  });
});

test.describe('Delete all data', () => {
  test('clears the icon, the notice, the alarm and the choice', async ({ env }) => {
    await withThreeDueCards(env);
    const options = await openReminderSettings(env);
    await switchOf(options).check();
    await setDailyTime(options, '07:30');
    await expect.poll(async () => (await alarmsOf(options)).length).toBe(1);
    // The daily time "came": the same flag the worker raises, written where the worker listens.
    await options.evaluate(() =>
      chrome.storage.session.set({
        reminderDue: { at: Date.now(), expiresAt: Date.now() + 3_600_000 },
      }),
    );
    await expect
      .poll(() => toolbar(options))
      .toEqual({ text: '!', title: `${DEFAULT_TITLE}: Time to review: 3 cards due` });

    await options.getByRole('button', { name: /^Delete all StudyVault data/ }).click();
    await options
      .getByRole('dialog', { name: 'Delete all StudyVault data?' })
      .getByRole('button', { name: 'Delete everything' })
      .click();
    await expect(
      options.getByText(/All StudyVault data was deleted from this device/),
    ).toBeVisible();

    await expect.poll(() => toolbar(options)).toEqual({ text: '', title: DEFAULT_TITLE });
    await expect.poll(() => alarmsOf(options)).toEqual([]);
    expect(await noticeFlag(options)).toBeUndefined();
    expect(await holdsAlarmsPermission(options)).toBe(false);
    expect(await storedReminders(options)).toEqual({ on: false, dailyAt: null });

    // A fresh start of the page: still off, and no count comes back by itself.
    await options.reload();
    await expect(switchOf(options)).not.toBeChecked();
    await bgData(options, 'banks.list');
    expect(await toolbar(options)).toEqual({ text: '', title: DEFAULT_TITLE });
  });
});
