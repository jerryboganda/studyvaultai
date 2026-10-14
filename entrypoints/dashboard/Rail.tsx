import { useRef, type ReactNode } from 'react';
import {
  Command,
  Ellipsis,
  House,
  Layers,
  Library,
  Search,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { reviewPageUrl } from '@ui/review';
import { useDismissibleDetails } from './hooks';

export type RailItem = 'home' | 'banks' | 'search' | 'more';

/** The product mark (blue tile with the yellow highlight bar); decorative. */
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="dash-logo">
      <rect width="32" height="32" rx="8" fill="#2a62e5" />
      <rect x="7" y="8" width="18" height="3" rx="1.5" fill="#fff" />
      <rect x="5.5" y="13.5" width="21" height="5" rx="2" fill="#ffc83d" />
      <rect x="8.5" y="15.2" width="15" height="1.6" rx="0.8" fill="#18213b" />
      <rect x="7" y="21" width="12" height="3" rx="1.5" fill="#fff" />
    </svg>
  );
}

function Item({
  icon: Icon,
  label,
  current,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  current?: boolean;
  onClick(): void;
  testId: string;
}) {
  return (
    <li>
      <button
        type="button"
        className="dash-nav__item"
        aria-current={current ? 'page' : undefined}
        onClick={onClick}
        data-testid={testId}
      >
        <Icon aria-hidden="true" strokeWidth={2.4} />
        <span className="dash-nav__label">{label}</span>
      </button>
    </li>
  );
}

/**
 * Left rail (UX_DESIGN 7.3 and 9): Home, Banks, Review, Search, More, then Commands, View options
 * and Settings at the bottom. Below 900px it is a bar across the top. Review is the review page,
 * opened as a link in a new tab.
 */
export function Rail({
  current,
  dueCount,
  onGo,
  onPalette,
  onSettings,
  viewOptions,
}: {
  current: RailItem | null;
  /** Cards ready today (a badge on Review), or null while unknown. */
  dueCount: number | null;
  onGo(item: RailItem): void;
  onPalette(): void;
  onSettings(): void;
  /** The View options popover (a <details>). */
  viewOptions: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  useDismissibleDetails(root);
  return (
    <nav ref={root} className="dash-rail" aria-label="Dashboard" data-testid="dash-rail">
      <LogoMark />
      <ul className="dash-nav">
        <Item
          icon={House}
          label="Home"
          current={current === 'home'}
          onClick={() => onGo('home')}
          testId="nav-home"
        />
        <Item
          icon={Library}
          label="Banks"
          current={current === 'banks'}
          onClick={() => onGo('banks')}
          testId="nav-banks"
        />
        <li>
          <a
            className="dash-nav__item"
            href={reviewPageUrl()}
            target="_blank"
            rel="noopener noreferrer"
            // The badge is decoration: the name says the count, after the visible word.
            aria-label={dueCount ? `Review (${dueCount.toLocaleString()} due)` : undefined}
            data-testid="nav-review"
          >
            <span className="dash-nav__icon" aria-hidden="true">
              <Layers strokeWidth={2.4} />
              {dueCount ? (
                <span className="dash-nav__count">{dueCount > 99 ? '99+' : dueCount}</span>
              ) : null}
            </span>
            <span className="dash-nav__label">Review</span>
          </a>
        </li>
        <Item
          icon={Search}
          label="Search"
          current={current === 'search'}
          onClick={() => onGo('search')}
          testId="nav-search"
        />
        <Item
          icon={Ellipsis}
          label="More"
          current={current === 'more'}
          onClick={() => onGo('more')}
          testId="nav-more"
        />
      </ul>
      <ul className="dash-nav dash-nav--end">
        <li>
          <button
            type="button"
            className="dash-nav__item"
            onClick={onPalette}
            aria-keyshortcuts="Control+K"
            data-testid="open-palette"
          >
            <Command aria-hidden="true" strokeWidth={2.4} />
            <span className="dash-nav__label">Commands</span>
          </button>
        </li>
        <li className="dash-nav__pop">{viewOptions}</li>
        <Item icon={Settings} label="Settings" onClick={onSettings} testId="nav-settings" />
      </ul>
    </nav>
  );
}
