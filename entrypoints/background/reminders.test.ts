// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultSettings, type Settings } from '@shared';
import { bumpDataEpoch, updateSettings } from '@runtime';
import { createDeck, createManualCards } from '@storage';
import { freshDatabase } from '@storage/test-vault';
import {
  REMINDER_ALARM,
  REMINDER_KEY,
  readReminderFlag,
  writeReminderFlag,
  type BadgeView,
  type ReminderFlag,
} from '@ui/review/reminders';
import { STUDY_SETTINGS_KEY, defaultStudySettings, type StudySettings } from '@ui/review/settings';
import {
  browserReminderDeps,
  createReminderService,
  registerReminders,
  type ReminderDeps,
} from './reminders';

const NOON = Date.UTC(2026, 2, 10, 12, 0, 0); // Tuesday 2026-03-10 12:00 UTC
const NEXT_DAY_STARTS = Date.UTC(2026, 2, 11, 4, 0, 0); // rollover 04:00
const UTC: StudySettings = { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 4 };

function settingsWith(reminders: Settings['reminders'], review = true): Settings {
  const base = defaultSettings();
  return { ...base, features: { ...base.features, review }, reminders };
}

/** The service over in-memory ports: every decision is observable and nothing else is touched. */
function harness(
  init: { settings?: Settings; count?: number; alarms?: boolean; study?: StudySettings } = {},
) {
  const world = {
    now: NOON,
    settings: init.settings ?? settingsWith({ on: true, dailyAt: null }),
    study: init.study ?? UTC,
    count: init.count ?? 0,
    flag: null as ReminderFlag | null,
    alarmsAvailable: init.alarms ?? true,
    alarm: undefined as { scheduledTime: number } | undefined,
    badge: [] as BadgeView[],
    created: [] as number[],
    cleared: 0,
    dueCountCalls: 0,
    shown: undefined as boolean | undefined,
  };
  const deps: ReminderDeps = {
    now: () => world.now,
    looksOn: async () =>
      world.shown ?? (world.settings.reminders.on && world.settings.features.review),
    getSettings: async () => world.settings,
    getStudySettings: async () => world.study,
    dueCount: async () => {
      world.dueCountCalls += 1;
      return world.count;
    },
    defaultTitle: 'StudyVault AI',
    applyBadge: async (view) => {
      world.badge.push(view);
    },
    readBadge: async () => {
      const last = world.badge[world.badge.length - 1];
      return { text: last?.text ?? '', title: last?.title ?? 'StudyVault AI' };
    },
    flag: {
      load: async () => world.flag,
      save: async (f) => {
        world.flag = f;
      },
    },
    alarms: () =>
      world.alarmsAvailable
        ? {
            get: async () => world.alarm,
            create: async (_name, info) => {
              world.created.push(info.when);
              world.alarm = { scheduledTime: info.when };
            },
            clear: async () => {
              world.cleared += 1;
              const had = world.alarm !== undefined;
              world.alarm = undefined;
              return had;
            },
          }
        : null,
  };
  const service = createReminderService(deps);
  return { world, service, last: () => world.badge[world.badge.length - 1] };
}

