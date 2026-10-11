import { z } from 'zod';

/**
 * All configuration comes from the environment; nothing secret has a default and nothing is read
 * from a file in the repository. Anything unset that would make the server unsafe is an error, not
 * a fallback: the process refuses to start.
 */

export interface ServerConfig {
  host: string;
  port: number;
  /** Browser origins allowed to call the API (exact match), e.g. chrome-extension://<id>. */
  corsOrigins: readonly string[];
  maxBodyBytes: number;
  defaultPullLimit: number;
  maxPullLimit: number;
  maxPullBytes: number;
  userRatePerMinute: number;
  ipRatePerMinute: number;
  quotaBytesPerUser: number;
  maxFutureSkewMs: number;
  /** Take the client address from the last X-Forwarded-For entry (one trusted proxy hop). */
  trustProxy: boolean;
}

export type AuthConfig =
  | { kind: 'static'; tokens: ReadonlyMap<string, string> }
  | { kind: 'jwt'; issuer: string; audience: string; jwksUri: string };

export type StorageConfig = { kind: 'memory' } | { kind: 'file'; dir: string };

export interface ParsedEnv {
  config: ServerConfig;
  auth: AuthConfig;
  storage: StorageConfig;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid server configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const DEFAULT_CONFIG: ServerConfig = {
  host: '127.0.0.1',
  port: 8787,
  corsOrigins: [],
  maxBodyBytes: 2 * 1024 * 1024,
  defaultPullLimit: 200,
  maxPullLimit: 500,
  maxPullBytes: 4 * 1024 * 1024,
  userRatePerMinute: 120,
  ipRatePerMinute: 600,
  quotaBytesPerUser: 256 * 1024 * 1024,
  maxFutureSkewMs: 24 * 60 * 60 * 1000,
  trustProxy: false,
};

const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

function httpsOrLocal(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || (u.protocol === 'http:' && loopback.has(u.hostname));
  } catch {
    return false;
  }
}

export function parseEnv(env: Record<string, string | undefined>): ParsedEnv {
  const problems: string[] = [];
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const r = int(min, max).safeParse(raw);
    if (!r.success) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return r.data;
  };

  const host = env['SV_HOST'] || DEFAULT_CONFIG.host;
  const config: ServerConfig = {
    host,
    port: num('SV_PORT', DEFAULT_CONFIG.port, 0, 65535),
    corsOrigins: (env['SV_CORS_ORIGINS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxBodyBytes: num('SV_MAX_BODY_BYTES', DEFAULT_CONFIG.maxBodyBytes, 1024, 64 * 1024 * 1024),
    defaultPullLimit: DEFAULT_CONFIG.defaultPullLimit,
    maxPullLimit: DEFAULT_CONFIG.maxPullLimit,
    maxPullBytes: DEFAULT_CONFIG.maxPullBytes,
    userRatePerMinute: num('SV_RATE_USER_PER_MIN', DEFAULT_CONFIG.userRatePerMinute, 1, 1_000_000),
    ipRatePerMinute: num('SV_RATE_IP_PER_MIN', DEFAULT_CONFIG.ipRatePerMinute, 1, 1_000_000),
    quotaBytesPerUser: num('SV_QUOTA_BYTES', DEFAULT_CONFIG.quotaBytesPerUser, 1024, 2 ** 40),
    maxFutureSkewMs: num(
      'SV_MAX_FUTURE_SKEW_MS',
      DEFAULT_CONFIG.maxFutureSkewMs,
      1000,
      365 * 86_400_000,
    ),
    trustProxy: env['SV_TRUST_PROXY'] === '1',
  };
  for (const origin of config.corsOrigins) {
    if (origin === '*' || !/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+$/i.test(origin)) {
      problems.push(
        `SV_CORS_ORIGINS entry "${origin}" must be an exact origin (no wildcard, no path)`,
      );
    }
  }

  // Plain HTTP carries bearer tokens: only on loopback, or when a TLS proxy is declared in front.
  if (!loopback.has(host) && env['SV_BEHIND_TLS_PROXY'] !== '1') {
    problems.push(
      `SV_HOST=${host} is not loopback. This server speaks plain HTTP: terminate TLS in front of it and set SV_BEHIND_TLS_PROXY=1`,
    );
  }

  let auth: AuthConfig | null = null;
  const issuer = env['SV_OIDC_ISSUER'];
  const dev = env['SV_DEV_TOKENS'];
  if (issuer) {
    const audience = env['SV_OIDC_AUDIENCE'];
    const jwksUri = env['SV_OIDC_JWKS_URI'];
    if (!httpsOrLocal(issuer)) problems.push('SV_OIDC_ISSUER must be an https URL');
    if (!audience) problems.push('SV_OIDC_AUDIENCE is required with SV_OIDC_ISSUER');
    if (!jwksUri || !httpsOrLocal(jwksUri)) problems.push('SV_OIDC_JWKS_URI must be an https URL');
    if (audience && jwksUri) auth = { kind: 'jwt', issuer, audience, jwksUri };
  } else if (dev) {
    if (env['NODE_ENV'] === 'production' && env['SV_ALLOW_DEV_TOKENS'] !== '1') {
      problems.push('SV_DEV_TOKENS is for development; NODE_ENV=production refuses it');
    }
    const tokens = new Map<string, string>();
    for (const pair of dev.split(',')) {
      const i = pair.indexOf('=');
      const token = pair.slice(0, i).trim();
      const user = pair.slice(i + 1).trim();
      if (i < 0 || token.length < 16 || !user) {
        problems.push('SV_DEV_TOKENS entries must look like <token of 16+ chars>=<user id>');
        break;
      }
      tokens.set(token, user);
    }
    auth = { kind: 'static', tokens };
  } else {
    problems.push(
      'Set SV_OIDC_ISSUER (+ SV_OIDC_AUDIENCE, SV_OIDC_JWKS_URI), or SV_DEV_TOKENS for development',
    );
  }

  const storageKind = env['SV_STORAGE'] ?? 'memory';
  let storage: StorageConfig = { kind: 'memory' };
  if (storageKind === 'file') {
    const dir = env['SV_DATA_DIR'];
    if (!dir) problems.push('SV_DATA_DIR is required with SV_STORAGE=file');
    else storage = { kind: 'file', dir };
  } else if (storageKind !== 'memory') {
    problems.push('SV_STORAGE must be "memory" or "file"');
  }

  if (problems.length > 0 || auth === null) throw new ConfigError(problems);
  return { config, auth, storage };
}
