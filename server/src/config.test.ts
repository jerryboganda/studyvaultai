// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from './config.ts';

const dev = { SV_DEV_TOKENS: 'a-sixteen-char-token=user-1' };

describe('server configuration fails closed', () => {
  it('accepts a minimal development setup with safe defaults', () => {
    const { config, auth, storage } = parseEnv(dev);
    expect(config.host).toBe('127.0.0.1');
    expect(config.corsOrigins).toEqual([]);
    expect(auth.kind).toBe('static');
    expect(storage).toEqual({ kind: 'memory' });
  });

  it('refuses to start without any authentication', () => {
    expect(() => parseEnv({})).toThrow(ConfigError);
  });

  it('refuses development tokens in production, and weak ones anywhere', () => {
    expect(() => parseEnv({ ...dev, NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => parseEnv({ SV_DEV_TOKENS: 'short=user' })).toThrow(/16\+/);
  });

  it('refuses a public bind without a declared TLS proxy', () => {
    expect(() => parseEnv({ ...dev, SV_HOST: '0.0.0.0' })).toThrow(/TLS/);
    expect(parseEnv({ ...dev, SV_HOST: '0.0.0.0', SV_BEHIND_TLS_PROXY: '1' }).config.host).toBe(
      '0.0.0.0',
    );
  });

  it('refuses wildcard or path-bearing CORS origins', () => {
    expect(() => parseEnv({ ...dev, SV_CORS_ORIGINS: '*' })).toThrow(/exact origin/);
    expect(() => parseEnv({ ...dev, SV_CORS_ORIGINS: 'https://a.example/path' })).toThrow(
      /exact origin/,
    );
    expect(
      parseEnv({ ...dev, SV_CORS_ORIGINS: 'chrome-extension://abc, https://app.example' }).config
        .corsOrigins,
    ).toEqual(['chrome-extension://abc', 'https://app.example']);
  });

  it('validates OIDC settings and storage selection', () => {
    expect(() => parseEnv({ SV_OIDC_ISSUER: 'https://id.example' })).toThrow(/AUDIENCE/);
    const ok = parseEnv({
      SV_OIDC_ISSUER: 'https://id.example',
      SV_OIDC_AUDIENCE: 'studyvault',
      SV_OIDC_JWKS_URI: 'https://id.example/jwks',
      SV_STORAGE: 'file',
      SV_DATA_DIR: '/var/lib/studyvault',
    });
    expect(ok.auth.kind).toBe('jwt');
    expect(ok.storage).toEqual({ kind: 'file', dir: '/var/lib/studyvault' });
    expect(() => parseEnv({ ...dev, SV_STORAGE: 'file' })).toThrow(/SV_DATA_DIR/);
    expect(() => parseEnv({ ...dev, SV_PORT: 'eighty' })).toThrow(/SV_PORT/);
  });
});
