import { useEffect, useState } from 'react';
import type { PdfStore, StoredCopy } from '@pdf';
import { Button, InlineNotice, errorMessage, plural } from '@ui';
import { formatBytes } from './DocInfo';

/**
 * "Stored copies" on the open screen: the PDFs whose bytes StudyVault keeps (only ever at the
 * person's request), with sizes, and the way to open or remove each one. Removing a copy never
 * touches highlights, notes or recognised text.
 */
export function StoredCopies({
  store,
  onOpen,
}: {
  store: Pick<PdfStore, 'listStoredCopies' | 'removeDocumentBytes'>;
  onOpen(documentId: string): void;
}) {
  const [copies, setCopies] = useState<StoredCopy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const list = store.listStoredCopies;
  const remove = store.removeDocumentBytes;
  /** Bumped after a removal so the list is read again. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    list?.().then(
      (found) => {
        if (!live) return;
        setCopies(found);
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err, 'The stored copies could not be listed.'));
      },
    );
    return () => {
      live = false;
    };
  }, [list, reload]);

  if (!list) return null;
  if (copies === null && error === null) return null;
  if (copies !== null && copies.length === 0 && error === null) {
    return (
      <section className="sv-open__card" aria-labelledby="stored-copies">
        <h2 id="stored-copies">Stored copies</h2>
        <p className="sv-muted" data-testid="pdf-copies-empty">
          StudyVault keeps no PDF files. Use &ldquo;Keep a copy in StudyVault&rdquo; inside a
          document if you want it to reopen without choosing the file again.
        </p>
      </section>
    );
  }
  const total = (copies ?? []).reduce((n, c) => n + c.byteLength, 0);
  return (
    <section className="sv-open__card" aria-labelledby="stored-copies" data-testid="pdf-copies">
      <h2 id="stored-copies">Stored copies</h2>
      {error ? (
        <InlineNotice tone="error" title="Stored copies">
          {error}
        </InlineNotice>
      ) : null}
      <p className="sv-muted" data-testid="pdf-copies-total">
        {plural((copies ?? []).length, 'copy', 'copies')} kept on this device, {formatBytes(total)}{' '}
        in total. These are the files themselves; your highlights do not depend on them.
      </p>
      <ul className="sv-copies">
        {(copies ?? []).map((c) => (
          <li key={c.documentId} className="sv-copies__row" data-testid="pdf-copy">
            <span className="sv-copies__name" dir="auto">
              {c.title}
            </span>
            <span className="sv-small sv-muted">
              {c.pageCount > 0 ? `${plural(c.pageCount, 'page')} · ` : ''}
              {formatBytes(c.byteLength)}
            </span>
            <Button variant="primary" onClick={() => onOpen(c.documentId)}>
              Open
            </Button>
            <Button
              busy={busy === c.documentId}
              disabledReason={
                remove ? undefined : 'Removing copies is not available in this build.'
              }
              onClick={() => {
                setBusy(c.documentId);
                void Promise.resolve(remove?.(c.documentId))
                  .then(() => setReload((n) => n + 1))
                  .catch((err: unknown) =>
                    setError(errorMessage(err, 'The copy could not be removed.')),
                  )
                  .finally(() => setBusy(null));
              }}
              title="Removes only the kept file. Highlights, notes and recognised text stay."
            >
              Remove copy
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
