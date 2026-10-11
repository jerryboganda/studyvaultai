import { useId, useLayoutEffect, useState, type RefObject } from 'react';
import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_BANK_NAME_CHARS,
  MAX_COMMENT_CHARS,
  type BankLite,
  type HighlightKind,
} from '@shared';
import { Button, InlineNotice, errorMessage, truncate } from '@ui';
import { pageRange, placeBar, type BarPlacement, type PdfSelection } from './model';

export interface SaveDraft {
  kind: HighlightKind;
  bankId: string | null;
  comment: string;
}

/**
 * The reader's selection toolbar. It lives in the extension's own origin, so (unlike the in-page
 * overlay on websites, ADR-005) it may contain free-text fields: a note and a new bank name.
 * It is anchored under the selection, flips above when there is no room, and never covers it.
 */
export function SaveBar({
  selection,
  banks,
  defaultKind,
  defaultBankId,
  barRef,
  onSave,
  onCreateBank,
  onDismiss,
  onEngaged,
  blockedReason,
}: {
  selection: PdfSelection;
  banks: readonly BankLite[];
  defaultKind: HighlightKind;
  defaultBankId: string | null;
  barRef: RefObject<HTMLDivElement | null>;
  onSave(draft: SaveDraft): Promise<{ summary: string }>;
  onCreateBank(name: string): Promise<BankLite>;
  onDismiss(): void;
  /** Focus is inside the bar: keep the selection even if the browser clears its own. */
  onEngaged(engaged: boolean): void;
  /** Saving is not allowed right now (private window): shown, and Save is disabled with it. */
  blockedReason?: string;
}) {
  const uid = useId();
  const [kind, setKind] = useState<HighlightKind>(defaultKind);
  const [chosenBank, setBankId] = useState<string | null>(null);
  const bankId = chosenBank ?? defaultBankId ?? banks[0]?.id ?? '';
  const [comment, setComment] = useState('');
  const [newBank, setNewBank] = useState<string | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({
    busy: false,
    error: null,
    done: null,
  });
  const [place, setPlace] = useState<BarPlacement>({ left: 8, top: 8 });

  useLayoutEffect(() => {
    const el = barRef.current;
    const box = el?.getBoundingClientRect();
    setPlace(
      placeBar(
        selection.bounds,
        { w: box?.width ?? 340, h: box?.height ?? 260 },
        { w: window.innerWidth, h: window.innerHeight },
      ),
    );
  }, [selection.bounds, barRef, selection.parts.length, newBank]);

  const pages = [...new Set(selection.parts.map((p) => p.pageNumber))];
  const multi = selection.parts.length > 1;
  const quote = selection.parts.map((p) => p.quote).join(' … ');
  // The text of an OCR page is machine output; say so where the quote is about to become a record.
  const fromOcr = selection.parts.some((p) => p.part?.page?.text?.algorithm === 'sv-ocr-text-v1');

  const save = async (): Promise<void> => {
    setState({ busy: true, error: null, done: null });
    try {
      const { summary } = await onSave({ kind, bankId: bankId || null, comment: comment.trim() });
      setState({ busy: false, error: null, done: summary });
    } catch (err) {
      setState({
        busy: false,
        error: errorMessage(err, 'The highlight could not be saved.'),
        done: null,
      });
    }
  };

  const createBank = async (): Promise<void> => {
    const name = (newBank ?? '').trim();
    if (!name) return;
    setState({ busy: true, error: null, done: null });
    try {
      const bank = await onCreateBank(name);
      setBankId(bank.id);
      setNewBank(null);
      setState({ busy: false, error: null, done: null });
    } catch (err) {
      setState({
        busy: false,
        error: errorMessage(err, 'The bank could not be created.'),
        done: null,
      });
    }
  };

  return (
    <div
      ref={barRef}
      className="sv-savebar"
      role="dialog"
      aria-modal="false"
      aria-label={`Save selection from ${pageRange(pages)}`}
      data-testid="pdf-savebar"
      style={{ left: place.left, top: place.top }}
      onFocus={() => onEngaged(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onEngaged(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onDismiss();
        }
      }}
    >
      <blockquote className="sv-quote sv-savebar__quote" dir="auto">
        {truncate(quote, 200)}
      </blockquote>

      {fromOcr ? (
        <p className="sv-small" data-testid="pdf-save-ocr-note">
          This text was recognised from a scanned image (OCR) and may contain errors. Check the
          quote against the page before relying on it.
        </p>
      ) : null}

      {multi ? (
        <InlineNotice tone="warning" title="This selection spans more than one page">
          A highlight belongs to a single page, so StudyVault saves each page's part as its own
          highlight ({pageRange(pages)}). Nothing is lost; they stay separate entries.
        </InlineNotice>
      ) : null}

      <div className="sv-savebar__fields">
        <label className="sv-field" htmlFor={`${uid}-kind`}>
          <span className="sv-label">Kind</span>
          <select
            id={`${uid}-kind`}
            className="sv-control"
            value={kind}
            data-testid="pdf-save-kind"
            onChange={(e) => setKind(e.target.value as HighlightKind)}
          >
            {HIGHLIGHT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k].glyph} {KIND_LABELS[k].label}
              </option>
            ))}
          </select>
        </label>

        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-bank`}>
            Bank
          </label>
          <div className="sv-row">
            <select
              id={`${uid}-bank`}
              className="sv-control sv-grow"
              value={bankId}
              data-testid="pdf-save-bank"
              onChange={(e) => setBankId(e.target.value)}
            >
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <Button
              onClick={() => setNewBank(newBank === null ? '' : null)}
              aria-expanded={newBank !== null}
            >
              New bank
            </Button>
          </div>
        </div>

        {newBank !== null ? (
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${uid}-newbank`}>
              New bank name
            </label>
            <div className="sv-row">
              <input
                id={`${uid}-newbank`}
                className="sv-control sv-grow"
                maxLength={MAX_BANK_NAME_CHARS}
                value={newBank}
                autoFocus
                data-testid="pdf-new-bank-name"
                onChange={(e) => setNewBank(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void createBank();
                  }
                }}
              />
              <Button
                variant="primary"
                busy={state.busy}
                disabledReason={newBank.trim() === '' ? 'Type a name first.' : undefined}
                onClick={() => void createBank()}
              >
                Create
              </Button>
            </div>
          </div>
        ) : null}

        <label className="sv-field" htmlFor={`${uid}-note`}>
          <span className="sv-label">Note (optional)</span>
          <textarea
            id={`${uid}-note`}
            className="sv-control"
            rows={2}
            maxLength={MAX_COMMENT_CHARS}
            value={comment}
            data-testid="pdf-save-note"
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
      </div>

      {blockedReason ? (
        <InlineNotice tone="warning" title="Not saved from this window">
          {blockedReason}
        </InlineNotice>
      ) : null}
      {state.error ? (
        <InlineNotice tone="error" title="Not saved">
          {state.error}
        </InlineNotice>
      ) : null}
      <p className="sv-small sv-muted" role="status">
        {state.done ?? ''}
      </p>

      <div className="sv-row">
        <Button
          variant="primary"
          busy={state.busy}
          disabledReason={blockedReason}
          onClick={() => void save()}
          data-testid="pdf-save"
        >
          {multi ? `Save ${selection.parts.length} highlights` : 'Save highlight'}
        </Button>
        <Button onClick={onDismiss}>Cancel</Button>
      </div>
    </div>
  );
}
