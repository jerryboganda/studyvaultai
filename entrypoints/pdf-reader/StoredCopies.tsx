import { useEffect, useState } from 'react';
import { BookOpen, HardDrive, RotateCcw, Trash2 } from 'lucide-react';
import type { PdfStore, StoredCopy } from '@pdf';
import { Button, ChunkyButton, InfoTip, InlineNotice, errorMessage, plural } from '@ui';
import { formatBytes } from './DocInfo';

/**
 * "Stored copies" on the open screen: the PDFs whose bytes StudyVault keeps (only ever at the
 * person's request), as cards with sizes, and the way to open or remove each one. Removing a copy
 * never touches highlights, notes or recognised text.
 */
export function StoredCopies({
  store,
  onOpen,
}: {
  store: Pick<PdfStore, 'listStoredCopies' | 'removeDocumentBytes'>;
  onOpen(documentId: string): void;
}) {
  const [copies, setCopies] = useState<StoredCopy[] | null>(null);
  const [error, setError] = useState<{ title: string; message: string; list: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const list = store.listStoredCopies;
  const remove = store.removeDocumentBytes;
  /** Bumped after a removal (or Retry) so the list is read again. */
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
        if (live) {
          setError({
            title: 'Copies not loaded',
            message: errorMessage(err, 'The stored copies could not be listed.'),
            list: true,
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [list, reload]);

  if (!list) return null;
  const total = (copies ?? []).reduce((n, c) => n + c.byteLength, 0);
  return (
    <section className="sv-copies" aria-labelledby="stored-copies" data-testid="pdf-copies">
      <div className="sv-copies__head">
        <span className="sv-tile sv-art--sun" aria-hidden="true">
          <HardDrive strokeWidth={2.4} />
        </span>
        <h2 id="stored-copies">Stored copies</h2>
        {copies && copies.length > 0 ? (
          <span className="sv-pill" data-testid="pdf-copies-total">
            {plural(copies.length, 'copy', 'copies')} · {formatBytes(total)}
          </span>
        ) : null}
        <InfoTip label="About stored copies" align="end">
          These are the files themselves, kept on this device only when you ask. Your highlights do
          not depend on them.
        </InfoTip>
      </div>

      {error ? (
        <InlineNotice
          tone="error"
          title={error.title}
          action={
            error.list ? (
              <Button onClick={() => setReload((n) => n + 1)}>
                <RotateCcw aria-hidden="true" />
                Retry
              </Button>
            ) : undefined
          }
        >
          {error.message}
        </InlineNotice>
      ) : null}
      {copies === null ? (
        error ? null : (
          <p className="sv-muted sv-small" role="status">
            Checking for stored copies…
          </p>
        )
      ) : copies.length === 0 ? (
        <p className="sv-copies__empty" data-testid="pdf-copies-empty">
          None yet. Keep a copy from a PDF&rsquo;s Details to reopen it here.
        </p>
      ) : (
        <ul className="sv-copies__grid">
          {copies.map((c) => (
            <li key={c.documentId} className="sv-copy" data-testid="pdf-copy">
              <span className="sv-tile sv-art--primary" aria-hidden="true">
                <BookOpen strokeWidth={2.4} />
              </span>
              <span className="sv-copy__text">
                <span className="sv-copy__name" dir="auto">
                  {c.title}
                </span>
                <span className="sv-small sv-muted">
                  {c.pageCount > 0 ? `${plural(c.pageCount, 'page')} · ` : ''}
                  {formatBytes(c.byteLength)}
                </span>
              </span>
              <span className="sv-copy__actions">
                <ChunkyButton
                  variant="primary"
                  size="sm"
                  icon={BookOpen}
                  aria-label={`Open ${c.title}`}
                  onClick={() => onOpen(c.documentId)}
                >
                  Open
                </ChunkyButton>
                <Button
                  variant="ghost"
                  busy={busy === c.documentId}
                  aria-label={`Remove copy of ${c.title}`}
                  disabledReason={
                    remove ? undefined : 'Removing copies is not available in this build.'
                  }
                  onClick={() => {
                    setBusy(c.documentId);
                    void Promise.resolve(remove?.(c.documentId))
                      .then(() => setReload((n) => n + 1))
                      .catch((err: unknown) =>
                        setError({
                          title: 'Copy not removed',
                          message: errorMessage(err, 'The copy could not be removed.'),
                          list: false,
                        }),
                      )
                      .finally(() => setBusy(null));
                  }}
                  title="Removes only the kept file. Highlights, notes and recognised text stay."
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
