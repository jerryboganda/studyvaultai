import {
  DENY_HOST,
  MATCH_PATTERN,
  StudyVaultError,
  isHostDenied,
  normalizeHost,
  originPattern,
  parseHttpUrl,
  type Settings,
  type SiteStatus,
} from '@shared';

/** Site access (ADR-003): the persistent dynamic content script and on-demand injection. */

export const PERSISTENT_SCRIPT_ID = 'sv-persistent';
export const CONTENT_SCRIPT_FILE = 'content-scripts/highlighter.js';
export const PING_TIMEOUT_MS = 800;
/**
 * Upper bound for one activation. Chrome calls here can hang forever: scripting.executeScript
 * never settles on a view-source: tab, for example. Whatever hangs, the caller gets an answer.
 */
export const ACTIVATE_TIMEOUT_MS = 5000;

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

/** Does match pattern `pattern` cover `url`? Pattern host without a port matches every port. */
export function patternCovers(pattern: string, url: URL): boolean {
  const m = MATCH_PATTERN.exec(pattern);
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
    /chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|view-source:|devtools:|extensions gallery|web store|file:|policy/i.test(
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

type ActivateStage = 'inspect' | 'inject' | 'start';

const scriptDidNotStart = () =>
  new StudyVaultError(
    'internal',
    'StudyVault was injected but did not start on this page. Reload the tab and try again.',
  );

/** The answer for an activation that ran out of time, by how far it got. Never a bare "timed out". */
export function activationTimeout(
  stage: ActivateStage,
  tabUrl: string | undefined,
): StudyVaultError {
  if (stage === 'start') return scriptDidNotStart();
  if (stage === 'inject' && (tabUrl === undefined || parseHttpUrl(tabUrl) === null)) {
    return new StudyVaultError(
      'unsupported_page',
      'StudyVault cannot run on this page. Chrome gave no answer when StudyVault tried to start here, which is how it treats view-source: pages, browser pages, the Chrome Web Store and other pages it protects. Open the page itself and try again.',
    );
  }
  return new StudyVaultError(
    'no_receiver',
    'Chrome did not answer when StudyVault tried to start on this tab. The tab may still be loading or may have stopped responding. Reload it and try again.',
  );
}

export function createSiteAccess(deps: SiteAccessDeps): SiteAccess {
  // One sync at a time across the worker and extension pages (same origin => shared Web Locks).
  const exclusive = <T>(run: () => Promise<T>): Promise<T> =>
    globalThis.navigator?.locks ? navigator.locks.request('studyvault-site-sync', run) : run();

  async function waitUntilActive(tabId: number, expired: () => boolean): Promise<boolean> {
    for (let i = 0; i < READY_ATTEMPTS && !expired(); i++) {
      if (await deps.isActive(tabId)) return true;
      await deps.sleep(READY_DELAY_MS);
    }
    return false;
  }

  /** `run` is what the deadline needs to know: how far activation got and whether it gave up. */
  async function activateTab(
    tabId: number,
    run: { stage: ActivateStage; url: string | undefined; expired: boolean },
  ): Promise<void> {
    try {
      run.url = await deps.tabUrl(tabId);
    } catch {
      throw new StudyVaultError('not_found', 'That tab is no longer open.');
    }
    const url = run.url;
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
    run.stage = 'inject';
    try {
      await deps.inject(tabId);
    } catch (err) {
      throw mapInjectionError(err, url);
    }
    run.stage = 'start';
    if (!(await waitUntilActive(tabId, () => run.expired))) throw scriptDidNotStart();
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
        const candidates = [...new Set(settings.persistentOrigins)].filter((p) =>
          MATCH_PATTERN.test(p),
        );
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
              .map(normalizeHost)
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
      const run = {
        stage: 'inspect' as ActivateStage,
        url: undefined as string | undefined,
        expired: false,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          run.expired = true;
          reject(activationTimeout(run.stage, run.url));
        }, ACTIVATE_TIMEOUT_MS);
      });
      try {
        await Promise.race([activateTab(tabId, run), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
