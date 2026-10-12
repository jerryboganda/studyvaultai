import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VirtualList, type VirtualListProps } from './VirtualList';

afterEach(cleanup);

function setup(over: Partial<VirtualListProps> = {}) {
  const props: VirtualListProps = {
    label: 'Highlights',
    count: 10_000,
    rowHeight: 50,
    rowKey: (i) => `r${i}`,
    renderRow: (i) => <span>Row {i}</span>,
    activeIndex: -1,
    isSelected: () => false,
    onNavigate: vi.fn(),
    onToggle: vi.fn(),
    onActivate: vi.fn(),
    onRowClick: vi.fn(),
    fallbackViewportHeight: 500,
    overscan: 5,
    ...over,
  };
  const view = render(<VirtualList {...props} />);
  return { props, ...view, list: screen.getByRole('listbox', { name: 'Highlights' }) };
}

describe('VirtualList windowing', () => {
  it('renders a window of rows, not 10,000', () => {
    const { list } = setup();
    const options = screen.getAllByRole('option');
    // viewport (10 rows) + 1 + overscan below; none above at the top
    expect(options).toHaveLength(16);
    expect(options.length).toBeLessThan(40);
    expect(options[0]?.textContent).toContain('Row 0');
    expect(options[0]!.getAttribute('aria-posinset')).toBe('1');
    expect(options[0]!.getAttribute('aria-setsize')).toBe('10000');
    expect((list.firstElementChild as HTMLElement).style.height).toBe('500000px');
  });

  it('moves the window with the scroll position and positions rows absolutely', () => {
    const { list } = setup();
    list.scrollTop = 25_000;
    fireEvent.scroll(list);
    const options = screen.getAllByRole('option');
    expect(options.length).toBeLessThan(40);
    expect(options[0]?.textContent).toContain('Row 495');
    expect((options[0] as HTMLElement).style.top).toBe(`${495 * 50}px`);
    expect(screen.queryByText('Row 0')).toBeNull();
  });

  it('does not render the rows again for a scroll that stays inside the same row', () => {
    const renderRow = vi.fn((i: number) => <span>Row {i}</span>);
    const { list } = setup({ renderRow });
    list.scrollTop = 1_000; // row 20
    fireEvent.scroll(list);
    const calls = renderRow.mock.calls.length;
    list.scrollTop = 1_001;
    fireEvent.scroll(list);
    list.scrollTop = 1_049;
    fireEvent.scroll(list);
    expect(renderRow.mock.calls.length).toBe(calls);
    // Crossing into the next row moves the window.
    list.scrollTop = 1_050;
    fireEvent.scroll(list);
    expect(renderRow.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('Row 16');
  });

  it('stays small at the very end', () => {
    const { list } = setup();
    list.scrollTop = 10_000_000;
    fireEvent.scroll(list);
    expect(screen.getAllByRole('option').length).toBeLessThan(40);
    expect(screen.getByText('Row 9999')).toBeTruthy();
  });

  it('reports selection and the active row to assistive technology', () => {
    const { list } = setup({ count: 20, activeIndex: 3, isSelected: (i) => i === 3 || i === 4 });
    const selected = screen.getAllByRole('option', { selected: true });
    expect(selected.map((o) => o.textContent)).toEqual(['Row 3', 'Row 4']);
    const active = list.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)?.textContent).toContain('Row 3');
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
  });

  it('asks for more rows when the window reaches the end', () => {
    const onNearEnd = vi.fn();
    setup({ count: 8, onNearEnd });
    expect(onNearEnd).toHaveBeenCalled();
    const far = vi.fn();
    cleanup();
    setup({ count: 10_000, onNearEnd: far });
    expect(far).not.toHaveBeenCalled();
  });
});

