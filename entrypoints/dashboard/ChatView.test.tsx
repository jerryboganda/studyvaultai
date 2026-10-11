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
import { defaultAiSettings, listAiResults, setAiApiKey, setAiSettings } from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { AiEnvProvider, type AiEnv } from '@ui/ai';
import { ToastProvider } from '@ui';
import { makeChromeFakes } from '@ui/testing/fakes';
import { ChatEntry } from './ChatEntry';
import { ALL_SCOPE } from './filters';
import type { SearchLike } from './results';

vi.setConfig({ testTimeout: 30_000 });
configureTestingLibrary({ asyncUtilTimeout: 8_000 });

const ORIGIN = 'https://api.example.test';
const KEY = 'sk-test-CHATCHAT0123456789SECRETKEY';
const Q1 = 'Metformin is the first-line pharmacological treatment for type 2 diabetes mellitus.';
const Q2 =
  'Insulin therapy is required in type 1 diabetes mellitus because beta cells are destroyed.';

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

const answer = (id: string, quote: string, state = 'answered', text = 'An answer.') => ({
  json: {
    answer: text,
    answerState: state,
    uncertainty: state === 'answered' ? '' : 'Your notes do not say.',
    evidence: state === 'insufficient_sources' ? [] : [{ quoteId: id, text: quote.slice(0, 40) }],
  },
});

