// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { StudyVaultError, type CaptureSelectionResult } from '@shared';
import {
  MENU_ID,
  badgeForError,
  badgeForResult,
  createCommandHandlers,
  installContextMenu,
  type Badge,
  type CommandDeps,
} from './commands';
import { createBadgePort } from './platform';

const BANK = { id: 'inbox-default', name: 'Inbox', color: 'blue', isInbox: true } as const;
const created = (over: Record<string, unknown> = {}) =>
  ({
    status: 'created',
    highlight: {} as never,
    bank: BANK,
    addedToBank: true,
    ...over,
  }) as CaptureSelectionResult;

function setup(
  result: CaptureSelectionResult | Error = created(),
  options: { allowIncognito?: boolean } = {},
) {
  const shown: Array<{ tabId: number; badge: Badge }> = [];
  const deps = {
    activate: vi.fn(async (_tabId: number) => undefined),
    allowIncognitoCapture: vi.fn(async () => options.allowIncognito ?? false),
    focusToolbar: vi.fn(async (_tabId: number) => ({ focused: true })),
    stepHighlight: vi.fn(async (_tabId: number, _direction: 'next' | 'previous') => ({
      found: true,
    })),
    captureSelection: vi.fn(async (_tabId: number, _method: string) => {
      if (result instanceof Error) throw result;
      return result;
    }),
    openSidePanel: vi.fn(async (_windowId: number) => undefined),
    isDashboardUrl: vi.fn(
      (url: string | undefined) =>
        url?.startsWith('chrome-extension://abc/dashboard.html') ?? false,
    ),
    requestSearchFocus: vi.fn(async (_target: 'panel' | 'dashboard') => undefined),
    showBadge: vi.fn(async (tabId: number, badge: Badge) => {
      shown.push({ tabId, badge });
    }),
  } satisfies CommandDeps;
  return { deps, shown, commands: createCommandHandlers(deps) };
}

describe('badge outcome mapping', () => {
  const cases: Array<[string, CaptureSelectionResult, string, string]> = [
    ['created', created(), '✓', 'saved to "Inbox"'],
    ['restored', created({ status: 'restored' }), '✓', 'restored a removed highlight'],
    [
      'duplicate (new bank)',
      created({ status: 'duplicate', addedToBank: true }),
      '✓',
      'added to "Inbox"',
    ],
    [
      'duplicate (same bank)',
      created({ status: 'duplicate', addedToBank: false }),
      '✓',
      'already saved in "Inbox"',
    ],
    ['no selection', { status: 'no-selection' }, '!', 'select some text'],
    [
      'blocked',
      { status: 'blocked', reason: 'Toolbar is turned off.' },
      '!',
      'Toolbar is turned off.',
    ],
  ];
  it.each(cases)('%s', (_name, result, text, titlePart) => {
    const badge = badgeForResult(result);
    expect(badge.text).toBe(text);
    expect(badge.title).toContain(titlePart);
    expect(badge.tone).toBe(text === '!' ? 'error' : 'success');
  });

  it('turns errors into an explanatory "!"', () => {
    expect(badgeForError(new StudyVaultError('unsupported_page', 'Not on this page.'))).toEqual({
      text: '!',
      title: 'StudyVault: Not on this page.',
      tone: 'error',
    });
    expect(badgeForError('plain').title).toBe('StudyVault: plain');
  });
});

