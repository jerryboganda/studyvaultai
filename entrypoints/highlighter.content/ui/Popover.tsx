import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  COLOR_SWATCH,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  type HighlightKind,
  type HighlightPatch,
  type HighlightView,
} from '@shared';
import { errorMessage, openSidePanel, truncate, useUi } from './context';
import { pushToast } from './store';
import { floatingStyle, useFloating } from './useFloating';

const QUOTE_PREVIEW_CHARS = 400;
/** The note is read-only here; the side panel shows and edits all of it. */
const NOTE_PREVIEW_CHARS = 500;

type Status =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'error'; message: string };

/**
 * Non-modal dialog (WAI-ARIA APG): focus moves to the dialog when it opens and Escape closes it and
 * returns focus to the page element that had it. Nothing traps Tab: it walks the popover controls in
 * reading order and then leaves for the rest of the page, which the user can keep working in; the
 * popover closes on a press outside, Escape or its own buttons, not on focus loss.
 *
 * It has no text fields: page scripts can observe keystrokes typed inside the page document, so the
 * note is shown as text and edited in the side panel.
 */
export function HighlightPopover({
  highlight,
  anchor,
}: {
  highlight: HighlightView;
  anchor: DOMRect;
}) {
  const ui = useUi();
  const { host, store } = ui;
  const uid = useId();
  const id = highlight.id;

  const [view, setView] = useState(highlight);
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [deleting, setDeleting] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  /** Writes are serialised so a slow earlier response can never overwrite a newer one. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const placement = useFloating(dialogRef, anchor);
  const placed = placement !== null;

  const commit = useCallback(
    (patch: HighlightPatch): Promise<void> => {
      const run = async (): Promise<void> => {
        if (alive.current) setStatus({ state: 'saving' });
        try {
          const next = await host.update(id, patch);
          if (!alive.current) return;
          setView(next);
          setStatus({ state: 'saved' });
        } catch (err) {
          const message = errorMessage(err, 'Could not save the change.');
          if (!alive.current) pushToast(store, { text: message, tone: 'error' });
          else setStatus({ state: 'error', message });
        }
      };
      queue.current = queue.current.then(run);
      return queue.current;
    },
    [host, id, store],
  );

  useEffect(() => {
    alive.current = true;
    ui.rememberFocus();
    return () => {
      alive.current = false;
    };
  }, [ui]);

  // The dialog is visibility:hidden until useFloating has measured it, and a hidden element cannot
  // take focus: focusing at mount was a silent no-op in a real browser (jsdom does not check).
  useEffect(() => {
    if (placed) dialogRef.current?.focus({ preventScroll: true });
  }, [placed]);

  const onDelete = async (): Promise<void> => {
    if (deleting) return;
    setDeleting(true);
    try {
      await queue.current;
      await host.remove(id);
    } catch (err) {
      if (alive.current) {
        setDeleting(false);
        setStatus({
          state: 'error',
          message: errorMessage(err, 'Could not delete the highlight.'),
        });
      }
      return;
    }
    pushToast(store, {
      text: 'Highlight deleted',
      tone: 'success',
      action: {
        label: 'Undo',
        run: () => {
          host.restore(id).then(
            () => pushToast(store, { text: 'Highlight restored', tone: 'success' }),
            (err: unknown) =>
              pushToast(store, {
                text: errorMessage(err, 'Could not restore the highlight.'),
                tone: 'error',
              }),
          );
        },
      },
    });
    ui.closePopover(true);
  };

  // Called inside the click: sidePanel.open needs the user gesture. The note shown here would be
  // stale after an edit there, so the popover closes once the panel is open.
  const editNote = (): void => {
    void openSidePanel(ui, id).then((opened) => {
      if (opened && alive.current) ui.closePopover(true);
    });
  };

  const kindMeta = KIND_LABELS[view.kind];
  const swatch = COLOR_SWATCH[view.color].solid;

  return (
    <div
      ref={dialogRef}
      className="sv-float sv-popover"
      role="dialog"
      aria-label="Highlight details"
      tabIndex={-1}
      data-placement={placement?.placement}
      style={floatingStyle(placement)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        e.preventDefault();
        ui.closePopover(true);
      }}
    >
      <div className="sv-popover-head">
        <span className="sv-chip">
          <span className="sv-swatch-dot" aria-hidden="true" style={{ background: swatch }} />
          <span aria-hidden="true">{kindMeta.glyph}</span>
          <span>{kindMeta.label}</span>
        </span>
        <button
          type="button"
          className="sv-btn sv-icon-btn"
          aria-label="Close highlight details"
          onClick={() => ui.closePopover(true)}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <p className="sv-quote sv-quote-block">
        <span className="sv-sr">Saved quote: </span>
        {truncate(view.exactQuote, QUOTE_PREVIEW_CHARS)}
      </p>
      {view.headingContext ? <p className="sv-muted">{view.headingContext}</p> : null}

      <div className="sv-field">
        <span className="sv-label" id={`${uid}-note`}>
          Note
        </span>
        {view.userComment ? (
          <p className="sv-note-text" aria-labelledby={`${uid}-note`}>
            {truncate(view.userComment, NOTE_PREVIEW_CHARS)}
          </p>
        ) : (
          <p className="sv-muted">No note yet.</p>
        )}
        <button type="button" className="sv-btn sv-btn-text sv-btn-start" onClick={editNote}>
          Edit note in side panel
        </button>
      </div>

      <div className="sv-row sv-row-split">
        <div className="sv-field">
          <label htmlFor={`${uid}-kind`}>Type</label>
          <select
            id={`${uid}-kind`}
            className="sv-control"
            value={view.kind}
            onChange={(e) => {
              const kind = e.target.value as HighlightKind;
              void commit({ kind, color: host.settings().palette[kind] });
            }}
          >
            {HIGHLIGHT_KINDS.map((k) => (
              <option key={k} value={k}>
                {`${KIND_LABELS[k].glyph} ${KIND_LABELS[k].label}`}
              </option>
            ))}
          </select>
        </div>
        <div className="sv-field">
          <label htmlFor={`${uid}-priority`}>Priority</label>
          <select
            id={`${uid}-priority`}
            className="sv-control"
            value={view.priority}
            onChange={(e) => void commit({ priority: Number(e.target.value) })}
          >
            <option value={1}>1 (lowest)</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={5}>5 (highest)</option>
          </select>
        </div>
      </div>

      <div className="sv-status" role="status" aria-live="polite">
        {status.state === 'saving' ? 'Saving…' : null}
        {status.state === 'saved' ? 'Saved' : null}
        {status.state === 'error' ? (
          <span className="sv-inline-error">{`Could not save: ${status.message}`}</span>
        ) : null}
      </div>

      <div className="sv-actions">
        <button
          type="button"
          className="sv-btn sv-btn-danger"
          aria-disabled={deleting}
          onClick={() => void onDelete()}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
        <button type="button" className="sv-btn sv-btn-text" onClick={() => ui.closePopover(true)}>
          Close
        </button>
      </div>
    </div>
  );
}
