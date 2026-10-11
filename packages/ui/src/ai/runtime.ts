// Framework-free glue between @ai (pure) and @storage (persistence). Nothing here runs on import and
// nothing is sent unless a function below is called from a user action with the feature flag on.
import {
  AiError,
  AiRequestPreview,
  buildPreview,
  checkBudget,
  createAnthropicProvider,
  createConsentToken,
  createCoordinator,
  createOpenAICompatibleProvider,
  emptyBudget,
  isAiError,
  rollover,
  runTask,
  scrubSecrets,
  systemClock,
  type AiCoordinator,
  type AiProvider,
  type AiSelection,
  type AiTaskKind,
  type BudgetState,
  type FetchLike,
  type LogEvent,
  type PipelineDeps,
  type RedactionEdits,
  type SystemClock,
} from '@ai';
import {
  addAiSpend,
  checkAiEndpoint,
  createAiCache,
  getAiApiKey,
  getAiBudget,
  getAiKeyInfo,
  getAiSettings,
  saveAiResult,
  type AiEndpointCheck,
  type AiSettings,
  type StoredAiResult,
} from '@storage';

export interface AiEnv {
  /** The only network primitive. Wrapped so it can reach nothing but the configured origin. */
  fetch: FetchLike;
  clock: SystemClock;
  coordinator: AiCoordinator;
  online(): boolean;
  /** Provider deadline per attempt in ms; the engine's default (60 s) when absent. */
  timeoutMs?: number;
  /** Test seam: replaces the HTTP adapters. Endpoint, key and consent rules all still apply. */
  createProvider?(cfg: {
    settings: AiSettings;
    apiKey: string | null;
    fetch: FetchLike;
  }): AiProvider;
}

let shared: AiEnv | null = null;

/** Production wiring: global fetch (extension pages are governed by the connect-src of ADR-009). */
export function defaultAiEnv(): AiEnv {
  shared ??= {
    fetch: (input, init) => globalThis.fetch(input, init),
    clock: systemClock(),
    coordinator: createCoordinator(2),
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  };
  return shared;
}

export type KeyState = 'present' | 'missing' | 'not_needed' | 'other_origin';

export interface AiConfig {
  /** Mirrors Settings.features.ai. Off => nothing can be previewed, sent or tested. */
  flagOn: boolean;
  settings: AiSettings;
  endpoint: AiEndpointCheck;
  key: { state: KeyState; mask: string | null; origin: string | null };
  /** Null while the feature is off or the settings are incomplete; `problem` says why. */
  provider: AiProvider | null;
  problem: string | null;
  budget: BudgetState;
}

// The key is held here, not on the config object: a config can be logged or serialised by a caller.
const secretsOf = new WeakMap<AiConfig, string[]>();
const secretsFor = (config: AiConfig): string[] => secretsOf.get(config) ?? [];

/** Exact strings that must never reach the screen or a log (the stored API key). */
export const configSecrets = secretsFor;

function guard(origin: string, inner: FetchLike): FetchLike {
  return (input, init) => {
    let target = '';
    try {
      target = new URL(input).origin;
    } catch {
      /* falls through to the refusal */
    }
    if (target !== origin)
      return Promise.reject(new TypeError('Blocked: not the configured address'));
    return inner(input, init);
  };
}

function httpProvider(
  settings: AiSettings,
  endpoint: Extract<AiEndpointCheck, { ok: true }>,
  apiKey: string | null,
  fetch: FetchLike,
): AiProvider {
  if (settings.provider === 'anthropic') {
    return createAnthropicProvider({
      apiKey: apiKey ?? '',
      model: settings.model,
      fetch,
      baseUrl: endpoint.url,
    });
  }
  return createOpenAICompatibleProvider({
    baseUrl: endpoint.url,
    ...(apiKey ? { apiKey } : {}),
    model: settings.model,
    fetch,
    jsonMode: settings.jsonMode,
    maxTokensParam: settings.maxTokensParam,
  });
}

