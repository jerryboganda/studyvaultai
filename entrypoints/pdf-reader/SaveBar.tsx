import { useId, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { Bookmark, Library, Plus, ScanText, X } from 'lucide-react';
import {
  COLOR_SWATCH,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_BANK_NAME_CHARS,
  MAX_COMMENT_CHARS,
  type BankLite,
  type ColorId,
  type HighlightKind,
} from '@shared';
import { Button, IconButton, InfoTip, InlineNotice, errorMessage, truncate } from '@ui';
import { pageRange, placeBar, type BarPlacement, type PdfSelection } from './model';

export interface SaveDraft {
  kind: HighlightKind;
  bankId: string | null;
  comment: string;
}

/**
 * The reader's selection toolbar, drawn like the in-page toolbar: kind dots, bank, note, Save. It
 * lives in the extension's own origin, so (unlike the in-page overlay on websites, ADR-005) it may
 * contain free-text fields: a note and a new bank name. It is anchored under the selection, flips
 * above when there is no room, and never covers it.
 */
export function SaveBar({
  selection,
  banks,
  banksError,
  defaultKind,
  defaultBankId,
  paletteFor,
  barRef,
  onSave,
  onCreateBank,
  onDismiss,
  onEngaged,
  blockedReason,
}: {
  selection: PdfSelection;
  banks: readonly BankLite[];
  /** The bank list could not be read: saving still goes to the default bank. */
  banksError?: string | null;
  defaultKind: HighlightKind;
  defaultBankId: string | null;
  /** The colour each kind is painted in (the person's palette); amber-ish default without it. */
  paletteFor?(kind: HighlightKind): ColorId;
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
      // The name field and its Create button are gone: the bank choice is where the person was.
      document.getElementById(`${uid}-bank`)?.focus();
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
      <blockquote className="sv-savebar__quote" dir="auto">
        {truncate(quote, 200)}
      </blockquote>

      {fromOcr ? (
        <p className="sv-savebar__note" data-testid="pdf-save-ocr-note">
          <ScanText aria-hidden="true" strokeWidth={2.4} />
          Text recognised from a scanned image (OCR): check it.
        </p>
      ) : null}

      {multi ? (
        <p className="sv-savebar__note">
          <span className="sv-pill sv-pill--warning">Spans {pageRange(pages)}</span>
          <InfoTip label="About selections over pages" align="start">
            This selection spans more than one page. A highlight belongs to a single page, so
            StudyVault saves each page&rsquo;s part as its own highlight ({pageRange(pages)}).
          </InfoTip>
        </p>
      ) : null}

      <fieldset className="sv-kinddots" data-testid="pdf-save-kind">
        <legend className="sv-sr">Kind</legend>
        {HIGHLIGHT_KINDS.map((k) => {
          const dot = {
            '--sv-dot': COLOR_SWATCH[paletteFor?.(k) ?? 'amber'].solid,
          } as CSSProperties;
          return (
            <label key={k} className="sv-kinddot" style={dot}>
              <input
                type="radio"
                className="sv-sr"
                name={`${uid}-kind`}
                value={k}
                checked={kind === k}
                data-testid={`pdf-save-kind-${k}`}
                onChange={() => setKind(k)}
              />
              <span className="sv-kinddot__glyph" aria-hidden="true">
                {KIND_LABELS[k].glyph}
              </span>
              <span className="sv-sr">{KIND_LABELS[k].label}</span>
            </label>
          );
        })}
        <span className="sv-kinddots__name" aria-hidden="true">
          {KIND_LABELS[kind].label}
        </span>
      </fieldset>

      <div className="sv-savebar__row">
        <label className="sv-savebar__bank" htmlFor={`${uid}-bank`}>
          <Library aria-hidden="true" strokeWidth={2.4} />
          <span className="sv-sr">Bank</span>
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
        </label>
        <IconButton
          icon={Plus}
          label="New bank"
          tipSide="top"
          onClick={() => setNewBank(newBank === null ? '' : null)}
          aria-expanded={newBank !== null}
        />
      </div>
      {banksError ? (
        <p className="sv-small sv-muted" role="status">
          Banks not loaded: it saves to your default bank.
        </p>
      ) : null}

      {newBank !== null ? (
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-newbank`}>
            New bank name
          </label>
          <div className="sv-savebar__row">
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

      <label className="sv-sr" htmlFor={`${uid}-note`}>
        Note (optional)
      </label>
      <textarea
        id={`${uid}-note`}
        className="sv-control sv-savebar__notefield"
        rows={1}
        maxLength={MAX_COMMENT_CHARS}
        value={comment}
        placeholder="Add a note (optional)"
        data-testid="pdf-save-note"
        onChange={(e) => setComment(e.target.value)}
      />

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
      <p className="sv-small sv-muted sv-savebar__status" role="status">
        {state.done ?? ''}
      </p>

      <div className="sv-savebar__actions">
        <Button
          variant="primary"
          busy={state.busy}
          disabledReason={blockedReason}
          onClick={() => void save()}
          data-testid="pdf-save"
        >
          <Bookmark aria-hidden="true" />
          {multi ? `Save ${selection.parts.length} highlights` : 'Save'}
        </Button>
        <IconButton icon={X} label="Cancel" tipSide="top" onClick={onDismiss} />
      </div>
    </div>
  );
}
