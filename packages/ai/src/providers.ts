// Provider adapters. Nothing here runs on import. `fetch` and the clock are injected; keys live only in
// the closure of `complete()` and never appear in errors, logs or properties.
//
// Request/response shapes follow the providers' published chat-completions / messages APIs. They were
// NOT exercised against live endpoints (no keys in this repo): only against recorded-shape fakes in tests.
import { AiError } from './errors';
import type { AiErrorCode } from './errors';
import type { Message } from './prompt';

export interface AiCompletionRequest {
  messages: readonly Message[];
  maxOutputTokens: number;
  temperature?: number;
  /** Ask for a JSON object when the provider supports a JSON mode. */
  json?: boolean;
}

export interface AiCompletion {
  /** Raw model text (a JSON document for well-behaved models). */
  text?: string;
  /** Pre-parsed JSON (mock/test providers); still validated by the pipeline. */
  json?: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AiProvider {
  /** Stable, key-free identifier recorded on results (e.g. `openai-compatible:api.openai.com`). */
  readonly id: string;
  readonly model: string;
  /**
   * The exact origin requests go to (scheme, host, port), for adapters that know it. The consent
   * hash includes it, so an address changed after the preview is not what was confirmed.
   */
  readonly origin?: string;
  complete(
    req: AiCompletionRequest,
    opts: {
      signal?: AbortSignal;
      /**
       * Receives the reply text so far, each time it grows, for providers that stream. The final
       * `AiCompletion` is still what is validated and grounded; this is only for showing progress.
       */
      onDelta?: (textSoFar: string) => void;
    },
  ): Promise<AiCompletion>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_RESPONSE_CHARS = 2_000_000;

// ---------------------------------------------------------------------------------------------
// Endpoint safety
// ---------------------------------------------------------------------------------------------

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

/** https only, except loopback hosts; no embedded credentials, query or fragment. */
export function assertSafeEndpoint(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AiError('invalid_endpoint');
  }
  if (u.username || u.password || u.search || u.hash) throw new AiError('invalid_endpoint');
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return u;
  throw new AiError('invalid_endpoint');
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing shared by the adapters
// ---------------------------------------------------------------------------------------------

/** Seconds, milliseconds (`retry-after-ms`) or HTTP-date -> wait in ms. */
export function parseRetryAfter(headers: Headers, nowMs: number): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

function providerCode(body: unknown): string {
  const err = (body as { error?: { code?: unknown; type?: unknown }; type?: unknown } | null)
    ?.error;
  const parts = [err?.code, err?.type].filter((x): x is string => typeof x === 'string');
  return parts.join(' ').toLowerCase();
}

/** The provider's message text, for classification only: it is never shown or stored. */
function providerMessage(body: unknown): string {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === 'string' ? m : '';
}

export function classifyHttp(status: number, body: unknown): AiErrorCode {
  const code = providerCode(body);
  // OpenAI answers an empty account with 429 + insufficient_quota: that is NOT a retryable rate limit.
  // Anthropic answers one with 400 invalid_request_error whose only tell is the message text.
  if (
    status === 402 ||
    /insufficient_quota|billing|credit|exceeded_current_quota|quota_exceeded/.test(code) ||
    (status === 400 && /credit balance is too low/i.test(providerMessage(body)))
  ) {
    return 'quota_exhausted';
  }
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error'; // includes Anthropic 529 overloaded_error
  return 'bad_request';
}

function httpError(res: Response, body: unknown, nowMs: number): AiError {
  const code = classifyHttp(res.status, body);
  const pc = providerCode(body)
    .split(' ')
    .find((p) => /^[a-z0-9_.-]{1,48}$/.test(p));
  const retryAfterMs =
    code === 'rate_limited' || code === 'server_error'
      ? parseRetryAfter(res.headers, nowMs)
      : undefined;
  return new AiError(code, {
    status: res.status,
    detail: `HTTP ${res.status}${pc ? ` ${pc}` : ''}`,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

async function postJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  nowMs: () => number,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ?? null,
      // A redirect would forward the key to another host.
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    if (signal?.aborted) throw new AiError('aborted');
    throw new AiError('network'); // never include the underlying message: it can echo the URL
  }
  let text: string;
  try {
    if (Number(res.headers.get('content-length')) > MAX_RESPONSE_CHARS) {
      throw new AiError('server_error', { status: res.status, detail: 'response too large' });
    }
    text = await res.text();
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError(signal?.aborted ? 'aborted' : 'network');
  }
  let parsed: unknown = null;
  if (text.length <= MAX_RESPONSE_CHARS) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) throw httpError(res, parsed, nowMs());
  if (parsed === null)
    throw new AiError('server_error', { status: res.status, detail: 'unreadable response' });
  return parsed;
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;

/**
 * Reads a server-sent-event body line by line, handing every `data:` payload to `onData`. Stops at
 * the size cap (a stream that never ends must not fill memory) and when `signal` aborts.
 */
async function readEventStream(
  res: Response,
  onData: (payload: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!res.body) {
    for (const line of (await res.text()).split('\n')) {
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new AiError('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_RESPONSE_CHARS * 2) {
        throw new AiError('server_error', { status: res.status, detail: 'response too large' });
      }
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) onData(line.slice(5).trim());
        nl = buffer.indexOf('\n');
      }
    }
    if (buffer.startsWith('data:')) onData(buffer.slice(5).trim());
  } finally {
    reader.releaseLock();
  }
}

/** POST that returns the live response (no body read), for streamed replies. */
async function postStream(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  nowMs: () => number,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ?? null,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    if (signal?.aborted) throw new AiError('aborted');
    throw new AiError('network');
  }
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      /* not JSON */
    }
    throw httpError(res, parsed, nowMs());
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible chat completions
// ---------------------------------------------------------------------------------------------

