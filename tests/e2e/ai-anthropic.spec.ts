import type { Page } from '@playwright/test';
import { anthropicFailure, cannedAnswer, failure, ok } from './aiServer';
import {
  ANTHROPIC_KEY,
  ANTHROPIC_MODEL,
  FAKE_KEY,
  WRONG_ANTHROPIC_KEY,
  addAnthropicFallback,
  backupText,
  configureProvider,
  enableAi,
  expect,
  maskOf,
  metaValue,
  nonFixture,
  openAdvanced,
  openConsent,
  openExt,
  openSide,
  outboundOf,
  pageContents,
  pickCard,
  readTable,
  renderOutbound,
  saveHighlight,
  saveKey,
  sendAndWaitForDraft,
  setUpAi,
  setUpAnthropic,
  setupStep,
  storageDump,
  test,
  watchTraffic,
} from './helpers.aiAnthropic';

/** The fixture card number (tests/fixtures/html/ai-source.html), with or without separators. */
const CARD = /4111[ -]?1111[ -]?1111[ -]?1111/;

/**
 * The Anthropic provider of the optional AI feature in a real loaded extension, against a local FAKE
 * that speaks the Anthropic Messages API (./aiServer.ts, `api: 'anthropic'`). No real key, no
 * internet. Everything a person does goes through the shipped UI: the Anthropic card of the setup
 * wizard, the key field under "Advanced", the side panel's highlight card, the consent preview.
 *
 * What the fake enforces, as the live API does: `x-api-key` (Authorization is not read),
 * `anthropic-version`, a body of exactly model / max_tokens / system / messages / temperature, user
 * and assistant roles only, a first message from the user. A request the adapter got wrong is a 400
 * in the test, never a quietly accepted one.
 *
 * Not covered (and why):
 *  - The live api.anthropic.com: there is no key in this repo, so the wire shape is the published
 *    Messages API as the fake enforces it, not a recording of a real exchange.
 *  - The native host-permission prompt: the e2e build holds loopback host permissions, so
 *    `permissions.request` resolves without a prompt; it stays a manual check (MT-30).
 */

test.describe.configure({ timeout: 150_000 });

const countOf = async (page: Page, store: string): Promise<number> =>
  (await readTable(page, store)).length;

const overloaded = () => anthropicFailure(529, { type: 'overloaded_error', message: 'Overloaded' });

// =============================================================================================
// 1. Choosing it, the key
// =============================================================================================

