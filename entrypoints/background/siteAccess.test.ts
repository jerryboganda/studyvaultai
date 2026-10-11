// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudyVaultError, defaultSettings, type Settings } from '@shared';
import {
  ACTIVATE_TIMEOUT_MS,
  CONTENT_SCRIPT_FILE,
  PERSISTENT_SCRIPT_ID,
  createSiteAccess,
  mapInjectionError,
  patternCovers,
  pingWithTimeout,
  type PersistentScript,
  type SiteAccessDeps,
} from './siteAccess';

function setup(
  settings: Partial<Settings> = {},
  opts: {
    /** Patterns `permissions.contains` says yes to. */
    granted?: string[];
    /** `permissions.getAll().origins`; defaults to `granted`. null = Chrome could not be asked. */
    grantedList?: string[] | null;
    registered?: string[] | null;
    url?: string | undefined;
  } = {},
) {
  const state = {
    registered: opts.registered === undefined ? null : opts.registered,
    active: false,
    url: 'url' in opts ? opts.url : ('https://example.com/page' as string | undefined),
  };
  const granted = new Set(opts.granted ?? []);
  const calls: string[] = [];
  const deps = {
    getSettings: async () => ({ ...defaultSettings(), ...settings }),
    hasPermission: vi.fn(async (origin: string) => granted.has(origin)),
    grantedOrigins: vi.fn(async () =>
      opts.grantedList === undefined ? [...granted] : opts.grantedList,
    ),
    rememberOrigins: vi.fn(async (_origins: string[]) => undefined),
    registeredMatches: vi.fn(async () => state.registered),
    register: vi.fn(async (s: PersistentScript) => {
      calls.push('register');
      state.registered = s.matches;
    }),
    update: vi.fn(async (s: PersistentScript) => {
      calls.push('update');
      state.registered = s.matches;
    }),
    unregister: vi.fn(async () => {
      calls.push('unregister');
      state.registered = null;
    }),
    tabUrl: vi.fn(async () => state.url),
    inject: vi.fn(async () => {
      calls.push('inject');
      state.active = true;
    }),
    isActive: vi.fn(async () => state.active),
    sleep: vi.fn(async (_ms: number) => undefined),
  } satisfies SiteAccessDeps;
  return { deps, state, calls, site: createSiteAccess(deps), granted };
}

async function failure(promise: Promise<unknown>): Promise<StudyVaultError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof StudyVaultError) return err;
    throw err;
  }
  throw new Error('expected a StudyVaultError');
}

describe('patternCovers', () => {
  const cases: Array<[string, string, boolean]> = [
    ['https://example.com/*', 'https://example.com/a/b?q=1', true],
    ['https://example.com/*', 'https://example.com:8443/a', true], // no port in pattern = any port
    ['https://example.com/*', 'http://example.com/a', false],
    ['https://example.com/*', 'https://sub.example.com/a', false],
    ['https://*.example.com/*', 'https://sub.example.com/a', true],
    ['https://*.example.com/*', 'https://example.com/a', true],
    ['https://*.example.com/*', 'https://badexample.com/a', false],
    ['https://*/*', 'https://anything.test/', true],
    ['https://*/*', 'http://anything.test/', false],
    ['*://example.com/*', 'http://example.com/', true],
    ['http://127.0.0.1/*', 'http://127.0.0.1:41234/page', true],
    ['http://127.0.0.1:8080/*', 'http://127.0.0.1:8080/page', true],
    ['http://127.0.0.1:8080/*', 'http://127.0.0.1:9090/page', false],
    ['https://example.com:443/*', 'https://example.com/page', true],
    ['https://my_host.example.com/*', 'https://my_host.example.com/a', true],
    ['https://*.my_host.example.com/*', 'https://sub.my_host.example.com/a', true],
    ['http://[::1]/*', 'http://[::1]:3000/page', true],
    ['http://[::1]:3000/*', 'http://[::1]:3000/page', true],
    ['http://[::1]:3000/*', 'http://[::1]:4000/page', false],
    ['http://[2001:db8::1]/*', 'http://[2001:db8::1]/', true],
    ['<all_urls>', 'https://example.com/', false],
    ['https://example.com/path/*', 'https://example.com/path/x', false], // only origin-wide patterns
  ];
  it.each(cases)('%s vs %s -> %s', (pattern, url, expected) => {
    expect(patternCovers(pattern, new URL(url))).toBe(expected);
  });
});

