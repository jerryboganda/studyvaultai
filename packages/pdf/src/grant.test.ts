// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  isCoveredBy,
  isSingleOriginPattern,
  requestOrigins,
  withdrawOrigins,
  type PermissionsPort,
} from './grant';

/** A stub of browser.permissions that records the order of calls and holds a set of granted patterns. */
function stubPermissions(initial: string[] = [], answer = true) {
  const granted = new Set(initial);
  const calls: string[] = [];
  type Query = { origins: string[] };
  const port: PermissionsPort = {
    contains: vi.fn(async ({ origins }: Query) => {
      calls.push(`contains ${origins.join(',')}`);
      return origins.every((o) => granted.has(o));
    }),
    request: vi.fn(async ({ origins }: Query) => {
      calls.push(`request ${origins.join(',')}`);
      if (answer) for (const o of origins) granted.add(o);
      return answer;
    }),
    remove: vi.fn(async ({ origins }: Query) => {
      calls.push(`remove ${origins.join(',')}`);
      for (const o of origins) granted.delete(o);
      return true;
    }),
  };
  return { port, granted, calls };
}

const A = 'https://files.example.org/*';
const B = 'https://cdn.example.net/*';

describe('isSingleOriginPattern', () => {
  it('accepts one origin, with or without a port, and nothing with a wildcard host', () => {
    for (const p of [A, 'http://127.0.0.1:8080/*', 'http://localhost/*']) {
      expect(isSingleOriginPattern(p), p).toBe(true);
    }
    for (const p of [
      'https://*/*',
      'http://*/*',
      '*://*/*',
      '<all_urls>',
      'https://*.example.org/*',
      'https://files.example.org/docs/*',
      'file:///*',
      '',
    ]) {
      expect(isSingleOriginPattern(p), p).toBe(false);
    }
  });
});

describe('isCoveredBy', () => {
  it('knows when a standing grant already gives access to the origin', () => {
    expect(isCoveredBy(A, [A])).toBe(true);
    expect(isCoveredBy('http://127.0.0.1:8080/*', ['http://127.0.0.1/*'])).toBe(true);
    expect(isCoveredBy(A, ['https://*/*'])).toBe(true);
    expect(isCoveredBy(A, ['*://*/*'])).toBe(true);
    expect(isCoveredBy(A, ['<all_urls>'])).toBe(true);
    expect(isCoveredBy(A, ['https://*.example.org/*'])).toBe(true);
    expect(isCoveredBy('https://example.org/*', ['https://*.example.org/*'])).toBe(true);
  });

  it('does not stretch a grant further than it goes', () => {
    expect(isCoveredBy(A, [])).toBe(false);
    expect(isCoveredBy(A, [B])).toBe(false);
    expect(isCoveredBy(A, ['http://*/*'])).toBe(false); // http only
    expect(isCoveredBy('http://files.example.org/*', ['https://*/*'])).toBe(false);
    expect(isCoveredBy(A, ['https://*.example.net/*'])).toBe(false);
    expect(isCoveredBy('https://badexample.org/*', ['https://*.example.org/*'])).toBe(false);
    expect(isCoveredBy('not a pattern', ['<all_urls>'])).toBe(false);
  });
});

describe('requestOrigins', () => {
  it('asks in the same tick it is called, so the click that explained it still counts', () => {
    const { port, calls } = stubPermissions();
    void requestOrigins(port, [A, B]);
    // Nothing has been awaited yet: all three calls are already issued, in this order.
    expect(calls).toEqual([`contains ${A}`, `contains ${B}`, `request ${A},${B}`]);
  });

  it('reports as fresh only what the request itself made accessible', async () => {
    const { port } = stubPermissions([B]); // B was already granted before
    const out = await requestOrigins(port, [A, B]);
    expect(out).toEqual({ granted: true, fresh: [A] });
  });

  it('nothing is fresh when the person declines', async () => {
    const { port } = stubPermissions([], false);
    expect(await requestOrigins(port, [A])).toEqual({ granted: false, fresh: [] });
  });

  it('a pattern whose state cannot be read counts as already granted, so it is never handed back', async () => {
    const { port } = stubPermissions();
    port.contains = vi.fn(async () => {
      throw new Error('unavailable');
    });
    expect(await requestOrigins(port, [A])).toEqual({ granted: true, fresh: [] });
  });

  it('a request that fails is the caller to handle', async () => {
    const { port } = stubPermissions();
    port.request = vi.fn(async () => {
      throw new Error('blocked by policy');
    });
    await expect(requestOrigins(port, [A])).rejects.toThrow('blocked by policy');
  });
});

describe('withdrawOrigins', () => {
  it('removes what the fetch was given, and only that', async () => {
    const { port, granted } = stubPermissions([A, B, 'https://other.example/*']);
    const removed = await withdrawOrigins(port, [A, B], []);
    expect(removed).toEqual([A, B]);
    expect([...granted]).toEqual(['https://other.example/*']);
  });

  it('leaves what the person keeps: their standing list, an all-sites grant, the manifest', async () => {
    const { port } = stubPermissions([A, B]);
    expect(await withdrawOrigins(port, [A], [A])).toEqual([]); // sites you enabled
    expect(await withdrawOrigins(port, [A], ['https://*/*'])).toEqual([]); // all sites
    expect(await withdrawOrigins(port, [B], ['https://*.example.net/*'])).toEqual([]);
    expect(port.remove).not.toHaveBeenCalled();
  });

  it('never removes an all-sites or wildcard pattern, whatever it is handed', async () => {
    const { port } = stubPermissions();
    const removed = await withdrawOrigins(
      port,
      [
        'https://*/*',
        'http://*/*',
        '<all_urls>',
        'https://*.example.org/*',
        'https://a.example/x/*',
      ],
      [],
    );
    expect(removed).toEqual([]);
    expect(port.remove).not.toHaveBeenCalled();
  });

  it('removes each pattern once, and a refusal to remove is not an error', async () => {
    const { port } = stubPermissions();
    port.remove = vi
      .fn<PermissionsPort['remove']>()
      .mockRejectedValueOnce(new Error('cannot remove'))
      .mockResolvedValue(true);
    expect(await withdrawOrigins(port, [A, A, B], [])).toEqual([B]);
    expect(port.remove).toHaveBeenCalledTimes(2);
  });
});
