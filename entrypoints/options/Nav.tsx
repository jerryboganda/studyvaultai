import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Settings as Gear } from 'lucide-react';
import { OPTION_SECTIONS, moveIndex, sectionFromHash, type OptionSectionId } from './model';
import { ArtTile, SECTION_LOOK } from './ui';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
const hashNow = (): string => window.location.hash;

/** The section the address names (`options.html#game`), or null for the settings home. */
export function useHashSection(): OptionSectionId | null {
  return sectionFromHash(useSyncExternalStore(subscribe, hashNow, () => ''));
}

const ENTRIES = [
  { id: null, label: 'Home', icon: Gear, tone: 'primary' as const },
  ...OPTION_SECTIONS.map((s) => ({ id: s.id, label: s.label, ...SECTION_LOOK[s.id] })),
];

/**
 * The settings sections as a navigation landmark (a left rail on a wide page). Each entry is a
 * plain link to `#section`, so a section can be linked to and the browser's history works. Only
 * one entry is in the Tab order at a time (roving tabindex); arrow keys, Home and End move.
 */
export function SectionNav({ current }: { current: OptionSectionId | null }) {
  const links = useRef<Array<HTMLAnchorElement | null>>([]);
  /** The entry that was focused last; before any focus, the current section. */
  const [focused, setFocused] = useState<number | null>(null);
  const stop =
    focused ??
    Math.max(
      0,
      ENTRIES.findIndex((e) => e.id === current),
    );

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = moveIndex(e.key, stop, ENTRIES.length);
    if (target === null) return;
    e.preventDefault();
    setFocused(target);
    links.current[target]?.focus();
  };

  return (
    <nav className="opt-nav" aria-label="Settings sections">
      <ul className="opt-nav__list" onKeyDown={onKeyDown}>
        {ENTRIES.map((s, i) => (
          <li key={s.id ?? 'home'}>
            <a
              ref={(el) => {
                links.current[i] = el;
              }}
              href={s.id ? `#${s.id}` : '#'}
              className="opt-nav__link"
              tabIndex={i === stop ? 0 : -1}
              aria-current={s.id === current ? 'page' : undefined}
              onFocus={() => setFocused(i)}
            >
              <ArtTile icon={s.icon} tone={s.tone} />
              <span className="opt-nav__label">{s.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