test.describe('choosing Anthropic and keeping its key', () => {
  test('the preset fills the provider address; the key stays in IndexedDB, travels in x-api-key only and is never echoed; Test connection sends one fixed message', async ({
    env,
    anthropic,
  }) => {
    const traffic = watchTraffic(env);
    const options = await openExt(env, 'options');
    // A highlight, so that the backup has real content to prove the key is missing from.
    const { highlight } = await saveHighlight(env, options, '#p-pearl');
    await options.bringToFront();

    await enableAi(options);
    await pickCard(options, 'ai-preset-anthropic');
    await options.getByTestId('ai-setup-next').click();
    await expect(setupStep(options, 'Address and model')).toBeVisible();
    await expect(options.getByTestId('ai-base-url')).toHaveValue('');
    await expect(options.getByText('Empty means https://api.anthropic.com.')).toBeVisible();
    await expect(options.getByTestId('ai-endpoint-status')).toContainText(
      'Requests go to https://api.anthropic.com only.',
    );
    await options.getByTestId('ai-setup-back').click();

    // The person points it at another address (here the fake) and names the model.
    await configureProvider(options, {
      baseUrl: anthropic.baseUrl,
      model: ANTHROPIC_MODEL,
      preset: 'anthropic',
      key: ANTHROPIC_KEY, // Anthropic always wants a key, even at a local address: the wizard asks
    });
    await expect(options.getByTestId('ai-endpoint-status')).toContainText(
      `Requests go to ${anthropic.origin} only.`,
    );
    expect(await metaValue(options, 'aiSettings')).toMatchObject({
      provider: 'anthropic',
      baseUrl: anthropic.baseUrl,
      model: ANTHROPIC_MODEL,
    });
    expect(anthropic.seen, 'configuring a provider sends nothing').toEqual([]);

    await expect(options.getByTestId('ai-key-status')).toContainText(maskOf(ANTHROPIC_KEY));
    await expect(options.getByTestId('ai-access-status')).toHaveText('allowed');

    // 1. Not echoed anywhere a person or a screen reader can reach.
    expect(await pageContents(options), 'the key is not in the page').not.toContain(ANTHROPIC_KEY);

    // 2. Stored once, in the vault database, bound to the origin it was saved for.
    expect(await metaValue(options, 'aiKey')).toEqual({
      apiKey: ANTHROPIC_KEY,
      origin: anthropic.origin,
    });

    // 3. Not in chrome.storage.* (a content script can read storage.local) nor in web storage.
    const storage = await storageDump(options);
    expect(storage).not.toContain(ANTHROPIC_KEY);
    expect(storage, 'the settings copy in storage.local has no AI endpoint either').not.toContain(
      anthropic.origin,
    );

    // 4. Not in a backup made through the Backup section.
    const text = await backupText(env, options);
    expect(text, 'the backup holds the highlight').toContain(highlight.exactQuote.slice(0, 40));
    expect(text, 'the backup does not hold the key').not.toContain(ANTHROPIC_KEY);
    expect(text, 'nor the provider address').not.toContain(anthropic.origin);
    expect(text, 'nor the settings and key rows').not.toMatch(/aiKey|aiSettings|aiBudget/);

    // 5. "Test connection" is the first and only thing that sends: one fixed message, the key in
    //    x-api-key and nowhere else, no cookie, no referrer.
    expect(anthropic.seen).toEqual([]);
    await options.getByTestId('ai-test').click();
    await expect(options.getByTestId('ai-test-result')).toContainText('Reply: "OK"');
    expect(anthropic.seen, 'one request, and no preflight before it').toHaveLength(1);
    const [probe] = anthropic.completions();
    expect(probe?.method).toBe('POST');
    expect(probe?.path).toBe('/v1/messages');
    expect(probe?.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(probe?.headers.authorization, 'not a bearer token').toBeUndefined();
    expect(probe?.headers['anthropic-version']).toBe('2023-06-01');
    expect(probe?.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(probe?.headers['content-type']).toBe('application/json');
    expect(probe?.headers.cookie).toBeUndefined();
    expect(probe?.headers.referer).toBeUndefined();
    expect(probe?.body).not.toContain(ANTHROPIC_KEY);
    expect(probe?.anthropic).toEqual({
      model: ANTHROPIC_MODEL,
      max_tokens: 16,
      temperature: 0.2,
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    });
    expect(await pageContents(options)).not.toContain(ANTHROPIC_KEY);
    expect(
      traffic.console.filter((line) => line.includes(ANTHROPIC_KEY)),
      'the key was never printed',
    ).toEqual([]);
    expect(nonFixture(env, traffic)).toEqual([`POST ${anthropic.origin}/v1/messages`]);
  });
});

// =============================================================================================
// 2. Consent preview, the one request, the draft, the ledger
// =============================================================================================

test.describe('a request', () => {
  test('Send transmits exactly the previewed payload once; the answer is an unverified draft that cites the immutable quote; the ledger holds the usage the provider reported', async ({
    env,
    anthropic,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAnthropic(options, anthropic);
    const { page, highlight } = await saveHighlight(env, options, '#p-pii');
    const side = await openSide(env, page);
    const dialog = await openConsent(side, highlight.id);

    await expect(dialog.getByTestId('ai-endpoint-line')).toContainText(
      `This will be sent to ${anthropic.origin}`,
    );
    await expect(dialog.getByTestId('ai-endpoint-line')).toContainText(
      `API key saved (${maskOf(ANTHROPIC_KEY)}), sent only to this address`,
    );
    const previewed = await outboundOf(dialog);
    expect(previewed).toContain('Registrar contact: [EMAIL], payment card [CARD_NUMBER].');
    expect(previewed).not.toContain('jane.doe@example.org');
    expect(previewed).not.toContain(ANTHROPIC_KEY);
    expect(anthropic.seen, 'the preview is built on this device').toEqual([]);

    // Token counts no size estimate could produce: the ledger must be reading `usage`.
    anthropic.queue((chat) =>
      ok(cannedAnswer(chat), { usage: { inputTokens: 4321, outputTokens: 87 } }),
    );
    const card = await sendAndWaitForDraft(dialog);

    // Exactly one request, and its body is the text the person approved.
    expect(anthropic.seen).toHaveLength(1);
    const [sent] = anthropic.completions();
    expect(sent?.path).toBe('/v1/messages');
    expect(
      renderOutbound(sent?.chat?.messages ?? []),
      'system part and messages as previewed',
    ).toBe(previewed);
    // The system text travels in the top-level field, the data block in a single user message.
    expect(sent?.anthropic?.system).toBe(sent?.chat?.messages[0]?.content);
    expect(sent?.anthropic?.messages.map((m) => m.role)).toEqual(['user']);
    expect(sent?.anthropic).toMatchObject({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      temperature: 0.2,
    });
    expect(Object.keys(JSON.parse(sent?.body ?? '{}')).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'system',
      'temperature',
    ]);
    expect(sent?.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(sent?.headers.authorization).toBeUndefined();
    expect(sent?.headers.cookie, 'no cookies').toBeUndefined();
    expect(sent?.headers.referer, 'no referrer').toBeUndefined();
    expect(sent?.body, 'the key is a header, never part of the body').not.toContain(ANTHROPIC_KEY);
    expect(sent?.body).not.toContain('jane.doe@example.org');
    expect(sent?.body).not.toMatch(CARD);

    // An unverified draft: labelled, with the vault's own quote as the citation.
    await expect(card).toHaveAttribute('data-kind', 'exam_pearl');
    await expect(card.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unverified');
    await expect(card.getByTestId('ai-verification')).toContainText('Unverified AI draft');
    await expect(card.getByTestId('ai-citation').locator('blockquote')).toHaveText(
      highlight.exactQuote,
    );
    await expect(dialog.getByRole('status').first()).toContainText(
      `Answer received from ${anthropic.host} in 1 request.`,
    );

    const [stored] = await readTable(options, 'aiResults');
    expect(stored).toMatchObject({
      kind: 'exam_pearl',
      verificationState: 'unverified',
      acceptedByUserAt: null,
      provider: `anthropic:${anthropic.host}`,
      model: ANTHROPIC_MODEL,
      inputSourceIds: [highlight.id],
      grounding: { checked: 1, supported: 1, unsupported: 0 },
      usage: { inputTokens: 4321, outputTokens: 87 },
    });
    expect(await metaValue(options, 'aiBudget')).toMatchObject({
      requests: 1,
      inputTokens: 4321,
      outputTokens: 87,
    });
    await options.reload();
    await openAdvanced(options);
    await expect(options.getByTestId('ai-ledger-requests')).toHaveText('1 of 30');
    await expect(options.getByTestId('ai-ledger-tokens')).toHaveText('4321 in, 87 out');

    // Asking the identical question again is answered from the device: nothing is sent.
    await dialog.getByTestId('ai-close').click();
    await expect(dialog).toHaveCount(0);
    const again = await openConsent(side, highlight.id);
    await again.getByTestId('ai-send').click();
    await expect(
      again.getByText(/Nothing was sent: the result was computed or reused on this device\./),
    ).toBeVisible();
    expect(anthropic.completions(), 'the repeat did not reach the provider').toHaveLength(1);
    expect(await countOf(options, 'aiResults')).toBe(1);
  });
});

// =============================================================================================
// 3. Failure states
// =============================================================================================

test.describe('failures are specific, save nothing, and can be retried', () => {
  test('a rejected key, a rate limit, an empty account, an overloaded provider and a cut-off or declined answer each say what happened; transient errors retry by themselves; Send works again', async ({
    env,
    anthropic,
  }) => {
    const options = await openExt(env, 'options');
    // The provider accepts ANTHROPIC_KEY; the person saved another one.
    await setUpAnthropic(options, anthropic, WRONG_ANTHROPIC_KEY);
    const { page, highlight } = await saveHighlight(env, options, '#p-pearl');
    const side = await openSide(env, page);
    let dialog = await openConsent(side, highlight.id);
    const send = () => dialog.getByTestId('ai-send');
    const error = () => dialog.getByTestId('ai-error');
    const calls = () => anthropic.completions().length;
    const nothingSaved = async () => {
      expect(await countOf(options, 'aiResults')).toBe(0);
      await expect(send()).not.toHaveAttribute('aria-disabled', 'true');
    };

    // 1. The provider's own 401 for a key it does not know.
    await send().click();
    await expect(error()).toContainText('The provider rejected the API key');
    await expect(error()).toContainText('HTTP 401 authentication_error');
    await expect(error()).toContainText('Check the key in the AI settings');
    expect(calls()).toBe(1);
    expect(anthropic.completions()[0]?.headers['x-api-key']).toBe(WRONG_ANTHROPIC_KEY);
    // The key that failed is not echoed into the message.
    expect(await dialog.evaluate((el) => el.textContent)).not.toContain(WRONG_ANTHROPIC_KEY);
    await nothingSaved();

    // Fix it where it is kept, then ask again.
    await dialog.getByTestId('ai-cancel').click();
    await saveKey(options, ANTHROPIC_KEY);
    expect(await metaValue(options, 'aiKey')).toEqual({
      apiKey: ANTHROPIC_KEY,
      origin: anthropic.origin,
    });
    dialog = await openConsent(side, highlight.id);
    await expect(dialog.getByTestId('ai-endpoint-line')).toContainText(maskOf(ANTHROPIC_KEY));

    // 2. 429 that asks for a long wait: fails at once and says how long.
    anthropic.queue(anthropicFailure(429, { type: 'rate_limit_error' }, { 'retry-after': '45' }));
    await send().click();
    await expect(error()).toContainText('Rate limited by the provider');
    await expect(error()).toContainText('wait 45 seconds');
    expect(calls()).toBe(2);
    await nothingSaved();

    // 3. An account without credit is a 400 whose message is the only tell; the message is not echoed.
    anthropic.queue(
      anthropicFailure(400, {
        type: 'invalid_request_error',
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      }),
    );
    await send().click();
    await expect(error()).toContainText('No quota or credit left');
    await expect(error()).toContainText('Add credit with your provider');
    expect(calls()).toBe(3);
    expect(await dialog.evaluate((el) => el.textContent)).not.toContain('Plans & Billing');
    await nothingSaved();

    // 4. 529 overloaded, every time: three attempts, then the provider's error code.
    anthropic.queue(overloaded(), overloaded(), overloaded());
    await send().click();
    await expect(error()).toContainText('The provider reported an error');
    await expect(error()).toContainText('HTTP 529 overloaded_error');
    expect(calls()).toBe(6);
    await nothingSaved();

    // 5. The answer was cut off by the output limit, and one the model declined.
    anthropic.queue((chat) => ok(cannedAnswer(chat), { finishReason: 'max_tokens' }));
    await send().click();
    await expect(error()).toContainText('The answer was cut off');
    expect(calls()).toBe(7);
    await nothingSaved();

    anthropic.queue((chat) => ok(cannedAnswer(chat), { finishReason: 'refusal' }));
    await send().click();
    await expect(error()).toContainText('The model declined');
    expect(calls()).toBe(8);
    await nothingSaved();

    // 6. One 529, then an answer the way Claude often writes JSON (inside a code fence): the
    //    retry is automatic and the fence is stripped, so the same dialog ends in a draft.
    anthropic.queue(overloaded(), (chat) => ok(`\`\`\`json\n${cannedAnswer(chat)}\n\`\`\``));
    const card = await sendAndWaitForDraft(dialog);
    expect(calls()).toBe(10);
    await expect(dialog.getByRole('status').first()).toContainText(
      `Answer received from ${anthropic.host} in 2 requests.`,
    );
    await expect(card.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unverified');
    expect(await countOf(options, 'aiResults')).toBe(1);
    for (const sent of anthropic.completions().slice(1)) {
      expect(sent.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    }

    // Every provider call was counted in the ledger, failed or not.
    expect((await metaValue<{ requests: number }>(options, 'aiBudget'))?.requests).toBe(10);
  });
});

// =============================================================================================
// 4. As a fallback behind another provider
// =============================================================================================

test.describe('Anthropic as a fallback provider', () => {
  test('a 503 from the primary moves the request to it: its own key in x-api-key, the primary key never sent to it and its key never sent to the primary', async ({
    env,
    provider,
    anthropic,
  }) => {
    const traffic = watchTraffic(env);
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    await expect(options.getByTestId('ai-profile')).toHaveCount(0);
    const card = await addAnthropicFallback(options, {
      label: 'Claude backup',
      baseUrl: anthropic.baseUrl,
    });
    const profileId = String(await card.getAttribute('data-profile-id'));

    // Its key sits in the vault database next to the primary one, bound to its own address.
    expect(await metaValue(options, 'aiProfileKeys')).toEqual({
      [profileId]: { apiKey: ANTHROPIC_KEY, origin: anthropic.origin },
    });
    expect(await metaValue(options, 'aiKey')).toEqual({
      apiKey: FAKE_KEY,
      origin: provider.origin,
    });
    expect(await metaValue<{ fallbacks: unknown[] }>(options, 'aiSettings')).toMatchObject({
      fallbacks: [
        {
          id: profileId,
          label: 'Claude backup',
          provider: 'anthropic',
          baseUrl: anthropic.baseUrl,
          model: ANTHROPIC_MODEL,
        },
      ],
    });
    expect(await pageContents(options)).not.toContain(ANTHROPIC_KEY);
    expect(await storageDump(options)).not.toContain(ANTHROPIC_KEY);

    // "Test connection" of that provider reaches that provider only.
    await card.getByTestId('ai-profile-test').click();
    await expect(card.getByTestId('ai-profile-test-result')).toContainText('Reply: "OK"');
    expect(anthropic.completions()).toHaveLength(1);
    expect(anthropic.completions()[0]?.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(provider.seen, 'the primary provider heard nothing').toEqual([]);

    const { page, highlight } = await saveHighlight(env, options, '#p-pearl');
    const side = await openSide(env, page);
    const dialog = await openConsent(side, highlight.id);
    const backups = dialog.getByTestId('ai-fallbacks');
    await expect(backups).toContainText(`Only if ${provider.host} is not answering`);
    await expect(backups).toContainText(anthropic.origin);
    await expect(backups).toContainText(ANTHROPIC_MODEL);
    await expect(backups).toContainText(`API key saved (${maskOf(ANTHROPIC_KEY)})`);
    const previewed = await outboundOf(dialog);

    provider.queue(
      failure(503, { type: 'server_error', code: 'overloaded' }),
      failure(503, { type: 'server_error', code: 'overloaded' }),
    );
    await dialog.getByTestId('ai-send').click();
    await expect(dialog.getByTestId('ai-result-card')).toBeVisible();

    // The primary had its two attempts; the Anthropic provider answered the third request.
    expect(provider.completions()).toHaveLength(2);
    expect(anthropic.completions(), 'the connection test and the request').toHaveLength(2);
    const sent = anthropic.completions()[1];
    expect(renderOutbound(sent?.chat?.messages ?? []), 'exactly the previewed text').toBe(
      previewed,
    );
    expect(sent?.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(sent?.headers.authorization).toBeUndefined();
    expect(sent?.anthropic?.model).toBe(ANTHROPIC_MODEL);
    for (const s of provider.completions()) {
      expect(s.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(JSON.stringify(s.headers) + s.body, 'the fallback key stays away').not.toContain(
        ANTHROPIC_KEY,
      );
    }
    for (const s of anthropic.completions()) {
      expect(JSON.stringify(s.headers) + s.body, 'the primary key stays away').not.toContain(
        FAKE_KEY,
      );
    }
    await expect(dialog.getByRole('status').first()).toContainText(
      `Answer received from ${anthropic.host} in 3 requests.`,
    );
    await expect(dialog).toContainText('did not answer, so the fallback you confirmed did');

    const [stored] = await readTable(options, 'aiResults');
    expect(stored).toMatchObject({
      kind: 'exam_pearl',
      provider: `anthropic:${anthropic.host}`,
      model: ANTHROPIC_MODEL,
      verificationState: 'unverified',
    });
    // The test, the two failed attempts and the answer.
    expect((await metaValue<{ requests: number }>(options, 'aiBudget'))?.requests).toBe(4);
    expect(
      nonFixture(env, traffic).every(
        (u) =>
          u === `POST ${provider.baseUrl}/chat/completions` ||
          u === `POST ${anthropic.origin}/v1/messages`,
      ),
      'nothing but the two providers was contacted',
    ).toBe(true);
  });
});
