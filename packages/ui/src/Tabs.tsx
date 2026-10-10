import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: string;
  /** Shown after the label as "(n)"; omitted while unknown. */
  count?: number;
}

/**
 * WAI-ARIA tabs with automatic activation: roving tabindex, Left/Right (wrapping), Home and End.
 * Renders one tabpanel for the selected tab; the caller supplies that panel's content.
 */
export function Tabs({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  tabs: readonly TabDef[];
  value: string;
  onChange(id: string): void;
  children: ReactNode;
}) {
  const base = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const tabId = (id: string) => `${base}-tab-${id}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = Math.max(
      0,
      tabs.findIndex((t) => t.id === value),
    );
    let next: number;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    buttons.current.get(target.id)?.focus();
  };

  return (
    <>
      <div className="sv-tablist" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) buttons.current.set(t.id, el);
                else buttons.current.delete(t.id);
              }}
              id={tabId(t.id)}
              type="button"
              role="tab"
              className="sv-tab"
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
            >
              {t.label}
              {t.count === undefined ? null : <span className="sv-tab__count"> ({t.count})</span>}
            </button>
          );
        })}
      </div>
      <div
        id={`${base}-panel`}
        role="tabpanel"
        className="sv-tabpanel"
        aria-labelledby={tabId(value)}
        tabIndex={-1}
      >
        {children}
      </div>
    </>
  );
}
