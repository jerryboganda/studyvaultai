import type { Browser } from 'wxt/browser';
import {
  INCOGNITO_CAPTURE_REFUSAL,
  PENDING_FOCUS_KEY,
  StudyVaultError,
  isHostDenied,
  parseHttpUrl,
  sameSite,
  trustedCanonical,
  type BackgroundRpc,
  type FilingOutcome,
  type Settings,
} from '@shared';
import type { Handlers } from '@runtime';
import type { FilingCapture, RepoApi } from '@storage';
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
 * reportResolution, filing.accept/dismiss/undo (own-site highlights; the page names a highlight and
 * never a bank), banks.list, bank.create, sidepanel.open (for the sender's own tab only; the
 * focus request is honoured only for a highlight of the sender's site). site.* and tab.activate
 * are extension-only.
 *
 * Identity rules for page callers (payload URLs are never trusted):
 *  - capture.save / page.highlights: payload `url` must have the same ORIGIN as `sender.url`
 *    (path may differ: SPAs change it with pushState). `canonicalUrl` is kept only when
 *    `trustedCanonical` accepts it for that page (it must be the page itself: same site, and the
 *    same path and query once tracking parameters, "www." and a trailing slash are ignored).
 *  - capture.save is also refused when the sender's host is on the deny list, and when the sender
 *    is a private (incognito) tab unless settings.allowIncognitoCapture is on (the database is
 *    shared with normal windows). A null bankId means the last-used bank while it still exists.
 *  - highlight.*: the highlight's Source (`getHighlightSource`) must be on the sender's SITE:
 *    both `urlKey` and `visitedKey` must have the sender's ORIGIN (`sameSite`: same scheme, same
 *    port, same host ignoring a leading "www."). Host alone is not a site: http vs https and
 *    :8443 vs :443 are different servers. An exact-URL compare is deliberately NOT used: SPA route
 *    changes leave previous-route highlights painted, and a source can hold address variants of
 *    one page. The page can already read any same-origin page's highlights through
 *    page.highlights, so a same-site rule grants nothing new while keeping Undo/edit working.
 *    Foreign sources -> forbidden; unknown ids -> not_found; deleted ids -> not_found except for
 *    delete (idempotent) and restore, which look the source up with `includeDeleted`: a deleted
 *    highlight still belongs to its page, so Undo needs no memory of its own.
 */

type Sender = Browser.runtime.MessageSender;
/** chrome.storage.session: the only part of it the handlers use. */
export interface SessionArea {
  set(items: Record<string, unknown>): Promise<void>;
}
type PageCaller = { kind: 'page'; tabId: number; url: URL };
type Caller = { kind: 'extension' } | PageCaller;
type SourceKeys = { urlKey: string; visitedKey: string };

/**
 * Auto-filing rules (docs/adr/017-filing-rules.md): the storage functions of @storage, behind a port
 * so the handlers stay testable. `afterCapture` never throws.
 */
export interface FilingPort {
  afterCapture(input: FilingCapture): Promise<FilingOutcome | null>;
  accept(highlightId: string): Promise<FilingOutcome>;
  dismiss(highlightId: string): Promise<void>;
  undo(highlightId: string): Promise<{ restored: boolean; reason: string | null }>;
}

export interface HandlerDeps {
  repo: RepoApi;
  filing: FilingPort;
  getSettings(): Promise<Settings>;
  updateSettings(mutate: (current: Settings) => Settings): Promise<Settings>;
  site: SiteAccess;
  /** `chrome-extension://<id>/` */
  extensionBaseUrl: string;
  /**
   * `sidePanel.open({ tabId })`. Chrome honours it only inside the user gesture that the message
   * carried, so the handler calls this before it awaits anything.
   */
  openSidePanel(tabId: number): Promise<void>;
  /** chrome.storage.session: hands the highlight to focus over to the side panel. */
  session: SessionArea;
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
    sameSite(caller.url, keys.urlKey) && sameSite(caller.url, keys.visitedKey);

  const assertOwns = (caller: PageCaller, keys: SourceKeys) => {
    if (!ownsSource(caller, keys)) throw forbidden('That highlight belongs to a different site.');
  };

