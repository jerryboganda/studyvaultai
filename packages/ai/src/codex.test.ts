// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AiError } from './errors';
import {
  buildCodexAuthorizeUrl,
  codexAccountId,
  codexCallbackParams,
  exchangeCodexCode,
  fetchCodexUsage,
  newCodexPkce,
  refreshCodexTokens,
} from './codexAuth';
import {
  basicAuthHeader,
  createCodexResponsesProvider,
  createOpenAICompatibleProvider,
  parseCodexStream,
} from './providers';
import type { FetchLike } from './providers';

const calls: { url: string; init: RequestInit }[] = [];
const fakeFetch =
  (respond: (url: string, init: RequestInit) => Response): FetchLike =>
  async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const req = {
  messages: [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' },
  ],
  maxOutputTokens: 50,
};
const ok = () => json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });

const jwt = (claims: unknown) =>
  `x.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.y`;

describe('OpenAI-compatible vendor options', () => {
  it('sends HTTP Basic auth for UBAG and no effort field', async () => {
    calls.length = 0;
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://ubag.example.test/v1/openai',
      apiKey: 'op:p@ss',
      authScheme: 'basic',
      reasoningStyle: 'none',
      reasoningEffort: 'high',
      waitMs: 240000,
      model: 'chatgpt_web|Medium',
      fetch: fakeFetch(ok),
    });
    await p.complete(req, {});
    const c = calls[0]!;
    expect(c.url).toBe('https://ubag.example.test/v1/openai/chat/completions');
    expect((c.init.headers as Record<string, string>).authorization).toBe(
      basicAuthHeader('op:p@ss'),
    );
    expect(basicAuthHeader('op:p@ss')).toBe(`Basic ${btoa('op:p@ss')}`);
    const body = JSON.parse(c.init.body as string);
    expect(body.model).toBe('chatgpt_web|Medium');
    expect(body.ubag_wait_ms).toBe(240000);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('maps the effort per vendor', async () => {
    const run = async (style: 'reasoning_effort' | 'openrouter') => {
      calls.length = 0;
      const p = createOpenAICompatibleProvider({
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'key-123456789',
        reasoningEffort: 'low',
        reasoningStyle: style,
        model: 'm',
        fetch: fakeFetch(ok),
      });
      await p.complete(req, {});
      return JSON.parse(calls[0]!.init.body as string);
    };
    expect(await run('reasoning_effort')).toMatchObject({ reasoning_effort: 'low' });
    expect(await run('openrouter')).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('sends nothing when the effort is the model default', async () => {
    calls.length = 0;
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'key-123456789',
      reasoningEffort: '',
      model: 'm',
      fetch: fakeFetch(ok),
    });
    await p.complete(req, {});
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
  });
});

describe('Codex Responses provider', () => {
  const sse = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hel"}',
    '',
    'data: {"type":"response.output_text.delta","delta":"lo"}',
    '',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":2}}}',
    '',
  ].join('\n');

  it('assembles streamed text and usage', () => {
    expect(parseCodexStream(sse)).toEqual({
      text: 'Hello',
      usage: { inputTokens: 9, outputTokens: 2 },
      incomplete: false,
      failed: false,
    });
  });

  it('posts the OAuth bearer, account id and effort', async () => {
    calls.length = 0;
    const p = createCodexResponsesProvider({
      accessToken: 'access-token-123',
      accountId: 'acct_1',
      model: 'gpt-5-codex',
      reasoningEffort: 'medium',
      fetch: fakeFetch(() => new Response(sse, { status: 200 })),
    });
    const out = await p.complete(req, {});
    expect(out.text).toBe('Hello');
    const c = calls[0]!;
    expect(c.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const h = c.init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer access-token-123');
    expect(h['chatgpt-account-id']).toBe('acct_1');
    const body = JSON.parse(c.init.body as string);
    expect(body).toMatchObject({
      model: 'gpt-5-codex',
      instructions: 'sys',
      stream: true,
      store: false,
      reasoning: { effort: 'medium' },
    });
    expect(body.input[0].content[0]).toEqual({ type: 'input_text', text: 'hi' });
    expect(JSON.stringify(p)).not.toContain('access-token-123');
  });

  it('reports a rejected login as an auth error', async () => {
    const p = createCodexResponsesProvider({
      accessToken: 'access-token-123',
      accountId: 'acct_1',
      model: 'm',
      fetch: fakeFetch(() => json({ error: { code: 'token_expired' } }, 401)),
    });
    await expect(p.complete(req, {})).rejects.toMatchObject({ code: 'auth' });
  });

  it('needs a login', async () => {
    const p = createCodexResponsesProvider({
      accessToken: '',
      accountId: '',
      model: 'm',
      fetch: fakeFetch(() => json({})),
    });
    const err = await p.complete(req, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('missing_key');
  });
});

describe('Codex login', () => {
  it('builds a PKCE authorize URL for the localhost callback', async () => {
    const p = await newCodexPkce();
    const u = new URL(buildCodexAuthorizeUrl(p.challenge, p.state));
    expect(u.origin).toBe('https://auth.openai.com');
    expect(u.searchParams.get('code_challenge')).toBe(p.challenge);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(u.searchParams.get('state')).toBe(p.state);
  });

  it('reads only its own callback', () => {
    expect(codexCallbackParams('http://localhost:1455/auth/callback?code=c&state=s')).toEqual({
      code: 'c',
      state: 's',
    });
    expect(codexCallbackParams('http://localhost:1455/auth/callback?error=access_denied')).toEqual({
      error: 'access_denied',
    });
    expect(codexCallbackParams('https://evil.test/auth/callback?code=c&state=s')).toBeNull();
    expect(codexCallbackParams('not a url')).toBeNull();
  });

  it('exchanges and refreshes tokens, keeping the refresh token when none is returned', async () => {
    const id = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_9' } });
    expect(codexAccountId(id)).toBe('acct_9');
    calls.length = 0;
    const tokens = await exchangeCodexCode(
      fakeFetch(() =>
        json({ access_token: 'a1', refresh_token: 'r1', id_token: id, expires_in: 100 }),
      ),
      'code',
      'verifier',
      1_000,
    );
    expect(tokens).toEqual({
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: 101_000,
      accountId: 'acct_9',
    });
    expect(String(calls[0]!.init.body)).toContain('code_verifier=verifier');
    const next = await refreshCodexTokens(
      fakeFetch(() => json({ access_token: 'a2', expires_in: 50 })),
      tokens,
      2_000,
    );
    expect(next).toMatchObject({ accessToken: 'a2', refreshToken: 'r1', accountId: 'acct_9' });
  });

  it('fails closed when the login has no account id', async () => {
    await expect(
      exchangeCodexCode(
        fakeFetch(() => json({ access_token: 'a1', refresh_token: 'r1' })),
        'c',
        'v',
        0,
      ),
    ).rejects.toMatchObject({ code: 'auth' });
  });

  it('reads the quota windows', async () => {
    const usage = await fetchCodexUsage(
      fakeFetch(() =>
        json({
          plan_type: 'plus',
          rate_limit: {
            primary_window: {
              used_percent: 42.5,
              limit_window_seconds: 18000,
              reset_after_seconds: 600,
            },
            secondary_window: { used_percent: 10, limit_window_seconds: 604800 },
          },
        }),
      ),
      { accessToken: 'a', accountId: 'b' },
    );
    expect(usage).toEqual({
      plan: 'plus',
      windows: [
        { usedPercent: 42.5, windowMinutes: 300, resetsInSeconds: 600 },
        { usedPercent: 10, windowMinutes: 10080, resetsInSeconds: null },
      ],
    });
  });
});
