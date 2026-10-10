import type { CaptureMethod, CaptureSelectionResult } from '@shared';

/** Keyboard commands and the selection context menu: capture outcome is reported on the badge. */

export const MENU_ID = 'sv-save-selection';
export const MENU_TITLE = 'Save selection to StudyVault';

export interface Badge {
  text: string;
  title: string;
  tone: 'success' | 'error';
}

export interface TabRef {
  id?: number;
  windowId?: number;
}

export interface CommandDeps {
  /** Make sure a content script answers in the tab (throws StudyVaultError otherwise). */
  activate(tabId: number): Promise<void>;
  captureSelection(tabId: number, method: CaptureMethod): Promise<CaptureSelectionResult>;
  openSidePanel(windowId: number): Promise<void>;
  /** Shows the badge on the tab and clears it again shortly after (best effort). */
  showBadge(tabId: number, badge: Badge): Promise<void>;
}

export interface MenuPort {
  removeAll(): Promise<void>;
  create(item: {
    id: string;
    title: string;
    contexts: ['selection'];
    documentUrlPatterns: string[];
  }): Promise<void>;
}

const success = (title: string): Badge => ({
  text: '✓',
  title: `StudyVault: ${title}`,
  tone: 'success',
});
const failure = (title: string): Badge => ({
  text: '!',
  title: `StudyVault: ${title}`,
  tone: 'error',
});

export function badgeForResult(result: CaptureSelectionResult): Badge {
  switch (result.status) {
    case 'created':
      return success(`saved to "${result.bank.name}".`);
    case 'restored':
      return success(`restored a removed highlight in "${result.bank.name}".`);
    case 'duplicate':
      return success(
        result.addedToBank
          ? `already saved; added to "${result.bank.name}".`
          : `already saved in "${result.bank.name}".`,
      );
    case 'no-selection':
      return failure('select some text on the page first.');
    case 'blocked':
      return failure(result.reason);
  }
}

export function badgeForError(err: unknown): Badge {
  return failure(err instanceof Error ? err.message : String(err));
}

/** Idempotent: removeAll first so a re-install or update never hits a duplicate id. */
export async function installContextMenu(menus: MenuPort): Promise<void> {
  await menus.removeAll();
  await menus.create({
    id: MENU_ID,
    title: MENU_TITLE,
    contexts: ['selection'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
}

export function createCommandHandlers(deps: CommandDeps) {
  /** activeTab is granted by the command / menu click; activate() injects when needed. */
  async function capture(tab: TabRef | undefined, method: CaptureMethod): Promise<void> {
    const tabId = tab?.id;
    if (tabId === undefined) return;
    let badge: Badge;
    try {
      await deps.activate(tabId);
      badge = badgeForResult(await deps.captureSelection(tabId, method));
    } catch (err) {
      badge = badgeForError(err);
    }
    await deps.showBadge(tabId, badge).catch(() => undefined); // the tab may have been closed
  }

  return {
    onCommand(command: string, tab: TabRef | undefined): Promise<void> {
      if (command === 'quick-save') return capture(tab, 'shortcut');
      if (command === 'open-side-panel') {
        // No await before open(): sidePanel.open needs the user gesture of the command.
        if (tab?.windowId === undefined) return Promise.resolve();
        return deps.openSidePanel(tab.windowId).catch(async (err: unknown) => {
          if (tab.id !== undefined) {
            await deps.showBadge(tab.id, badgeForError(err)).catch(() => undefined);
          }
        });
      }
      return Promise.resolve();
    },

    onMenuClick(menuItemId: string | number, tab: TabRef | undefined): Promise<void> {
      return menuItemId === MENU_ID ? capture(tab, 'context-menu') : Promise.resolve();
    },
  };
}
