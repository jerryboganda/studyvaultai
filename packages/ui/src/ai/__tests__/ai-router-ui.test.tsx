import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  configure as configureTestingLibrary,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import {
  AiError,
  createCoordinator,
  createMockProvider,
  systemClock,
  type AiSelection,
  type AiTaskKind,
  type MockProvider,
  type MockStep,
} from '@ai';
import { goodReply } from '@ai/testkit';
import { defaultSettings } from '@shared';
import {
  defaultAiSettings,
  getAiBudget,
  getAiProfileApiKey,
  getAiSettings,
  getDb,
  listAiResults,
  newAiProfileId,
  setAiApiKey,
  setAiProfileApiKey,
  setAiSettings,
  updateAiSettings,
  type AiProfile,
} from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { makeChromeFakes } from '@ui/testing/fakes';
import { AiEnvProvider } from '../context';
import { AiSettingsSection } from '../AiSettingsSection';
import { ConsentPreviewDialog } from '../ConsentPreviewDialog';
import type { AiChatInput } from '../chat';
import { HighlightAiActions } from '../HighlightAiActions';
import { useAiConfig } from '../hooks';
import type { AiEnv } from '../runtime';

vi.setConfig({ testTimeout: 30_000 });
configureTestingLibrary({ asyncUtilTimeout: 8_000 });

const ORIGIN_A = 'https://a.example.test';
const ORIGIN_B = 'https://b.example.test';
const KEY_A = 'sk-test-AAAA0123456789SECRETKEYA';
const KEY_B = 'sk-test-BBBB0123456789SECRETKEYB';

const Q1 = 'Metformin is the first-line pharmacological treatment for type 2 diabetes mellitus.';
const Q2 =
  'Insulin therapy is required in type 1 diabetes mellitus because beta cells are destroyed.';

let chrome: ReturnType<typeof makeChromeFakes>;

/** Providers by profile id: 'primary' and the fallbacks. */
type Providers = Record<string, MockProvider>;

function envFor(providers: Providers, over: Partial<AiEnv> = {}): AiEnv {
  return {
    fetch: vi.fn(() => Promise.reject(new Error('no network in this test'))) as never,
    clock: {
      ...systemClock(),
      sha256: (text: string) => Promise.resolve(createHash('sha256').update(text).digest('hex')),
    },
    coordinator: createCoordinator(2),
    online: () => true,
    createProvider: ({ profileId }) => {
      const p = providers[profileId];
      if (!p) throw new Error(`no scripted provider for ${profileId}`);
      return p;
    },
    ...over,
  };
}

const mock = (name: string, steps: readonly MockStep[]) =>
  createMockProvider(steps, {
    id: `openai-compatible:${name}.example.test`,
    model: `${name}-model`,
  });

const fail = (code: 'network' | 'server_error' | 'auth', status?: number): MockStep => ({
  error: new AiError(code, status === undefined ? {} : { status, detail: `HTTP ${status}` }),
});

async function turnAi(on: boolean) {
  await browser.storage.local.set({
    settings: { ...defaultSettings(), features: { ...defaultSettings().features, ai: on } },
  });
}

const profile = (over: Partial<AiProfile> = {}): AiProfile => ({
  id: newAiProfileId(),
  label: 'Provider B',
  provider: 'openai_compatible',
  baseUrl: `${ORIGIN_B}/v1`,
  model: 'b-model',
  jsonMode: true,
  maxTokensParam: 'max_tokens',
  vendor: 'custom',
  reasoningEffort: '',
  authScheme: 'bearer',
  pricing: null,
  fallback: true,
  ...over,
});

/** The primary provider (with its key) and, optionally, fallbacks with keys. */
async function configure(fallbacks: { profile: AiProfile; key: string | null }[] = []) {
  await setAiSettings({
    ...defaultAiSettings(),
    baseUrl: `${ORIGIN_A}/v1`,
    model: 'a-model',
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
    fallbacks: fallbacks.map((f) => f.profile),
  });
  await setAiApiKey(KEY_A, ORIGIN_A);
  for (const f of fallbacks) {
    if (f.key) await setAiProfileApiKey(f.profile.id, f.key, new URL(f.profile.baseUrl).origin);
  }
}

