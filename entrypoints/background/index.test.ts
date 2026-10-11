// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { PENDING_FOCUS_KEY } from '@shared';
import { resetDbForTests } from '@storage';
import background from './index';
import { ACTIVATE_TIMEOUT_MS } from './siteAccess';

/**
 * Wiring smoke test. fakeBrowser does not implement commands/contextMenus/permissions/scripting/
 * sidePanel, so those namespaces get minimal in-memory stand-ins. This proves registration and
 * routing; it cannot prove real Chrome behaviour (see the E2E suite).
 */

type Listener = (...args: never[]) => unknown;
function event() {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: (l: Listener) => listeners.push(l),
    removeListener: (l: Listener) => listeners.splice(listeners.indexOf(l), 1),
    hasListeners: () => listeners.length > 0,
  };
}

function installFakes() {
  const fakes = {
    commands: { onCommand: event() },
    contextMenus: {
      onClicked: event(),
      removeAll: vi.fn(async () => undefined),
      create: vi.fn((_item: unknown, cb?: () => void) => cb?.()),
    },
    permissions: {
      onRemoved: event(),
      contains: vi.fn(async (_p: { origins: string[] }) => true),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(
        async () => [] as Array<{ id: string; matches?: string[] }>,
      ),
      registerContentScripts: vi.fn(async (_s: unknown[]) => undefined),
      updateContentScripts: vi.fn(async (_s: unknown[]) => undefined),
      unregisterContentScripts: vi.fn(async (_f: unknown) => undefined),
      executeScript: vi.fn(async (_i: unknown) => [] as unknown[]),
    },
    sidePanel: { open: vi.fn(async (_o: unknown) => undefined) },
  };
  Object.assign(browser, fakes);
  Object.assign(browser.runtime, {
    getManifest: () => ({ action: { default_title: 'StudyVault AI' } }),
  });
  return fakes;
}

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
});

