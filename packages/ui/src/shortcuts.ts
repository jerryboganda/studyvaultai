/** One manifest command as Chrome reports it (`commands.getAll`). `shortcut` is '' when none is set. */
export interface ShortcutInfo {
  name: string;
  description: string;
  shortcut: string;
}

/**
 * Chrome reports the toolbar-button command `_execute_action` with an empty description (the
 * manifest cannot declare one): name it in words instead of showing the internal id.
 */
export function describeCommand(name: string, description: string | undefined): string {
  if (description) return description;
  return name === '_execute_action' ? 'Open the StudyVault popup' : name;
}

/** Manifest command names (wxt.config.ts). The keys themselves are always read from Chrome. */
export const COMMAND = {
  openSidePanel: 'open-side-panel',
  quickSave: 'quick-save',
  focusToolbar: 'focus-toolbar',
  nextHighlight: 'next-highlight',
  previousHighlight: 'previous-highlight',
} as const;

/**
 * Keys the page overlay handles itself. `[` and `]` are not valid manifest shortcut keys, so these
 * cannot be remapped in Chrome; they work while the page has focus and StudyVault runs on it.
 */
export const IN_PAGE_KEYS = [
  { keys: 'Alt+Shift+]', action: 'Go to the next highlight on the page' },
  { keys: 'Alt+Shift+[', action: 'Go to the previous highlight on the page' },
] as const;

/** Extension pages cannot be linked to from a page: open this through `tabs.create`. */
export function shortcutsPageUrl(userAgent: string): string {
  return /\bEdg\//.test(userAgent)
    ? 'edge://extensions/shortcuts'
    : 'chrome://extensions/shortcuts';
}

/** The named commands, in the order asked for; commands Chrome did not report are left out. */
export function pickCommands(
  commands: readonly ShortcutInfo[],
  names: readonly string[],
): ShortcutInfo[] {
  return names.flatMap((name) => commands.filter((c) => c.name === name));
}