describe('site.sync', () => {
  it('registers one script from persistentOrigins ∩ granted, with deny-list excludeMatches', async () => {
    const t = setup(
      {
        persistentOrigins: ['https://a.example/*', 'https://b.example/*', 'https://c.example/*'],
        denyList: ['accounts.google.com', 'PayPal.com'],
      },
      { granted: ['https://a.example/*', 'https://c.example/*'] },
    );
    const out = await t.site.sync();
    expect(out.registeredMatches).toEqual(['https://a.example/*', 'https://c.example/*']);
    expect(t.deps.register).toHaveBeenCalledOnce();
    expect(t.deps.register).toHaveBeenCalledWith({
      id: PERSISTENT_SCRIPT_ID,
      js: [CONTENT_SCRIPT_FILE],
      matches: ['https://a.example/*', 'https://c.example/*'],
      excludeMatches: ['*://*.accounts.google.com/*', '*://*.paypal.com/*'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
      allFrames: false,
    });
  });

  it('is idempotent: a second sync updates the existing registration instead of failing', async () => {
    const t = setup(
      { persistentOrigins: ['https://a.example/*'], denyList: [] },
      { granted: ['https://a.example/*'] },
    );
    await t.site.sync();
    await t.site.sync();
    expect(t.calls).toEqual(['register', 'update']);
    expect(t.state.registered).toEqual(['https://a.example/*']);
  });

  it('updates when the registered set drifted from settings', async () => {
    const t = setup(
      { persistentOrigins: ['https://new.example/*'], denyList: [] },
      { granted: ['https://new.example/*'], registered: ['https://old.example/*'] },
    );
    await t.site.sync();
    expect(t.calls).toEqual(['update']);
    expect(t.state.registered).toEqual(['https://new.example/*']);
  });

  it('unregisters when nothing is both enabled and granted (permission revoked)', async () => {
    const t = setup(
      { persistentOrigins: ['https://a.example/*'] },
      { granted: [], registered: ['https://a.example/*'] },
    );
    expect(await t.site.sync()).toEqual({ registeredMatches: [] });
    expect(t.calls).toEqual(['unregister']);
  });

  it('does nothing when there is nothing to register and nothing registered', async () => {
    const t = setup({ persistentOrigins: [] });
    expect(await t.site.sync()).toEqual({ registeredMatches: [] });
    expect(t.calls).toEqual([]);
  });

  it('drops patterns Chrome would reject and deny entries that cannot be patterns', async () => {
    const t = setup(
      {
        persistentOrigins: [
          'https://good.example/*',
          'https://good.example/*',
          'not a pattern',
          '<all_urls>',
          'https://example.com/only/path/*',
          'javascript://x/*',
        ],
        denyList: ['ok.example', '*.wild.example', 'with/path', 'host:8080', 'ok.example'],
      },
      { granted: ['https://good.example/*', 'not a pattern'] },
    );
    const out = await t.site.sync();
    expect(out.registeredMatches).toEqual(['https://good.example/*']);
    expect(t.deps.register.mock.calls[0]![0].excludeMatches).toEqual(['*://*.ok.example/*']);
    expect(t.deps.hasPermission).not.toHaveBeenCalledWith('not a pattern');
  });

  it('registers hosts with underscores and bracketed IPv6 literals instead of dropping them', async () => {
    const patterns = ['https://my_host.example.com/*', 'http://[::1]:3000/*', 'http://[::1]/*'];
    const t = setup({ persistentOrigins: patterns, denyList: [] }, { granted: patterns });
    expect((await t.site.sync()).registeredMatches).toEqual(patterns);
    expect(t.state.registered).toEqual(patterns);
  });

  it('turns deny entries into excludeMatches after normalising case and a trailing dot', async () => {
    const t = setup(
      {
        persistentOrigins: ['https://*/*'],
        denyList: ['PayPal.com.', 'my_host.example', 'x.test'],
      },
      { granted: ['https://*/*'] },
    );
    await t.site.sync();
    expect(t.deps.register.mock.calls[0]![0].excludeMatches).toEqual([
      '*://*.paypal.com/*',
      '*://*.my_host.example/*',
      '*://*.x.test/*',
    ]);
  });

  it('accepts broad "all sites" patterns', async () => {
    const t = setup(
      { persistentOrigins: ['https://*/*', 'http://*/*'], denyList: [] },
      { granted: ['https://*/*', 'http://*/*'] },
    );
    expect((await t.site.sync()).registeredMatches).toEqual(['https://*/*', 'http://*/*']);
  });
});

describe('site.sync reconciles with what Chrome grants', () => {
  it('registers a grant that settings never heard of (given in chrome://extensions) and remembers it', async () => {
    const t = setup({ persistentOrigins: [] }, { granted: ['https://given.example/*'] });
    expect(await t.site.sync()).toEqual({ registeredMatches: ['https://given.example/*'] });
    expect(t.state.registered).toEqual(['https://given.example/*']);
    expect(t.deps.rememberOrigins).toHaveBeenCalledWith(['https://given.example/*']);
  });

  it('treats an all-sites grant reported as <all_urls> as both web schemes', async () => {
    const t = setup({ persistentOrigins: [] }, { granted: [], grantedList: ['<all_urls>'] });
    expect((await t.site.sync()).registeredMatches).toEqual(['https://*/*', 'http://*/*']);
  });

  it('keeps the exact patterns the user asked for while a broader grant covers them', async () => {
    // Chrome reports only the broad grant; "https://a.example/*" is covered by it.
    const t = setup(
      { persistentOrigins: ['https://a.example/*'], denyList: [] },
      { granted: ['https://a.example/*', 'https://*/*'], grantedList: ['https://*/*'] },
    );
    expect((await t.site.sync()).registeredMatches).toEqual(['https://a.example/*', 'https://*/*']);
    // The hint learns about the broad grant, so the options page shows what is really running.
    expect(t.deps.rememberOrigins).toHaveBeenCalledWith(['https://a.example/*', 'https://*/*']);
  });

  it('forgets a hint Chrome no longer covers and unregisters', async () => {
    const t = setup(
      { persistentOrigins: ['https://old.example/*'] },
      { granted: [], registered: ['https://old.example/*'] },
    );
    expect(await t.site.sync()).toEqual({ registeredMatches: [] });
    expect(t.calls).toEqual(['unregister']);
    expect(t.deps.rememberOrigins).toHaveBeenCalledWith([]);
  });

  it('does not touch the user choices when Chrome cannot be asked, and falls back to the hints', async () => {
    const t = setup(
      { persistentOrigins: ['https://a.example/*', 'https://gone.example/*'] },
      { granted: ['https://a.example/*'], grantedList: null },
    );
    expect(await t.site.sync()).toEqual({ registeredMatches: ['https://a.example/*'] });
    expect(t.deps.rememberOrigins).not.toHaveBeenCalled();
  });

  it('does not write settings when they already match', async () => {
    const t = setup(
      { persistentOrigins: ['https://a.example/*', 'https://b.example/*'] },
      { granted: ['https://b.example/*', 'https://a.example/*'] },
    );
    await t.site.sync();
    expect(t.deps.rememberOrigins).not.toHaveBeenCalled();
  });

  it('survives a failed settings write: the registration is still made', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = setup({ persistentOrigins: [] }, { granted: ['https://a.example/*'] });
    t.deps.rememberOrigins.mockRejectedValueOnce(new Error('storage down'));
    expect(await t.site.sync()).toEqual({ registeredMatches: ['https://a.example/*'] });
    expect(warn).toHaveBeenCalled();
  });
});

