import {
  useImperativeHandle,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import {
  flattenVisible,
  treeKey,
  typeahead,
  type TreeItem,
  type TreeKeyResult,
  type VisibleNode,
} from './treeModel';

export interface TreeHandle {
  /** Move keyboard focus into the tree (to `id`, else the current item). */
  focus(id?: string): void;
}

export interface TreeProps {
  label: string;
  items: readonly TreeItem[];
  expanded: ReadonlySet<string>;
  onExpandedChange(next: Set<string>): void;
  /** The node that is "current" (aria-selected). Focus is separate and follows the arrow keys. */
  selectedId: string | null;
  renderItem(node: VisibleNode): ReactNode;
  /** Enter, Space or a click. */
  onActivate(id: string): void;
  /** F2, Delete, Alt+arrows. */
  onCommand(command: Extract<TreeKeyResult, { type: 'rename' | 'delete' | 'move' }>): void;
  /** Right click, the Menu key and Shift+F10. `at` is a viewport point for the menu. */
  onContextMenu(id: string, at: { x: number; y: number }): void;
  /** Extra attributes per node, used for drag and drop. */
  itemProps?(
    id: string,
  ): HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  ref?: Ref<TreeHandle>;
  className?: string;
}

/**
 * WAI-ARIA tree with a roving tabindex: one tab stop, arrows move focus, Enter/Space/click make a
 * node current. Rendered flat (aria-level carries the depth). Mutating keys (F2, Delete, Alt+arrows)
 * are only reported; the owner decides what they do and whether they are allowed.
 */
export function Tree({
  label,
  items,
  expanded,
  onExpandedChange,
  selectedId,
  renderItem,
  onActivate,
  onCommand,
  onContextMenu,
  itemProps,
  ref,
  className,
}: TreeProps) {
  const visible = flattenVisible(items, expanded);
  const [focused, setFocused] = useState<string | null>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());

  const ids = new Set(visible.map((n) => n.item.id));
  const roving =
    focused !== null && ids.has(focused)
      ? focused
      : selectedId !== null && ids.has(selectedId)
        ? selectedId
        : (visible[0]?.item.id ?? null);

  const focusNode = (id: string) => {
    setFocused(id);
    nodes.current.get(id)?.focus();
  };

  useImperativeHandle(
    ref,
    () => ({
      focus(id) {
        const target = id ?? roving;
        if (target) nodes.current.get(target)?.focus();
      },
    }),
    [roving],
  );

  const setExpanded = (id: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    onExpandedChange(next);
  };

  const anchorOf = (id: string) => {
    const rect = nodes.current.get(id)?.getBoundingClientRect();
    return { x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0 };
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // A field inside a row (inline rename) keeps its own keys.
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]'))
      return;
    const result = treeKey(visible, roving, e);
    if (result === null) {
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== ' ') {
        const hit = typeahead(visible, roving, e.key);
        if (hit) {
          e.preventDefault();
          focusNode(hit);
        }
      }
      return;
    }
    e.preventDefault();
    switch (result.type) {
      case 'focus':
        focusNode(result.id);
        break;
      case 'expand':
        setExpanded(result.id, true);
        break;
      case 'collapse':
        setExpanded(result.id, false);
        break;
      case 'activate':
        onActivate(result.id);
        break;
      case 'menu':
        onContextMenu(result.id, anchorOf(result.id));
        break;
      default:
        onCommand(result);
    }
  };

  return (
    <div
      role="tree"
      aria-label={label}
      className={`sv-tree${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
    >
      {visible.map((node) => {
        const id = node.item.id;
        const extra = itemProps?.(id) ?? {};
        return (
          <div
            key={id}
            {...extra}
            ref={(el) => {
              if (el) nodes.current.set(id, el);
              else nodes.current.delete(id);
            }}
            role="treeitem"
            tabIndex={id === roving ? 0 : -1}
            aria-level={node.level}
            aria-setsize={node.siblings}
            aria-posinset={node.index + 1}
            aria-expanded={node.expanded === null ? undefined : node.expanded}
            aria-selected={id === selectedId}
            data-tree-id={id}
            className="sv-treeitem"
            style={{ paddingInlineStart: `calc(var(--sv-space-2) + ${(node.level - 1) * 16}px)` }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocused(id);
            }}
            onClick={() => {
              setFocused(id);
              onActivate(id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              focusNode(id); // the menu hands focus back here when it closes
              onContextMenu(id, { x: e.clientX, y: e.clientY });
            }}
          >
            {node.expanded === null ? (
              <span className="sv-treeitem__twist" aria-hidden="true" />
            ) : (
              <span
                className="sv-treeitem__twist sv-treeitem__twist--btn"
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(id, !node.expanded);
                }}
              >
                {node.expanded ? '▾' : '▸'}
              </span>
            )}
            {renderItem(node)}
          </div>
        );
      })}
    </div>
  );
}
