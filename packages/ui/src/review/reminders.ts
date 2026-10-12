import { browser } from 'wxt/browser';

/**
 * Study reminders: what the service worker and the pages share (docs/adr/019-reminders.md). No React
 * and no storage layer on purpose: the worker imports this file.
 *
 * A reminder is an in-extension notice, never a system notification. Two things carry it:
 *  - the toolbar badge (set by the worker): the number of cards due, or "!" once the daily time came;
 *  - one small flag in `chrome.storage.session` (memory only, trusted contexts only), read by the
 *    popup and the side panel to show "Time to review: N cards due".
 */

/** `chrome.storage.session` key of the flag. It is gone when the browser closes, by design. */
export const REMINDER_KEY = 'reminderDue';

/** The name of the one alarm the feature owns (the optional "alarms" permission). */
export const REMINDER_ALARM = 'sv-reminder';

export interface ReminderFlag {
  /** When the daily time came (epoch ms). */
  at: number;
  /** When it stops counting: the end of the study day it was raised in (epoch ms). */
  expiresAt: number;
}

export function parseReminderFlag(raw: unknown): ReminderFlag | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { at, expiresAt } = raw as Record<string, unknown>;
  return typeof at === 'number' && Number.isFinite(at) && typeof expiresAt === 'number'
    ? { at, expiresAt }
    : null;
}

/** A flag counts until the study day it was raised in ends. */
export const isRaised = (flag: ReminderFlag | null, now: number): flag is ReminderFlag =>
  flag !== null && now < flag.expiresAt;

const cards = (count: number): string => `${count} ${count === 1 ? 'card' : 'cards'}`;

/** The one sentence used by the notice and by the icon's tooltip. */
export const reminderText = (count: number): string => `Time to review: ${cards(count)} due`;

/** The badge holds about four characters. */
export const BADGE_MAX = 999;

export interface BadgeView {
  /** Empty clears the badge. */
  text: string;
  /** The tooltip: the badge is not read by assistive technology, this is. */
  title: string;
  /** The "!" state: drawn in the warm colour instead of the calm one. */
  highlighted: boolean;
}

/**
 * What the toolbar icon says. Nothing is invented: the number is the database's own due count, and
 * with nothing due the badge is empty and the tooltip is the extension's normal one.
 */
export function badgeView(o: { count: number; raised: boolean; defaultTitle: string }): BadgeView {
  if (o.count <= 0) return { text: '', title: o.defaultTitle, highlighted: false };
  if (o.raised) {
    return {
      text: '!',
      title: `${o.defaultTitle}: ${reminderText(o.count)}`,
      highlighted: true,
    };
  }
  return {
    text: o.count > BADGE_MAX ? `${BADGE_MAX}+` : String(o.count),
    title: `${o.defaultTitle}: ${cards(o.count)} due`,
    highlighted: false,
  };
}

export async function readReminderFlag(): Promise<ReminderFlag | null> {
  return parseReminderFlag((await browser.storage.session.get(REMINDER_KEY))[REMINDER_KEY]);
}

export async function writeReminderFlag(flag: ReminderFlag | null): Promise<void> {
  if (flag) await browser.storage.session.set({ [REMINDER_KEY]: flag });
  else await browser.storage.session.remove(REMINDER_KEY);
}

/** Subscribe to the flag from any context. Returns the unsubscribe function. */
export function watchReminderFlag(onChange: (flag: ReminderFlag | null) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'session' && REMINDER_KEY in changes) {
      onChange(parseReminderFlag(changes[REMINDER_KEY]?.newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
