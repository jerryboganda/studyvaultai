import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  COLOR_SWATCH,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  type CaptureResult,
  type HighlightKind,
} from '@shared';
import type { SaveRequest, SelectionInfo } from '../contract';
import { Composer } from './Composer';
import { errorMessage, openSidePanel, useUi } from './context';
import { pushToast, useStore } from './store';
import { floatingStyle, useFloating } from './useFloating';

const DEFAULT_PRIORITY = 3;
/** Undo stays longer after a keyboard save: the user first has to press the Focus toolbar shortcut. */
const KEYBOARD_UNDO_MS = 15000;
const NOTE_IN_PANEL = 'write your note in the side panel';

interface ToolbarAction {
  key: string;
  /** Accessible name. Includes the visible text (WCAG 2.5.3). */
  name: string;
  content: ReactNode;
  swatch?: string;
  expanded?: boolean;
  /** Starts a visual group (extra space; no divider, which would strand itself when the bar wraps). */
  groupStart?: boolean;
  onActivate(): void;
}

/** `note`: the side panel is open on this highlight, so say where to write the note. */
function savedNotice(result: CaptureResult, note: boolean): { text: string; undoable: boolean } {
  const bank = result.bank.name;
  switch (result.status) {
    case 'created':
      return { text: note ? `Saved - ${NOTE_IN_PANEL}` : `Saved to ${bank}`, undoable: true };
    case 'restored':
      return {
        text: note ? `Restored - ${NOTE_IN_PANEL}` : `Restored in ${bank}`,
        undoable: true,
      };
    default:
      // A duplicate may only have gained a bank membership; undo would delete the older highlight.
      return {
        text: note
          ? `Already saved - ${NOTE_IN_PANEL}`
          : result.addedToBank
            ? `Already saved - added to ${bank}`
            : `Already saved in ${bank}`,
        undoable: false,
      };
  }
}