const asHighlight = (h: { id: string; exactQuote: string }) => ({
  id: h.id,
  exactQuote: h.exactQuote,
});
const selectionOf = (...hs: { id: string; exactQuote: string }[]): AiSelection => ({
  chunks: hs.map((h) => ({ id: h.id, kind: 'highlight' as const, text: h.exactQuote })),
});
const reply = (kind: AiTaskKind, hs: { id: string; exactQuote: string }[]) =>
  goodReply(kind, selectionOf(...hs));

beforeEach(async () => {
  await freshDatabase();
  chrome = makeChromeFakes();
  Object.assign(browser, chrome);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type User = ReturnType<typeof userEvent.setup>;

function renderActions(env: AiEnv, hs: { id: string; exactQuote: string }[]) {
  return render(
    <AiEnvProvider env={env}>
      <HighlightAiActions highlights={hs.map(asHighlight)} />
    </AiEnvProvider>,
  );
}
async function openAction(user: User, kind: string) {
  const button = await screen.findByTestId(`ai-action-${kind}`);
  await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
  await user.click(button);
}
async function sendNow(user: User) {
  const send = await screen.findByTestId('ai-send');
  await waitFor(() => expect(send.getAttribute('aria-disabled')).toBeNull());
  await user.click(send);
}

// ---------------------------------------------------------------------------------------------

describe('fallback providers in the AI settings', () => {
  it(
    'adds a provider, validates it, keeps its key apart, tests only it, and removes it with its key',
    { timeout: 90_000 },
    async () => {
      const user = userEvent.setup();
      await turnAi(true);
      await configure();
      const b = mock('b', [{ text: 'OK', usage: { inputTokens: 9, outputTokens: 1 } }]);
      // The test of a provider must reach that provider only: the primary one is scripted to fail loudly.
      const a = mock('a', []);
      render(
        <AiEnvProvider
          env={envFor(
            { primary: a },
            {
              createProvider: ({ profileId, settings }) => {
                if (profileId === 'primary') return a;
                expect(settings.baseUrl).toBe(`${ORIGIN_B}/v1`);
                return b;
              },
            },
          )}
        >
          <AiSettingsSection />
        </AiEnvProvider>,
      );

      const add = await screen.findByTestId('ai-profile-add');
      expect(screen.getByTestId('ai-fallbacks-empty')).toBeTruthy();
      await waitFor(() => expect(add.getAttribute('aria-disabled')).toBeNull());
      await user.click(add);
      const card = await screen.findByTestId('ai-profile');
      expect((await getAiSettings()).fallbacks).toHaveLength(1);

      // A plain-http address the extension could not reach is explained and cannot be saved.
      const url = within(card).getByTestId('ai-profile-base-url');
      await user.type(url, 'http://example.com/v1');
      expect(within(card).getByTestId('ai-profile-endpoint-status').textContent).toMatch(
        /localhost/,
      );
      await user.type(within(card).getByTestId('ai-profile-model'), 'b-model');
      await user.click(within(card).getByTestId('ai-profile-save'));
      expect(await within(card).findByText('Check these settings')).toBeTruthy();

      await user.clear(url);
      await user.type(url, `${ORIGIN_B}/v1`);
      expect(within(card).getByTestId('ai-profile-endpoint-status').textContent).toContain(
        ORIGIN_B,
      );
      await user.click(within(card).getByTestId('ai-profile-save'));
      await waitFor(async () => {
        const [p] = (await getAiSettings()).fallbacks;
        expect(p).toMatchObject({ baseUrl: `${ORIGIN_B}/v1`, model: 'b-model' });
      });

      // The key: masked, bound to the address, never in the page.
      await user.type(within(card).getByTestId('ai-profile-key-input'), KEY_B);
      await waitFor(() =>
        expect(
          within(card).getByTestId('ai-profile-key-save').getAttribute('aria-disabled'),
        ).toBeNull(),
      );
      await user.click(within(card).getByTestId('ai-profile-key-save'));
      const mask = await within(card).findByTestId('ai-profile-key-mask');
      expect(mask.textContent).toBe(`••••••••${KEY_B.slice(-4)}`);
      expect(document.body.textContent).not.toContain(KEY_B);
      const [saved] = (await getAiSettings()).fallbacks;
      expect(await getAiProfileApiKey(saved!.id, ORIGIN_B)).toBe(KEY_B);
      expect(JSON.stringify(await getAiSettings())).not.toContain(KEY_B);

      // Test connection: asks Chrome for that one address, sends the fixed message to that provider only.
      const test = within(card).getByTestId('ai-profile-test');
      await waitFor(() => expect(test.getAttribute('aria-disabled')).toBeNull());
      await user.click(test);
      const result = await within(card).findByTestId('ai-profile-test-result');
      expect(result.textContent).toContain('"OK"');
      expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: [`${ORIGIN_B}/*`] });
      expect(b.calls[0]!.messages).toEqual([
        { role: 'user', content: 'Reply with the single word: OK' },
      ]);
      expect(a.calls).toHaveLength(0);
      expect((await getAiBudget()).requests).toBe(1);

      // Remove: confirmation, then the provider and its key are gone.
      await user.click(within(card).getByTestId('ai-profile-remove'));
      const dialog = await screen.findByRole('dialog', { name: /Remove Fallback 1\?/ });
      await user.click(within(dialog).getByRole('button', { name: 'Remove provider' }));
      await waitFor(async () => expect((await getAiSettings()).fallbacks).toEqual([]));
      expect(await getDb().meta.get('aiProfileKeys')).toBeUndefined();
      expect(await screen.findByTestId('ai-fallbacks-empty')).toBeTruthy();
    },
  );

  it('orders the fallbacks, and saves which provider each task starts with', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    const b = profile({ label: 'Provider B' });
    const c = profile({ label: 'Provider C', baseUrl: 'https://c.example.test/v1' });
    await configure([
      { profile: b, key: KEY_B },
      { profile: c, key: KEY_B },
    ]);
    render(
      <AiEnvProvider
        env={envFor({ primary: mock('a', []), [b.id]: mock('b', []), [c.id]: mock('c', []) })}
      >
        <AiSettingsSection />
      </AiEnvProvider>,
    );
    const cards = await screen.findAllByTestId('ai-profile');
    expect(
      cards.map((x) => within(x).getByTestId('ai-profile-label').getAttribute('value')),
    ).toEqual(['Provider B', 'Provider C']);
    // The first cannot go up, the last cannot go down: the buttons say why.
    expect(within(cards[0]!).getByTestId('ai-profile-up').getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(within(cards[1]!).getByTestId('ai-profile-down').getAttribute('aria-disabled')).toBe(
      'true',
    );

    await user.click(within(cards[1]!).getByTestId('ai-profile-up'));
    await waitFor(async () =>
      expect((await getAiSettings()).fallbacks.map((p) => p.label)).toEqual([
        'Provider C',
        'Provider B',
      ]),
    );

    // Summaries start with provider C; an explanation goes back to the default and the key stays.
    const routeSelect = (await screen.findByTestId('ai-route-summary')) as HTMLSelectElement;
    await user.selectOptions(routeSelect, c.id);
    await waitFor(async () => expect((await getAiSettings()).routes).toEqual({ summary: c.id }));
    await user.selectOptions(screen.getByTestId('ai-route-explain'), b.id);
    await user.selectOptions(screen.getByTestId('ai-route-explain'), 'primary');
    await waitFor(async () => expect((await getAiSettings()).routes).toEqual({ summary: c.id }));

    // Removing the provider a task starts with drops that route.
    await updateAiSettings((cur) => ({
      ...cur,
      fallbacks: cur.fallbacks.filter((p) => p.id !== c.id),
    }));
    await waitFor(async () => expect((await getAiSettings()).routes).toEqual({}));
  });
});

