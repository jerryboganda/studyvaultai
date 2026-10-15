import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny OpenAI-compatible chat-completions server for the AI e2e specs (tests/e2e/ai.spec.ts).
 *
 * It is the provider the product's own `openai_compatible` adapter (packages/ai/src/providers.ts)
 * talks to, on 127.0.0.1 with a random port (the e2e build holds loopback host permissions). The wire
 * format is implemented as the adapter sends and expects it:
 *
 *   POST {base}/chat/completions, content-type application/json, optional `Authorization: Bearer <key>`
 *   body   { model, messages: [{role, content}], max_tokens | max_completion_tokens, temperature,
 *            stream: false, response_format?: { type: 'json_object' } }
 *   200    { id, object, created, model, choices: [{ index, message: {role, content}, finish_reason }],
 *            usage: { prompt_tokens, completion_tokens, total_tokens } }
 *   errors { error: { message, type, code } } with the status code (401 / 429 / 5xx ...)
 *
 * What it does NOT do: streaming, tools, multiple choices, CORS headers (the extension's host
 * permission is what lets an extension page read the answer, exactly as in production after the user
 * grants the origin). Every request is recorded, whatever its method or path, so a test can assert
 * "the provider heard nothing", "exactly one request" or "no preflight, no cookie, no referrer".
 *
 * No real key, no internet: the canned answers are computed from the request itself (the data
 * blocks the product put into the prompt), so a quote is always a verbatim span of what was sent.
 *
 * ANTHROPIC MODE (`startFakeProvider({ api: 'anthropic' })`): the same server speaks the Anthropic
 * Messages API instead, as the product's `anthropic` adapter sends and expects it:
 *
 *   POST {base}/v1/messages, content-type application/json, `x-api-key: <key>` (never Authorization),
 *        `anthropic-version`, `anthropic-dangerous-direct-browser-access: true` (recorded, not required)
 *   body   { model, max_tokens, system?, messages: [{role: 'user'|'assistant', content}], temperature? }
 *          anything else is refused like the real API refuses it (`Extra inputs are not permitted`), as
 *          is a `system` role inside `messages` and a first message that is not `user`
 *   200    { id, type: 'message', role: 'assistant', model, content: [{type: 'text', text}],
 *            stop_reason, stop_sequence, usage: { input_tokens, output_tokens } }
 *   errors { type: 'error', error: { type, message }, request_id } with 401 authentication_error,
 *          429 rate_limit_error, 529 overloaded_error ... (`anthropicFailure`)
 *
 * `baseUrl` is then the origin itself (the adapter appends /v1/messages). `Seen.chat` is the request
 * normalised to the chat shape (the `system` text first) so `dataBlocks`, `taskOf` and the canned
 * answers work unchanged; `Seen.anthropic` is the validated body as it came. In this mode the `ok`
 * reply's `finishReason` is the `stop_reason` (default `end_turn`).
 */

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: { type: string };
}

/** The body of POST /v1/messages that the fake accepts (Anthropic mode). */
export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  temperature?: number;
}

/** One request the provider saw (every method and path, not only completions). */
export interface Seen {
  n: number;
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The parsed, validated body (null when the request was not a valid completion). */
  chat: ChatRequest | null;
  /** Anthropic mode only: the validated Messages API body as it came (absent otherwise). */
  anthropic?: AnthropicRequest;
  /** The client dropped the connection before an answer was written (cancel or timeout). */
  clientClosed: boolean;
  /** Status written, `'hang'` while held open, null while still being read. */
  answered: number | 'hang' | null;
}

export type Reply =
  | {
      kind: 'ok';
      /** The model's message content (a JSON document for a well-behaved model). */
      content: string;
      /** OpenAI `finish_reason` (default `stop`); in Anthropic mode the `stop_reason` (`end_turn`). */
      finishReason?: string;
      /** Token counts the answer reports; absent: derived from the text sizes (4 characters each). */
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      kind: 'http';
      status: number;
      /** An object is sent as JSON; a string is sent as it is (a gateway page, for example). */
      body: unknown;
      headers?: Record<string, string>;
    }
  | { kind: 'hang' };

