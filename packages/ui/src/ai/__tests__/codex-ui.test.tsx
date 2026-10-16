import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { createCoordinator, systemClock } from '@ai';
import {
  clearCodexAuth,
  defaultAiSettings,
  getCodexAuth,
  setAiSettings,
  setCodexAuth,
} from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { AiEnvProvider, type AiEnv } from '..';
import { loadAiConfig, sendBlocker } from '../runtime';
import { CodexSignIn } from '../VendorExtras';

const jwt = (claims: unknown) =>
  `x.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.y`;
const ID_TOKEN = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_ui' } });

type Listener = (tabId: number, info: { url?: string }, tab: { url?: string }) => void;
let created: string[] = [];
let listeners: Listener[] = [];
let removed: number[] = [];

function fakeTabs() {
  created = [];
  listeners = [];
  removed = [];
  Object.assign(browser, {
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => {
        created.push(url);
        return { id: 7 };
      }),
      remove: vi.fn(async (id: number) => {
        removed.push(id);
      }),
      onUpdated: {
        addListener: (l: Listener) => listeners.push(l),
        removeListener: (l: Listener) => {
          listeners = listeners.filter((x) => x !== l);
        },
      },
      onRemoved: { addListener: () => undefined, removeListener: () => undefined },
    },
    permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) },
  });
}

const tokenReply = () =>
  new Response(
    JSON.stringify({
      access_token: 'access-ui-1',
      refresh_token: 'refresh-ui-1',
      id_token: ID_TOKEN,
      expires_in: 3600,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function envWith(fetchImpl: AiEnv['fetch']): AiEnv {
  return {
    fetch: fetchImpl,
    clock: systemClock(),
    coordinator: createCoordinator(1),
    online: () => true,
  };
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

beforeEach(async () => {
  await freshDatabase();
  fakeTabs();
});
afterEach(() => cleanup());

describe('ChatGPT sign-in', () => {
  it('opens the sign-in tab, takes the code from the redirected tab and stores the login', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const env = envWith(async (url) => {
      calls.push(String(url));
      return tokenReply();
    });
    const changed = vi.fn();
    render(
      <AiEnvProvider env={env}>
        <CodexSignIn signedIn={false} onChanged={changed} />
      </AiEnvProvider>,
    );
    expect(screen.getByTestId('ai-codex-status').textContent).toContain('Not signed in');
    await user.click(screen.getByTestId('ai-codex-signin'));
    await waitFor(() => expect(created).toHaveLength(1));
    const authorize = new URL(created[0]!);
    expect(authorize.origin).toBe('https://auth.openai.com');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    await waitFor(() => expect(listeners).toHaveLength(1));

    // The tab ends up on the localhost callback: the extension reads the code and closes the tab.
    listeners[0]!(
      7,
      { url: `http://localhost:1455/auth/callback?code=the-code&state=${stateOf(created[0]!)}` },
      {},
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls).toEqual(['https://auth.openai.com/oauth/token']);
    expect(removed).toEqual([7]);
    expect(await getCodexAuth()).toMatchObject({
      accessToken: 'access-ui-1',
      refreshToken: 'refresh-ui-1',
      accountId: 'acct_ui',
    });
  });

  it('accepts the pasted address when the tab cannot be read, and refuses one from another attempt', async () => {
    const user = userEvent.setup();
    const env = envWith(async () => tokenReply());
    const changed = vi.fn();
    render(
      <AiEnvProvider env={env}>
        <CodexSignIn signedIn={false} onChanged={changed} />
      </AiEnvProvider>,
    );
    await user.click(screen.getByTestId('ai-codex-signin'));
    await waitFor(() => expect(created).toHaveLength(1));
    const paste = await screen.findByTestId('ai-codex-paste');

    await user.type(paste, 'http://localhost:1455/auth/callback?code=c&state=someone-elses');
    await user.click(screen.getByTestId('ai-codex-finish'));
    expect(await screen.findByText(/does not belong to this attempt/)).toBeTruthy();
    expect(await getCodexAuth()).toBeNull();

    await user.clear(paste);
    await user.type(
      paste,
      `http://localhost:1455/auth/callback?code=c&state=${stateOf(created[0]!)}`,
    );
    await user.click(screen.getByTestId('ai-codex-finish'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect((await getCodexAuth())?.accountId).toBe('acct_ui');
  });

  it('shows a refused sign-in as it is and signs out by removing the tokens', async () => {
    const user = userEvent.setup();
    await setCodexAuth({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acct_ui',
    });
    const changed = vi.fn();
    render(
      <AiEnvProvider env={envWith(async () => tokenReply())}>
        <CodexSignIn signedIn onChanged={changed} />
      </AiEnvProvider>,
    );
    await user.click(screen.getByTestId('ai-codex-signout'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(await getCodexAuth()).toBeNull();
  });
});

describe('ChatGPT login in the request path', () => {
  const settings = {
    ...defaultAiSettings(),
    provider: 'codex_responses' as const,
    vendor: 'chatgpt_codex' as const,
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'gpt-5-codex',
  };

  it('uses a valid login, refreshes one that is about to expire, and says to sign in when it cannot', async () => {
    await setAiSettings(settings);
    await setCodexAuth({
      accessToken: 'valid-token-1',
      refreshToken: 'r1',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acct_ui',
    });
    const fetchSpy = vi.fn(async () => tokenReply());
    let cfg = await loadAiConfig(true, envWith(fetchSpy));
    expect(cfg.key.state).toBe('present');
    expect(cfg.provider).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    // About to expire: refreshed before use, and the new token is stored.
    await setCodexAuth({
      accessToken: 'old-token-12',
      refreshToken: 'r1',
      expiresAt: Date.now() + 10_000,
      accountId: 'acct_ui',
    });
    cfg = await loadAiConfig(true, envWith(fetchSpy));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await getCodexAuth())?.accessToken).toBe('access-ui-1');
    expect(cfg.key.state).toBe('present');

    // Expired and the refresh is refused: signed out, with a message that says what to do.
    await setCodexAuth({
      accessToken: 'dead-token-12',
      refreshToken: 'r1',
      expiresAt: Date.now() - 1_000,
      accountId: 'acct_ui',
    });
    const refused = vi.fn(async () => new Response('{}', { status: 400 }));
    cfg = await loadAiConfig(true, envWith(refused));
    expect(cfg.key.state).toBe('missing');
    expect(sendBlocker(cfg, envWith(refused))).toMatch(/Sign in with ChatGPT/);

    await clearCodexAuth();
    cfg = await loadAiConfig(true, envWith(refused));
    expect(cfg.key.state).toBe('missing');
  });
});
