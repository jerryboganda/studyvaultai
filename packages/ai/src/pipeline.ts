// runTask: consent gate -> cache -> single flight -> budget -> provider (timeout/retry) -> strict JSON
// validation (+ one repair) -> deterministic grounding -> sanitising -> AiResult. Pure apart from the
// injected deps. No partial acceptance: any failure is a typed AiError and nothing is cached.
import { checkBudget, recordSpend, rollover } from './budget';
import type { BudgetLimits, BudgetState } from './budget';
import {
  CONSENT_TTL_MS,
  CLINICAL_NOTICE,
  DEFAULT_TIMEOUT_MS,
  FACT_CHECK_SCOPE_NOTICE,
  MAX_RETRY_WAIT_MS,
  MNEMONIC_NOTICE,
  TEMPLATE_VERSION,
  UNSUPPORTED_NOTICE,
  UNVERIFIED_NOTICE,
} from './constants';
import { chainOf, createCoordinator } from './deps';
import type { ChainTarget, PipelineDeps, Pricing } from './deps';
import { AiError, isAiError } from './errors';
import type { AiErrorCode } from './errors';
import { citationsFrom, groundClaims, pairKey } from './grounding';
import { repairMessages } from './prompt';
import type { Message } from './prompt';
import type { AiCompletion, AiProvider } from './providers';
import { prepare } from './prepare';
import type { Prepared } from './prepare';
import type { RedactionEdits } from './redact';
import { scrubSecrets } from './secrets';
import { AiResult, ConsentToken, OUTPUT_SCHEMAS } from './schema';
import type { AiSelection, AiTaskKind, Usage } from './schema';
import { collapseWhitespace, estimateTokens, toPlainText } from './text';

export interface RunOptions {
  /** Created from the preview the user approved. Without it nothing is sent. */
  consent: ConsentToken | undefined;
  /** The same redaction edits that were used for the preview. */
  edits?: RedactionEdits;
  budget?: { state: BudgetState; limits: BudgetLimits };
  signal?: AbortSignal;
}

export interface RunOutcome {
  result: AiResult;
  /** Budget after this call (the input state unchanged on cache hits / coalesced calls); null if none given. */
  budget: BudgetState | null;
  cacheHit: boolean;
  /** Joined an identical in-flight request instead of calling the provider. */
  coalesced: boolean;
  /** Provider calls made by this run (0 for cache hits). */
  attempts: number;
}

// ---------------------------------------------------------------------------------------------

const SKIP_KEYS = new Set([
  'quoteId',
  'sourceQuoteId',
  'claimId',
  'claim',
  'keyChoiceId',
  'id',
  'type',
  'label',
  'answerState',
]);

/** Free-text output fields become inert plain text; verbatim-grounded quotes and identifiers are kept. */
function sanitizeOutput(value: unknown, keep: ReadonlySet<string>, path = ''): unknown {
  if (typeof value === 'string') {
    return keep.has(path) ? value : scrubSecrets(toPlainText(value));
  }
  if (Array.isArray(value)) return value.map((v, i) => sanitizeOutput(v, keep, `${path}/${i}`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        typeof v === 'string' && SKIP_KEYS.has(k) ? v : sanitizeOutput(v, keep, `${path}/${k}`),
      ]),
    );
  }
  return value;
}

type Parsed = { ok: true; value: unknown } | { ok: false; issues: string[] };

const MAX_REPLY_CHARS = 200_000;

/** Whole-reply JSON only: no "find the first {...}" heuristics, so smuggled JSON in prose is not picked up. */
function parseReply(c: AiCompletion): Parsed {
  if (c.json !== undefined) return { ok: true, value: c.json };
  let t = (c.text ?? '').trim();
  if (t.length > MAX_REPLY_CHARS) return { ok: false, issues: ['reply is too long'] };
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence?.[1] !== undefined) t = fence[1].trim();
  try {
    const v: unknown = JSON.parse(t);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, issues: ['the reply must be one JSON object'] };
    }
    return { ok: true, value: v };
  } catch {
    return { ok: false, issues: ['the reply is not a single valid JSON document'] };
  }
}

