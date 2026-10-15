// Framework-free glue between @ai (pure) and @storage (persistence). Nothing here runs on import and
// nothing is sent unless a function below is called from a user action with the feature flag on.
import {
  AiError,
  AiRequestPreview,
  buildPreview,
  checkBudget,
  createAnthropicProvider,
  createCodexResponsesProvider,
  createConsentToken,
  createCoordinator,
  createOpenAICompatibleProvider,
  emptyBudget,
  isAiError,
  refreshCodexTokens,
  rollover,
  runTask,
  scrubSecrets,
  systemClock,
  type AiCoordinator,
  type AiProvider,
  type AiSelection,
  type AiTaskKind,
  type BudgetState,
  type FallbackTarget,
  type FetchLike,
  type LogEvent,
  type PipelineDeps,
  type RedactionEdits,
  type SystemClock,
} from '@ai';
import { VENDORS, providerNeedsKey } from './vendors';
import {
  PRIMARY_PROFILE_ID,
  addAiSpend,
  checkAiEndpoint,
  createAiCache,
  getAiApiKey,
  getAiBudget,
  getAiKeyInfo,
  getAiProfileApiKey,
  getAiProfileKeyInfos,
  getAiSettings,
  getCodexAuth,
  saveAiResult,
  setCodexAuth,
  type AiEndpointCheck,
  type AiKeyInfo,
  type AiProfileSettings,
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
  /**
   * Test seam: replaces the HTTP adapters. Endpoint, key and consent rules all still apply.
   * `settings` is the provider's own address, model and options (merged over the primary settings
   * for a fallback), `profileId` says which provider it is.
   */
  createProvider?(cfg: {
    settings: AiSettings;
    apiKey: string | null;
    fetch: FetchLike;
    profileId: string;
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

/** One provider as configured: the primary one (`id` 'primary') or a fallback. */
export interface AiProfileConfig {
  id: string;
  label: string;
  /** May be used when an earlier provider is not answering. The primary provider always may. */
  fallback: boolean;
  settings: AiProfileSettings;
  endpoint: AiEndpointCheck;
  key: { state: KeyState; mask: string | null; origin: string | null };
  /** Null while the feature is off or this provider's settings are incomplete; `problem` says why. */
  provider: AiProvider | null;
  problem: string | null;
}

export interface AiConfig {
  /** Mirrors Settings.features.ai. Off => nothing can be previewed, sent or tested. */
  flagOn: boolean;
  settings: AiSettings;
  /** The primary provider's endpoint, key and provider (the same data as `profiles[0]`). */
  endpoint: AiEndpointCheck;
  key: { state: KeyState; mask: string | null; origin: string | null };
  /** Null while the feature is off or the settings are incomplete; `problem` says why. */
  provider: AiProvider | null;
  problem: string | null;
  budget: BudgetState;
  /** The primary provider first, then the fallbacks in the order they are tried. */
  profiles: AiProfileConfig[];
}

// The keys are held here, not on the config object: a config can be logged or serialised by a caller.
const secretsOf = new WeakMap<AiConfig, string[]>();
const secretsFor = (config: AiConfig): string[] => secretsOf.get(config) ?? [];

/** Exact strings that must never reach the screen or a log (every stored API key). */
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

/** UBAG drives a real browser: a request can take minutes (its facade deadline is 240 s). */
const UBAG_WAIT_MS = 240_000;
// 240 s per wait, and the same request is joined up to three more times (16 minutes in all).
const SLOW_TIMEOUT_MS = 17 * 60_000;
const timeoutFor = (settings: AiProfileSettings): number | null =>
  settings.vendor === 'ubag'
    ? SLOW_TIMEOUT_MS
    : settings.vendor === 'chatgpt_codex'
      ? 120_000
      : null;

function httpProvider(
  settings: AiProfileSettings,
  endpoint: Extract<AiEndpointCheck, { ok: true }>,
  apiKey: string | null,
  fetch: FetchLike,
  accountId: string | null,
): AiProvider {
  if (settings.provider === 'codex_responses') {
    return createCodexResponsesProvider({
      accessToken: apiKey ?? '',
      accountId: accountId ?? '',
      model: settings.model,
      fetch,
      baseUrl: endpoint.url,
      reasoningEffort: settings.reasoningEffort,
    });
  }
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
    authScheme: settings.authScheme,
    reasoningEffort: settings.reasoningEffort,
    reasoningStyle: VENDORS[settings.vendor].reasoningStyle,
    ...(settings.vendor === 'ubag' ? { waitMs: UBAG_WAIT_MS, streaming: false } : {}),
  });
}

/** The saved Codex login, refreshed when it is about to expire. Null = not signed in. */
async function codexLogin(
  env: AiEnv,
): Promise<{ accessToken: string; accountId: string; last4: string } | null> {
  const auth = await getCodexAuth();
  if (!auth) return null;
  const nowMs = env.clock.now();
  if (auth.expiresAt - nowMs > 60_000) {
    return { ...auth, last4: auth.accessToken.slice(-4) };
  }
  try {
    // auth.openai.com is not the configured chatgpt.com origin, so this call uses the raw fetch.
    const next = await refreshCodexTokens(env.fetch, auth, nowMs);
    await setCodexAuth(next);
    return { ...next, last4: next.accessToken.slice(-4) };
  } catch {
    // Offline or refused: keep the stored token; the request itself reports the real error.
    return auth.expiresAt > nowMs ? { ...auth, last4: auth.accessToken.slice(-4) } : null;
  }
}

interface ProfileInput {
  id: string;
  label: string;
  fallback: boolean;
  settings: AiProfileSettings;
  keyInfo: AiKeyInfo;
  readKey(origin: string): Promise<string | null>;
}

async function buildProfile(
  input: ProfileInput,
  base: AiSettings,
  flagOn: boolean,
  env: AiEnv,
  secrets: string[],
): Promise<AiProfileConfig> {
  const { settings } = input;
  let { keyInfo } = input;
  const endpoint = checkAiEndpoint(settings.provider, settings.baseUrl);
  let apiKey: string | null = null;
  let accountId: string | null = null;
  if (settings.provider === 'codex_responses') {
    const login = await codexLogin(env);
    if (login) {
      apiKey = login.accessToken;
      accountId = login.accountId;
      keyInfo = {
        present: true,
        origin: endpoint.ok ? endpoint.origin : null,
        last4: login.last4,
      };
    }
  } else {
    apiKey = endpoint.ok ? await input.readKey(endpoint.origin) : null;
  }
  if (apiKey) secrets.push(apiKey);
  const needsKey = providerNeedsKey(settings.provider, endpoint.ok && endpoint.loopback);
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
      ? env.createProvider({
          settings: { ...base, ...settings },
          apiKey,
          fetch,
          profileId: input.id,
        })
      : httpProvider(settings, endpoint, apiKey, fetch, accountId);
  }
  return {
    id: input.id,
    label: input.label,
    fallback: input.fallback,
    settings,
    endpoint,
    key: {
      state,
      mask: keyInfo.last4 ? `••••••••${keyInfo.last4}` : null,
      origin: keyInfo.origin,
    },
    provider,
    problem,
  };
}