export type ReplyFor = Reply | ((chat: ChatRequest) => Reply);

/** An answer whose message content is `content` (an object is sent as its JSON text). */
export function ok(
  content: unknown,
  extra: { finishReason?: string; usage?: { inputTokens: number; outputTokens: number } } = {},
): Reply {
  return {
    kind: 'ok',
    content: typeof content === 'string' ? content : JSON.stringify(content),
    ...extra,
  };
}

/** An OpenAI-shaped error answer. */
export function failure(
  status: number,
  error: { type: string; code: string; message?: string },
  headers: Record<string, string> = {},
): Reply {
  return {
    kind: 'http',
    status,
    body: { error: { message: error.message ?? `${error.code} (e2e fake provider)`, ...error } },
    headers,
  };
}

/** An Anthropic-shaped error answer: `{type: 'error', error: {type, message}, request_id}`. */
export function anthropicFailure(
  status: number,
  error: { type: string; message?: string },
  headers: Record<string, string> = {},
): Reply {
  return {
    kind: 'http',
    status,
    body: {
      type: 'error',
      error: { type: error.type, message: error.message ?? `${error.type} (e2e fake provider)` },
      request_id: 'req_e2e_fake',
    },
    headers,
  };
}

/** The request is accepted and never answered (until the client gives up or the server closes). */
export const hang: Reply = { kind: 'hang' };

// ---------------------------------------------------------------------------------------------
// Reading the prompt the product built (packages/ai/src/prompt.ts)
// ---------------------------------------------------------------------------------------------

export interface DataBlock {
  id: string;
  kind: string;
  text: string;
}

