import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { HIGHLIGHT_KINDS, KIND_LABELS, type BankLite, type HighlightKind } from '@shared';
import type { SaveRequest } from '../contract';
import { errorMessage, openSidePanel, truncate, useUi } from './context';

const DEFAULT_PRIORITY = 3;
const QUOTE_PREVIEW_CHARS = 240;

type BankState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; banks: BankLite[] };

interface ComposerProps {
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

/**
 * "More options": bank, type and priority. Only pickers: free text (a note, a bank name) is typed
 * in the side panel, because keystrokes typed inside the page document are visible to page scripts.
 */
export function Composer({ quote, busy, onSave, onCancel }: ComposerProps) {
  const ui = useUi();
  const { host, store } = ui;
  const uid = useId();

  const [kind, setKind] = useState<HighlightKind>(store.get().settings.defaultKind);
  const [priority, setPriority] = useState(DEFAULT_PRIORITY);
  const [bankId, setBankId] = useState<string | null>(null);
  const [bankState, setBankState] = useState<BankState>({ status: 'loading' });

  const panelRef = useRef<HTMLDivElement>(null);
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
        // A refresh that fails keeps the list the user already has.
        setBankState((prev) =>
          prev.status === 'ready'
            ? prev
            : { status: 'error', message: errorMessage(err, 'Could not load your banks.') },
        );
      },
    );
  }, [host]);

  useEffect(() => {
    alive.current = true;
    fetchBanks();
    // A bank created in the side panel appears when the user comes back to the page.
    const win = panelRef.current?.ownerDocument.defaultView;
    win?.addEventListener('focus', fetchBanks);
    return () => {
      alive.current = false;
      win?.removeEventListener('focus', fetchBanks);
    };
  }, [fetchBanks]);

  // Opening the panel is a deliberate act: focus moves into it, so Tab and Escape work from here.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const retryBanks = (): void => {
    setBankState({ status: 'loading' });
    fetchBanks();
  };

  const submit = (): void => {
    if (busy) return;
    const { palette } = host.settings();
    void onSave({
      kind,
      color: palette[kind],
      bankId,
      comment: '',
      priority,
    });
  };

  const ids = {
    bank: `${uid}-bank`,
    bankHint: `${uid}-bank-hint`,
    kind: `${uid}-kind`,
    priority: `${uid}-priority`,
  };

  return (
    <div
      ref={panelRef}
      className="sv-panel"
      role="dialog"
      aria-label="Save with details"
      tabIndex={-1}
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

      <div className="sv-field sv-area-bank">
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
          <>
            <div className="sv-row">
              <select
                id={ids.bank}
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
                aria-describedby={ids.bankHint}
                onClick={() => void openSidePanel(ui, null)}
              >
                New bank...
              </button>
            </div>
            <p id={ids.bankHint} className="sv-muted">
              A new bank is named in the side panel.
            </p>
          </>
        )}
      </div>

      <div className="sv-row sv-row-split sv-area-kind">
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
