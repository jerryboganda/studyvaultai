import { useEffect, useId, useRef, useState } from 'react';
import { Button, InlineNotice } from '@ui';

/**
 * Asks for a PDF's password. The value lives in this component's state until it is handed to pdf.js,
 * is never written to storage, logs or the address, and is cleared when the dialog closes.
 */
export function PasswordDialog({
  reason,
  fileLabel,
  onSubmit,
  onCancel,
}: {
  reason: 'needed' | 'incorrect';
  fileLabel: string;
  onSubmit(password: string): void;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    field.current?.focus();
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
        e.preventDefault();
        onCancel();
      }}
    >
      <form
        className="sv-dialog__body sv-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (value !== '') onSubmit(value);
        }}
      >
        <h2 id={titleId}>This PDF is password protected</h2>
        <p className="sv-muted sv-wrap">{fileLabel}</p>
        {reason === 'incorrect' ? (
          <InlineNotice tone="error" title="That password did not open the file">
            Check the password and try again.
          </InlineNotice>
        ) : null}
        <label className="sv-field" htmlFor={inputId}>
          <span className="sv-label">Password</span>
          <input
            ref={field}
            id={inputId}
            className="sv-control"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            data-testid="pdf-password"
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <p className="sv-small sv-muted">
          The password is used once to open this file on this device. StudyVault does not store it.
        </p>
        <div className="sv-row">
          <Button
            variant="primary"
            type="submit"
            disabledReason={value === '' ? 'Type the password first.' : undefined}
          >
            Open PDF
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </dialog>
  );
}
