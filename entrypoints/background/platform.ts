import { browser } from 'wxt/browser';
import { PENDING_SEARCH_KEY, StudyVaultError } from '@shared';
import { callTab, getTrustedSettings, updateSettings } from '@runtime';
import { dashboardUrl } from '@ui/vault/dashboardLink'; // imports only wxt/browser: no UI in the worker
import type { Badge, CommandDeps, MenuPort } from './commands';
import type { SessionArea } from './handlers';
import {
  CONTENT_SCRIPT_FILE,
  PERSISTENT_SCRIPT_ID,
  PING_TIMEOUT_MS,
  pingWithTimeout,
  type SiteAccess,
  type SiteAccessDeps,
} from './siteAccess';

/** Real Chrome adapters for the injected ports. Thin on purpose: logic lives in the tested modules. */

const BADGE_MS = 3000;
// scripting.executeScript takes extension-root paths; WXT types them with a leading slash.
const INJECT_FILE = `/${CONTENT_SCRIPT_FILE}` as const;
const BADGE_COLORS = { success: '#15803d', error: '#b91c1c' } as const;

const ALL_SITES_PATTERNS = new Set(['https://*/*', 'http://*/*', '*://*/*', '<all_urls>']);

export function browserSiteDeps(): SiteAccessDeps {
  return {
    // The authoritative copy (deny list, hint): a content script can write chrome.storage.local.
    getSettings: getTrustedSettings,
    hasPermission: (origin) =>
      browser.permissions.contains({ origins: [origin] }).catch(() => false),
    grantedOrigins: async () => {
      try {
        // Install-time host_permissions are not a user choice and cannot be revoked, so only the
        // OPTIONAL grants decide persistent registration. Production declares none; the e2e build
        // declares loopback, which must not turn the script on for every loopback page.
        const fixed = new Set(browser.runtime.getManifest().host_permissions ?? []);
        // A per-origin grant is NOT site access by itself: the AI endpoint, the sync server and a
        // PDF's origin are granted for fetching data, and must never get the highlighter injected.
        // Those origins count only when the user enabled the site in StudyVault (the settings hint,
        // merged by sync()). What Chrome's own "site access: all sites" toggle produces is an
        // all-sites pattern, which is a deliberate broad choice, so it counts without a hint.
        return ((await browser.permissions.getAll()).origins ?? []).filter(
          (o) => !fixed.has(o) && ALL_SITES_PATTERNS.has(o),
        );
      } catch {
        return null;
      }
    },
    rememberOrigins: async (origins) => {
      await updateSettings((s) => ({ ...s, persistentOrigins: origins }));
    },
    registeredMatches: async () => {
      const [script] = await browser.scripting.getRegisteredContentScripts({
        ids: [PERSISTENT_SCRIPT_ID],
      });
      return script ? (script.matches ?? []) : null;
    },
    register: (script) => browser.scripting.registerContentScripts([script]),
    update: (script) => browser.scripting.updateContentScripts([script]),
    unregister: () => browser.scripting.unregisterContentScripts({ ids: [PERSISTENT_SCRIPT_ID] }),
    tabUrl: async (tabId) => (await browser.tabs.get(tabId)).url,
    inject: async (tabId) => {
      await browser.scripting.executeScript({ target: { tabId }, files: [INJECT_FILE] });
    },
    isActive: (tabId) => pingWithTimeout(() => callTab(tabId, 'content.ping', {}), PING_TIMEOUT_MS),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function browserSessionArea(): SessionArea {
  return browser.storage.session;
}

/** Open the side panel for one tab. Call it before awaiting anything: it needs the user gesture. */
export function browserOpenSidePanel(tabId: number): Promise<void> {
  return browser.sidePanel.open({ tabId });
}

/** Tab-scoped badge text, colour and tooltip; navigation also resets tab-scoped values. */
export function createBadgePort(defaultTitle: string, ms = BADGE_MS) {
  return async (tabId: number, badge: Badge): Promise<void> => {
    await browser.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[badge.tone] });
    await browser.action.setBadgeText({ tabId, text: badge.text });
    await browser.action.setTitle({ tabId, title: badge.title });
    setTimeout(() => {
      // Best effort: the worker may be suspended before this fires. A tab-scoped value hides the
      // global one until the tab navigates, even an empty one, so put back what every other tab
      // shows (the due count, when the person turned reminders on) instead of blanking this one.
      void (async () => {
        const text = await browser.action.getBadgeText({});
        const title = (await browser.action.getTitle({})) || defaultTitle;
        await browser.action.setBadgeText({ tabId, text });
        await browser.action.setTitle({ tabId, title });
        const color = await browser.action.getBadgeBackgroundColor({});
        await browser.action.setBadgeBackgroundColor({ tabId, color });
      })().catch(() => undefined);
    }, ms);
  };
}

export function browserCommandDeps(site: SiteAccess): CommandDeps {
  const defaultTitle = browser.runtime.getManifest().action?.default_title ?? 'StudyVault AI';
  return {
    activate: (tabId) => site.activate(tabId),
    captureSelection: (tabId, method) =>
      callTab(tabId, 'content.captureSelection', { method, bankId: null }),
    allowIncognitoCapture: async () => (await getTrustedSettings()).allowIncognitoCapture,
    focusToolbar: (tabId) => callTab(tabId, 'content.focusToolbar', {}),
    stepHighlight: (tabId, direction) => callTab(tabId, 'content.stepHighlight', { direction }),
    isDashboardUrl: (url) => {
      if (!url) return false;
      const page = dashboardUrl();
      return url === page || url.startsWith(`${page}?`) || url.startsWith(`${page}#`);
    },
    requestSearchFocus: (target) =>
      browser.storage.session.set({ [PENDING_SEARCH_KEY]: { target, at: Date.now() } }),
    openSidePanel: async (windowId) => {
      try {
        await browser.sidePanel.open({ windowId });
      } catch (err) {
        throw new StudyVaultError(
          'internal',
          `Could not open the side panel: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    showBadge: createBadgePort(defaultTitle),
  };
}

export function browserMenuPort(): MenuPort {
  return {
    removeAll: () => browser.contextMenus.removeAll(),
    create: (item) =>
      new Promise((resolve, reject) => {
        browser.contextMenus.create(item, () => {
          const error = browser.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      }),
  };
}