export function ToolbarUnit({ selection }: { selection: SelectionInfo }) {
  const ui = useUi();
  const { host, store } = ui;
  const settings = useStore(store, (s) => s.settings);

  const [panel, setPanel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  // The full name of the button under the pointer or holding focus is shown in a caption row.
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const busyRef = useRef(false);
  const invokerRef = useRef<HTMLElement | null>(null);
  const unitRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const placement = useFloating(unitRef, selection.rect, panel);

  const save = useCallback(
    async (req: SaveRequest, note = false): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      // A pointer press never focuses an overlay button, so focus inside means keyboard or AT. The
      // More options panel holds focus for pointer users too: they only get Undo for longer.
      const viaKeyboard = ui.focusedInside() !== null;
      const errorsBefore = store.get().errorSeq;
      // The selection this save is for. The user may select something else while it is in flight.
      const savedText = store.get().toolbar?.selection.text;
      try {
        const result = await host.save(req);
        const id = result.highlight.id;
        // The id exists only now, after the round trip. chrome.sidePanel.open still has the click's
        // transient user activation (about 5 s; measured: allowed after 3 s, refused after 6 s).
        const noted = note && (await openSidePanel(ui, id));
        const { text, undoable } = savedNotice(result, noted);
        pushToast(store, {
          text,
          tone: 'success',
          ttl: undoable && viaKeyboard ? KEYBOARD_UNDO_MS : undefined,
          action: undoable
            ? {
                label: 'Undo',
                run: () => {
                  host.undo(id).then(
                    () => pushToast(store, { text: 'Save undone', tone: 'info' }),
                    (err: unknown) =>
                      pushToast(store, {
                        text: errorMessage(err, 'Could not undo the save.'),
                        tone: 'error',
                      }),
                  );
                },
              }
            : undefined,
        });
        // Same selection (text), not same object: scrolling re-places the toolbar with a new rect.
        // A newer selection owns the toolbar now and must not be dismissed with this one.
        if (store.get().toolbar?.selection.text === savedText) {
          host.dismissSelection();
          ui.closeToolbar();
        }
        return true;
      } catch (err) {
        // The host usually reports (and offers Retry for) its own failures; do not double up.
        if (store.get().errorSeq === errorsBefore) {
          pushToast(store, {
            text: errorMessage(err, 'Could not save the selection. Try again.'),
            tone: 'error',
          });
        }
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [host, store, ui],
  );

  /** `note`: after the save, open the side panel on the new highlight (the note is typed there). */
  const quick = (kind: HighlightKind | null, note = false): void => {
    const current = host.settings();
    const k = kind ?? current.defaultKind;
    void save(
      {
        kind: k,
        color: current.palette[k],
        bankId: null,
        comment: '',
        priority: DEFAULT_PRIORITY,
      },
      note,
    );
  };

  const togglePanel = (): void => {
    if (panel) return closePanel();
    ui.rememberFocus();
    invokerRef.current = ui.focusedInside();
    setPanel(true);
  };

  function closePanel(): void {
    const invoker = invokerRef.current;
    invokerRef.current = null;
    setPanel(false);
    // Keyboard users go back to the button that opened the panel; pointer users to the page.
    if (invoker?.isConnected) invoker.focus({ preventScroll: true });
    else ui.restoreFocus();
  }

  const actions: ToolbarAction[] = [
    {
      key: 'save',
      name: 'Save selection',
      content: 'Save',
      onActivate: () => quick(null),
    },
    ...HIGHLIGHT_KINDS.map((kind, i): ToolbarAction => ({
      key: kind,
      name: `Save as ${KIND_LABELS[kind].label}`,
      content: KIND_LABELS[kind].glyph,
      swatch: COLOR_SWATCH[settings.palette[kind]].solid,
      groupStart: i === 0,
      onActivate: () => quick(kind),
    })),
    {
      key: 'note',
      name: 'Save and add a note in the side panel',
      content: 'Note',
      groupStart: true,
      onActivate: () => quick(null, true),
    },
    {
      key: 'more',
      name: 'More options',
      content: 'More',
      expanded: panel,
      onActivate: togglePanel,
    },
  ];

  const onBarKeyDown = (e: KeyboardEvent): void => {
    const buttons = Array.from(barRef.current?.querySelectorAll('button') ?? []);
    const i = buttons.findIndex((b) => b === (e.target as Element).closest('button'));
    if (i === -1) return;
    const last = buttons.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % buttons.length
        : e.key === 'ArrowLeft'
          ? (i + last) % buttons.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : -1;
    if (next === -1) return;
    e.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  };

  const shown = hovered ?? focused;
  const caption = shown === null ? null : (actions[shown]?.name ?? null);

  return (
    <div
      ref={unitRef}
      className="sv-float sv-unit"
      data-placement={placement?.placement}
      style={floatingStyle(placement)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        e.preventDefault();
        ui.dismissToolbar();
      }}
    >
      <div className="sv-bar-group">
        <div
          ref={barRef}
          className="sv-toolbar"
          role="toolbar"
          aria-label="StudyVault: save selected text"
          aria-busy={busy}
          onKeyDown={onBarKeyDown}
        >
          {actions.map((a, i) => (
            <span
              key={a.key}
              className={a.groupStart ? 'sv-toolbar-item sv-group-start' : 'sv-toolbar-item'}
            >
              <button
                type="button"
                className={a.swatch ? 'sv-btn sv-tool sv-kind' : 'sv-btn sv-tool'}
                tabIndex={i === active ? 0 : -1}
                aria-label={a.name}
                title={a.name}
                aria-disabled={busy}
                aria-expanded={a.expanded}
                aria-haspopup={a.expanded === undefined ? undefined : 'dialog'}
                data-kind={a.swatch ? a.key : undefined}
                onFocus={() => {
                  setActive(i);
                  setFocused(i);
                }}
                onBlur={() => setFocused(null)}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => {
                  if (!busyRef.current) a.onActivate();
                }}
              >
                <span aria-hidden="true">{a.content}</span>
                {a.swatch ? (
                  <span className="sv-swatch" aria-hidden="true" style={{ background: a.swatch }} />
                ) : null}
              </button>
            </span>
          ))}
        </div>
        {/* Always laid out (hidden when empty), so showing a name never resizes the unit. The
            accessible name is on the button itself, hence aria-hidden. */}
        <div
          className="sv-caption"
          aria-hidden="true"
          data-empty={caption === null ? '' : undefined}
        >
          {caption ?? '\u00a0'}
        </div>
      </div>

      {panel ? (
        <Composer quote={selection.text} busy={busy} onSave={save} onCancel={closePanel} />
      ) : null}
    </div>
  );
}
