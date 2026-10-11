import { describe, expect, it } from 'vitest';
import { DEFAULT_DENY_HOSTS } from '@shared';
import { SETTINGS_SECTIONS } from '@ui/shell/paths';
import {
  addDenyEntry,
  missingDefaults,
  moveIndex,
  removeDenyEntry,
  sectionFromHash,
  sortedDeny,
  splitOrigins,
  storageLabel,
  storageRows,
} from './model';

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

describe('sectionFromHash', () => {
  it('accepts every section id and nothing else', () => {
    for (const { id } of SETTINGS_SECTIONS) {
      expect(sectionFromHash(`#${id}`)).toBe(id);
      expect(sectionFromHash(id)).toBe(id);
    }
    expect(sectionFromHash('')).toBeNull();
    expect(sectionFromHash('#')).toBeNull();
    expect(sectionFromHash('#nope')).toBeNull();
    expect(sectionFromHash('#ai?x=1')).toBeNull();
    expect(sectionFromHash('#javascript:alert(1)')).toBeNull();
  });

  it('lists the deep-link ids the brief names, in page order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'site-access',
      'appearance',
      'capture',
      'review',
      'ai',
      'sync',
      'backup',
      'storage',
      'shortcuts',
      'privacy',
      'data',
    ]);
  });
});

describe('moveIndex', () => {
  it('steps with the arrows, wrapping at both ends', () => {
    expect(moveIndex('ArrowDown', 0, 5)).toBe(1);
    expect(moveIndex('ArrowRight', 4, 5)).toBe(0);
    expect(moveIndex('ArrowUp', 0, 5)).toBe(4);
    expect(moveIndex('ArrowLeft', 3, 5)).toBe(2);
  });

  it('jumps with Home and End and ignores every other key', () => {
    expect(moveIndex('Home', 3, 5)).toBe(0);
    expect(moveIndex('End', 1, 5)).toBe(4);
    expect(moveIndex('Tab', 1, 5)).toBeNull();
    expect(moveIndex('a', 1, 5)).toBeNull();
    expect(moveIndex('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('storageRows', () => {
  it('drops empty tables and orders by size, then by label', () => {
    const rows = storageRows({
      highlights: 40,
      banks: 3,
      notes: 3,
      cards: 0,
      meta: 2,
      syncOps: 0,
    });
    expect(rows.map((r) => r.table)).toEqual(['highlights', 'banks', 'notes', 'meta']);
    expect(storageLabel('meta')).toBe('Internal bookkeeping');
    expect(storageLabel('highlights')).toBe('Highlights');
    expect(storageLabel('somethingNew')).toBe('somethingNew');
  });
});
