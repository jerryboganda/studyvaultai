/** Bump whenever a prompt, output schema or grounding rule changes: it is part of the cache key. */
export const TEMPLATE_VERSION = 'sv-ai/2026-10-11.1';

export const AI_TASK_KINDS = [
  'exam_pearl',
  'summary',
  'structured_notes',
  'flashcards',
  'mcq',
  'explain',
  'compare_topics',
  'contradictions',
  'fact_check',
] as const;

/** Fixed notice attached to every result whose input looks clinical (SECURITY_PRIVACY: AI). */
export const CLINICAL_NOTICE = 'Study aid - verify against authoritative references';
export const UNVERIFIED_NOTICE =
  'AI-generated and unverified. Citations were only checked for verbatim presence in your selected sources.';
export const UNSUPPORTED_NOTICE =
  'Some citations were not found verbatim in the cited source and are marked unsupported. Do not rely on them.';
export const FACT_CHECK_SCOPE_NOTICE =
  'Checked only against your selected sources. No external verification was performed; "externally_verified" is never produced here.';

export const DEFAULT_LIMITS = {
  /** A single captured passage is cut here (visibly: the preview shows the truncated text). */
  maxChunkChars: 8_000,
  /** Estimated input tokens above this refuse the task instead of silently cutting more. */
  maxInputTokens: 10_000,
  /** Hard cap on chunks per request. */
  maxChunks: 50,
  /** Per-task output token cap defaults (see tasks.ts); this is the global ceiling. */
  maxOutputTokens: 2_500,
  /** Candidate pairs the contradiction task will ask the model to judge. */
  maxCandidatePairs: 30,
} as const;

export const CONSENT_TTL_MS = 10 * 60_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_RETRY_WAIT_MS = 20_000;
/** Rough tokens estimate: deliberately pessimistic (chars / 3) so budgets fail safe. */
export const CHARS_PER_TOKEN = 3;
