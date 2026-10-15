import { updateSettings } from '@runtime';
import {
  addAiSpend,
  defaultAiSettings,
  setAiApiKey,
  setAiProfileApiKey,
  setAiSettings,
} from '@storage';
import { gallery } from '../shim/chrome';

/**
 * "AI configured" for the gallery: settings for a fake provider on reserved `.example` addresses,
 * sample keys that open nothing, and an in-page answer to that provider's HTTP calls (window.fetch is
 * wrapped for those two origins only), so the real consent dialog, answers, Test connection and the
 * routing and ledger screens can be shown. No request leaves the page.
 */
const PRIMARY = {
  origin: 'https://api.sample-ai.example',
  baseUrl: 'https://api.sample-ai.example/v1',
};
const BACKUP = { origin: 'https://backup.sample-ai.example', id: 'p-backup01' };
const PRICING = { inputUsdPerMTok: 0.5, outputUsdPerMTok: 1.5 };
/** How long the fake provider "thinks", so the dialog's waiting state shows for a moment. */
const LATENCY_MS = 600;

/** `access`: Chrome already allows the provider's address (otherwise the dialog asks first). */
export async function seedAi({ access = true } = {}): Promise<void> {
  await updateSettings((s) => ({ ...s, features: { ...s.features, ai: true } }));
  await setAiSettings({
    ...defaultAiSettings(),
    baseUrl: PRIMARY.baseUrl,
    model: 'sample-model-small',
    pricing: PRICING,
    limits: { maxRequestsPerDay: 30, maxCostUsdPerDay: 1 },
    fallbacks: [
      {
        id: BACKUP.id,
        label: 'Sample backup provider',
        provider: 'anthropic',
        baseUrl: BACKUP.origin,
        model: 'sample-model-large',
        jsonMode: false,
        maxTokensParam: 'max_tokens',
        vendor: 'custom',
        reasoningEffort: '',
        authScheme: 'bearer',
        pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
        fallback: true,
      },
    ],
    routes: { flashcards: BACKUP.id },
  });
  await setAiApiKey('gallery-sample-key-0000', PRIMARY.origin);
  await setAiProfileApiKey(BACKUP.id, 'gallery-sample-key-1111', BACKUP.origin);
  await addAiSpend({ requests: 3, costUsd: 0.0042, inputTokens: 5200, outputTokens: 640 });
  if (access) {
    gallery.grantedOrigins.add(`${PRIMARY.origin}/*`);
    gallery.grantedOrigins.add(`${BACKUP.origin}/*`);
  }
  installFakeProvider();
}

interface Block {
  id: string;
  kind: string;
  text: string;
}

/** The data blocks of a task prompt (packages/ai/src/prompt.ts), quotable ones only. */
function quotable(prompt: string): Block[] {
  const re = /<<<SV_DATA n=\S+ id="([^"]+)" kind="(\w+)">>>\n([\s\S]*?)\n<<<END_SV_DATA/g;
  return [...prompt.matchAll(re)]
    .map(([, id, kind, text]) => ({ id: id!, kind: kind!, text: text! }))
    .filter((b) => b.kind === 'highlight' || b.kind === 'note');
}

/** A verbatim, contiguous span of a block (the citation rule): its first sentence, capped. */
const span = (b: Block) => (b.text.split(/(?<=[.;:])\s/)[0] ?? b.text).slice(0, 240).trim();
const evidence = (b: Block) => ({ quoteId: b.id, text: span(b) });
const SAMPLE = 'Sample answer from the screen gallery’s fake AI provider';

/** A schema-valid answer for the task the prompt asks for (by its OUTPUT SHAPE), else `{}`. */
export function sampleAnswer(prompt: string): string {
  if (/^Reply with the single word: OK$/.test(prompt.trim())) return 'OK';
  const blocks = quotable(prompt);
  const first = blocks[0];
  // Chat ("basis" shape): answers even with no study material, citing a passage when there is one.
  if (prompt.includes('"basis"')) {
    return JSON.stringify(
      first
        ? {
            answer: `${SAMPLE}. Your notes say: “${span(first)}”`,
            basis: 'mixed',
            evidence: [evidence(first)],
          }
        : {
            answer: `${SAMPLE}: a general answer (no saved passage matched).`,
            basis: 'general',
            evidence: [],
          },
    );
  }
  if (!first) return '{}';
  const cited = blocks.slice(0, 2).map(evidence);
  const has = (key: string) => prompt.includes(`"${key}"`);
  let out: unknown = {};
  if (has('answerState')) {
    out = {
      answer: `${SAMPLE}. The saved passages say: “${span(first)}”`,
      answerState: 'answered',
      uncertainty: 'This is a canned sample, not a real model answer.',
      evidence: cited,
    };
  } else if (has('oneLiner')) {
    out = {
      oneLiner: `${SAMPLE}: one line to remember.`,
      why: 'Canned sample text: a real provider would explain why this matters for the exam.',
      sourceQuoteId: first.id,
      sourceQuote: span(first),
    };
  } else if (has('keyPoints')) {
    out = {
      summary: `${SAMPLE}: a short summary of the selected passages.`,
      keyPoints: ['Sample key point one.', 'Sample key point two.'],
      evidence: cited,
    };
  } else if (has('cards')) {
    out = {
      cards: [
        {
          type: 'basic',
          front: 'Sample question (gallery)?',
          back: span(first),
          evidence: [evidence(first)],
        },
        {
          type: 'cloze',
          text: 'A {{c1::sample}} cloze card from the gallery.',
          evidence: [evidence(first)],
        },
      ],
    };
  } else if (has('stem')) {
    out = {
      stem: 'Sample question from the gallery: which statement is in the saved passage?',
      choices: [
        { id: 'A', text: span(first).slice(0, 120) },
        { id: 'B', text: 'A sample distractor.' },
        { id: 'C', text: 'Another sample distractor.' },
        { id: 'D', text: 'A third sample distractor.' },
      ],
      keyChoiceId: 'A',
      explanation: 'Canned sample: choice A is quoted from the passage.',
      evidence: [evidence(first)],
      requiresHumanVerification: true,
    };
  } else if (has('aids')) {
    out = {
      aids: [
        {
          type: 'acronym',
          fact: 'Sample fact taken from the passage.',
          mnemonic: 'SAMPLE: a canned memory aid.',
          howItWorks: 'Each letter stands for a word of the fact (gallery sample).',
          evidence: [evidence(first)],
        },
      ],
    };
  }
  return JSON.stringify(out);
}

let installed = false;

function installFakeProvider(): void {
  if (installed) return;
  installed = true;
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const origin = new URL(url, location.href).origin;
    if (origin !== PRIMARY.origin && origin !== BACKUP.origin) return real(input, init);
    gallery.calls.push({ api: 'ai.fetch', args: [url], at: Date.now() });
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: { role: string; content: string }[];
    };
    // The task message (a repair turn repeats the original one before it), else the only one.
    const users = (body.messages ?? []).filter((m) => m.role === 'user');
    const prompt =
      (users.find((m) => m.content.includes('OUTPUT SHAPE')) ?? users[0])?.content ?? '';
    const text = sampleAnswer(prompt);
    const tokens = { input: Math.ceil(JSON.stringify(body).length / 4), output: text.length };
    const reply =
      origin === BACKUP.origin
        ? {
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            usage: { input_tokens: tokens.input, output_tokens: tokens.output },
          }
        : {
            choices: [{ message: { content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output },
          };
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
