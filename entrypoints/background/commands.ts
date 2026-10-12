import {
  INCOGNITO_CAPTURE_REFUSAL,
  type CaptureMethod,
  type CaptureSelectionResult,
  type SearchFocusTarget,
} from '@shared';

/**
 * Keyboard commands and the selection context menu: the outcome is reported on the badge. Captures
 * are refused in private windows unless the user allowed them (the database is shared).
 */

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
  incognito?: boolean;
  /** Present for the tab a command was run in (the command grants activeTab). */
  url?: string;
}

export type StepDirection = 'next' | 'previous';

export interface CommandDeps {
  /** Make sure a content script answers in the tab (throws StudyVaultError otherwise). */
  activate(tabId: number): Promise<void>;
  captureSelection(tabId: number, method: CaptureMethod): Promise<CaptureSelectionResult>;
  openSidePanel(windowId: number): Promise<void>;
  /** settings.allowIncognitoCapture */
  allowIncognitoCapture(): Promise<boolean>;
  /** Move keyboard focus into the selection toolbar (or toast) of the tab. */
  focusToolbar(tabId: number): Promise<{ focused: boolean }>;
  /** Scroll to the next / previous visible highlight of the tab. */
  stepHighlight(tabId: number, direction: StepDirection): Promise<{ found: boolean }>;
  /** The address is the dashboard page of this extension. */
  isDashboardUrl(url: string | undefined): boolean;
  /**
   * Ask a surface to put the keyboard in its search box: written to chrome.storage.session, read by
   * the side panel (on mount and on change) or the dashboard.
   */
  requestSearchFocus(target: SearchFocusTarget): Promise<void>;
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

const STEP_COMMANDS = new Map<string, StepDirection>([
  ['next-highlight', 'next'],
  ['previous-highlight', 'previous'],
]);

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
    await report(tabId, async () => {
      // Before anything is injected: a private tab is refused, not started and then refused.
      if (tab?.incognito === true && !(await deps.allowIncognitoCapture())) {
        return failure(INCOGNITO_CAPTURE_REFUSAL);
      }
      await deps.activate(tabId);
      return badgeForResult(await deps.captureSelection(tabId, method));
    });
  }

  /** Run a command in a tab and show its badge; a null outcome (nothing to report) shows none. */
  async function report(tabId: number, run: () => Promise<Badge | null>): Promise<void> {
    let badge: Badge | null;
    try {
      badge = await run();
    } catch (err) {
      badge = badgeForError(err);
    }
    if (badge === null) return;
    await deps.showBadge(tabId, badge).catch(() => undefined); // the tab may have been closed
  }

  /** The content script is started first (the command grants activeTab), then asked. Only failures show. */
  async function inTab(
    tab: TabRef | undefined,
    ask: (tabId: number) => Promise<Badge | null>,
  ): Promise<void> {
    const tabId = tab?.id;
    if (tabId === undefined) return;
    await report(tabId, async () => {
      await deps.activate(tabId);
      return ask(tabId);
    });
  }

  return {
    onCommand(command: string, tab: TabRef | undefined): Promise<void> {
      if (command === 'quick-save') return capture(tab, 'shortcut');
      if (command === 'focus-toolbar') {
        return inTab(tab, async (tabId) =>
          (await deps.focusToolbar(tabId)).focused
            ? null
            : failure('select some text on the page first; there is no toolbar to focus.'),
        );
      }
      const direction = STEP_COMMANDS.get(command);
      if (direction !== undefined) {
        return inTab(tab, async (tabId) =>
          (await deps.stepHighlight(tabId, direction)).found
            ? null
            : failure('no highlights are visible on this page.'),
        );
      }
      if (command === 'focus-search') {
        // The dashboard in front has its own search box: no panel to open.
        if (deps.isDashboardUrl(tab?.url)) {
          return deps.requestSearchFocus('dashboard').catch(async (err: unknown) => {
            if (tab?.id !== undefined) {
              await deps.showBadge(tab.id, badgeForError(err)).catch(() => undefined);
            }
          });
        }
        if (tab?.windowId === undefined) return Promise.resolve();
        // No await before open(): sidePanel.open needs the user gesture of the command. The request
        // is written once the panel is open, so a panel that mounts later still finds it.
        return deps
          .openSidePanel(tab.windowId)
          .then(() => deps.requestSearchFocus('panel'))
          .catch(async (err: unknown) => {
            if (tab.id !== undefined) {
              await deps.showBadge(tab.id, badgeForError(err)).catch(() => undefined);
            }
          });
      }
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