describe('reminders service: the toolbar count', () => {
  it('does nothing at all while the feature is off', async () => {
    const h = harness({ settings: settingsWith({ on: false, dailyAt: '18:00' }), count: 9 });
    await h.service.refresh();
    expect(h.world.dueCountCalls).toBe(0);
    expect(h.world.badge).toEqual([]);
    expect(h.world.created).toEqual([]);
    expect(h.world.cleared).toBe(0);
  });

  it('a settings change for a person who never used it writes nothing', async () => {
    const h = harness({ settings: settingsWith({ on: false, dailyAt: null }), count: 9 });
    await h.service.onSettings();
    await h.service.onSettings();
    expect(h.world.badge).toEqual([]);
    expect(h.world.cleared).toBe(0);
    expect(h.world.created).toEqual([]);
    expect(h.world.dueCountCalls).toBe(0);
  });

  it('shows the due count, in the tooltip too, and follows it', async () => {
    const h = harness({ count: 3 });
    await h.service.refresh();
    expect(h.last()).toEqual({
      text: '3',
      title: 'StudyVault AI: 3 cards due',
      highlighted: false,
    });
    h.world.count = 1;
    await h.service.refresh();
    expect(h.last()).toMatchObject({ text: '1', title: 'StudyVault AI: 1 card due' });
    h.world.count = 0;
    await h.service.refresh();
    expect(h.last()).toEqual({ text: '', title: 'StudyVault AI', highlighted: false });
  });

  it('caps the number the badge can hold', async () => {
    const h = harness({ count: 4821 });
    await h.service.refresh();
    expect(h.last()?.text).toBe('999+');
    expect(h.last()?.title).toBe('StudyVault AI: 4821 cards due');
  });

  it('works without the alarms permission: the count is there, no alarm is touched', async () => {
    const h = harness({
      settings: settingsWith({ on: true, dailyAt: '18:00' }),
      count: 4,
      alarms: false,
    });
    await h.service.refresh();
    expect(h.last()?.text).toBe('4');
    expect(h.world.created).toEqual([]);
  });

  it('is paused while review is off, and switching it off removes everything', async () => {
    const h = harness({ count: 2 });
    h.world.settings = settingsWith({ on: true, dailyAt: '18:00' });
    await h.service.refresh();
    expect(h.world.alarm).toBeDefined();
    h.world.flag = { at: NOON, expiresAt: NEXT_DAY_STARTS };

    h.world.settings = settingsWith({ on: true, dailyAt: '18:00' }, false);
    await h.service.onSettings();
    expect(h.last()).toEqual({ text: '', title: 'StudyVault AI', highlighted: false });
    expect(h.world.alarm).toBeUndefined();
    expect(h.world.flag).toBeNull();
  });

  it('turning the feature off clears the badge, the notice and the alarm', async () => {
    const h = harness({ settings: settingsWith({ on: true, dailyAt: '07:30' }), count: 6 });
    await h.service.refresh();
    await h.service.onAlarm(REMINDER_ALARM);
    expect(h.last()).toMatchObject({ text: '!', highlighted: true });

    h.world.settings = settingsWith({ on: false, dailyAt: '07:30' });
    await h.service.onSettings();
    expect(h.last()).toEqual({ text: '', title: 'StudyVault AI', highlighted: false });
    expect(h.world.flag).toBeNull();
    expect(h.world.alarm).toBeUndefined();
  });

  it('bursts of events share one pass and one re-run', async () => {
    const h = harness({ count: 5 });
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => h.service.refresh()));
    expect(h.world.dueCountCalls).toBeLessThanOrEqual(2);
    expect(h.last()?.text).toBe('5');
  });
});

