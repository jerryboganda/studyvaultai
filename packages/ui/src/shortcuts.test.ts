import { describe, expect, it } from 'vitest';
import {
  COMMAND,
  IN_PAGE_KEYS,
  describeCommand,
  pickCommands,
  shortcutsPageUrl,
} from './shortcuts';

const all = [
  { name: 'open-side-panel', description: 'Open', shortcut: 'Alt+Shift+S' },
  { name: 'quick-save', description: 'Save', shortcut: '' },
  { name: 'next-highlight', description: 'Next', shortcut: 'Alt+Shift+Period' },
];

describe('shortcut helpers', () => {
  it('picks commands in the requested order and skips ones Chrome did not report', () => {
    expect(
      pickCommands(all, [COMMAND.quickSave, COMMAND.focusToolbar, COMMAND.openSidePanel]).map(
        (c) => c.name,
      ),
    ).toEqual(['quick-save', 'open-side-panel']);
  });

  it('the in-page keys are the two bracket keys that are not manifest commands', () => {
    expect(IN_PAGE_KEYS.map((k) => k.keys)).toEqual(['Alt+Shift+]', 'Alt+Shift+[']);
  });

  it('names the toolbar-button command in words when Chrome gives it no description', () => {
    expect(describeCommand('_execute_action', '')).toBe('Open the StudyVault popup');
    expect(describeCommand('quick-save', 'Quick-save the current selection')).toBe(
      'Quick-save the current selection',
    );
    expect(describeCommand('mystery', undefined)).toBe('mystery');
  });

  it('opens the right browser shortcuts page', () => {
    expect(shortcutsPageUrl('Mozilla/5.0 Chrome/130.0 Safari/537.36')).toBe(
      'chrome://extensions/shortcuts',
    );
    expect(shortcutsPageUrl('Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe(
      'edge://extensions/shortcuts',
    );
  });
});