describe('VirtualList keyboard', () => {
  it('moves with arrows, Home, End and pages; Shift extends', () => {
    const { props, list } = setup({ activeIndex: 10 });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(props.onNavigate).toHaveBeenLastCalledWith(11, false);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(props.onNavigate).toHaveBeenLastCalledWith(9, false);
    fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true });
    expect(props.onNavigate).toHaveBeenLastCalledWith(11, true);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(props.onNavigate).toHaveBeenLastCalledWith(0, false);
    fireEvent.keyDown(list, { key: 'End' });
    expect(props.onNavigate).toHaveBeenLastCalledWith(9_999, false);
    fireEvent.keyDown(list, { key: 'PageDown' });
    expect(props.onNavigate).toHaveBeenLastCalledWith(19, false); // 10 rows per viewport - 1
    fireEvent.keyDown(list, { key: 'PageUp' });
    expect(props.onNavigate).toHaveBeenLastCalledWith(1, false);
  });

  it('starts at the first row when nothing is active', () => {
    const { props, list } = setup({ activeIndex: -1 });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(props.onNavigate).toHaveBeenLastCalledWith(0, false);
  });

  it('does not run past either end', () => {
    const { props, list } = setup({ count: 3, activeIndex: 2 });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(props.onNavigate).toHaveBeenLastCalledWith(2, false);
  });

  it('Space toggles and Enter activates the active row', () => {
    const { props, list } = setup({ activeIndex: 4 });
    fireEvent.keyDown(list, { key: ' ' });
    expect(props.onToggle).toHaveBeenCalledWith(4);
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(props.onActivate).toHaveBeenCalledWith(4);
  });

  it('hands every other key, including modified arrows, to the owner', () => {
    const onKeyDown = vi.fn();
    const { props, list } = setup({ activeIndex: 4, onKeyDown });
    fireEvent.keyDown(list, { key: 'Delete' });
    fireEvent.keyDown(list, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(list, { key: 'ArrowDown', altKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(3);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it('a click on a row reports its index and the event', () => {
    const { props } = setup({ count: 30 });
    fireEvent.click(screen.getByText('Row 2'), { shiftKey: true });
    expect(props.onRowClick).toHaveBeenCalledTimes(1);
    const [index, event] = (props.onRowClick as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(index).toBe(2);
    expect((event as MouseEvent).shiftKey).toBe(true);
  });
});

describe('VirtualList row height under text-spacing overrides (WCAG 1.4.12)', () => {
  /** A ResizeObserver that records what it watches and lets a test report sizes. */
  class FakeObserver {
    static all: FakeObserver[] = [];
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      FakeObserver.all.push(this);
    }
    observe(el: Element) {
      this.targets.add(el);
    }
    unobserve(el: Element) {
      this.targets.delete(el);
    }
    disconnect() {
      this.targets.clear();
    }
  }

  /** Report that every row's content box is now `height` px tall. */
  function reportContentHeight(height: number) {
    const watcher = FakeObserver.all.find((o) =>
      [...o.targets].some((t) => t.classList.contains('sv-vrow__content')),
    )!;
    const entries = [...watcher.targets].map(
      (target) => ({ target, contentRect: { height } }) as unknown as ResizeObserverEntry,
    );
    act(() => watcher.callback(entries, watcher as unknown as ResizeObserver));
  }

  beforeEach(() => {
    FakeObserver.all = [];
    vi.stubGlobal('ResizeObserver', FakeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const heights = () => screen.getAllByRole('option').map((o) => (o as HTMLElement).style.height);

  it('keeps the given height while the content fits', () => {
    setup({ count: 100 });
    reportContentHeight(40);
    expect(new Set(heights())).toEqual(new Set(['50px']));
  });

  it('grows every row to the tallest content instead of clipping it, and never shrinks back', () => {
    const { list } = setup({ count: 100 });
    reportContentHeight(180); // plus the row's 1 px border
    expect(new Set(heights())).toEqual(new Set(['181px']));
    expect((list.firstElementChild as HTMLElement).style.height).toBe('18100px');
    const options = screen.getAllByRole('option') as HTMLElement[];
    expect(options[1]?.style.top).toBe('181px');

    reportContentHeight(120); // a shorter row scrolled into view: no jump back
    expect(new Set(heights())).toEqual(new Set(['181px']));
  });

  it('stays on the same first row when the height changes under a scrolled list', () => {
    const { list } = setup({ count: 1_000 });
    list.scrollTop = 5_000; // row 100
    fireEvent.scroll(list);
    reportContentHeight(150);
    expect(list.scrollTop).toBe(100 * 151);
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('Row 95'); // 5 rows of overscan
  });

  it('watches each row, not the list, and stops watching a row that leaves', () => {
    const { list } = setup({ count: 1_000 });
    const watcher = FakeObserver.all.find((o) =>
      [...o.targets].some((t) => t.classList.contains('sv-vrow__content')),
    )!;
    const before = watcher.targets.size;
    expect(before).toBe(screen.getAllByRole('option').length);
    list.scrollTop = 40_000;
    fireEvent.scroll(list);
    expect(watcher.targets.size).toBe(screen.getAllByRole('option').length);
    expect([...watcher.targets].every((t) => t.isConnected)).toBe(true);
  });
});
