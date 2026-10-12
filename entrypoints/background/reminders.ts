import { browser } from 'wxt/browser';
import type { Settings } from '@shared';
import { getSettings, getTrustedSettings } from '@runtime';
import { getDueSummary } from '@storage';
import { nextReminderAt, studyDayNumber, studyDayStartMs } from '@study';
import {
  REMINDER_ALARM,
  REMINDER_KEY,
  badgeView,
  isRaised,
  readReminderFlag,
  writeReminderFlag,
  type BadgeView,
  type ReminderFlag,
} from '@ui/review/reminders';
import { getStudySettings, toBoundary, toClock, type StudySettings } from '@ui/review/settings';

/**
 * Opt-in study reminders in the service worker (docs/adr/019-reminders.md).
 *
 * What it does, when `Settings.reminders.on` and review are both on, and nothing otherwise:
 *  - the toolbar badge shows the number of cards due (the same number the popup shows). It needs no
 *    permission and is refreshed at every worker start and every data or study-settings change;
 *  - with a daily time AND the optional "alarms" permission, one alarm wakes the worker at that wall
 *    clock time (study time zone): the badge turns to "!" and the popup and side panel say "Time to
 *    review: N cards due" until the study day ends, the cards are done or the person dismisses it.
 *
 * Everything is a function of persisted state (settings, database, one session flag), so a worker
 * that was suspended behaves like one that never stopped. No system notifications, no network.
 */

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

