import type { Browser } from 'wxt/browser';
import {
  StudyVaultError,
  isHostDenied,
  parseHttpUrl,
  trustedCanonical,
  type BackgroundRpc,
  type Settings,
} from '@shared';
import type { Handlers } from '@runtime';
import type { RepoApi } from '@storage';
import type { DeleteLedger } from './deleteLedger';
import type { SiteAccess } from './siteAccess';

/**
 * Service-worker RPC handlers with the sender policy (SECURITY_PRIVACY: pages are untrusted).
 *
 * Callers
 *  - "extension": no `sender.tab`, or the sender frame URL is under chrome-extension://<id>/
 *    (popup, side panel, options, and extension pages opened as tabs). May call everything.
 *  - "page": a content script. The only data it can trust is `sender.url`, which Chrome sets.
 *
 * Page callers may use only: capture.save, page.highlights, highlight.update/delete/restore/
 * reportResolution, banks.list, bank.create. site.* and tab.activate are extension-only.
 *
 * Identity rules for page callers (payload URLs are never trusted):
 *  - capture.save / page.highlights: payload `url` must have the same ORIGIN as `sender.url`
 *    (path may differ: SPAs change it with pushState). `canonicalUrl` is kept only when
 *    `trustedCanonical` accepts it for that page (same host, ignoring "www.").
 *  - capture.save is also refused when the sender's host is on the deny list.
 *  - highlight.*: the highlight's Source (`getHighlightSource`) must be on the sender's SITE:
 *    both `urlKey` and `visitedKey` must be accepted by `trustedCanonical(sender.url, key)`,
 *    i.e. same host ignoring "www.". An exact-URL compare is deliberately NOT used: a source's
 *    `urlKey` is the page-declared canonical (it may differ from the visited URL by query or
 *    path), and SPA route changes leave previous-route highlights painted. The page can already
 *    declare any same-host canonical and read any same-origin page's highlights through
 *    page.highlights, so a same-site rule grants nothing new while keeping Undo/edit working.
 *    Foreign sources -> forbidden; unknown or deleted ids -> not_found.
 */

type Sender = Browser.runtime.MessageSender;
type PageCaller = { kind: 'page'; tabId: number; url: URL };
type Caller = { kind: 'extension' } | PageCaller;
type SourceKeys = { urlKey: string; visitedKey: string };

export interface HandlerDeps {
  repo: RepoApi;
  getSettings(): Promise<Settings>;
  updateSettings(mutate: (current: Settings) => Settings): Promise<Settings>;
  site: SiteAccess;
  ledger: DeleteLedger;
  /** `chrome-extension://<id>/` */
  extensionBaseUrl: string;
}

const forbidden = (message: string) => new StudyVaultError('forbidden', message);

