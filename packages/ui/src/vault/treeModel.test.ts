import { describe, expect, it } from 'vitest';
import { flattenVisible, treeKey, typeahead, type TreeItem } from './treeModel';

const leaf = (id: string, label = id): TreeItem => ({ id, label, children: [] });
const items: TreeItem[] = [
  {
    id: 'inbox',
    label: 'Inbox',
    children: [],
  },
  {
    id: 'bio',
    label: 'Biology',
    children: [
      {
        id: 'cells',
        label: 'Cells',
        children: [leaf('membrane', 'Membrane'), leaf('nucleus', 'Nucleus')],
      },
      leaf('genetics', 'Genetics'),
    ],
  },
  { id: 'chem', label: 'Chemistry', children: [leaf('organic', 'Organic')] },
];

describe('flattenVisible', () => {
  it('shows only children of expanded nodes, with level, siblings and state', () => {
    const v = flattenVisible(items, new Set(['bio']));
    expect(v.map((n) => n.item.id)).toEqual(['inbox', 'bio', 'cells', 'genetics', 'chem']);
    const cells = v.find((n) => n.item.id === 'cells')!;
    expect(cells).toMatchObject({
      level: 2,
      parentId: 'bio',
      index: 0,
      siblings: 2,
      expanded: false,
    });
    expect(v.find((n) => n.item.id === 'inbox')!.expanded).toBeNull();
    expect(v.find((n) => n.item.id === 'bio')!.expanded).toBe(true);
  });
});

describe('treeKey', () => {
  const visible = flattenVisible(items, new Set(['bio', 'cells']));
  const press = (focused: string, key: string, mods: Record<string, boolean> = {}) =>
    treeKey(visible, focused, { key, ...mods });

  it('Down/Up/Home/End move focus within the visible nodes', () => {
    expect(press('inbox', 'ArrowDown')).toEqual({ type: 'focus', id: 'bio' });
    expect(press('bio', 'ArrowUp')).toEqual({ type: 'focus', id: 'inbox' });
    expect(press('genetics', 'Home')).toEqual({ type: 'focus', id: 'inbox' });
    expect(press('inbox', 'End')).toEqual({ type: 'focus', id: 'chem' });
    expect(press('inbox', 'ArrowUp')).toBeNull();
  });

  it('Right opens a closed node, enters an open one and ignores leaves', () => {
    expect(press('chem', 'ArrowRight')).toEqual({ type: 'expand', id: 'chem' });
    expect(press('bio', 'ArrowRight')).toEqual({ type: 'focus', id: 'cells' });
    expect(press('inbox', 'ArrowRight')).toBeNull();
  });

  it('Left closes an open node, otherwise goes to the parent', () => {
    expect(press('bio', 'ArrowLeft')).toEqual({ type: 'collapse', id: 'bio' });
    expect(press('membrane', 'ArrowLeft')).toEqual({ type: 'focus', id: 'cells' });
    expect(press('inbox', 'ArrowLeft')).toBeNull();
  });

  it('Enter and Space activate; F2, Delete and the menu keys are reported', () => {
    expect(press('bio', 'Enter')).toEqual({ type: 'activate', id: 'bio' });
    expect(press('bio', ' ')).toEqual({ type: 'activate', id: 'bio' });
    expect(press('bio', 'F2')).toEqual({ type: 'rename', id: 'bio' });
    expect(press('bio', 'Delete')).toEqual({ type: 'delete', id: 'bio' });
    expect(press('bio', 'ContextMenu')).toEqual({ type: 'menu', id: 'bio' });
    expect(press('bio', 'F10', { shiftKey: true })).toEqual({ type: 'menu', id: 'bio' });
    expect(press('bio', 'F10')).toBeNull();
  });

  it('Alt+arrows are the keyboard alternative to dragging', () => {
    expect(press('genetics', 'ArrowUp', { altKey: true })).toEqual({
      type: 'move',
      id: 'genetics',
      direction: 'up',
    });
    expect(press('genetics', 'ArrowDown', { altKey: true })).toMatchObject({ direction: 'down' });
    expect(press('genetics', 'ArrowRight', { altKey: true })).toMatchObject({
      direction: 'indent',
    });
    expect(press('genetics', 'ArrowLeft', { altKey: true })).toMatchObject({
      direction: 'outdent',
    });
  });

  it('leaves browser shortcuts alone', () => {
    expect(press('bio', 'a', { ctrlKey: true })).toBeNull();
    expect(press('bio', 'ArrowDown', { metaKey: true })).toBeNull();
    expect(treeKey([], null, { key: 'ArrowDown' })).toBeNull();
  });

  it('falls back to the first node when the focused id is unknown', () => {
    expect(treeKey(visible, 'gone', { key: 'ArrowDown' })).toEqual({ type: 'focus', id: 'bio' });
  });
});

describe('typeahead', () => {
  const visible = flattenVisible(items, new Set(['bio']));
  it('jumps to the next label starting with the letter and wraps', () => {
    expect(typeahead(visible, 'inbox', 'c')).toBe('cells');
    expect(typeahead(visible, 'cells', 'c')).toBe('chem');
    expect(typeahead(visible, 'chem', 'c')).toBe('cells');
    expect(typeahead(visible, 'inbox', 'z')).toBeNull();
    expect(typeahead(visible, 'inbox', 'ab')).toBeNull();
  });
});
