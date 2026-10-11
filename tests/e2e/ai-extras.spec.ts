import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { dataBlocks, failure, ok, type FakeProvider } from './aiServer';
import {
  FAKE_KEY,
  FALLBACK_MODEL,
  MODEL,
  OTHER_KEY,
  addFallback,
  aiSwitch,
  askChat,
  axeReport,
  chatPassagesOf,
  expect,
  highlightsOf,
  metaValue,
  nonFixture,
  openChat,
  openConsent,
  openExt,
  openSide,
  outboundOf,
  pageContents,
  profilesOf,
  readTable,
  renderOutbound,
  routingOf,
  saveBlock,
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

const DIALOG = '[data-testid="ai-consent-dialog"]';

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

    const download = options.waitForEvent('download');
    await options.getByTestId('backup-export-start').click();
    const file = await (await download).path();
    const text = Object.values(unzipSync(new Uint8Array(fs.readFileSync(file))))
      .map((bytes) => strFromU8(bytes))
      .join('\n');
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

test.describe('chat with your notes', () => {
  test('retrieval is local; the preview lists the passages and earlier turns to untick; what is sent is exactly what was shown; the answer cites the vault quote', async ({
    env,
    provider,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    // Both on ONE page: the harness finds a tab to activate by its address, so a second tab at the
    // same address would never get the content script.
    const { page } = await saveHighlight(env, options, '#p-pearl');
    await saveBlock(options, page, '#p-second');
    const rows = await highlightsOf(options, page.url());
    const pearl = rows.find((r) => r.exactQuote.startsWith('The sinoatrial node sets'));
    const vagal = rows.find((r) => r.exactQuote.startsWith('Parasympathetic stimulation'));
    if (!pearl || !vagal) throw new Error('both highlights should be stored');
    const chat = await openChat(env);
    await expect(chat.getByTestId('chat-scope')).toHaveText('the bank "Inbox"');

    // First question: both passages match; one is unticked.
    let dialog = await askChat(chat, 'What does the sinoatrial node do?');
    expect(requestsOf(provider), 'searching and previewing send nothing').toHaveLength(0);
    await expect(chatPassagesOf(dialog)).toHaveCount(2);
    const outbound = dialog.getByTestId('ai-outbound');
    await expect(outbound).toContainText(pearl.exactQuote);
    await expect(outbound).toContainText(vagal.exactQuote);
    await dialog.getByRole('checkbox', { name: /Parasympathetic stimulation/ }).uncheck();
    await expect(outbound).not.toContainText('Parasympathetic stimulation');
    await expect(outbound).toContainText(pearl.exactQuote);
    const previewed = await outboundOf(dialog);

    await dialog.getByTestId('ai-send').click();
    await expect(dialog.getByTestId('ai-result-card')).toBeVisible();
    const [first] = requestsOf(provider);
    expect(requestsOf(provider)).toHaveLength(1);
    expect(renderOutbound(first?.chat?.messages ?? [])).toBe(previewed);
    expect(first?.body).not.toContain('Parasympathetic stimulation');
    expect(first?.body).toContain('What does the sinoatrial node do?');
    await dialog.getByTestId('ai-close').click();

    const turn = chat.getByTestId('chat-turn').first();
    await expect(turn).toContainText('What does the sinoatrial node do?');
    await expect(turn.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unverified');
    await expect(turn.getByTestId('ai-citation').locator('blockquote')).toHaveText(
      pearl.exactQuote,
    );
    await expect(turn).toContainText('E2E answer drawn from the first passage.');

    // Follow-up: the earlier turn is offered, ticked, and is sent only while it stays ticked.
    dialog = await askChat(chat, 'And what slows it?');
    const history = dialog.getByTestId('ai-chat-history');
    await expect(history.getByTestId('ai-chat-turn')).toHaveCount(2);
    await expect(history.getByTestId('ai-chat-turn').first()).toBeChecked();
    await expect(dialog.getByTestId('ai-outbound')).toContainText(
      'E2E answer drawn from the first passage.',
    );
    await history.getByTestId('ai-chat-turn').last().uncheck();
    await expect(dialog.getByTestId('ai-outbound')).not.toContainText(
      'E2E answer drawn from the first passage.',
    );
    await dialog.getByTestId('ai-send').click();
    await expect(dialog.getByTestId('ai-result-card')).toBeVisible();
    expect(requestsOf(provider)).toHaveLength(2);
    const second = requestsOf(provider)[1];
    expect(second?.body).not.toContain('E2E answer drawn from the first passage.');
    expect(second?.body).toContain('And what slows it?');
    await dialog.getByTestId('ai-close').click();
    await expect(chat.getByTestId('chat-turn')).toHaveCount(2);

    // The conversation is this page's: a new page has none, and nothing but the drafts was stored.
    const reopened = await openChat(env);
    await expect(reopened.getByTestId('chat-turn')).toHaveCount(0);
    expect(await countOf(options, 'aiResults')).toBe(2);
  });

  test('a citation that is not in the passages is flagged, the answer is not presented as one, and it cannot be saved as it is', async ({
    env,
    provider,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    await saveHighlight(env, options, '#p-pearl');
    const chat = await openChat(env);

    provider.queue((request) => {
      const [block] = dataBlocks(request);
      return ok({
        answer: 'Warfarin is the first-line drug for the sinoatrial node.',
        answerState: 'answered',
        uncertainty: '',
        evidence: [
          {
            quoteId: block?.id ?? 'missing',
            text: 'Warfarin inhibits vitamin K epoxide reductase in the liver.',
          },
        ],
      });
    });
    const dialog = await askChat(chat, 'What drug acts on the sinoatrial node?');
    await dialog.getByTestId('ai-send').click();
    await expect(dialog.getByTestId('ai-result-card')).toBeVisible();
    await dialog.getByTestId('ai-close').click();

    const turn = chat.getByTestId('chat-turn');
    await expect(turn.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unsupported');
    await expect(turn.getByTestId('ai-unsupported')).toContainText('Unsupported citation.');
    await expect(turn.getByTestId('ai-citation')).toHaveCount(0);
    await expect(turn.getByTestId('chat-cannot-answer')).toBeVisible();
    await expect(turn.getByTestId('ai-accept')).toHaveAttribute('aria-disabled', 'true');
    const [stored] = await readTable(options, 'aiResults');
    expect(stored).toMatchObject({
      kind: 'explain',
      verificationState: 'unsupported',
      grounding: { checked: 1, supported: 0, unsupported: 1 },
      output: { answerState: 'insufficient_sources' },
    });
  });

  test('"cannot answer from your notes": no match sends nothing; a model that says so is shown as an answer; an empty selection cannot be sent', async ({
    env,
    provider,
  }) => {
    const options = await openExt(env, 'options');
    await setUpAi(options, provider);
    await saveHighlight(env, options, '#p-pearl');
    const chat = await openChat(env);

    // Nothing in the notes matches: said on this device, no request, no dialog.
    await chat.getByTestId('chat-question').fill('zebrafish genomics pipeline');
    await expect(chat.getByTestId('chat-ask')).not.toHaveAttribute('aria-disabled', 'true');
    await chat.getByTestId('chat-ask').click();
    await expect(chat.getByTestId('chat-note')).toContainText('Cannot answer from your notes');
    await expect(chat.getByTestId('chat-note')).toContainText('nothing was sent');
    await expect(chat.getByTestId('ai-consent-dialog')).toHaveCount(0);
    expect(provider.seen).toEqual([]);

    // Every passage unticked: Send says why and does nothing.
    let dialog = await askChat(chat, 'What does the sinoatrial node do?');
    await chatPassagesOf(dialog).first().uncheck();
    await expect(dialog.getByTestId('ai-send')).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByTestId('ai-send-reason')).toContainText('Tick at least one passage');
    await dialog.getByTestId('ai-send').click({ force: true });
    expect(provider.seen).toEqual([]);
    await dialog.getByTestId('ai-cancel').click();

    // The model itself says the notes do not answer it.
    provider.queue(
      ok({
        answer: 'Your passages do not say what the node does at night.',
        answerState: 'insufficient_sources',
        uncertainty: 'No passage mentions the night.',
        evidence: [],
      }),
    );
    dialog = await askChat(chat, 'What does the sinoatrial node do at night?');
    await dialog.getByTestId('ai-send').click();
    await expect(dialog.getByTestId('ai-result-card')).toBeVisible();
    await dialog.getByTestId('ai-close').click();
    const turn = chat.getByTestId('chat-turn');
    await expect(turn.getByTestId('chat-cannot-answer')).toContainText(
      'No passage mentions the night.',
    );
    await expect(turn.getByTestId('ai-verification')).toHaveAttribute('data-state', 'unverified');
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
  test('the provider list, the chat view and its consent dialog pass axe in light and dark', async ({
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

    const dialog = await askChat(chat, 'What does the sinoatrial node do?');
    await expect(dialog.getByTestId('ai-fallbacks')).toBeVisible();
    expect(await axeReport(chat, DIALOG), 'consent dialog with passages, light').toBe('');
    await chat.emulateMedia({ colorScheme: 'dark' });
    expect(await axeReport(chat, DIALOG), 'consent dialog with passages, dark').toBe('');
    await chat.emulateMedia({ colorScheme: 'light' });
    await chat.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Focus goes back to the button that opened the dialog.
    await expect(chat.getByTestId('chat-ask')).toBeFocused();
    expect(requestsOf(provider)).toHaveLength(0);
  });
});