describe('reminders service: the daily time', () => {
  it('creates one alarm at the next occurrence in the study time zone, and only once', async () => {
    const h = harness({ settings: settingsWith({ on: true, dailyAt: '18:00' }), count: 2 });
    await h.service.refresh();
    expect(h.world.created).toEqual([Date.UTC(2026, 2, 10, 18, 0, 0)]);
    await h.service.refresh();
    await h.service.refresh();
    expect(h.world.created).toHaveLength(1); // idempotent
  });

  it('moves the alarm when the time or the time zone changes, and removes it with the time', async () => {
    const h = harness({ settings: settingsWith({ on: true, dailyAt: '18:00' }), count: 2 });
    await h.service.refresh();
    h.world.settings = settingsWith({ on: true, dailyAt: '09:15' });
    await h.service.onSettings();
    expect(h.world.alarm?.scheduledTime).toBe(Date.UTC(2026, 2, 11, 9, 15, 0)); // tomorrow, it has passed
    h.world.study = { ...UTC, timeZone: 'America/New_York' };
    await h.service.refresh();
    expect(h.world.alarm?.scheduledTime).toBe(Date.UTC(2026, 2, 10, 13, 15, 0)); // 09:15 EDT today
    h.world.settings = settingsWith({ on: true, dailyAt: null });
    await h.service.onSettings();
    expect(h.world.alarm).toBeUndefined();
    expect(h.last()?.text).toBe('2'); // the count stays
  });

  it('resolves a time that does not exist on a clock-change day to the end of the gap', async () => {
    const h = harness({ settings: settingsWith({ on: true, dailyAt: '02:30' }), count: 1 });
    h.world.study = { ...UTC, timeZone: 'America/Los_Angeles' };
    h.world.now = Date.UTC(2026, 2, 7, 12, 0, 0); // the day before the clocks go forward
    await h.service.refresh();
    expect(h.world.alarm?.scheduledTime).toBe(Date.UTC(2026, 2, 8, 10, 0, 0)); // 03:00 PDT
  });

  it('raises the notice when the alarm fires: "!" and the count in the tooltip, then re-arms', async () => {
    const h = harness({ settings: settingsWith({ on: true, dailyAt: '18:00' }), count: 12 });
    await h.service.refresh();
    expect(h.last()?.text).toBe('12');

    h.world.now = Date.UTC(2026, 2, 10, 18, 0, 0);
    await h.service.onAlarm(REMINDER_ALARM);
    expect(h.last()).toEqual({
      text: '!',
      title: 'StudyVault AI: Time to review: 12 cards due',
      highlighted: true,
    });
    expect(h.world.flag).toEqual({ at: h.world.now, expiresAt: NEXT_DAY_STARTS });
    expect(h.world.alarm?.scheduledTime).toBe(Date.UTC(2026, 2, 11, 18, 0, 0));
  });

  it('raises nothing when nothing is due', async () => {
    const h = harness({ settings: settingsWith({ on: true, dailyAt: '18:00' }), count: 0 });
    await h.service.refresh();
    await h.service.onAlarm(REMINDER_ALARM);
    expect(h.world.flag).toBeNull();
    expect(h.last()?.text).toBe('');
  });

  it('keeps the notice until the cards are done, the study day ends or it is dismissed', async () => {
    const h = harness({ settings: settingsWith({ on: true, dailyAt: '18:00' }), count: 5 });
    await h.service.onAlarm(REMINDER_ALARM);
    expect(h.last()?.text).toBe('!');

    h.world.count = 3; // some were answered: still something to do
    await h.service.refresh();
    expect(h.last()).toMatchObject({
      text: '!',
      title: 'StudyVault AI: Time to review: 3 cards due',
    });

    h.world.flag = null; // dismissed in the popup
    await h.service.refresh();
    expect(h.last()).toMatchObject({ text: '3', highlighted: false });

    await h.service.onAlarm(REMINDER_ALARM);
    expect(h.last()?.text).toBe('!');
    h.world.count = 0; // all done
    await h.service.refresh();
    expect(h.world.flag).toBeNull();
    expect(h.last()?.text).toBe('');

    h.world.count = 2; // new cards fall due later the same day: no new alarm, no new notice
    await h.service.refresh();
    expect(h.last()).toMatchObject({ text: '2', highlighted: false });

    await h.service.onAlarm(REMINDER_ALARM);
    expect(h.last()?.text).toBe('!');
    h.world.now = NEXT_DAY_STARTS; // the study day it was raised in is over
    await h.service.refresh();
    expect(h.world.flag).toBeNull();
    expect(h.last()).toMatchObject({ text: '2', highlighted: false });
  });

  it('ignores alarms that are not its own, and clears one whose time was removed', async () => {
    const h = harness({ settings: settingsWith({ on: true, dailyAt: null }), count: 4 });
    await h.service.onAlarm('sv-sync-periodic');
    expect(h.world.dueCountCalls).toBe(0);

    h.world.alarm = { scheduledTime: NOON + 1000 }; // left over from a time that was removed
    await h.service.onAlarm(REMINDER_ALARM);
    expect(h.world.alarm).toBeUndefined();
    expect(h.world.flag).toBeNull();
    expect(h.world.badge).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The registered worker, over fakeBrowser and a real (fake) IndexedDB
// ---------------------------------------------------------------------------------------------

describe('registerReminders (fakeBrowser, real storage)', () => {
  const badgeText = () => fakeBrowser.action.getBadgeText({});
  const title = () => fakeBrowser.action.getTitle({});

  beforeEach(async () => {
    await freshDatabase();
    fakeBrowser.reset();
    Object.assign(browser.runtime, {
      getManifest: () => ({ version: '1.0.0', action: { default_title: 'StudyVault AI' } }),
    });
    await browser.storage.local.set({ [STUDY_SETTINGS_KEY]: UTC });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function dueCards(n: number): Promise<void> {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards(
      Array.from({ length: n }, (_, i) => ({
        template: 'basic' as const,
        question: `Question ${i}?`,
        answer: `Answer ${i}`,
      })),
      { deckId: deck.id },
    );
  }

  it('a start with the feature off touches neither the toolbar nor the alarms', async () => {
    const setBadge = vi.spyOn(fakeBrowser.action, 'setBadgeText');
    const setTitle = vi.spyOn(fakeBrowser.action, 'setTitle');
    const reminders = registerReminders(browserReminderDeps(), (e) => {
      throw e;
    });
    await reminders.service.refresh();
    await reminders.onPermissionsChanged();
    await reminders.service.onSettings(); // any settings write, e.g. a capture's lastBankId
    expect(setBadge).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
    expect(await fakeBrowser.alarms.getAll()).toEqual([]);
  });

  it('shows the due count at start, follows the data, and clears when switched off', async () => {
    await dueCards(3);
    await updateSettings((s) => ({ ...s, reminders: { on: true, dailyAt: null } }));
    registerReminders(browserReminderDeps(), (e) => {
      throw e;
    });
    await vi.waitFor(async () => expect(await badgeText()).toBe('3'));
    expect(await title()).toBe('StudyVault AI: 3 cards due');

    await createManualCards([{ template: 'basic', question: 'More?', answer: 'Yes' }], {
      deckId: (await createDeck({ name: 'Another' })).id,
    });
    await bumpDataEpoch();
    await vi.waitFor(async () => expect(await badgeText()).toBe('4'));

    await updateSettings((s) => ({ ...s, reminders: { on: false, dailyAt: null } }));
    await vi.waitFor(async () => expect(await badgeText()).toBe(''));
    expect(await title()).toBe('StudyVault AI');
  });

  it('with the permission: one alarm at the daily time; firing it raises the notice', async () => {
    await dueCards(2);
    await updateSettings((s) => ({ ...s, reminders: { on: true, dailyAt: '18:00' } }));
    registerReminders(browserReminderDeps(), (e) => {
      throw e;
    });
    await vi.waitFor(async () => expect(await fakeBrowser.alarms.getAll()).toHaveLength(1));
    const [alarm] = await fakeBrowser.alarms.getAll();
    expect(alarm?.name).toBe(REMINDER_ALARM);
    expect(new Date(alarm!.scheduledTime).getUTCHours()).toBe(18);
    expect(new Date(alarm!.scheduledTime).getUTCMinutes()).toBe(0);

    await fakeBrowser.alarms.onAlarm.trigger({
      name: REMINDER_ALARM,
      scheduledTime: Date.now(),
      persistAcrossSessions: false,
    });
    await vi.waitFor(async () => expect(await badgeText()).toBe('!'));
    expect(await title()).toBe('StudyVault AI: Time to review: 2 cards due');
    expect(await readReminderFlag()).toMatchObject({ at: expect.any(Number) });

    // A dismissal from a popup is a write to the session flag: the count comes back.
    await writeReminderFlag(null);
    expect((await browser.storage.session.get(REMINDER_KEY))[REMINDER_KEY]).toBeUndefined();
    await vi.waitFor(async () => expect(await badgeText()).toBe('2'));
  });

  it('Delete all data (settings cleared) removes the badge and the alarm', async () => {
    await dueCards(2);
    await updateSettings((s) => ({ ...s, reminders: { on: true, dailyAt: '18:00' } }));
    registerReminders(browserReminderDeps(), (e) => {
      throw e;
    });
    await vi.waitFor(async () => expect(await fakeBrowser.alarms.getAll()).toHaveLength(1));
    await vi.waitFor(async () => expect(await badgeText()).toBe('2'));

    // What wipeAllData does to the extension's storage; the database is empty afterwards.
    await freshDatabase();
    await browser.storage.session.clear();
    await browser.storage.local.clear();
    await vi.waitFor(async () => expect(await badgeText()).toBe(''));
    expect(await fakeBrowser.alarms.getAll()).toEqual([]);
  });
});
