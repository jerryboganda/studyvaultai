import { startFakeProvider, failure, type FakeProvider } from './aiServer';
import {
  configureProvider,
  enableAi,
  expect,
  metaValue,
  openChat,
  openExt,
  pickCard,
  saveKey,
  sendChat,
  setupStep,
  test as base,
} from './helpers.aiExtras';

/**
 * The UBAG gateway preset, end to end in a real loaded extension against a LOCAL fake of the
 * gateway's OpenAI facade (./aiServer.ts, `api: 'ubag'`): HTTP Basic credentials, a model list with
 * `target|setting` ids, a thinking level that swaps the model id, a "still running" 504 that is
 * answered by sending the same request again, and chat with a second provider. No real gateway, no
 * real credentials; the live gateway is checked with scripts/smoke-ubag.mjs by its owner.
 */

const LOGIN = 'operator:e2e-pass-12345';

const test = base.extend<{ ubag: FakeProvider }>({
  // Playwright requires an object-destructuring first argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  ubag: async ({}, use) => {
    const ubag = await startFakeProvider({ apiKey: LOGIN, api: 'ubag' });
    await use(ubag);
    await ubag.close();
  },
});

test.describe.configure({ timeout: 150_000 });

/** The chat requests (the two probes of "Test connection" are not study traffic). */
const chatRequests = (p: FakeProvider) =>
  p.completions().filter((c) => c.chat?.messages[0]?.content !== 'Reply with the single word: OK');

const basicOf = (login: string) => `Basic ${Buffer.from(login, 'utf8').toString('base64')}`;

