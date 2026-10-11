import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  onSelect(): void;
  /** Why the item cannot be used. It stays focusable and the reason is shown under the label. */
  disabledReason?: string;
  danger?: boolean;
  separatorBefore?: boolean;
  /** Shortcut hint shown at the end of the row. */
  hint?: string;
}

/**
 * Context / action menu (role="menu"). Opens at a viewport point, focuses its first item, moves with
 * the arrow keys, closes on Escape, Tab or an outside click and hands focus back to the control that
 * had it. Disabled items explain themselves instead of silently doing nothing.
 */
export function PopupMenu({
  label,
  items,
  at,
  onClose,
}: {
  label: string;
  items: readonly MenuItem[];
  at: { x: number; y: number };
  onClose(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [at.x, at.y]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const close = () => {
    opener.current?.focus();
    onClose();
  };

  const focusItem = (index: number) => {
    const buttons = root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!buttons || buttons.length === 0) return;
    const next = (index + buttons.length) % buttons.length;
    setActive(next);
    buttons[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(active - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(0);
        break;
      case 'End':
        e.preventDefault();
        focusItem(items.length - 1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        e.preventDefault();
        close();
        break;
      default:
    }
  };

  return (
    <div
      ref={root}
      role="menu"
      aria-label={label}
      className="sv-menu"
      style={{ left: at.x, top: at.y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <div key={item.id} role="none">
          {item.separatorBefore ? <hr className="sv-menu__sep" /> : null}
          <button
            type="button"
            role="menuitem"
            tabIndex={i === active ? 0 : -1}
            aria-disabled={item.disabledReason ? true : undefined}
            className={`sv-menu__item${item.danger ? ' sv-menu__item--danger' : ''}`}
            data-menu-id={item.id}
            onFocus={() => setActive(i)}
            onClick={() => {
              if (item.disabledReason) return;
              // Focus goes back first so a dialog opened by the action remembers the right opener.
              opener.current?.focus();
              onClose();
              item.onSelect();
            }}
          >
            <span className="sv-menu__label">{item.label}</span>
            {item.hint ? <span className="sv-menu__hint sv-muted">{item.hint}</span> : null}
            {item.disabledReason ? (
              <span className="sv-menu__reason sv-muted">{item.disabledReason}</span>
            ) : null}
          </button>
        </div>
      ))}
    </div>
  );
}
