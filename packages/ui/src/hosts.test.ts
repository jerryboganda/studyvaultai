import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  denyEntriesFor,
  hostOf,
  isAllSitesPattern,
  isPdfUrl,
  normalizeDenyInput,
  patternHost,
  safeHref,
} from './hosts';

describe('address helpers', () => {
  it('extracts hosts and patterns', () => {
    expect(hostOf('https://Sub.Example.com:8443/a?b#c')).toBe('sub.example.com');
    expect(hostOf('chrome://extensions')).toBeNull();
    expect(hostOf(undefined)).toBeNull();
    expect(patternHost('https://example.com/*')).toBe('example.com');
    expect(patternHost('*://*.example.com/*')).toBe('*.example.com');
    expect(patternHost('https://example.com/path/*')).toBeNull();
    expect(isAllSitesPattern('https://*/*')).toBe(true);
    expect(isAllSitesPattern('https://example.com/*')).toBe(false);
  });

  it('only returns http(s) hrefs', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,<b>x</b>')).toBeUndefined();
    expect(safeHref('')).toBeUndefined();
  });

  it('recognises PDF addresses by path, not by query', () => {
    expect(isPdfUrl('https://example.com/a/b.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/a/b.PDF?x=1')).toBe(true);
    expect(isPdfUrl('https://example.com/view?file=b.pdf')).toBe(false);
    expect(isPdfUrl('https://example.com/pdf')).toBe(false);
  });
});

describe('denyEntriesFor', () => {
  it('matches the host and parent domains only', () => {
    const list = ['paypal.com', 'mail.google.com', 'example.org'];
    expect(denyEntriesFor('www.paypal.com', list)).toEqual(['paypal.com']);
    expect(denyEntriesFor('paypal.com', list)).toEqual(['paypal.com']);
    expect(denyEntriesFor('notpaypal.com', list)).toEqual([]);
    expect(denyEntriesFor('google.com', list)).toEqual([]);
    expect(denyEntriesFor('MAIL.GOOGLE.COM', list)).toEqual(['mail.google.com']);
  });

  it('treats a trailing-dot FQDN as the same host', () => {
    const list = ['paypal.com'];
    expect(denyEntriesFor('paypal.com.', list)).toEqual(['paypal.com']);
    expect(denyEntriesFor('www.paypal.com.', list)).toEqual(['paypal.com']);
    expect(classifyAddress('https://www.paypal.com./pay', list)).toEqual({
      kind: 'denied',
      host: 'www.paypal.com.',
      entries: ['paypal.com'],
    });
  });
});

describe('classifyAddress', () => {
  const deny = ['paypal.com'];
  it('covers every outcome', () => {
    expect(classifyAddress(undefined, deny).kind).toBe('no-address');
    expect(classifyAddress('chrome://settings', deny)).toEqual({
      kind: 'unsupported',
      scheme: 'chrome:',
    });
    expect(classifyAddress('file:///a.html', deny)).toMatchObject({ kind: 'unsupported' });
    expect(classifyAddress('https://example.com/x.pdf', deny)).toEqual({
      kind: 'pdf',
      host: 'example.com',
    });
    expect(classifyAddress('https://www.paypal.com/pay', deny)).toEqual({
      kind: 'denied',
      host: 'www.paypal.com',
      entries: ['paypal.com'],
    });
    expect(classifyAddress('https://example.com/x', deny)).toEqual({
      kind: 'ok',
      url: 'https://example.com/x',
      host: 'example.com',
    });
  });
});

describe('normalizeDenyInput', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  Example.COM ', 'example.com'],
    ['https://www.Example.com/a/b?c#d', 'www.example.com'],
    ['*.example.com', 'example.com'],
    ['example.com.', 'example.com'],
    ['localhost', 'localhost'],
    ['my_host.example.com', 'my_host.example.com'],
  ])('accepts %j', (input, host) => {
    expect(normalizeDenyInput(input)).toEqual({ host });
  });

  it.each([
    '',
    '   ',
    'a b',
    'example.com/path',
    'example.com:8080',
    'ex*mple.com',
    '-bad.com',
    'ftp://x.com',
  ])('rejects %j', (input) => {
    expect(normalizeDenyInput(input)).toHaveProperty('error');
  });
});
