import { Component, type ReactNode, type SyntheticEvent } from 'react';
import { useUi } from './context';
import { HighlightPopover } from './Popover';
import { useStore } from './store';
import { Toasts } from './Toasts';
import { ToolbarUnit } from './Toolbar';

/**
 * Pressing a control must not collapse the page selection or pull focus off the page. A native
 * <select> is the exception: it cannot open without its mousedown. The overlay has no free-text
 * fields (page scripts can observe keystrokes typed in the page); text is typed in the side panel.
 */
function keepPageState(e: SyntheticEvent): void {
  if (e.target instanceof Element && e.target.closest('select')) return;
  e.preventDefault();
}

/** A render failure must not leave the overlay dead for the rest of the page's life. */
class Boundary extends Component<{ resetKey: unknown; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.warn('[StudyVault] overlay render failed', error);
  }

  override componentDidUpdate(prev: { resetKey: unknown }): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function Overlay() {
  const { store } = useUi();
  const settings = useStore(store, (s) => s.settings);
  const toolbar = useStore(store, (s) => s.toolbar);
  const popover = useStore(store, (s) => s.popover);

  return (
    <Boundary resetKey={toolbar?.selection.text ?? popover?.highlight.id ?? null}>
      <div
        className="sv-root"
        data-density={settings.density}
        onPointerDown={keepPageState}
        onMouseDown={keepPageState}
      >
        {toolbar ? (
          <ToolbarUnit key={toolbar.selection.text} selection={toolbar.selection} />
        ) : null}
        {popover ? (
          <HighlightPopover
            key={popover.highlight.id}
            highlight={popover.highlight}
            anchor={popover.anchor}
          />
        ) : null}
        <Toasts />
      </div>
    </Boundary>
  );
}
