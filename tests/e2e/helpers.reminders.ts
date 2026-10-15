import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { settleAnimations } from './axeSettle';
import { expect } from './helpers.review';
import { openExt, type Env } from './helpers.pages';

export { expect };

/**
 * Helpers for reminders.spec.ts: the opt-in toolbar count and daily notice (docs/adr/019). Real
 * Chromium, the real built extension. The toolbar is read through `chrome.action` from an extension
 * page (the only way to see a badge in headless Chromium); alarms through `chrome.alarms`.
 */

/** The extension's own tooltip, as the manifest declares it. */
export const DEFAULT_TITLE = 'StudyVault AI';
export const ALARM_NAME = 'sv-reminder';

export const section = (page: Page): Locator => page.getByTestId('reminders-section');
export const statusOf = (page: Page): Locator => section(page).getByTestId('reminders-status');
/** One line of the status list ("Badge", "Daily time"): its value. */
export const statusItem = (page: Page, term: 'Badge' | 'Daily time'): Locator =>
  statusOf(page)
    .locator('div')
    .filter({ has: page.getByRole('term').filter({ hasText: term }) })
    .getByRole('definition');
export const switchOf = (page: Page): Locator =>
  section(page).getByRole('checkbox', { name: 'Badge on icon', exact: true });

/** Show one settings view (`options.html#<id>`): only the current view is mounted. */
export async function gotoSettings(page: Page, env: Env, view: string): Promise<void> {
  await page.goto(`chrome-extension://${env.extensionId}/options.html#${view}`);
}

/** The settings page's Reminders view, loaded far enough that the reminders section is showing. */
export async function openReminderSettings(env: Env): Promise<Page> {
  const page = await openExt(env, 'options');
  await gotoSettings(page, env, 'reminders');
  await expect(page.getByRole('heading', { name: 'Reminders', level: 1 })).toBeVisible();
  await expect(section(page)).toBeVisible();
  return page;
}

export interface Toolbar {
  text: string;
  title: string;
}

/** What the toolbar icon says for tabs that have no value of their own (the global badge). */
export async function toolbar(page: Page): Promise<Toolbar> {
  return page.evaluate(async () => ({
    text: await chrome.action.getBadgeText({}),
    title: await chrome.action.getTitle({}),
  }));
}

/** The reminders choice exactly as stored (the defaults while nothing was ever written). */
export async function storedReminders(
  page: Page,
): Promise<{ on: boolean; dailyAt: string | null }> {
  return page.evaluate(async () => {
    const got = await chrome.storage.local.get('settings');
    const settings = got.settings as { reminders?: { on: boolean; dailyAt: string | null } };
    return settings?.reminders ?? { on: false, dailyAt: null };
  });
}

export interface AlarmInfo {
  name: string;
  scheduledTime: number;
}

/**
 * The extension's alarms. Empty once the `alarms` permission is gone: the namespace may be missing
 * (Windows) or present with every method throwing "not available in this context" (Linux).
 */
export async function alarmsOf(page: Page): Promise<AlarmInfo[]> {
  return page.evaluate(async () => {
    try {
      if (!chrome.alarms) return [];
      return (await chrome.alarms.getAll())
        .map((a) => ({ name: a.name, scheduledTime: a.scheduledTime }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  });
}

export async function holdsAlarmsPermission(page: Page): Promise<boolean> {
  return page.evaluate(() => chrome.permissions.contains({ permissions: ['alarms'] }));
}

/** "HH:MM" of an instant in UTC. */
export const utcTime = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/** The flag the worker raises (chrome.storage.session), or undefined. */
export async function noticeFlag(page: Page): Promise<unknown> {
  return page.evaluate(async () => (await chrome.storage.session.get('reminderDue')).reminderDue);
}

// ---------------------------------------------------------------------------------------------
// Accessibility: WCAG 2.2 AA, light and dark, over one part of a page
// ---------------------------------------------------------------------------------------------

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

export async function expectAccessible(page: Page, include: string, state: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settleAnimations(page);
    const { violations, passes } = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include(include)
      .analyze();
    // A run that checked nothing must not read as "no violations".
    const report =
      passes.length === 0
        ? `axe applied no rule under ${include}`
        : violations
            .map(
              (v) =>
                `[${v.impact}] ${v.id}: ${v.help}\n` +
                v.nodes
                  .slice(0, 4)
                  .map((n) => `   ${JSON.stringify(n.target)} ${n.html.slice(0, 160)}`)
                  .join('\n'),
            )
            .join('\n');
    expect(report, `${state} (${scheme})`).toBe('');
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
