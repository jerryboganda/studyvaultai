import { Component, type ReactNode, type SyntheticEvent } from 'react';
import { useUi } from './context';
import { HighlightPopover } from './Popover';
import { useStore } from './store';
import { Toasts } from './Toasts';
import { ToolbarUnit } from './Toolbar';

const TEXT_ENTRY = 'input, textarea, select';

/**
 * Pressing a control must not collapse the page selection or pull focus off the page. Text entry
 * is the exception: it needs the caret, and focusing it is a deliberate act.
 */
function keepPageState(e: SyntheticEvent): void {
  if (e.target instanceof Element && e.target.closest(TEXT_ENTRY)) return;
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
