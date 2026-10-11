import { useState } from 'react';
import { Button, InlineNotice, errorMessage, plural, useToast } from '@ui';
import { useApi } from './api';
import { ExplainDialog } from './dialogs';
import { formatBytes } from './format';
import { useBump, useVaultQuery } from './hooks';
import type { SearchHostState } from '@ui/vault/searchHost';

const TABLE_LABELS: Record<string, string> = {
  banks: 'Banks',
  folders: 'Folders',
  sources: 'Sources (pages)',
  highlights: 'Highlights',
  highlightBanks: 'Highlight filings',
  tags: 'Tags',
  highlightTags: 'Tag links',
  notes: 'Notes',
  documents: 'PDF documents',
  attachments: 'Cached PDF copies',
  ocrPages: 'OCR pages',
  knowledgePoints: 'Knowledge points',
  decks: 'Decks',
  cards: 'Cards',
  reviewLogs: 'Review logs',
  aiResults: 'AI results',
  syncOps: 'Sync operations',
  meta: 'Internal bookkeeping',
};

export function StoragePanel({
  hostState,
  onRebuildIndex,
}: {
  hostState: SearchHostState;
  onRebuildIndex(): void;
}) {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const usage = useVaultQuery(() => api.getStorageUsage(), []);
  const docs = useVaultQuery(() => api.listDocuments(), []);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const cached = (docs.data ?? []).filter((d) => d.cachedBytes !== null);

  const clear = async (ids: string[], label: string) => {
    setBusy(true);
    try {
      let removed = 0;
      for (const id of ids) if (await api.removeDocumentBytes(id)) removed++;
      bump();
      usage.refresh();
      docs.refresh();
      toast.push({
        message: `Cleared ${label}: ${plural(removed, 'cached copy', 'cached copies')}.`,
      });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'Could not clear the cache.') });
    } finally {
      setBusy(false);
    }
  };

  const u = usage.data;
  const percent =
    u?.estimate?.usage != null && u.estimate.quota
      ? (u.estimate.usage / u.estimate.quota) * 100
      : null;

  return (
    <section className="dash-panel" aria-labelledby="storage-title" data-testid="storage-panel">
      <h2 id="storage-title">Storage</h2>
      <p className="sv-small sv-muted">
        Everything is stored in this browser profile. Nothing is uploaded unless you turn on an
        optional feature that says so.
      </p>

      {usage.error ? (
        <InlineNotice
          tone="error"
          title="Could not measure storage"
          action={<Button onClick={usage.refresh}>Try again</Button>}
        >
          {usage.error}
        </InlineNotice>
      ) : u ? (
        <>
          <div className="dash-stats">
            <div>
              <span className="sv-label">Rows stored</span>
              <p className="dash-stat" data-testid="storage-total-rows">
                {u.totalRows.toLocaleString()}
              </p>
            </div>
            <div>
              <span className="sv-label">Browser storage in use</span>
              <p className="dash-stat" data-testid="storage-usage">
                {u.estimate?.usage != null ? formatBytes(u.estimate.usage) : 'Not reported'}
              </p>
              {u.estimate?.quota != null ? (
                <p className="sv-small sv-muted">
                  of {formatBytes(u.estimate.quota)} available
                  {percent !== null ? ` (${percent < 0.1 ? '<0.1' : percent.toFixed(1)}%)` : ''}
                </p>
              ) : null}
            </div>
            <div>
              <span className="sv-label">Cached PDF copies</span>
              <p className="dash-stat" data-testid="storage-pdf-bytes">
                {formatBytes(u.cachedPdfBytes)}
              </p>
              <p className="sv-small sv-muted">{plural(u.cachedPdfCount, 'file')}</p>
            </div>
          </div>

          <table className="dash-table" data-testid="storage-table">
            <caption className="sv-label">Rows per table</caption>
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col" className="dash-table__num">
                  Rows
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(u.rows)
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([name, count]) => (
                  <tr key={name}>
                    <th scope="row">{TABLE_LABELS[name] ?? name}</th>
                    <td className="dash-table__num">{count.toLocaleString()}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="sv-muted" role="status">
          Measuring…
        </p>
      )}

      <section className="dash-section" aria-labelledby="storage-pdf">
        <h3 id="storage-pdf">Cached PDF copies</h3>
        <p className="sv-small sv-muted">
          A copy is kept only for PDFs you chose to keep. Clearing it frees space; your highlights
          and notes stay, and the PDF can be opened again from its file or address.
        </p>
        {cached.length === 0 ? (
          <p className="sv-small" data-testid="no-cached-pdfs">
            No PDF copies are cached.
          </p>
        ) : (
          <>
            <ul className="sv-stack sv-stack--tight" data-testid="cached-pdfs">
              {cached.map((d) => (
                <li key={d.document.id} className="sv-row">
                  <span className="sv-grow sv-wrap" dir="auto">
                    {d.document.title || 'Untitled PDF'}{' '}
                    <span className="sv-muted sv-small">
                      · {formatBytes(d.cachedBytes ?? 0)} · {plural(d.highlightCount, 'highlight')}
                    </span>
                  </span>
                  <Button
                    busy={busy}
                    onClick={() => void clear([d.document.id], d.document.title || 'PDF')}
                    aria-label={`Clear the cached copy of ${d.document.title || 'this PDF'}`}
                  >
                    Clear cache
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              variant="danger"
              busy={busy}
              onClick={() => setConfirmAll(true)}
              data-testid="clear-all-cache"
            >
              Clear all cached PDF copies…
            </Button>
          </>
        )}
      </section>

      <section className="dash-section" aria-labelledby="storage-index">
        <h3 id="storage-index">Search index</h3>
        <p className="sv-small" data-testid="index-summary">
          {hostState.phase === 'ready' || hostState.phase === 'updating'
            ? `${hostState.documents.toLocaleString()} documents indexed.`
            : hostState.phase === 'building'
              ? `Building: ${hostState.done.toLocaleString()}${
                  hostState.total !== null ? ` of ${hostState.total.toLocaleString()}` : ''
                } documents read.`
              : hostState.phase === 'error'
                ? `Unavailable: ${hostState.message}`
                : 'Opening…'}
        </p>
        <p className="sv-small sv-muted">
          The index is a cache derived from your data and is rebuilt automatically when it is
          missing or damaged.
        </p>
        <Button
          onClick={onRebuildIndex}
          disabledReason={hostState.phase === 'building' ? 'It is rebuilding already.' : undefined}
          data-testid="rebuild-index"
        >
          Rebuild the search index
        </Button>
      </section>

      {confirmAll ? (
        <ExplainDialog
          title="Clear every cached PDF copy?"
          lines={[
            `${plural(cached.length, 'cached copy', 'cached copies')} (${formatBytes(
              cached.reduce((n, d) => n + (d.cachedBytes ?? 0), 0),
            )}) will be removed.`,
            'Highlights, notes and PDF records are not touched.',
          ]}
          confirmLabel="Clear the cache"
          danger
          onCancel={() => setConfirmAll(false)}
          onConfirm={async () => {
            setConfirmAll(false);
            await clear(
              cached.map((d) => d.document.id),
              'the PDF cache',
            );
          }}
        />
      ) : null}
    </section>
  );
}
