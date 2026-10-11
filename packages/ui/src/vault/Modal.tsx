import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';

/**
 * Modal dialog on the native <dialog>: focus is trapped, the page behind is inert, Escape cancels
 * and focus returns to the control that opened it. The first element with `data-autofocus` (else the
 * first field) takes focus. `onSubmit` makes the body a form so Enter submits.
 */
export function Modal({
  title,
  onClose,
  onSubmit,
  children,
  wide = false,
  testId,
}: {
  title: string;
  onClose(): void;
  onSubmit?(): void;
  children: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    (
      el.querySelector<HTMLElement>('[data-autofocus]') ??
      el.querySelector<HTMLElement>('input, select, textarea, button')
    )?.focus();
    return () => {
      if (typeof el.close === 'function' && el.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const body = (
    <div className="sv-dialog__body sv-stack">
      <h2 id={titleId}>{title}</h2>
      {children}
    </div>
  );

  return (
    <dialog
      ref={dialog}
      className={`sv-dialog${wide ? ' sv-dialog--wide' : ''}`}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault(); // the owner unmounts us; closing here would desync its state
        onClose();
      }}
    >
      {onSubmit ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {body}
        </form>
      ) : (
        body
      )}
    </dialog>
  );
}
