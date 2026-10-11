import { useId, useState, type ReactNode } from 'react';
import { MAX_BANK_NAME_CHARS, MAX_FOLDER_NAME_CHARS } from '@shared';
import { Button, InlineNotice, useAction } from '@ui';
import { Modal } from '@ui/vault';
import { flattenFolders, useTreeData } from './treeData';

/** Small modal forms used by the bank tree, the bulk bar and the preview. */

export const NAME_LIMITS = { bank: MAX_BANK_NAME_CHARS, folder: MAX_FOLDER_NAME_CHARS };

export function DialogError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <InlineNotice
      tone="error"
      title="That did not work"
      action={retry ? <Button onClick={retry}>Try again</Button> : undefined}
    >
      {message}
    </InlineNotice>
  );
}

/** A form dialog with Cancel / confirm and the action's busy and error state handled. */
export function FormDialog({
  title,
  confirmLabel,
  danger = false,
  disabledReason,
  onSubmit,
  onCancel,
  children,
  wide,
  testId,
}: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  disabledReason?: string;
  /** Resolve to close (the owner unmounts the dialog); reject to show the error and stay. */
  onSubmit(): Promise<void>;
  onCancel(): void;
  children: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  const act = useAction(onSubmit);
  return (
    <Modal
      title={title}
      onClose={onCancel}
      onSubmit={() => {
        // A submit button that is aria-disabled still submits its form: guard here.
        if (!disabledReason && !act.busy) void act.run();
      }}
      wide={wide}
      testId={testId}
    >
      <div className="sv-stack sv-stack--tight">{children}</div>
      {act.error ? (
        <DialogError message={act.error} retry={act.retryable ? act.retry : undefined} />
      ) : null}
      <div className="sv-row">
        <Button
          type="submit"
          variant={danger ? 'danger' : 'primary'}
          busy={act.busy}
          disabledReason={disabledReason}
          data-testid="dialog-confirm"
        >
          {confirmLabel}
        </Button>
        <Button onClick={onCancel} data-testid="dialog-cancel">
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

export function NameDialog({
  title,
  label,
  initial = '',
  confirmLabel,
  maxLength,
  hint,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  maxLength: number;
  hint?: string;
  onSubmit(name: string): Promise<void>;
  onCancel(): void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const name = value.trim();
  return (
    <FormDialog
      title={title}
      confirmLabel={confirmLabel}
      disabledReason={name === '' ? 'Enter a name first.' : undefined}
      onSubmit={() => onSubmit(name)}
      onCancel={onCancel}
      testId="name-dialog"
    >
      <div className="sv-field">
        <label className="sv-label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="sv-control"
          data-autofocus=""
          value={value}
          maxLength={maxLength}
          dir="auto"
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          data-testid="name-input"
        />
      </div>
      {hint ? <p className="sv-small sv-muted">{hint}</p> : null}
    </FormDialog>
  );
}

export function ExplainDialog({
  title,
  lines,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): Promise<void>;
  onCancel(): void;
  children?: ReactNode;
}) {
  return (
    <FormDialog
      title={title}
      confirmLabel={confirmLabel}
      danger={danger}
      onSubmit={onConfirm}
      onCancel={onCancel}
      testId="explain-dialog"
    >
      <p>This is what will happen:</p>
      <ul className="sv-stack sv-stack--tight" data-testid="explain-lines">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {children}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------------------------

export interface Place {
  bankId: string;
  /** null: the top level of the bank. */
  folderId: string | null;
}

/**
 * Bank + folder chooser (two selects, folders indented by depth). `excludeFolderIds` keeps a folder's
 * own subtree out of the list when choosing where to move it.
 */
export function PlacePicker({
  value,
  onChange,
  excludeFolderIds,
  excludeBankIds,
  bankLabel = 'Bank',
  folderLabel = 'Folder',
  allowFolders = true,
}: {
  value: Place;
  onChange(next: Place): void;
  excludeFolderIds?: ReadonlySet<string>;
  excludeBankIds?: ReadonlySet<string>;
  bankLabel?: string;
  folderLabel?: string;
  allowFolders?: boolean;
}) {
  const data = useTreeData();
  const bankId = useId();
  const folderId = useId();
  const banks = data.banks.filter((b) => !excludeBankIds?.has(b.id));
  const folders = flattenFolders(data.folders[value.bankId] ?? []).filter(
    (f) => !excludeFolderIds?.has(f.id),
  );
  return (
    <div className="sv-stack sv-stack--tight">
      <div className="sv-field">
        <label className="sv-label" htmlFor={bankId}>
          {bankLabel}
        </label>
        <select
          id={bankId}
          className="sv-control"
          value={value.bankId}
          data-testid="place-bank"
          onChange={(e) => onChange({ bankId: e.target.value, folderId: null })}
        >
          {banks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      {allowFolders ? (
        <div className="sv-field">
          <label className="sv-label" htmlFor={folderId}>
            {folderLabel}
          </label>
          <select
            id={folderId}
            className="sv-control"
            value={value.folderId ?? ''}
            data-testid="place-folder"
            onChange={(e) => onChange({ bankId: value.bankId, folderId: e.target.value || null })}
          >
            <option value="">Top level of the bank</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {`${'  '.repeat(f.depth - 1)}${f.name}`}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
