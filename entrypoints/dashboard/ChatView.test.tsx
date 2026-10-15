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
import { createCoordinator, createMockProvider, systemClock, type MockStep } from '@ai';
import { defaultSettings } from '@shared';
import {
  defaultAiSettings,
  listAiResults,
  listChatThreads,
  listNotes,
  newAiProfileId,
  setAiApiKey,
  setAiProfileApiKey,
  setAiSettings,
} from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { AiEnvProvider, type AiEnv } from '@ui/ai';
import { ToastProvider } from '@ui';
import { makeChromeFakes } from '@ui/testing/fakes';
import { ChatEntry } from './ChatEntry';
import { ALL_SCOPE } from './filters';
import type { SearchLike } from './results';

vi.setConfig({ testTimeout: 30_000 });
configureTestingLibrary({ asyncUtilTimeout: 15_000 });

const ORIGIN = 'https://api.example.test';
const KEY = 'sk-test-CHATCHAT0123456789SECRETKEY';
const Q1 = 'Metformin is the first-line pharmacological treatment for type 2 diabetes mellitus.';

let chrome: ReturnType<typeof makeChromeFakes>;

beforeEach(async () => {
  await freshDatabase();
  chrome = makeChromeFakes();
  Object.assign(browser, chrome);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function turnAi(on: boolean) {
  await browser.storage.local.set({
    settings: { ...defaultSettings(), features: { ...defaultSettings().features, ai: on } },
  });
}

async function configure() {
  await setAiSettings({
    ...defaultAiSettings(),
    baseUrl: `${ORIGIN}/v1`,
    model: 'chat-model',
  });
  await setAiApiKey(KEY, ORIGIN);
}

function envFor(steps: readonly MockStep[]) {
  const provider = createMockProvider(steps, {
    id: 'openai-compatible:api.example.test',
    model: 'chat-model',
  });
  const env: AiEnv = {
    fetch: vi.fn(() => Promise.reject(new Error('no network'))) as never,
    clock: {
      ...systemClock(),
      sha256: (text: string) => Promise.resolve(createHash('sha256').update(text).digest('hex')),
    },
    coordinator: createCoordinator(2),
    online: () => true,
    createProvider: () => provider,
  };
  return { env, provider };
}

/** A search index that answers every query with the given highlights, and records the queries. */
function fakeIndex(ids: string[]): SearchLike & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    search(query: string) {
      queries.push(query);
      const hits = ids.map((id) => ({ doc: { id, docType: 'highlight' as const } }));
      return { total: hits.length, hits } as never;
    },
  };
}

function renderChat(
  env: AiEnv,
  index: SearchLike | null,
  scope = ALL_SCOPE,
  bank: string | null = null,
) {
  return render(
    <ToastProvider>
      <AiEnvProvider env={env}>
        <ChatEntry
          index={index}
          scope={scope}
          names={{ bank, folder: null }}
          tags={[{ id: 'tag-00000001', name: 'drugs' }]}
        />
      </AiEnvProvider>
    </ToastProvider>,
  );
}

const reply = (
  basis: 'notes' | 'mixed' | 'general',
  evidence: { id: string; quote: string }[],
  text = 'An answer.',
) => ({
  json: {
    answer: text,
    basis,
    evidence: evidence.map((e) => ({ quoteId: e.id, text: e.quote.slice(0, 40) })),
  },
});

type User = ReturnType<typeof userEvent.setup>;

/** Types a message and presses Send once the button is enabled. */
async function say(user: User, text: string) {
  const box = await screen.findByTestId('chat-question');
  await user.clear(box);
  await user.type(box, text);
  const ask = screen.getByTestId('chat-ask');
  await waitFor(() => expect(ask.getAttribute('aria-disabled')).toBeNull());
  await user.click(ask);
}

const consentOnce = async (user: User) => {
  await user.click(await screen.findByTestId('chat-consent-accept'));
};

