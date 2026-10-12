import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MAX_INDENT_LEVELS, Tree, indentFor, type TreeProps } from './Tree';
import type { TreeItem } from './treeModel';

afterEach(cleanup);

const leaf = (id: string, label: string): TreeItem => ({ id, label, children: [] });
const ITEMS: TreeItem[] = [
  leaf('inbox', 'Inbox'),
  {
    id: 'bio',
    label: 'Biology',
    children: [
      { id: 'cells', label: 'Cells', children: [leaf('membrane', 'Membrane')] },
      leaf('genetics', 'Genetics'),
    ],
  },
  { id: 'chem', label: 'Chemistry', children: [leaf('organic', 'Organic')] },
];

function Harness(over: Partial<TreeProps> & { initial?: string[] }) {
  const [expanded, setExpanded] = useState(new Set(over.initial ?? ['bio']));
  return (
    <Tree
      label="Banks"
      items={ITEMS}
      expanded={expanded}
      onExpandedChange={(next) => {
        setExpanded(next);
        over.onExpandedChange?.(next);
      }}
      selectedId="inbox"
      renderItem={(n) => <span>{n.item.label}</span>}
      onActivate={over.onActivate ?? (() => undefined)}
      onCommand={over.onCommand ?? (() => undefined)}
      onContextMenu={over.onContextMenu ?? (() => undefined)}
    />
  );
}

const item = (name: string) => screen.getByRole('treeitem', { name });
const focus = (name: string) => act(() => item(name).focus());