test.describe('UBAG preset', () => {
  test('credentials are sent as HTTP Basic, the model list loads, a thinking level swaps the model id, and the test connection works', async ({
    env,
    ubag,
  }) => {
    const options = await openExt(env, 'options');
    await enableAi(options);
    await configureProvider(options, {
      baseUrl: ubag.baseUrl,
      model: 'deepseek_web',
      preset: 'ubag',
    });
    await saveKey(options, LOGIN);
    expect(
      await metaValue<{ vendor?: string; authScheme?: string }>(options, 'aiSettings'),
    ).toMatchObject({
      vendor: 'ubag',
      authScheme: 'basic',
    });

    // Edit setup: the saved login lists the models; Medium belongs to chatgpt_web.
    await options.getByTestId('ai-edit-setup').click();
    await pickCard(options, 'ai-preset-ubag');
    await options.getByTestId('ai-setup-next').click();
    await expect(setupStep(options, 'Address and model')).toBeVisible();
    await options.getByTestId('ai-model').fill('chatgpt_web');
    await options.getByTestId('ai-load-models').click();
    await expect(options.getByTestId('ai-models-note')).toContainText('4 models');
    await options.getByTestId('ai-effort').selectOption({ label: 'Medium' });
    await expect(options.getByTestId('ai-model')).toHaveValue('chatgpt_web|Medium');
    await options.getByTestId('ai-setup-next').click();
    await options.getByTestId('ai-setup-next').click();
    await options.getByTestId('ai-setup-save').click();
    await expect
      .poll(async () => (await metaValue<{ model?: string }>(options, 'aiSettings'))?.model)
      .toBe('chatgpt_web|Medium');

    await options.getByTestId('ai-test').click();
    await expect(options.getByTestId('ai-test-result')).toContainText('OK');
    const auth = ubag.seen.map((s) => s.headers.authorization);
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.every((h) => h === basicOf(LOGIN))).toBe(true);
    // The model list and the probe both asked for the chosen model id as written.
    expect(ubag.completions().at(-1)?.chat?.model).toBe('chatgpt_web|Medium');
  });

  test('a request the gateway reports as still running is sent again unchanged, and the chat shows one answer', async ({
    env,
    ubag,
  }) => {
    const options = await openExt(env, 'options');
    await enableAi(options);
    await configureProvider(options, {
      baseUrl: ubag.baseUrl,
      model: 'deepseek_web',
      preset: 'ubag',
    });
    await saveKey(options, LOGIN);

    const wait = () => failure(504, { type: 'timeout_error', code: 'wait_timeout' });
    ubag.queue(wait(), wait());
    const chat = await openChat(env);
    await sendChat(chat, 'How do beta blockers work?');
    await expect(chat.getByTestId('chat-turn')).toHaveCount(1);
    await expect(chat.getByTestId('chat-turn').first()).toContainText('E2E general chat answer.');

    const requests = chatRequests(ubag);
    expect(requests).toHaveLength(3);
    // Byte-identical: that is what lets the gateway join the running job instead of starting another.
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(requests[2]?.body).toBe(requests[0]?.body);
    const body = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ stream: false });
    expect(body.ubag_wait_ms).toBe(240_000);
    expect(headersOk(requests.map((r) => r.headers.authorization))).toBe(true);
  });

  test('a second provider added with "Add another provider" can be chosen in the chat, which asks once more before using it', async ({
    env,
    ubag,
    provider,
  }) => {
    provider.setKey(undefined);
    const options = await openExt(env, 'options');
    await enableAi(options);
    await configureProvider(options, {
      baseUrl: ubag.baseUrl,
      model: 'deepseek_web',
      preset: 'ubag',
    });
    await saveKey(options, LOGIN);

    // The same step-by-step wizard, now for a backup provider.
    await options.getByTestId('ai-add-provider').click();
    await pickCard(options, 'ai-preset-custom');
    await options.getByTestId('ai-setup-next').click();
    await options.getByTestId('ai-base-url').fill(provider.baseUrl);
    await options.getByTestId('ai-model').fill('backup-model-1');
    await options.getByTestId('ai-setup-next').click();
    await options.getByTestId('ai-setup-save').click();
    await expect(options.getByTestId('ai-backups')).toContainText('backup-model-1');

    const chat = await openChat(env);
    await sendChat(chat, 'First message goes to the main provider');
    await expect(chat.getByTestId('chat-turn')).toHaveCount(1);
    expect(chatRequests(ubag)).toHaveLength(1);

    await chat.getByTestId('chat-profile').selectOption({ index: 1 });
    await chat.getByTestId('chat-question').fill('Second message goes to the backup');
    await chat.getByTestId('chat-ask').click();
    // A new recipient: the agreement is asked for again, then the message goes there only.
    await chat.getByTestId('chat-consent-accept').click();
    await expect(chat.getByTestId('chat-turn')).toHaveCount(2);
    expect(chatRequests(provider)).toHaveLength(1);
    expect(chatRequests(ubag)).toHaveLength(1);
  });

  test('a personal access token is sent as a Bearer token instead of Basic credentials', async ({
    env,
  }) => {
    const token = 'ubag_pat_e2e_token_123456';
    const gateway = await startFakeProvider({ apiKey: token, api: 'ubag', ubagAuth: 'bearer' });
    try {
      const options = await openExt(env, 'options');
      await enableAi(options);
      await configureProvider(options, {
        baseUrl: gateway.baseUrl,
        model: 'deepseek_web',
        preset: 'ubag',
        // The wizard's own choice, made before saving.
        before: async () => {
          await options.getByTestId('ai-auth-scheme').selectOption('bearer');
        },
      });
      await saveKey(options, token);
      expect(await metaValue<{ authScheme?: string }>(options, 'aiSettings')).toMatchObject({
        authScheme: 'bearer',
      });
      await options.getByTestId('ai-test').click();
      await expect(options.getByTestId('ai-test-result')).toContainText('OK');
      const auth = gateway.seen.map((s) => s.headers.authorization);
      expect(auth.length).toBeGreaterThan(0);
      expect(auth.every((h) => h === `Bearer ${token}`)).toBe(true);
    } finally {
      await gateway.close();
    }
  });
});

const headersOk = (headers: (string | undefined)[]) => headers.every((h) => h === basicOf(LOGIN));