export interface OpenAICompatibleConfig {
  /** e.g. `https://api.openai.com/v1`. https required unless loopback. */
  baseUrl: string;
  /** Optional only for loopback servers (Ollama, LM Studio, llama.cpp). */
  apiKey?: string;
  model: string;
  fetch: FetchLike;
  /** Send `response_format: {type: "json_object"}` (default true). Turn off for servers that reject it. */
  jsonMode?: boolean;
  /** Some servers/models want `max_completion_tokens`. Default `max_tokens` (widest compatibility). */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** `basic`: `apiKey` is `user:password` (UBAG's public gateway). Default `bearer`. */
  authScheme?: 'bearer' | 'basic';
  /** Reasoning/thinking effort; '' or absent sends nothing. */
  reasoningEffort?: string;
  /**
   * How the effort is sent: `reasoning_effort` (OpenAI, NVIDIA NIM, OpenCode Go), `openrouter`
   * (`reasoning: {effort}`), or `none` (UBAG folds the level into the model id).
   */
  reasoningStyle?: 'reasoning_effort' | 'openrouter' | 'none';
  /** Per-attempt facade deadline hint, ms (UBAG `ubag_wait_ms`). */
  waitMs?: number;
  /**
   * Stream the reply when the caller wants progress (`onDelta`). Default true; off for gateways that
   * cannot stream (UBAG drives a browser and answers once).
   */
  streaming?: boolean;
  now?: () => number;
}

/** `Basic base64(user:password)`; UTF-8 safe. */
export function basicAuthHeader(credentials: string): string {
  const bytes = new TextEncoder().encode(credentials);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/** The reply shape of a chat-completions call (streamed replies are folded into this shape). */
interface OpenAIReply {
  choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function openaiResult(raw: unknown): AiCompletion {
  const data = (raw ?? {}) as OpenAIReply;
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new AiError('output_truncated');
  if (choice?.finish_reason === 'content_filter' || typeof choice?.message?.refusal === 'string') {
    throw new AiError('refused');
  }
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new AiError('invalid_output', { detail: 'response had no text' });
  }
  return {
    text: content,
    usage: {
      inputTokens: num(data.usage?.prompt_tokens),
      outputTokens: num(data.usage?.completion_tokens),
    },
  };
}

export function createOpenAICompatibleProvider(cfg: OpenAICompatibleConfig): AiProvider {
  const base = assertSafeEndpoint(cfg.baseUrl);
  const url = `${base.origin}${base.pathname.replace(/\/+$/, '')}/chat/completions`;
  const key = cfg.apiKey?.trim() ?? '';
  const keyless = isLoopbackHost(base.hostname);
  const effort = cfg.reasoningEffort?.trim() ?? '';
  const style = cfg.reasoningStyle ?? 'reasoning_effort';
  const now = cfg.now ?? (() => Date.now());
  return {
    id: `openai-compatible:${base.host}`,
    model: cfg.model,
    origin: base.origin,
    async complete(req, { signal, onDelta }) {
      if (!key && !keyless) throw new AiError('missing_key');
      const wantStream = !!onDelta && cfg.streaming !== false;
      const body = {
        model: cfg.model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        [cfg.maxTokensParam ?? 'max_tokens']: req.maxOutputTokens,
        temperature: req.temperature ?? 0.2,
        stream: wantStream,
        ...(wantStream ? { stream_options: { include_usage: true } } : {}),
        ...(req.json !== false && cfg.jsonMode !== false
          ? { response_format: { type: 'json_object' } }
          : {}),
        ...(effort && style === 'reasoning_effort' ? { reasoning_effort: effort } : {}),
        ...(effort && style === 'openrouter' ? { reasoning: { effort } } : {}),
        ...(cfg.waitMs ? { ubag_wait_ms: cfg.waitMs } : {}),
      };
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (key) {
        headers.authorization = cfg.authScheme === 'basic' ? basicAuthHeader(key) : `Bearer ${key}`;
      }
      if (wantStream) {
        let res: Response;
        try {
          res = await postStream(cfg.fetch, url, headers, body, signal, now);
        } catch (e) {
          // A server that rejects `stream` is asked again without it.
          if (!(e instanceof AiError) || e.code !== 'bad_request') throw e;
          return this.complete(req, { ...(signal ? { signal } : {}) });
        }
        if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
          // Answered with a plain JSON body anyway.
          const text = await res.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new AiError('server_error', {
              status: res.status,
              detail: 'unreadable response',
            });
          }
          return openaiResult(parsed);
        }
        let text = '';
        let finish: unknown = null;
        let refusal = false;
        let usage: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
        await readEventStream(
          res,
          (payload) => {
            if (!payload || payload === '[DONE]') return;
            let ev: {
              choices?: {
                delta?: { content?: unknown; refusal?: unknown };
                finish_reason?: unknown;
              }[];
              usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
            };
            try {
              ev = JSON.parse(payload);
            } catch {
              return;
            }
            const choice = ev.choices?.[0];
            if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
              text += choice.delta.content;
              onDelta?.(text);
            }
            if (typeof choice?.delta?.refusal === 'string') refusal = true;
            if (choice?.finish_reason) finish = choice.finish_reason;
            if (ev.usage) usage = ev.usage;
          },
          signal,
        );
        return openaiResult({
          choices: [
            {
              message: { content: text, ...(refusal ? { refusal: 'refused' } : {}) },
              finish_reason: finish ?? 'stop',
            },
          ],
          ...(usage ? { usage } : {}),
        });
      }
      const data = (await postJson(cfg.fetch, url, headers, body, signal, now)) as OpenAIReply;
      return openaiResult(data);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------------------------

export interface AnthropicConfig {
  apiKey: string;
  /** Caller-supplied model id; nothing is hard-coded here. */
  model: string;
  fetch: FetchLike;
  baseUrl?: string;
  /** `anthropic-version` header. */
  version?: string;
  /**
   * Adds `anthropic-dangerous-direct-browser-access: true`, which Anthropic requires for calls that are
   * subject to CORS (extension pages without host permission). Default true: this package only runs
   * inside the user's own extension with the user's own key.
   */
  browserDirectAccess?: boolean;
  now?: () => number;
}

export function createAnthropicProvider(cfg: AnthropicConfig): AiProvider {
  const base = assertSafeEndpoint(cfg.baseUrl ?? 'https://api.anthropic.com');
  const url = `${base.origin}${base.pathname.replace(/\/+$/, '')}/v1/messages`;
  const key = cfg.apiKey?.trim() ?? '';
  const now = cfg.now ?? (() => Date.now());
  return {
    id: `anthropic:${base.host}`,
    model: cfg.model,
    origin: base.origin,
    async complete(req, { signal }) {
      if (!key) throw new AiError('missing_key');
      const system = req.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const body = {
        model: cfg.model,
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature ?? 0.2,
        ...(system ? { system } : {}),
        messages: req.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content })),
      };
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': cfg.version ?? '2023-06-01',
      };
      if (cfg.browserDirectAccess !== false) {
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
      }
      const data = (await postJson(cfg.fetch, url, headers, body, signal, now)) as {
        content?: { type?: unknown; text?: unknown }[];
        stop_reason?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      if (data.stop_reason === 'max_tokens') throw new AiError('output_truncated');
      if (data.stop_reason === 'refusal') throw new AiError('refused');
      const text = (data.content ?? [])
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('');
      if (!text) throw new AiError('invalid_output', { detail: 'response had no text' });
      return {
        text,
        usage: {
          inputTokens: num(data.usage?.input_tokens),
          outputTokens: num(data.usage?.output_tokens),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ChatGPT Codex backend (Responses API, OAuth bearer). Unofficial: shapes follow the Codex CLI.
// The backend only answers as a server-sent-event stream, so this adapter reads the whole stream
// and returns the assembled text (the pipeline above it is not streaming either).
// ---------------------------------------------------------------------------------------------

export interface CodexResponsesConfig {
  /** OAuth access token (never logged). */
  accessToken: string;
  accountId: string;
  model: string;
  fetch: FetchLike;
  /** Default `https://chatgpt.com/backend-api/codex`. */
  baseUrl?: string;
  reasoningEffort?: string;
  now?: () => number;
}

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** Text and token usage out of a Responses-API event stream. Exported for tests. */
export function parseCodexStream(raw: string): {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  incomplete: boolean;
  failed: boolean;
} {
  let deltas = '';
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let incomplete = false;
  let failed = false;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev: {
      type?: unknown;
      delta?: unknown;
      response?: {
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
        output?: { content?: { type?: unknown; text?: unknown }[] }[];
      };
    };
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      deltas += ev.delta;
    } else if (ev.type === 'response.failed' || ev.type === 'error') {
      failed = true;
    } else if (ev.type === 'response.incomplete') {
      incomplete = true;
    } else if (ev.type === 'response.completed' && ev.response) {
      inputTokens = num(ev.response.usage?.input_tokens);
      outputTokens = num(ev.response.usage?.output_tokens);
      finalText = (ev.response.output ?? [])
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
    }
  }
  return { text: deltas || finalText, usage: { inputTokens, outputTokens }, incomplete, failed };
}

export function createCodexResponsesProvider(cfg: CodexResponsesConfig): AiProvider {
  const base = assertSafeEndpoint(cfg.baseUrl ?? CODEX_BASE_URL);
  const url = `${base.origin}${base.pathname.replace(/\/+$/, '')}/responses`;
  const token = cfg.accessToken.trim();
  const now = cfg.now ?? (() => Date.now());
  const effort = cfg.reasoningEffort?.trim() ?? '';
  return {
    id: `codex-responses:${base.host}`,
    model: cfg.model,
    origin: base.origin,
    async complete(req, { signal, onDelta }) {
      if (!token || !cfg.accountId) throw new AiError('missing_key');
      const system = req.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const body = {
        model: cfg.model,
        instructions: system || 'You are a helpful study assistant.',
        input: req.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            type: 'message',
            role: m.role,
            content: [
              { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content },
            ],
          })),
        stream: true,
        store: false,
        ...(effort ? { reasoning: { effort, summary: 'auto' } } : {}),
      };
      let res: Response;
      try {
        res = await cfg.fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${token}`,
            'chatgpt-account-id': cfg.accountId,
            'openai-beta': 'responses=experimental',
            originator: 'codex_cli_rs',
          },
          body: JSON.stringify(body),
          signal: signal ?? null,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
      } catch {
        if (signal?.aborted) throw new AiError('aborted');
        throw new AiError('network');
      }
      let text: string;
      try {
        if (res.ok) {
          // Read the event stream as it arrives so the answer can be shown while it is written.
          const lines: string[] = [];
          let soFar = '';
          await readEventStream(
            res,
            (payload) => {
              lines.push(`data: ${payload}`);
              if (!onDelta || !payload.includes('response.output_text.delta')) return;
              try {
                const ev = JSON.parse(payload) as { type?: unknown; delta?: unknown };
                if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
                  soFar += ev.delta;
                  onDelta(soFar);
                }
              } catch {
                /* partial or foreign event */
              }
            },
            signal,
          );
          text = lines.join('\n');
        } else {
          text = await res.text();
        }
      } catch (e) {
        if (e instanceof AiError) throw e;
        throw new AiError(signal?.aborted ? 'aborted' : 'network');
      }
      if (!res.ok) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        // A 401 means the login expired or was revoked: sign in again.
        throw httpError(res, parsed, now());
      }
      if (text.length > MAX_RESPONSE_CHARS) {
        throw new AiError('server_error', { status: res.status, detail: 'response too large' });
      }
      const out = parseCodexStream(text);
      if (out.failed) {
        throw new AiError('server_error', { status: res.status, detail: 'stream failed' });
      }
      if (out.incomplete) throw new AiError('output_truncated');
      if (!out.text) throw new AiError('invalid_output', { detail: 'response had no text' });
      return { text: out.text, usage: out.usage };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Scripted provider for tests and offline demos
// ---------------------------------------------------------------------------------------------

export interface MockStep {
  text?: string;
  json?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  /** Throw this instead of answering. */
  error?: Error;
  /** Never answer; settles only when the signal aborts. */
  hang?: boolean;
  /** Answer only after this promise resolves. */
  gate?: Promise<unknown>;
}

export type MockScript =
  readonly MockStep[] | ((req: AiCompletionRequest, call: number) => MockStep);

export interface MockProvider extends AiProvider {
  readonly calls: AiCompletionRequest[];
}

export function createMockProvider(
  script: MockScript,
  opts: { id?: string; model?: string } = {},
): MockProvider {
  const calls: AiCompletionRequest[] = [];
  return {
    id: opts.id ?? 'mock',
    model: opts.model ?? 'mock-model',
    calls,
    async complete(req, { signal }) {
      const index = calls.length;
      calls.push(req);
      if (signal?.aborted) throw new AiError('aborted');
      const step = typeof script === 'function' ? script(req, index) : script[index];
      if (!step) throw new AiError('internal', { detail: 'mock script exhausted' });
      if (step.hang) {
        await new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new AiError('aborted')), { once: true });
        });
      }
      if (step.gate) await step.gate;
      if (signal?.aborted) throw new AiError('aborted');
      if (step.error) throw step.error;
      const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
      const out = step.text ?? JSON.stringify(step.json ?? {});
      return {
        ...(step.text !== undefined ? { text: step.text } : {}),
        ...(step.json !== undefined ? { json: step.json } : {}),
        usage: step.usage ?? {
          inputTokens: Math.ceil(chars / 4),
          outputTokens: Math.ceil(out.length / 4),
        },
      };
    },
  };
}
