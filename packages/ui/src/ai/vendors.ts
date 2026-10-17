// The provider presets: what each vendor needs (address, auth, how reasoning effort is sent) and
// how its model list is obtained. Pure data and one fetch helper; nothing runs on import.
import { basicAuthHeader, type FetchLike } from '@ai';
import type { AiAuthScheme, AiEffort, AiProviderId, AiVendorId } from '@storage';

export interface VendorSpec {
  id: AiVendorId;
  label: string;
  hint: string;
  provider: AiProviderId;
  baseUrl: string;
  authScheme: AiAuthScheme;
  /** How the effort reaches the provider (OpenAI-compatible adapter only). */
  reasoningStyle: 'reasoning_effort' | 'openrouter' | 'none';
  /** Efforts this vendor can express; models narrow it further in `effortsFor`. */
  efforts: readonly AiEffort[];
  /** Shown when the vendor has no effort control, as the reason the dropdown is disabled. */
  noEffortReason: string;
  /** Used when the live list cannot be fetched (offline, no key yet). */
  curatedModels: readonly string[];
  /** The key field's label and what it holds. */
  keyLabel: string;
  keyHelp: string;
  /** `GET <base>/models` is available. */
  liveModels: boolean;
}

const E3: readonly AiEffort[] = ['low', 'medium', 'high'];
const E4: readonly AiEffort[] = ['minimal', 'low', 'medium', 'high'];

