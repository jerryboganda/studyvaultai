import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';

/**
 * Modal confirmation on the native <dialog>: focus is trapped, the page behind is inert and Escape
 * cancels. Focus starts on the cancel button (the safe choice) and goes back to the control that
 * opened it. Mount it only while the question is open; the parent owns that state.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** The action destroys something: confirm is drawn as a danger button. */
  danger?: boolean;
  /** Runs synchronously from the click, so a user-gesture-only API may be called first in it. */
  onConfirm(): void;
  onCancel(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // jsdom (unit tests) predates showModal; the open attribute is the same visible state.
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (typeof el.close === 'function' && el.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="sv-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault(); // the parent unmounts us; closing here would desync its state
        onCancel();
      }}
    >
      <div className="sv-dialog__body sv-stack">
        <h2 id={titleId}>{title}</h2>
        <div className="sv-stack sv-stack--tight">{children}</div>
        <div className="sv-row">
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button data-autofocus="" onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
