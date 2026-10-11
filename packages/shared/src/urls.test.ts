import { describe, expect, it } from 'vitest';
import {
  captureBlock,
  denyEntriesFor,
  isHostDenied,
  isPlaceholderSourceUrl,
  isRegistrablePattern,
  normalizeHost,
  normalizeUrl,
  originPattern,
  parseHttpUrl,
  redactUrl,
  sameSite,
  sourceKeys,
  trustedCanonical,
  visibleSourceUrl,
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

  it('accepts a canonical that names the page itself, resolving relative hrefs', () => {
    const page = 'https://example.com/a/b?utm_source=x';
    expect(trustedCanonical(page, 'https://example.com/a/b')).toBe('https://example.com/a/b');
    expect(trustedCanonical(page, '/a/b/')).toBe('https://example.com/a/b');
    expect(trustedCanonical(page, 'b')).toBe('https://example.com/a/b');
    // www. is the same site, and tracking parameters or a fragment are not identity.
    expect(trustedCanonical(page, 'https://www.example.com/a/b')).toBe(
      'https://www.example.com/a/b',
    );
    expect(
      trustedCanonical('https://www.example.com/a/b?fbclid=z#intro', 'https://example.com/a/b'),
    ).toBe('https://example.com/a/b');
    expect(trustedCanonical('https://example.com/a?b=2&a=1', '/a?a=1&b=2')).toBe(
      'https://example.com/a?a=1&b=2',
    );
  });

  it('rejects a same-site canonical that points at a different page', () => {
    // Single-page app: "/" is declared on every route.
    expect(trustedCanonical('https://spa.test/courses/12', '/')).toBeNull();
    expect(trustedCanonical('https://spa.test/courses/12', 'https://spa.test/')).toBeNull();
    // Listing: page 2 declares page 1.
    expect(trustedCanonical('https://shop.test/list?page=2', '/list')).toBeNull();
    expect(trustedCanonical('https://shop.test/list/page/2', '/list/')).toBeNull();
    // A different query is a different page; a different path is too.
    expect(trustedCanonical('https://shop.test/item?id=2', '/item?id=1')).toBeNull();
    expect(trustedCanonical('https://example.com/a/b', 'https://example.com/canon')).toBeNull();
    // Hash-routed apps: the route is the identity and the canonical omits it.
    expect(trustedCanonical('https://app.test/#/courses/1', 'https://app.test/')).toBeNull();
    // They are keyed by the visited URL.
    expect(sourceKeys('https://spa.test/courses/12', '/')).toEqual({
      urlKey: 'https://spa.test/courses/12',
      visitedKey: 'https://spa.test/courses/12',
    });
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
    expect(normalizeUrl('https://x.test/p?keyword=a&codes=2&author=x')).toBe(
      'https://x.test/p?author=x&codes=2&keyword=a',
    );
  });

  // Every spelling of a credential-like name, as page and API authors really write them.
  const SECRET_NAMES = [
    'access-token',
    'accessToken',
    'ACCESS_TOKEN',
    'auth_token',
    'authToken',
    'jwt',
    'bearer',
    'sid',
    'session_token',
    'PHPSESSID',
    'JSESSIONID',
    'x-api-key',
    'client_secret',
    'secret_key',
    'csrf_token',
    'xsrf-token',
    'otp',
    'pwd',
    'passwd',
    'ticket',
    'AWSAccessKeyId',
    'awsaccesskeyid',
    'Key-Pair-Id',
    'Authorization',
    'auth_code',
    'verification_code',
    'code_verifier',
    'sig',
    'Signature',
    'oauth_token',
    'credentials',
    'X_Amz_Security_Token',
    'x-goog-credential',
    'api.key',
    'user[token]',
    '%74oken',
  ];

  // Page identity and navigation state: they must stay readable and keep the page apart.
  const KEEP_NAMES = [
    'medium',
    'page',
    'q',
    'id',
    'v',
    't',
    'sort',
    'author',
    'keyword',
    'keywords',
    'design',
    'signup',
    'signal',
    'assessment',
    'inside',
    'side',
    'passage',
    'encode',
    'codes',
    'zipcode',
    'postcode',
    'code_challenge',
    'authuser',
    'lang',
    'topic',
    'course_id',
    'userId',
    'section',
    'state',
  ];

  it.each(SECRET_NAMES)('redacts the parameter %s everywhere an address is stored', (name) => {
    const url = `https://x.test/p?${name}=SECRETVALUE&id=7#/r?${name}=SECRETVALUE&step=2`;
    expect(redactUrl(url)).toBe('https://x.test/p?id=7#/r?step=2');
    expect(normalizeUrl(url)).toBe('https://x.test/p?id=7#/r?step=2');
    expect(sourceKeys(url, null)).toEqual({
      urlKey: 'https://x.test/p?id=7#/r?step=2',
      visitedKey: 'https://x.test/p?id=7#/r?step=2',
    });
  });

  it.each(KEEP_NAMES)('keeps the parameter %s readable', (name) => {
    const url = `https://x.test/p?${name}=v#/r?${name}=v`;
    expect(redactUrl(url)).toBe(url);
    expect(normalizeUrl(url)).toBe(url);
  });

  it('removes a credential in a key=value fragment or route, whatever its spelling', () => {
    for (const hash of [
      '#access_token=a&token_type=bearer',
      '#/access-token=a',
      '#!authToken=a',
      '#/cb;jwt=a',
      '#/cb/session_token=a/x',
    ]) {
      expect(normalizeUrl(`https://a.test/${hash}`), hash).toBe('https://a.test/');
    }
    // A second "#" is not part of a route: what follows it is dropped.
    expect(normalizeUrl('https://a.test/#/cb#id_token=a')).toBe('https://a.test/#/cb');
    expect(normalizeUrl('https://a.test/#/cb#state=1&access_token=a')).toBe('https://a.test/#/cb');
    expect(normalizeUrl('https://a.test/#/r?step=2&AuthToken=a&ticket=t&page=3')).toBe(
      'https://a.test/#/r?step=2&page=3',
    );
    expect(redactUrl('https://a.test/p?q=1#/r?sid=z')).toBe('https://a.test/p?q=1#/r');
  });

  it('removes credential path parameters and keeps the others', () => {
    expect(normalizeUrl('https://a.test/app/page;jsessionid=ABC123?x=1')).toBe(
      'https://a.test/app/page?x=1',
    );
    expect(redactUrl('https://a.test/app;JSESSIONID=ABC/page;v=2;sid=9')).toBe(
      'https://a.test/app/page;v=2',
    );
  });

  it('identity stays stable when only a secret differs, in any parameter spelling', () => {
    const a = sourceKeys('https://app.test/r?id=9&authToken=aaa&PHPSESSID=1#/x?jwt=a', null);
    const b = sourceKeys('https://app.test/r?PHPSESSID=2&id=9&authToken=bbb#/x?jwt=b', null);
    expect(a).toEqual(b);
    expect(a?.urlKey).toBe('https://app.test/r?id=9#/x');
  });

  describe('on arbitrary input', () => {
    // Deterministic generator (mulberry32), so a failure is reproducible.
    let seed = 0x5eed1234;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
    const junk = [
      '',
      '&',
      '=',
      '==',
      '?',
      '#',
      '/',
      ';',
      '!',
      '%',
      '%zz',
      '%E0%A4%A',
      '+',
      ' ',
      '\u0000',
      '\ud800',
      'é',
      '[]',
      'a'.repeat(300),
      '\\',
      ':',
      '@',
    ];
    const encode = (s: string) => {
      try {
        return encodeURIComponent(s);
      } catch {
        return '%EF%BF%BD'; // a lone surrogate cannot be percent-encoded
      }
    };
    /** A credential name in a random spelling: "authToken", "AUTH-TOKEN", "auth.token", "authtoken". */
    const secretName = () => {
      // "sid" and "code" only count as a word of their own ("auth_code"), never glued ("authcode").
      const last = pick(['token', 'key', 'secret', 'jwt', 'password', 'sid', 'code']);
      const words = [pick(['access', 'auth', 'client', 'csrf', 'api', 'id', 'refresh']), last];
      const glued = last === 'sid' || last === 'code' ? ['-', '_', '.'] : ['-', '_', '.', ''];
      const style = Math.floor(rand() * 3);
      if (style === 0) return words.join(pick(glued));
      if (style === 1) return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
      return words.join(pick(glued)).toUpperCase();
    };

    it('never lets a planted credential survive, whatever surrounds it', () => {
      const names = [...SECRET_NAMES, ...KEEP_NAMES, ...junk];
      for (let i = 0; i < 1500; i++) {
        const secret = secretName();
        const pairs = Array.from(
          { length: Math.floor(rand() * 5) },
          () => `${encode(pick(names))}=${encode(pick(junk))}`,
        );
        pairs.splice(Math.floor(rand() * (pairs.length + 1)), 0, `${secret}=LEAK${i}`);
        const query = pairs.join('&');
        const hash = pick([
          '',
          '#frag',
          `#/r?${query}`,
          `#!/r?${query}&x=1`,
          `#/r/${secret}=LEAK${i}`,
          `#!${secret}=LEAK${i}&state=s`,
          `#/r#${query}`,
          `#${query}`,
        ]);
        const path = pick(['', '/', '/x/', `/x;${secret}=LEAK${i}`, `/x;a=b;${secret}=LEAK${i}/y`]);
        const input = `${pick(['https://', 'http://u:p@'])}a.test${path}?${query}${hash}`;
        const red = redactUrl(input);
        const norm = normalizeUrl(input);
        expect(red, input).not.toBeNull();
        expect(norm, input).not.toBeNull();
        expect(red, input).not.toContain(`LEAK${i}`);
        expect(norm, input).not.toContain(`LEAK${i}`);
        expect(redactUrl(red!), `idempotent: ${input}`).toBe(red);
        expect(normalizeUrl(norm!), `idempotent: ${input}`).toBe(norm);
        // Two spellings of one page that differ only in the secret have one identity.
        const other = input.replaceAll(`LEAK${i}`, `OTHER${i}`);
        expect(sourceKeys(other, null), input).toEqual(sourceKeys(input, null));
      }
    });

    it('never throws on malformed addresses, queries and fragments', () => {
      for (let i = 0; i < 1500; i++) {
        const piece = () =>
          [pick(junk), pick(junk), secretName(), pick(junk)].join(pick(['', '=']));
        const input = `${pick(['https', 'http', 'ftp', '', 'javascript'])}://${pick(['u:p@', '', '['])}a.test${pick(['', '/', '/x/;a', `;${piece()}`])}?${piece()}&${piece()}${pick(['', '#', '#/', '#!', '#/r?', `#/${piece()}`, `#${piece()}`])}`;
        expect(() => {
          const red = redactUrl(input);
          const norm = normalizeUrl(input);
          sourceKeys(input, pick([null, '/', input, 'https://a.test/x', ':::']));
          for (const v of [red, norm]) {
            // Whatever comes back is itself a valid address, and a second pass does not change it.
            if (v !== null) expect(parseHttpUrl(v), input).not.toBeNull();
          }
          if (norm !== null) expect(normalizeUrl(norm), input).toBe(norm);
        }, input).not.toThrow();
      }
    });
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

describe('stand-in addresses of sources without one', () => {
  it('are recognised by host, whatever the path or the letter case', () => {
    expect(isPlaceholderSourceUrl('https://studyvault.invalid/pdf/abc')).toBe(true);
    expect(isPlaceholderSourceUrl('https://studyvault.invalid/imported/b/1')).toBe(true);
    expect(isPlaceholderSourceUrl('https://StudyVault.INVALID/anything')).toBe(true);
    expect(isPlaceholderSourceUrl('https://example.com/studyvault.invalid/')).toBe(false);
    expect(isPlaceholderSourceUrl('not a url')).toBe(false);
    expect(isPlaceholderSourceUrl(null)).toBe(false);
  });

  it('are hidden by visibleSourceUrl, real addresses are returned as they are', () => {
    expect(visibleSourceUrl('https://studyvault.invalid/pdf/abc')).toBe('');
    expect(visibleSourceUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(visibleSourceUrl(undefined)).toBe('');
  });
});
