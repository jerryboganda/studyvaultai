import { useRef, useState } from 'react';
import { BookOpen, Database, FileText, HardDrive, Trash2, X } from 'lucide-react';
import { getStorageUsage, listDocuments, removeDocumentBytes } from '@storage';
import {
  Button,
  ConfirmDialog,
  IconButton,
  InlineNotice,
  ProgressRing,
  VaultBuddy,
  plural,
  useAction,
  useAsync,
  useDataEpoch,
  useToast,
} from '@ui';
import { formatBytes } from '@ui/backup/format';
import { storageLabel, storageRows } from './model';
import { Card } from './ui';

/**
 * What StudyVault keeps on this device, measured now from the real database, and the one thing a
 * person can reasonably want to clear: the PDF files they chose to keep a copy of. Removing a copy
 * never touches highlights, notes or recognised text; the PDF can be opened again from its file or
 * address.
 */
export function Storage({ syncOn }: { syncOn: boolean }) {
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
  const used = u?.estimate?.usage ?? null;
  const quota = u?.estimate?.quota ?? null;
  const percent = used !== null && quota ? (used / quota) * 100 : null;
  const rows = u ? storageRows(u.rows) : [];
  const biggest = rows[0]?.count ?? 0;

  return (
    <div className="opt-stack" data-testid="storage-section">
      {usage.error ? (
        <InlineNotice
          tone="error"
          title="Could not measure storage"
          action={
            usage.retryable ? (
              <Button busy={usage.refreshing} onClick={usage.refresh}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {usage.error}
        </InlineNotice>
      ) : !u ? (
        <div className="opt-loading">
          <VaultBuddy pose="think" size={64} />
          <p className="sv-muted">Measuring…</p>
        </div>
      ) : (
        <>
          <Card
            title="Space used"
            icon={HardDrive}
            tone="warning"
            info={`Chrome's own estimate for everything StudyVault stores on this device, search data included, so it can be more than the items alone.${syncOn ? ' Sync also keeps a copy on your server.' : ''}`}
          >
            <div className="opt-space">
              {percent !== null ? (
                <ProgressRing
                  value={Math.round(percent * 10) / 10}
                  max={100}
                  label="Space used"
                  unit="percent of what Chrome allows"
                  tone="primary"
                  size={128}
                  stroke={14}
                >
                  {/* The bytes are in "Space used" beside it; the ring shows the share. */}
                  <span className="opt-ring__num opt-ring__num--sm">
                    {percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`}
                  </span>
                  <span className="opt-ring__of">used</span>
                </ProgressRing>
              ) : null}
              <dl className="opt-facts">
                <div>
                  <dt>Space used</dt>
                  <dd data-testid="storage-usage">
                    {used !== null ? formatBytes(used) : 'Not reported'}
                  </dd>
                  {quota !== null ? (
                    <dd className="sv-muted sv-small">of about {formatBytes(quota)}</dd>
                  ) : null}
                </div>
                <div>
                  <dt>Items stored</dt>
                  <dd data-testid="storage-total-rows">{u.totalRows.toLocaleString('en')}</dd>
                </div>
                <div>
                  <dt>PDF copies</dt>
                  <dd data-testid="storage-pdf-bytes">{formatBytes(u.cachedPdfBytes)}</dd>
                  <dd className="sv-muted sv-small">{plural(u.cachedPdfCount, 'file')}</dd>
                </div>
              </dl>
            </div>
          </Card>

          <Card title="What is stored" icon={Database} tone="primary">
            {rows.length === 0 ? (
              <p className="sv-muted">Nothing is stored yet.</p>
            ) : (
              <table className="opt-table" data-testid="storage-table">
                <caption className="sv-vh">What is stored</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col" className="opt-table__num">
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ table, count }) => (
                    <tr key={table}>
                      <th scope="row">
                        {storageLabel(table)}
                        <span className="opt-table__bar" aria-hidden="true">
                          <span style={{ width: `${Math.max(2, (count / biggest) * 100)}%` }} />
                        </span>
                      </th>
                      <td className="opt-table__num">{count.toLocaleString('en')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      <Card
        title="Stored PDF copies"
        icon={BookOpen}
        tone="violet"
        headingRef={heading}
        info="A copy is kept only when you choose “Keep a copy in StudyVault” in the reader. Removing it frees the space; highlights, notes and recognised text stay, and the PDF opens again from its file or address."
      >
        {docs.error ? (
          <InlineNotice
            tone="error"
            title="Could not list the stored PDF copies"
            action={
              docs.retryable ? (
                <Button busy={docs.refreshing} onClick={docs.refresh}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {docs.error}
          </InlineNotice>
        ) : docs.loading ? (
          <p className="sv-muted">Reading the stored copies…</p>
        ) : cached.length === 0 ? (
          <p className="opt-line" data-testid="no-cached-pdfs">
            No PDF copies are stored.
          </p>
        ) : (
          <>
            <ul className="opt-rows" data-testid="cached-pdfs">
              {cached.map((d) => {
                const title = d.document.title || 'Untitled PDF';
                return (
                  <li key={d.document.id} className="opt-rowitem">
                    <FileText aria-hidden="true" strokeWidth={2.4} className="opt-rowitem__icon" />
                    <span className="opt-rowitem__text" dir="auto">
                      {title}
                      <span className="opt-rowitem__meta">
                        {formatBytes(d.cachedBytes ?? 0)} · {plural(d.highlightCount, 'highlight')}
                      </span>
                    </span>
                    <IconButton
                      icon={X}
                      tipSide="left"
                      label={`Remove the stored copy of ${title}`}
                      aria-disabled={clear.busy || undefined}
                      onClick={() => {
                        if (!clear.busy) void clear.run([d.document.id], title);
                      }}
                    />
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
                <Trash2 aria-hidden="true" strokeWidth={2.6} className="opt-btnicon" />
                Remove all copies
              </Button>
            </div>
          </>
        )}
        {unlisted > 0 ? (
          <p className="sv-muted sv-small">
            {formatBytes(unlisted)} more belongs to PDFs no longer in your library. Delete all data
            removes it.
          </p>
        ) : null}
        {clear.error ? (
          <InlineNotice
            tone="error"
            title="A stored copy was not removed"
            action={
              clear.retryable ? (
                <Button busy={clear.busy} onClick={clear.retry}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {clear.error}
          </InlineNotice>
        ) : null}
      </Card>

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
    </div>
  );
}