// ---------------------------------------------------------------------------------------------

describe('the consent dialog with fallback providers', () => {
  it('shows every address that may receive the text, asks Chrome for all of them once, and sends nothing before Send', async () => {
    const user = userEvent.setup();
    const h = await save(Q1);
    await turnAi(true);
    const b = profile();
    await configure([{ profile: b, key: KEY_B }]);
    const a = mock('a', [{ json: reply('summary', [h]) }]);
    renderActions(envFor({ primary: a, [b.id]: mock('b', []) }), [h]);
    await openAction(user, 'summary');

    const dialog = await screen.findByTestId('ai-consent-dialog');
    await within(dialog).findByTestId('ai-outbound');
    const line = within(dialog).getByTestId('ai-endpoint-line');
    expect(line.textContent).toContain(`This will be sent to ${ORIGIN_A}`);
    const fallbacks = within(dialog).getByTestId('ai-fallbacks');
    expect(fallbacks.textContent).toContain('Only if a.example.test is not answering');
    const targets = within(fallbacks).getAllByTestId('ai-fallback-target');
    expect(targets).toHaveLength(1);
    expect(targets[0]!.textContent).toContain(ORIGIN_B);
    expect(targets[0]!.textContent).toContain('b-model');
    expect(targets[0]!.textContent).toContain(`API key saved (••••••••${KEY_B.slice(-4)})`);
    expect(line.textContent).not.toContain(KEY_A);
    expect(line.textContent).not.toContain(KEY_B);
    expect(within(dialog).getByTestId('ai-send').textContent).toContain('1 fallback');
    expect(a.calls).toHaveLength(0);
    expect(chrome.permissions.request).not.toHaveBeenCalled();

    await sendNow(user);
    await screen.findAllByTestId('ai-result-card');
    // One request for the two origins, in the order they are tried.
    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: [`${ORIGIN_A}/*`, `${ORIGIN_B}/*`],
    });
    expect(a.calls).toHaveLength(1);
  });

  it('sends nothing to anyone when Chrome does not grant every address, and names them all', async () => {
    const user = userEvent.setup();
    const h = await save(Q1);
    await turnAi(true);
    const b = profile();
    await configure([{ profile: b, key: KEY_B }]);
    const a = mock('a', [{ json: reply('summary', [h]) }]);
    const second = mock('b', [{ json: reply('summary', [h]) }]);
    renderActions(envFor({ primary: a, [b.id]: second }), [h]);
    await openAction(user, 'summary');
    chrome.permissions.request.mockResolvedValueOnce(false);
    await sendNow(user);

    const error = await screen.findByTestId('ai-error');
    expect(error.textContent).toContain(`${ORIGIN_A}, ${ORIGIN_B}`);
    expect(error.textContent).toContain('so nothing was sent');
    expect(error.textContent).toMatch(/turn the fallback providers off/);
    expect(a.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
    expect((await getAiBudget()).requests).toBe(0);
  });

  it('takes the next provider after a server error, says so, counts every attempt, and records who answered', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    const h2 = await save(Q2);
    await turnAi(true);
    const b = profile();
    await configure([{ profile: b, key: KEY_B }]);
    const a = mock('a', [fail('server_error', 503), fail('server_error', 503)]);
    const second = mock('b', [{ json: reply('summary', [h1, h2]) }]);
    renderActions(envFor({ primary: a, [b.id]: second }), [h1, h2]);
    await openAction(user, 'summary');
    await sendNow(user);

    const card = (await screen.findAllByTestId('ai-result-card'))[0]!;
    const done = await screen.findByText(/Answer received from b\.example\.test in 3 requests\./);
    expect(done.textContent).toContain('did not answer, so the fallback you confirmed did');
    // The fallback saw exactly what was previewed.
    expect(second.calls[0]!.messages).toEqual(a.calls[0]!.messages);
    expect(a.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(1);
    expect((await getAiBudget()).requests).toBe(3);
    const [stored] = await listAiResults();
    expect(stored).toMatchObject({
      provider: 'openai-compatible:b.example.test',
      model: 'b-model',
      verificationState: 'unverified',
    });
    expect(within(card).getByTestId('ai-verification').getAttribute('data-state')).toBe(
      'unverified',
    );
  });

  it('does not pass a rejected key on to the next provider, and still counts the attempt', async () => {
    const user = userEvent.setup();
    const h = await save(Q1);
    await turnAi(true);
    const b = profile();
    await configure([{ profile: b, key: KEY_B }]);
    const a = mock('a', [fail('auth', 401)]);
    const second = mock('b', [{ json: reply('summary', [h]) }]);
    renderActions(envFor({ primary: a, [b.id]: second }), [h]);
    await openAction(user, 'summary');
    await sendNow(user);

    const error = await screen.findByTestId('ai-error');
    expect(error.textContent).toMatch(/rejected the API key/);
    expect(second.calls).toHaveLength(0);
    expect(await listAiResults()).toEqual([]);
    expect((await getAiBudget()).requests).toBe(1);
  });

  it('starts a task with the provider it is routed to, and uses the primary one only as a fallback', async () => {
    const user = userEvent.setup();
    const h = await save(Q1);
    await turnAi(true);
    const b = profile();
    await configure([{ profile: b, key: KEY_B }]);
    await updateAiSettings((cur) => ({ ...cur, routes: { summary: b.id } }));
    const a = mock('a', []);
    const second = mock('b', [{ json: reply('summary', [h]) }]);
    renderActions(envFor({ primary: a, [b.id]: second }), [h]);
    await openAction(user, 'summary');

    const dialog = await screen.findByTestId('ai-consent-dialog');
    await within(dialog).findByTestId('ai-outbound');
    expect(within(dialog).getByTestId('ai-endpoint-line').textContent).toContain(
      `This will be sent to ${ORIGIN_B}`,
    );
    const targets = within(dialog).getAllByTestId('ai-fallback-target');
    expect(targets[0]!.textContent).toContain(ORIGIN_A);
    await sendNow(user);
    await screen.findAllByTestId('ai-result-card');
    expect(second.calls).toHaveLength(1);
    expect(a.calls).toHaveLength(0);
  });

  it('leaves a provider that is not set up out of the list, and says so', async () => {
    const user = userEvent.setup();
    const h = await save(Q1);
    await turnAi(true);
    const noKey = profile({ label: 'Needs a key' });
    await configure([{ profile: noKey, key: null }]);
    renderActions(envFor({ primary: mock('a', []), [noKey.id]: mock('b', []) }), [h]);
    await openAction(user, 'summary');
    const dialog = await screen.findByTestId('ai-consent-dialog');
    await within(dialog).findByTestId('ai-outbound');
    expect(within(dialog).queryByTestId('ai-fallbacks')).toBeNull();
    expect(within(dialog).getByTestId('ai-fallbacks-skipped').textContent).toContain('Needs a key');
    // Nothing is missing for the first provider: Send is available.
    await waitFor(() =>
      expect(within(dialog).getByTestId('ai-send').getAttribute('aria-disabled')).toBeNull(),
    );
  });

  it('a provider that is the first for a task and has no key blocks it, by name', async () => {
    const user = userEvent.setup();
    const h = await save(Q1);
    await turnAi(true);
    const noKey = profile({ label: 'Needs a key' });
    await configure([{ profile: noKey, key: null }]);
    await updateAiSettings((cur) => ({ ...cur, routes: { summary: noKey.id } }));
    const a = mock('a', [{ json: reply('summary', [h]) }]);
    renderActions(envFor({ primary: a, [noKey.id]: mock('b', []) }), [h]);
    await openAction(user, 'summary');
    const send = await screen.findByTestId('ai-send');
    await waitFor(() => expect(send.getAttribute('aria-disabled')).toBe('true'));
    expect(screen.getByTestId('ai-send-reason').textContent).toContain(
      'Add the API key of "Needs a key"',
    );
    await user.click(send);
    expect(a.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the added task kinds', () => {
  it('are offered, and each result says what it is: a memory aid is flagged, with the quote it anchors', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    const h2 = await save(Q2);
    await turnAi(true);
    await configure();
    const a = mock('a', [
      { json: reply('mnemonic', [h1, h2]) },
      { json: reply('short_viva', [h1, h2]) },
      { json: reply('study_outline', [h1, h2]) },
    ]);
    renderActions(envFor({ primary: a }), [h1, h2]);
    for (const kind of ['mnemonic', 'short_viva', 'study_outline']) {
      expect(await screen.findByTestId(`ai-action-${kind}`)).toBeTruthy();
    }

    await openAction(user, 'mnemonic');
    await sendNow(user);
    let card = await waitFor(() => {
      const found = screen
        .getAllByTestId('ai-result-card')
        .find((c) => c.getAttribute('data-kind') === 'mnemonic');
      if (!found) throw new Error('not shown yet');
      return found;
    });
    expect(within(card).getByText('Memory aid, not a fact')).toBeTruthy();
    expect(within(card).getByTestId('ai-aid')).toBeTruthy();
    // The anchor is the vault's quote, shown before the aid.
    await waitFor(() => expect(within(card).getAllByTestId('ai-citation')).toHaveLength(1));
    expect(within(card).getByTestId('ai-citation').textContent).toContain(Q1);
    expect(card.textContent).toContain('is not a statement from your sources');
    await waitFor(() =>
      expect(within(card).getByTestId('ai-accept').getAttribute('aria-disabled')).toBeNull(),
    );
    await user.click(within(card).getByTestId('ai-accept'));
    await waitFor(() => expect(within(card).getByTestId('ai-item-accepted')).toBeTruthy());
    const [note] = await getDb().notes.toArray();
    expect(note!.body).toContain('Memory aid, not a fact');
    expect(note!.body).toContain('Anchored to');
    await user.click(await screen.findByTestId('ai-close'));

    await openAction(user, 'short_viva');
    await sendNow(user);
    card = await waitFor(() => {
      const found = screen
        .getAllByTestId('ai-result-card')
        .find((c) => c.getAttribute('data-kind') === 'short_viva');
      if (!found) throw new Error('not shown yet');
      return found;
    });
    expect(within(card).getAllByTestId('ai-viva-question')).toHaveLength(2);
    expect(card.textContent).toContain('Model answer (a draft to check)');
    await user.click(await screen.findByTestId('ai-close'));

    await openAction(user, 'study_outline');
    await sendNow(user);
    card = await waitFor(() => {
      const found = screen
        .getAllByTestId('ai-result-card')
        .find((c) => c.getAttribute('data-kind') === 'study_outline');
      if (!found) throw new Error('not shown yet');
      return found;
    });
    const levels = within(card).getByTestId('ai-outline').querySelectorAll(':scope > li');
    expect(Array.from(levels).map((li) => li.getAttribute('data-level'))).toEqual(['1', '2', '1']);
  });
});

// ---------------------------------------------------------------------------------------------

function ChatHarness({ chat, env }: { chat: AiChatInput; env: AiEnv }) {
  const cfg = useAiConfig(true);
  void env;
  return cfg.data ? (
    <ConsentPreviewDialog
      kind="explain"
      highlights={[]}
      chat={chat}
      config={cfg.data}
      onClose={() => {}}
    />
  ) : null;
}

describe('a chat request in the consent dialog', () => {
  const passages = (ids: { id: string; text: string }[]): AiChatInput['passages'] =>
    ids.map((p) => ({ id: p.id, kind: 'highlight', text: p.text, label: 'highlight from Notes' }));

  async function openChat(chat: AiChatInput, steps: readonly MockStep[] = []) {
    await turnAi(true);
    await configure();
    const a = mock('a', steps);
    const env = envFor({ primary: a });
    render(
      <AiEnvProvider env={env}>
        <ChatHarness chat={chat} env={env} />
      </AiEnvProvider>,
    );
    const dialog = await screen.findByTestId('ai-consent-dialog');
    await within(dialog).findByTestId('ai-outbound');
    return { a, dialog };
  }

  it('lists the passages and earlier turns, sends only what is ticked, and nothing before Send', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    const h2 = await save(Q2);
    const history = [
      { role: 'user' as const, text: 'Oldest question about renal dosing?' },
      { role: 'assistant' as const, text: 'Oldest answer about renal dosing.' },
      { role: 'user' as const, text: 'Which drug is first-line?' },
      { role: 'assistant' as const, text: 'Metformin, per your passage.' },
    ];
    const chat: AiChatInput = {
      question: 'And what about type 1 diabetes?',
      passages: passages([
        { id: h1.id, text: h1.exactQuote },
        { id: h2.id, text: h2.exactQuote },
      ]),
      history: [
        ...history,
        { role: 'user', text: 'Third question?' },
        { role: 'assistant', text: 'Third answer.' },
      ],
    };
    const { a, dialog } = await openChat(chat, [
      {
        json: {
          answer: 'Insulin therapy is required.',
          answerState: 'answered',
          uncertainty: '',
          evidence: [{ quoteId: h2.id, text: h2.exactQuote.slice(0, 40) }],
        },
      },
    ]);
    const outbound = within(dialog).getByTestId('ai-outbound');
    const boxes = within(dialog).getAllByTestId('ai-chat-passage') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.checked)).toBe(true);
    // The two newest turns are ticked, the older one is not.
    const turns = within(dialog).getAllByTestId('ai-chat-turn') as HTMLInputElement[];
    expect(turns.map((t) => t.checked)).toEqual([false, false, true, true, true, true]);
    expect(outbound.textContent).toContain('Third answer.');
    expect(outbound.textContent).not.toContain('Oldest answer');
    expect(outbound.textContent).toContain(Q1);
    expect(outbound.textContent).toContain(Q2);
    expect(a.calls).toHaveLength(0);

    // Unticking a passage removes it from the text that would be sent; unticking a turn too.
    await user.click(boxes[0]!);
    await waitFor(() => expect(outbound.textContent).not.toContain(Q1));
    expect(outbound.textContent).toContain(Q2);
    await user.click(turns[5]!);
    await waitFor(() => expect(outbound.textContent).not.toContain('Third answer.'));
    await user.click(turns[0]!);
    await waitFor(() =>
      expect(outbound.textContent).toContain('Oldest question about renal dosing?'),
    );
    expect(a.calls).toHaveLength(0);

    const previewed = outbound.textContent;
    await user.click(within(dialog).getByTestId('ai-send'));
    await within(dialog).findByTestId('ai-result-card');
    expect(a.calls).toHaveLength(1);
    const sent = a.calls[0]!.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
    expect(sent).toBe(previewed);
    expect(sent).not.toContain(Q1);
    expect(sent).toContain('kind="history"');
  });

  it('sends nothing when every passage is unticked, and says why', async () => {
    const user = userEvent.setup();
    const h = await save(Q1);
    const { a, dialog } = await openChat({
      question: 'What is first-line?',
      passages: passages([{ id: h.id, text: h.exactQuote }]),
      history: [],
    });
    await user.click(within(dialog).getByTestId('ai-chat-passage'));
    const send = within(dialog).getByTestId('ai-send');
    await waitFor(() => expect(send.getAttribute('aria-disabled')).toBe('true'));
    expect(within(dialog).getByTestId('ai-send-reason').textContent).toMatch(
      /Tick at least one passage/,
    );
    await user.click(send);
    expect(a.calls).toHaveLength(0);
  });

  it('flags a citation that is not in the passages, and "cannot answer from your notes" is accepted as an answer', async () => {
    const user = userEvent.setup();
    const h = await save(Q1);
    const fabricated = {
      answer: 'Warfarin is first-line.',
      answerState: 'answered',
      uncertainty: '',
      evidence: [
        { quoteId: h.id, text: 'Warfarin inhibits vitamin K epoxide reductase in the liver.' },
      ],
    };
    const { dialog } = await openChat(
      {
        question: 'What is first-line for AF?',
        passages: passages([{ id: h.id, text: h.exactQuote }]),
        history: [],
      },
      [{ json: fabricated }],
    );
    await user.click(within(dialog).getByTestId('ai-send'));
    const card = await within(dialog).findByTestId('ai-result-card');
    expect(within(card).getByTestId('ai-verification').getAttribute('data-state')).toBe(
      'unsupported',
    );
    expect(within(card).getAllByTestId('ai-unsupported')).toHaveLength(1);
    // The answer is not presented as an answer: nothing in it is supported.
    expect(card.textContent).toContain('insufficient sources');
    const [stored] = await listAiResults();
    expect(stored!.kind === 'explain' && stored!.output.answerState).toBe('insufficient_sources');
  });
});