/** Per-provider setting overrides for one request (a chat's own model or reasoning effort). */
export type AiOverrides = Record<
  string,
  Partial<Pick<AiProfileSettings, 'model' | 'reasoningEffort'>>
>;

export async function loadAiConfig(
  flagOn: boolean,
  env: AiEnv = defaultAiEnv(),
  overrides: AiOverrides = {},
): Promise<AiConfig> {
  const stored = await getAiSettings();
  const apply = <T extends AiProfileSettings>(id: string, s: T): T => {
    const o = overrides[id];
    return o
      ? {
          ...s,
          ...(o.model ? { model: o.model } : {}),
          ...(o.reasoningEffort === undefined ? {} : { reasoningEffort: o.reasoningEffort }),
        }
      : s;
  };
  const settings = {
    ...apply(PRIMARY_PROFILE_ID, stored),
    fallbacks: stored.fallbacks.map((p) => apply(p.id, p)),
  };
  const budget = await getAiBudget(env.clock.now());
  const secrets: string[] = [];
  const primary = await buildProfile(
    {
      id: PRIMARY_PROFILE_ID,
      label: 'Primary provider',
      fallback: true,
      settings,
      keyInfo: await getAiKeyInfo(),
      readKey: getAiApiKey,
    },
    settings,
    flagOn,
    env,
    secrets,
  );
  const infos = settings.fallbacks.length > 0 ? await getAiProfileKeyInfos() : {};
  const profiles = [primary];
  for (const p of settings.fallbacks) {
    profiles.push(
      await buildProfile(
        {
          id: p.id,
          label: p.label,
          fallback: p.fallback,
          settings: p,
          keyInfo: infos[p.id] ?? { present: false, origin: null, last4: null },
          readKey: (origin) => getAiProfileApiKey(p.id, origin),
        },
        settings,
        flagOn,
        env,
        secrets,
      ),
    );
  }
  const config: AiConfig = {
    flagOn,
    settings,
    endpoint: primary.endpoint,
    key: primary.key,
    provider: primary.provider,
    problem: primary.problem,
    budget,
    profiles,
  };
  if (secrets.length > 0) secretsOf.set(config, secrets);
  return config;
}

