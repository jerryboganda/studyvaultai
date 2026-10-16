import { useEffect, useState, type KeyboardEvent } from 'react';
import { useUi } from './context';
import { Icon, type IconName } from './icons';
import { dismissToast, useStore, type Toast } from './store';

const UNDO_MS = 6000;
const ERROR_MS = 10000;
const NOTICE_MS = 4000;
/** Tone is never colour alone: each has its own icon. */
const TONE_ICON: Record<Toast['tone'], IconName> = {
  info: 'info',
  success: 'check',
  error: 'alert',
};
const ACTION_ICON: Record<string, IconName> = { Undo: 'undo', Retry: 'retry', File: 'check' };

function ToastCard({ toast }: { toast: Toast }) {
  const ui = useUi();
  // Pointer and keyboard focus stop the timer independently (WCAG 2.2.1): the pointer leaving must
  // not restart it while focus is still on the Undo button.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const ttl = toast.ttl ?? (toast.action ? UNDO_MS : toast.tone === 'error' ? ERROR_MS : NOTICE_MS);

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

  const actionIcon = toast.action ? ACTION_ICON[toast.action.label] : undefined;
  return (
    <div
      className={`sv-toast sv-toast-${toast.tone}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // Focus moving between the buttons of this toast is not leaving it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={onKeyDown}
    >
      <span className="sv-toast-icon" aria-hidden="true">
        <Icon name={TONE_ICON[toast.tone]} size={20} />
      </span>
      <span className="sv-toast-body">
        <span className="sv-toast-text">{toast.text}</span>
        {toast.action ? (
          // How a keyboard user reaches the action: spoken with the toast, not shown (one line).
          // The key is the user's (Chrome > Extensions > Keyboard shortcuts), so it is not named.
          <span className="sv-sr">{`${toast.action.label}: use the Focus toolbar shortcut`}</span>
        ) : null}
      </span>
      {/* One group, so on a narrow screen the buttons wrap together under the text (the dismiss
          button never strands on a row of its own). */}
      <span className="sv-toast-actions">
        {toast.xp ? (
          <span className="sv-xp">
            <Icon name="zap" size={14} fill />
            {`+${toast.xp} XP`}
          </span>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            className="sv-btn sv-chip-btn"
            data-sv-toast-action={toast.id}
            onClick={() => {
              toast.action?.run();
              close();
            }}
          >
            {actionIcon ? <Icon name={actionIcon} size={16} /> : null}
            {toast.action.label}
          </button>
        ) : null}
        {toast.secondary ? (
          <button
            type="button"
            className="sv-btn sv-chip-btn sv-chip-quiet"
            onClick={() => {
              toast.secondary?.run();
              close();
            }}
          >
            {toast.secondary.label}
          </button>
        ) : null}
        <button
          type="button"
          className="sv-btn sv-icon-btn"
          aria-label="Dismiss notification"
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </span>
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

/**
 * A third, silent live region for messages that have no visible counterpart (CaptureUi.announce).
 * Plain aria-live rather than role="status": the toast status region stays the only one. Each
 * message is a new node, which is what makes identical text announce again.
 */
export function Announcer() {
  const ui = useUi();
  const message = useStore(ui.store, (s) => s.announcement);
  return (
    <div className="sv-sr" aria-live="polite" aria-atomic="true" data-sv-announcer>
      {message ? <span key={message.id}>{message.text}</span> : null}
    </div>
  );
}
