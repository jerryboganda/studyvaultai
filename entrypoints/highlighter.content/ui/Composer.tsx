import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_BANK_NAME_CHARS,
  MAX_COMMENT_CHARS,
  type BankLite,
  type HighlightKind,
} from '@shared';
import type { SaveRequest } from '../contract';
import { errorMessage, truncate, useUi } from './context';

const DEFAULT_PRIORITY = 3;
const QUOTE_PREVIEW_CHARS = 240;

type BankState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; banks: BankLite[] };

interface ComposerProps {
  /** note: comment only (default kind, last-used bank). advanced: bank, kind, priority and comment. */
  mode: 'note' | 'advanced';
  quote: string;
  busy: boolean;
  /** Resolves true when the save succeeded (the toolbar then closes itself). */
  onSave(req: SaveRequest): Promise<boolean>;
  onCancel(): void;
}

function pickBank(
  banks: BankLite[],
  lastBankId: string | null,
  current: string | null,
): string | null {
  const keep = (id: string | null): string | null =>
    id !== null && banks.some((b) => b.id === id) ? id : null;
  return (
    keep(current) ?? keep(lastBankId) ?? banks.find((b) => b.isInbox)?.id ?? banks[0]?.id ?? null
  );
}

export function Composer({ mode, quote, busy, onSave, onCancel }: ComposerProps) {
  const { host, store } = useUi();
  const uid = useId();
  const advanced = mode === 'advanced';
  const defaultKind = store.get().settings.defaultKind;

  const [comment, setComment] = useState('');
  const [kind, setKind] = useState<HighlightKind>(defaultKind);
  const [priority, setPriority] = useState(DEFAULT_PRIORITY);
  const [bankId, setBankId] = useState<string | null>(null);
  const [bankState, setBankState] = useState<BankState>({ status: 'loading' });

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newError, setNewError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const commentRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const bankSelectRef = useRef<HTMLSelectElement>(null);
  const alive = useRef(true);

  const fetchBanks = useCallback(() => {
    host.listBanks().then(
      (res) => {
        if (!alive.current) return;
        setBankState({ status: 'ready', banks: res.banks });
        setBankId((current) => pickBank(res.banks, res.lastBankId, current));
      },
      (err: unknown) => {
        if (!alive.current) return;
        setBankState({ status: 'error', message: errorMessage(err, 'Could not load your banks.') });
      },
    );
  }, [host]);

  useEffect(() => {
    alive.current = true;
    if (advanced) fetchBanks();
    return () => {
      alive.current = false;
    };
  }, [advanced, fetchBanks]);

  const retryBanks = (): void => {
    setBankState({ status: 'loading' });
    fetchBanks();
  };

  // Opening the composer is a deliberate act: focus moves to the comment field.
  useEffect(() => {
    commentRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (creating) nameRef.current?.focus({ preventScroll: true });
  }, [creating]);

  const submit = (): void => {
    if (busy || createBusy) return;
    const { palette } = host.settings();
    void onSave({
      kind,
      color: palette[kind],
      bankId: advanced ? bankId : null,
      comment: comment.trim(),
      priority,
    });
  };

  const createBank = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (bankState.status !== 'ready' || createBusy) return;
    const name = newName.trim();
    if (!name) return setNewError('Enter a name for the bank.');
    if (name.length > MAX_BANK_NAME_CHARS) {
      return setNewError(`Use ${MAX_BANK_NAME_CHARS} characters or fewer.`);
    }
    if (bankState.banks.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
      return setNewError(`A bank named "${name}" already exists. Pick it from the list.`);
    }
    setNewError(null);
    setCreateBusy(true);
    try {
      const bank = await host.createBank(name);
      if (!alive.current) return;
      setBankState((prev) =>
        prev.status === 'ready' ? { status: 'ready', banks: [...prev.banks, bank] } : prev,
      );
      setBankId(bank.id);
      setCreating(false);
      setNewName('');
      bankSelectRef.current?.focus({ preventScroll: true });
    } catch (err) {
      if (alive.current) setNewError(errorMessage(err, 'Could not create the bank. Try again.'));
    } finally {
      if (alive.current) setCreateBusy(false);
    }
  };

  const ids = {
    bank: `${uid}-bank`,
    kind: `${uid}-kind`,
    priority: `${uid}-priority`,
    comment: `${uid}-comment`,
    name: `${uid}-name`,
    nameError: `${uid}-name-error`,
  };

  return (
    <div
      className="sv-panel"
      role="dialog"
      aria-label={advanced ? 'Save with details' : 'Add a note'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="sv-quote" aria-label="Selected text">
        {truncate(quote, QUOTE_PREVIEW_CHARS)}
      </p>

      {advanced ? (
        <div className="sv-field">
          <label htmlFor={ids.bank}>Bank</label>
          {bankState.status === 'loading' ? (
            <p className="sv-muted" role="status">
              Loading banks…
            </p>
          ) : bankState.status === 'error' ? (
            <div role="alert" className="sv-inline-error">
              <span>{bankState.message} Saving uses your last-used bank.</span>
              <button type="button" className="sv-btn sv-btn-text" onClick={retryBanks}>
                Retry
              </button>
            </div>
          ) : (
            <div className="sv-row">
              <select
                id={ids.bank}
                ref={bankSelectRef}
                className="sv-control"
                value={bankId ?? ''}
                disabled={bankState.banks.length === 0}
                onChange={(e) => setBankId(e.target.value)}
              >
                {bankState.banks.length === 0 ? (
                  <option value="">Inbox (default)</option>
                ) : (
                  bankState.banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.isInbox ? `${b.name} (default)` : b.name}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                className="sv-btn sv-btn-text"
                aria-expanded={creating}
                onClick={() => setCreating((v) => !v)}
              >
                New bank
              </button>
            </div>
          )}
          {creating && bankState.status === 'ready' ? (
            <form className="sv-new-bank" onSubmit={(e) => void createBank(e)} noValidate>
              <label htmlFor={ids.name}>Bank name</label>
              <div className="sv-row">
                <input
                  id={ids.name}
                  ref={nameRef}
                  className="sv-control"
                  type="text"
                  value={newName}
                  maxLength={MAX_BANK_NAME_CHARS}
                  aria-invalid={newError !== null}
                  aria-describedby={newError ? ids.nameError : undefined}
                  onChange={(e) => {
                    setNewName(e.target.value);
                    setNewError(null);
                  }}
                />
                <button type="submit" className="sv-btn sv-btn-primary" disabled={createBusy}>
                  {createBusy ? 'Creating…' : 'Create'}
                </button>
              </div>
              {newError ? (
                <p id={ids.nameError} className="sv-inline-error" role="alert">
                  {newError}
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}

      {advanced ? (
        <div className="sv-row sv-row-split">
          <div className="sv-field">
            <label htmlFor={ids.kind}>Type</label>
            <select
              id={ids.kind}
              className="sv-control"
              value={kind}
              onChange={(e) => setKind(e.target.value as HighlightKind)}
            >
              {HIGHLIGHT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {`${KIND_LABELS[k].glyph} ${KIND_LABELS[k].label}`}
                </option>
              ))}
            </select>
          </div>
          <div className="sv-field">
            <label htmlFor={ids.priority}>Priority</label>
            <select
              id={ids.priority}
              className="sv-control"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            >
              <option value={1}>1 (lowest)</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5 (highest)</option>
            </select>
          </div>
        </div>
      ) : null}

      <div className="sv-field">
        <label htmlFor={ids.comment}>Note</label>
        <textarea
          id={ids.comment}
          ref={commentRef}
          className="sv-control sv-textarea"
          rows={3}
          value={comment}
          maxLength={MAX_COMMENT_CHARS}
          placeholder="Your own words (optional)"
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>

      <div className="sv-actions">
        <button
          type="button"
          className="sv-btn sv-btn-primary"
          aria-disabled={busy}
          onClick={submit}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="sv-btn sv-btn-text" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
