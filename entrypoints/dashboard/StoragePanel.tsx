import { useState } from 'react';
import {
  CircleCheck,
  FileText,
  HardDrive,
  Highlighter,
  RefreshCw,
  Rows3,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  BarMeter,
  BuddyEmptyState,
  ChunkyButton,
  InfoTip,
  InlineNotice,
  ProgressRing,
  errorMessage,
  plural,
  useToast,
} from '@ui';
import { useApi } from './api';
import { ExplainDialog } from './dialogs';
import { formatBytes } from './format';
import { useBump, useVaultQuery } from './hooks';
import { Action, Chip, IconAction, Loading, ViewHead } from './moreKit';
import type { SearchHostState } from '@ui/vault/searchHost';

const TABLE_LABELS: Record<string, string> = {
  banks: 'Banks',
  folders: 'Folders',
  sources: 'Sources (pages)',
  highlights: 'Highlights',
  highlightBanks: 'Highlight filings',
  tags: 'Tags',
  highlightTags: 'Tag links',
  filingRules: 'Auto-filing rules',
  syllabi: 'Syllabi',
  relations: 'Links between items',
  notes: 'Notes',
  documents: 'PDF documents',
  attachments: 'Cached PDF copies',
  ocrPages: 'OCR pages',
  knowledgePoints: 'Knowledge points',
  decks: 'Decks',
  cards: 'Cards',
  reviewLogs: 'Review logs',
  aiResults: 'AI results',
  gameEvents: 'XP history',
  gameFacts: 'Game stats',
  syncOps: 'Sync operations',
  syncEntityMeta: 'Sync bookkeeping',
  syncConflicts: 'Sync conflicts',
  syncQuarantine: 'Sync quarantine',
  meta: 'Internal bookkeeping',
};