export interface ReminderAlarms {
  get(name: string): Promise<{ scheduledTime: number } | undefined>;
  create(name: string, info: { when: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
}

export interface ReminderDeps {
  now(): number;
  /**
   * A cheap guess whether the feature is on, from the copy of the settings a content script can
   * write and without opening the database. It only decides whether to look at all: a planted
   * value can make the worker skip a refresh or do one for nothing, never show anything false.
   */
  looksOn(): Promise<boolean>;
  /** The AUTHORITATIVE settings (never the copy a content script can write). */
  getSettings(): Promise<Settings>;
  getStudySettings(): Promise<StudySettings>;
  /** Cards the review page would offer right now under today's caps. */
  dueCount(study: StudySettings): Promise<number>;
  /** The extension's normal tooltip. */
  defaultTitle: string;
  applyBadge(view: BadgeView): Promise<void>;
  /** What the toolbar says now, to leave it alone when there is nothing of ours on it. */
  readBadge(): Promise<{ text: string; title: string }>;
  flag: {
    load(): Promise<ReminderFlag | null>;
    save(flag: ReminderFlag | null): Promise<void>;
  };
  /** Looked up per call: "alarms" is optional and may be granted while the worker runs. */
  alarms(): ReminderAlarms | null;
}

interface RunOptions {
  /** Settings changed: when the feature is off, remove the badge, the flag and the alarm. */
  clear: boolean;
  /** The daily time came. */
  raise: boolean;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export function createReminderService(deps: ReminderDeps) {
  const active = (s: Settings) => s.reminders.on && s.features.review;

  /** One pass: make the badge, the flag and the alarm agree with the settings and the database. */
  async function pass(o: RunOptions): Promise<void> {
    const settings = await deps.getSettings();
    const alarms = deps.alarms();
    if (!active(settings)) {
      // Only a settings change clears: a worker that merely started must not touch the toolbar.
      if (!o.clear) return;
      // And only what is there: every settings write (a capture changes `lastBankId`) arrives here
      // for a person who never turned the feature on, who gets no write at all.
      const shown = await deps.readBadge();
      if (shown.text !== '' || shown.title !== deps.defaultTitle) {
        await deps.applyBadge(
          badgeView({ count: 0, raised: false, defaultTitle: deps.defaultTitle }),
        );
      }
      if ((await deps.flag.load()) !== null) await deps.flag.save(null);
      if (alarms && (await alarms.get(REMINDER_ALARM).catch(() => null))) {
        await alarms.clear(REMINDER_ALARM).catch(() => false);
      }
      return;
    }

    const study = await deps.getStudySettings();
    const boundary = toBoundary(study);
    const now = deps.now();
    const count = await deps.dueCount(study);

    // A notice counts while something is due and until the study day it was raised in ends.
    let flag = await deps.flag.load();
    const dailyAt = settings.reminders.dailyAt;
    if (o.raise && dailyAt !== null && count > 0) {
      flag = { at: now, expiresAt: studyDayStartMs(studyDayNumber(now, boundary) + 1, boundary) };
      await deps.flag.save(flag);
    } else if (flag !== null && (count === 0 || !isRaised(flag, now))) {
      flag = null;
      await deps.flag.save(null);
    }
    await deps.applyBadge(
      badgeView({ count, raised: flag !== null, defaultTitle: deps.defaultTitle }),
    );

    // The alarm is created only when the permission already exists: asking is the settings page's
    // job, from a click. Creating again with the same time is skipped, so this is idempotent.
    if (!alarms) return;
    if (dailyAt === null) {
      await alarms.clear(REMINDER_ALARM).catch(() => false);
      return;
    }
    const when = nextReminderAt(now, boundary.timeZone, dailyAt);
    // The API object can outlive the permission with every call refusing: that is "no alarms".
    const existing = await alarms.get(REMINDER_ALARM).then(
      (found) => found ?? null,
      () => undefined,
    );
    if (existing === undefined) return;
    if (existing?.scheduledTime !== when) await alarms.create(REMINDER_ALARM, { when });
  }

  // Bursts of events (a bulk edit bumps the data epoch many times) share one pass and one re-run.
  let inFlight: Promise<void> | null = null;
  let waiting: RunOptions | null = null;
  const merge = (a: RunOptions | null, b: RunOptions): RunOptions => ({
    clear: (a?.clear ?? false) || b.clear,
    raise: (a?.raise ?? false) || b.raise,
  });

  function request(o: Partial<RunOptions> = {}): Promise<void> {
    const wanted = merge(null, { clear: false, raise: false, ...o });
    if (inFlight) {
      waiting = merge(waiting, wanted);
      return inFlight;
    }
    const take = (): RunOptions | null => {
      const next = waiting;
      waiting = null;
      return next;
    };
    inFlight = (async () => {
      let next: RunOptions | null = wanted;
      while (next) {
        await pass(next);
        next = take();
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    /**
     * Worker start, a permission change, a data or study-settings change, a dismissed notice. With
     * the feature off this reads one key of chrome.storage.local and nothing else.
     */
    async refresh(): Promise<void> {
      if (await deps.looksOn()) await request();
    },
    /** `Settings` changed (the feature was switched, the time was edited, review was turned off). */
    onSettings: () => request({ clear: true }),
    /** The alarm fired. Anything else is not ours. */
    async onAlarm(name: string): Promise<void> {
      if (name !== REMINDER_ALARM) return;
      const settings = await deps.getSettings();
      if (!active(settings) || settings.reminders.dailyAt === null) {
        // A leftover of a time that was removed, or of a feature that was switched off.
        await deps
          .alarms()
          ?.clear(REMINDER_ALARM)
          .catch(() => false);
        return;
      }
      await request({ raise: true });
    },
  };
}

export type ReminderService = ReturnType<typeof createReminderService>;

// ---------------------------------------------------------------------------------------------
// Chrome adapters and registration
// ---------------------------------------------------------------------------------------------

/** Calm blue for the count, warm amber for "!": both keep 4.5:1 against the white badge text. */
const CALM = '#1d4ed8';
const WARM = '#b45309';

export function browserReminderDeps(): ReminderDeps {
  const defaultTitle = browser.runtime.getManifest().action?.default_title ?? 'StudyVault AI';
  return {
    now: () => Date.now(),
    looksOn: async () => {
      const shown = await getSettings();
      return shown.reminders.on && shown.features.review;
    },
    getSettings: getTrustedSettings,
    getStudySettings,
    dueCount: async (study) => (await getDueSummary(toClock(study))).total.total,
    defaultTitle,
    applyBadge: async (view) => {
      // The badge is not read by assistive technology, so the tooltip carries the same words.
      await browser.action.setBadgeBackgroundColor({ color: view.highlighted ? WARM : CALM });
      await browser.action.setBadgeText({ text: view.text });
      await browser.action.setTitle({ title: view.title });
    },
    readBadge: async () => ({
      text: await browser.action.getBadgeText({}),
      title: (await browser.action.getTitle({})) || defaultTitle,
    }),
    flag: { load: readReminderFlag, save: writeReminderFlag },
    alarms: () => {
      const api = browser.alarms as typeof browser.alarms | undefined;
      if (!api) return null;
      return {
        get: async (name) => (await api.get(name)) ?? undefined,
        create: async (name, info) => {
          await api.create(name, info);
        },
        clear: (name) => api.clear(name),
      };
    },
  };
}

/**
 * Top-level listener registration (call synchronously from the background entry point). Reading
 * anything is deferred to the first event; a start with the feature off only reads the settings.
 */
export function registerReminders(
  deps: ReminderDeps = browserReminderDeps(),
  report: (err: unknown) => void = (err) => console.error('[StudyVault] reminders', err),
) {
  const service = createReminderService(deps);

  // Chrome only remembers listeners added during the worker's initial evaluation: with the optional
  // permission already held it is added here and wakes a stopped worker. In the lifetime in which
  // the permission is granted `chrome.alarms` did not exist yet, so it is added when the grant is
  // noticed; that one dies with the worker (docs/adr/010-module-seams.md, amendment 3, decision 2).
  // Remembered by event object, not by a flag: if Chrome binds a new one after the permission was
  // taken away and given again, the new one needs its own listener.
  let listeningOn: unknown = null;
  const listen = () => {
    const api = browser.alarms as typeof browser.alarms | undefined;
    if (!api || listeningOn === api.onAlarm) return;
    listeningOn = api.onAlarm;
    api.onAlarm.addListener((alarm) => {
      service.onAlarm(alarm.name).catch(report);
    });
  };
  listen();

  // The payload of a storage event is writable by content scripts: nothing is read from it, the
  // authoritative settings and the database are read again.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if ('settings' in changes) service.onSettings().catch(report);
      else if ('dataEpoch' in changes || 'studySettings' in changes)
        service.refresh().catch(report);
    } else if (area === 'session' && REMINDER_KEY in changes) {
      service.refresh().catch(report); // dismissed in a popup or the side panel
    }
  });

  // Worker start covers a browser start, an install, an update and a reload: the badge and the
  // alarm do not survive those, and a start with the feature off reads nothing but the settings.
  service.refresh().catch(report);

  return {
    service,
    /** Permissions changed (granted or taken away): look again at the alarm. */
    async onPermissionsChanged(): Promise<void> {
      listen();
      await service.refresh();
    },
  };
}
