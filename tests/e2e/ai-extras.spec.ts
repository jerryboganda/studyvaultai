import type { Page } from '@playwright/test';
import { dataBlocks, failure, ok, type FakeProvider } from './aiServer';
import {
  FAKE_KEY,
  FALLBACK_MODEL,
  MODEL,
  OTHER_KEY,
  addFallback,
  aiSwitch,
  axeReport,
  backupText,
  expect,
  highlightsOf,
  metaValue,
  nonFixture,
  openChat,
  sendChat,
  openConsent,
  openExt,
  openSide,
  outboundOf,
  pageContents,
  profilesOf,
  readTable,
  renderOutbound,
  routingOf,
  saveHighlight,
  setUpAi,
  storageDump,
  test,
  watchTraffic,
} from './helpers.aiExtras';

/**
 * The AI router, the added task kinds and the chat view, in a real loaded extension against two
 * LOCAL fake providers (./aiServer.ts): no real key, no internet. Everything a person does goes
 * through the shipped UI. What these specs add to ai.spec.ts:
 *
 *  - a 503 hands the request to the next provider, which receives exactly the previewed text, with
 *    every attempt in the ledger; a rejected key, no quota and a rate limit do not;
 *  - the consent dialog names every address that may receive the text, and a task can start with a
 *    provider of its own;
 *  - mnemonic, short viva and study outline are drafts like the others, a memory aid flagged as one;
 *  - chat: retrieval on this device, passages and earlier turns the person can untick, a citation
 *    that is not in the passages flagged, "cannot answer from your notes" as an answer;
 *  - the keys of the extra providers stay in IndexedDB and out of backups; removing a provider
 *    removes its key.
 *
 * Not covered (and why): Chrome's host-permission prompt for the second origin. The e2e build holds
 * loopback host permissions, so `permissions.request` resolves without a prompt; the permission call
 * itself (one request listing every origin) is unit-tested (packages/ui/src/ai/__tests__) and the
 * prompt stays a manual check (MT-30).
 */

test.describe.configure({ timeout: 150_000 });

const countOf = async (page: Page, store: string): Promise<number> =>
  (await readTable(page, store)).length;

/** The two probes of "Test connection" are not study traffic: count the rest. */
const requestsOf = (p: FakeProvider) =>
  p.completions().filter((c) => c.chat?.messages[0]?.content !== 'Reply with the single word: OK');

// =============================================================================================
// 1. Fallback providers
// =============================================================================================

