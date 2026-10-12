import type { Locator, Page } from '@playwright/test';
import { startFakeProvider, type FakeProvider } from './aiServer';
import {
  configureProvider,
  enableAi,
  expect,
  profilesOf,
  saveKey,
  test as base,
} from './helpers.aiExtras';

export * from './helpers.aiExtras';

/**
 * Helpers for ai-anthropic.spec.ts and backup-secrets.spec.ts: the Anthropic provider through the
 * shipped settings UI, against a local fake that speaks the Anthropic Messages API (./aiServer.ts,
 * `api: 'anthropic'`). No real key, no internet.
 *
 * `anthropic` accepts ANTHROPIC_KEY in `x-api-key` (and nothing in `Authorization`); `provider` and
 * `fallback` (from helpers.aiExtras) are the two OpenAI-compatible servers.
 */

/** Syntactically valid fake keys (printable ASCII, 8 to 512 characters). Never real keys. */
export const ANTHROPIC_KEY = 'sk-ant-e2e-fake-Q8wN4Zr2Lp7Vb1Xk';
export const WRONG_ANTHROPIC_KEY = 'sk-ant-e2e-wrong-J3hD9sT5Fc6Ym0Ea';
/** The model id is the person's to type: the product hard-codes none. */
export const ANTHROPIC_MODEL = 'claude-e2e-fake-1';

export const test = base.extend<{ anthropic: FakeProvider }>({
  // Playwright requires an object-destructuring first argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  anthropic: async ({}, use) => {
    const anthropic = await startFakeProvider({ apiKey: ANTHROPIC_KEY, api: 'anthropic' });
    await use(anthropic);
    await anthropic.close();
  },
});

/**
 * Choose Anthropic the way a person does ("Use Anthropic" fills the provider's own address), then
 * type the address of the fake and the model and save. Sends nothing.
 */
export async function configureAnthropic(
  options: Page,
  cfg: { baseUrl: string; model?: string },
): Promise<void> {
  await options.getByRole('button', { name: 'Use Anthropic' }).click();
  await expect(options.getByTestId('ai-provider')).toHaveValue('anthropic');
  await configureProvider(options, { baseUrl: cfg.baseUrl, model: cfg.model ?? ANTHROPIC_MODEL });
}

/** Switch on, choose Anthropic at the fake's address, save the key. Sends nothing. */
export async function setUpAnthropic(
  options: Page,
  anthropic: Pick<FakeProvider, 'baseUrl'>,
  key: string | null = ANTHROPIC_KEY,
): Promise<void> {
  await enableAi(options);
  await configureAnthropic(options, { baseUrl: anthropic.baseUrl });
  if (key !== null) await saveKey(options, key);
}

/**
 * Add an Anthropic provider after the primary one through the settings page: Add, name, provider
 * type, address, model, Save, then the key. Returns the card.
 */
export async function addAnthropicFallback(
  options: Page,
  cfg: { label: string; baseUrl: string; model?: string; key?: string | null },
): Promise<Locator> {
  const before = await profilesOf(options).count();
  await options.getByTestId('ai-profile-add').click();
  await expect(profilesOf(options)).toHaveCount(before + 1);
  const card = profilesOf(options).nth(before);
  await card.getByTestId('ai-profile-label').fill(cfg.label);
  await card.getByTestId('ai-profile-provider').selectOption('anthropic');
  await card.getByTestId('ai-profile-base-url').fill(cfg.baseUrl);
  await card.getByTestId('ai-profile-model').fill(cfg.model ?? ANTHROPIC_MODEL);
  await card.getByTestId('ai-profile-save').click();
  await expect(card.getByTestId('ai-profile-save')).toHaveAttribute('aria-disabled', 'true');
  if (cfg.key !== null) {
    const key = cfg.key ?? ANTHROPIC_KEY;
    await card.getByTestId('ai-profile-key-input').fill(key);
    await card.getByTestId('ai-profile-key-save').click();
    await expect(card.getByTestId('ai-profile-key-mask')).toHaveText(`••••••••${key.slice(-4)}`);
    await expect(card.getByTestId('ai-profile-key-input')).toHaveValue('');
  }
  return card;
}

/** Press Send in the consent dialog and wait until it shows a stored draft. */
export async function sendAndWaitForDraft(dialog: Locator): Promise<Locator> {
  await dialog.getByTestId('ai-send').click();
  const card = dialog.getByTestId('ai-result-card');
  await expect(card).toBeVisible();
  return card;
}
