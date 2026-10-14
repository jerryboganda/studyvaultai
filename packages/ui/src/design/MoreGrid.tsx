import type { LucideIcon } from 'lucide-react';
import type { Tone } from './motion';

export type MoreItem = {
  id: string;
  /** <= 3 words. */
  label: string;
  icon: LucideIcon;
  tone?: Tone;
  /** Short status pill, e.g. "Off" or "3 new"; part of the tile's name. */
  status?: string;
  onSelect: () => void;
};

/** Icon tiles for everything outside the core tabs. */
export function MoreGrid({
  items,
  label,
  columns,
}: {
  items: MoreItem[];
  /** Accessible name of the list, e.g. "More tools". */
  label: string;
  /** Most columns to use; fewer when narrow. */
  columns?: 2 | 3 | 4;
}) {
  return (
    <ul className={`sv-moregrid${columns ? ` sv-moregrid--${columns}` : ''}`} aria-label={label}>
      {items.map(({ id, label: name, icon: Icon, tone = 'primary', status, onSelect }) => (
        <li key={id}>
          <button type="button" className="sv-moretile" onClick={onSelect}>
            <span className={`sv-moretile__icon sv-art--${tone}`} aria-hidden="true">
              <Icon strokeWidth={2.4} />
            </span>
            <span className="sv-moretile__label">{name}</span>
            {status && (
              <span className="sv-moretile__status">
                <span className="sv-vh">, </span>
                {status}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