describe('site.status', () => {
  it('reports unsupported schemes without probing the tab', async () => {
    const t = setup();
    for (const url of ['chrome://extensions', 'file:///C:/x.html', 'about:blank', 'not a url']) {
      expect(await t.site.status({ tabId: 1, url })).toEqual({
        supported: false,
        denied: false,
        pattern: null,
        access: 'none',
        active: false,
        allSites: false,
      });
    }
    expect(t.deps.isActive).not.toHaveBeenCalled();
  });

  it('supported page with no persistent access (activeTab may still apply)', async () => {
    const t = setup();
    expect(await t.site.status({ tabId: 1, url: 'https://example.com/page' })).toEqual({
      supported: true,
      denied: false,
      pattern: 'https://example.com/*',
      access: 'none',
      active: false,
      allSites: false,
    });
  });

  it('persistent when a registered script covers the page and the origin is granted', async () => {
    const t = setup(
      {},
      { granted: ['https://example.com/*'], registered: ['https://example.com/*'] },
    );
    t.state.active = true;
    const status = await t.site.status({ tabId: 1, url: 'https://example.com/page' });
    expect(status).toMatchObject({ access: 'persistent', active: true });
  });

  it('persistent under an all-sites registration', async () => {
    const t = setup({}, { granted: ['https://example.com/*'], registered: ['https://*/*'] });
    expect((await t.site.status({ tabId: 1, url: 'https://example.com/p' })).access).toBe(
      'persistent',
    );
  });

  describe('allSites is what Chrome grants and a registration covers, not a stored flag', () => {
    const status = (t: ReturnType<typeof setup>, url = 'https://example.com/p') =>
      t.site.status({ tabId: 1, url });

    it('is true with an all-sites grant and an all-sites registration', async () => {
      const t = setup(
        { persistentOrigins: [] },
        {
          granted: ['https://example.com/*', 'https://*/*'],
          grantedList: ['https://*/*'],
          registered: ['https://*/*'],
        },
      );
      expect(await status(t)).toMatchObject({ allSites: true, access: 'persistent' });
    });

    it('is true when Chrome reports the grant as <all_urls>', async () => {
      const t = setup(
        {},
        {
          granted: ['https://example.com/*'],
          grantedList: ['<all_urls>'],
          registered: ['https://*/*'],
        },
      );
      expect((await status(t)).allSites).toBe(true);
    });

    it('is false when the setting says all sites but Chrome revoked the grant', async () => {
      const t = setup(
        { persistentOrigins: ['https://*/*', 'http://*/*'] },
        { granted: [], registered: ['https://*/*'] },
      );
      expect((await status(t)).allSites).toBe(false);
    });

    it('is false when the grant is there but nothing is registered that covers the page', async () => {
      const t = setup({}, { granted: ['https://*/*'], registered: null });
      expect((await status(t)).allSites).toBe(false);
      const narrow = setup({}, { granted: ['https://*/*'], registered: ['https://example.com/*'] });
      expect((await status(narrow)).allSites).toBe(false);
    });

    it('is false for one-site grants, for another scheme and for a denied host', async () => {
      const oneSite = setup(
        {},
        { granted: ['https://example.com/*'], registered: ['https://example.com/*'] },
      );
      expect((await status(oneSite)).allSites).toBe(false);

      const httpsOnly = setup({}, { granted: ['https://*/*'], registered: ['https://*/*'] });
      expect((await status(httpsOnly, 'http://example.com/p')).allSites).toBe(false);

      const denied = setup(
        { denyList: ['example.com'] },
        { granted: ['https://*/*'], registered: ['https://*/*'] },
      );
      expect(await status(denied)).toMatchObject({ denied: true, allSites: false });
    });

    it('is false when Chrome cannot be asked', async () => {
      const t = setup(
        {},
        { granted: ['https://*/*'], grantedList: null, registered: ['https://*/*'] },
      );
      expect((await status(t)).allSites).toBe(false);
    });
  });

  it('none when registered but the permission was revoked since', async () => {
    const t = setup({}, { granted: [], registered: ['https://example.com/*'] });
    expect((await t.site.status({ tabId: 1, url: 'https://example.com/p' })).access).toBe('none');
  });

  it('a trailing-dot spelling of a denied host is denied too', async () => {
    const t = setup({ denyList: ['paypal.com'] });
    for (const url of ['https://paypal.com./pay', 'https://www.paypal.com./pay']) {
      expect(await t.site.status({ tabId: 1, url }), url).toMatchObject({
        supported: true,
        denied: true,
        access: 'none',
      });
    }
  });

  it('denied host is reported denied and never persistent', async () => {
    const t = setup(
      { denyList: ['example.com'] },
      { granted: ['https://shop.example.com/*'], registered: ['https://shop.example.com/*'] },
    );
    expect(await t.site.status({ tabId: 1, url: 'https://shop.example.com/cart' })).toMatchObject({
      supported: true,
      denied: true,
      access: 'none',
    });
  });
});

