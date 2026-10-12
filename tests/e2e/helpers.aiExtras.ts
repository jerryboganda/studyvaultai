import type { Locator, Page } from '@playwright/test';
import { startFakeProvider, type FakeProvider } from './aiServer';
import { OTHER_KEY, expect, test as base, type Env } from './helpers.ai';

export * from './helpers.ai';

/**
 * Helpers for ai-extras.spec.ts: fallback providers, routing, the added task kinds and the chat view
 * of the optional AI feature, against TWO local fake providers (no real key, no internet).
 *
 * `provider` (from helpers.ai) is the primary one and accepts FAKE_KEY; `fallback` is a second,
 * independent server that accepts OTHER_KEY, so a request that reaches the wrong one is a 401 and
 * the tests can also tell, from `seen`, exactly which server heard what.
 */

export const test = base.extend<{ fallback: FakeProvider }>({
  // Playwright requires an object-destructuring first argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  fallback: async ({}, use) => {
    const fallback = await startFakeProvider({ apiKey: OTHER_KEY });
    await use(fallback);
    await fallback.close();
  },
});

export const FALLBACK_MODEL = 'fallback-model-1';

/** The routing section of the AI settings (below the primary provider's form). */
export const routingOf = (options: Page): Locator => options.getByTestId('ai-routing');
export const profilesOf = (options: Page): Locator => options.getByTestId('ai-profile');

/**
 * Add a fallback provider through the settings page the way a person does: Add, fill the address,
 * the model and the name, Save, then the key. Returns the card.
 */
export async function addFallback(
  options: Page,
  cfg: { label: string; baseUrl: string; model?: string; key?: string | null },
): Promise<Locator> {
  const before = await profilesOf(options).count();
  await options.getByTestId('ai-profile-add').click();
  await expect(profilesOf(options)).toHaveCount(before + 1);
  const card = profilesOf(options).nth(before);
  await card.getByTestId('ai-profile-label').fill(cfg.label);
  await card.getByTestId('ai-profile-base-url').fill(cfg.baseUrl);
  await card.getByTestId('ai-profile-model').fill(cfg.model ?? FALLBACK_MODEL);
  await card.getByTestId('ai-profile-save').click();
  // Saved: the button has nothing left to save.
  await expect(card.getByTestId('ai-profile-save')).toHaveAttribute('aria-disabled', 'true');
  if (cfg.key !== null) {
    const key = cfg.key ?? OTHER_KEY;
    await card.getByTestId('ai-profile-key-input').fill(key);
    await card.getByTestId('ai-profile-key-save').click();
    await expect(card.getByTestId('ai-profile-key-mask')).toHaveText(`••••••••${key.slice(-4)}`);
    await expect(card.getByTestId('ai-profile-key-input')).toHaveValue('');
  }
  return card;
}

/** The text the dialog shows as the passages of a chat request, ticked or not. */
export const chatPassagesOf = (dialog: Locator): Locator => dialog.getByTestId('ai-chat-passage');

/**
 * Open the dashboard on the chat view (optionally scoped to a bank) and wait until the chat has
 * loaded: the question box is there once AI is on and the view's code has been fetched.
 */
export async function openChat(env: Env, bankId = 'inbox-default'): Promise<Page> {
  const page = await env.context.newPage();
  await page.goto(`chrome-extension://${env.extensionId}/dashboard.html?view=chat&bank=${bankId}`);
  await expect(page.getByTestId('chat-question')).toBeVisible();
  return page;
}

/** Type a question; wait until Ask is available (settings read, search index ready). */
export async function askChat(page: Page, question: string): Promise<Locator> {
  const box = page.getByTestId('chat-question');
  await box.fill(question);
  const ask = page.getByTestId('chat-ask');
  await expect(ask).not.toHaveAttribute('aria-disabled', 'true');
  await ask.click();
  const dialog = page.getByTestId('ai-consent-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('ai-outbound')).toBeVisible();
  return dialog;
}