describe('quick-save command and context menu', () => {
  it('activates the tab, captures with method "shortcut" and shows a check mark', async () => {
    const t = setup(created());
    await t.commands.onCommand('quick-save', { id: 11, windowId: 2 });
    expect(t.deps.activate).toHaveBeenCalledWith(11);
    expect(t.deps.captureSelection).toHaveBeenCalledWith(11, 'shortcut');
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]!.tabId).toBe(11);
    expect(t.shown[0]!.badge.text).toBe('✓');
    expect(t.deps.activate.mock.invocationCallOrder[0]!).toBeLessThan(
      t.deps.captureSelection.mock.invocationCallOrder[0]!,
    );
  });

  it('context menu click uses method "context-menu"; other menu ids are ignored', async () => {
    const t = setup(created());
    await t.commands.onMenuClick('someone-elses-item', { id: 4 });
    expect(t.deps.captureSelection).not.toHaveBeenCalled();
    await t.commands.onMenuClick(MENU_ID, { id: 4 });
    expect(t.deps.captureSelection).toHaveBeenCalledWith(4, 'context-menu');
    expect(t.shown[0]!.badge.text).toBe('✓');
  });

  it('reports "no selection" on the badge', async () => {
    const t = setup({ status: 'no-selection' });
    await t.commands.onCommand('quick-save', { id: 1 });
    expect(t.shown[0]!.badge).toMatchObject({ text: '!', tone: 'error' });
    expect(t.shown[0]!.badge.title).toMatch(/select some text/);
  });

  it('reports activation failures (unsupported page, deny list) without capturing', async () => {
    const t = setup();
    t.deps.activate.mockRejectedValueOnce(
      new StudyVaultError('unsupported_page', 'StudyVault cannot run on this page.'),
    );
    await t.commands.onCommand('quick-save', { id: 1 });
    expect(t.deps.captureSelection).not.toHaveBeenCalled();
    expect(t.shown[0]!.badge).toEqual({
      text: '!',
      title: 'StudyVault: StudyVault cannot run on this page.',
      tone: 'error',
    });
  });

  it('reports capture failures from the page', async () => {
    const t = setup(new StudyVaultError('forbidden', 'StudyVault is turned off on example.com.'));
    await t.commands.onCommand('quick-save', { id: 1 });
    expect(t.shown[0]!.badge.title).toContain('turned off on example.com');
  });

  it('does nothing when the event carries no tab id', async () => {
    const t = setup();
    await t.commands.onCommand('quick-save', undefined);
    await t.commands.onMenuClick(MENU_ID, {});
    expect(t.deps.activate).not.toHaveBeenCalled();
    expect(t.shown).toEqual([]);
  });

  it('survives the badge call failing (tab closed meanwhile)', async () => {
    const t = setup(created());
    t.deps.showBadge.mockRejectedValueOnce(new Error('No tab with id: 1'));
    await expect(t.commands.onCommand('quick-save', { id: 1 })).resolves.toBeUndefined();
  });
});

describe('private windows', () => {
  it('refuses the shortcut and the menu before injecting anything', async () => {
    const t = setup(created());
    await t.commands.onCommand('quick-save', { id: 4, incognito: true });
    await t.commands.onMenuClick(MENU_ID, { id: 4, incognito: true });
    expect(t.deps.activate).not.toHaveBeenCalled();
    expect(t.deps.captureSelection).not.toHaveBeenCalled();
    expect(t.shown).toHaveLength(2);
    for (const { tabId, badge } of t.shown) {
      expect(tabId).toBe(4);
      expect(badge).toMatchObject({ text: '!', tone: 'error' });
      expect(badge.title).toMatch(/private \(incognito\) windows/);
    }
  });

  it('captures there once the user allowed it, and never asks for normal tabs', async () => {
    const allowed = setup(created(), { allowIncognito: true });
    await allowed.commands.onCommand('quick-save', { id: 4, incognito: true });
    expect(allowed.deps.captureSelection).toHaveBeenCalledWith(4, 'shortcut');

    const normal = setup(created());
    await normal.commands.onCommand('quick-save', { id: 5, incognito: false });
    await normal.commands.onCommand('quick-save', { id: 5 });
    expect(normal.deps.captureSelection).toHaveBeenCalledTimes(2);
    expect(normal.deps.allowIncognitoCapture).not.toHaveBeenCalled();
  });

  it('reports a settings read failure instead of capturing', async () => {
    const t = setup(created());
    t.deps.allowIncognitoCapture.mockRejectedValueOnce(new Error('storage down'));
    await t.commands.onCommand('quick-save', { id: 4, incognito: true });
    expect(t.deps.captureSelection).not.toHaveBeenCalled();
    expect(t.shown[0]!.badge.title).toContain('storage down');
  });
});