export async function loadAiConfig(
  flagOn: boolean,
  env: AiEnv = defaultAiEnv(),
): Promise<AiConfig> {
  const settings = await getAiSettings();
  const keyInfo = await getAiKeyInfo();
  const budget = await getAiBudget(env.clock.now());
  const endpoint = checkAiEndpoint(settings.provider, settings.baseUrl);
  const apiKey = endpoint.ok ? await getAiApiKey(endpoint.origin) : null;
  const needsKey = settings.provider === 'anthropic' || !(endpoint.ok && endpoint.loopback);
  const state: KeyState = apiKey
    ? 'present'
    : keyInfo.present && endpoint.ok
      ? 'other_origin'
      : needsKey
        ? 'missing'
        : 'not_needed';

  let provider: AiProvider | null = null;
  let problem: string | null = null;
  if (!flagOn) problem = 'AI features are turned off.';
  else if (!endpoint.ok) problem = endpoint.reason;
  else if (!settings.model) problem = 'Enter the model id in the AI settings.';
  else {
    const fetch = guard(endpoint.origin, env.fetch);
    provider = env.createProvider
      ? env.createProvider({ settings, apiKey, fetch })
      : httpProvider(settings, endpoint, apiKey, fetch);
  }

  const config: AiConfig = {
    flagOn,
    settings,
    endpoint,
    key: {
      state,
      mask: keyInfo.last4 ? `••••••••${keyInfo.last4}` : null,
      origin: keyInfo.origin,
    },
    provider,
    problem,
    budget,
  };
  if (apiKey) secretsOf.set(config, [apiKey]);
  return config;
}

/** Why a request cannot be sent right now (null = it can). Shown as the reason a button is disabled. */
export function sendBlocker(config: AiConfig, env: AiEnv): string | null {
  if (!config.flagOn) return 'AI features are turned off in the AI settings.';
  if (config.problem) return config.problem;
  if (config.key.state === 'missing') return 'Add your API key in the AI settings first.';
  if (config.key.state === 'other_origin') {
    return 'The saved API key belongs to another address. Enter the key again in the AI settings.';
  }
  if (config.endpoint.ok && !config.endpoint.loopback && !env.online()) {
    return 'You are offline. AI needs a connection (a model on this computer works offline).';
  }
  return null;
}

export async function previewAiTask(
  config: AiConfig,
  env: AiEnv,
  kind: AiTaskKind,
  selection: AiSelection,
  edits?: RedactionEdits,
): Promise<AiRequestPreview> {
  if (!config.flagOn) throw new AiError('disabled');
  if (!config.provider) throw new Error(config.problem ?? 'AI is not set up.');
  return buildPreview(
    kind,
    selection,
    { provider: config.provider, sha256: env.clock.sha256, pricing: config.settings.pricing },
    edits,
  );
}

export interface AiRunArgs {
  kind: AiTaskKind;
  selection: AiSelection;
  /** What the user reviewed. The consent token is bound to exactly this. */
  preview: AiRequestPreview;
  edits?: RedactionEdits;
  signal?: AbortSignal;
  onProgress?(event: LogEvent): void;
}

export interface AiRunDone {
  saved: StoredAiResult;
  cacheHit: boolean;
  coalesced: boolean;
  /** Provider calls this run made (0 = nothing was sent). */
  attempts: number;
  budget: BudgetState;
}

/** Add the difference between two ledger states (same UTC day) to the stored ledger. */
async function persistSpend(before: BudgetState, after: BudgetState, nowMs: number) {
  const base = after.day === before.day ? before : emptyBudget(nowMs);
  const delta = {
    requests: after.requests - base.requests,
    costUsd: Math.max(0, after.costUsd - base.costUsd),
    inputTokens: after.inputTokens - base.inputTokens,
    outputTokens: after.outputTokens - base.outputTokens,
  };
  if (delta.requests === 0 && delta.inputTokens === 0 && delta.outputTokens === 0) return after;
  return addAiSpend(delta, nowMs);
}

/** Never lets the key leave through an unexpected error type. */
function clean(err: unknown, secrets: readonly string[]): unknown {
  if (isAiError(err)) return err;
  const message = err instanceof Error ? err.message : 'Something went wrong.';
  return new Error(scrubSecrets(message, secrets));
}

/**
 * The only place a consent token is created, and it is called only from the confirm click. Without
 * a previewed request there is nothing to bind the token to, so nothing can be sent.
 */
