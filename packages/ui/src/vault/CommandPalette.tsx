import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface Command {
  id: string;
  label: string;
  /** Section shown at the end of the row ("Go to", "Selection", ...). */
  group: string;
  /** Extra words that should find the command. */
  keywords?: string;
  /** Key hint such as "Ctrl+K". */
  hint?: string;
  /** Why the command cannot run right now; it is still listed so it can be discovered. */
  disabledReason?: string;
  run(): void;
}

const fold = (text: string) => text.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * Every whitespace-separated word of `query` must occur in the label, group or keywords. Commands
 * whose label starts with the first word come first; otherwise the given order is kept.
 */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  const hits = commands.filter((c) => {
    const hay = fold(`${c.label} ${c.group} ${c.keywords ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
  const first = words[0]!;
  return [
    ...hits.filter((c) => fold(c.label).startsWith(first)),
    ...hits.filter((c) => !fold(c.label).startsWith(first)),
  ];
}

/**
 * Command palette on a native modal <dialog>: focus is trapped, Escape closes and focus returns to
 * the control that had it. The input is a combobox over a listbox; arrows move, Enter runs.
 */
export function CommandPalette({
  commands,
  onClose,
}: {
  commands: readonly Command[];
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [note, setNote] = useState('');

  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    input.current?.focus();
    return () => {
      if (typeof el.close === 'function' && el.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const results = filterCommands(commands, query);
  const index = Math.min(active, Math.max(0, results.length - 1));
  const current = results[index];
  const optionId = (id: string) => `${uid}-${id}`;

  const run = (command: Command | undefined) => {
    if (!command) return;
    if (command.disabledReason) {
      setNote(`${command.label} is unavailable: ${command.disabledReason}`);
      return;
    }
    onClose();
    // After the dialog has closed and focus has returned, so commands that move focus win.
    setTimeout(() => command.run(), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(results.length - 1, index + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, index - 1));
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(current);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="sv-dialog sv-palette"
      aria-label="Command palette"
      data-testid="command-palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="sv-dialog__body sv-stack sv-stack--tight">
        <label className="sv-label" htmlFor={`${uid}-input`}>
          Type a command
        </label>
        <input
          ref={input}
          id={`${uid}-input`}
          className="sv-control"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(current.id) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          data-testid="palette-input"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setNote('');
          }}
          onKeyDown={onKeyDown}
        />
        <div
          id={`${uid}-list`}
          role="listbox"
          aria-label="Commands"
          className="sv-palette__list"
          data-testid="palette-list"
        >
          {results.length === 0 ? (
            <p className="sv-muted sv-palette__none" role="option" aria-selected="false">
              No command matches “{query}”.
            </p>
          ) : (
            results.map((c, i) => (
              <div
                key={c.id}
                id={optionId(c.id)}
                role="option"
                aria-selected={i === index}
                aria-disabled={c.disabledReason ? true : undefined}
                className="sv-palette__item"
                data-command-id={c.id}
                onMouseMove={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span className="sv-palette__label">{c.label}</span>
                {c.disabledReason ? (
                  <span className="sv-palette__reason sv-muted sv-small">{c.disabledReason}</span>
                ) : null}
                <span className="sv-palette__meta sv-muted sv-small">
                  {c.hint ? <kbd className="sv-kbd">{c.hint}</kbd> : null} {c.group}
                </span>
              </div>
            ))
          )}
        </div>
        <p role="status" className="sv-small sv-muted">
          {note || 'Arrow keys choose, Enter runs, Escape closes.'}
        </p>
      </div>
    </dialog>
  );
}
