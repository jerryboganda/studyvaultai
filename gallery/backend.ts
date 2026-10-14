import { BackgroundRpc, StudyVaultError, isHostDenied, type PageStatus } from '@shared';
import { getSettings, getTrustedSettings, serveRpc, updateSettings } from '@runtime';
import {
  acceptFiling,
  dismissFiling,
  filingAfterCapture,
  isGameModeOn,
  repo,
  undoFiling,
} from '@storage';
import { createHandlers } from '../entrypoints/background/handlers';
import { browserSiteDeps } from '../entrypoints/background/platform';
import { createSiteAccess, type SiteAccess } from '../entrypoints/background/siteAccess';
import { registerSync } from '../entrypoints/background/sync';
import { browser, gallery, type FakeTab } from './shim/chrome';

/**
 * The real service-worker RPC layer, run inside the gallery page: `serveRpc(BackgroundRpc,
 * createHandlers(...))` with the real repository, settings and site-access logic (over the fake
 * Chrome adapters), plus the real sync RPC (idle while sync is off). The only stand-in is the
 * highlighter content script, which cannot run without a real web page: a small responder that
 * answers the TabRpc calls from the database.
 */
export function startBackend(): { site: SiteAccess } {
  const site = createSiteAccess(browserSiteDeps());
  serveRpc(
    BackgroundRpc,
    createHandlers({
      repo,
      filing: {
        afterCapture: (input) => filingAfterCapture(input),
        accept: (id) => acceptFiling(id),
        dismiss: (id) => dismissFiling(id),
        undo: (id) => undoFiling(id),
      },
      getSettings: getTrustedSettings,
      updateSettings,
      site,
      extensionBaseUrl: browser.runtime.getURL('/'),
      openSidePanel: (tabId) => browser.sidePanel.open({ tabId }),
      session: browser.storage.session,
      isGameModeOn,
    }),
  );
  registerSync(browser.runtime.getURL('/'));
  gallery.contentScript = contentScript;
  return { site };
}

const STATUS_KEYS = { resolved: 'resolved', changed: 'changed', ambiguous: 'ambiguous' } as const;

async function pageStatus(tab: FakeTab): Promise<PageStatus> {
  const url = tab.url ?? '';
  const settings = await getSettings();
  const { highlights } = await repo.getPageHighlights(url, null);
  const counts = { total: 0, resolved: 0, changed: 0, ambiguous: 0, orphaned: 0, pending: 0 };
  for (const h of highlights) {
    counts.total++;
    if (h.resolveStatus === 'orphaned') counts.orphaned++;
    else if (h.resolveStatus === 'unchecked') counts.pending++;
    else counts[STATUS_KEYS[h.resolveStatus]]++;
  }
  const denied = isHostDenied(new URL(url).hostname, settings.denyList);
  return {
    url,
    canonicalUrl: null,
    title: tab.title ?? '',
    counts,
    paintingSupported: true,
    hasSelection: false,
    blocked: denied ? 'denied-site' : settings.toolbarEnabled ? null : 'toolbar-disabled',
  };
}

/** TabRpc answers of a highlighter that has painted the page's saved highlights. */
async function answer(tab: FakeTab, type: string, payload: Record<string, unknown>) {
  switch (type) {
    case 'content.ping':
      return { ready: true, version: gallery.manifest.version };
    case 'content.pageStatus':
      return pageStatus(tab);
    case 'content.refresh':
      return { ok: true };
    case 'content.reveal': {
      const { highlights } = await repo.getPageHighlights(tab.url ?? '', null);
      return { found: highlights.some((h) => h.id === payload.id) };
    }
    case 'content.captureSelection':
      return { status: 'no-selection' };
    case 'content.focusToolbar':
      return { focused: false };
    case 'content.stepHighlight': {
      const { highlights } = await repo.getPageHighlights(tab.url ?? '', null);
      return { found: highlights.length > 0 };
    }
    default:
      throw new StudyVaultError('not_found', `No handler for ${type}`);
  }
}

async function contentScript(tab: FakeTab, message: unknown): Promise<unknown> {
  const { type, payload } = message as { type: string; payload: Record<string, unknown> };
  try {
    return { ok: true, data: await answer(tab, type, payload ?? {}) };
  } catch (err) {
    const code = err instanceof StudyVaultError ? err.code : 'internal';
    return {
      ok: false,
      error: { code, message: err instanceof Error ? err.message : String(err) },
    };
  }
}