describe('focus-toolbar, next-highlight and previous-highlight commands', () => {
  it('focus-toolbar starts the script, then focuses, and is silent on success', async () => {
    const t = setup();
    await t.commands.onCommand('focus-toolbar', { id: 6, windowId: 1 });
    expect(t.deps.activate).toHaveBeenCalledWith(6);
    expect(t.deps.focusToolbar).toHaveBeenCalledWith(6);
    expect(t.deps.activate.mock.invocationCallOrder[0]!).toBeLessThan(
      t.deps.focusToolbar.mock.invocationCallOrder[0]!,
    );
    expect(t.shown).toEqual([]);
  });

  it('focus-toolbar says so on the badge when there is nothing to focus', async () => {
    const t = setup();
    t.deps.focusToolbar.mockResolvedValueOnce({ focused: false });
    await t.commands.onCommand('focus-toolbar', { id: 6 });
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]!.badge).toMatchObject({ text: '!', tone: 'error' });
    expect(t.shown[0]!.badge.title).toMatch(/select some text/);
  });

  it.each([
    ['next-highlight', 'next'],
    ['previous-highlight', 'previous'],
  ] as const)('%s starts the script and steps %s', async (command, direction) => {
    const t = setup();
    await t.commands.onCommand(command, { id: 8 });
    expect(t.deps.activate).toHaveBeenCalledWith(8);
    expect(t.deps.stepHighlight).toHaveBeenCalledWith(8, direction);
    expect(t.shown).toEqual([]);
  });

  it('stepping reports found:false on the badge', async () => {
    const t = setup();
    t.deps.stepHighlight.mockResolvedValueOnce({ found: false });
    await t.commands.onCommand('next-highlight', { id: 8 });
    expect(t.shown[0]!.badge).toMatchObject({ text: '!', tone: 'error' });
    expect(t.shown[0]!.badge.title).toMatch(/no highlights/);
  });

  it('reports activation and transport failures like quick-save does', async () => {
    const t = setup();
    t.deps.activate.mockRejectedValueOnce(
      new StudyVaultError('unsupported_page', 'StudyVault cannot run on this page.'),
    );
    await t.commands.onCommand('next-highlight', { id: 8 });
    expect(t.deps.stepHighlight).not.toHaveBeenCalled();
    expect(t.shown[0]!.badge.title).toContain('cannot run on this page');

    t.deps.focusToolbar.mockRejectedValueOnce(
      new StudyVaultError('no_receiver', 'Could not establish connection.'),
    );
    await t.commands.onCommand('focus-toolbar', { id: 8 });
    expect(t.shown[1]!.badge).toMatchObject({ text: '!', tone: 'error' });
  });

  it('does nothing without a tab, and ignores look-alike command names', async () => {
    const t = setup();
    await t.commands.onCommand('focus-toolbar', undefined);
    await t.commands.onCommand('next-highlight', {});
    await t.commands.onCommand('constructor', { id: 1 });
    await t.commands.onCommand('toString', { id: 1 });
    expect(t.deps.activate).not.toHaveBeenCalled();
    expect(t.shown).toEqual([]);
  });
});

describe('open-side-panel command', () => {
  it('opens the panel for the tab window synchronously (user gesture) ', async () => {
    const t = setup();
    const pending = t.commands.onCommand('open-side-panel', { id: 1, windowId: 9 });
    expect(t.deps.openSidePanel).toHaveBeenCalledWith(9); // before any await resolved
    await pending;
  });

  it('shows an error badge when the panel cannot be opened', async () => {
    const t = setup();
    t.deps.openSidePanel.mockRejectedValueOnce(
      new Error('may only be called in response to a user gesture'),
    );
    await t.commands.onCommand('open-side-panel', { id: 3, windowId: 9 });
    expect(t.shown[0]).toMatchObject({ tabId: 3, badge: { text: '!', tone: 'error' } });
  });

  it('ignores unknown commands and missing windows', async () => {
    const t = setup();
    await t.commands.onCommand('open-side-panel', { id: 1 });
    await t.commands.onCommand('something-else', { id: 1, windowId: 1 });
    expect(t.deps.openSidePanel).not.toHaveBeenCalled();
  });
});

