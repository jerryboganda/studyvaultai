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

function setup(result: CaptureSelectionResult | Error = created()) {
  const shown: Array<{ tabId: number; badge: Badge }> = [];
  const deps = {
    activate: vi.fn(async (_tabId: number) => undefined),
    captureSelection: vi.fn(async (_tabId: number, _method: string) => {
      if (result instanceof Error) throw result;
      return result;
    }),
    openSidePanel: vi.fn(async (_windowId: number) => undefined),
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
});