export const VENDORS: Record<AiVendorId, VendorSpec> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    hint: 'Cloud, API key',
    provider: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    authScheme: 'bearer',
    reasoningStyle: 'reasoning_effort',
    efforts: E4,
    noEffortReason: 'This model does not take a reasoning effort.',
    curatedModels: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o-mini'],
    keyLabel: 'API key',
    keyHelp: 'An OpenAI API key (sk-…).',
    liveModels: true,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Cloud, API key',
    provider: 'anthropic',
    baseUrl: '',
    authScheme: 'bearer',
    reasoningStyle: 'none',
    efforts: [],
    noEffortReason: 'Extended thinking is not used for Anthropic requests yet.',
    curatedModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    keyLabel: 'API key',
    keyHelp: 'An Anthropic API key.',
    liveModels: false,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    hint: 'This computer',
    provider: 'openai_compatible',
    baseUrl: 'http://localhost:11434/v1',
    authScheme: 'bearer',
    reasoningStyle: 'none',
    efforts: [],
    noEffortReason: 'Local models have no reasoning-effort setting here.',
    curatedModels: [],
    keyLabel: 'API key',
    keyHelp: 'Not needed on this computer.',
    liveModels: true,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    hint: 'This computer',
    provider: 'openai_compatible',
    baseUrl: 'http://localhost:1234/v1',
    authScheme: 'bearer',
    reasoningStyle: 'none',
    efforts: [],
    noEffortReason: 'Local models have no reasoning-effort setting here.',
    curatedModels: [],
    keyLabel: 'API key',
    keyHelp: 'Not needed on this computer.',
    liveModels: true,
  },
  custom: {
    id: 'custom',
    label: 'Other',
    hint: 'Any address',
    provider: 'openai_compatible',
    baseUrl: '',
    authScheme: 'bearer',
    reasoningStyle: 'reasoning_effort',
    efforts: E4,
    noEffortReason: '',
    curatedModels: [],
    keyLabel: 'API key',
    keyHelp: 'Sent as a Bearer token.',
    liveModels: true,
  },
  ubag: {
    id: 'ubag',
    label: 'UBAG',
    hint: 'Browser gateway',
    provider: 'openai_compatible',
    baseUrl: 'https://ubag.polytronx.com/v1/openai',
    authScheme: 'basic',
    // UBAG has no effort parameter: a thinking level is its own model id (`target|Medium`).
    reasoningStyle: 'none',
    efforts: [],
    noEffortReason: 'UBAG picks the thinking level through the model list.',
    // A bare target uses the gateway operator's defaults (ChatGPT: GPT-6 at Medium power, Gemini: 4 Argon at Low
    // thinking); `target|setting` ids from the live list pick a model or a level explicitly.
    curatedModels: ['chatgpt_web', 'gemini_web', 'deepseek_web'],
    keyLabel: 'Username and password',
    keyHelp: 'Enter as username:password (the gateway operator login).',
    liveModels: true,
  },
  nvidia_nim: {
    id: 'nvidia_nim',
    label: 'NVIDIA NIM',
    hint: 'Cloud, API key',
    provider: 'openai_compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authScheme: 'bearer',
    reasoningStyle: 'reasoning_effort',
    efforts: E3,
    noEffortReason: 'This model does not take a reasoning effort.',
    curatedModels: [
      'openai/gpt-oss-120b',
      'meta/llama-3.3-70b-instruct',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
    ],
    keyLabel: 'API key',
    keyHelp: 'An NVIDIA API key (nvapi-…) from build.nvidia.com.',
    liveModels: true,
  },
  opencode_go: {
    id: 'opencode_go',
    label: 'OpenCode Go',
    hint: 'Cloud, API key',
    provider: 'openai_compatible',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    authScheme: 'bearer',
    reasoningStyle: 'reasoning_effort',
    efforts: E3,
    noEffortReason: 'This model does not take a reasoning effort.',
    curatedModels: [],
    keyLabel: 'API key',
    keyHelp: 'Your OpenCode Go API key.',
    liveModels: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'Cloud, API key',
    provider: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    authScheme: 'bearer',
    reasoningStyle: 'openrouter',
    efforts: E4,
    noEffortReason: 'This model does not support reasoning.',
    curatedModels: [
      'openai/gpt-5',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-r1',
    ],
    keyLabel: 'API key',
    keyHelp: 'An OpenRouter API key (sk-or-…).',
    liveModels: true,
  },
  chatgpt_codex: {
    id: 'chatgpt_codex',
    label: 'ChatGPT Codex',
    hint: 'Sign in, subscription',
    provider: 'codex_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authScheme: 'bearer',
    reasoningStyle: 'reasoning_effort',
    efforts: E4,
    noEffortReason: '',
    curatedModels: ['gpt-5-codex', 'gpt-5', 'gpt-5-codex-mini'],
    keyLabel: 'ChatGPT sign-in',
    keyHelp: 'Uses your ChatGPT subscription (unofficial).',
    liveModels: false,
  },
};

/** Anthropic and the Codex login always need credentials; others only off this computer. */
export const providerNeedsKey = (provider: AiProviderId, loopback: boolean): boolean =>
  provider === 'anthropic' || provider === 'codex_responses' || !loopback;

/**
 * Rough context window, in tokens, of a model (what the whole request may hold). Unknown models get
 * a cautious default; it only decides how much is trimmed before sending, never what is allowed.
 */
export function contextWindowTokens(vendor: AiVendorId, model: string): number {
  const m = model.toLowerCase();
  if (vendor === 'ubag') return 16_000; // a web chat, whatever the target
  if (/claude/.test(m)) return 200_000;
  if (/gpt-5|gpt-4\.1|gpt-4o|o\d|codex/.test(m)) return 128_000;
  if (/gemini/.test(m)) return 128_000;
  if (/llama-3\.[1-3]|qwen|deepseek|gpt-oss|nemotron|mistral|kimi|glm/.test(m)) return 32_000;
  return 8_000;
}

/** What the credential field is called and what it holds, which for UBAG depends on how it is reached. */
export function keyWording(
  vendor: AiVendorId,
  authScheme: AiAuthScheme,
): { label: string; help: string } {
  if (vendor === 'ubag' && authScheme === 'bearer') {
    return {
      label: 'Access token',
      help: 'A personal access token issued by the gateway operator, sent as a Bearer token.',
    };
  }
  return { label: VENDORS[vendor].keyLabel, help: VENDORS[vendor].keyHelp };
}

