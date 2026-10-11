// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AiError } from './errors';
import {
  assertSafeEndpoint,
  createAnthropicProvider,
  createMockProvider,
  createOpenAICompatibleProvider,
  parseRetryAfter,
} from './providers';
import type { AiCompletionRequest, FetchLike } from './providers';

const KEY = 'sk-test-AbCdEf0123456789XyZ';
const req: AiCompletionRequest = {
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
  ],
  maxOutputTokens: 321,
};

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  };
  return { fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const openaiOk = (content = '{"a":1}') =>
  json({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });

async function failure(p: Promise<unknown>): Promise<AiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AiError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('endpoint safety', () => {
  it('accepts https and loopback http only', () => {
    for (const ok of [
      'https://api.openai.com/v1',
      'https://my-gateway.example.org/openai',
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:8080/v1',
      'http://ollama.localhost/v1',
    ]) {
      expect(() => assertSafeEndpoint(ok)).not.toThrow();
    }
    for (const bad of [
      'http://api.openai.com/v1',
      'http://192.168.1.10:8080',
      'http://localhost.evil.test/v1',
      'ftp://localhost/v1',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@api.example.com/v1',
      'https://api.example.com/v1?key=abc',
      'not a url',
    ]) {
      expect(() => assertSafeEndpoint(bad), bad).toThrow(AiError);
    }
  });

  it('providers refuse an unsafe endpoint at construction', () => {
    const { fn } = fakeFetch(() => openaiOk());
    expect(() =>
      createOpenAICompatibleProvider({
        baseUrl: 'http://example.com/v1',
        apiKey: KEY,
        model: 'm',
        fetch: fn,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_endpoint' }));
    expect(() =>
      createAnthropicProvider({
        baseUrl: 'http://example.com',
        apiKey: KEY,
        model: 'm',
        fetch: fn,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_endpoint' }));
  });
});

describe('OpenAI-compatible provider', () => {
  it('sends a chat-completions request with the key only in the Authorization header', async () => {
    const { fn, calls } = fakeFetch(() => openaiOk());
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: KEY,
      model: 'some-model',
      fetch: fn,
    });
    const out = await p.complete(req, {});
    expect(out).toEqual({ text: '{"a":1}', usage: { inputTokens: 11, outputTokens: 7 } });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.example.com/v1/chat/completions');
    const headers = c.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(c.init.body as string);
    expect(body).toMatchObject({
      model: 'some-model',
      max_tokens: 321,
      stream: false,
      response_format: { type: 'json_object' },
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(c.init.redirect).toBe('error');
    expect(c.init.credentials).toBe('omit');
    expect(p.id).toBe('openai-compatible:api.example.com');
    expect(JSON.stringify(p)).not.toContain(KEY);
  });

  it('honours jsonMode:false and max_completion_tokens', async () => {
    const { fn, calls } = fakeFetch(() => openaiOk());
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: KEY,
      model: 'm',
      fetch: fn,
      jsonMode: false,
      maxTokensParam: 'max_completion_tokens',
    });
    await p.complete(req, {});
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.response_format).toBeUndefined();
    expect(body.max_completion_tokens).toBe(321);
    expect(body.max_tokens).toBeUndefined();
  });

  it('loopback servers need no key; remote servers without a key fail before any request', async () => {
    const local = fakeFetch(() => openaiOk());
    const lp = createOpenAICompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama',
      fetch: local.fn,
    });
    await lp.complete(req, {});
    expect((local.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();

    const remote = fakeFetch(() => openaiOk());
    const rp = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: '   ',
      model: 'm',
      fetch: remote.fn,
    });
    expect((await failure(rp.complete(req, {}))).code).toBe('missing_key');
    expect(remote.calls).toHaveLength(0);
  });

  const cases: [string, Response, string][] = [
    ['401', json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401), 'auth'],
    ['403', json({}, 403), 'auth'],
    ['402', json({}, 402), 'quota_exhausted'],
    [
      '429 insufficient_quota is NOT a retryable rate limit',
      json({ error: { type: 'insufficient_quota', code: 'insufficient_quota' } }, 429),
      'quota_exhausted',
    ],
    ['429 rate limit', json({ error: { code: 'rate_limit_exceeded' } }, 429), 'rate_limited'],
    ['500', json({}, 500), 'server_error'],
    ['503', json({}, 503), 'server_error'],
    ['400', json({ error: { message: 'bad' } }, 400), 'bad_request'],
    ['404', json({}, 404), 'bad_request'],
    ['408', json({}, 408), 'timeout'],
  ];
  it.each(cases)('maps HTTP %s', async (_name, response, code) => {
    const { fn } = fakeFetch(() => response);
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://a.example.com/v1',
      apiKey: KEY,
      model: 'm',
      fetch: fn,
    });
    const err = await failure(p.complete(req, {}));
    expect(err.code).toBe(code);
    // Provider free text (which may echo the key) is never copied into the error.
    expect(JSON.stringify({ m: err.message, d: err.detail, i: err.issues })).not.toContain(
      'Incorrect API key',
    );
    expect(err.message).not.toContain(KEY);
  });

  it('parses Retry-After in seconds, milliseconds and HTTP-date', async () => {
    const mk = (headers: Record<string, string>) =>
      createOpenAICompatibleProvider({
        baseUrl: 'https://a.example.com/v1',
        apiKey: KEY,
        model: 'm',
        now: () => Date.parse('2026-10-11T10:00:00Z'),
        fetch: fakeFetch(() => json({}, 429, headers)).fn,
      });
    expect((await failure(mk({ 'retry-after': '7' }).complete(req, {}))).retryAfterMs).toBe(7000);
    expect((await failure(mk({ 'retry-after-ms': '250' }).complete(req, {}))).retryAfterMs).toBe(
      250,
    );
    expect(
      (await failure(mk({ 'retry-after': 'Sun, 11 Oct 2026 10:00:30 GMT' }).complete(req, {})))
        .retryAfterMs,
    ).toBe(30_000);
    expect((await failure(mk({}).complete(req, {}))).retryAfterMs).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after': 'garbage' }), 0)).toBeUndefined();
  });

  it('network failures, truncation, refusals and empty answers are typed', async () => {
    const mk = (r: () => Response | Promise<Response>) =>
      createOpenAICompatibleProvider({
        baseUrl: 'https://a.example.com/v1',
        apiKey: KEY,
        model: 'm',
        fetch: fakeFetch(r).fn,
      });
    const net = await failure(
      mk(() => {
        throw new TypeError(`fetch failed for https://a.example.com/v1?key=${KEY}`);
      }).complete(req, {}),
    );
    expect(net.code).toBe('network');
    expect(net.message).not.toContain(KEY);
    expect(
      (
        await failure(
          mk(() =>
            json({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] }),
          ).complete(req, {}),
        )
      ).code,
    ).toBe('output_truncated');
    expect(
      (
        await failure(
          mk(() =>
            json({
              choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }],
            }),
          ).complete(req, {}),
        )
      ).code,
    ).toBe('refused');
    expect((await failure(mk(() => json({ choices: [] })).complete(req, {}))).code).toBe(
      'invalid_output',
    );
    expect(
      (
        await failure(
          mk(() => new Response('<html>gateway</html>', { status: 200 })).complete(req, {}),
        )
      ).code,
    ).toBe('server_error');
  });

  it('maps an aborted fetch to aborted', async () => {
    const ac = new AbortController();
    const fn: FetchLike = (_url, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')));
      });
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://a.example.com/v1',
      apiKey: KEY,
      model: 'm',
      fetch: fn,
    });
    const pending = failure(p.complete(req, { signal: ac.signal }));
    ac.abort();
    expect((await pending).code).toBe('aborted');
  });
});

