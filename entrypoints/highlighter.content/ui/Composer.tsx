import { useId, useLayoutEffect, useRef, useState } from 'react';
import { COLOR_SWATCH, type HighlightKind } from '@shared';
import type { SaveRequest } from '../contract';
import type { BankState } from './banks';
import { KindChoice, PriorityChoice } from './Choice';
import { openSidePanel, truncate, useUi } from './context';
import { Icon } from './icons';
import { useStore } from './store';

const DEFAULT_PRIORITY = 3;
const QUOTE_PREVIEW_CHARS = 240;
const NEW_BANK_HINT = 'A new bank is named in the side panel.';

interface ComposerProps {
  quote: string;
  busy: boolean;
  /** The toolbar's bank list and the bank it saves into (shared with the bank chip). */
  banks: BankState;
  bankId: string | null;
  onBank(bankId: string): void;
  onRetryBanks(): void;
  /** Resolves true when the save succeeded (the toolbar then closes itself). */
  onSave(req: SaveRequest): Promise<boolean>;
  onCancel(): void;
}

/**
 * "Save with details": bank, kind and priority on one compact card. Only pickers: free text (a note,
 * a bank name) is typed in the side panel, because keystrokes typed inside the page document are
 * visible to page scripts.
 */
export function Composer({
  quote,
  busy,
  banks,
  bankId,
  onBank,
  onRetryBanks,
  onSave,
  onCancel,
}: ComposerProps) {
  const ui = useUi();
  const { host, store } = ui;
  const uid = useId();
  const palette = useStore(store, (s) => s.settings.palette);

  const [kind, setKind] = useState<HighlightKind>(store.get().settings.defaultKind);
  const [priority, setPriority] = useState(DEFAULT_PRIORITY);
  const panelRef = useRef<HTMLDivElement>(null);

  // Opening the panel is a deliberate act: focus moves into it, so Tab and Escape work from here.
  // A layout effect: Preact would run a passive one a frame later, and a key pressed right after the
  // click would go to the page (docs/adr/012).
  useLayoutEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const submit = (): void => {
    if (busy) return;
    void onSave({
      kind,
      color: host.settings().palette[kind],
      bankId,
      comment: '',
      priority,
    });
  };

  const ids = { bank: `${uid}-bank`, bankHint: `${uid}-bank-hint` };

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
      <p
        className="sv-quote"
        aria-label="Selected text"
        style={{ borderLeftColor: COLOR_SWATCH[palette[kind]].solid }}
      >
        {truncate(quote, QUOTE_PREVIEW_CHARS)}
      </p>

      <div className="sv-field sv-area-bank">
        <label htmlFor={ids.bank}>Bank</label>
        {banks.status === 'loading' ? (
          <p className="sv-muted" role="status">
            Loading banks…
          </p>
        ) : banks.status === 'error' ? (
          <div role="alert" className="sv-inline-error">
            <Icon name="alert" size={16} />
            <span>{banks.message} Saving uses your last-used bank.</span>
            <button type="button" className="sv-btn sv-btn-text" onClick={onRetryBanks}>
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
                disabled={banks.banks.length === 0}
                onChange={(e) => onBank(e.target.value)}
              >
                {banks.banks.length === 0 ? (
                  <option value="">Inbox (default)</option>
                ) : (
                  banks.banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.isInbox ? `${b.name} (default)` : b.name}
                    </option>
                  ))
                )}
              </select>
              {/* Icon-only, so the bank's full name fits in the picker beside it. */}
              <button
                type="button"
                className="sv-btn sv-btn-soft sv-square"
                aria-label="New bank..."
                aria-describedby={ids.bankHint}
                title={`New bank: ${NEW_BANK_HINT}`}
                onClick={() => void openSidePanel(ui, null)}
              >
                <Icon name="plus" />
              </button>
            </div>
            {/* Spoken with the button and part of its tooltip: the card stays short enough to fit
                above the selection. */}
            <p id={ids.bankHint} className="sv-sr">
              {NEW_BANK_HINT}
            </p>
          </>
        )}
      </div>

      <div className="sv-field sv-area-kind">
        <KindChoice value={kind} palette={palette} showValue onChange={setKind} />
        <PriorityChoice value={priority} onChange={setPriority} />
      </div>

      <div className="sv-actions">
        <button
          type="button"
          className="sv-btn sv-btn-primary"
          aria-disabled={busy}
          onClick={submit}
        >
          <Icon name="bookmark" />
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="sv-btn sv-btn-text" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
