import type { Locator, Page } from '@playwright/test';
import { INBOX_BANK_ID } from '@shared';
import { expect, readTable, settle } from './helpers.dashboard';
import { pickCard } from './helpers.graph';
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
  /** Default true, as in the wizard. */
  asks?: boolean;
}

/** The "New filing rule" wizard dialog. */
export const ruleWizard = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'New filing rule' });

/** Press the wizard's Next and wait for the named step heading. */
async function nextStep(dialog: Locator, step: string): Promise<void> {
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: step, exact: true })).toBeVisible();
}

/**
 * Walk the "New filing rule" wizard with real input and create the rule: When (which fields) ›
 * What matches › File into › Ask first? › Try it › Looks good? (name) › Create rule.
 */
export async function createRule(page: Page, rule: NewRule): Promise<void> {
  const before = await ruleRows(page).count();
  await page.getByTestId('rule-new').click();
  const dialog = ruleWizard(page);
  await expect(dialog).toBeVisible();

  // When: the fields this rule looks at.
  await expect(dialog.getByRole('heading', { name: 'When', exact: true })).toBeVisible();
  const when = dialog.getByTestId('rule-when');
  if (rule.hosts?.length) await pickCard(when.getByRole('checkbox', { name: /^Site/ }));
  if (rule.titleContains?.length) {
    await pickCard(when.getByRole('checkbox', { name: /^Page title/ }));
  }

  // What matches: the values, one chip each.
  await nextStep(dialog, 'What matches');
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
    await expect(dialog.getByTestId('rule-title').getByRole('listitem')).toContainText(word);
  }

  // File into: the bank, as a picture card.
  await nextStep(dialog, 'File into');
  await pickCard(
    dialog.getByTestId('rule-bank').getByRole('radio', { name: rule.bank, exact: true }),
  );

  // Ask first? On by default.
  await nextStep(dialog, 'Ask first?');
  const confirm = dialog.getByTestId('rule-confirm');
  if (rule.asks === false) {
    await pickCard(confirm.getByRole('radio', { name: /^File at once/ }));
  } else {
    await expect(confirm.getByRole('radio', { name: /^Ask first/ })).toBeChecked();
  }

  await nextStep(dialog, 'Try it');
  await nextStep(dialog, 'Looks good?');
  await dialog.getByTestId('rule-name').fill(rule.name);
  await dialog.getByRole('button', { name: 'Create rule', exact: true }).click();
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