export const VENDOR_IDS = Object.keys(VENDORS) as AiVendorId[];

/** The preset a stored provider belongs to: its recorded vendor, else the address it points at. */
export function vendorOf(vendor: AiVendorId, provider: AiProviderId, baseUrl: string): AiVendorId {
  if (vendor !== 'custom') return vendor;
  const url = baseUrl.trim().replace(/\/+$/, '');
  return (
    VENDOR_IDS.find(
      (v) => v !== 'custom' && VENDORS[v].provider === provider && VENDORS[v].baseUrl === url,
    ) ?? 'custom'
  );
}

/** A model the live list says supports reasoning (OpenRouter), or one the vendor lists by name. */
export interface ModelEntry {
  id: string;
  reasoning?: boolean;
}

/** UBAG thinking-level ids look like `chatgpt_web|Medium`; the rest are models or toggles. */
const THINKING_LEVEL =
  /^(minimal|light|low|standard|medium|high|extended|heavy|max|deep|think(ing)?|reasoning)\b/i;

export const isUbagThinkingId = (id: string): boolean => {
  const i = id.indexOf('|');
  return i > 0 && THINKING_LEVEL.test(id.slice(i + 1).trim());
};

/** The thinking-level ids of the selected UBAG target (the effort dropdown's options). */
export function ubagThinkingOptions(models: readonly ModelEntry[], current: string): string[] {
  const target = current.split('|')[0] ?? '';
  return models
    .map((m) => m.id)
    .filter((id) => id.startsWith(`${target}|`) && isUbagThinkingId(id));
}

/**
 * Efforts the chosen model can take. An empty list means "none": the dropdown is disabled with
 * `noEffortReason`. Unknown models get the vendor's list (the provider ignores or rejects what it
 * does not know, and '' always means "the model's default").
 */
export function effortsFor(
  vendor: AiVendorId,
  model: string,
  models: readonly ModelEntry[] = [],
): readonly AiEffort[] {
  const spec = VENDORS[vendor];
  const id = model.trim().toLowerCase();
  if (vendor === 'openai') return /^(o\d|gpt-5)/.test(id) ? spec.efforts : [];
  if (vendor === 'nvidia_nim')
    return id === '' || /gpt-oss|nemotron|reason|r1|qwen3/.test(id) ? spec.efforts : [];
  if (vendor === 'openrouter') {
    const entry = models.find((m) => m.id === model);
    if (entry && entry.reasoning === false) return [];
  }
  return spec.efforts;
}

/**
 * `GET <base>/models`. Returns null (not an error) when the list cannot be fetched: the caller falls
 * back to the curated list and says so. Never throws; never logs the key.
 */
export async function fetchModelList(args: {
  baseUrl: string;
  apiKey: string | null;
  authScheme: AiAuthScheme;
  fetch: FetchLike;
  signal?: AbortSignal;
}): Promise<ModelEntry[] | null> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (args.apiKey) {
    headers.authorization =
      args.authScheme === 'basic' ? basicAuthHeader(args.apiKey) : `Bearer ${args.apiKey}`;
  }
  try {
    const res = await args.fetch(`${args.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers,
      signal: args.signal ?? null,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { id?: unknown; supported_parameters?: unknown }[];
      models?: { id?: unknown; name?: unknown }[];
    };
    const rows = data.data ?? [];
    const out: ModelEntry[] = [];
    for (const r of rows) {
      if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 120) continue;
      const params = Array.isArray(r.supported_parameters) ? r.supported_parameters : null;
      out.push({
        id: r.id,
        ...(params
          ? { reasoning: params.includes('reasoning') || params.includes('reasoning_effort') }
          : {}),
      });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out.length > 0 ? out.slice(0, 2000) : null;
  } catch {
    return null;
  }
}