export async function runAiTask(config: AiConfig, env: AiEnv, args: AiRunArgs): Promise<AiRunDone> {
  const secrets = secretsFor(config);
  try {
    if (!config.flagOn || !config.provider) throw new AiError('disabled');
    if (config.key.state === 'missing' || config.key.state === 'other_origin') {
      throw new AiError('missing_key');
    }
    if (!AiRequestPreview.safeParse(args.preview).success) throw new AiError('consent_required');
    const consent = createConsentToken(args.preview, env.clock);
    const nowMs = env.clock.now();
    const before = rollover(await getAiBudget(nowMs), nowMs);
    const deps: PipelineDeps = {
      enabled: config.flagOn,
      provider: config.provider,
      ...env.clock,
      cache: createAiCache(),
      coordinator: env.coordinator,
      pricing: config.settings.pricing,
      secrets,
      ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
      ...(args.onProgress ? { log: args.onProgress } : {}),
    };
    let outcome;
    try {
      outcome = await runTask(args.kind, args.selection, deps, {
        consent,
        ...(args.edits ? { edits: args.edits } : {}),
        budget: { state: before, limits: config.settings.limits },
        ...(args.signal ? { signal: args.signal } : {}),
      });
    } catch (e) {
      // Provider calls are counted even when the run failed.
      if (isAiError(e) && e.budgetAfter) {
        // Best effort: a ledger write failure must not hide why the request failed.
        await persistSpend(before, e.budgetAfter, nowMs).catch(() => undefined);
      }
      throw e;
    }
    const budget = outcome.budget ? await persistSpend(before, outcome.budget, nowMs) : before;
    const saved = await saveAiResult(outcome.result, {
      ...(args.selection.question ? { question: args.selection.question } : {}),
    });
    return {
      saved,
      cacheHit: outcome.cacheHit,
      coalesced: outcome.coalesced,
      attempts: outcome.attempts,
      budget,
    };
  } catch (e) {
    throw clean(e, secrets);
  }
}

export type AiConnectionTest =
  | { ok: true; reply: string; latencyMs: number; inputTokens: number; outputTokens: number }
  | { ok: false; error: unknown };

const TEST_TIMEOUT_MS = 20_000;

/**
 * One minimal request with a fixed message that contains no study content. Counted in the ledger
 * and subject to the daily limits, like any other request. Returns the real result or error.
 */
export async function testAiConnection(
  config: AiConfig,
  env: AiEnv,
  signal?: AbortSignal,
): Promise<AiConnectionTest> {
  const secrets = secretsFor(config);
  const timer = new AbortController();
  const stop = setTimeout(() => timer.abort(), TEST_TIMEOUT_MS);
  const onAbort = () => timer.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (!config.flagOn || !config.provider) throw new AiError('disabled');
    if (config.key.state === 'missing' || config.key.state === 'other_origin') {
      throw new AiError('missing_key');
    }
    const nowMs = env.clock.now();
    const before = rollover(await getAiBudget(nowMs), nowMs);
    const { pricing, limits } = config.settings;
    const estimate = pricing
      ? (40 * pricing.inputUsdPerMTok + 16 * pricing.outputUsdPerMTok) / 1e6
      : null;
    const decision = checkBudget(before, limits, nowMs, {
      requests: 1,
      estimatedCostUsd: estimate,
    });
    if (!decision.ok) throw new AiError('budget_exceeded', { detail: decision.reason });
    const started = env.clock.now();
    let completion;
    try {
      completion = await config.provider.complete(
        {
          messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
          maxOutputTokens: 16,
          json: false,
        },
        { signal: timer.signal },
      );
    } catch (e) {
      await addAiSpend({ requests: 1, costUsd: 0, inputTokens: 0, outputTokens: 0 }, nowMs);
      if (timer.signal.aborted && !signal?.aborted) throw new AiError('timeout');
      throw e;
    }
    const usage = completion.usage;
    const cost = pricing
      ? (usage.inputTokens * pricing.inputUsdPerMTok +
          usage.outputTokens * pricing.outputUsdPerMTok) /
        1e6
      : 0;
    await addAiSpend(
      {
        requests: 1,
        costUsd: cost,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      nowMs,
    );
    const text = completion.text ?? JSON.stringify(completion.json ?? null);
    return {
      ok: true,
      reply: scrubSecrets(text, secrets).slice(0, 200),
      latencyMs: Math.max(0, env.clock.now() - started),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  } catch (e) {
    return { ok: false, error: clean(e, secrets) };
  } finally {
    clearTimeout(stop);
    signal?.removeEventListener('abort', onAbort);
  }
}
