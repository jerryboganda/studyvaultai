import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { SETTINGS_SECTIONS } from '@ui/shell/paths';
import { moveIndex, sectionFromHash } from './model';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
const hashNow = (): string => window.location.hash;

/**
 * The settings sections as a navigation landmark. Each entry is a plain link to `#section` (so a
 * section can be linked to, and the browser's own scrolling and history work). Only one entry is in
 * the Tab order at a time (roving tabindex); arrow keys, Home and End move between them.
 */
export function SectionNav() {
  const hash = useSyncExternalStore(subscribe, hashNow, () => '');
  const current = sectionFromHash(hash);
  const links = useRef<Array<HTMLAnchorElement | null>>([]);
  /** The entry that was focused last; before any focus, the section the address names, else the first. */
  const [focused, setFocused] = useState<number | null>(null);
  const currentIndex = SETTINGS_SECTIONS.findIndex((s) => s.id === current);
  const stop = focused ?? (currentIndex >= 0 ? currentIndex : 0);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = moveIndex(e.key, stop, SETTINGS_SECTIONS.length);
    if (target === null) return;
    e.preventDefault();
    setFocused(target);
    links.current[target]?.focus();
  };

  return (
    <nav className="opt__nav" aria-label="Settings sections">
      <ul className="opt__navlist" onKeyDown={onKeyDown}>
        {SETTINGS_SECTIONS.map((s, i) => (
          <li key={s.id}>
            <a
              ref={(el) => {
                links.current[i] = el;
              }}
              href={`#${s.id}`}
              className="opt__navlink"
              tabIndex={i === stop ? 0 : -1}
              aria-current={s.id === current ? 'location' : undefined}
              onFocus={() => setFocused(i)}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