describe('focus-search command', () => {
  it('opens the side panel from the gesture, then asks it to focus its search box', async () => {
    const t = setup();
    const order: string[] = [];
    t.deps.openSidePanel.mockImplementationOnce(async () => {
      order.push('open');
    });
    t.deps.requestSearchFocus.mockImplementationOnce(async (target) => {
      order.push(`request:${target}`);
    });
    const pending = t.commands.onCommand('focus-search', {
      id: 1,
      windowId: 9,
      url: 'https://example.org/page',
    });
    expect(t.deps.openSidePanel).toHaveBeenCalledWith(9); // before any await resolved
    await pending;
    expect(order).toEqual(['open', 'request:panel']);
    expect(t.shown).toEqual([]);
  });

  it('asks the dashboard itself when the dashboard is the page in front, and opens no panel', async () => {
    const t = setup();
    await t.commands.onCommand('focus-search', {
      id: 2,
      windowId: 9,
      url: 'chrome-extension://abc/dashboard.html?bank=b1',
    });
    expect(t.deps.requestSearchFocus).toHaveBeenCalledWith('dashboard');
    expect(t.deps.openSidePanel).not.toHaveBeenCalled();
    expect(t.deps.activate).not.toHaveBeenCalled(); // no content script involved
  });

  it('does not ask for focus when the panel could not be opened, and says so on the badge', async () => {
    const t = setup();
    t.deps.openSidePanel.mockRejectedValueOnce(
      new Error('may only be called in response to a user gesture'),
    );
    await t.commands.onCommand('focus-search', { id: 3, windowId: 9, url: 'https://example.org/' });
    expect(t.deps.requestSearchFocus).not.toHaveBeenCalled();
    expect(t.shown[0]).toMatchObject({ tabId: 3, badge: { text: '!', tone: 'error' } });
  });

  it('reports a failed hand-over instead of dropping it', async () => {
    const t = setup();
    t.deps.requestSearchFocus.mockRejectedValueOnce(new Error('session storage is not available'));
    await t.commands.onCommand('focus-search', { id: 4, windowId: 9, url: 'https://example.org/' });
    expect(t.shown[0]?.badge.title).toContain('session storage is not available');
  });

  it('does nothing without a window (and never opens a panel for it)', async () => {
    const t = setup();
    await t.commands.onCommand('focus-search', { id: 5, url: 'https://example.org/' });
    expect(t.deps.openSidePanel).not.toHaveBeenCalled();
    expect(t.deps.requestSearchFocus).not.toHaveBeenCalled();
  });
});

describe('installContextMenu', () => {
  it('removes existing items first, then creates the selection item (idempotent)', async () => {
    const log: string[] = [];
    const menus = {
      removeAll: vi.fn(async () => {
        log.push('removeAll');
      }),
      create: vi.fn(async (item: { id: string }) => {
        log.push(`create:${item.id}`);
      }),
    };
    await installContextMenu(menus);
    await installContextMenu(menus);
    expect(log).toEqual(['removeAll', `create:${MENU_ID}`, 'removeAll', `create:${MENU_ID}`]);
    expect(menus.create.mock.calls[0]![0]).toEqual({
      id: MENU_ID,
      title: 'Save selection to StudyVault',
      contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  });
});

describe('badge port (fakeBrowser.action)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('sets tab-scoped text, colour and title, then restores them after ~3 s', async () => {
    const show = createBadgePort('StudyVault AI');
    await show(5, { text: '✓', title: 'StudyVault: saved to "Inbox".', tone: 'success' });
    expect(await fakeBrowser.action.getBadgeText({ tabId: 5 })).toBe('✓');
    expect(await fakeBrowser.action.getTitle({ tabId: 5 })).toBe('StudyVault: saved to "Inbox".');
    expect(await fakeBrowser.action.getBadgeText({})).toBe(''); // other tabs untouched

    await vi.advanceTimersByTimeAsync(3000);
    expect(await fakeBrowser.action.getBadgeText({ tabId: 5 })).toBe('');
    expect(await fakeBrowser.action.getTitle({ tabId: 5 })).toBe('StudyVault AI');
  });

  it('puts back the toolbar count of the reminders feature, not a blank, on that tab', async () => {
    // The global badge is what every other tab shows (docs/adr/019-reminders.md).
    await fakeBrowser.action.setBadgeText({ text: '12' });
    await fakeBrowser.action.setTitle({ title: 'StudyVault AI: 12 cards due' });
    const show = createBadgePort('StudyVault AI');
    await show(5, { text: '✓', title: 'StudyVault: saved to "Inbox".', tone: 'success' });
    expect(await fakeBrowser.action.getBadgeText({ tabId: 5 })).toBe('✓');

    await vi.advanceTimersByTimeAsync(3000);
    expect(await fakeBrowser.action.getBadgeText({ tabId: 5 })).toBe('12');
    expect(await fakeBrowser.action.getTitle({ tabId: 5 })).toBe('StudyVault AI: 12 cards due');
  });
});
