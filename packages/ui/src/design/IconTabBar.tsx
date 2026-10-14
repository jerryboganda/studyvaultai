import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type IconTab<T extends string> = {
  id: T;
  /** <= 3 words; always visible under the icon. */
  label: string;
  icon: LucideIcon;
  /** Count bubble (due cards, items on the page); also read after the label. */
  count?: number;
};

export type IconTabBarProps<T extends string> = {
  /** Accessible name of the tab list, e.g. "Side panel". */
  label: string;
  /** The core tabs: Highlight & save, Banks, Review, Search. */
  tabs: IconTab<T>[];
  /** Adds the trailing "More" tab (everything else lives in its panel, e.g. a MoreGrid). */
  more?: { id: T; label?: string; count?: number };
  active: T;
  onChange: (id: T) => void;
  /** The active tab's panel. */
  children: ReactNode;
  className?: string;
};

/**
 * Icon + label tab bar with roving focus: arrows move and activate, Home/End jump, Tab goes to the
 * panel. Only the active panel is rendered, so only the active tab points at it.
 */
export function IconTabBar<T extends string>({
  label,
  tabs,
  more,
  active,
  onChange,
  children,
  className,
}: IconTabBarProps<T>) {
  const base = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const all: IconTab<T>[] = more
    ? [...tabs, { id: more.id, label: more.label ?? 'More', icon: Ellipsis, count: more.count }]
    : tabs;

  const onKeyDown = (e: KeyboardEvent) => {
    const i = all.findIndex((t) => t.id === active);
    const target =
      e.key === 'ArrowRight'
        ? all[(i + 1) % all.length]
        : e.key === 'ArrowLeft'
          ? all[(i - 1 + all.length) % all.length]
          : e.key === 'Home'
            ? all[0]
            : e.key === 'End'
              ? all[all.length - 1]
              : undefined;
    if (!target) return;
    e.preventDefault();
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div className={`sv-tabbar${className ? ` ${className}` : ''}`}>
      <div role="tablist" aria-label={label} className="sv-tabbar__list" onKeyDown={onKeyDown}>
        {all.map(({ id, label: name, icon: Icon, count }) => (
          <button
            key={id}
            ref={(el) => {
              if (el) refs.current.set(id, el);
              else refs.current.delete(id);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${id}`}
            aria-selected={id === active}
            aria-controls={id === active ? `${base}-panel` : undefined}
            tabIndex={id === active ? 0 : -1}
            className="sv-tabbar__tab"
            onClick={() => onChange(id)}
          >
            <span className="sv-tabbar__icon" aria-hidden="true">
              <Icon strokeWidth={2.4} />
              {count !== undefined && count > 0 && (
                <span className="sv-tabbar__count">{count > 99 ? '99+' : count}</span>
              )}
            </span>
            <span className="sv-tabbar__label">
              {name}
              {count !== undefined && count > 0 && <span className="sv-vh"> ({count})</span>}
            </span>
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${active}`}
        tabIndex={0}
        className="sv-tabbar__panel"
      >
        {children}
      </div>
    </div>
  );
}
