import { describe, expect, it } from 'vitest';
import { DEFAULT_DENY_HOSTS } from '@shared';
import { addDenyEntry, missingDefaults, removeDenyEntry, sortedDeny, splitOrigins } from './model';

describe('splitOrigins', () => {
  it('separates all-sites patterns from individual sites', () => {
    expect(
      splitOrigins([
        'https://example.com/*',
        'https://*/*',
        'http://localhost:3000/*',
        'http://*/*',
      ]),
    ).toEqual({
      allSites: true,
      sites: [
        { pattern: 'https://example.com/*', host: 'example.com' },
        { pattern: 'http://localhost:3000/*', host: 'localhost:3000' },
      ],
    });
  });

  it('is false for allSites when only single sites are listed', () => {
    expect(splitOrigins(['https://a.org/*']).allSites).toBe(false);
  });
});

describe('addDenyEntry', () => {
  const list = ['paypal.com'];

  it('normalises what people paste', () => {
    expect(addDenyEntry(list, '  HTTPS://Bank.Example.com/login?x=1 ')).toEqual({
      ok: true,
      host: 'bank.example.com',
      list: ['paypal.com', 'bank.example.com'],
    });
    expect(addDenyEntry(list, '*.example.org')).toMatchObject({ ok: true, host: 'example.org' });
  });

  it('rejects empty, invalid and duplicate entries with a reason', () => {
    expect(addDenyEntry(list, '   ')).toMatchObject({ ok: false });
    expect(addDenyEntry(list, 'not a host')).toMatchObject({ ok: false });
    expect(addDenyEntry(list, 'a/b')).toMatchObject({ ok: false });
    expect(addDenyEntry(list, 'ftp://example.com')).toMatchObject({ ok: false });
    expect(addDenyEntry(list, 'PayPal.com')).toEqual({
      ok: false,
      error: 'paypal.com is already on the deny list.',
    });
  });
});

describe('deny list helpers', () => {
  it('removes, reports missing defaults and sorts', () => {
    expect(removeDenyEntry(['a.com', 'b.com'], 'a.com')).toEqual(['b.com']);
    const defaults = [...DEFAULT_DENY_HOSTS];
    expect(missingDefaults(defaults.slice(2), defaults)).toEqual(defaults.slice(0, 2));
    expect(missingDefaults(defaults, defaults)).toEqual([]);
    expect(sortedDeny(['b.com', 'a.com'])).toEqual(['a.com', 'b.com']);
  });
});
