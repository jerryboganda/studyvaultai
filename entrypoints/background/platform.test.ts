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

  it('excludes install-time host_permissions: only optional grants are persistent choices', async () => {
    stub(
      ['http://127.0.0.1/*', 'http://localhost/*'],
      ['http://127.0.0.1/*', 'http://localhost/*', 'https://example.com/*'],
    );
    await expect(browserSiteDeps().grantedOrigins()).resolves.toEqual(['https://example.com/*']);
  });

  it('keeps every grant when the manifest declares no host_permissions (production)', async () => {
    stub(undefined, ['https://a.test/*', 'http://b.test/*']);
    await expect(browserSiteDeps().grantedOrigins()).resolves.toEqual([
      'https://a.test/*',
      'http://b.test/*',
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
