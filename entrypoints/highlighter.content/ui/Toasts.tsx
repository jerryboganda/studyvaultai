import { useEffect, useState, type KeyboardEvent } from 'react';
import { useUi } from './context';
import { dismissToast, useStore, type Toast } from './store';

const UNDO_MS = 6000;
const ERROR_MS = 10000;
const NOTICE_MS = 4000;
/** Tone is never colour alone. */
const TONE_ICON = { info: 'i', success: '✓', error: '!' } as const;

function ToastCard({ toast }: { toast: Toast }) {
  const ui = useUi();
  // Hovering or focusing a toast stops its timer (WCAG 2.2.1): there is always time to reach Undo.
  const [paused, setPaused] = useState(false);
  const ttl = toast.action ? UNDO_MS : toast.tone === 'error' ? ERROR_MS : NOTICE_MS;

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismissToast(ui.store, toast.id), ttl);
    return () => clearTimeout(timer);
  }, [paused, ttl, toast.id, ui.store]);

  const close = (): void => {
    ui.restoreFocus();
    dismissToast(ui.store, toast.id);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };

  return (
    <div
      className={`sv-toast sv-toast-${toast.tone}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      <span className="sv-toast-icon" aria-hidden="true">
        {TONE_ICON[toast.tone]}
      </span>
      <span className="sv-toast-text">{toast.text}</span>
      {toast.action ? (
        <button
          type="button"
          className="sv-btn sv-btn-link"
          data-sv-toast-action
          onClick={() => {
            toast.action?.run();
            close();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="sv-btn sv-icon-btn"
        aria-label="Dismiss notification"
        onClick={close}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

/** Both live regions exist from the start; screen readers only announce changes to regions already in the tree. */
export function Toasts() {
  const ui = useUi();
  const toasts = useStore(ui.store, (s) => s.toasts);
  return (
    <div className="sv-toasts">
      <div className="sv-toast-list" role="status" aria-live="polite">
        {toasts
          .filter((t) => t.tone !== 'error')
          .map((t) => (
            <ToastCard key={t.id} toast={t} />
          ))}
      </div>
      <div className="sv-toast-list" role="alert">
        {toasts
          .filter((t) => t.tone === 'error')
          .map((t) => (
            <ToastCard key={t.id} toast={t} />
          ))}
      </div>
    </div>
  );
}
