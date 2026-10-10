// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import {
  StudyVaultError,
  defaultSettings,
  type BankLite,
  type CaptureInput,
  type CaptureResult,
  type HighlightView,
  type Settings,
} from '@shared';
import type { RepoApi } from '@storage';
import { createDeleteLedger } from './deleteLedger';
import { createHandlers } from './handlers';
import type { SiteAccess } from './siteAccess';

type Sender = Browser.runtime.MessageSender;
const EXT_BASE = 'chrome-extension://test-extension-id/';
const BANK: BankLite = { id: 'inbox-default', name: 'Inbox', color: 'blue', isInbox: true };
const OTHER_BANK: BankLite = {
  id: 'bank-cardio-1',
  name: 'Cardiology',
  color: 'red',
  isInbox: false,
};

const VIEW = {
  id: 'hl-000001',
  sourceId: 'src-000001',
  exactQuote: 'Aspirin irreversibly inhibits cyclooxygenase.',
  anchorSet: {} as HighlightView['anchorSet'],
  kind: 'essential',
  color: 'amber',
  priority: 3,
  userComment: '',
  headingContext: null,
  bankIds: [BANK.id],
  capturedAt: '2026-10-11T00:00:00.000Z',
  resolveStatus: 'resolved',
  resolveConfidence: 1,
} satisfies HighlightView;

/** A content script on `url` in tab `tabId`. */
const pageSender = (url: string | undefined, tabId = 7): Sender =>
  ({ id: 'test-extension-id', tab: { id: tabId }, url, frameId: 0 }) as Sender;
/** Popup / side panel: no tab. */
const extensionSender = (): Sender => ({ id: 'test-extension-id', url: `${EXT_BASE}popup.html` });
/** An extension page opened as a normal tab (has sender.tab). */
const extensionTabSender = (): Sender =>
  ({ id: 'test-extension-id', tab: { id: 3 }, url: `${EXT_BASE}options.html` }) as Sender;

function captureInput(over: Partial<CaptureInput['page']> = {}): CaptureInput {
  return {
    page: {
      url: 'https://example.com/notes/pharm',
      canonicalUrl: null,
      title: 'Pharmacology',
      ...over,
    },
    exactQuote: VIEW.exactQuote,
    anchorSet: VIEW.anchorSet,
    headingContext: null,
    kind: 'essential',
    color: 'amber',
    bankId: null,
    userComment: '',
    priority: 3,
    captureMethod: 'toolbar',
  };
}

function setup(initial: Partial<Settings> = {}) {
  let settings: Settings = { ...defaultSettings(), ...initial };
  const live = new Map<string, { sourceId: string; urlKey: string; visitedKey: string }>();
  const deleted = new Map<string, { sourceId: string; urlKey: string; visitedKey: string }>();
  const own = (id: string, urlKey: string, visitedKey = urlKey) =>
    live.set(id, { sourceId: `src-${id}`, urlKey, visitedKey });

  const repo = {
    saveCapture: vi.fn(
      async (input: CaptureInput) =>
        ({
          status: 'created',
          highlight: { ...VIEW, exactQuote: input.exactQuote },
          bank: input.bankId === OTHER_BANK.id ? OTHER_BANK : BANK,
          addedToBank: true,
        }) satisfies CaptureResult,
    ),
    getPageHighlights: vi.fn(async () => ({ sourceId: null, highlights: [] })),
    updateHighlight: vi.fn(async (id: string) => ({ ...VIEW, id })),
    softDeleteHighlight: vi.fn(async (id: string) => {
      const row = live.get(id);
      if (row) {
        live.delete(id);
        deleted.set(id, row);
      }
    }),
    restoreHighlight: vi.fn(async (id: string) => {
      const row = deleted.get(id);
      if (row) {
        deleted.delete(id);
        live.set(id, row);
      }
      return { ...VIEW, id };
    }),
    reportResolutions: vi.fn(async (items: unknown[]) => items.length),
    getHighlightSource: vi.fn(async (id: string) => live.get(id) ?? null),
    listBanks: vi.fn(async () => [BANK, OTHER_BANK]),
    createBank: vi.fn(async (name: string) => ({ ...OTHER_BANK, name })),
    listRecentHighlights: vi.fn(async () => []),
    listPageHighlights: vi.fn(async () => []),
    listBanksWithCounts: vi.fn(async () => []),
  } satisfies RepoApi;

  const updateSettings = vi.fn(async (mutate: (s: Settings) => Settings) => {
    settings = mutate(settings);
    return settings;
  });
  const site: SiteAccess = {
    status: vi.fn(async () => ({
      supported: true,
      denied: false,
      pattern: 'https://example.com/*',
      access: 'none' as const,
      active: false,
    })),
    sync: vi.fn(async () => ({ registeredMatches: [] })),
    activate: vi.fn(async () => undefined),
  };
  const store = new Map<string, unknown>();
  const ledger = createDeleteLedger({
    get: async (key) => ({ [key]: store.get(key) }),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
  });

  const handlers = createHandlers({
    repo,
    getSettings: async () => settings,
    updateSettings,
    site,
    ledger,
    extensionBaseUrl: EXT_BASE,
  }) as Required<ReturnType<typeof createHandlers>>;

  return { handlers, repo, updateSettings, site, own, settings: () => settings, ledger };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof StudyVaultError ? err.code : `other:${String(err)}`;
  }
}

