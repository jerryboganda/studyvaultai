# ADR-019: Opt-in study reminders

**Status:** accepted · **Date:** 2026-10-11 · Refines ADR-003 (least privilege), ADR-009 (what the
optional `alarms` permission is for) and ADR-010 (amendment 3, decision 2: the worker's `onAlarm`
listener).

## Context
Spaced review only works if the learner comes back. The extension may not read history, may not
require more permissions at install, and works with no account or network. A reminder therefore has
to be (a) off until asked for, (b) built from what is already there, and (c) honest about what an MV3
extension cannot do: a service worker is suspended after seconds, and nothing runs while the browser
is closed.

## Decision
Two independent parts, both inside the extension, both off by default.

### 1. The toolbar count (no permission)
`Settings.reminders.on` (`packages/shared/src/settings.ts`; default `false`). While it and
`features.review` are on, the service worker sets the action badge to the number of cards due, and
the action tooltip (`action.setTitle`) to the same information in words ("StudyVault AI: 12 cards
due"), because the badge text is not read by assistive technology.

- The number is `getDueSummary(toClock(studySettings)).total.total`: the function the popup, the side
  panel and the review page use, so the icon and the popup cannot disagree. It reads only the cards
  that can be due today (an index range).
- It is refreshed at every worker start and on every `dataEpoch`, `studySettings` and `settings`
  change (`entrypoints/background/reminders.ts`), through one single-flight pass with a re-run flag
  (a bulk edit bumps the epoch many times).
- Nothing is read at start while the feature is off beyond one key of `chrome.storage.local`
  (`looksOn`, the display copy: it can only make the worker skip or do a refresh, never show
  something false). A worker that merely started never touches the toolbar; only a settings change
  clears it.
- Colours: calm blue for the count, warm amber for "!" (both 4.5:1 against the white badge text).
  The badge is capped at `999+`.

### 2. The daily time (optional `alarms` permission)
`Settings.reminders.dailyAt` is `"HH:MM"` or `null`, a wall-clock time **in the study time zone**
(`studySettings.timeZone`), so one setting says where a day starts and when the reminder comes.

- `nextReminderAt(now, timeZone, "HH:MM")` (`packages/study/src/time.ts`) is pure. It reuses the
  study-day machinery (`wallClockToMs`, factored out of `studyDayStartMs`): a time that does not exist
  on a spring-forward day is the instant the gap ends; a time that happens twice on a fall-back day
  is its first occurrence, and the second is skipped. Exactly one reminder per calendar day, tested
  over 400 days in six zones.
- One alarm, `sv-reminder`, created with `when`. Creation is idempotent (skipped when the existing
  alarm already has that time) and happens only when `chrome.alarms` already exists.
- The permission is requested by the settings page, from the click that saves the time
  (`permissions.request` is the first await of the handler). Declining keeps the time, says why it is
  idle (Chrome only lets an extension run at a set time with `alarms`) and offers "Allow the timer
  permission". Nothing else asks for it; sync asks for the same permission for its own timer and
  neither feature needs the other.
- When the alarm fires the worker raises a **notice**: a flag `{ at, expiresAt }` in
  `chrome.storage.session` (key `reminderDue`; memory only, trusted contexts only). `expiresAt` is
  the end of the study day it was raised in. Only raised when something is due. The badge becomes
  "!" with the tooltip "Time to review: N cards due", and the popup and the side panel show the same
  sentence with a Dismiss button (`ReminderNotice`, live region). Any page can dismiss (a write to
  the session flag); every other context and the worker follow through `storage.onChanged`.
- The notice ends when: Dismiss; the due count reaches 0; the study day ends. New cards falling due
  later the same day do not raise it again: only the alarm does.
- The alarm is cleared when the feature or review is switched off, when the time is removed, and by
  "Delete all data" (which already clears every alarm and gives `alarms` back). Taking the
  permission away elsewhere leaves the count working; the settings page notices through
  `permissions.onRemoved` and says the time is idle.

### What it does not do
- **No `notifications` permission and no system notification in this release.** The notice lives in
  StudyVault's own surfaces.
- No reminder while Chrome is closed, and no catching up afterwards beyond what Chrome does for a
  missed alarm.
- No network, no account, nothing synchronised (`Settings` is not part of sync or of a backup,
  ADR-010).

## Storage
`Settings.reminders` is a new top-level object, not a member of `features`: `parseSettings` falls a
whole object back to its default when one member is invalid, and `features` carries the AI and sync
switches, which a damaged reminder time must not reset. `reminders` is parsed member by member, so a
bad `dailyAt` keeps `on` and the reverse. Older stored settings have no such key and read as the
default (off). `schemaVersion` stays 1. The session flag is derived data and leaves with the browser
session.

## Interplay worth knowing
- **Tab-scoped capture feedback.** The "saved" check mark (`createBadgePort` in `platform.ts`) is
  tab-scoped and a tab-scoped value, even an empty one, hides the global badge until the tab
  navigates. After three seconds it now puts back the global text, colour and tooltip instead of
  blanking the tab. Limit: on that one tab the count shown is the one at that moment until the next
  navigation; the popup always shows the live number.
- **The `onAlarm` listener** follows ADR-010 amendment 3, decision 2. It is added during the worker's
  initial evaluation when `chrome.alarms` exists then, and (best effort, once per event object)
  when the grant is noticed in `permissions.onAdded`, which works for as long as that worker lives.
  A worker that is stopped is woken by the alarm only after it has started once for another reason
  since the grant. Consequence: after the grant, the first daily notice can be missed until a
  StudyVault page is opened or the browser is restarted.
- **Badge staleness.** Cards that become due by the passing of time are counted at the next worker
  start, data change or daily time, not at the minute. A periodic alarm would fix that at the price
  of waking the worker every half hour for every user of the feature and of using `alarms` for a
  count that needs no permission; rejected. The popup and the side panel always show the live number.

## Consequences
- Size, from private e2e builds that differ only by the feature (the same tree built three times:
  with it, without the worker registration, without the three UI uses): the worker +11,762 B
  (`getDueSummary` brings the queue builder, 6.2 KB before minification; ts-fsrs, Dexie and zod were
  already there), the pages +7,868 B. The settings section is a separate lazy chunk
  (`Reminders-*.js`), so the settings page itself does not grow at start. Small additions after that
  measurement (a read of the current badge, a clock hook, longer permission copy) are well under 1 KB.
- New copy that must stay true: the toolbar count needs no permission; the daily time needs
  `alarms`, asked from the click that saves it; the browser must be running; no system notifications.

## Tests
- `packages/study/src/reminders.test.ts`: next occurrence, strictly-after, DST in Los Angeles,
  Berlin and Auckland, one per calendar day for 400 days, invalid input.
- `packages/shared/src/settings.test.ts`: default off, settings stored without the key, damaged
  members fall back by themselves.
- `entrypoints/background/reminders.test.ts`: the service over in-memory ports (off does nothing,
  count and tooltip, cap, no permission, alarm idempotence and moves, DST gap, raise, expiry,
  dismiss, foreign and stale alarms, bursts) and the registered worker over `fakeBrowser` with a real
  IndexedDB (start, data change, switch off, alarm, dismissal, settings cleared by "Delete all data").
- `entrypoints/background/commands.test.ts`: the capture badge puts back the global count.
- `entrypoints/options/Reminders.test.tsx`, `entrypoints/popup/Reminder.test.tsx`,
  `entrypoints/sidepanel/SidePanel.features.test.tsx` ("daily review notice").
- `tests/e2e/reminders.spec.ts` (loaded extension): off by default; count equals the due cards and
  follows an answer; review off pauses it; the daily time with the permission granted from the click;
  the alarm waking a stopped worker, the popup and side panel notice and Dismiss; the permission
  taken away and given back; Delete all data.

## Not verified here
Branded Chrome or Edge; a real wall-clock daily time (the e2e creates the alarm under the
extension's own name a few seconds ahead); the badge colours and tooltip in the operating system's
toolbar (read back through `chrome.action`, not looked at); screen-reader announcement of the notice
(live region by code and axe only).