describe('the chat view', () => {
  it('is only an explanation while AI is off: nothing to type into, nothing sent', async () => {
    await turnAi(false);
    const { env, provider } = envFor([]);
    renderChat(env, fakeIndex([]));
    expect(await screen.findByText('AI features are off')).toBeTruthy();
    expect(screen.queryByTestId('chat-question')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open the AI settings' })).toBeTruthy();
    expect(provider.calls).toHaveLength(0);
  });

  it('finds passages on this device, shows them with the exact text, and sends only after Send', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    const h2 = await save(Q2);
    await turnAi(true);
    await configure();
    const { env, provider } = envFor([answer(h1.id, Q1, 'answered', 'Metformin is first-line.')]);
    const index = fakeIndex([h1.id, h2.id]);
    renderChat(env, index, { bankId: 'inbox-default', folderId: null }, 'Inbox');

    await user.type(
      await screen.findByTestId('chat-question'),
      'Which drug is first-line for type 2 diabetes?',
    );
    const ask = screen.getByTestId('chat-ask');
    await waitFor(() => expect(ask.getAttribute('aria-disabled')).toBeNull());
    await user.click(ask);

    const dialog = await screen.findByTestId('ai-consent-dialog');
    await within(dialog).findByTestId('ai-outbound');
    // The search ran on this device, inside the chosen bank.
    expect(index.queries).toHaveLength(1);
    expect(index.queries[0]).toMatch(/^\(.+\) bank:"Inbox"$/);
    const boxes = within(dialog).getAllByTestId('ai-chat-passage') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(within(dialog).getByTestId('ai-outbound').textContent).toContain(Q1);
    expect(provider.calls).toHaveLength(0);

    // Untick the second passage: it is not part of what is sent.
    await user.click(boxes[1]!);
    await waitFor(() =>
      expect(within(dialog).getByTestId('ai-outbound').textContent).not.toContain(Q2),
    );
    const previewed = within(dialog).getByTestId('ai-outbound').textContent;
    await user.click(within(dialog).getByTestId('ai-send'));
    await within(dialog).findByTestId('ai-close');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')).toBe(
      previewed,
    );
    await user.click(within(dialog).getByTestId('ai-close'));

    // The answer is in the conversation, an unverified draft that quotes the vault.
    const turn = await screen.findByTestId('chat-turn');
    expect(turn.textContent).toContain('You asked:');
    expect(within(turn).getByTestId('ai-verification').getAttribute('data-state')).toBe(
      'unverified',
    );
    await waitFor(() => expect(within(turn).getByTestId('ai-citation').textContent).toContain(Q1));
    const [stored] = await listAiResults();
    expect(stored).toMatchObject({ kind: 'explain', inputSourceIds: [h1.id] });
  });

  it('follows up with the earlier turn offered in the preview, ticked, and only if it stays ticked', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    await turnAi(true);
    await configure();
    const { env, provider } = envFor([
      answer(h1.id, Q1, 'answered', 'Metformin is first-line.'),
      answer(h1.id, Q1, 'answered', 'It is the first choice in most adults.'),
    ]);
    renderChat(env, fakeIndex([h1.id]));

    const type = async (text: string) => {
      const box = await screen.findByTestId('chat-question');
      await user.clear(box);
      await user.type(box, text);
      const ask = screen.getByTestId('chat-ask');
      await waitFor(() => expect(ask.getAttribute('aria-disabled')).toBeNull());
      await user.click(ask);
      return screen.findByTestId('ai-consent-dialog');
    };

    let dialog = await type('Which drug is first-line for type 2 diabetes?');
    expect(within(dialog).queryByTestId('ai-chat-history')).toBeNull();
    await user.click(await within(dialog).findByTestId('ai-send'));
    await user.click(await within(dialog).findByTestId('ai-close'));
    await screen.findByTestId('chat-turn');

    dialog = await type('And in most adults, how first is it?');
    const history = await within(dialog).findByTestId('ai-chat-history');
    const turns = within(history).getAllByTestId('ai-chat-turn') as HTMLInputElement[];
    expect(turns.map((t) => t.checked)).toEqual([true, true]);
    const outbound = within(dialog).getByTestId('ai-outbound');
    await waitFor(() => expect(outbound.textContent).toContain('Metformin is first-line.'));
    expect(outbound.textContent).toContain('kind="history"');
    // Unticked, it is gone from what would be sent.
    await user.click(turns[1]!);
    await waitFor(() => expect(outbound.textContent).not.toContain('Metformin is first-line.'));
    await user.click(within(dialog).getByTestId('ai-send'));
    await within(dialog).findByTestId('ai-close');
    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1]!.messages.map((m) => m.content).join('\n');
    expect(second).not.toContain('Metformin is first-line.');
    expect(second).toContain('Which drug is first-line for type 2 diabetes?');
  });

  it('says "cannot answer from your notes" when nothing matches, and sends nothing', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    await configure();
    const { env, provider } = envFor([]);
    renderChat(env, fakeIndex([]));
    await user.type(await screen.findByTestId('chat-question'), 'zebrafish genomics pipeline');
    const ask = screen.getByTestId('chat-ask');
    await waitFor(() => expect(ask.getAttribute('aria-disabled')).toBeNull());
    await user.click(ask);
    const note = await screen.findByTestId('chat-note');
    expect(note.textContent).toContain('Cannot answer from your notes');
    expect(note.textContent).toContain('nothing was sent');
    expect(screen.queryByTestId('ai-consent-dialog')).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('shows a model that says the notes do not answer as an answer, and flags an invented quote', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    await turnAi(true);
    await configure();
    const { env } = envFor([
      answer(h1.id, Q1, 'insufficient_sources', 'Your passages do not say.'),
      {
        json: {
          answer: 'Warfarin is first-line.',
          answerState: 'answered',
          uncertainty: '',
          evidence: [{ quoteId: h1.id, text: 'Warfarin inhibits vitamin K epoxide reductase.' }],
        },
      },
    ]);
    renderChat(env, fakeIndex([h1.id]));

    const ask = async (text: string) => {
      const box = await screen.findByTestId('chat-question');
      await user.clear(box);
      await user.type(box, text);
      await waitFor(() =>
        expect(screen.getByTestId('chat-ask').getAttribute('aria-disabled')).toBeNull(),
      );
      await user.click(screen.getByTestId('chat-ask'));
      const dialog = await screen.findByTestId('ai-consent-dialog');
      await user.click(await within(dialog).findByTestId('ai-send'));
      await user.click(await within(dialog).findByTestId('ai-close'));
    };
    await ask('What is the dose of rivaroxaban?');
    await screen.findByTestId('chat-cannot-answer');

    await ask('What is first-line for atrial fibrillation?');
    const turns = await screen.findAllByTestId('chat-turn');
    expect(turns).toHaveLength(2);
    const second = turns[1]!;
    expect(within(second).getByTestId('ai-verification').getAttribute('data-state')).toBe(
      'unsupported',
    );
    expect(within(second).getAllByTestId('ai-unsupported')).toHaveLength(1);
    expect(second.textContent).not.toContain('Warfarin inhibits');
  });

  it('is not available until the index is ready, and says so', async () => {
    const user = userEvent.setup();
    await turnAi(true);
    await configure();
    const { env, provider } = envFor([]);
    renderChat(env, null);
    await user.type(await screen.findByTestId('chat-question'), 'metformin dosing');
    const ask = screen.getByTestId('chat-ask');
    await waitFor(() => expect(ask.getAttribute('aria-disabled')).toBe('true'));
    expect(screen.getByTestId('chat-reason').textContent).toMatch(/index is still being built/);
    await user.click(ask);
    expect(provider.calls).toHaveLength(0);
  });

  it('keeps the conversation in this page: Clear removes it, and nothing was saved but the drafts', async () => {
    const user = userEvent.setup();
    const h1 = await save(Q1);
    await turnAi(true);
    await configure();
    const { env } = envFor([answer(h1.id, Q1)]);
    renderChat(env, fakeIndex([h1.id]));
    await user.type(await screen.findByTestId('chat-question'), 'first-line diabetes treatment');
    await waitFor(() =>
      expect(screen.getByTestId('chat-ask').getAttribute('aria-disabled')).toBeNull(),
    );
    await user.click(screen.getByTestId('chat-ask'));
    const dialog = await screen.findByTestId('ai-consent-dialog');
    await user.click(await within(dialog).findByTestId('ai-send'));
    await user.click(await within(dialog).findByTestId('ai-close'));
    await screen.findByTestId('chat-turn');
    expect(screen.getByTestId('chat-clear').getAttribute('aria-disabled')).toBeNull();
    await user.click(screen.getByTestId('chat-clear'));
    await waitFor(() => expect(screen.queryByTestId('chat-turn')).toBeNull());
    expect(screen.getByTestId('chat-clear').getAttribute('aria-disabled')).toBe('true');
  });
});