describe('capture.save sender policy', () => {
  it('saves for a page on its own origin and remembers the bank as lastBankId', async () => {
    const t = setup();
    const result = await t.handlers['capture.save'](
      captureInput({ url: 'https://example.com/other/path?utm_source=x' }),
      pageSender('https://example.com/notes/pharm'),
    );
    expect(result.status).toBe('created');
    expect(t.repo.saveCapture).toHaveBeenCalledOnce();
    expect(t.settings().lastBankId).toBe(BANK.id);
  });

  it('stores the bank actually used when the capture targeted a specific bank', async () => {
    const t = setup({ lastBankId: BANK.id });
    await t.handlers['capture.save'](
      { ...captureInput(), bankId: OTHER_BANK.id },
      pageSender('https://example.com/notes/pharm'),
    );
    expect(t.settings().lastBankId).toBe(OTHER_BANK.id);
  });

  it('does not rewrite settings when lastBankId is already that bank', async () => {
    const t = setup({ lastBankId: BANK.id });
    await t.handlers['capture.save'](captureInput(), pageSender('https://example.com/notes/pharm'));
    expect(t.updateSettings).not.toHaveBeenCalled();
  });

  it('still reports the save when persisting lastBankId fails (data is already written)', async () => {
    const t = setup();
    t.updateSettings.mockRejectedValueOnce(new Error('quota'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await t.handlers['capture.save'](
      captureInput(),
      pageSender('https://example.com/notes/pharm'),
    );
    expect(result.status).toBe('created');
    expect(warn).toHaveBeenCalled();
  });

  it('rejects a sender on a deny-listed host (and its subdomains) without touching storage', async () => {
    const t = setup();
    for (const host of ['accounts.google.com', 'login.paypal.com']) {
      const url = `https://${host}/signin`;
      const status = await code(t.handlers['capture.save'](captureInput({ url }), pageSender(url)));
      expect(status, host).toBe('forbidden');
    }
    expect(t.repo.saveCapture).not.toHaveBeenCalled();
    expect(t.updateSettings).not.toHaveBeenCalled();
  });

  it('honours user edits to the deny list', async () => {
    const t = setup({ denyList: ['example.com'] });
    const status = await code(
      t.handlers['capture.save'](captureInput(), pageSender('https://docs.example.com/a')),
    );
    expect(status).toBe('forbidden');
  });

  it('rejects a payload URL whose origin differs from the sender origin', async () => {
    const t = setup();
    const sender = pageSender('https://example.com/notes/pharm');
    for (const url of [
      'https://evil.example/notes/pharm',
      'http://example.com/notes/pharm', // scheme differs
      'https://example.com:8443/notes/pharm', // port differs
      'https://sub.example.com/notes/pharm',
    ]) {
      expect(await code(t.handlers['capture.save'](captureInput({ url }), sender)), url).toBe(
        'forbidden',
      );
    }
    expect(t.repo.saveCapture).not.toHaveBeenCalled();
  });

  it('rejects senders that are not http(s) pages or have no tab id', async () => {
    const t = setup();
    for (const sender of [
      pageSender(undefined),
      pageSender('chrome://settings/'),
      pageSender('file:///C:/notes.html'),
      { id: 'test-extension-id', tab: {}, url: 'https://example.com/' } as Sender,
    ]) {
      expect(await code(t.handlers['capture.save'](captureInput(), sender))).toBe('forbidden');
    }
  });

  it('drops a canonical URL on another host but keeps a same-host one', async () => {
    const t = setup();
    const sender = pageSender('https://example.com/notes/pharm');
    await t.handlers['capture.save'](
      captureInput({ canonicalUrl: 'https://attacker.example/steal' }),
      sender,
    );
    expect(t.repo.saveCapture.mock.calls[0]![0].page.canonicalUrl).toBeNull();

    await t.handlers['capture.save'](
      captureInput({ canonicalUrl: 'https://www.example.com/notes/pharm' }),
      sender,
    );
    expect(t.repo.saveCapture.mock.calls[1]![0].page.canonicalUrl).toBe(
      'https://www.example.com/notes/pharm',
    );
  });

  it('lets extension pages (no tab, or an extension URL in a tab) save for any page', async () => {
    const t = setup();
    const input = captureInput({ url: 'https://accounts.google.com/x' });
    for (const sender of [extensionSender(), extensionTabSender()]) {
      expect(await code(t.handlers['capture.save'](input, sender))).toBe('resolved');
    }
  });
});

describe('page.highlights', () => {
  it('looks up the sender page and rejects other origins', async () => {
    const t = setup();
    const sender = pageSender('https://example.com/a');
    await t.handlers['page.highlights'](
      { url: 'https://example.com/a', canonicalUrl: null },
      sender,
    );
    expect(t.repo.getPageHighlights).toHaveBeenCalledWith('https://example.com/a', null);

    const status = await code(
      t.handlers['page.highlights']({ url: 'https://other.example/a', canonicalUrl: null }, sender),
    );
    expect(status).toBe('forbidden');
    expect(t.repo.getPageHighlights).toHaveBeenCalledOnce();
  });

  it('drops an untrusted canonical before the lookup', async () => {
    const t = setup();
    await t.handlers['page.highlights'](
      { url: 'https://example.com/a', canonicalUrl: 'https://bank.example/secret' },
      pageSender('https://example.com/a'),
    );
    expect(t.repo.getPageHighlights).toHaveBeenCalledWith('https://example.com/a', null);
  });
});

describe('highlight.* ownership', () => {
  const sender = pageSender('https://example.com/notes/pharm?x=2');

  it('allows editing a highlight of the same page', async () => {
    const t = setup();
    t.own('hl-own0001', 'https://example.com/notes/pharm', 'https://example.com/notes/pharm?x=1');
    const view = await t.handlers['highlight.update'](
      { id: 'hl-own0001', patch: { color: 'blue' } },
      sender,
    );
    expect(view.id).toBe('hl-own0001');
    expect(t.repo.updateHighlight).toHaveBeenCalledWith('hl-own0001', { color: 'blue' });
  });

  it('allows a source whose canonical key differs from the visited URL (same site)', async () => {
    const t = setup();
    t.own(
      'hl-canon01',
      'https://www.example.com/canonical/other-path',
      'https://example.com/v?x=9',
    );
    expect(
      await code(
        t.handlers['highlight.update']({ id: 'hl-canon01', patch: { priority: 5 } }, sender),
      ),
    ).toBe('resolved');
  });

  it('rejects a highlight that belongs to another site', async () => {
    const t = setup();
    t.own('hl-foreign', 'https://bank.example/account');
    expect(
      await code(
        t.handlers['highlight.update']({ id: 'hl-foreign', patch: { priority: 5 } }, sender),
      ),
    ).toBe('forbidden');
    expect(await code(t.handlers['highlight.delete']({ id: 'hl-foreign' }, sender))).toBe(
      'forbidden',
    );
    expect(await code(t.handlers['highlight.restore']({ id: 'hl-foreign' }, sender))).toBe(
      'forbidden',
    );
    expect(t.repo.updateHighlight).not.toHaveBeenCalled();
    expect(t.repo.softDeleteHighlight).not.toHaveBeenCalled();
    expect(t.repo.restoreHighlight).not.toHaveBeenCalled();
  });

  it('rejects a source with only one key on the sender site', async () => {
    const t = setup();
    t.own('hl-mixed01', 'https://example.com/ok', 'https://bank.example/visited');
    expect(
      await code(
        t.handlers['highlight.update']({ id: 'hl-mixed01', patch: { priority: 1 } }, sender),
      ),
    ).toBe('forbidden');
  });

  it('answers not_found for an unknown or deleted id', async () => {
    const t = setup();
    expect(
      await code(
        t.handlers['highlight.update']({ id: 'hl-missing1', patch: { priority: 1 } }, sender),
      ),
    ).toBe('not_found');
    expect(await code(t.handlers['highlight.delete']({ id: 'hl-missing1' }, sender))).toBe(
      'not_found',
    );
  });

  it('delete is idempotent for the tab that deleted, and restore (undo) works only there', async () => {
    const t = setup();
    t.own('hl-undo0001', 'https://example.com/notes/pharm');

    await t.handlers['highlight.delete']({ id: 'hl-undo0001' }, sender);
    expect(t.repo.softDeleteHighlight).toHaveBeenCalledOnce();
    // The row is now soft-deleted: the repo reports null, the ledger proves it was ours.
    expect(await code(t.handlers['highlight.delete']({ id: 'hl-undo0001' }, sender))).toBe(
      'resolved',
    );
    expect(t.repo.softDeleteHighlight).toHaveBeenCalledOnce();

    // Another tab (same site) did not delete it: refused.
    expect(
      await code(
        t.handlers['highlight.restore'](
          { id: 'hl-undo0001' },
          pageSender('https://example.com/notes/pharm', 99),
        ),
      ),
    ).toBe('forbidden');
    expect(t.repo.restoreHighlight).not.toHaveBeenCalled();

    const restored = await t.handlers['highlight.restore']({ id: 'hl-undo0001' }, sender);
    expect(restored.id).toBe('hl-undo0001');
    expect(t.repo.restoreHighlight).toHaveBeenCalledOnce();
  });

  it('does not let a tab that moved to another site restore what it deleted before', async () => {
    const t = setup();
    t.own('hl-moved001', 'https://example.com/notes/pharm');
    await t.handlers['highlight.delete']({ id: 'hl-moved001' }, sender);
    const afterNavigation = pageSender('https://other.example/page');
    expect(
      await code(t.handlers['highlight.restore']({ id: 'hl-moved001' }, afterNavigation)),
    ).toBe('forbidden');
  });

  it('refuses to restore an id the page never deleted', async () => {
    const t = setup();
    expect(await code(t.handlers['highlight.restore']({ id: 'hl-unknown1' }, sender))).toBe(
      'forbidden',
    );
  });

  it('reportResolution: all own passes through; unknown ids are left to the repo', async () => {
    const t = setup();
    t.own('hl-aaaaaaa1', 'https://example.com/notes/pharm');
    const items = [
      { id: 'hl-aaaaaaa1', status: 'resolved' as const, confidence: 1 },
      { id: 'hl-gone0001', status: 'orphaned' as const, confidence: null },
    ];
    const out = await t.handlers['highlight.reportResolution']({ items }, sender);
    expect(out.updated).toBe(2);
    expect(t.repo.reportResolutions).toHaveBeenCalledWith(items);
  });

  it('reportResolution: one foreign id rejects the whole batch', async () => {
    const t = setup();
    t.own('hl-aaaaaaa1', 'https://example.com/notes/pharm');
    t.own('hl-bbbbbbb1', 'https://bank.example/x');
    const status = await code(
      t.handlers['highlight.reportResolution'](
        {
          items: [
            { id: 'hl-aaaaaaa1', status: 'resolved', confidence: 1 },
            { id: 'hl-bbbbbbb1', status: 'resolved', confidence: 1 },
          ],
        },
        sender,
      ),
    );
    expect(status).toBe('forbidden');
    expect(t.repo.reportResolutions).not.toHaveBeenCalled();
  });

  it('extension pages skip the page-identity check', async () => {
    const t = setup();
    t.own('hl-foreign', 'https://bank.example/account');
    for (const s of [extensionSender(), extensionTabSender()]) {
      expect(
        await code(t.handlers['highlight.update']({ id: 'hl-foreign', patch: { priority: 2 } }, s)),
      ).toBe('resolved');
    }
    expect(t.repo.getHighlightSource).not.toHaveBeenCalled();
    await t.handlers['highlight.delete']({ id: 'hl-foreign' }, extensionSender());
    expect(t.repo.softDeleteHighlight).toHaveBeenCalledWith('hl-foreign');
  });
});

describe('banks and extension-only actions', () => {
  it('lists banks with lastBankId, nulling a stale id', async () => {
    const t = setup({ lastBankId: OTHER_BANK.id });
    const sender = pageSender('https://example.com/');
    expect(await t.handlers['banks.list']({}, sender)).toEqual({
      banks: [BANK, OTHER_BANK],
      lastBankId: OTHER_BANK.id,
    });
    const stale = setup({ lastBankId: 'bank-deleted1' });
    expect((await stale.handlers['banks.list']({}, sender)).lastBankId).toBeNull();
  });

  it('creates a bank for pages and extension pages', async () => {
    const t = setup();
    const bank = await t.handlers['bank.create'](
      { name: 'Renal' },
      pageSender('https://example.com/'),
    );
    expect(bank.name).toBe('Renal');
    expect(t.repo.createBank).toHaveBeenCalledWith('Renal');
  });

  it('site.* and tab.activate are refused for content scripts and delegated for extension pages', async () => {
    const t = setup();
    const page = pageSender('https://example.com/');
    expect(
      await code(t.handlers['site.status']({ tabId: 1, url: 'https://example.com/' }, page)),
    ).toBe('forbidden');
    expect(await code(t.handlers['site.sync']({}, page))).toBe('forbidden');
    expect(await code(t.handlers['tab.activate']({ tabId: 1 }, page))).toBe('forbidden');
    expect(t.site.status).not.toHaveBeenCalled();
    expect(t.site.sync).not.toHaveBeenCalled();
    expect(t.site.activate).not.toHaveBeenCalled();

    const ext = extensionSender();
    await t.handlers['site.status']({ tabId: 1, url: 'https://example.com/' }, ext);
    await t.handlers['site.sync']({}, ext);
    expect(await t.handlers['tab.activate']({ tabId: 1 }, ext)).toEqual({ ok: true });
    expect(t.site.activate).toHaveBeenCalledWith(1);
  });
});