// ---------------------------------------------------------------------------------------------
// Routing: which providers one task may use, in which order
// ---------------------------------------------------------------------------------------------

const usable = (p: AiProfileConfig): boolean =>
  p.provider !== null && (p.key.state === 'present' || p.key.state === 'not_needed');

export interface AiRoute {
  /** Providers in the order they are tried. The first is the one the confirmation names first. */
  targets: AiProfileConfig[];
  /** Fallbacks that are not set up: they are left out and receive nothing. */
  skipped: AiProfileConfig[];
  /** The provider chosen for the task, whether or not it is set up. */
  first: AiProfileConfig;
}

/**
 * The route of a task kind: the provider chosen for it first (the primary one unless the settings
 * route it elsewhere), then every other provider that is set up and allowed to be a fallback, in list
 * order. Providers that are not set up are skipped, never guessed at.
 */
export function routeFor(config: AiConfig, kind: AiTaskKind, prefer?: string | null): AiRoute {
  const all = config.profiles;
  const chosen =
    (prefer ? all.find((p) => p.id === prefer) : undefined) ??
    all.find((p) => p.id === config.settings.routes[kind]) ??
    all[0]!;
  const rest = all.filter((p) => p.id !== chosen.id && p.fallback);
  // The first provider is kept whenever it exists: a missing key is then a reason to show next to
  // Send, with the preview still readable, not a missing preview.
  const targets = chosen.provider ? [chosen, ...rest.filter(usable)] : [];
  return { targets, skipped: rest.filter((p) => !usable(p)), first: chosen };
}

/** Why a request cannot be sent right now (null = it can). Shown as the reason a button is disabled. */
export function sendBlocker(
  config: AiConfig,
  env: AiEnv,
  kind?: AiTaskKind,
  prefer?: string | null,
): string | null {
  if (!config.flagOn) return 'AI features are turned off in the AI settings.';
  const p = kind ? routeFor(config, kind, prefer).first : config.profiles[0]!;
  const named = (text: string) => (p.id === PRIMARY_PROFILE_ID ? text : `${p.label}: ${text}`);
  if (p.problem) return named(p.problem);
  if (p.key.state === 'missing') {
    return p.id === PRIMARY_PROFILE_ID
      ? 'Add your API key in the AI settings first.'
      : `Add the API key of "${p.label}" in the AI settings first.`;
  }
  if (p.key.state === 'other_origin') {
    return named(
      'The saved API key belongs to another address. Enter the key again in the AI settings.',
    );
  }
  if (p.endpoint.ok && !p.endpoint.loopback && !env.online()) {
    return 'You are offline. AI needs a connection (a model on this computer works offline).';
  }
  return null;
}

/** The text the consent preview pairs with each provider: its price list, for the cost bound. */
const targetOf = (p: AiProfileConfig): FallbackTarget => ({
  provider: p.provider!,
  pricing: p.settings.pricing,
});

/** Pipeline deps for one task: the first provider and the fallbacks behind it. */
function routedDeps(config: AiConfig, kind: AiTaskKind, prefer?: string | null) {
  const route = routeFor(config, kind, prefer);
  const [first, ...rest] = route.targets;
  if (!first?.provider) return null;
  return {
    route,
    provider: first.provider,
    pricing: first.settings.pricing,
    fallbacks: rest.map(targetOf),
  };
}

