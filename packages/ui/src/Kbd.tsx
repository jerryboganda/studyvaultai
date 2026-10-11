import type { ShortcutInfo } from './shortcuts';

/** A key combination as text, or an honest "Not set" when the user has cleared it in Chrome. */
export function Kbd({ shortcut }: { shortcut: string }) {
  return shortcut ? (
    <kbd className="sv-kbd">{shortcut}</kbd>
  ) : (
    <span className="sv-muted">Not set</span>
  );
}

/** "Alt+Shift+H  Quick-save the current selection" lines for the commands Chrome reported. */
export function ShortcutHints({ commands }: { commands: readonly ShortcutInfo[] }) {
  if (commands.length === 0) return null;
  return (
    <ul className="sv-stack sv-stack--tight sv-small">
      {commands.map((c) => (
        <li key={c.name} className="sv-hint">
          <Kbd shortcut={c.shortcut} /> <span>{c.description || c.name}</span>
        </li>
      ))}
    </ul>
  );
}
