import { isAiError, scrubSecrets, type AiTaskKind } from '@ai';
import { StudyVaultError } from '@shared';

export interface AiKindInfo {
  label: string;
  hint: string;
  /** Highlights needed before the action is offered. */
  min: number;
}

export const AI_KIND_INFO: Record<AiTaskKind, AiKindInfo> = {
  exam_pearl: {
    label: 'Exam pearl',
    hint: 'One testable fact and why it matters.',
    min: 1,
  },
  summary: { label: 'Summary', hint: 'A short summary with key points.', min: 1 },
  structured_notes: {
    label: 'Structured notes',
    hint: 'Headings and bullets, each bullet cited.',
    min: 1,
  },
  flashcards: { label: 'Flashcards', hint: 'Basic and cloze cards, each cited.', min: 1 },
  mcq: { label: 'Multiple-choice question', hint: 'One question with a proposed key.', min: 1 },
  explain: {
    label: 'Explain',
    hint: 'Answer your question using only the selected passages.',
    min: 1,
  },
  compare_topics: {
    label: 'Compare topics',
    hint: 'A table of aspects across topics. Needs two or more passages.',
    min: 2,
  },
  contradictions: {
    label: 'Find contradictions',
    hint: 'Judges pre-selected pairs of passages. Needs two or more passages.',
    min: 2,
  },
  fact_check: {
    label: 'Check statements against sources',
    hint: 'Checks statements only against the selected passages.',
    min: 1,
  },
  mnemonic: {
    label: 'Memory aids',
    hint: 'Acronyms, rhymes or images that help recall a quoted fact. An aid, not a fact.',
    min: 1,
  },
  short_viva: {
    label: 'Short viva',
    hint: 'Three to five oral-exam questions with model answers that cite your quotes.',
    min: 1,
  },
  study_outline: {
    label: 'Study outline',
    hint: 'A hierarchical outline of the selected highlights, each item cited.',
    min: 1,
  },
};

/** The actions offered in the UI, in display order. */
export const AI_ACTION_KINDS = [
  'exam_pearl',
  'summary',
  'structured_notes',
  'flashcards',
  'mcq',
  'explain',
  'compare_topics',
  'contradictions',
  'mnemonic',
  'short_viva',
  'study_outline',
] as const satisfies readonly AiTaskKind[];

export interface AiErrorView {
  code: string;
  title: string;
  /** The real cause, as the engine states it. */
  message: string;
  /** Validation issues the provider's answer failed (short, already safe). */
  details: string[];
  /** Seconds to wait when the provider said so. */
  retryAfterSec: number | null;
  /** What the person can do about it. */
  hint: string | null;
}

const TITLES: Record<string, string> = {
  disabled: 'AI features are off',
  consent_required: 'Confirmation needed',
  consent_mismatch: 'The request changed',
  consent_expired: 'The confirmation expired',
  invalid_selection: 'This selection cannot be used',
  input_too_large: 'The selection is too large',
  budget_exceeded: 'Daily AI budget reached',
  missing_key: 'No API key',
  invalid_endpoint: 'Provider address not usable',
  auth: 'The provider rejected the API key',
  quota_exhausted: 'No quota or credit left',
  rate_limited: 'Rate limited by the provider',
  timeout: 'The provider timed out',
  network: 'Could not reach the provider',
  server_error: 'The provider reported an error',
  bad_request: 'The provider rejected the request',
  refused: 'The model declined',
  output_truncated: 'The answer was cut off',
  invalid_output: 'The answer was not in the required format',
  aborted: 'Cancelled',
  not_acceptable: 'This result cannot be accepted',
  internal: 'Unexpected error',
};

const BUDGET_HINT: Record<string, string> = {
  requests: 'Raise the daily request limit in AI settings, or try again after UTC midnight.',
  cost: 'The estimate for this request would pass the daily cost limit. Raise it in AI settings or select less text.',
  cost_unknown:
    'A cost limit is set but no pricing is configured, so the cost cannot be checked. Add pricing or clear the cost limit in AI settings.',
};

const HINTS: Record<string, string> = {
  disabled: 'Turn AI features on in the AI settings.',
  consent_mismatch: 'Open the preview again and confirm it.',
  consent_expired: 'Open the preview again and confirm it.',
  input_too_large: 'Select fewer or shorter passages.',
  missing_key: 'Add your API key in the AI settings.',
  invalid_endpoint: 'Fix the address in the AI settings.',
  auth: 'Check the key in the AI settings; it may be wrong, expired or for another provider.',
  quota_exhausted: 'Add credit with your provider, or switch to another provider or a local model.',
  timeout: 'Try again, or select fewer passages.',
  network:
    'Check your connection and the provider address. For a local model, make sure the server is running.',
  server_error: 'Try again later.',
  bad_request:
    'Check the model id and the compatibility options in the AI settings. The provider’s error code is shown above when it sent one.',
  output_truncated: 'Try fewer passages or fewer cards.',
  invalid_output: 'Nothing was saved. Try again, or use a different model.',
  refused: 'Try different passages or a different model.',
  aborted: 'Nothing was saved.',
};

/**
 * Turns any thrown value into text for the screen. Messages of AiError are fixed strings plus a
 * short safe detail; anything else is scrubbed of the key before it is shown.
 */
export function describeAiError(err: unknown, secrets: readonly string[] = []): AiErrorView {
  if (isAiError(err)) {
    const retryAfterSec =
      err.retryAfterMs === undefined ? null : Math.max(1, Math.ceil(err.retryAfterMs / 1000));
    let hint = HINTS[err.code] ?? null;
    if (err.code === 'budget_exceeded') hint = BUDGET_HINT[err.detail ?? ''] ?? null;
    if (err.code === 'rate_limited') {
      hint =
        retryAfterSec === null
          ? 'Wait a moment and try again.'
          : `The provider asks you to wait ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'} before trying again.`;
    }
    if (err.code === 'network' && typeof navigator !== 'undefined' && navigator.onLine === false) {
      hint = 'You appear to be offline. Core StudyVault features keep working without AI.';
    }
    return {
      code: err.code,
      title: TITLES[err.code] ?? 'AI request failed',
      message: scrubSecrets(err.message, secrets),
      details: (err.issues ?? []).slice(0, 5).map((i) => scrubSecrets(i, secrets)),
      retryAfterSec,
      hint,
    };
  }
  const raw = err instanceof Error && err.message.trim() ? err.message : 'Something went wrong.';
  return {
    code: err instanceof StudyVaultError ? err.code : 'internal',
    title: 'AI request failed',
    message: scrubSecrets(raw, secrets),
    details: [],
    retryAfterSec: null,
    hint: null,
  };
}
