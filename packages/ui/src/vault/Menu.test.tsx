import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PopupMenu, type MenuItem } from './Menu';
import { CommandPalette, filterCommands, type Command } from './CommandPalette';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PopupMenu', () => {
  const make = (): MenuItem[] => [
    { id: 'a', label: 'Rename…', onSelect: vi.fn() },
    {
      id: 'b',
      label: 'Delete…',
      onSelect: vi.fn(),
      disabledReason: 'The Inbox cannot be deleted.',
    },
    { id: 'c', label: 'Merge…', onSelect: vi.fn() },
  ];

  it('focuses the first item and moves with the arrow keys, wrapping', () => {
    render(
      <PopupMenu label="Actions" items={make()} at={{ x: 5, y: 5 }} onClose={() => undefined} />,
    );
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
  });

  it('runs an enabled item and closes; a disabled one explains itself and does nothing', () => {
    const items = make();
    const onClose = vi.fn();
    render(<PopupMenu label="Actions" items={items} at={{ x: 0, y: 0 }} onClose={onClose} />);
    const [rename, del] = screen.getAllByRole('menuitem');
    expect(del!.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('The Inbox cannot be deleted.')).toBeTruthy();
    fireEvent.click(del!);
    expect(items[1]!.onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(rename!);
    expect(items[0]!.onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and gives focus back to the opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    render(<PopupMenu label="Actions" items={make()} at={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes on an outside pointer press', () => {
    const onClose = vi.fn();
    render(<PopupMenu label="Actions" items={make()} at={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CommandPalette', () => {
  const commands = (run = vi.fn()): Command[] => [
    { id: 'lib', label: 'Show all highlights', group: 'Go to', run },
    { id: 'trash', label: 'Show the trash', group: 'Go to', keywords: 'deleted restore', run },
    {
      id: 'sel',
      label: 'Move the selection to the trash',
      group: 'Selection',
      disabledReason: 'Select highlights first.',
      run,
    },
    { id: 'theme', label: 'Theme: dark', group: 'Appearance', run },
  ];

  it('filters by every word, label first', () => {
    const list = commands();
    expect(filterCommands(list, '').map((c) => c.id)).toEqual(['lib', 'trash', 'sel', 'theme']);
    expect(filterCommands(list, 'trash').map((c) => c.id)).toEqual(['trash', 'sel']);
    expect(filterCommands(list, 'restore').map((c) => c.id)).toEqual(['trash']);
    expect(filterCommands(list, 'go to all').map((c) => c.id)).toEqual(['lib']);
    expect(filterCommands(list, 'zzz')).toEqual([]);
    expect(filterCommands(list, 'THEME').map((c) => c.id)).toEqual(['theme']);
  });

  it('runs the chosen command after closing, and ignores disabled ones', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands(run)} onClose={onClose} />);
    const input = screen.getByRole('combobox');
    expect(screen.getAllByRole('option')).toHaveLength(4);

    fireEvent.change(input, { target: { value: 'selection' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getAllByText('Select highlights first.').length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('status')?.textContent).toContain(
      'unavailable: Select highlights first.',
    );

    fireEvent.change(input, { target: { value: 'show trash' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('moves the highlighted option with the arrow keys', () => {
    render(<CommandPalette commands={commands()} onClose={() => undefined} />);
    const input = screen.getByRole('combobox');
    const options = () => screen.getAllByRole('option');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('says so when nothing matches', () => {
    render(<CommandPalette commands={commands()} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qqqq' } });
    expect(screen.getByText(/No command matches/)).toBeTruthy();
  });
});