describe('the chat view', () => {
  it('is only an explanation while AI is off: nothing to type into, nothing sent', async () => {
    await turnAi(false);
    const { env, provider } = envFor([]);
    renderChat(env, fakeIndex([]));
    expect(await screen.findByText('AI features are off')).toBeTruthy();
    expect(screen.queryByTestId('chat-question')).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('chats with an empty vault: general knowledge, no notes sent, saved as a conversation', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    await configure();
    const { env, provider } = envFor([reply('general', [], 'Beta blockers slow the heart.')]);
    renderChat(env, fakeIndex([]));

    await say(user, 'How do beta blockers work');
    // The first message asks once what this conversation may send, and shows the exact text.
    expect(provider.calls).toHaveLength(0);
    expect((await screen.findByTestId('chat-consent-text')).textContent).toContain(
      'How do beta blockers work',
    );
    await consentOnce(user);

    const turn = await screen.findByTestId('chat-turn');
    expect(turn.textContent).toContain('Beta blockers slow the heart.');
    expect(within(turn).getByTestId('chat-used').textContent).toContain('No notes were sent');
    expect(provider.calls).toHaveLength(1);
    const [stored] = await listAiResults({ kind: 'chat' });
    expect(stored).toMatchObject({ kind: 'chat', inputSourceIds: [] });
    const [thread] = await listChatThreads();
    expect(thread).toMatchObject({ turns: 1, consentedAt: expect.any(String) });
  });

  it('finds notes on this device and cites them, and does not ask again in the same chat', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    await turnAi(true);
    await configure();
    const { env, provider } = envFor([
      reply('notes', [{ id: h1.id, quote: Q1 }], 'Metformin is first-line.'),
      reply('general', [], 'Sure, here is more.'),
    ]);
    const index = fakeIndex([h1.id]);
    renderChat(env, index);

    await say(user, 'Which drug is first-line for type 2 diabetes?');
    await consentOnce(user);
    const first = await screen.findByTestId('chat-turn');
    await waitFor(() => expect(within(first).getByTestId('ai-citation').textContent).toContain(Q1));
    expect(within(first).getByTestId('chat-used').textContent).toContain('1 of your notes');
    expect(index.queries).toHaveLength(1);

    await say(user, 'And what about side effects?');
    await waitFor(() => expect(provider.calls).toHaveLength(2));
    expect(screen.queryByTestId('chat-consent')).toBeNull();
    // Memory: the earlier turn travels with the follow-up.
    const second = provider.calls[1]!.messages.map((m) => m.content).join('\n');
    expect(second).toContain('Metformin is first-line.');
    expect(second).toContain('kind="history"');
    // The follow-up search borrows the words of the message before it.
    expect(index.queries[1]).toContain('diabetes');
  });

  it('resumes a saved conversation after the page is opened again', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    await configure();
    const { env } = envFor([reply('general', [], 'Hello there.')]);
    const first = renderChat(env, fakeIndex([]));
    await say(user, 'Say hello');
    await consentOnce(user);
    await screen.findByTestId('chat-turn');
    first.unmount();

    const { env: env2 } = envFor([]);
    renderChat(env2, fakeIndex([]));
    await user.click(await screen.findByTestId('chat-thread'));
    expect((await screen.findByTestId('chat-turn')).textContent).toContain('Hello there.');
  });

  it('flags a citation that is not in the notes', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    await turnAi(true);
    await configure();
    const { env } = envFor([
      {
        json: {
          answer: 'Warfarin is first-line.',
          basis: 'notes',
          evidence: [{ quoteId: h1.id, text: 'Warfarin inhibits vitamin K epoxide reductase.' }],
        },
      },
    ]);
    renderChat(env, fakeIndex([h1.id]));
    await say(user, 'What is first-line for atrial fibrillation?');
    await consentOnce(user);
    const turn = await screen.findByTestId('chat-turn');
    expect(within(turn).getByTestId('ai-verification').getAttribute('data-state')).toBe(
      'unsupported',
    );
  });

  it('can be switched to general chat only: no search runs', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    await configure();
    const { env } = envFor([reply('general', [], 'Fine.')]);
    const index = fakeIndex(['x']);
    renderChat(env, index);
    await user.click(await screen.findByTestId('chat-use-notes'));
    await say(user, 'Tell me about photosynthesis');
    await consentOnce(user);
    await screen.findByTestId('chat-turn');
    expect(index.queries).toHaveLength(0);
  });

  it('deletes a conversation with its messages', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    await configure();
    const { env } = envFor([reply('general', [], 'Hi.')]);
    renderChat(env, fakeIndex([]));
    await say(user, 'Hello');
    await consentOnce(user);
    await screen.findByTestId('chat-turn');
    await user.click(screen.getByTestId('chat-thread-delete'));
    await user.click(screen.getByTestId('chat-thread-delete-yes'));
    await waitFor(() => expect(screen.queryByTestId('chat-thread')).toBeNull());
    expect(await listAiResults({ kind: 'chat' })).toHaveLength(0);
    expect(await listChatThreads()).toHaveLength(0);
  });

  it('uses the provider chosen for the conversation, and asks once more when the recipient changes', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    const backupId = newAiProfileId();
    await setAiSettings({
      ...defaultAiSettings(),
      baseUrl: `${ORIGIN}/v1`,
      model: 'chat-model',
      fallbacks: [
        {
          id: backupId,
          label: 'Backup',
          provider: 'openai_compatible',
          baseUrl: 'https://backup.example.test/v1',
          model: 'backup-model',
          jsonMode: true,
          maxTokensParam: 'max_tokens',
          vendor: 'custom',
          reasoningEffort: '',
          authScheme: 'bearer',
          pricing: null,
          fallback: true,
        },
      ],
    });
    await setAiApiKey(KEY, ORIGIN);
    await setAiProfileApiKey(backupId, KEY, 'https://backup.example.test');
    const main = createMockProvider([reply('general', [], 'From main.')], {
      id: 'openai-compatible:api.example.test',
      model: 'chat-model',
    });
    const backup = createMockProvider([reply('general', [], 'From backup.')], {
      id: 'openai-compatible:backup.example.test',
      model: 'backup-model',
    });
    const env: AiEnv = {
      fetch: vi.fn(() => Promise.reject(new Error('no network'))) as never,
      clock: {
        ...systemClock(),
        sha256: (t: string) => Promise.resolve(createHash('sha256').update(t).digest('hex')),
      },
      coordinator: createCoordinator(2),
      online: () => true,
      createProvider: ({ profileId }) => (profileId === 'primary' ? main : backup),
    };
    renderChat(env, fakeIndex([]));

    await say(user, 'Hello main');
    await consentOnce(user);
    await screen.findByTestId('chat-turn');
    expect(main.calls).toHaveLength(1);

    // Same conversation, another provider: it must ask again, and the message goes to the backup.
    const profile = screen.getByTestId('chat-profile');
    await waitFor(() => expect((profile as HTMLSelectElement).disabled).toBe(false));
    await user.selectOptions(profile, backupId);
    await say(user, 'Hello backup');
    await consentOnce(user);
    await waitFor(() => expect(screen.getAllByTestId('chat-turn')).toHaveLength(2));
    expect(backup.calls).toHaveLength(1);
    expect(main.calls).toHaveLength(1);
  });

  it('shows the memory, lets it be cleared, and saves the chat as a note', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    await configure();
    const { env } = envFor([reply('general', [], 'Hi.')]);
    renderChat(env, fakeIndex([]));
    await say(user, 'Hello');
    await consentOnce(user);
    await screen.findByTestId('chat-turn');

    await user.click(screen.getByTestId('chat-export-note'));
    expect((await screen.findByTestId('chat-note')).textContent).toContain('Saved as a note');
    const notes = await listNotes();
    expect(notes.some((n) => n.title.startsWith('AI chat:') && n.body.includes('Hi.'))).toBe(true);

    expect(screen.getByTestId('chat-memory').textContent).toContain('nothing summarised yet');
  });
});