test.describe('fallback providers', () => {
  test('a 503 moves the request to the fallback named in the preview: exactly the previewed text, every attempt counted, the answer labelled with who gave it', async ({
    env,
    provider,
    fallback,
  }) => {
    const traffic = watchTraffic(env);
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    await expect(profilesOf(options)).toHaveCount(0);
    const card = await addFallback(options, { label: 'Backup model', baseUrl: fallback.baseUrl });
    const profileId = await card.getAttribute('data-profile-id');

    // The key sits in the vault database next to the primary one, bound to its own address.
    expect(await metaValue(options, 'aiProfileKeys')).toEqual({
      [String(profileId)]: { apiKey: OTHER_KEY, origin: fallback.origin },
    });
    expect(await metaValue(options, 'aiKey')).toEqual({
      apiKey: FAKE_KEY,
      origin: provider.origin,
    });
    expect(await metaValue<{ fallbacks: unknown[] }>(options, 'aiSettings')).toMatchObject({
      fallbacks: [
        { id: profileId, label: 'Backup model', baseUrl: fallback.baseUrl, model: FALLBACK_MODEL },
      ],
    });

    // "Test connection" of that provider reaches that provider only.
    await card.getByTestId('ai-profile-test').click();
    await expect(card.getByTestId('ai-profile-test-result')).toContainText('Reply: "OK"');
    expect(fallback.completions()).toHaveLength(1);
    expect(fallback.completions()[0]?.headers.authorization).toBe(`Bearer ${OTHER_KEY}`);
    expect(provider.seen, 'the primary provider heard nothing').toEqual([]);
    expect(await pageContents(options)).not.toContain(OTHER_KEY);

    const { page, highlight } = await saveHighlight(env, options, '#p-pearl');
    const side = await openSide(env, page);
    const dialog = await openConsent(side, highlight.id);

    // Every address that may receive the text, before anything is sent.
    await expect(dialog.getByTestId('ai-endpoint-line')).toContainText(
      `This will be sent to ${provider.origin}`,
    );
    const backups = dialog.getByTestId('ai-fallbacks');
    await expect(backups).toContainText(`Only if ${provider.host} is not answering`);
    await expect(backups.getByTestId('ai-fallback-target')).toHaveCount(1);
    await expect(backups).toContainText(fallback.origin);
    await expect(backups).toContainText(FALLBACK_MODEL);
    await expect(backups).toContainText(`API key saved (••••••••${OTHER_KEY.slice(-4)})`);
    const previewed = await outboundOf(dialog);
    expect(requestsOf(provider)).toHaveLength(0);
    expect(requestsOf(fallback)).toHaveLength(0);

    provider.queue(
      failure(503, { type: 'server_error', code: 'overloaded' }),
      failure(503, { type: 'server_error', code: 'overloaded' }),
    );
    await dialog.getByTestId('ai-send').click();
    const draft = dialog.getByTestId('ai-result-card');
    await expect(draft).toBeVisible();

    // The first provider had its two attempts; the second one answered.
    expect(requestsOf(provider)).toHaveLength(2);
    expect(requestsOf(fallback)).toHaveLength(1);
    for (const sent of [...requestsOf(provider), ...requestsOf(fallback)]) {
      expect(renderOutbound(sent.chat?.messages ?? []), 'exactly the previewed text').toBe(
        previewed,
      );
      expect(sent.headers.cookie).toBeUndefined();
      expect(sent.headers.referer).toBeUndefined();
      expect(sent.body).not.toContain(FAKE_KEY);
      expect(sent.body).not.toContain(OTHER_KEY);
    }
    expect(requestsOf(provider)[0]?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(requestsOf(fallback)[0]?.headers.authorization).toBe(`Bearer ${OTHER_KEY}`);
    expect(requestsOf(fallback)[0]?.chat?.model).toBe(FALLBACK_MODEL);

    await expect(dialog.getByRole('status').first()).toContainText(
      `Answer received from ${fallback.host} in 3 requests.`,
    );
    await expect(dialog).toContainText('did not answer, so the fallback you confirmed did');
    await expect(draft.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unverified');

    // The result records who really answered; the ledger holds the test and the three attempts.
    const [stored] = await readTable(options, 'aiResults');
    expect(stored).toMatchObject({
      kind: 'exam_pearl',
      provider: `openai-compatible:${fallback.host}`,
      model: FALLBACK_MODEL,
      inputSourceIds: [highlight.id],
    });
    expect((await metaValue<{ requests: number }>(options, 'aiBudget'))?.requests).toBe(4);
    expect(
      nonFixture(env, traffic).every(
        (u) =>
          u === `POST ${provider.baseUrl}/chat/completions` ||
          u === `POST ${fallback.baseUrl}/chat/completions`,
      ),
      'nothing but the two providers was contacted',
    ).toBe(true);
  });

  test('a rejected key, an account without quota and a rate limit stop at the first provider: the fallback hears nothing, the attempt is counted, nothing is saved', async ({
    env,
    provider,
    fallback,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    await addFallback(options, { label: 'Backup model', baseUrl: fallback.baseUrl });
    const { page, highlight } = await saveHighlight(env, options, '#p-pearl');
    const side = await openSide(env, page);
    const dialog = await openConsent(side, highlight.id);
    const error = dialog.getByTestId('ai-error');

    provider.queue(failure(401, { type: 'invalid_request_error', code: 'invalid_api_key' }));
    await dialog.getByTestId('ai-send').click();
    await expect(error).toContainText('The provider rejected the API key');
    expect(requestsOf(provider)).toHaveLength(1);

    provider.queue(failure(429, { type: 'insufficient_quota', code: 'insufficient_quota' }));
    await dialog.getByTestId('ai-send').click();
    await expect(error).toContainText('No quota or credit left');
    expect(requestsOf(provider)).toHaveLength(2);

    provider.queue(
      failure(429, { type: 'requests', code: 'rate_limit_exceeded' }, { 'retry-after': '45' }),
    );
    await dialog.getByTestId('ai-send').click();
    await expect(error).toContainText('Rate limited by the provider');
    await expect(error).toContainText('wait 45 seconds');
    expect(requestsOf(provider)).toHaveLength(3);

    expect(fallback.seen, 'the fallback was never asked').toEqual([]);
    expect(await countOf(options, 'aiResults')).toBe(0);
    expect((await metaValue<{ requests: number }>(options, 'aiBudget'))?.requests).toBe(3);
  });

  test('a task can start with the provider it is routed to; the consent shows that one first and the primary as its fallback', async ({
    env,
    provider,
    fallback,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    const card = await addFallback(options, { label: 'Cheap model', baseUrl: fallback.baseUrl });
    const profileId = await card.getAttribute('data-profile-id');

    // Summaries start with the cheap one; the other tasks keep the primary provider.
    await expect(routingOf(options).getByTestId('ai-route-summary')).toBeVisible();
    await routingOf(options).getByTestId('ai-route-summary').selectOption({ label: 'Cheap model' });
    await expect
      .poll(
        async () =>
          (await metaValue<{ routes: Record<string, string> }>(options, 'aiSettings'))?.routes,
      )
      .toEqual({ summary: String(profileId) });

    const { page, highlight } = await saveHighlight(env, options, '#p-pearl');
    const side = await openSide(env, page);

    let dialog = await openConsent(side, highlight.id, 'summary');
    await expect(dialog.getByTestId('ai-endpoint-line')).toContainText(
      `This will be sent to ${fallback.origin}`,
    );
    await expect(dialog.getByTestId('ai-fallbacks')).toContainText(provider.origin);
    await dialog.getByTestId('ai-send').click();
    await expect(dialog.getByTestId('ai-result-card')).toBeVisible();
    expect(requestsOf(fallback)).toHaveLength(1);
    expect(requestsOf(fallback)[0]?.chat?.model).toBe(FALLBACK_MODEL);
    expect(requestsOf(provider)).toHaveLength(0);
    await dialog.getByTestId('ai-close').click();

    dialog = await openConsent(side, highlight.id, 'exam_pearl');
    await expect(dialog.getByTestId('ai-endpoint-line')).toContainText(
      `This will be sent to ${provider.origin}`,
    );
    await expect(dialog.getByTestId('ai-fallbacks')).toContainText(fallback.origin);
    await dialog.getByTestId('ai-cancel').click();
    expect(requestsOf(provider)).toHaveLength(0);
    expect(MODEL).not.toBe(FALLBACK_MODEL);
  });

  test('keys of extra providers stay in the vault database: not in storage, a backup or the page; removing a provider removes its key', async ({
    env,
    provider,
    fallback,
  }) => {
    const options = await openExt(env, 'options');
    const { highlight } = await saveHighlight(env, options, '#p-pearl');
    await options.bringToFront();
    await setUpAi(options, provider);
    const card = await addFallback(options, { label: 'Backup model', baseUrl: fallback.baseUrl });
    const profileId = String(await card.getAttribute('data-profile-id'));

    expect(await pageContents(options)).not.toContain(OTHER_KEY);
    expect(await storageDump(options)).not.toContain(OTHER_KEY);
    expect(await storageDump(options), 'nor the address of the fallback').not.toContain(
      fallback.origin,
    );

    const text = await backupText(env, options);
    expect(text, 'the backup holds the highlight').toContain(highlight.exactQuote.slice(0, 40));
    for (const secret of [OTHER_KEY, FAKE_KEY, fallback.origin, 'aiProfileKeys', 'aiKey']) {
      expect(text, `the backup does not hold ${secret}`).not.toContain(secret);
    }

    // Remove the key alone, then the provider (with its confirmation): the row goes with it.
    await card.getByTestId('ai-profile-key-remove').click();
    await expect(card.getByTestId('ai-profile-key-status')).toContainText('No key saved.');
    expect(await metaValue(options, 'aiProfileKeys')).toBeUndefined();

    await card.getByTestId('ai-profile-key-input').fill(OTHER_KEY);
    await card.getByTestId('ai-profile-key-save').click();
    await expect(card.getByTestId('ai-profile-key-mask')).toBeVisible();
    expect(Object.keys((await metaValue(options, 'aiProfileKeys')) ?? {})).toEqual([profileId]);

    await card.getByTestId('ai-profile-remove').click();
    const confirm = options.getByRole('dialog', { name: 'Remove Backup model?' });
    await confirm.getByRole('button', { name: 'Remove provider' }).click();
    await expect(profilesOf(options)).toHaveCount(0);
    expect(await metaValue(options, 'aiProfileKeys')).toBeUndefined();
    expect((await metaValue<{ fallbacks: unknown[] }>(options, 'aiSettings'))?.fallbacks).toEqual(
      [],
    );

    // "Delete all AI data" takes the keys of every provider with it.
    await addFallback(options, { label: 'Second backup', baseUrl: fallback.baseUrl });
    expect(await metaValue(options, 'aiProfileKeys')).not.toBeUndefined();
    await options.getByTestId('ai-delete-all').click();
    await options
      .getByRole('dialog', { name: 'Delete all AI data?' })
      .getByRole('button', { name: 'Delete AI data' })
      .click();
    await expect.poll(() => metaValue(options, 'aiProfileKeys')).toBeUndefined();
    expect(await metaValue(options, 'aiKey')).toBeUndefined();
    expect(await metaValue(options, 'aiSettings')).toBeUndefined();
  });
});

// =============================================================================================
// 2. The added task kinds
// =============================================================================================

test.describe('memory aids, short viva and study outline', () => {
  test('each is an unverified draft that cites the immutable quote; a memory aid is flagged as an aid and becomes a marked note', async ({
    env,
    provider,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    const { page, highlight } = await saveHighlight(env, options, '#p-pearl');
    const side = await openSide(env, page);
    const quote = highlight.exactQuote;

    // Memory aid.
    let dialog = await openConsent(side, highlight.id, 'mnemonic');
    await dialog.getByTestId('ai-send').click();
    let draft = dialog.getByTestId('ai-result-card');
    await expect(draft).toHaveAttribute('data-kind', 'mnemonic');
    await expect(draft.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unverified');
    await expect(draft.getByTestId('ai-aid').getByText('Memory aid, not a fact')).toBeVisible();
    await expect(draft.getByTestId('ai-notice').first()).toContainText(
      'AI-generated and unverified',
    );
    await expect(draft).toContainText('is not a statement from your sources');
    // The quote the aid is anchored to is the vault's own text.
    await expect(draft.getByTestId('ai-citation').locator('blockquote')).toHaveText(quote);
    const [mnemonic] = await readTable(options, 'aiResults');
    expect(mnemonic).toMatchObject({
      kind: 'mnemonic',
      verificationState: 'unverified',
      output: { aidNotFact: true },
    });

    await draft.getByTestId('ai-accept').click();
    await expect(draft.getByTestId('ai-item-accepted')).toContainText('created note');
    const [note] = await readTable(options, 'notes');
    expect(String(note?.body)).toContain('Memory aid, not a fact');
    expect(String(note?.body)).toContain('Anchored to');
    expect(String(note?.body)).toContain('AI-generated, unverified');
    const [row] = (await readTable(options, 'highlights')).filter((r) => r.id === highlight.id);
    expect(row?.exactQuote, 'the quote is untouched').toBe(quote);
    await dialog.getByTestId('ai-close').click();

    // Short viva.
    dialog = await openConsent(side, highlight.id, 'short_viva');
    await dialog.getByTestId('ai-send').click();
    draft = dialog.getByTestId('ai-result-card');
    await expect(draft).toHaveAttribute('data-kind', 'short_viva');
    await expect(draft.getByTestId('ai-viva-question')).toHaveCount(1);
    await expect(draft).toContainText('Model answer (a draft to check)');
    await expect(draft.getByTestId('ai-citation').locator('blockquote')).toHaveText(quote);
    await dialog.getByTestId('ai-close').click();

    // Study outline: a hierarchy by level.
    dialog = await openConsent(side, highlight.id, 'study_outline');
    await dialog.getByTestId('ai-send').click();
    draft = dialog.getByTestId('ai-result-card');
    await expect(draft).toHaveAttribute('data-kind', 'study_outline');
    await expect(draft.getByTestId('ai-outline').locator(':scope > li')).toHaveCount(2);
    await expect(draft.getByTestId('ai-outline').locator('[data-level="2"]')).toHaveCount(1);
    await dialog.getByTestId('ai-close').click();

    expect(requestsOf(provider)).toHaveLength(3);
    expect(await countOf(options, 'aiResults')).toBe(3);
    expect(await countOf(options, 'knowledgePoints'), 'nothing else was created').toBe(0);
  });
});

// =============================================================================================
// 3. Chat with a bank
// =============================================================================================

test.describe('chat', () => {
  test('works with no study material at all, remembers the conversation, and survives a reload', async ({
    env,
    provider,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    const chat = await openChat(env);

    // The first message asks once what the conversation may send and shows the exact text.
    await sendChat(chat, 'How do beta blockers work?', false);
    await expect(chat.getByTestId('chat-consent')).toBeVisible();
    await expect(chat.getByTestId('chat-consent-text')).toContainText('How do beta blockers work?');
    expect(requestsOf(provider), 'nothing is sent before the person agrees').toHaveLength(0);
    await chat.getByTestId('chat-consent-accept').click();

    const first = chat.getByTestId('chat-turn').first();
    await expect(first).toContainText('E2E general chat answer.');
    await expect(first.getByTestId('chat-used')).toContainText('No notes were sent');
    expect(requestsOf(provider)).toHaveLength(1);
    expect(requestsOf(provider)[0]?.body).toContain('How do beta blockers work?');
    expect(requestsOf(provider)[0]?.body).not.toContain('kind=\\"highlight\\"');

    // The second message does not ask again, and carries the first turn as memory.
    await sendChat(chat, 'And which are cardioselective?', false);
    await expect(chat.getByTestId('chat-turn')).toHaveCount(2);
    await expect(chat.getByTestId('chat-consent')).toHaveCount(0);
    expect(requestsOf(provider)).toHaveLength(2);
    expect(requestsOf(provider)[1]?.body).toContain('E2E general chat answer.');

    // A new page lists the saved conversation and resumes it.
    const reopened = await openChat(env);
    await expect(reopened.getByTestId('chat-turn')).toHaveCount(0);
    await reopened.getByTestId('chat-thread').first().click();
    await expect(reopened.getByTestId('chat-turn')).toHaveCount(2);
    expect(await countOf(options, 'aiResults')).toBe(2);
  });

  test('finds the relevant notes on this device and cites the vault quote word for word', async ({
    env,
    provider,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    const { page } = await saveHighlight(env, options, '#p-pearl');
    const rows = await highlightsOf(options, page.url());
    const pearl = rows.find((r) => r.exactQuote.startsWith('The sinoatrial node sets'));
    if (!pearl) throw new Error('the highlight should be stored');
    const chat = await openChat(env);
    await expect(chat.getByTestId('chat-scope')).toHaveText('the bank "Inbox"');

    await sendChat(chat, 'What does the sinoatrial node do?');
    const turn = chat.getByTestId('chat-turn').first();
    await expect(turn).toContainText('E2E chat answer drawn from your notes.');
    await expect(turn.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unverified');
    await expect(turn.getByTestId('ai-citation').locator('blockquote')).toHaveText(
      pearl.exactQuote,
    );
    await expect(turn.getByTestId('chat-used')).toContainText('1 of your notes');
    // What was sent contains the quote, redaction applied, and nothing else from the vault.
    expect(requestsOf(provider)[0]?.body).toContain(pearl.exactQuote);
  });

  test('a citation that is not in the notes is flagged and cannot be saved as it is', async ({
    env,
    provider,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    await saveHighlight(env, options, '#p-pearl');
    const chat = await openChat(env);

    provider.queue((request) => {
      const block = dataBlocks(request).find((b) => b.kind === 'highlight');
      return ok({
        answer: 'Warfarin is the first-line drug for the sinoatrial node.',
        basis: 'notes',
        evidence: [
          {
            quoteId: block?.id ?? 'missing',
            text: 'Warfarin inhibits vitamin K epoxide reductase in the liver.',
          },
        ],
      });
    });
    await sendChat(chat, 'What drug acts on the sinoatrial node?');
    const turn = chat.getByTestId('chat-turn');
    await expect(turn.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unsupported');
    await expect(turn.getByTestId('ai-unsupported')).toContainText('Unsupported citation.');
    await expect(turn.getByTestId('ai-citation')).toHaveCount(0);
    await expect(turn.getByTestId('ai-accept')).toHaveAttribute('aria-disabled', 'true');
    const [stored] = await readTable(options, 'aiResults');
    expect(stored).toMatchObject({
      kind: 'chat',
      verificationState: 'unsupported',
      grounding: { checked: 1, supported: 0, unsupported: 1 },
      output: { basis: 'general' },
    });
  });

  test('with AI off the chat view only explains, and the side panel button says why; with it on, the button opens the chat for that bank', async ({
    env,
    provider,
  }) => {
    const options = await openExt(env, 'options');
    const { page } = await saveHighlight(env, options, '#p-pearl');

    const off = await env.context.newPage();
    await off.goto(`chrome-extension://${env.extensionId}/dashboard.html?view=chat`);
    await expect(off.getByText('AI features are off')).toBeVisible();
    await expect(off.getByTestId('chat-question')).toHaveCount(0);
    // The side panel button reuses an open dashboard tab: close this one so a new tab is opened.
    await off.close();

    const side = await openSide(env, page);
    await side.getByRole('tab', { name: 'Banks' }).click();
    await side.getByTestId('bank-filter').filter({ hasText: 'Inbox' }).click();
    const button = side.getByRole('button', { name: 'Chat with the notes of Inbox (AI)' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription(/AI features are off/);
    expect(provider.seen).toEqual([]);

    await options.bringToFront();
    await setUpAi(options, provider);
    await side.bringToFront();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    const opened = env.context.waitForEvent('page');
    await button.click();
    const dashboard = await opened;
    await dashboard.waitForLoadState('domcontentloaded');
    expect(new URL(dashboard.url()).searchParams.get('view')).toBe('chat');
    await expect(dashboard.getByTestId('chat-scope')).toHaveText('the bank "Inbox"');
    await expect(dashboard.getByTestId('chat-question')).toBeVisible();
    expect(provider.seen, 'opening the chat sends nothing').toEqual([]);
  });
});

// =============================================================================================
// 4. Accessibility of the new surfaces
// =============================================================================================

test.describe('accessibility', () => {
  test('the provider list, the chat view and its consent card pass axe in light and dark', async ({
    env,
    provider,
    fallback,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    await addFallback(options, { label: 'Backup model', baseUrl: fallback.baseUrl });
    await expect(routingOf(options).getByTestId('ai-route-summary')).toBeVisible();
    expect(await axeReport(options, '[data-testid="ai-routing"]'), 'provider list, light').toBe('');
    await options.emulateMedia({ colorScheme: 'dark' });
    expect(await axeReport(options, '[data-testid="ai-routing"]'), 'provider list, dark').toBe('');
    await options.emulateMedia({ colorScheme: 'light' });
    await expect(aiSwitch(options)).toBeChecked();

    await saveHighlight(env, options, '#p-pearl');
    const chat = await openChat(env);
    expect(await axeReport(chat, '[data-testid="chat-view"]'), 'chat view, light').toBe('');
    await chat.emulateMedia({ colorScheme: 'dark' });
    expect(await axeReport(chat, '[data-testid="chat-view"]'), 'chat view, dark').toBe('');
    await chat.emulateMedia({ colorScheme: 'light' });

    await sendChat(chat, 'What does the sinoatrial node do?', false);
    await expect(chat.getByTestId('chat-consent')).toBeVisible();
    expect(await axeReport(chat, '[data-testid="chat-consent"]'), 'consent card, light').toBe('');
    await chat.emulateMedia({ colorScheme: 'dark' });
    expect(await axeReport(chat, '[data-testid="chat-consent"]'), 'consent card, dark').toBe('');
    await chat.emulateMedia({ colorScheme: 'light' });
    expect(requestsOf(provider)).toHaveLength(0);
  });
});
