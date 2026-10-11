/**
 * Keyboard model of the ARIA tree (pure, unit-tested). The component only renders and forwards keys;
 * every decision about what a key means lives here so it can be tested without a DOM.
 */

export interface TreeItem {
  id: string;
  label: string;
  children: TreeItem[];
}

export interface VisibleNode {
  item: TreeItem;
  /** 1 for a root. */
  level: number;
  parentId: string | null;
  /** Position among siblings (0-based) and how many siblings there are. */
  index: number;
  siblings: number;
  /** null for a leaf. */
  expanded: boolean | null;
}

/** The nodes that are on screen, in reading order: a node is visible when all ancestors are expanded. */
export function flattenVisible(
  roots: readonly TreeItem[],
  expanded: ReadonlySet<string>,
): VisibleNode[] {
  const out: VisibleNode[] = [];
  const walk = (items: readonly TreeItem[], level: number, parentId: string | null) => {
    items.forEach((item, index) => {
      const open = item.children.length === 0 ? null : expanded.has(item.id);
      out.push({ item, level, parentId, index, siblings: items.length, expanded: open });
      if (open) walk(item.children, level + 1, item.id);
    });
  };
  walk(roots, 1, null);
  return out;
}

export type TreeMoveDirection = 'up' | 'down' | 'indent' | 'outdent';

export type TreeKeyResult =
  | { type: 'focus'; id: string }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'rename'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'menu'; id: string }
  | { type: 'move'; id: string; direction: TreeMoveDirection };

export interface KeyLike {
  key: string;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** What a key press means for the focused node. `null`: not a tree key, leave it to the browser. */
export function treeKey(
  visible: readonly VisibleNode[],
  focusedId: string | null,
  event: KeyLike,
): TreeKeyResult | null {
  if (visible.length === 0) return null;
  const at = Math.max(
    0,
    visible.findIndex((n) => n.item.id === focusedId),
  );
  const node = visible[at]!;
  const id = node.item.id;
  const focus = (i: number): TreeKeyResult => ({ type: 'focus', id: visible[i]!.item.id });

  if (event.ctrlKey || event.metaKey) return null;

  if (event.altKey) {
    switch (event.key) {
      case 'ArrowUp':
        return { type: 'move', id, direction: 'up' };
      case 'ArrowDown':
        return { type: 'move', id, direction: 'down' };
      case 'ArrowRight':
        return { type: 'move', id, direction: 'indent' };
      case 'ArrowLeft':
        return { type: 'move', id, direction: 'outdent' };
      default:
        return null;
    }
  }

  switch (event.key) {
    case 'ArrowDown':
      return at + 1 < visible.length ? focus(at + 1) : null;
    case 'ArrowUp':
      return at > 0 ? focus(at - 1) : null;
    case 'Home':
      return focus(0);
    case 'End':
      return focus(visible.length - 1);
    case 'ArrowRight':
      if (node.expanded === false) return { type: 'expand', id };
      if (node.expanded === true) return at + 1 < visible.length ? focus(at + 1) : null;
      return null;
    case 'ArrowLeft': {
      if (node.expanded === true) return { type: 'collapse', id };
      if (node.parentId !== null) return { type: 'focus', id: node.parentId };
      return null;
    }
    case 'Enter':
    case ' ':
      return { type: 'activate', id };
    case 'F2':
      return { type: 'rename', id };
    case 'Delete':
      return { type: 'delete', id };
    case 'ContextMenu':
      return { type: 'menu', id };
    case 'F10':
      return event.shiftKey ? { type: 'menu', id } : null;
    default:
      return null;
  }
}

/**
 * First-letter navigation: the next visible node after the focused one whose label starts with
 * `char` (wraps). Null when nothing matches.
 */
export function typeahead(
  visible: readonly VisibleNode[],
  focusedId: string | null,
  char: string,
): string | null {
  if (char.length !== 1 || visible.length === 0) return null;
  const needle = char.toLocaleLowerCase();
  const from = Math.max(
    0,
    visible.findIndex((n) => n.item.id === focusedId),
  );
  for (let step = 1; step <= visible.length; step++) {
    const candidate = visible[(from + step) % visible.length]!;
    if (candidate.item.label.toLocaleLowerCase().startsWith(needle)) return candidate.item.id;
  }
  return null;
}
