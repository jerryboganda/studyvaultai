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
import { errorMessage, useUi } from './context';
import { pushToast, useStore } from './store';
import { floatingStyle, useFloating } from './useFloating';

const DEFAULT_PRIORITY = 3;

type PanelMode = 'note' | 'advanced';

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

function savedNotice(result: CaptureResult): { text: string; undoable: boolean } {
  const bank = result.bank.name;
  switch (result.status) {
    case 'created':
      return { text: `Saved to ${bank}`, undoable: true };
    case 'restored':
      return { text: `Restored in ${bank}`, undoable: true };
    default:
      // A duplicate may only have gained a bank membership; undo would delete the older highlight.
      return {
        text: result.addedToBank ? `Already saved - added to ${bank}` : `Already saved in ${bank}`,
        undoable: false,
      };
  }
}

export function ToolbarUnit({ selection }: { selection: SelectionInfo }) {
  const ui = useUi();
  const { host, store } = ui;
  const settings = useStore(store, (s) => s.settings);

  const [panel, setPanel] = useState<PanelMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const busyRef = useRef(false);
  const invokerRef = useRef<HTMLElement | null>(null);
  const unitRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const placement = useFloating(unitRef, selection.rect, panel);

  const save = useCallback(
    async (req: SaveRequest): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      const errorsBefore = store.get().errorSeq;
      try {
        const result = await host.save(req);
        const { text, undoable } = savedNotice(result);
        const id = result.highlight.id;
        pushToast(store, {
          text,
          tone: 'success',
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
        host.dismissSelection();
        ui.closeToolbar();
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

  const quick = (kind: HighlightKind | null): void => {
    const current = host.settings();
    const k = kind ?? current.defaultKind;
    void save({
      kind: k,
      color: current.palette[k],
      bankId: null,
      comment: '',
      priority: DEFAULT_PRIORITY,
    });
  };

  const togglePanel = (mode: PanelMode): void => {
    if (panel === mode) return closePanel();
    ui.rememberFocus();
    invokerRef.current = ui.focusedInside();
    setPanel(mode);
  };

  function closePanel(): void {
    const invoker = invokerRef.current;
    invokerRef.current = null;
    setPanel(null);
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
      name: 'Add a note',
      content: 'Note',
      expanded: panel === 'note',
      groupStart: true,
      onActivate: () => togglePanel('note'),
    },
    {
      key: 'more',
      name: 'More options',
      content: 'More',
      expanded: panel === 'advanced',
      onActivate: () => togglePanel('advanced'),
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
      <div
        ref={barRef}
        className="sv-toolbar"
        role="toolbar"
        aria-label="StudyVault: save selected text"
        aria-keyshortcuts="Alt+Shift+T"
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
              onFocus={() => setActive(i)}
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

      {panel ? (
        <Composer
          mode={panel}
          quote={selection.text}
          busy={busy}
          onSave={save}
          onCancel={closePanel}
        />
      ) : null}
    </div>
  );
}
