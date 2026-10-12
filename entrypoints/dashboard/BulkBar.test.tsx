import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BulkBar, type BulkBarProps } from './BulkBar';

afterEach(cleanup);

function setup(over: Partial<BulkBarProps> = {}) {
  const props: BulkBarProps = {
    count: 3,
    totalMatching: 120,
    allFiltered: false,
    busy: false,
    onSelectAllFiltered: vi.fn(),
    onClear: vi.fn(),
    onMove: vi.fn(),
    onTags: vi.fn(),
    onSetKind: vi.fn(),
    onSetColor: vi.fn(),
    onSetPriority: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
  render(<BulkBar {...props} />);
  return props;
}

describe('BulkBar', () => {
  it('is absent while nothing is selected', () => {
    setup({ count: 0 });
    expect(screen.queryByRole('group', { name: /selected highlights/ })).toBeNull();
  });

  it('announces how many rows are selected', () => {
    setup();
    expect(screen.getByRole('group', { name: /selected highlights/ })).toBeTruthy();
    // It is not a toolbar: nothing here promises arrow-key movement between the buttons.
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('3 selected');
  });

  it('offers to select everything that matches, and says so afterwards', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 120 matching' }));
    expect(props.onSelectAllFiltered).toHaveBeenCalledTimes(1);

    cleanup();
    setup({ count: 120, allFiltered: true });
    expect(screen.queryByRole('button', { name: /Select all/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('everything that matches');
  });

  it('does not offer select-all when the selection already covers the result', () => {
    setup({ count: 120, totalMatching: 120 });
    expect(screen.queryByRole('button', { name: /Select all/ })).toBeNull();
  });

  it('opens a menu per attribute and reports the chosen value', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: /Kind/ }));
    const kinds = within(screen.getByRole('menu', { name: 'Set kind' })).getAllByRole('menuitem');
    expect(kinds).toHaveLength(7);
    fireEvent.click(kinds.find((k) => k.textContent?.includes('Formula'))!);
    expect(props.onSetKind).toHaveBeenCalledWith('formula');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Colour/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Teal' }));
    expect(props.onSetColor).toHaveBeenCalledWith('teal');

    fireEvent.click(screen.getByRole('button', { name: /Priority/ }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(5);
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority 5/ }));
    expect(props.onSetPriority).toHaveBeenCalledWith(5);
  });

  it('wires move, tags, delete and clear', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tags…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(props.onMove).toHaveBeenCalledTimes(1);
    expect(props.onTags).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks on actions while one is running', () => {
    const props = setup({ busy: true });
    const trash = screen.getByRole('button', { name: 'Move to trash' });
    expect(trash.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(trash);
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onMove).not.toHaveBeenCalled();
  });
});