describe('tab.activate', () => {
  it('injects when the content script is not running and waits for it to answer', async () => {
    const t = setup();
    await t.site.activate(5);
    expect(t.deps.inject).toHaveBeenCalledWith(5);
  });

  it('does not inject twice when a script already answers', async () => {
    const t = setup();
    t.state.active = true;
    await t.site.activate(5);
    expect(t.deps.inject).not.toHaveBeenCalled();
  });

  it('refuses unsupported schemes before injecting', async () => {
    for (const url of ['chrome://extensions', 'file:///C:/x.html', 'about:blank']) {
      const t = setup({}, { url });
      const err = await failure(t.site.activate(5));
      expect(err.code, url).toBe('unsupported_page');
      expect(err.message).toMatch(/cannot run on this page/);
      expect(t.deps.inject).not.toHaveBeenCalled();
    }
  });

  it('refuses deny-listed hosts with forbidden', async () => {
    const t = setup({}, { url: 'https://mail.google.com/mail/u/0/' });
    const err = await failure(t.site.activate(5));
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain('mail.google.com');
    expect(t.deps.inject).not.toHaveBeenCalled();
  });

  it('refuses a deny-listed host written with a trailing dot (same server, same rule)', async () => {
    for (const url of [
      'https://paypal.com./signin',
      'https://www.paypal.com./signin',
      'https://MAIL.GOOGLE.COM./mail/u/0/',
    ]) {
      const t = setup({}, { url });
      const err = await failure(t.site.activate(5));
      expect(err.code, url).toBe('forbidden');
      expect(t.deps.inject, url).not.toHaveBeenCalled();
    }
  });

  it('maps a closed tab to not_found', async () => {
    const t = setup();
    t.deps.tabUrl.mockRejectedValueOnce(new Error('No tab with id: 5.'));
    expect((await failure(t.site.activate(5))).code).toBe('not_found');
  });

  it('maps injection failures from restricted pages to unsupported_page', async () => {
    for (const message of [
      'Cannot access a chrome:// URL',
      'The extensions gallery cannot be scripted.',
      'Cannot access contents of url "chrome-extension://abc/page.html". Extension manifest must request permission to access this host.',
      'Cannot access "file:///C:/x.html" without allow file access',
      'This page cannot be scripted due to an ExtensionsSettings policy.',
    ]) {
      const t = setup();
      t.deps.inject.mockRejectedValueOnce(new Error(message));
      const err = await failure(t.site.activate(5));
      expect(err.code, message).toBe('unsupported_page');
    }
  });

  it('maps a missing grant on an unreadable tab to forbidden with guidance', async () => {
    const t = setup({}, { url: undefined });
    t.deps.inject.mockRejectedValueOnce(
      new Error(
        'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      ),
    );
    const err = await failure(t.site.activate(5));
    expect(err.code).toBe('forbidden');
    expect(err.message).toMatch(/toolbar icon/);
  });

  it('keeps the browser reason for an unknown failure on a readable http page', async () => {
    const t = setup();
    t.deps.inject.mockRejectedValueOnce(new Error('Frame is showing error page'));
    const err = await failure(t.site.activate(5));
    expect(err.code).toBe('unsupported_page');
    expect(err.message).toContain('Frame is showing error page');
  });

  it('maps a tab closed mid-injection to not_found', async () => {
    const t = setup();
    t.deps.inject.mockRejectedValueOnce(new Error('The tab was closed.'));
    expect((await failure(t.site.activate(5))).code).toBe('not_found');
  });

  it('polls until the injected script answers, then returns', async () => {
    const t = setup();
    let pings = 0;
    t.deps.isActive.mockImplementation(async () => t.state.active && ++pings > 3);
    t.deps.isActive.mockResolvedValueOnce(false); // initial "already running?" probe
    await t.site.activate(5);
    expect(t.deps.sleep).toHaveBeenCalled();
    expect(pings).toBe(4);
  });

  it('fails with internal when the injected script never answers', async () => {
    const t = setup();
    t.deps.inject.mockImplementation(async () => undefined);
    const err = await failure(t.site.activate(5));
    expect(err.code).toBe('internal');
    expect(err.message).toMatch(/did not start/);
  });
});

describe('tab.activate never waits forever', () => {
  afterEach(() => vi.useRealTimers());
  const never = () => new Promise<never>(() => undefined);

  /** Starts the activation, lets the clock run out, and returns the error it settled with. */
  async function afterDeadline(promise: Promise<unknown>): Promise<StudyVaultError> {
    const outcome = failure(promise);
    await vi.advanceTimersByTimeAsync(ACTIVATE_TIMEOUT_MS);
    return outcome;
  }

  it('a view-source: tab (address hidden, executeScript never settles) is unsupported_page', async () => {
    vi.useFakeTimers();
    const t = setup({}, { url: undefined });
    t.deps.inject.mockImplementation(never);
    const err = await afterDeadline(t.site.activate(5));
    expect(err.code).toBe('unsupported_page');
    expect(err.message).toMatch(/view-source/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers at the deadline, not before', async () => {
    vi.useFakeTimers();
    const t = setup({}, { url: undefined });
    t.deps.inject.mockImplementation(never);
    let settled = false;
    const outcome = failure(t.site.activate(5)).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(ACTIVATE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome).code).toBe('unsupported_page');
  });

  it('a hung injection into a normal http page is no_receiver, not a restricted-page claim', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.deps.inject.mockImplementation(never);
    const err = await afterDeadline(t.site.activate(5));
    expect(err.code).toBe('no_receiver');
    expect(err.message).toMatch(/Reload it and try again/);
  });

  it('a tab lookup that never answers is no_receiver', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.deps.tabUrl.mockImplementation(never);
    const err = await afterDeadline(t.site.activate(5));
    expect(err.code).toBe('no_receiver');
    expect(t.deps.inject).not.toHaveBeenCalled();
  });

  it('a script that was injected but whose ping never settles is internal "did not start"', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.deps.isActive.mockResolvedValueOnce(false).mockImplementation(never);
    const err = await afterDeadline(t.site.activate(5));
    expect(err.code).toBe('internal');
    expect(err.message).toMatch(/did not start/);
  });

  it('stops polling once it has given up', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.deps.isActive.mockResolvedValue(false);
    t.deps.sleep.mockImplementation(
      (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms * 10)),
    );
    const err = await afterDeadline(t.site.activate(5));
    expect(err.code).toBe('internal');
    const callsAtDeadline = t.deps.isActive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.deps.isActive.mock.calls.length).toBeLessThanOrEqual(callsAtDeadline + 1);
  });

  it('leaves no timer behind after a normal activation or an ordinary refusal', async () => {
    vi.useFakeTimers();
    await setup().site.activate(5);
    expect(vi.getTimerCount()).toBe(0);
    await failure(setup({}, { url: 'chrome://extensions' }).site.activate(5));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('mapInjectionError', () => {
  it('stringifies non-Error values', () => {
    expect(mapInjectionError('boom', 'https://example.com/').code).toBe('unsupported_page');
  });

  it('treats view-source: and devtools pages as restricted, not as a missing grant', () => {
    for (const text of [
      'Cannot access contents of url "view-source:http://example.com/". Extension manifest must request permission to access this host.',
      'Cannot access contents of url "devtools://devtools/bundled/inspector.html".',
    ]) {
      expect(mapInjectionError(new Error(text), undefined).code, text).toBe('unsupported_page');
    }
  });
});

describe('pingWithTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('is true when the tab answers and false when it rejects', async () => {
    expect(await pingWithTimeout(async () => ({ ready: true }), 50)).toBe(true);
    expect(
      await pingWithTimeout(() => Promise.reject(new Error('Receiving end does not exist.')), 50),
    ).toBe(false);
  });

  it('is false when the tab never answers, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const result = pingWithTimeout(() => new Promise(() => undefined), 800);
    await vi.advanceTimersByTimeAsync(800);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout once the ping answered', async () => {
    vi.useFakeTimers();
    expect(await pingWithTimeout(async () => true, 800)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