function validateModel(
  p: Prepared,
  value: unknown,
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const r = p.task.modelSchema.safeParse(value);
  if (!r.success) {
    return {
      ok: false,
      issues: r.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const issues = p.task.semanticIssues(r.data, p.ctx);
  return issues.length ? { ok: false, issues } : { ok: true, data: r.data };
}

// ---------------------------------------------------------------------------------------------
// Provider call: timeout, abort, retry with exponential backoff + jitter, Retry-After
// ---------------------------------------------------------------------------------------------

function toAiError(e: unknown, deps: PipelineDeps): AiError {
  if (isAiError(e)) return e;
  if (e instanceof Error && e.name === 'AbortError') return new AiError('aborted');
  const msg = e instanceof Error ? e.message : '';
  return new AiError('network', {
    detail: scrubSecrets(msg, deps.secrets).replace(/\s+/g, ' ').slice(0, 80) || 'unknown error',
  });
}

async function attempt(
  deps: PipelineDeps,
  provider: AiProvider,
  messages: readonly Message[],
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
): Promise<AiCompletion> {
  if (signal?.aborted) throw new AiError('aborted');
  const call = new AbortController();
  const stop = new AbortController();
  const onAbort = () => call.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const deadline = deps.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, stop.signal).then(
    () => {
      timedOut = true;
      call.abort();
      throw new AiError('timeout');
    },
    () => new Promise<never>(() => {}),
  );
  try {
    return await Promise.race([
      provider.complete(
        { messages, maxOutputTokens, json: true },
        { signal: call.signal, ...(deps.onDelta ? { onDelta: deps.onDelta } : {}) },
      ),
      deadline,
    ]);
  } catch (e) {
    if (timedOut) throw new AiError('timeout');
    if (signal?.aborted) throw new AiError('aborted');
    throw toAiError(e, deps);
  } finally {
    stop.abort();
    signal?.removeEventListener('abort', onAbort);
  }
}

interface Tally {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens by position in the chain, so each provider's own price list prices its own attempts. */
  by: { inputTokens: number; outputTokens: number }[];
}

/** Failures that say "this endpoint is not answering": the only ones another provider may take over. */
const FALLBACK_CODES: ReadonlySet<AiErrorCode> = new Set(['network', 'server_error', 'timeout']);

/** True for the failure classes another provider may take over (never auth, quota, rate limit, refusal). */
export const failsOver = (code: AiErrorCode): boolean => FALLBACK_CODES.has(code);

/** Attempts a provider gets before the next one is used, when there is a next one. */
const ATTEMPTS_BEFORE_FALLBACK = 2;

/** The providers of one run. `at` is the one that answered last; the repair call continues from it. */
interface Chain {
  targets: readonly ChainTarget[];
  at: number;
  /** Called before another provider is tried: an error when the budget has no room for one more request. */
  gate?: () => AiError | null;
}

async function callProvider(
  deps: PipelineDeps,
  chain: Chain,
  messages: readonly Message[],
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
  tally: Tally,
): Promise<AiCompletion> {
  const index = chain.at;
  const provider = chain.targets[index]!.provider;
  const r = deps.retry ?? {};
  const configured = r.maxAttempts ?? 3;
  const maxAttempts =
    index < chain.targets.length - 1 ? Math.min(configured, ATTEMPTS_BEFORE_FALLBACK) : configured;
  const base = r.baseDelayMs ?? 500;
  const cap = r.maxDelayMs ?? 8_000;
  const maxWait = r.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS;
  for (let n = 1; ; n++) {
    tally.requests++;
    try {
      const c = await attempt(deps, provider, messages, maxOutputTokens, signal);
      // Providers that omit usage must not make the budget look free: fall back to a size estimate.
      const sentChars = messages.reduce((n, m) => n + m.content.length, 0);
      const replyChars = c.text?.length ?? JSON.stringify(c.json ?? null).length;
      const inputTokens = c.usage.inputTokens || estimateTokens(sentChars);
      const outputTokens = c.usage.outputTokens || estimateTokens(replyChars);
      tally.inputTokens += inputTokens;
      tally.outputTokens += outputTokens;
      const by = (tally.by[index] ??= { inputTokens: 0, outputTokens: 0 });
      by.inputTokens += inputTokens;
      by.outputTokens += outputTokens;
      return c;
    } catch (e) {
      const err = toAiError(e, deps);
      if (!err.retryable || n >= maxAttempts) throw err;
      // Retry-After wins over our own backoff; a wait longer than the cap fails fast so the UI can say when.
      if (err.retryAfterMs !== undefined && err.retryAfterMs > maxWait) throw err;
      const backoff = Math.min(cap, base * 2 ** (n - 1));
      const wait = err.retryAfterMs ?? Math.round(backoff / 2 + (deps.random() * backoff) / 2);
      deps.log?.({ event: 'retry', detail: `${err.code} attempt ${n} wait ${wait}ms` });
      try {
        await deps.sleep(wait, signal);
      } catch {
        throw new AiError('aborted');
      }
      if (signal?.aborted) throw new AiError('aborted');
    }
  }
}

/**
 * One call with the configured retry policy, moving to the next provider of the chain only when the
 * current one is not answering (network, 5xx, timeout) after its attempts. Every attempt on every
 * provider is counted in `tally`; each provider sees exactly the previewed messages.
 */
async function callWithRetry(
  deps: PipelineDeps,
  chain: Chain,
  messages: readonly Message[],
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
  tally: Tally,
): Promise<AiCompletion> {
  const first = chain.at;
  for (;;) {
    try {
      return await callProvider(deps, chain, messages, maxOutputTokens, signal, tally);
    } catch (e) {
      const err = toAiError(e, deps);
      const last = chain.at >= chain.targets.length - 1;
      if (last || !FALLBACK_CODES.has(err.code)) {
        const tried = chain.at - first + 1;
        if (tried < 2) throw err;
        throw new AiError(err.code, {
          ...(err.status !== undefined ? { status: err.status } : {}),
          ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
          detail: `${err.detail ? `${err.detail}; ` : ''}tried ${tried} providers`,
          ...(err.issues !== undefined ? { issues: err.issues } : {}),
        });
      }
      const stop = chain.gate?.();
      if (stop) throw stop;
      chain.at++;
      deps.log?.({
        event: 'fallback',
        detail: `${err.code}, trying ${chain.targets[chain.at]!.provider.id}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------

const priceOf = (p: Pricing, inputTokens: number, outputTokens: number) =>
  (inputTokens * p.inputUsdPerMTok + outputTokens * p.outputUsdPerMTok) / 1_000_000;

/**
 * What the attempts cost by each provider's own price list. `known` is false as soon as a provider of
 * the chain has none (the ledger still gets the part that is known, like before).
 */
function costOf(targets: readonly ChainTarget[], tally: Tally): { usd: number; known: boolean } {
  let usd = 0;
  targets.forEach((t, i) => {
    const by = tally.by[i];
    if (t.pricing && by) usd += priceOf(t.pricing, by.inputTokens, by.outputTokens);
  });
  return { usd, known: targets.every((t) => t.pricing !== null) };
}

async function fingerprintOf(p: Prepared, deps: PipelineDeps): Promise<string> {
  return deps.sha256(
    JSON.stringify({
      t: TEMPLATE_VERSION,
      m: deps.provider.model,
      k: p.kind,
      i: p.messages.map((m) => collapseWhitespace(m.content)),
      // Also covers requests that need no provider call (empty messages).
      c: p.preview.chunks.map((c) => [c.id, collapseWhitespace(c.sentText)]),
    }),
  );
}

function buildResult(
  p: Prepared,
  deps: PipelineDeps,
  consent: ConsentToken,
  fingerprint: string,
  modelData: unknown,
  usage: Usage,
  /** The provider that answered: with fallbacks it is not always the one consent names first. */
  answered: AiProvider,
): AiResult {
  const normalized = p.task.normalize(modelData, p.ctx);
  const claims = p.task.claims(normalized, p.ctx);
  const candidateKeys =
    p.kind === 'contradictions'
      ? new Set(p.ctx.candidates.map(([a, b]) => pairKey(a, b)))
      : undefined;
  const grounding = groundClaims(claims, p.chunkTexts, candidateKeys);
  const finalized = p.task.finalize(normalized, grounding, p.ctx);
  const keep = new Set(grounding.claims.filter((c) => c.supported).map((c) => c.path));
  const output = sanitizeOutput(finalized, keep);
  const checked = OUTPUT_SCHEMAS[p.kind].safeParse(output);
  if (!checked.success) {
    throw new AiError('invalid_output', {
      detail: 'output failed validation after cleaning',
      issues: checked.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const unsupported = grounding.unsupported > 0;
  const notices = [UNVERIFIED_NOTICE];
  if (p.ctx.clinical) notices.push(CLINICAL_NOTICE);
  if (p.kind === 'fact_check') notices.push(FACT_CHECK_SCOPE_NOTICE);
  if (p.kind === 'mnemonic') notices.push(MNEMONIC_NOTICE);
  if (unsupported) notices.push(UNSUPPORTED_NOTICE);
  const candidate = {
    id: deps.randomId(),
    kind: p.kind,
    inputSourceIds: p.ctx.chunkIds,
    inputFingerprint: fingerprint,
    provider: answered.id,
    model: answered.model,
    templateVersion: TEMPLATE_VERSION,
    output: checked.data,
    citations: citationsFrom(claims, grounding, p.chunkTexts),
    verificationState: unsupported
      ? 'unsupported'
      : p.task.conflicts(checked.data)
        ? 'conflicting'
        : 'unverified',
    usage,
    createdAt: new Date(deps.now()).toISOString(),
    acceptedByUserAt: null,
    consentRef: consent.id,
    grounding,
    notices,
  };
  const r = AiResult.safeParse(candidate);
  if (!r.success) {
    throw new AiError('internal', {
      detail: 'result failed validation',
      issues: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return r.data;
}

function verifyConsent(p: Prepared, consent: ConsentToken, deps: PipelineDeps): void {
  if (
    consent.previewHash !== p.preview.previewHash ||
    consent.kind !== p.kind ||
    consent.provider !== deps.provider.id ||
    consent.model !== deps.provider.model
  ) {
    throw new AiError('consent_mismatch');
  }
  const age = deps.now() - Date.parse(consent.createdAt);
  if (!(age <= CONSENT_TTL_MS)) throw new AiError('consent_expired');
}

async function execute(
  p: Prepared,
  deps: PipelineDeps,
  opts: RunOptions,
  consent: ConsentToken,
  fingerprint: string,
): Promise<RunOutcome> {
  const tally: Tally = { requests: 0, inputTokens: 0, outputTokens: 0, by: [] };
  const chain: Chain = { targets: chainOf(deps), at: 0 };
  let budget: BudgetState | null = null;
  if (opts.budget) {
    budget = rollover(opts.budget.state, deps.now());
    const d = checkBudget(budget, opts.budget.limits, deps.now(), {
      requests: 1,
      estimatedCostUsd: p.preview.estimate.estimatedCostUsd,
    });
    if (!d.ok) throw new AiError('budget_exceeded', { detail: d.reason, budgetAfter: budget });
  }
  const spend = (): BudgetState | undefined =>
    budget
      ? recordSpend(budget, deps.now(), { ...tally, costUsd: costOf(chain.targets, tally).usd })
      : undefined;
  // Another provider is another request: it only goes out while the daily budget has room for it.
  chain.gate = () => {
    const after = spend();
    if (!after || !opts.budget) return null;
    const d = checkBudget(after, opts.budget.limits, deps.now(), {
      requests: 1,
      estimatedCostUsd: p.preview.estimate.estimatedCostUsd,
    });
    return d.ok ? null : new AiError('budget_exceeded', { detail: d.reason });
  };
  const fail = (e: unknown): never => {
    const err = toAiError(e, deps);
    const after = spend();
    if (!after || err.budgetAfter) throw err;
    throw new AiError(err.code, {
      ...(err.status !== undefined ? { status: err.status } : {}),
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
      ...(err.issues !== undefined ? { issues: err.issues } : {}),
      budgetAfter: after,
    });
  };

  try {
    let completion = await callWithRetry(
      deps,
      chain,
      p.messages,
      p.maxOutputTokens,
      opts.signal,
      tally,
    );
    let parsed = parseReply(completion);
    let validated = parsed.ok ? validateModel(p, parsed.value) : parsed;
    if (!validated.ok) {
      // Exactly one repair attempt; the validator's issues (not the model's words) drive it.
      deps.log?.({ event: 'repair', detail: `${validated.issues.length} issue(s)` });
      const bad = completion.text ?? JSON.stringify(completion.json ?? null);
      completion = await callWithRetry(
        deps,
        chain,
        repairMessages(p.messages, bad, validated.issues),
        p.maxOutputTokens,
        opts.signal,
        tally,
      );
      parsed = parseReply(completion);
      validated = parsed.ok ? validateModel(p, parsed.value) : parsed;
      if (!validated.ok) throw new AiError('invalid_output', { issues: validated.issues });
    }
    const cost = costOf(chain.targets, tally);
    const usage: Usage = {
      inputTokens: tally.inputTokens,
      outputTokens: tally.outputTokens,
      estimatedCostUsd: cost.known ? cost.usd : null,
    };
    const answered = chain.targets[chain.at]!.provider;
    const result = buildResult(p, deps, consent, fingerprint, validated.data, usage, answered);
    try {
      await deps.cache?.put(result);
    } catch {
      deps.log?.({ event: 'cache_put_failed' });
    }
    return {
      result,
      budget: spend() ?? null,
      cacheHit: false,
      coalesced: false,
      attempts: tally.requests,
    };
  } catch (e) {
    return fail(e);
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AiError('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AiError('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Runs one AI task. Throws AiError (typed) on every failure. See RunOptions for the consent contract.
 * `selection` is validated; `deps.enabled` must be true.
 */
export async function runTask(
  kind: AiTaskKind,
  selection: AiSelection,
  deps: PipelineDeps,
  opts: RunOptions,
): Promise<RunOutcome> {
  if (!deps.enabled) throw new AiError('disabled');
  const consentParsed = ConsentToken.safeParse(opts.consent);
  if (!consentParsed.success) throw new AiError('consent_required');
  const consent = consentParsed.data;

  const p = await prepare(kind, selection, deps, opts.edits);
  verifyConsent(p, consent, deps);
  const fingerprint = await fingerprintOf(p, deps);
  const budgetIn = opts.budget?.state ?? null;
  const zeroUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: p.willSend ? null : 0,
  };

  if (!p.willSend) {
    // e.g. no contradiction candidates: the answer is computed locally and nothing is transmitted.
    const result = buildResult(
      p,
      deps,
      consent,
      fingerprint,
      p.task.empty(p.ctx),
      zeroUsage,
      deps.provider,
    );
    return { result, budget: budgetIn, cacheHit: false, coalesced: false, attempts: 0 };
  }

  if (deps.cache) {
    try {
      const hit = await deps.cache.get(fingerprint);
      const parsed = hit ? AiResult.safeParse(hit) : null;
      if (parsed?.success && parsed.data.inputFingerprint === fingerprint) {
        deps.log?.({ event: 'cache_hit' });
        return {
          result: parsed.data,
          budget: budgetIn,
          cacheHit: true,
          coalesced: false,
          attempts: 0,
        };
      }
    } catch {
      deps.log?.({ event: 'cache_get_failed' });
    }
  }

  const coord = deps.coordinator ?? createCoordinator();
  for (let round = 0; round < 3; round++) {
    const existing = coord.inflight.get(fingerprint) as Promise<RunOutcome> | undefined;
    if (!existing) break;
    try {
      const out = await raceAbort(existing, opts.signal);
      return { ...out, budget: budgetIn, coalesced: true, attempts: 0 };
    } catch (e) {
      // The leader was cancelled but we were not: take over instead of failing for someone else's abort.
      if (isAiError(e) && e.code === 'aborted' && !opts.signal?.aborted) continue;
      throw e;
    }
  }

  const work = (async () => {
    const release = await coord.acquire(opts.signal);
    try {
      return await execute(p, deps, opts, consent, fingerprint);
    } finally {
      release();
    }
  })();
  coord.inflight.set(fingerprint, work);
  try {
    return await work;
  } finally {
    if (coord.inflight.get(fingerprint) === work) coord.inflight.delete(fingerprint);
  }
}

/**
 * The user accepts a result. Only a result whose citations all grounded becomes `source_supported`;
 * an `unsupported` result cannot be accepted (edit or regenerate it instead).
 */
export function acceptResult(result: AiResult, nowMs: number): AiResult {
  if (result.verificationState === 'unsupported') throw new AiError('not_acceptable');
  if (result.acceptedByUserAt) return result;
  const grounded = result.grounding.checked > 0 && result.grounding.unsupported === 0;
  return {
    ...result,
    acceptedByUserAt: new Date(nowMs).toISOString(),
    verificationState:
      result.verificationState === 'unverified' && grounded
        ? 'source_supported'
        : result.verificationState,
  };
}