describe('Tree', () => {
  it('exposes tree semantics', () => {
    render(<Harness />);
    expect(screen.getByRole('tree', { name: 'Banks' })).toBeTruthy();
    const items = screen.getAllByRole('treeitem');
    expect(items.map((i) => i.textContent?.replace(/[▾▸]/g, ''))).toEqual([
      'Inbox',
      'Biology',
      'Cells',
      'Genetics',
      'Chemistry',
    ]);
    expect(item('Biology').getAttribute('aria-expanded')).toBe('true');
    expect(item('Chemistry').getAttribute('aria-expanded')).toBe('false');
    expect(item('Inbox').getAttribute('aria-expanded')).toBeNull();
    expect(item('Cells').getAttribute('aria-level')).toBe('2');
    expect(item('Genetics').getAttribute('aria-posinset')).toBe('2');
    expect(item('Genetics').getAttribute('aria-setsize')).toBe('2');
    expect(item('Inbox').getAttribute('aria-selected')).toBe('true');
  });

  it('is one tab stop (roving tabindex) that follows focus', () => {
    render(<Harness />);
    const stops = () =>
      screen
        .getAllByRole('treeitem')
        .filter((i) => i.tabIndex === 0)
        .map((s) => s.getAttribute('data-tree-id'));
    expect(stops()).toEqual(['inbox']);
    focus('Inbox');
    fireEvent.keyDown(item('Inbox'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Biology'));
    expect(stops()).toEqual(['bio']);
    fireEvent.keyDown(item('Biology'), { key: 'End' });
    expect(document.activeElement).toBe(item('Chemistry'));
    fireEvent.keyDown(item('Chemistry'), { key: 'Home' });
    expect(document.activeElement).toBe(item('Inbox'));
  });

  it('expands and collapses with Right and Left, and walks into and out of children', () => {
    const onExpandedChange = vi.fn();
    render(<Harness onExpandedChange={onExpandedChange} />);
    focus('Chemistry');
    fireEvent.keyDown(item('Chemistry'), { key: 'ArrowRight' });
    expect([...(onExpandedChange.mock.calls.at(-1)![0] as Set<string>)].sort()).toEqual([
      'bio',
      'chem',
    ]);
    expect(screen.getByRole('treeitem', { name: 'Organic' })).toBeTruthy();

    fireEvent.keyDown(item('Chemistry'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item('Organic'));
    fireEvent.keyDown(item('Organic'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item('Chemistry'));
    fireEvent.keyDown(item('Chemistry'), { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: 'Organic' })).toBeNull();
  });

  it('activates with Enter, Space and click', () => {
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    focus('Biology');
    fireEvent.keyDown(item('Biology'), { key: 'Enter' });
    fireEvent.keyDown(item('Biology'), { key: ' ' });
    fireEvent.click(item('Genetics'));
    expect(onActivate.mock.calls.map((c) => c[0])).toEqual(['bio', 'bio', 'genetics']);
  });

  it('reports rename, delete and the Alt+arrow moves instead of dragging', () => {
    const onCommand = vi.fn();
    render(<Harness onCommand={onCommand} />);
    focus('Genetics');
    fireEvent.keyDown(item('Genetics'), { key: 'F2' });
    fireEvent.keyDown(item('Genetics'), { key: 'Delete' });
    fireEvent.keyDown(item('Genetics'), { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(item('Genetics'), { key: 'ArrowRight', altKey: true });
    expect(onCommand.mock.calls.map((c) => c[0])).toEqual([
      { type: 'rename', id: 'genetics' },
      { type: 'delete', id: 'genetics' },
      { type: 'move', id: 'genetics', direction: 'up' },
      { type: 'move', id: 'genetics', direction: 'indent' },
    ]);
  });

  it('opens the context menu from the keyboard and the pointer', () => {
    const onContextMenu = vi.fn();
    render(<Harness onContextMenu={onContextMenu} />);
    focus('Cells');
    fireEvent.keyDown(item('Cells'), { key: 'ContextMenu' });
    fireEvent.keyDown(item('Cells'), { key: 'F10', shiftKey: true });
    fireEvent.contextMenu(item('Genetics'), { clientX: 40, clientY: 60 });
    expect(onContextMenu.mock.calls.map((c) => c[0])).toEqual(['cells', 'cells', 'genetics']);
    expect(onContextMenu.mock.calls[2]![1]).toEqual({ x: 40, y: 60 });
    expect(document.activeElement).toBe(item('Genetics'));
  });

  it('jumps to a node by typing its first letter', () => {
    render(<Harness />);
    focus('Inbox');
    fireEvent.keyDown(item('Inbox'), { key: 'g' });
    expect(document.activeElement).toBe(item('Genetics'));
  });

  it('leaves keys typed inside a field in a row alone', () => {
    const onCommand = vi.fn();
    render(
      <Tree
        label="Banks"
        items={[leaf('a', 'Alpha')]}
        expanded={new Set()}
        onExpandedChange={() => undefined}
        selectedId={null}
        renderItem={() => <input aria-label="rename" />}
        onActivate={() => undefined}
        onCommand={onCommand}
        onContextMenu={() => undefined}
      />,
    );
    const input = within(screen.getByRole('treeitem')).getByLabelText('rename');
    fireEvent.keyDown(input, { key: 'Delete' });
    fireEvent.keyDown(input, { key: 'F2' });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('stops indenting after a few levels while aria-level keeps the real depth', () => {
    // 32 nested folders: the deepest label must not be pushed off a narrow panel.
    let node: TreeItem = leaf('n32', 'Level 32');
    for (let i = 31; i >= 1; i--) node = { id: `n${i}`, label: `Level ${i}`, children: [node] };
    render(
      <Tree
        label="Banks"
        items={[node]}
        expanded={new Set(Array.from({ length: 32 }, (_, i) => `n${i + 1}`))}
        onExpandedChange={() => undefined}
        selectedId={null}
        renderItem={(n) => <span>{n.item.label}</span>}
        onActivate={() => undefined}
        onCommand={() => undefined}
        onContextMenu={() => undefined}
      />,
    );
    const deepest = screen.getByRole('treeitem', { name: 'Level 32' });
    expect(deepest.getAttribute('aria-level')).toBe('32');
    const capped = `calc(var(--sv-space-2) + ${MAX_INDENT_LEVELS * 16}px)`;
    expect(deepest.style.paddingInlineStart).toBe(capped);
    expect(screen.getByRole('treeitem', { name: 'Level 9' }).style.paddingInlineStart).toBe(capped);
    expect(screen.getByRole('treeitem', { name: 'Level 3' }).style.paddingInlineStart).toBe(
      'calc(var(--sv-space-2) + 32px)',
    );
    expect(indentFor(1)).toBe(0);
    expect(indentFor(0)).toBe(0);
  });
});
