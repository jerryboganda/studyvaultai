import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { computeWindow, scrollTopFor } from './virtual';

export interface VirtualListProps {
  /** Accessible name of the listbox. */
  label: string;
  count: number;
  /** Total rows the user can reach (more may still be loading); announced as aria-setsize. */
  setSize?: number;
  rowHeight: number;
  rowKey(index: number): string;
  renderRow(index: number): ReactNode;
  /** The row that has keyboard focus (aria-activedescendant); -1 for none. */
  activeIndex: number;
  isSelected(index: number): boolean;
  multiselectable?: boolean;
  overscan?: number;
  /** Used until the real height is measured (and in environments without layout). */
  fallbackViewportHeight?: number;
  /** Arrow/Home/End/Page keys. `extend` is true while Shift is held. */
  onNavigate(index: number, extend: boolean): void;
  /** Space. */
  onToggle(index: number): void;
  /** Enter. */
  onActivate(index: number): void;
  onRowClick(index: number, event: MouseEvent): void;
  /** Keys this list does not handle itself (Delete, Ctrl+A, ...). */
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
  /** The window reached the last loaded rows: load the next page. */
  onNearEnd?(): void;
  className?: string;
  ref?: Ref<HTMLDivElement>;
  'aria-describedby'?: string;
}

/**
 * Windowed listbox: only the rows in (and just around) the viewport exist in the DOM, so 10,000 rows
 * cost the same as 20. Focus stays on the listbox and moves with aria-activedescendant, which is the
 * listbox pattern for lists whose rows come and go. Rows must be non-interactive (an option cannot
 * contain controls); anything clickable belongs in the preview pane.
 */
export function VirtualList({
  label,
  count,
  setSize,
  rowHeight,
  rowKey,
  renderRow,
  activeIndex,
  isSelected,
  multiselectable = true,
  overscan = 6,
  fallbackViewportHeight = 600,
  onNavigate,
  onToggle,
  onActivate,
  onRowClick,
  onKeyDown,
  onNearEnd,
  className,
  ref,
  'aria-describedby': describedBy,
}: VirtualListProps) {
  const base = useId();
  const element = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState(0);
  const viewportHeight = measured > 0 ? measured : fallbackViewportHeight;

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
    },
    [ref],
  );

  // Measure the real viewport; the observer reports once on observe() and again on every resize.
  useEffect(() => {
    const el = element.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setMeasured(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const win = computeWindow({ count, rowHeight, scrollTop, viewportHeight, overscan });

  // Keep the active row on screen when it changes (keyboard, deep link, selection from elsewhere).
  useEffect(() => {
    const el = element.current;
    if (!el || activeIndex < 0) return;
    const next = scrollTopFor(
      activeIndex,
      rowHeight,
      el.scrollTop,
      el.clientHeight || viewportHeight,
    );
    if (next !== el.scrollTop) el.scrollTop = next;
    // Only the index matters: a user who scrolls away with the wheel must not be pulled back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const nearEnd = count > 0 && win.end >= count - 2;
  useEffect(() => {
    if (nearEnd) onNearEnd?.();
  }, [nearEnd, count, onNearEnd]);

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) {
      onKeyDown?.(e);
      return;
    }
    const last = count - 1;
    const page = Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
    const from = activeIndex < 0 ? 0 : activeIndex;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = activeIndex < 0 ? 0 : Math.min(last, from + 1);
        break;
      case 'ArrowUp':
        next = activeIndex < 0 ? 0 : Math.max(0, from - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'PageDown':
        next = Math.min(last, from + page);
        break;
      case 'PageUp':
        next = Math.max(0, from - page);
        break;
      case ' ':
        if (activeIndex >= 0) {
          e.preventDefault();
          onToggle(activeIndex);
          return;
        }
        break;
      case 'Enter':
        if (activeIndex >= 0) {
          e.preventDefault();
          onActivate(activeIndex);
          return;
        }
        break;
      default:
        onKeyDown?.(e);
        return;
    }
    if (next === null || count === 0) return;
    e.preventDefault();
    onNavigate(next, e.shiftKey);
  };

  const rows: ReactNode[] = [];
  for (let i = win.start; i < win.end; i++) {
    rows.push(
      <div
        key={rowKey(i)}
        id={`${base}-${rowKey(i)}`}
        role="option"
        aria-selected={isSelected(i)}
        aria-posinset={i + 1}
        aria-setsize={setSize ?? count}
        data-index={i}
        data-active={i === activeIndex ? '' : undefined}
        className="sv-vrow"
        style={{ top: i * rowHeight, height: rowHeight }}
        onClick={(e) => onRowClick(i, e)}
      >
        {renderRow(i)}
      </div>,
    );
  }

  return (
    <div
      ref={setRefs}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-multiselectable={multiselectable || undefined}
      aria-describedby={describedBy}
      aria-activedescendant={
        activeIndex >= 0 && activeIndex >= win.start && activeIndex < win.end
          ? `${base}-${rowKey(activeIndex)}`
          : undefined
      }
      className={`sv-vlist${className ? ` ${className}` : ''}`}
      onScroll={(e: { currentTarget: HTMLDivElement }) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={handleKey}
    >
      <div className="sv-vlist__spacer" style={{ height: win.totalHeight }}>
        {rows}
      </div>
    </div>
  );
}
