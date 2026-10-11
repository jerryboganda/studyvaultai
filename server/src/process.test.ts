// @vitest-environment node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The deployment path: the entry point is run by plain Node (type stripping), not by Vite. This is
 * what catches syntax the test runner accepts and Node does not (parameter properties, enums).
 */

const entry = resolve(__dirname, 'main.ts');
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
const nodeArgs = major === 22 && minor < 18 ? ['--experimental-strip-types'] : [];

function run(env: Record<string, string>) {
  return spawn(process.execPath, [...nodeArgs, entry], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('server process', () => {
  it('starts under plain Node, serves, and shuts down on SIGTERM', async () => {
    const child = run({ SV_DEV_TOKENS: 'dev-token-0123456789=dev-user', SV_PORT: '0' });
    const port = await new Promise<number>((resolvePort, reject) => {
      let out = '';
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString();
        const m = /"port":(\d+)/.exec(out);
        if (m) resolvePort(Number(m[1]));
      });
      child.on('exit', (code) => reject(new Error(`exited early (${code}): ${out}`)));
      setTimeout(() => reject(new Error('did not start')), 15_000);
    });

    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect(health.status).toBe(200);
    const denied = await fetch(`http://127.0.0.1:${port}/v1/ops`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/ops`, {
      headers: { authorization: 'Bearer dev-token-0123456789' },
    });
    expect(ok.status).toBe(200);

    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    child.kill('SIGTERM');
    // Windows has no SIGTERM handler semantics; either way the process must be gone.
    expect(
      await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10_000))]),
    ).not.toBe('timeout');
  }, 60_000);

  it('refuses to start without authentication, with a readable reason and exit code 2', async () => {
    const child = run({});
    let err = '';
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    expect(code).toBe(2);
    expect(err).toContain('SV_OIDC_ISSUER');
  }, 30_000);
});
