import type { Locator, Page } from '@playwright/test';
import { INBOX_BANK_ID } from '@shared';
import { expect, readTable, settle } from './helpers.dashboard';
import type { Env } from './helpers.pages';

export { INBOX_BANK_ID };

/**
 * Helpers for rules.spec.ts: the filing-rules manager of the dashboard (docs/adr/017-filing-rules.md)
 * driven through its real controls, and the toasts the page overlay shows after a capture.
 */

/** The dashboard on the rules view (`?view=rules`), wide enough for the three panes. */
export async function openRules(env: Env): Promise<Page> {
  const page = await env.context.newPage();
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`chrome-extension://${env.extensionId}/dashboard.html?view=rules`);
  await expect(page.getByTestId('rules-view')).toBeVisible();
  await expect(page.getByText('Loading the rules…')).toHaveCount(0);
  return page;
}

export const ruleRows = (page: Page): Locator => page.getByTestId('rule-row');

export const ruleRow = (page: Page, name: string): Locator =>
  ruleRows(page).filter({ has: page.getByTestId('rule-name-text').filter({ hasText: name }) });

/** Names of the rules, top to bottom. */
export async function ruleOrder(page: Page): Promise<string[]> {
  return page.getByTestId('rule-name-text').allTextContents();
}

export interface NewRule {
  name: string;
  /** Typed into "Sites" one by one. */
  hosts?: string[];
  titleContains?: string[];
  bank: string;
  /** Default true, as in the dialog. */
  asks?: boolean;
}

/** Fill and submit the "New filing rule" dialog (opened by the caller's click or by this). */
export async function createRule(page: Page, rule: NewRule): Promise<void> {
  const before = await ruleRows(page).count();
  const open = page.getByTestId('rule-new');
  if (await open.isVisible()) await open.click();
  else await page.getByRole('button', { name: 'Create the first rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New filing rule' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('rule-name').fill(rule.name);
  for (const host of rule.hosts ?? []) {
    const field = dialog.getByTestId('rule-hosts').getByRole('textbox');
    await field.fill(host);
    await field.press('Enter');
    await expect(dialog.getByTestId('rule-hosts').getByRole('listitem')).toContainText(host);
  }
  for (const word of rule.titleContains ?? []) {
    const field = dialog.getByTestId('rule-title').getByRole('textbox');
    await field.fill(word);
    await field.press('Enter');
  }
  await dialog.getByTestId('rule-bank').selectOption({ label: rule.bank });
  if (rule.asks === false) await dialog.getByTestId('rule-confirm').uncheck();
  await dialog.getByTestId('dialog-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(ruleRows(page)).toHaveCount(before + 1);
}

/** The overlay toast whose text matches (the open shadow root of the e2e build is pierced). */
export const overlayToast = (page: Page, text: string | RegExp): Locator =>
  page.locator('.sv-toast', { hasText: text });

/** Rows of the vault's filing-rule table, read straight from IndexedDB (never upgrades it). */
export async function storedRules(ctrl: Page): Promise<Array<Record<string, unknown>>> {
  return readTable(ctrl, 'filingRules' as never);
}

export { settle };