describe('Anthropic provider', () => {
  const ok = () =>
    json({
      content: [
        { type: 'text', text: '{"x":' },
        { type: 'text', text: '1}' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 5 },
    });

  it('sends a messages request: system split out, key header, version header', async () => {
    const { fn, calls } = fakeFetch(ok);
    const p = createAnthropicProvider({ apiKey: KEY, model: 'caller-supplied-model', fetch: fn });
    const out = await p.complete(
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'u2' },
        ],
        maxOutputTokens: 99,
      },
      {},
    );
    expect(out).toEqual({ text: '{"x":1}', usage: { inputTokens: 20, outputTokens: 5 } });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    const h = c.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(KEY);
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(c.init.body as string);
    expect(body).toMatchObject({ model: 'caller-supplied-model', max_tokens: 99, system: 'sys' });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(p.id).toBe('anthropic:api.anthropic.com');
  });

  it('can drop the browser-access header, and requires a key', async () => {
    const { fn, calls } = fakeFetch(ok);
    await createAnthropicProvider({
      apiKey: KEY,
      model: 'm',
      fetch: fn,
      browserDirectAccess: false,
    }).complete(req, {});
    expect(
      (calls[0]!.init.headers as Record<string, string>)[
        'anthropic-dangerous-direct-browser-access'
      ],
    ).toBeUndefined();
    const none = createAnthropicProvider({ apiKey: '', model: 'm', fetch: fn });
    expect((await failure(none.complete(req, {}))).code).toBe('missing_key');
    expect(calls).toHaveLength(1);
  });

  it('maps error types, 529 overloaded, stop reasons', async () => {
    const mk = (r: Response) =>
      createAnthropicProvider({ apiKey: KEY, model: 'm', fetch: fakeFetch(() => r).fn });
    expect(
      (
        await failure(
          mk(
            json({ type: 'error', error: { type: 'authentication_error', message: KEY } }, 401),
          ).complete(req, {}),
        )
      ).code,
    ).toBe('auth');
    const rl = await failure(
      mk(
        json({ type: 'error', error: { type: 'rate_limit_error' } }, 429, { 'retry-after': '12' }),
      ).complete(req, {}),
    );
    expect([rl.code, rl.retryAfterMs, rl.retryable]).toEqual(['rate_limited', 12_000, true]);
    expect(
      (
        await failure(
          mk(json({ type: 'error', error: { type: 'overloaded_error' } }, 529)).complete(req, {}),
        )
      ).code,
    ).toBe('server_error');
    expect(
      (await failure(mk(json({ error: { type: 'billing_error' } }, 402)).complete(req, {}))).code,
    ).toBe('quota_exhausted');
    // An empty Anthropic account is a 400 whose message is the only tell; another 400 is not quota.
    const empty = await failure(
      mk(
        json(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message:
                'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
            },
          },
          400,
        ),
      ).complete(req, {}),
    );
    expect([empty.code, empty.retryable, empty.status]).toEqual(['quota_exhausted', false, 400]);
    expect(empty.message).not.toContain('credit balance');
    const other = await failure(
      mk(
        json(
          { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 0' } },
          400,
        ),
      ).complete(req, {}),
    );
    expect(other.code).toBe('bad_request');
    expect(
      (await failure(mk(json({ content: [], stop_reason: 'max_tokens' })).complete(req, {}))).code,
    ).toBe('output_truncated');
    expect(
      (await failure(mk(json({ content: [], stop_reason: 'refusal' })).complete(req, {}))).code,
    ).toBe('refused');
  });
});

describe('mock provider', () => {
  it('replays a script in order, records calls and reports exhaustion', async () => {
    const m = createMockProvider([{ text: 'one' }, { json: { two: 2 } }]);
    expect((await m.complete(req, {})).text).toBe('one');
    expect((await m.complete(req, {})).json).toEqual({ two: 2 });
    expect(m.calls).toHaveLength(2);
    expect((await failure(m.complete(req, {}))).code).toBe('internal');
  });

  it('hang settles only on abort; errors are thrown as given', async () => {
    const m = createMockProvider([{ hang: true }, { error: new AiError('quota_exhausted') }]);
    const ac = new AbortController();
    const pending = failure(m.complete(req, { signal: ac.signal }));
    ac.abort();
    expect((await pending).code).toBe('aborted');
    expect((await failure(m.complete(req, {}))).code).toBe('quota_exhausted');
  });
});
