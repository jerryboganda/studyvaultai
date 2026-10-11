import { Button, plural } from '@ui';
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

/** Document properties and the stored-copy control, in a disclosure under the title. */
export function DocInfo(p: DocInfoProps) {
  const sha = p.fingerprint.length === 64;
  return (
    <details className="sv-props" data-testid="pdf-props">
      <summary>Document properties and stored copy</summary>
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
            <code>{p.fingerprint.slice(0, 12)}</code>
            <span className="sv-muted sv-small">
              {' '}
              {sha
                ? '(first 12 digits of the SHA-256 of the file; highlights find the file again by it)'
                : '(a quick fingerprint of the file structure)'}
            </span>
          </dd>
        </div>
        <div>
          <dt>Stored copy</dt>
          <dd data-testid="pdf-props-copy">
            {p.copy === 'unknown'
              ? 'Checking…'
              : p.copy === 'none'
                ? 'None. StudyVault keeps your highlights, not the file, unless you keep a copy.'
                : `Kept on this device: ${formatBytes(p.copy.bytes)}.`}
          </dd>
        </div>
      </dl>
      {p.copy === 'unknown' ? null : typeof p.copy === 'object' ? (
        <Button
          onClick={p.onRemove}
          busy={p.busy}
          data-testid="pdf-remove-copy"
          title="Removes only the kept copy of the file. Highlights, notes and recognised text stay."
        >
          Remove stored copy ({formatBytes(p.copy.bytes)})
        </Button>
      ) : (
        <Button
          onClick={p.onKeep}
          busy={p.busy}
          disabledReason={p.copyUnavailable}
          data-testid="pdf-keep-copy"
        >
          Keep a copy in StudyVault ({formatBytes(p.byteLength)})
        </Button>
      )}
      {p.copy !== 'unknown' && p.copyUnavailable && p.copy === 'none' ? (
        <p className="sv-small sv-muted">{p.copyUnavailable}</p>
      ) : null}
    </details>
  );
}