export async function previewAiTask(
  config: AiConfig,
  env: AiEnv,
  kind: AiTaskKind,
  selection: AiSelection,
  edits?: RedactionEdits,
  prefer?: string | null,
): Promise<AiRequestPreview> {
  if (!config.flagOn) throw new AiError('disabled');
  const routed = routedDeps(config, kind, prefer);
  if (!routed)
    throw new Error(
      sendBlocker(config, env, kind, prefer) ?? config.problem ?? 'AI is not set up.',
    );
  return buildPreview(
    kind,
    selection,
    {
      provider: routed.provider,
      fallbacks: routed.fallbacks,
      sha256: env.clock.sha256,
      pricing: routed.pricing,
    },
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
  /** `chat` only: the conversation the answer is saved under. */
  threadId?: string;
  /** Try this provider first (a chat's own choice); the others still follow as fallbacks. */
  prefer?: string | null;
  /** Reply text so far, while a streaming provider answers (progress display only). */
  onDelta?(textSoFar: string): void;
  onProgress?(event: LogEvent): void;
}

export interface AiRunDone {
  saved: StoredAiResult;
  cacheHit: boolean;
  coalesced: boolean;
  /** Provider calls this run made (0 = nothing was sent), failed ones included. */
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

/** Never lets a key leave through an unexpected error type. */
function clean(err: unknown, secrets: readonly string[]): unknown {
  if (isAiError(err)) return err;
  const message = err instanceof Error ? err.message : 'Something went wrong.';
  return new Error(scrubSecrets(message, secrets));
}

/**
 * The only place a consent token is created, and it is called only from the confirm click. Without
 * a previewed request there is nothing to bind the token to, so nothing can be sent. The token is
 * checked against the route as it is NOW: a provider added or removed since the preview is a
 * different request and is refused (`consent_mismatch`).
 */
export async function runAiTask(config: AiConfig, env: AiEnv, args: AiRunArgs): Promise<AiRunDone> {
  const secrets = secretsFor(config);
  try {
    const routed = config.flagOn ? routedDeps(config, args.kind, args.prefer) : null;
    if (!routed) throw new AiError('disabled');
    const { first } = routed.route;
    if (first.key.state === 'missing' || first.key.state === 'other_origin') {
      throw new AiError('missing_key');
    }
    if (!AiRequestPreview.safeParse(args.preview).success) throw new AiError('consent_required');
    const consent = createConsentToken(args.preview, env.clock);
    const nowMs = env.clock.now();
    const before = rollover(await getAiBudget(nowMs), nowMs);
    const deps: PipelineDeps = {
      enabled: config.flagOn,
      provider: routed.provider,
      fallbacks: routed.fallbacks,
      ...env.clock,
      cache: createAiCache(),
      coordinator: env.coordinator,
      pricing: routed.pricing,
      secrets,
      ...(() => {
        const slowest = Math.max(
          env.timeoutMs ?? 0,
          ...[routed.route.first, ...routed.route.targets].map((t) => timeoutFor(t.settings) ?? 0),
        );
        return slowest > 0 ? { timeoutMs: slowest } : {};
      })(),
      ...(args.onProgress ? { log: args.onProgress } : {}),
      ...(args.onDelta ? { onDelta: args.onDelta } : {}),
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
      ...(args.threadId ? { threadId: args.threadId } : {}),
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
 * One minimal request with a fixed message that contains no study content, to ONE provider
 * (`profileId`, the primary one by default). Counted in the ledger and subject to the daily limits,
 * like any other request. Returns the real result or error.
 */
export async function testAiConnection(
  config: AiConfig,
  env: AiEnv,
  signal?: AbortSignal,
  profileId: string = PRIMARY_PROFILE_ID,
): Promise<AiConnectionTest> {
  const secrets = secretsFor(config);
  const timer = new AbortController();
  const stop = setTimeout(
    () => timer.abort(),
    Math.max(
      TEST_TIMEOUT_MS,
      ...config.profiles.filter((p) => p.id === profileId).map((p) => timeoutFor(p.settings) ?? 0),
    ),
  );
  const onAbort = () => timer.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const profile = config.profiles.find((p) => p.id === profileId);
    if (!config.flagOn || !profile?.provider) throw new AiError('disabled');
    if (profile.key.state === 'missing' || profile.key.state === 'other_origin') {
      throw new AiError('missing_key');
    }
    const nowMs = env.clock.now();
    const before = rollover(await getAiBudget(nowMs), nowMs);
    const { pricing } = profile.settings;
    const { limits } = config.settings;
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
      completion = await profile.provider.complete(
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
