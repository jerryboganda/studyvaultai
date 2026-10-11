import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { browserSiteDeps } from './platform';

describe('browserSiteDeps.grantedOrigins', () => {
  afterEach(() => vi.restoreAllMocks());

  const stub = (staticHosts: string[] | undefined, granted: string[]) => {
    vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({
      host_permissions: staticHosts,
    } as never);
    (browser.permissions as { getAll: unknown }).getAll = vi.fn(async () => ({ origins: granted }));
  };

  it('excludes install-time host_permissions: they are not a user choice', async () => {
    stub(
      ['http://127.0.0.1/*', 'http://localhost/*'],
      ['http://127.0.0.1/*', 'http://localhost/*', 'https://example.com/*'],
    );
    // example.com is a per-origin grant, so it is not implicit site access either (settings hint only).
    await expect(browserSiteDeps().grantedOrigins()).resolves.toEqual([]);
  });

  it('keeps all-sites grants and drops per-origin grants made for AI, sync or PDF fetches', async () => {
    stub(undefined, [
      'https://*/*',
      'http://*/*',
      'https://api.openai.com/*',
      'http://localhost/*',
      'https://sync.example.org/*',
    ]);
    await expect(browserSiteDeps().grantedOrigins()).resolves.toEqual([
      'https://*/*',
      'http://*/*',
    ]);
  });

  it('reports null when Chrome cannot be asked', async () => {
    vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({} as never);
    (browser.permissions as { getAll: unknown }).getAll = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(browserSiteDeps().grantedOrigins()).resolves.toBeNull();
  });
});