  /**
   * Page callers: the highlight must exist and belong to the sender's site. Deleted highlights
   * count only when `includeDeleted` (delete is idempotent, restore is Undo).
   */
  const authorize = async (sender: Sender, id: string, includeDeleted = false) => {
    const caller = callerOf(sender);
    if (caller.kind === 'extension') return;
    const source = await deps.repo.getHighlightSource(id, { includeDeleted });
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
      if (sender.tab?.incognito === true && !settings.allowIncognitoCapture) {
        throw forbidden(INCOGNITO_CAPTURE_REFUSAL);
      }
      const page = {
        ...input.page,
        ...ownLocation(caller, input.page.url, input.page.canonicalUrl),
      };
      // Shortcut and context-menu captures carry no bank: file them where the last save went, while
      // that bank still exists (the repo falls back to the Inbox for a deleted one anyway).
      let bankId = input.bankId;
      if (bankId === null && settings.lastBankId !== null) {
        const banks = await deps.repo.listBanks();
        if (banks.some((b) => b.id === settings.lastBankId)) bankId = settings.lastBankId;
      }
      const result = await deps.repo.saveCapture({ ...input, bankId, page });
      if (settings.lastBankId !== result.bank.id) {
        // The highlight is already saved; a failed convenience write must not turn it into an error.
        await deps
          .updateSettings((s) => ({ ...s, lastBankId: result.bank.id }))
          .catch((err: unknown) => console.warn('[StudyVault] could not store lastBankId', err));
      }
      // Post-commit: a rule may move the highlight that was just created. Whatever happens here
      // the save stands (afterCapture never throws), and a bank the person named is never overridden
      // (storage checks that, with the requested bank and the last-used one).
      if (result.status === 'created' && settings.useFilingRules) {
        const filing = await deps.filing.afterCapture({
          highlightId: result.highlight.id,
          placed: { bankId: result.bank.id, folderId: null },
          requestedBankId: input.bankId,
          lastBankId: settings.lastBankId,
          candidate: {
            url: page.url,
            title: page.title,
            quote: result.highlight.exactQuote,
            kind: result.highlight.kind,
            tagIds: [],
            sourceType: 'web',
          },
        });
        if (filing) return { ...result, filing };
      }
      return result;
    },

    'page.highlights': async ({ url, canonicalUrl }, sender) => {
      const own = ownLocation(callerOf(sender), url, canonicalUrl);
      return deps.repo.getPageHighlights(own.url, own.canonicalUrl);
    },

    'highlight.update': async ({ id, patch }, sender) => {
      await authorize(sender, id);
      return deps.repo.updateHighlight(id, patch);
    },

    'highlight.delete': async ({ id }, sender) => {
      // Deleted rows are included so a repeated delete is idempotent (the repo no-ops on it).
      await authorize(sender, id, true);
      await deps.repo.softDeleteHighlight(id);
      return { id };
    },

    'highlight.restore': async ({ id }, sender) => {
      await authorize(sender, id, true);
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

    'filing.accept': async ({ highlightId }, sender) => {
      await authorize(sender, highlightId);
      // Same rule as capture.save: a private window files only where capture is allowed.
      if (sender.tab?.incognito === true && !(await deps.getSettings()).allowIncognitoCapture) {
        throw forbidden(INCOGNITO_CAPTURE_REFUSAL);
      }
      return deps.filing.accept(highlightId);
    },

    'filing.dismiss': async ({ highlightId }, sender) => {
      await authorize(sender, highlightId, true);
      await deps.filing.dismiss(highlightId);
      return { ok: true };
    },

    'filing.undo': async ({ highlightId }, sender) => {
      await authorize(sender, highlightId);
      return deps.filing.undo(highlightId);
    },

    'banks.list': async () => {
      const [banks, settings] = await Promise.all([deps.repo.listBanks(), deps.getSettings()]);
      const lastBankId = banks.some((b) => b.id === settings.lastBankId)
        ? settings.lastBankId
        : null;
      return { banks, lastBankId };
    },

    'bank.create': ({ name }) => deps.repo.createBank(name),

    'sidepanel.open': async ({ focusHighlightId }, sender) => {
      const caller = callerOf(sender);
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        throw new StudyVaultError('invalid_request', 'There is no tab to open the side panel for.');
      }
      // Nothing may be awaited before this call (user gesture). The async wrapper turns a
      // synchronous throw (no sidePanel API in this browser) into a rejection.
      const opening = (async () => deps.openSidePanel(tabId))().then(
        () => true,
        (err: unknown) => {
          console.warn('[StudyVault] could not open the side panel', err);
          return false;
        },
      );

      // A page may only ask to focus a highlight of its own site; anything else is ignored.
      let focus: string | null = null;
      if (focusHighlightId !== null) {
        if (caller.kind === 'extension') {
          focus = focusHighlightId;
        } else {
          const source = await deps.repo
            .getHighlightSource(focusHighlightId)
            .catch((err: unknown) => {
              console.warn('[StudyVault] could not check the highlight to focus', err);
              return null;
            });
          if (source && ownsSource(caller, source)) focus = focusHighlightId;
        }
      }

      // Stored even when opening failed: if the user opens the panel by hand within the next 30
      // seconds (the overlay says so), it still jumps to the note.
      if (focus !== null) {
        await deps.session
          .set({ [PENDING_FOCUS_KEY]: { highlightId: focus, at: Date.now() } })
          .catch((err: unknown) => console.warn('[StudyVault] could not hand over the focus', err));
      }
      return { opened: await opening };
    },

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
