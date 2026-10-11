import { useId, useRef, useState } from 'react';
import { getStorageUsage, listDocuments, removeDocumentBytes } from '@storage';
import {
  Button,
  ConfirmDialog,
  InlineNotice,
  plural,
  useAction,
  useAsync,
  useDataEpoch,
  useToast,
} from '@ui';
import { formatBytes } from '@ui/backup/format';
import { storageLabel, storageRows } from './model';

/**
 * What StudyVault keeps on this device, measured now from the real database, and the one thing a
 * person can reasonably want to clear: the PDF files they chose to keep a copy of. Removing a copy
 * never touches highlights, notes or recognised text; the PDF can be opened again from its file or
 * address.
 */
export function Storage({ syncOn }: { syncOn: boolean }) {
  const uid = useId();
  const { announce } = useToast();
  const epoch = useDataEpoch();
  const usage = useAsync(() => getStorageUsage(), [], [epoch]);
  const docs = useAsync(() => listDocuments(), [], [epoch]);
  const [confirmAll, setConfirmAll] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const clear = useAction(async (ids: string[], what: string) => {
    let removed = 0;
    for (const id of ids) if (await removeDocumentBytes(id)) removed += 1;
    usage.refresh();
    docs.refresh();
    announce(`Removed ${plural(removed, 'stored copy', 'stored copies')} of ${what}.`);
    // The row that held focus is gone: hand focus to a stable element.
    heading.current?.focus();
  });

  const u = usage.data;
  const cached = (docs.data ?? []).filter((d) => d.cachedBytes !== null);
  const listedBytes = cached.reduce((n, d) => n + (d.cachedBytes ?? 0), 0);
  const unlisted = u ? Math.max(0, u.cachedPdfBytes - listedBytes) : 0;
  const percent =
    u?.estimate?.usage != null && u.estimate.quota
      ? (u.estimate.usage / u.estimate.quota) * 100
      : null;

  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`} data-testid="storage-section">
      <h2 id={`${uid}-h`}>Storage</h2>
      <p>
        Everything StudyVault keeps is stored in this Chrome profile, on this device
        {syncOn ? ' (sync, which you turned on, also keeps a copy on your server)' : ''}. The
        numbers below are counted from this device&apos;s database when the page opens and when
        something changes.
      </p>

      {usage.error ? (
        <InlineNotice
          tone="error"
          title="Could not measure storage"
          action={
            usage.retryable ? (
              <Button busy={usage.refreshing} onClick={usage.refresh}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {usage.error}
        </InlineNotice>
      ) : u ? (
        <>
          <dl className="opt-stats">
            <div>
              <dt>Items stored</dt>
              <dd data-testid="storage-total-rows">{u.totalRows.toLocaleString('en')}</dd>
            </div>
            <div>
              <dt>Space used by StudyVault</dt>
              <dd data-testid="storage-usage">
                {u.estimate?.usage != null ? formatBytes(u.estimate.usage) : 'Not reported'}
              </dd>
              {u.estimate?.quota != null ? (
                <dd className="sv-muted sv-small">
                  of about {formatBytes(u.estimate.quota)} Chrome allows
                  {percent !== null
                    ? ` (${percent < 0.1 ? 'under 0.1' : percent.toFixed(1)}%)`
                    : ''}
                </dd>
              ) : null}
            </div>
            <div>
              <dt>Stored PDF copies</dt>
              <dd data-testid="storage-pdf-bytes">{formatBytes(u.cachedPdfBytes)}</dd>
              <dd className="sv-muted sv-small">{plural(u.cachedPdfCount, 'file')}</dd>
            </div>
          </dl>
          <p className="sv-muted sv-small">
            Space used is Chrome&apos;s own estimate for everything this extension stores, including
            search data kept for speed, so it can be larger than the items alone.
          </p>

          {storageRows(u.rows).length === 0 ? (
            <p className="sv-muted">Nothing is stored yet.</p>
          ) : (
            <table className="opt-table" data-testid="storage-table">
              <caption className="sv-label">What is stored</caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col" className="opt-table__num">
                    Count
                  </th>
                </tr>
              </thead>
              <tbody>
                {storageRows(u.rows).map(({ table, count }) => (
                  <tr key={table}>
                    <th scope="row">{storageLabel(table)}</th>
                    <td className="opt-table__num">{count.toLocaleString('en')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <p className="sv-muted">Measuring…</p>
      )}

      <div
        className="opt-card sv-stack sv-stack--tight"
        role="group"
        aria-labelledby={`${uid}-pdf`}
      >
        <h3 id={`${uid}-pdf`} ref={heading} tabIndex={-1}>
          Stored PDF copies
        </h3>
        <p>
          A copy of a PDF is kept only when you choose &ldquo;Keep a copy in StudyVault&rdquo; in
          the reader. Removing it frees the space; your highlights, notes and recognised text stay,
          and you can open the PDF again from its file or address.
        </p>
        {docs.error ? (
          <InlineNotice
            tone="error"
            title="Could not list the stored PDF copies"
            action={
              docs.retryable ? (
                <Button busy={docs.refreshing} onClick={docs.refresh}>
                  Try again
                </Button>
              ) : undefined
            }
          >
            {docs.error}
          </InlineNotice>
        ) : docs.loading ? (
          <p className="sv-muted">Reading the stored copies…</p>
        ) : cached.length === 0 ? (
          <p data-testid="no-cached-pdfs">No PDF copies are stored.</p>
        ) : (
          <>
            <ul className="opt-list" data-testid="cached-pdfs">
              {cached.map((d) => {
                const title = d.document.title || 'Untitled PDF';
                return (
                  <li key={d.document.id} className="opt-item">
                    <span className="sv-grow sv-wrap" dir="auto">
                      {title}{' '}
                      <span className="sv-muted sv-small">
                        · {formatBytes(d.cachedBytes ?? 0)} ·{' '}
                        {plural(d.highlightCount, 'highlight')}
                      </span>
                    </span>
                    <Button
                      busy={clear.busy}
                      aria-label={`Remove the stored copy of ${title}`}
                      onClick={() => void clear.run([d.document.id], title)}
                    >
                      Remove copy
                    </Button>
                  </li>
                );
              })}
            </ul>
            <div>
              <Button
                variant="danger"
                busy={clear.busy}
                data-testid="clear-all-cache"
                onClick={() => setConfirmAll(true)}
              >
                Remove all stored copies…
              </Button>
            </div>
          </>
        )}
        {unlisted > 0 ? (
          <p className="sv-muted sv-small">
            {formatBytes(unlisted)} more belongs to PDFs that are no longer in your library. It is
            removed when you delete all data.
          </p>
        ) : null}
        {clear.error ? (
          <InlineNotice
            tone="error"
            title="A stored copy was not removed"
            action={
              clear.retryable ? (
                <Button busy={clear.busy} onClick={clear.retry}>
                  Try again
                </Button>
              ) : undefined
            }
          >
            {clear.error}
          </InlineNotice>
        ) : null}
      </div>

      {confirmAll ? (
        <ConfirmDialog
          title="Remove every stored PDF copy?"
          confirmLabel="Remove the copies"
          danger
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false);
            void clear.run(
              cached.map((d) => d.document.id),
              'every stored PDF',
            );
          }}
        >
          <p>
            {plural(cached.length, 'stored copy', 'stored copies')} ({formatBytes(listedBytes)})
            will be removed from this device.
          </p>
          <p>Highlights, notes, recognised text and the PDF records are not touched.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
