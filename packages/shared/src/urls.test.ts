import { describe, expect, it } from 'vitest';
import {
  captureBlock,
  denyEntriesFor,
  isHostDenied,
  isRegistrablePattern,
  normalizeHost,
  normalizeUrl,
  originPattern,
  redactUrl,
  sameSite,
  sourceKeys,
  trustedCanonical,
} from './urls';

describe('deny list host matching', () => {
  const deny = ['paypal.com', 'mail.google.com', 'Example.ORG'];

  it('matches the host, its subdomains and nothing else', () => {
    expect(isHostDenied('paypal.com', deny)).toBe(true);
    expect(isHostDenied('www.PayPal.com', deny)).toBe(true);
    expect(isHostDenied('example.org', deny)).toBe(true);
    expect(isHostDenied('notpaypal.com', deny)).toBe(false);
    expect(isHostDenied('google.com', deny)).toBe(false);
    expect(isHostDenied('paypal.com.evil.test', deny)).toBe(false);
  });

  it.each(['paypal.com.', 'www.paypal.com.', 'WWW.PAYPAL.COM.', 'paypal.com..'])(
    'a trailing dot does not bypass the list: %s',
    (host) => {
      expect(isHostDenied(host, deny)).toBe(true);
      expect(denyEntriesFor(host, deny)).toEqual(['paypal.com']);
    },
  );

  it('also normalises the stored entry and returns it as stored', () => {
    expect(denyEntriesFor('shop.paypal.com', ['PayPal.com.'])).toEqual(['PayPal.com.']);
    expect(isHostDenied('x.test', ['', ' ', '.'])).toBe(false);
  });

  it('applies to the capture block for URLs with a trailing-dot host', () => {
    expect(captureBlock('https://paypal.com./signin', deny)).toBe('denied-site');
    expect(captureBlock('https://www.paypal.com.:8443/x', deny)).toBe('denied-site');
    expect(captureBlock('https://example.com./', deny)).toBeNull();
    expect(captureBlock('chrome://settings', deny)).toBe('unsupported-scheme');
  });

  it('normalizeHost lowercases and strips every trailing dot', () => {
    expect(normalizeHost(' Www.Example.COM.. ')).toBe('www.example.com');
  });
});

describe('same site and trusted canonical', () => {
  it('requires the same scheme, port and host (a leading www. is equivalent)', () => {
    const page = 'https://example.com/a';
    expect(sameSite(page, 'https://example.com/b?x=1')).toBe(true);
    expect(sameSite(page, 'https://www.example.com/b')).toBe(true);
    expect(sameSite('https://www.example.com/a', 'https://example.com/b')).toBe(true);
    expect(sameSite(page, 'https://example.com:443/b')).toBe(true); // default port
    expect(sameSite(page, 'http://example.com/b')).toBe(false);
    expect(sameSite(page, 'https://example.com:8443/b')).toBe(false);
    expect(sameSite(page, 'https://sub.example.com/b')).toBe(false);
    expect(sameSite(page, 'https://example.org/b')).toBe(false);
    expect(sameSite(page, 'not a url')).toBe(false);
    expect(sameSite(page, 'ftp://example.com/b')).toBe(false);
  });

  it('accepts a same-site canonical, resolving relative hrefs', () => {
    const page = 'https://example.com/a/b?utm_source=x';
    expect(trustedCanonical(page, 'https://example.com/canon')).toBe('https://example.com/canon');
    expect(trustedCanonical(page, '/canon/')).toBe('https://example.com/canon');
    expect(trustedCanonical(page, 'https://www.example.com/canon')).toBe(
      'https://www.example.com/canon',
    );
  });

  it('rejects a canonical on another host, scheme or port', () => {
    const page = 'https://example.com/a';
    expect(trustedCanonical(page, 'https://attacker.test/a')).toBeNull();
    expect(trustedCanonical(page, 'http://example.com/a')).toBeNull();
    expect(trustedCanonical(page, 'https://example.com:8443/a')).toBeNull();
    expect(trustedCanonical('http://localhost:3000/a', 'http://localhost:3001/a')).toBeNull();
    expect(trustedCanonical(page, 'javascript:alert(1)')).toBeNull();
    expect(trustedCanonical(page, null)).toBeNull();
    // Falls back to the visited URL for the source key.
    expect(sourceKeys(page, 'http://example.com/a')).toEqual({
      urlKey: 'https://example.com/a',
      visitedKey: 'https://example.com/a',
    });
  });
});

