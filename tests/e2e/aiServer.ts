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

/** One request the provider saw (every method and path, not only completions). */
export interface Seen {
  n: number;
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The parsed, validated body (null when the request was not a valid completion). */
  chat: ChatRequest | null;
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
      finishReason?: string;
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
export function ok(content: unknown): Reply {
  return { kind: 'ok', content: typeof content === 'string' ? content : JSON.stringify(content) };
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
    default:
      throw new Error(`the fake provider has no canned answer for task ${task}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

export interface FakeProvider {
  /** http://127.0.0.1:PORT */
  readonly origin: string;
  /** `${origin}/v1`: what a person types as the provider address. */
  readonly baseUrl: string;
  /** 127.0.0.1:PORT (what the product prints as the provider). */
  readonly host: string;
  /** Every request, any method or path, in arrival order. */
  readonly seen: readonly Seen[];
  /** POST /v1/chat/completions only. */
  completions(): Seen[];
  /** The bearer key the server accepts; undefined accepts any request (a keyless local model). */
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

export async function startFakeProvider(opts: { apiKey?: string } = {}): Promise<FakeProvider> {
  let key = opts.apiKey;
  const seen: Seen[] = [];
  const queue: ReplyFor[] = [];
  let fallback: (chat: ChatRequest) => Reply = (chat) => ok(cannedAnswer(chat));

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
      const prompt = Math.ceil(chars / 4);
      const completion = Math.ceil(reply.content.length / 4);
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
  return {
    origin,
    baseUrl: `${origin}/v1`,
    host: `127.0.0.1:${port}`,
    seen,
    completions: () => seen.filter((s) => s.method === 'POST' && s.path === '/v1/chat/completions'),
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
