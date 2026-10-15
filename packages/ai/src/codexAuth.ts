// ChatGPT (Codex) OAuth: authorization-code flow with PKCE, token refresh and quota usage.
// UNOFFICIAL: this reuses the public Codex CLI client and its localhost redirect, the same method
// third-party Codex clients use. It can change without notice, so every call returns a typed error
// instead of guessing, and nothing here runs on import. `fetch` and randomness are injected.
import { AiError } from './errors';
import type { FetchLike } from './providers';

const AUTH_ORIGIN = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** Origins this flow talks to: the host permission patterns to request. */
export const codexAuthOrigins = (): string[] => [`${AUTH_ORIGIN}/*`, 'https://chatgpt.com/*'];

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  accountId: string;
}

const b64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Fresh PKCE verifier/challenge and an anti-forgery `state`. */
export async function newCodexPkce(): Promise<{
  verifier: string;
  challenge: string;
  state: string;
}> {
  const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
  const verifier = b64url(rand(48));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)), state: b64url(rand(24)) };
}

export function buildCodexAuthorizeUrl(challenge: string, state: string): string {
  const u = new URL(`${AUTH_ORIGIN}/oauth/authorize`);
  const q = u.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', CLIENT_ID);
  q.set('redirect_uri', CODEX_REDIRECT_URI);
  q.set('scope', 'openid profile email offline_access');
  q.set('code_challenge', challenge);
  q.set('code_challenge_method', 'S256');
  q.set('id_token_add_organizations', 'true');
  q.set('codex_cli_simplified_flow', 'true');
  q.set('state', state);
  q.set('originator', 'codex_cli_rs');
  return u.toString();
}

/**
 * `code` and `state` out of the redirect URL (pasted by the user or seen on the tab), or null when
 * it is not this flow's callback. The caller compares `state` with the one it generated.
 */
export function codexCallbackParams(
  raw: string,
): { code: string; state: string } | { error: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.origin !== 'http://localhost:1455' || u.pathname !== '/auth/callback') return null;
  const error = u.searchParams.get('error');
  if (error) return { error: error.slice(0, 80) };
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  return code && state ? { code, state } : null;
}

/** `chatgpt_account_id` out of a JWT (the id token or the access token); null if absent. */
export function codexAccountId(jwt: string): string | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(
      part
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(part.length / 4) * 4, '='),
    );
    const claims = JSON.parse(json) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'] as
      { chatgpt_account_id?: unknown } | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

async function tokenRequest(
  fetchFn: FetchLike,
  form: Record<string, string>,
  nowMs: number,
  previous?: CodexTokens,
): Promise<CodexTokens> {
  let res: Response;
  try {
    res = await fetchFn(`${AUTH_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new AiError('network');
  }
  if (!res.ok) {
    throw new AiError(res.status === 400 || res.status === 401 ? 'auth' : 'server_error', {
      status: res.status,
      detail: `login HTTP ${res.status}`,
    });
  }
  let data: {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new AiError('server_error', { detail: 'unreadable login response' });
  }
  const access = typeof data.access_token === 'string' ? data.access_token : '';
  const refresh =
    typeof data.refresh_token === 'string' ? data.refresh_token : (previous?.refreshToken ?? '');
  if (!access || !refresh) throw new AiError('auth', { detail: 'login response incomplete' });
  const accountId =
    codexAccountId(typeof data.id_token === 'string' ? data.id_token : '') ??
    codexAccountId(access) ??
    previous?.accountId ??
    '';
  if (!accountId) throw new AiError('auth', { detail: 'no ChatGPT account id in the login' });
  const secs = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  return { accessToken: access, refreshToken: refresh, expiresAt: nowMs + secs * 1000, accountId };
}

export const exchangeCodexCode = (
  fetchFn: FetchLike,
  code: string,
  verifier: string,
  nowMs: number,
): Promise<CodexTokens> =>
  tokenRequest(
    fetchFn,
    {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI,
    },
    nowMs,
  );

export const refreshCodexTokens = (
  fetchFn: FetchLike,
  tokens: CodexTokens,
  nowMs: number,
): Promise<CodexTokens> =>
  tokenRequest(
    fetchFn,
    {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: tokens.refreshToken,
      scope: 'openid profile email',
    },
    nowMs,
    tokens,
  );

export interface CodexUsageWindow {
  /** 0-100. */
  usedPercent: number;
  /** Window length in minutes (300 = 5 hours, 10080 = a week), when reported. */
  windowMinutes: number | null;
  /** Seconds until the window resets, when reported. */
  resetsInSeconds: number | null;
}

export interface CodexUsage {
  plan: string | null;
  windows: CodexUsageWindow[];
}

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Subscription quota windows of the signed-in ChatGPT account; an error says why it is unknown. */
export async function fetchCodexUsage(
  fetchFn: FetchLike,
  tokens: Pick<CodexTokens, 'accessToken' | 'accountId'>,
): Promise<CodexUsage> {
  let res: Response;
  try {
    res = await fetchFn(USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'chatgpt-account-id': tokens.accountId,
        originator: 'codex_cli_rs',
        accept: 'application/json',
      },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new AiError('network');
  }
  if (res.status === 401 || res.status === 403) throw new AiError('auth', { status: res.status });
  if (!res.ok) throw new AiError('server_error', { status: res.status });
  let data: {
    plan_type?: unknown;
    rate_limit?: Record<
      string,
      | { used_percent?: unknown; limit_window_seconds?: unknown; reset_after_seconds?: unknown }
      | undefined
    >;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new AiError('server_error', { detail: 'unreadable usage response' });
  }
  const windows: CodexUsageWindow[] = [];
  for (const key of ['primary_window', 'secondary_window']) {
    const w = data.rate_limit?.[key];
    const used = numOrNull(w?.used_percent);
    if (!w || used === null) continue;
    const secs = numOrNull(w.limit_window_seconds);
    windows.push({
      usedPercent: Math.max(0, Math.min(100, used)),
      windowMinutes: secs === null ? null : Math.round(secs / 60),
      resetsInSeconds: numOrNull(w.reset_after_seconds),
    });
  }
  return { plan: typeof data.plan_type === 'string' ? data.plan_type : null, windows };
}
