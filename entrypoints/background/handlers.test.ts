// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import {
  PENDING_FOCUS_KEY,
  StudyVaultError,
  defaultSettings,
  type BankLite,
  type CaptureInput,
  type CaptureResult,
  type HighlightView,
  type Settings,
} from '@shared';
import type { RepoApi } from '@storage';
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
/** A content script in a private (incognito) tab. */
const incognitoSender = (url: string, tabId = 7): Sender =>
  ({ id: 'test-extension-id', tab: { id: tabId, incognito: true }, url, frameId: 0 }) as Sender;

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
  /** A soft-deleted highlight: only `includeDeleted` lookups see it. */
  const ownDeleted = (id: string, urlKey: string, visitedKey = urlKey) =>
    deleted.set(id, { sourceId: `src-${id}`, urlKey, visitedKey });

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
    getHighlightSource: vi.fn(
      async (id: string, options?: { includeDeleted?: boolean }) =>
        live.get(id) ?? (options?.includeDeleted ? deleted.get(id) : undefined) ?? null,
    ),
    listBanks: vi.fn(async () => [BANK, OTHER_BANK]),
    createBank: vi.fn(async (name: string) => ({ ...OTHER_BANK, name })),
    listRecentHighlights: vi.fn(async () => []),
    listPageHighlights: vi.fn(async () => []),
    listBanksWithCounts: vi.fn(async () => []),
    wipeAllData: vi.fn(async () => undefined),
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
      allSites: false,
    })),
    sync: vi.fn(async () => ({ registeredMatches: [] })),
    activate: vi.fn(async () => undefined),
  };
  const store = new Map<string, unknown>();
  const area = {
    get: async (key: string) => ({ [key]: store.get(key) }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }),
  };
  const openSidePanel = vi.fn(async (_tabId: number): Promise<void> => undefined);

  const handlers = createHandlers({
    repo,
    getSettings: async () => settings,
    updateSettings,
    site,
    extensionBaseUrl: EXT_BASE,
    openSidePanel,
    session: area,
  }) as Required<ReturnType<typeof createHandlers>>;

  return {
    handlers,
    repo,
    updateSettings,
    site,
    own,
    ownDeleted,
    settings: () => settings,
    openSidePanel,
    session: area,
    pendingFocus: () => store.get(PENDING_FOCUS_KEY),
  };
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
    // A trailing dot names the same server and must not slip past the list.
    for (const host of [
      'accounts.google.com',
      'login.paypal.com',
      'paypal.com.',
      'www.paypal.com.',
    ]) {
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

describe('capture.save without a bank (shortcut and context menu)', () => {
  const sender = pageSender('https://example.com/notes/pharm');
  const lastUsed = async (settings: Partial<Settings>, input = captureInput()) => {
    const t = setup(settings);
    await t.handlers['capture.save'](input, sender);
    return t;
  };

  it('files into the last-used bank while it still exists', async () => {
    const t = await lastUsed({ lastBankId: OTHER_BANK.id });
    expect(t.repo.saveCapture.mock.calls[0]![0].bankId).toBe(OTHER_BANK.id);
  });

  it('falls back to the Inbox (bankId stays null) when that bank is gone', async () => {
    const t = await lastUsed({ lastBankId: 'bank-deleted1' });
    expect(t.repo.saveCapture.mock.calls[0]![0].bankId).toBeNull();
  });

  it('uses the Inbox when nothing was saved yet, without listing banks', async () => {
    const t = await lastUsed({ lastBankId: null });
    expect(t.repo.saveCapture.mock.calls[0]![0].bankId).toBeNull();
    expect(t.repo.listBanks).not.toHaveBeenCalled();
  });

  it('never overrides a bank the caller chose', async () => {
    const t = await lastUsed({ lastBankId: OTHER_BANK.id }, { ...captureInput(), bankId: BANK.id });
    expect(t.repo.saveCapture.mock.calls[0]![0].bankId).toBe(BANK.id);
    expect(t.repo.listBanks).not.toHaveBeenCalled();
  });
});

describe('capture.save from private windows', () => {
  const url = 'https://example.com/notes/pharm';

  it('is refused with a clear forbidden message, before anything is written', async () => {
    const t = setup();
    const result = t.handlers['capture.save'](captureInput(), incognitoSender(url));
    await expect(result).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringMatching(/private \(incognito\) windows/),
    });
    expect(t.repo.saveCapture).not.toHaveBeenCalled();
    expect(t.updateSettings).not.toHaveBeenCalled();
  });

  it('is allowed once the user turned it on', async () => {
    const t = setup({ allowIncognitoCapture: true });
    expect(await code(t.handlers['capture.save'](captureInput(), incognitoSender(url)))).toBe(
      'resolved',
    );
    expect(t.repo.saveCapture).toHaveBeenCalledOnce();
  });

  it('applies to extension pages in a private tab too, and not to normal tabs', async () => {
    const t = setup();
    const privateExtensionTab = {
      id: 'test-extension-id',
      tab: { id: 3, incognito: true },
      url: `${EXT_BASE}options.html`,
    } as Sender;
    expect(await code(t.handlers['capture.save'](captureInput(), privateExtensionTab))).toBe(
      'forbidden',
    );
    const normal = { ...pageSender(url), tab: { id: 7, incognito: false } } as Sender;
    expect(await code(t.handlers['capture.save'](captureInput(), normal))).toBe('resolved');
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

  it('a source on another scheme or port of the same host is another site', async () => {
    const t = setup();
    t.own('hl-http0001', 'http://example.com/notes/pharm'); // http vs https
    t.own('hl-port0001', 'https://example.com:8443/notes/pharm'); // :8443 vs :443
    t.own('hl-visit001', 'https://example.com/notes/pharm', 'http://example.com/notes/pharm');
    t.own('hl-www00001', 'https://www.example.com/notes/pharm'); // same site: www is folded
    t.own('hl-port4430', 'https://example.com:443/notes/pharm'); // explicit default port

    for (const id of ['hl-http0001', 'hl-port0001', 'hl-visit001']) {
      expect(
        await code(t.handlers['highlight.update']({ id, patch: { priority: 5 } }, sender)),
        id,
      ).toBe('forbidden');
      expect(await code(t.handlers['highlight.delete']({ id }, sender)), id).toBe('forbidden');
      expect(await code(t.handlers['highlight.restore']({ id }, sender)), id).toBe('forbidden');
    }
    expect(
      await code(
        t.handlers['highlight.reportResolution'](
          { items: [{ id: 'hl-port0001', status: 'resolved', confidence: 1 }] },
          sender,
        ),
      ),
    ).toBe('forbidden');
    expect(t.repo.updateHighlight).not.toHaveBeenCalled();
    expect(t.repo.softDeleteHighlight).not.toHaveBeenCalled();

    for (const id of ['hl-www00001', 'hl-port4430']) {
      expect(
        await code(t.handlers['highlight.update']({ id, patch: { priority: 5 } }, sender)),
        id,
      ).toBe('resolved');
    }
  });

  it('does not honour an Undo for a deleted highlight of another scheme or port', async () => {
    const t = setup();
    t.ownDeleted('hl-ledger01', 'https://example.com:8443/a');
    t.ownDeleted('hl-ledger02', 'http://example.com/a');
    for (const id of ['hl-ledger01', 'hl-ledger02']) {
      expect(await code(t.handlers['highlight.restore']({ id }, sender)), id).toBe('forbidden');
      expect(await code(t.handlers['highlight.delete']({ id }, sender)), id).toBe('forbidden');
    }
    expect(t.repo.restoreHighlight).not.toHaveBeenCalled();
    expect(t.repo.softDeleteHighlight).not.toHaveBeenCalled();
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
    t.ownDeleted('hl-deleted1', 'https://example.com/notes/pharm');
    for (const id of ['hl-missing1', 'hl-deleted1']) {
      expect(
        await code(t.handlers['highlight.update']({ id, patch: { priority: 1 } }, sender)),
        id,
      ).toBe('not_found');
    }
    expect(await code(t.handlers['highlight.delete']({ id: 'hl-missing1' }, sender))).toBe(
      'not_found',
    );
    expect(await code(t.handlers['highlight.restore']({ id: 'hl-missing1' }, sender))).toBe(
      'not_found',
    );
    expect(t.repo.updateHighlight).not.toHaveBeenCalled();
  });

  it('delete is idempotent and restore (undo) is authorised by the page the highlight belongs to', async () => {
    const t = setup();
    t.own('hl-undo0001', 'https://example.com/notes/pharm');

    await t.handlers['highlight.delete']({ id: 'hl-undo0001' }, sender);
    expect(t.repo.softDeleteHighlight).toHaveBeenCalledOnce();
    // The row is now soft-deleted; the ownership lookup includes deleted rows, so a repeat resolves.
    expect(await code(t.handlers['highlight.delete']({ id: 'hl-undo0001' }, sender))).toBe(
      'resolved',
    );
    expect(t.repo.getHighlightSource).toHaveBeenLastCalledWith('hl-undo0001', {
      includeDeleted: true,
    });

    // A highlight of another site cannot be restored from here.
    t.ownDeleted('hl-foreign01', 'https://bank.example/account');
    expect(await code(t.handlers['highlight.restore']({ id: 'hl-foreign01' }, sender))).toBe(
      'forbidden',
    );
    expect(t.repo.restoreHighlight).not.toHaveBeenCalled();

    // Any tab of the same site can undo it: the proof is the stored row, not a per-tab memory.
    const restored = await t.handlers['highlight.restore'](
      { id: 'hl-undo0001' },
      pageSender('https://example.com/notes/pharm', 99),
    );
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

describe('sidepanel.open', () => {
  const sender = pageSender('https://example.com/notes/pharm?x=2');

  it('opens the panel for the sender tab before awaiting anything, then hands the focus over', async () => {
    const t = setup();
    t.own('hl-own0001', 'https://example.com/notes/pharm');
    const pending = t.handlers['sidepanel.open']({ focusHighlightId: 'hl-own0001' }, sender);
    // Synchronous: Chrome honours sidePanel.open only inside the user gesture of the message.
    expect(t.openSidePanel).toHaveBeenCalledTimes(1);
    expect(t.openSidePanel).toHaveBeenCalledWith(7);

    expect(await pending).toEqual({ opened: true });
    // The ownership lookup (async storage) comes after the open call, never before it.
    expect(t.openSidePanel.mock.invocationCallOrder[0]!).toBeLessThan(
      t.repo.getHighlightSource.mock.invocationCallOrder[0]!,
    );
    expect(t.pendingFocus()).toEqual({ highlightId: 'hl-own0001', at: expect.any(Number) });
  });

  it('opens without a focus request and writes no hand-over', async () => {
    const t = setup();
    expect(await t.handlers['sidepanel.open']({ focusHighlightId: null }, sender)).toEqual({
      opened: true,
    });
    expect(t.pendingFocus()).toBeUndefined();
    expect(t.session.set).not.toHaveBeenCalled();
  });

  it('ignores a focus request for a highlight of another site, scheme or port, or an unknown one', async () => {
    const t = setup();
    t.own('hl-foreign1', 'https://bank.example/account');
    t.own('hl-http0001', 'http://example.com/notes/pharm');
    t.own('hl-port0001', 'https://example.com:8443/notes/pharm');
    for (const focusHighlightId of ['hl-foreign1', 'hl-http0001', 'hl-port0001', 'hl-missing1']) {
      expect(
        await t.handlers['sidepanel.open']({ focusHighlightId }, sender),
        focusHighlightId,
      ).toEqual({ opened: true });
    }
    expect(t.session.set).not.toHaveBeenCalled();
    expect(t.openSidePanel).toHaveBeenCalledTimes(4);
  });

  it('reports opened:false when the panel cannot be opened, but keeps the hand-over for a manual open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = setup();
    t.own('hl-own0001', 'https://example.com/notes/pharm');
    t.openSidePanel.mockRejectedValueOnce(
      new Error('may only be called in response to a user gesture'),
    );
    expect(await t.handlers['sidepanel.open']({ focusHighlightId: 'hl-own0001' }, sender)).toEqual({
      opened: false,
    });
    expect(t.pendingFocus()).toMatchObject({ highlightId: 'hl-own0001' });

    // A browser without the API throws synchronously.
    t.openSidePanel.mockImplementationOnce(() => {
      throw new TypeError('browser.sidePanel is undefined');
    });
    expect(await t.handlers['sidepanel.open']({ focusHighlightId: null }, sender)).toEqual({
      opened: false,
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('still opens when the hand-over cannot be stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = setup();
    t.own('hl-own0001', 'https://example.com/notes/pharm');
    t.session.set.mockRejectedValueOnce(new Error('session storage unavailable'));
    expect(await t.handlers['sidepanel.open']({ focusHighlightId: 'hl-own0001' }, sender)).toEqual({
      opened: true,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('is refused for non-http senders and has nothing to open without a tab', async () => {
    const t = setup();
    expect(
      await code(
        t.handlers['sidepanel.open']({ focusHighlightId: null }, pageSender('chrome://settings/')),
      ),
    ).toBe('forbidden');
    // The popup and the side panel have no sender.tab; they open the panel themselves.
    expect(
      await code(t.handlers['sidepanel.open']({ focusHighlightId: null }, extensionSender())),
    ).toBe('invalid_request');
    expect(t.openSidePanel).not.toHaveBeenCalled();
  });

  it('extension pages opened as a tab may focus any highlight', async () => {
    const t = setup();
    t.own('hl-foreign1', 'https://bank.example/account');
    expect(
      await t.handlers['sidepanel.open']({ focusHighlightId: 'hl-foreign1' }, extensionTabSender()),
    ).toEqual({ opened: true });
    expect(t.openSidePanel).toHaveBeenCalledWith(3);
    expect(t.pendingFocus()).toMatchObject({ highlightId: 'hl-foreign1' });
    expect(t.repo.getHighlightSource).not.toHaveBeenCalled();
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
