import type { BudgetState } from './budget';

/** Every failure surfaced by @ai is an AiError with a stable code. Messages are fixed strings. */
export type AiErrorCode =
  | 'disabled'
  | 'consent_required'
  | 'consent_mismatch'
  | 'consent_expired'
  | 'invalid_selection'
  | 'input_too_large'
  | 'budget_exceeded'
  | 'missing_key'
  | 'invalid_endpoint'
  | 'auth'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'bad_request'
  | 'refused'
  | 'output_truncated'
  | 'invalid_output'
  | 'aborted'
  | 'not_acceptable'
  | 'internal';

const MESSAGES: Record<AiErrorCode, string> = {
  disabled: 'AI features are turned off.',
  consent_required: 'Review the request preview and confirm before anything is sent.',
  consent_mismatch: 'The request changed after you confirmed it. Review the preview again.',
  consent_expired: 'The confirmation expired. Review the preview again.',
  invalid_selection: 'The selected content is not valid for this task.',
  input_too_large: 'The selection is too large for one request. Select fewer passages.',
  budget_exceeded: 'The daily AI budget is used up.',
  missing_key: 'No API key is configured for this provider.',
  invalid_endpoint: 'The provider endpoint must use https (http is only allowed for localhost).',
  auth: 'The provider rejected the API key.',
  quota_exhausted: 'The provider account has no remaining quota or credit.',
  rate_limited: 'The provider is rate limiting requests.',
  timeout: 'The provider did not answer in time.',
  network: 'The provider could not be reached.',
  server_error: 'The provider reported a server error.',
  bad_request: 'The provider rejected the request.',
  refused: 'The provider declined to answer.',
  output_truncated: 'The answer was cut off by the output limit.',
  invalid_output: 'The provider returned an answer that does not match the required format.',
  aborted: 'The request was cancelled.',
  not_acceptable: 'This result cannot be accepted.',
  internal: 'Unexpected internal error.',
};

const RETRYABLE: ReadonlySet<AiErrorCode> = new Set([
  'rate_limited',
  'timeout',
  'network',
  'server_error',
]);

export interface AiErrorInit {
  status?: number;
  retryAfterMs?: number;
  /** Short, already-safe detail (never provider free text, never a key). */
  detail?: string;
  issues?: string[];
  /** Budget after the spend of a run that failed (provider calls are counted even on failure). */
  budgetAfter?: BudgetState;
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly detail: string | undefined;
  readonly issues: string[] | undefined;
  readonly budgetAfter: BudgetState | undefined;

  constructor(code: AiErrorCode, init: AiErrorInit = {}) {
    super(init.detail ? `${MESSAGES[code]} (${init.detail})` : MESSAGES[code]);
    this.name = 'AiError';
    this.code = code;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.detail = init.detail;
    this.issues = init.issues;
    this.budgetAfter = init.budgetAfter;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export function isAiError(e: unknown): e is AiError {
  return e instanceof AiError;
}
