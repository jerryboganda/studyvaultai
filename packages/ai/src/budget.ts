// Per-day request/cost budget as pure state in / state out. The caller persists the state (e.g. in
// chrome.storage.local or the Dexie `meta` table); nothing here touches storage or the clock itself.
import './zodConfig';
import { z } from 'zod';

export const BudgetLimits = z.strictObject({
  maxRequestsPerDay: z.number().int().min(0),
  /** Null = no cost cap. A cap needs pricing, otherwise runs are refused (an unenforceable cap is a lie). */
  maxCostUsdPerDay: z.number().min(0).nullable(),
});
export type BudgetLimits = z.infer<typeof BudgetLimits>;

export const BudgetState = z.strictObject({
  /** UTC day `YYYY-MM-DD` this state counts. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requests: z.number().int().min(0),
  costUsd: z.number().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type BudgetState = z.infer<typeof BudgetState>;

export const dayKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function emptyBudget(nowMs: number): BudgetState {
  return { day: dayKey(nowMs), requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
}

/** The same state, or a fresh one when the UTC day changed. */
export function rollover(state: BudgetState, nowMs: number): BudgetState {
  return state.day === dayKey(nowMs) ? state : emptyBudget(nowMs);
}

export type BudgetDecision =
  { ok: true } | { ok: false; reason: 'requests' | 'cost' | 'cost_unknown' };

export function checkBudget(
  state: BudgetState,
  limits: BudgetLimits,
  nowMs: number,
  need: { requests: number; estimatedCostUsd: number | null },
): BudgetDecision {
  const s = rollover(state, nowMs);
  if (s.requests + need.requests > limits.maxRequestsPerDay)
    return { ok: false, reason: 'requests' };
  if (limits.maxCostUsdPerDay !== null) {
    if (need.estimatedCostUsd === null) return { ok: false, reason: 'cost_unknown' };
    if (s.costUsd + need.estimatedCostUsd > limits.maxCostUsdPerDay)
      return { ok: false, reason: 'cost' };
  }
  return { ok: true };
}

export function recordSpend(
  state: BudgetState,
  nowMs: number,
  spend: { requests: number; costUsd: number | null; inputTokens: number; outputTokens: number },
): BudgetState {
  const s = rollover(state, nowMs);
  return {
    day: s.day,
    requests: s.requests + spend.requests,
    costUsd: s.costUsd + (spend.costUsd ?? 0),
    inputTokens: s.inputTokens + spend.inputTokens,
    outputTokens: s.outputTokens + spend.outputTokens,
  };
}