export function createHandlers(deps: HandlerDeps): Handlers<BackgroundRpc> {
  const callerOf = (sender: Sender): Caller => {
    if (sender.tab === undefined || sender.url?.startsWith(deps.extensionBaseUrl)) {
      return { kind: 'extension' };
    }
    const url = sender.url ? parseHttpUrl(sender.url) : null;
    const tabId = sender.tab.id;
    if (!url || tabId === undefined) {
      throw forbidden('Requests are only accepted from web pages and StudyVault pages.');
    }
    return { kind: 'page', tabId, url };
  };

  const extensionOnly = (sender: Sender) => {
    if (callerOf(sender).kind !== 'extension') {
      throw forbidden('This action is only available from StudyVault pages.');
    }
  };

  /** Payload page location checked against what Chrome says about the sender. */
  const ownLocation = (caller: Caller, url: string, canonicalUrl: string | null) => {
    if (caller.kind === 'extension') return { url, canonicalUrl };
    if (parseHttpUrl(url)?.origin !== caller.url.origin) {
      throw forbidden('The page address does not match the page that sent the request.');
    }
    return { url, canonicalUrl: trustedCanonical(url, canonicalUrl) ? canonicalUrl : null };
  };

  const ownsSource = (caller: PageCaller, keys: SourceKeys) =>
    trustedCanonical(caller.url.href, keys.urlKey) !== null &&
    trustedCanonical(caller.url.href, keys.visitedKey) !== null;

  const assertOwns = (caller: PageCaller, keys: SourceKeys) => {
    if (!ownsSource(caller, keys)) throw forbidden('That highlight belongs to a different site.');
  };

  /** Page callers: the live highlight must exist and belong to the sender's site. */
  const authorizeLive = async (sender: Sender, id: string) => {
    const caller = callerOf(sender);
    if (caller.kind === 'extension') return;
    const source = await deps.repo.getHighlightSource(id);
    if (!source) throw new StudyVaultError('not_found', 'Highlight not found');
    assertOwns(caller, source);
  };

  return {
    'capture.save': async (input, sender) => {
      const caller = callerOf(sender);
      const settings = await deps.getSettings();
      if (caller.kind === 'page' && isHostDenied(caller.url.hostname, settings.denyList)) {
        throw forbidden(`StudyVault is turned off on ${caller.url.hostname}.`);
      }
      const page = {
        ...input.page,
        ...ownLocation(caller, input.page.url, input.page.canonicalUrl),
      };
      const result = await deps.repo.saveCapture({ ...input, page });
      if (settings.lastBankId !== result.bank.id) {
        // The highlight is already saved; a failed convenience write must not turn it into an error.
        await deps
          .updateSettings((s) => ({ ...s, lastBankId: result.bank.id }))
          .catch((err: unknown) => console.warn('[StudyVault] could not store lastBankId', err));
      }
      return result;
    },

    'page.highlights': async ({ url, canonicalUrl }, sender) => {
      const own = ownLocation(callerOf(sender), url, canonicalUrl);
      return deps.repo.getPageHighlights(own.url, own.canonicalUrl);
    },

    'highlight.update': async ({ id, patch }, sender) => {
      await authorizeLive(sender, id);
      return deps.repo.updateHighlight(id, patch);
    },

    'highlight.delete': async ({ id }, sender) => {
      const caller = callerOf(sender);
      if (caller.kind === 'extension') {
        await deps.repo.softDeleteHighlight(id);
        return { id };
      }
      const source = await deps.repo.getHighlightSource(id);
      if (!source) {
        // Idempotent: a second delete of what this tab already deleted succeeds.
        const earlier = await deps.ledger.find(caller.tabId, id);
        if (earlier && ownsSource(caller, earlier)) return { id };
        throw new StudyVaultError('not_found', 'Highlight not found');
      }
      assertOwns(caller, source);
      await deps.repo.softDeleteHighlight(id);
      await deps.ledger
        .add({ tabId: caller.tabId, id, urlKey: source.urlKey, visitedKey: source.visitedKey })
        .catch((err: unknown) => console.warn('[StudyVault] could not record deletion', err));
      return { id };
    },

    'highlight.restore': async ({ id }, sender) => {
      const caller = callerOf(sender);
      if (caller.kind === 'page') {
        // A live highlight is checked through the repo; a deleted one only via this tab's ledger.
        const known =
          (await deps.repo.getHighlightSource(id)) ?? (await deps.ledger.find(caller.tabId, id));
        if (!known) throw forbidden('Only highlights removed from this page can be restored here.');
        assertOwns(caller, known);
      }
      return deps.repo.restoreHighlight(id);
    },

    'highlight.reportResolution': async ({ items }, sender) => {
      const caller = callerOf(sender);
      if (caller.kind === 'page') {
        const ids = [...new Set(items.map((i) => i.id))];
        const sources = await Promise.all(ids.map((id) => deps.repo.getHighlightSource(id)));
        // Unknown/deleted ids are skipped by the repo; any foreign one rejects the whole report.
        for (const source of sources) if (source) assertOwns(caller, source);
      }
      return { updated: await deps.repo.reportResolutions(items) };
    },

    'banks.list': async () => {
      const [banks, settings] = await Promise.all([deps.repo.listBanks(), deps.getSettings()]);
      const lastBankId = banks.some((b) => b.id === settings.lastBankId)
        ? settings.lastBankId
        : null;
      return { banks, lastBankId };
    },

    'bank.create': ({ name }) => deps.repo.createBank(name),

    'site.status': async (input, sender) => {
      extensionOnly(sender);
      return deps.site.status(input);
    },

    'site.sync': async (_input, sender) => {
      extensionOnly(sender);
      return deps.site.sync();
    },

    'tab.activate': async ({ tabId }, sender) => {
      extensionOnly(sender);
      await deps.site.activate(tabId);
      return { ok: true };
    },
  };
}