const percentText = (p: number) =>
  p < 0.1 ? '<0.1%' : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;

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
  const tables = u
    ? Object.entries(u.rows).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    : [];
  const biggest = Math.max(1, ...tables.map(([, n]) => n));
  const busyReason = busy ? 'Clearing already.' : undefined;

  return (
    <section
      className="dash-panel mv-view"
      aria-labelledby="storage-title"
      data-testid="storage-panel"
    >
      <ViewHead
        icon={HardDrive}
        tone="sun"
        title="Storage"
        titleId="storage-title"
        info="Everything is stored in this browser profile. Nothing is uploaded unless you turn on an optional feature that says so."
      />

      <div className="store-grid">
        <div className="store-col">
          {usage.error ? (
            <InlineNotice
              tone="error"
              title="Could not measure storage"
              action={
                <ChunkyButton size="sm" onClick={usage.refresh}>
                  Try again
                </ChunkyButton>
              }
            >
              {usage.error}
            </InlineNotice>
          ) : u ? (
            <div className="mv-card store-usage">
              {percent !== null && u.estimate?.quota != null ? (
                <ProgressRing
                  // Percent, not bytes, so the spoken name stays short; the bytes are its description.
                  value={percent < 0.1 ? 0 : Math.round(percent * 10) / 10}
                  max={100}
                  unit="percent"
                  label="Browser storage in use"
                  tone="primary"
                  size={112}
                  stroke={12}
                  description={`${formatBytes(u.estimate.usage ?? 0)} of ${formatBytes(u.estimate.quota)} (${percentText(percent)})`}
                >
                  <span className="store-usage__pct">{percentText(percent)}</span>
                  <span className="store-usage__of">used</span>
                </ProgressRing>
              ) : (
                <span className="store-usage__none" aria-hidden="true">
                  <HardDrive strokeWidth={2.4} />
                </span>
              )}
              <dl className="store-stats">
                <div>
                  <dt>
                    <HardDrive aria-hidden="true" /> In use
                  </dt>
                  <dd data-testid="storage-usage">
                    {u.estimate?.usage != null ? formatBytes(u.estimate.usage) : 'Not reported'}
                  </dd>
                  {u.estimate?.quota != null ? (
                    <dd className="mv-meta">of {formatBytes(u.estimate.quota)}</dd>
                  ) : null}
                </div>
                <div>
                  <dt>
                    <Rows3 aria-hidden="true" /> Rows
                  </dt>
                  <dd data-testid="storage-total-rows">{u.totalRows.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>
                    <FileText aria-hidden="true" /> PDF copies
                  </dt>
                  <dd data-testid="storage-pdf-bytes">{formatBytes(u.cachedPdfBytes)}</dd>
                  <dd className="mv-meta">{plural(u.cachedPdfCount, 'file')}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <Loading>Measuring…</Loading>
          )}

          <section className="mv-card" aria-labelledby="storage-pdf">
            <div className="store-card-head">
              <h3 id="storage-pdf" className="mv-card__title">
                <FileText className="store-h-icon" aria-hidden="true" />
                Cached PDFs
                <InfoTip label="About cached PDFs">
                  A copy is kept only for PDFs you chose to keep. Clearing it frees space; your
                  highlights and notes stay, and the PDF opens again from its file or address.
                </InfoTip>
              </h3>
              {cached.length > 0 ? (
                <Action
                  size="sm"
                  variant="danger"
                  icon={Trash2}
                  disabledReason={busyReason}
                  onClick={() => setConfirmAll(true)}
                  data-testid="clear-all-cache"
                >
                  Clear all
                </Action>
              ) : null}
            </div>
            {docs.loading ? (
              <Loading>Reading your PDFs…</Loading>
            ) : docs.error ? (
              <InlineNotice
                tone="error"
                title="Could not read your PDFs"
                action={
                  <ChunkyButton size="sm" onClick={docs.refresh}>
                    Try again
                  </ChunkyButton>
                }
              >
                {docs.error}
              </InlineNotice>
            ) : cached.length === 0 ? (
              <div data-testid="no-cached-pdfs">
                <BuddyEmptyState
                  pose="sleep"
                  mascotSize={88}
                  heading="h4"
                  title="No cached PDFs"
                  className="store-empty"
                />
              </div>
            ) : (
              <ul className="mv-list store-pdfs" data-testid="cached-pdfs">
                {cached.map((d) => {
                  const title = d.document.title || 'Untitled PDF';
                  return (
                    <li key={d.document.id} className="store-pdf">
                      <span className="store-pdf__art sv-art--danger" aria-hidden="true">
                        <FileText strokeWidth={2.4} />
                      </span>
                      <span className="mv-grow">
                        <span className="store-pdf__title mv-wrap" dir="auto">
                          {title}
                        </span>
                        <span className="mv-row">
                          <Chip icon={HardDrive} prefix="Size">
                            {formatBytes(d.cachedBytes ?? 0)}
                          </Chip>
                          <Chip icon={Highlighter} tone="sun">
                            {plural(d.highlightCount, 'highlight')}
                          </Chip>
                        </span>
                      </span>
                      <IconAction
                        icon={Trash2}
                        className="mv-ibtn--danger"
                        label={`Clear the cached copy of ${d.document.title || 'this PDF'}`}
                        tipSide="left"
                        disabledReason={busyReason}
                        onClick={() => void clear([d.document.id], d.document.title || 'PDF')}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="mv-card" aria-labelledby="storage-index">
            <h3 id="storage-index" className="mv-card__title">
              <Search className="store-h-icon" aria-hidden="true" />
              Search index
              <InfoTip label="About the search index">
                The index is a cache made from your data. It is rebuilt by itself when it is missing
                or damaged.
              </InfoTip>
            </h3>
            <div className="store-index">
              {hostState.phase === 'ready' || hostState.phase === 'updating' ? (
                <CircleCheck
                  className="store-index__icon store-index__icon--ok"
                  aria-hidden="true"
                />
              ) : hostState.phase === 'error' ? (
                <TriangleAlert
                  className="store-index__icon store-index__icon--bad"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw className="store-index__icon" aria-hidden="true" />
              )}
              <p className="store-index__text" data-testid="index-summary">
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
              <Action
                size="sm"
                icon={RefreshCw}
                onClick={onRebuildIndex}
                disabledReason={
                  hostState.phase === 'building' ? 'It is rebuilding already.' : undefined
                }
                data-testid="rebuild-index"
              >
                Rebuild index
              </Action>
            </div>
            {hostState.phase === 'building' && hostState.total ? (
              <BarMeter
                value={hostState.done}
                max={hostState.total}
                label="Search index build"
                valueText={`${hostState.done.toLocaleString()} of ${hostState.total.toLocaleString()} documents`}
                tone="primary"
              />
            ) : null}
          </section>
        </div>
        {u ? (
          <div className="mv-card store-tables">
            <h3 className="mv-card__title">
              <span id="storage-rows-h">What is stored</span>
              <InfoTip label="About rows">
                Rows per table in this browser. Bars compare each table with the largest one.
              </InfoTip>
            </h3>
            <table
              className="store-table"
              data-testid="storage-table"
              aria-labelledby="storage-rows-h"
            >
              <thead className="sv-vh">
                <tr>
                  <th scope="col">Table</th>
                  <th scope="col">Rows</th>
                </tr>
              </thead>
              <tbody>
                {tables.map(([name, count]) => {
                  const label = TABLE_LABELS[name] ?? name;
                  return (
                    <tr key={name}>
                      <th scope="row">{label}</th>
                      <td>
                        <span className="store-table__cell">
                          {/* The number beside it is the data; the bar only draws it. */}
                          <span className="store-table__bar" aria-hidden="true">
                            <BarMeter
                              value={count}
                              max={biggest}
                              label={`${label} rows`}
                              valueText={count.toLocaleString()}
                              tone={name === 'highlights' ? 'success' : 'primary'}
                              size="sm"
                            />
                          </span>
                          <span className="store-table__num">{count.toLocaleString()}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

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
