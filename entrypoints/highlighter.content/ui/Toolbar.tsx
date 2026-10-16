import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { HIGHLIGHT_KINDS, KIND_LABELS, type CaptureResult, type HighlightKind } from '@shared';
import type { SaveRequest, SelectionInfo } from '../contract';
import { pushSaved } from '../filingNotice';
import { BankDot, BankMenu } from './BankMenu';
import { pickBank, useBanks } from './banks';
import { KindDot } from './Choice';
import { Composer } from './Composer';
import { errorMessage, openSidePanel, rove, useUi } from './context';
import { Icon, LogoMark } from './icons';
import { pushToast, useStore } from './store';
import { floatingStyle, useFloating } from './useFloating';

const DEFAULT_PRIORITY = 3;
/** Undo stays longer after a keyboard save: the user first has to press the Focus toolbar shortcut. */
const KEYBOARD_UNDO_MS = 15000;
const NOTE_IN_PANEL = 'write your note in the side panel';
/** The roving tab stop starts on Save: the one-click default (the kind dots come before it). */
const SAVE_INDEX = HIGHLIGHT_KINDS.length;

interface ToolbarAction {
  key: string;
  /** Accessible name. Includes the visible text (WCAG 2.5.3). */
  name: string;
  content: ReactNode;
  cls: string;
  popup?: 'dialog' | 'menu';
  expanded?: boolean;
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

/**
 * The in-page toolbar (UX_DESIGN 7.6): logo | seven kind dots | Save | Note | bank chip | More.
 * The chip and More open one popup each (the bank menu, the "Save with details" panel); both share
 * the bank list and the bank the user picked, which every save from this toolbar then uses.
 */
export function ToolbarUnit({ selection }: { selection: SelectionInfo }) {
  const ui = useUi();
  const { host, store } = ui;
  const settings = useStore(store, (s) => s.settings);

  const [popup, setPopup] = useState<'menu' | 'panel' | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<number>(SAVE_INDEX);
  // The full name of the button under the pointer or holding focus is shown in a caption row.
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  /** A bank the user picked here; null = the worker's default (last-used bank, else the Inbox). */
  const [chosen, setChosen] = useState<string | null>(null);
  const busyRef = useRef(false);
  const invokerRef = useRef<HTMLElement | null>(null);
  const unitRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const placement = useFloating(unitRef, selection.rect, popup);
  const banks = useBanks(host, unitRef);
  const bankId =
    banks.state.status === 'ready'
      ? pickBank(banks.state.banks, banks.state.lastBankId, chosen)
      : null;
  const bank =
    banks.state.status === 'ready' ? banks.state.banks.find((b) => b.id === bankId) : undefined;

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
        pushSaved(
          result,
          {
            text,
            tone: 'success',
            ttl: undoable && viaKeyboard ? KEYBOARD_UNDO_MS : undefined,
            ...(result.xp ? { xp: result.xp } : {}),
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
          },
          host,
          (notice) => pushToast(store, notice),
        );
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
        // A pick that has since disappeared from the list (deleted elsewhere) falls back to the default.
        bankId: chosen === bankId ? chosen : null,
        comment: '',
        priority: DEFAULT_PRIORITY,
      },
      note,
    );
  };

  const toggle = (which: 'menu' | 'panel'): void => {
    if (popup === which) return closePopup();
    // Switching from one popup to the other keeps the first opener.
    if (popup === null) {
      ui.rememberFocus();
      invokerRef.current = ui.focusedInside();
    }
    setPopup(which);
  };

  function closePopup(): void {
    const invoker = invokerRef.current;
    invokerRef.current = null;
    setPopup(null);
    // Keyboard users go back to the button that opened the popup; pointer users to the page.
    if (invoker?.isConnected) invoker.focus({ preventScroll: true });
    else ui.restoreFocus();
  }

  const bankName = bank ? `Bank: ${bank.name}` : 'Bank';
  const actions: ToolbarAction[] = [
    ...HIGHLIGHT_KINDS.map((kind): ToolbarAction => ({
      key: kind,
      name: `Save as ${KIND_LABELS[kind].label}`,
      content: <KindDot kind={kind} color={settings.palette[kind]} />,
      cls: 'sv-kind',
      onActivate: () => quick(kind),
    })),
    {
      key: 'save',
      name: 'Save selection',
      content: (
        <>
          <Icon name="bookmark" />
          Save
        </>
      ),
      cls: 'sv-save',
      onActivate: () => quick(null),
    },
    {
      key: 'note',
      name: 'Save and add a note in the side panel',
      content: <Icon name="note" />,
      cls: 'sv-icon-tool',
      onActivate: () => quick(null, true),
    },
    {
      key: 'bank',
      name: bankName,
      content: (
        <>
          {bank ? <BankDot bank={bank} /> : null}
          <span className="sv-bank-name">{bank ? bank.name : 'Bank'}</span>
          <Icon name="chevron" size={16} />
        </>
      ),
      cls: 'sv-bank',
      popup: 'menu',
      expanded: popup === 'menu',
      onActivate: () => toggle('menu'),
    },
    {
      key: 'more',
      name: 'More options',
      content: <Icon name="more" />,
      cls: 'sv-icon-tool',
      popup: 'dialog',
      expanded: popup === 'panel',
      onActivate: () => toggle('panel'),
    },
  ];

  const onBarKeyDown = (e: KeyboardEvent): void => {
    const buttons = Array.from(barRef.current?.querySelectorAll('button') ?? []);
    const i = buttons.findIndex((b) => b === (e.target as Element).closest('button'));
    if (i === -1) return;
    // The bank chip is a menu button: Down / Up open its menu.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && actions[i]?.popup === 'menu') {
      e.preventDefault();
      if (popup !== 'menu' && !busyRef.current) toggle('menu');
      return;
    }
    const next = rove(e.key, i, buttons.length, ['ArrowLeft'], ['ArrowRight']);
    if (next === -1) return;
    e.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  };

  const shown = hovered ?? focused;
  const caption = shown === null ? null : (actions[shown]?.name ?? null);

  // The caption sits over the button it names (kept within the bar), not over the bar's middle,
  // where it read as the name of whatever button happened to be there.
  useLayoutEffect(() => {
    const cap = captionRef.current;
    const bar = barRef.current;
    const button = shown === null ? undefined : bar?.querySelectorAll('button')[shown];
    if (!cap || !bar || !button) return;
    const left = button.offsetLeft + button.offsetWidth / 2 - cap.offsetWidth / 2;
    cap.style.marginLeft = `${Math.round(Math.max(0, Math.min(left, bar.offsetWidth - cap.offsetWidth)))}px`;
  }, [shown, caption, bankName]);

  // The arrow points at the middle of the selection (placement.x is the unit's left edge).
  const arrowX = placement ? selection.rect.left + selection.rect.width / 2 - placement.x : 0;

  return (
    <div
      ref={unitRef}
      className="sv-float sv-unit"
      data-placement={placement?.placement}
      data-popup={popup ?? undefined}
      style={
        {
          ...floatingStyle(placement),
          '--sv-arrow-x': `${Math.round(arrowX)}px`,
        } as CSSProperties
      }
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
          <LogoMark />
          {actions.map((a, i) => (
            <span key={a.key} className="sv-toolbar-item">
              {i === SAVE_INDEX ? <span className="sv-sep" aria-hidden="true" /> : null}
              <button
                type="button"
                className={`sv-btn sv-tool ${a.cls}`}
                tabIndex={i === active ? 0 : -1}
                aria-label={a.name}
                title={a.name}
                aria-disabled={busy}
                aria-expanded={a.expanded}
                aria-haspopup={a.popup}
                data-kind={a.cls === 'sv-kind' ? a.key : undefined}
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
                {a.content}
              </button>
            </span>
          ))}
        </div>
        {/* Always laid out (hidden when empty), so showing a name never resizes the unit. The
            accessible name is on the button itself, hence aria-hidden. */}
        <div
          ref={captionRef}
          className="sv-caption"
          aria-hidden="true"
          data-empty={caption === null ? '' : undefined}
        >
          {caption ?? ' '}
        </div>
      </div>

      {popup === 'menu' ? (
        <BankMenu
          state={banks.state}
          current={bankId}
          onPick={(id) => {
            setChosen(id);
            closePopup();
          }}
          onRetry={banks.retry}
          onNewBank={() => {
            void openSidePanel(ui, null);
            closePopup();
          }}
          onClose={closePopup}
        />
      ) : null}
      {popup === 'panel' ? (
        <Composer
          quote={selection.text}
          busy={busy}
          banks={banks.state}
          bankId={bankId}
          onBank={setChosen}
          onRetryBanks={banks.retry}
          onSave={save}
          onCancel={closePopup}
        />
      ) : null}
    </div>
  );
}