describe('credentials never become part of an address', () => {
  it('removes credential parameters and the fragment from the identity', () => {
    const presigned =
      'https://files.example.com/doc.html?X-Amz-Algorithm=AWS4&X-Amz-Credential=AKIA%2F2026&X-Amz-Date=20261011&X-Amz-Signature=abc123&page=2';
    expect(normalizeUrl(presigned)).toBe('https://files.example.com/doc.html?page=2');
    expect(normalizeUrl('https://x.test/p?X-Goog-Signature=1&Z=1&a=2')).toBe(
      'https://x.test/p?Z=1&a=2',
    );
    for (const name of [
      'token',
      'access_token',
      'id_token',
      'refresh_token',
      'code',
      'sig',
      'signature',
      'key',
      'apikey',
      'api_key',
      'secret',
      'session',
      'sessionid',
      'auth',
      'password',
      'TOKEN',
    ]) {
      expect(normalizeUrl(`https://x.test/p?${name}=v&id=7`), name).toBe('https://x.test/p?id=7');
    }
    // Look-alikes are page identity.
    expect(normalizeUrl('https://x.test/p?tokens=1&keyword=a&codes=2')).toBe(
      'https://x.test/p?codes=2&keyword=a&tokens=1',
    );
  });

  it('a rotated token yields the same identity', () => {
    const a = sourceKeys('https://app.test/report?id=9&token=aaa', null);
    const b = sourceKeys('https://app.test/report?token=bbb&id=9', null);
    expect(a).toEqual(b);
    expect(a?.urlKey).toBe('https://app.test/report?id=9');
  });

  it('drops a fragment unless it is a route, and scrubs credentials inside routes', () => {
    expect(normalizeUrl('https://a.test/p#section')).toBe('https://a.test/p');
    expect(normalizeUrl('https://a.test/cb#access_token=abc&token_type=bearer')).toBe(
      'https://a.test/cb',
    );
    expect(normalizeUrl('https://a.test/#/docs/intro')).toBe('https://a.test/#/docs/intro');
    expect(normalizeUrl('https://a.test/#!/docs')).toBe('https://a.test/#!/docs');
    expect(normalizeUrl('https://a.test/#/reset?token=abc&step=2')).toBe(
      'https://a.test/#/reset?step=2',
    );
    expect(normalizeUrl('https://a.test/#/reset?token=abc')).toBe('https://a.test/#/reset');
    expect(normalizeUrl('https://a.test/#/access_token=abc&token_type=bearer')).toBe(
      'https://a.test/',
    );
    expect(normalizeUrl('https://a.test/#!access_token=abc')).toBe('https://a.test/');
  });

  it('redactUrl keeps the visited address openable and drops only what is secret', () => {
    expect(redactUrl('https://u:pw@a.test/p?utm_source=n&b=2&a=1&sig=zzz#frag')).toBe(
      'https://a.test/p?utm_source=n&b=2&a=1',
    );
    // Untouched when there is nothing to remove.
    expect(redactUrl('https://a.test/Path/?q=a%20b&x=1')).toBe('https://a.test/Path/?q=a%20b&x=1');
    expect(redactUrl('https://a.test/#/r?token=1&s=2')).toBe('https://a.test/#/r?s=2');
    expect(redactUrl('ftp://a.test/')).toBeNull();
    expect(redactUrl('not a url')).toBeNull();
  });
});

describe('match patterns', () => {
  it('originPattern keeps the port and IPv6 brackets', () => {
    expect(originPattern('https://Example.com:8443/a')).toBe('https://example.com:8443/*');
    expect(originPattern('http://[::1]:3000/x')).toBe('http://[::1]:3000/*');
    expect(originPattern('http://my_host.local/x')).toBe('http://my_host.local/*');
  });

  it.each([
    'https://example.com/*',
    'https://my_host.example.com/*',
    'http://my_host/*',
    'http://[::1]/*',
    'http://[::1]:3000/*',
    'http://[2001:db8::1]/*',
    'https://*.example.com/*',
    'https://*/*',
    '*://example.com:8080/*',
    'http://127.0.0.1:41234/*',
  ])('registers %s', (pattern) => {
    expect(isRegistrablePattern(pattern)).toBe(true);
  });

  it.each([
    '<all_urls>',
    'https://example.com/path/*',
    'https://a*b.example/*',
    'https://exa$mple.com/*',
    'ftp://example.com/*',
    'https://example.com',
    'not a pattern',
    'http://[::1/*',
  ])('does not register %s', (pattern) => {
    expect(isRegistrablePattern(pattern)).toBe(false);
  });
});