describe('background wiring', () => {
  it('registers every listener synchronously while the worker script runs', () => {
    const fakes = installFakes();
    expect(browser.runtime.onMessage.hasListeners()).toBe(false);
    background.main();
    expect(browser.runtime.onMessage.hasListeners()).toBe(true);
    expect(browser.runtime.onInstalled.hasListeners()).toBe(true);
    expect(browser.runtime.onStartup.hasListeners()).toBe(true);
    expect(fakes.commands.onCommand.listeners).toHaveLength(1);
    expect(fakes.contextMenus.onClicked.listeners).toHaveLength(1);
    expect(fakes.permissions.onRemoved.listeners).toHaveLength(1);
  });

  it('on install: creates the context menu and registers the persistent script', async () => {
    const fakes = installFakes();
    await browser.storage.local.set({
      settings: { persistentOrigins: ['https://example.com/*'], denyList: ['paypal.com'] },
    });
    background.main();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' });

    await vi.waitFor(() => expect(fakes.contextMenus.create).toHaveBeenCalledOnce());
    expect(fakes.contextMenus.removeAll).toHaveBeenCalled();
    await vi.waitFor(() => expect(fakes.scripting.registerContentScripts).toHaveBeenCalledOnce());
    expect(fakes.scripting.registerContentScripts.mock.calls[0]![0]).toMatchObject([
      {
        id: 'sv-persistent',
        matches: ['https://example.com/*'],
        excludeMatches: ['*://*.paypal.com/*'],
        persistAcrossSessions: true,
      },
    ]);
  });

  it('re-syncs on browser startup and when a permission is removed', async () => {
    const fakes = installFakes();
    fakes.permissions.contains.mockResolvedValue(false);
    fakes.scripting.getRegisteredContentScripts.mockResolvedValue([
      { id: 'sv-persistent', matches: ['https://example.com/*'] },
    ]);
    await browser.storage.local.set({ settings: { persistentOrigins: ['https://example.com/*'] } });
    background.main();

    await fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(() =>
      expect(fakes.scripting.unregisterContentScripts).toHaveBeenCalledTimes(1),
    );
    await Promise.all(fakes.permissions.onRemoved.listeners.map((l) => (l as () => unknown)()));
    await vi.waitFor(() =>
      expect(fakes.scripting.unregisterContentScripts).toHaveBeenCalledTimes(2),
    );
  });

  it('serves RPC through the sender policy and the real repository', async () => {
    installFakes();
    background.main();
    const send = async (type: string, payload: unknown, sender: object) => {
      let response: unknown;
      await fakeBrowser.runtime.onMessage.trigger({ v: 1, type, payload }, sender, (r: unknown) => {
        response = r;
      });
      await vi.waitFor(() => expect(response).toBeDefined());
      return response as { ok: boolean; data?: unknown; error?: { code: string } };
    };
    const ext = { id: browser.runtime.id };
    const page = { id: browser.runtime.id, tab: { id: 4 }, url: 'https://example.com/a' };

    const banks = await send('banks.list', {}, page);
    expect(banks.ok).toBe(true);
    expect((banks.data as { banks: Array<{ isInbox: boolean }> }).banks[0]!.isInbox).toBe(true);

    const refused = await send('site.sync', {}, page);
    expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    const synced = await send('site.sync', {}, ext);
    expect(synced).toEqual({ ok: true, data: { registeredMatches: [] } });

    const foreign = await send(
      'page.highlights',
      { url: 'https://evil.example/', canonicalUrl: null },
      page,
    );
    expect(foreign).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    const other = await send('banks.list', {}, { id: 'some-other-extension' });
    expect(other).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('sidepanel.open calls chrome.sidePanel.open inside the message event, then stores the hand-over', async () => {
    const fakes = installFakes();
    background.main();
    const page = { id: browser.runtime.id, tab: { id: 4 }, url: 'https://example.com/a' };
    const send = (type: string, payload: unknown, sender: object) => {
      let response: unknown;
      // Not awaited: whatever the worker does synchronously has happened when this returns.
      void fakeBrowser.runtime.onMessage.trigger({ v: 1, type, payload }, sender, (r: unknown) => {
        response = r;
      });
      return () => vi.waitFor(() => expect(response).toBeDefined()).then(() => response);
    };
    const saved = await send(
      'capture.save',
      {
        page: { url: 'https://example.com/a', canonicalUrl: null, title: 'A' },
        exactQuote: 'Aspirin inhibits cyclooxygenase.',
        anchorSet: {
          type: 'html',
          textAlgorithm: 'sv-text-v1',
          textQuote: { exact: 'Aspirin inhibits cyclooxygenase.', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 32 },
          structuralPath: null,
          contentSignature: 'x',
          documentTextLength: 100,
        },
        headingContext: null,
        kind: 'essential',
        color: 'amber',
        bankId: null,
        userComment: '',
        priority: 3,
        captureMethod: 'toolbar',
      },
      page,
    )();
    const id = (saved as { data: { highlight: { id: string } } }).data.highlight.id;

    const reply = send('sidepanel.open', { focusHighlightId: id }, page);
    expect(fakes.sidePanel.open).toHaveBeenCalledWith({ tabId: 4 });
    expect(await reply()).toEqual({ ok: true, data: { opened: true } });
    const stored = (await browser.storage.session.get(PENDING_FOCUS_KEY))[PENDING_FOCUS_KEY];
    expect(stored).toMatchObject({ highlightId: id });

    // A page cannot ask for another site's highlight to be focused.
    await browser.storage.session.remove(PENDING_FOCUS_KEY);
    const other = send(
      'sidepanel.open',
      { focusHighlightId: id },
      {
        ...page,
        url: 'https://other.example/a',
      },
    );
    expect(await other()).toEqual({ ok: true, data: { opened: true } });
    expect(
      (await browser.storage.session.get(PENDING_FOCUS_KEY))[PENDING_FOCUS_KEY],
    ).toBeUndefined();
  });

  it('quick-save command injects, asks the tab to capture and badges the result', async () => {
    const fakes = installFakes();
    background.main();
    // First ping (already active?) fails, injection starts a "content script" that answers.
    let injected = false;
    fakes.scripting.executeScript.mockImplementation(async () => {
      injected = true;
      return [];
    });
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({
      id: 8,
      url: 'https://example.com/a',
    } as never);
    vi.spyOn(browser.tabs, 'sendMessage').mockImplementation(async (_tabId, message) => {
      const { type } = message as { type: string };
      if (!injected)
        throw new Error('Could not establish connection. Receiving end does not exist.');
      if (type === 'content.ping') return { ok: true, data: { ready: true, version: '0.1.0' } };
      return {
        ok: true,
        data: {
          status: 'created',
          highlight: {
            id: 'hl-000001',
            sourceId: 'src-000001',
            exactQuote: 'q',
            anchorSet: {
              type: 'html',
              textAlgorithm: 'sv-text-v1',
              textQuote: { exact: 'q', prefix: '', suffix: '' },
              textPosition: { start: 0, end: 1 },
              structuralPath: null,
              contentSignature: 'x',
              documentTextLength: 1,
            },
            kind: 'essential',
            color: 'amber',
            priority: 3,
            userComment: '',
            headingContext: null,
            bankIds: [],
            capturedAt: '2026-10-11T00:00:00.000Z',
            resolveStatus: 'resolved',
            resolveConfidence: 1,
          },
          bank: { id: 'inbox-default', name: 'Inbox', color: 'blue', isInbox: true },
          addedToBank: true,
        },
      };
    });

    await Promise.all(
      fakes.commands.onCommand.listeners.map((l) =>
        (l as (c: string, t: object) => unknown)('quick-save', { id: 8, windowId: 1 }),
      ),
    );
    await vi.waitFor(async () => expect(await browser.action.getBadgeText({ tabId: 8 })).toBe('✓'));
    expect(fakes.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 8 },
      files: ['/content-scripts/highlighter.js'],
    });
  });

  it('tab.activate is answered even when scripting.executeScript never settles (view-source: tab)', async () => {
    vi.useFakeTimers();
    try {
      const fakes = installFakes();
      fakes.scripting.executeScript.mockImplementation(() => new Promise(() => undefined));
      vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 6 } as never); // address hidden
      vi.spyOn(browser.tabs, 'sendMessage').mockRejectedValue(
        new Error('Could not establish connection. Receiving end does not exist.'),
      );
      background.main();

      const replies: unknown[] = [];
      await fakeBrowser.runtime.onMessage.trigger(
        { v: 1, type: 'tab.activate', payload: { tabId: 6 } },
        { id: browser.runtime.id },
        (r: unknown) => replies.push(r),
      );
      await vi.advanceTimersByTimeAsync(ACTIVATE_TIMEOUT_MS);
      expect(replies).toMatchObject([{ ok: false, error: { code: 'unsupported_page' } }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