const BLOCK =
  /<<<SV_DATA n=(\S+) id="([^"]+)" kind="([^"]+)">>>\n([\s\S]*?)\n<<<END_SV_DATA n=\1>>>/g;

/** The user message of the first turn (the repair turn appends more messages after it). */
export function userPrompt(chat: ChatRequest): string {
  return chat.messages.find((m) => m.role === 'user')?.content ?? '';
}

/** The untrusted-data blocks of the prompt: the passages the person selected, as sent. */
export function dataBlocks(chat: ChatRequest): DataBlock[] {
  return [...userPrompt(chat).matchAll(BLOCK)].map((m) => ({
    id: m[2] ?? '',
    kind: m[3] ?? '',
    text: m[4] ?? '',
  }));
}

/** The first `words` words of `text`: a contiguous span, so it is verbatim in the block. */
export function quoteFrom(text: string, words = 7): string {
  return text.split(/\s+/).filter(Boolean).slice(0, words).join(' ');
}

/** The task the prompt asks for, from the fixed instruction text of packages/ai/src/tasks.ts. */
export function taskOf(chat: ChatRequest): string {
  const p = userPrompt(chat);
  if (p === 'Reply with the single word: OK') return 'connection_test';
  if (p.startsWith('TASK\nWrite ONE exam pearl')) return 'exam_pearl';
  if (p.startsWith('TASK\nCreate up to')) return 'flashcards';
  if (p.startsWith('TASK\nWrite a concise summary')) return 'summary';
  if (p.startsWith('TASK\nWrite 1 to 5 memory aids')) return 'mnemonic';
  if (p.startsWith('TASK\nWrite 3 to 5 short oral-exam')) return 'short_viva';
  if (p.startsWith('TASK\nBuild a hierarchical study outline')) return 'study_outline';
  if (p.startsWith('TASK\nAnswer the question in the data block')) return 'explain';
  if (p.startsWith('TASK\nReply to the message in the data block')) return 'chat';
  return 'unknown';
}

/** A well-formed, fully grounded answer for the task in `chat`. */
export function cannedAnswer(chat: ChatRequest): string {
  const task = taskOf(chat);
  const [first] = dataBlocks(chat);
  if (task === 'connection_test') return 'OK';
  if (!first) throw new Error(`the prompt has no data block (task ${task})`);
  const evidence = { quoteId: first.id, text: quoteFrom(first.text) };
  switch (task) {
    case 'exam_pearl':
      return JSON.stringify({
        oneLiner: 'E2E pearl: the passage states one testable fact.',
        why: 'E2E canned explanation of why the fact matters.',
        sourceQuoteId: first.id,
        sourceQuote: evidence.text,
      });
    case 'flashcards':
      return JSON.stringify({
        cards: [
          {
            type: 'basic',
            front: 'E2E question: what does the passage state?',
            back: 'E2E answer: the passage states one fact.',
            evidence: [evidence],
          },
        ],
      });
    case 'summary':
      return JSON.stringify({
        summary: 'E2E summary of the passage.',
        keyPoints: ['E2E key point one.'],
        evidence: [evidence],
      });
    case 'explain':
      return JSON.stringify({
        answer: 'E2E answer drawn from the first passage.',
        answerState: 'answered',
        uncertainty: '',
        evidence: [evidence],
      });
    case 'chat': {
      // Passages (highlight/note blocks) come first; a chat with none is a general conversation.
      const passage = dataBlocks(chat).find((x) => x.kind === 'highlight' || x.kind === 'note');
      return JSON.stringify(
        passage
          ? {
              answer: 'E2E chat answer drawn from your notes.',
              basis: 'notes',
              evidence: [{ quoteId: passage.id, text: quoteFrom(passage.text) }],
            }
          : { answer: 'E2E general chat answer.', basis: 'general', evidence: [] },
      );
    }
    case 'mnemonic':
      return JSON.stringify({
        aids: [
          {
            type: 'acronym',
            fact: 'E2E fact the aid is anchored to.',
            mnemonic: 'E2E mnemonic: S-A-N.',
            howItWorks: 'E2E mapping of the letters.',
            evidence: [evidence],
          },
        ],
      });
    case 'short_viva':
      return JSON.stringify({
        questions: [
          {
            question: 'E2E viva question about the passage?',
            modelAnswer: 'E2E model answer to say aloud.',
            evidence: [evidence],
          },
        ],
      });
    case 'study_outline':
      return JSON.stringify({
        title: 'E2E outline',
        items: [
          { level: 1, text: 'E2E main topic', evidence: [evidence] },
          { level: 2, text: 'E2E sub-topic', evidence: [evidence] },
        ],
      });
    default:
      throw new Error(`the fake provider has no canned answer for task ${task}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

export interface FakeProvider {
  /** Which wire format this server speaks. */
  readonly api: 'openai' | 'anthropic';
  /** http://127.0.0.1:PORT */
  readonly origin: string;
  /**
   * What a person types as the provider address: `${origin}/v1` for the OpenAI format, the origin
   * itself for the Anthropic one (the adapter appends /v1/messages).
   */
  readonly baseUrl: string;
  /** 127.0.0.1:PORT (what the product prints as the provider). */
  readonly host: string;
  /** Every request, any method or path, in arrival order. */
  readonly seen: readonly Seen[];
  /** POST /v1/chat/completions only (POST /v1/messages in Anthropic mode). */
  completions(): Seen[];
  /**
   * The bearer key the server accepts (`x-api-key` in Anthropic mode); undefined accepts any request
   * (a keyless local model; in Anthropic mode any non-empty key, as that API always wants one).
   */
  setKey(key: string | undefined): void;
  /** Replies for the next completions, in order, before the default answer applies again. */
  queue(...replies: ReplyFor[]): void;
  /** What answers when the queue is empty (default: `cannedAnswer`). */
  setDefault(fn: (chat: ChatRequest) => Reply): void;
  close(): Promise<void>;
}

const error = (message: string, type: string, code: string) => ({
  error: { message, type, code },
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validChat(raw: unknown): ChatRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.model !== 'string' || o.model === '') return null;
  if (!Array.isArray(o.messages) || o.messages.length === 0) return null;
  for (const m of o.messages) {
    const x = m as Record<string, unknown> | null;
    if (typeof x !== 'object' || x === null) return null;
    if (!['system', 'user', 'assistant'].includes(String(x.role))) return null;
    if (typeof x.content !== 'string') return null;
  }
  return raw as ChatRequest;
}

/** The only fields the product's Anthropic adapter may send (an unknown one is a 400, as live). */
const ANTHROPIC_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'max_tokens',
  'system',
  'messages',
  'temperature',
]);

/** The Messages API checks the adapter must pass; the message is what the real API would say. */
function validAnthropic(
  raw: unknown,
): { ok: true; req: AnthropicRequest } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return bad('body: Input should be a valid dictionary');
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ANTHROPIC_FIELDS.has(k)) return bad(`${k}: Extra inputs are not permitted`);
  }
  if (typeof o.model !== 'string' || o.model === '') return bad('model: Field required');
  if (typeof o.max_tokens !== 'number' || !Number.isInteger(o.max_tokens) || o.max_tokens < 1) {
    return bad('max_tokens: Field required');
  }
  if (o.system !== undefined && typeof o.system !== 'string') {
    return bad('system: Input should be a valid string');
  }
  if (
    o.temperature !== undefined &&
    (typeof o.temperature !== 'number' || o.temperature < 0 || o.temperature > 1)
  ) {
    return bad('temperature: Input should be a number between 0 and 1');
  }
  if (!Array.isArray(o.messages) || o.messages.length === 0) return bad('messages: Field required');
  for (const [i, m] of o.messages.entries()) {
    const x = m as Record<string, unknown> | null;
    if (typeof x !== 'object' || x === null) {
      return bad(`messages.${i}: Input should be a valid dictionary`);
    }
    if (x.role !== 'user' && x.role !== 'assistant') {
      return bad(`messages.${i}.role: Input should be 'user' or 'assistant'`);
    }
    if (typeof x.content !== 'string' || x.content.trim() === '') {
      return bad(`messages.${i}.content: must be a non-empty string`);
    }
  }
  if ((o.messages[0] as { role: string }).role !== 'user') {
    return bad('messages: first message must use the "user" role');
  }
  return { ok: true, req: raw as AnthropicRequest };
}

export async function startFakeProvider(
  opts: { apiKey?: string; api?: 'openai' | 'anthropic' } = {},
): Promise<FakeProvider> {
  let key = opts.apiKey;
  const api = opts.api ?? 'openai';
  const seen: Seen[] = [];
  const queue: ReplyFor[] = [];
  let fallback: (chat: ChatRequest) => Reply = (chat) => ok(cannedAnswer(chat));

  type Send = (status: number, payload: unknown, headers?: Record<string, string>) => void;

  /** One request in Anthropic mode: headers, body, then the same queue as the OpenAI mode. */
  const answerAnthropic = (entry: Seen, send: Send): void => {
    const refuse = (status: number, type: string, message: string): void =>
      send(status, { type: 'error', error: { type, message }, request_id: 'req_e2e_fake' });
    if (entry.path !== '/v1/messages') {
      return refuse(404, 'not_found_error', `Unknown URL ${entry.path}`);
    }
    if (entry.method !== 'POST') return refuse(405, 'invalid_request_error', 'Method not allowed');
    const sent = entry.headers['x-api-key'];
    if (typeof sent !== 'string' || sent === '') {
      return refuse(401, 'authentication_error', 'x-api-key header is required');
    }
    if (key !== undefined && sent !== key) {
      return refuse(401, 'authentication_error', 'invalid x-api-key');
    }
    if (!entry.headers['anthropic-version']) {
      return refuse(400, 'invalid_request_error', 'anthropic-version: header is required');
    }
    const parsed = validAnthropic(parseJson(entry.body));
    if (!parsed.ok) return refuse(400, 'invalid_request_error', parsed.message);
    const { req } = parsed;
    const chat: ChatRequest = {
      model: req.model,
      max_tokens: req.max_tokens,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages],
    };
    entry.chat = chat;
    entry.anthropic = req;

    let reply: Reply;
    try {
      const next = queue.shift();
      reply = typeof next === 'function' ? next(chat) : (next ?? fallback(chat));
    } catch (e) {
      return refuse(400, 'invalid_request_error', String((e as Error).message));
    }
    if (reply.kind === 'hang') {
      entry.answered = 'hang';
      return; // held open: `close` fires when the client aborts or the server stops
    }
    if (reply.kind === 'http') return send(reply.status, reply.body, reply.headers);
    const chars = chat.messages.reduce((n, m) => n + m.content.length, 0);
    send(200, {
      id: `msg_e2e_${entry.n}`,
      type: 'message',
      role: 'assistant',
      model: chat.model,
      content: [{ type: 'text', text: reply.content }],
      stop_reason: reply.finishReason ?? 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: reply.usage?.inputTokens ?? Math.ceil(chars / 4),
        output_tokens: reply.usage?.outputTokens ?? Math.ceil(reply.content.length / 4),
      },
    });
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = {
        n: seen.length + 1,
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://fake.local').pathname,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        chat: null,
        clientClosed: false,
        answered: null,
      };
      seen.push(entry);
      res.on('close', () => {
        if (!res.writableFinished) entry.clientClosed = true;
      });
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        entry.answered = status;
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, {
          'content-type': typeof payload === 'string' ? 'text/plain' : 'application/json',
          'cache-control': 'no-store',
          ...headers,
        });
        res.end(text);
      };

      if (api === 'anthropic') return answerAnthropic(entry, send);

      if (entry.path !== '/v1/chat/completions') {
        return send(404, error(`Unknown URL ${entry.path}`, 'invalid_request_error', 'not_found'));
      }
      if (entry.method !== 'POST') {
        return send(405, error('Method not allowed', 'invalid_request_error', 'bad_method'));
      }
      if (key !== undefined && req.headers.authorization !== `Bearer ${key}`) {
        return send(
          401,
          error('Incorrect API key provided.', 'invalid_request_error', 'invalid_api_key'),
        );
      }
      const chat = validChat(parseJson(entry.body));
      if (!chat) {
        return send(400, error('Invalid request body.', 'invalid_request_error', 'bad_request'));
      }
      entry.chat = chat;

      let reply: Reply;
      try {
        const next = queue.shift();
        reply = typeof next === 'function' ? next(chat) : (next ?? fallback(chat));
      } catch (e) {
        return send(400, error(String((e as Error).message), 'invalid_request_error', 'e2e_fake'));
      }
      if (reply.kind === 'hang') {
        entry.answered = 'hang';
        return undefined; // held open: `close` fires when the client aborts or the server stops
      }
      if (reply.kind === 'http') return send(reply.status, reply.body, reply.headers);
      const chars = chat.messages.reduce((n, m) => n + m.content.length, 0);
      const prompt = reply.usage?.inputTokens ?? Math.ceil(chars / 4);
      const completion = reply.usage?.outputTokens ?? Math.ceil(reply.content.length / 4);
      return send(200, {
        id: `chatcmpl-e2e-${entry.n}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: chat.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply.content },
            finish_reason: reply.finishReason ?? 'stop',
          },
        ],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
        },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const completionPath = api === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  return {
    api,
    origin,
    baseUrl: api === 'anthropic' ? origin : `${origin}/v1`,
    host: `127.0.0.1:${port}`,
    seen,
    completions: () => seen.filter((s) => s.method === 'POST' && s.path === completionPath),
    setKey: (next) => {
      key = next;
    },
    queue: (...replies) => {
      queue.push(...replies);
    },
    setDefault: (fn) => {
      fallback = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
