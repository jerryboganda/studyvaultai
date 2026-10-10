import {
  StudyVaultError,
  isHostDenied,
  originPattern,
  parseHttpUrl,
  type Settings,
  type SiteStatus,
} from '@shared';

/** Site access (ADR-003): the persistent dynamic content script and on-demand injection. */

export const PERSISTENT_SCRIPT_ID = 'sv-persistent';
export const CONTENT_SCRIPT_FILE = 'content-scripts/highlighter.js';
export const PING_TIMEOUT_MS = 800;

const READY_ATTEMPTS = 10;
const READY_DELAY_MS = 100;

export interface PersistentScript {
  id: string;
  js: string[];
  matches: string[];
  excludeMatches: string[];
  runAt: 'document_idle';
  persistAcrossSessions: true;
  allFrames: false;
}

/** Everything that touches Chrome. Real adapters live in platform.ts; tests inject fakes. */
export interface SiteAccessDeps {
  getSettings(): Promise<Settings>;
  /** True when `origin` (a match pattern) is covered by granted host permissions. */
  hasPermission(origin: string): Promise<boolean>;
  /** `matches` of the registered persistent script, or null when it is not registered. */
  registeredMatches(): Promise<string[] | null>;
  register(script: PersistentScript): Promise<void>;
  update(script: PersistentScript): Promise<void>;
  unregister(): Promise<void>;
  /** The tab's URL; undefined when Chrome hides it (no activeTab/host access). Rejects for a closed tab. */
  tabUrl(tabId: number): Promise<string | undefined>;
  /** Inject the content script file (needs activeTab or host access). */
  inject(tabId: number): Promise<void>;
  /** A StudyVault content script answers `content.ping` in this tab (bounded wait). */
  isActive(tabId: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface SiteAccess {
  status(input: { tabId: number; url: string }): Promise<SiteStatus>;
  sync(): Promise<{ registeredMatches: string[] }>;
  /** Resolves when a content script is answering in the tab; throws StudyVaultError otherwise. */
  activate(tabId: number): Promise<void>;
}

// scheme://host[:port]/*  (scheme may be *, host may be * or *.name). We only ever register origin-wide patterns.
const PATTERN = /^(\*|https?):\/\/(\*|(?:\*\.)?[a-z0-9.-]+)(?::(\*|\d{1,5}))?\/\*$/i;
// Deny entries become `*://*.host/*`; anything with wildcards, ports or paths cannot be expressed.
const DENY_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Does match pattern `pattern` cover `url`? Pattern host without a port matches every port. */
export function patternCovers(pattern: string, url: URL): boolean {
  const m = PATTERN.exec(pattern);
  if (!m) return false;
  const [, scheme = '', host = '', port] = m;
  const urlScheme = url.protocol.slice(0, -1);
  if (scheme !== '*' ? scheme.toLowerCase() !== urlScheme : !/^https?$/.test(urlScheme))
    return false;
  if (port !== undefined && port !== '*') {
    if (port !== (url.port || (urlScheme === 'https' ? '443' : '80'))) return false;
  }
  const h = host.toLowerCase();
  if (h === '*') return true;
  if (h.startsWith('*.')) {
    const base = h.slice(2);
    return url.hostname === base || url.hostname.endsWith(`.${base}`);
  }
  return url.hostname === h;
}

export async function pingWithTimeout(ping: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      ping().then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chrome reports injection failures as free text. Map the known restricted-page families to
 * `unsupported_page`, a missing grant to `forbidden`, and keep the reason for anything unknown.
 */
export function mapInjectionError(err: unknown, tabUrl: string | undefined): StudyVaultError {
  const text = err instanceof Error ? err.message : String(err);
  if (/no tab with id|tab was closed|was removed/i.test(text)) {
    return new StudyVaultError('not_found', 'That tab is no longer open.');
  }
  if (
    /chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|extensions gallery|web store|file:|policy/i.test(
      text,
    )
  ) {
    return new StudyVaultError(
      'unsupported_page',
      'Chrome does not let extensions run on this page (browser pages, the Chrome Web Store, local files and managed pages are blocked).',
    );
  }
  if (tabUrl === undefined && /must request permission|cannot access contents/i.test(text)) {
    return new StudyVaultError(
      'forbidden',
      'StudyVault has not been given access to this tab yet. Click the StudyVault toolbar icon or use its shortcut on the page, then try again.',
    );
  }
  return new StudyVaultError(
    'unsupported_page',
    `StudyVault cannot run on this page (${text}). Browser pages, the Chrome Web Store and the built-in PDF viewer are blocked by Chrome.`,
  );
}

export function createSiteAccess(deps: SiteAccessDeps): SiteAccess {
  // One sync at a time across the worker and extension pages (same origin => shared Web Locks).
  const exclusive = <T>(run: () => Promise<T>): Promise<T> =>
    globalThis.navigator?.locks ? navigator.locks.request('studyvault-site-sync', run) : run();

  async function waitUntilActive(tabId: number): Promise<boolean> {
    for (let i = 0; i < READY_ATTEMPTS; i++) {
      if (await deps.isActive(tabId)) return true;
      await deps.sleep(READY_DELAY_MS);
    }
    return false;
  }

  return {
    async status({ tabId, url }) {
      const page = parseHttpUrl(url);
      if (!page)
        return { supported: false, denied: false, pattern: null, access: 'none', active: false };
      const settings = await deps.getSettings();
      const denied = isHostDenied(page.hostname, settings.denyList);
      const pattern = originPattern(url);
      const [registered, active] = await Promise.all([
        deps.registeredMatches(),
        deps.isActive(tabId),
      ]);
      // "persistent" is only true when a registered script really covers this page and Chrome
      // still grants the origin; a denied host is excluded from the registration.
      const covered = !denied && !!registered?.some((m) => patternCovers(m, page));
      const access = covered && pattern !== null && (await deps.hasPermission(pattern));
      return { supported: true, denied, pattern, access: access ? 'persistent' : 'none', active };
    },

    sync() {
      return exclusive(async () => {
        const settings = await deps.getSettings();
        const candidates = [...new Set(settings.persistentOrigins)].filter((p) => PATTERN.test(p));
        const granted = await Promise.all(candidates.map((p) => deps.hasPermission(p)));
        const matches = candidates.filter((_, i) => granted[i]);
        const registered = await deps.registeredMatches();
        if (matches.length === 0) {
          if (registered !== null) await deps.unregister();
          return { registeredMatches: [] };
        }
        const excludeMatches = [
          ...new Set(
            settings.denyList
              .map((h) => h.trim().toLowerCase())
              .filter((h) => DENY_HOST.test(h))
              .map((h) => `*://*.${h}/*`),
          ),
        ];
        const script: PersistentScript = {
          id: PERSISTENT_SCRIPT_ID,
          js: [CONTENT_SCRIPT_FILE],
          matches,
          excludeMatches,
          runAt: 'document_idle',
          persistAcrossSessions: true,
          allFrames: false,
        };
        await (registered === null ? deps.register(script) : deps.update(script));
        return { registeredMatches: matches };
      });
    },

    async activate(tabId) {
      let url: string | undefined;
      try {
        url = await deps.tabUrl(tabId);
      } catch {
        throw new StudyVaultError('not_found', 'That tab is no longer open.');
      }
      if (url !== undefined) {
        const page = parseHttpUrl(url);
        if (!page) {
          throw new StudyVaultError(
            'unsupported_page',
            'StudyVault cannot run on this page. Chrome blocks extensions on browser pages, the Chrome Web Store and local files.',
          );
        }
        const settings = await deps.getSettings();
        if (isHostDenied(page.hostname, settings.denyList)) {
          throw new StudyVaultError(
            'forbidden',
            `StudyVault is turned off on ${page.hostname}. Remove it from the deny list in Settings to use it here.`,
          );
        }
      }
      // Already running (persistent registration or an earlier activation): never inject twice.
      if (await deps.isActive(tabId)) return;
      try {
        await deps.inject(tabId);
      } catch (err) {
        throw mapInjectionError(err, url);
      }
      if (!(await waitUntilActive(tabId))) {
        throw new StudyVaultError(
          'internal',
          'StudyVault was injected but did not start on this page. Reload the tab and try again.',
        );
      }
    },
  };
}
