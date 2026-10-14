import { useEffect, useRef, type KeyboardEvent } from 'react';
import { HardDrive, Info, Trash2 } from 'lucide-react';
import { Button, InfoTip, plural } from '@ui';
import type { TextStatus } from '@pdf';

export const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MB`;

export type StoredCopyState = 'unknown' | 'none' | { bytes: number };

export interface DocInfoProps {
  title: string;
  pageCount: number;
  byteLength: number;
  /** Document id: sha-256 of the bytes (64 hex digits) or the pdf.js fingerprint fallback. */
  fingerprint: string;
  /** Why the quick fingerprint was used (sha-256 unavailable), if it was. */
  fingerprintNote?: string | null;
  textStatus: TextStatus;
  /** Pages known to have no embedded text / pages whose text comes from OCR. */
  scannedPages: number;
  ocrPages: number;
  /** Host the file came from, or null for a file opened from this device. */
  host: string | null;
  copy: StoredCopyState;
  /** Why a copy cannot be kept (private window, store without a cache); undefined when it can. */
  copyUnavailable: string | undefined;
  busy: boolean;
  onKeep(): void;
  onRemove(): void;
}

const TEXT_LABEL: Record<TextStatus, string> = {
  text: 'Selectable text',
  scanned: 'Scanned images (no selectable text)',
  partial: 'Partly scanned (some pages have no selectable text)',
};

/** Escape closes the panel and puts focus back on its summary (the disclosure's own button). */
function closeOnEscape(e: KeyboardEvent<HTMLDetailsElement>): void {
  if (e.key !== 'Escape' || !e.currentTarget.open || e.defaultPrevented) return;
  e.preventDefault();
  e.currentTarget.open = false;
  e.currentTarget.querySelector('summary')?.focus();
}

/** Document details and the stored-copy control: a disclosure in the reader's header. */
export function DocInfo(p: DocInfoProps) {
  const sha = p.fingerprint.length === 64;
  const box = useRef<HTMLDetailsElement>(null);
  // A click anywhere else closes it, as the other popovers do.
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const el = box.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);
  return (
    <details ref={box} className="sv-props" data-testid="pdf-props" onKeyDown={closeOnEscape}>
      <summary className="sv-props__summary">
        <Info aria-hidden="true" strokeWidth={2.4} />
        <span>Details</span>
      </summary>
      <div className="sv-props__pop">
        <dl className="sv-props__list">
          <div>
            <dt>Title</dt>
            <dd dir="auto">{p.title}</dd>
          </div>
          <div>
            <dt>Pages</dt>
            <dd>{p.pageCount}</dd>
          </div>
          <div>
            <dt>File size</dt>
            <dd>{formatBytes(p.byteLength)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{p.host ?? 'A file on this device'}</dd>
          </div>
          <div>
            <dt>Text</dt>
            <dd data-testid="pdf-props-text">
              {TEXT_LABEL[p.textStatus]}
              {p.scannedPages > 0 ? ` · ${plural(p.scannedPages, 'page')} without text` : ''}
              {p.ocrPages > 0 ? ` · ${plural(p.ocrPages, 'page')} recognised by OCR` : ''}
            </dd>
          </div>
          <div>
            <dt>Fingerprint</dt>
            <dd>
              <code>{p.fingerprint.slice(0, 12)}</code>{' '}
              <InfoTip label="About the fingerprint" align="end">
                {sha
                  ? 'The first 12 digits of the SHA-256 of the file; highlights find the file again by it.'
                  : 'A quick fingerprint of the file structure; highlights find the file again by it.'}
                {p.fingerprintNote ? ` ${p.fingerprintNote}` : ''}
              </InfoTip>
            </dd>
          </div>
        </dl>

        <div className="sv-props__copy">
          <span className="sv-tile sv-art--sun" aria-hidden="true">
            <HardDrive strokeWidth={2.4} />
          </span>
          <span className="sv-props__copytext">
            <strong>Stored copy</strong>
            <span className="sv-small" data-testid="pdf-props-copy">
              {p.copy === 'unknown'
                ? 'Checking…'
                : p.copy === 'none'
                  ? 'None. StudyVault keeps your highlights, not the file.'
                  : `Kept on this device: ${formatBytes(p.copy.bytes)}.`}
            </span>
          </span>
        </div>
        {p.copy === 'unknown' ? null : typeof p.copy === 'object' ? (
          <Button
            onClick={p.onRemove}
            busy={p.busy}
            data-testid="pdf-remove-copy"
            title="Removes only the kept copy of the file. Highlights, notes and recognised text stay."
          >
            <Trash2 aria-hidden="true" />
            Remove copy ({formatBytes(p.copy.bytes)})
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={p.onKeep}
            busy={p.busy}
            disabledReason={p.copyUnavailable}
            data-testid="pdf-keep-copy"
          >
            <HardDrive aria-hidden="true" />
            Keep a copy ({formatBytes(p.byteLength)})
          </Button>
        )}
        {p.copy !== 'unknown' && p.copyUnavailable && p.copy === 'none' ? (
          <p className="sv-small sv-muted">{p.copyUnavailable}</p>
        ) : null}
      </div>
    </details>
  );
}
