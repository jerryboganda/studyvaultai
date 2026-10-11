import { useState } from 'react';
import { KIND_LABELS } from '@shared';
import type { ImportRowSet } from '@backup';
import type { ImportExternalResult } from '@storage';
import { Button } from '../Button';
import { useAsync } from '../hooks';
import { InlineNotice } from '../Notice';
import { plural, truncate } from '../text';
import type { BackupDeps } from './deps';
import { describeRejection, explainBackupError, type ErrorExplanation } from './explain';
import { formatWhen } from './format';

type Kind = 'markdown' | 'csv';

interface Parsed {
  name: string;
  kind: Kind;
  rowSet: ImportRowSet;
}

const kindOf = (name: string): Kind => (/\.(csv|tsv)$/i.test(name) ? 'csv' : 'markdown');

/**
 * Import highlights from a Markdown or CSV file (untrusted). The parsed rows are shown first, with
 * duplicates and rejects, and only the rows the user keeps ticked are written, marked
 * "imported - needs review".
 */
export function ExternalImport({ deps }: { deps: BackupDeps }) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const banks = useAsync(
    () => (parsed ? deps.listBanks() : Promise.resolve([])),
    [parsed !== null],
  );
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [bankId, setBankId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorExplanation | null>(null);
  const [result, setResult] = useState<ImportExternalResult | null>(null);
  const [reviewEpoch, setReviewEpoch] = useState(0);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setParsed(null);
    setExcluded(new Set());
    try {
      const text = await deps.readText(file);
      const kind = kindOf(file.name);
      setParsed({ name: file.name, kind, rowSet: await deps.parseExternal(kind, text) });
    } catch (err) {
      setError(explainBackupError(err));
    } finally {
      setBusy(false);
    }
  }

  const chosen = parsed ? parsed.rowSet.highlights.filter((h) => !excluded.has(h.position)) : [];

  async function commit() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await deps.importExternal({ highlights: chosen }, { bankId: bankId || null });
      setResult(res);
      setParsed(null);
      setReviewEpoch((n) => n + 1);
    } catch (err) {
      setError(explainBackupError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sv-stack" data-testid="backup-external">
      <h3>Import highlights from a Markdown or CSV file</h3>
      <p>
        For notes from other tools, or a spreadsheet. Imported highlights are not captures from a
        web page, so they are marked <strong>imported, needs review</strong> and nothing is added
        until you confirm the list below.
      </p>
      <div className="sv-field">
        <label className="sv-label" htmlFor="bk-external-file">
          Markdown (.md) or CSV (.csv) file
        </label>
        <input
          id="bk-external-file"
          type="file"
          accept=".md,.markdown,.txt,.csv,.tsv,text/markdown,text/csv,text/plain"
          disabled={busy}
          data-testid="backup-external-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            void pick(f);
          }}
        />
      </div>

      {error ? (
        <InlineNotice tone="error" title={error.title} live>
          {error.body}
        </InlineNotice>
      ) : null}

      {parsed ? (
        <div className="sv-stack" data-testid="backup-external-review">
          <p data-testid="backup-external-stats">
            <strong>{parsed.name}</strong> read as {parsed.kind === 'csv' ? 'CSV' : 'Markdown'}:{' '}
            {plural(parsed.rowSet.stats.records, 'record')}, {parsed.rowSet.stats.accepted} can be
            imported, {parsed.rowSet.stats.duplicates} duplicate
            {parsed.rowSet.stats.duplicates === 1 ? '' : 's'} skipped,{' '}
            {parsed.rowSet.stats.rejected} rejected.
          </p>

          {parsed.rowSet.highlights.length > 0 ? (
            <>
              <div className="sv-field">
                <label className="sv-label" htmlFor="bk-external-bank">
                  Add to bank
                </label>
                <select
                  id="bk-external-bank"
                  className="sv-control"
                  value={bankId}
                  data-testid="backup-external-bank"
                  onChange={(e) => setBankId(e.target.value)}
                >
                  <option value="">Inbox</option>
                  {banks.data
                    ?.filter((b) => b.id !== 'inbox-default')
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="sv-row">
                <Button onClick={() => setExcluded(new Set())} data-testid="backup-external-all">
                  Select all
                </Button>
                <Button
                  onClick={() =>
                    setExcluded(new Set(parsed.rowSet.highlights.map((h) => h.position)))
                  }
                  data-testid="backup-external-none"
                >
                  Select none
                </Button>
              </div>
              <ul className="bk-candidates" data-testid="backup-external-rows">
                {parsed.rowSet.highlights.map((h) => (
                  <li key={h.position}>
                    <div className="sv-check">
                      <input
                        id={`bk-ext-${h.position}`}
                        type="checkbox"
                        checked={!excluded.has(h.position)}
                        data-testid={`backup-external-row-${h.position}`}
                        onChange={(e) => {
                          const next = new Set(excluded);
                          if (e.target.checked) next.delete(h.position);
                          else next.add(h.position);
                          setExcluded(next);
                        }}
                      />
                      <label htmlFor={`bk-ext-${h.position}`}>
                        <span className="bk-quote">{truncate(h.quote, 240)}</span>
                        <span className="sv-small sv-muted bk-meta">
                          {[
                            `line ${h.position}`,
                            h.sourceTitle ?? (h.sourceUrl ? h.sourceUrl : 'no source'),
                            h.kind ? KIND_LABELS[h.kind].label : null,
                            h.tags.length > 0 ? h.tags.map((t) => `#${t}`).join(' ') : null,
                            h.capturedAt ? formatWhen(h.capturedAt) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        {h.comment ? (
                          <span className="sv-small bk-meta">
                            Comment: {truncate(h.comment, 160)}
                          </span>
                        ) : null}
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <InlineNotice tone="info" title="Nothing new to import">
              Every record in the file is already in your vault, is a repeat, or was rejected.
            </InlineNotice>
          )}

          {parsed.rowSet.duplicates.length > 0 ? (
            <details data-testid="backup-external-duplicates">
              <summary>{plural(parsed.rowSet.duplicates.length, 'duplicate')} skipped</summary>
              <ul className="bk-files">
                {parsed.rowSet.duplicates.slice(0, 20).map((d) => (
                  <li key={`${d.position}:${d.quoteHash}`}>
                    Line {d.position}:{' '}
                    {d.of === 'existing'
                      ? 'the same quote is already in your vault'
                      : 'repeats an earlier record in this file'}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {parsed.rowSet.rejected.length > 0 ? (
            <details data-testid="backup-external-rejected">
              <summary>{plural(parsed.rowSet.rejected.length, 'record')} rejected</summary>
              <ul className="bk-files">
                {parsed.rowSet.rejected.slice(0, 20).map((r) => (
                  <li key={`${r.position}:${r.reason}`}>
                    Line {r.position} {describeRejection(r.reason)}.
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="sv-row">
            <Button
              variant="primary"
              busy={busy}
              disabledReason={chosen.length === 0 ? 'Tick at least one highlight.' : undefined}
              data-testid="backup-external-commit"
              onClick={() => void commit()}
            >
              Add {plural(chosen.length, 'highlight')} (marked needs review)
            </Button>
            <Button
              data-testid="backup-external-cancel"
              onClick={() => {
                setParsed(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {result ? (
        <InlineNotice tone="success" live title="Import finished">
          <span data-testid="backup-external-result">
            {plural(result.created, 'highlight')} added
            {result.duplicates > 0 ? `, ${plural(result.duplicates, 'duplicate')} skipped` : ''}
            {result.tagsCreated > 0 ? `, ${plural(result.tagsCreated, 'new tag')}` : ''}. They are
            marked “imported, needs review” below until you confirm them.
          </span>
        </InlineNotice>
      ) : null}

      <NeedsReview deps={deps} epoch={reviewEpoch} />
    </div>
  );
}

/** The imported highlights nobody has confirmed yet, with a way to confirm each one. */
function NeedsReview({ deps, epoch }: { deps: BackupDeps; epoch: number }) {
  // Finding them scans every highlight, so it runs when asked for or right after an import.
  const [requested, setRequested] = useState(false);
  const load = requested || epoch > 0;
  const list = useAsync(
    () => (load ? deps.listNeedsReview() : Promise.resolve(null)),
    [load],
    [epoch],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function review(id: string) {
    setBusy(id);
    setError(null);
    try {
      await deps.markReviewed(id);
      list.refresh();
    } catch (err) {
      setError(explainBackupError(err).body);
    } finally {
      setBusy(null);
    }
  }

  if (!load) {
    return (
      <div>
        <Button data-testid="backup-review-check" onClick={() => setRequested(true)}>
          Show imported highlights that still need review
        </Button>
      </div>
    );
  }
  if (!list.data) return null;
  if (list.data.total === 0) {
    return (
      <p className="sv-small sv-muted" data-testid="backup-needs-review-none">
        No imported highlights are waiting for review.
      </p>
    );
  }
  return (
    <div className="sv-stack sv-stack--tight" data-testid="backup-needs-review">
      <h4 className="bk-subhead">Imported, needs review ({list.data.total})</h4>
      <p className="sv-small sv-muted">
        These came from a file, not from a page you were on, so their source is only what the file
        claimed. Mark each one reviewed once you have checked it.
      </p>
      {error ? (
        <InlineNotice tone="error" title="Could not update">
          {error}
        </InlineNotice>
      ) : null}
      <ul className="bk-candidates">
        {list.data.items.map((item) => (
          <li key={item.id} className="sv-row">
            <span className="sv-grow">
              <span className="bk-quote">{truncate(item.quote, 200)}</span>
              <span className="sv-small sv-muted bk-meta">
                from {item.importedFrom === 'csv' ? 'a CSV file' : 'a Markdown file'}
              </span>
            </span>
            <Button
              busy={busy === item.id}
              data-testid={`backup-review-${item.id}`}
              onClick={() => void review(item.id)}
            >
              Mark reviewed
            </Button>
          </li>
        ))}
      </ul>
      {list.data.total > list.data.items.length ? (
        <p className="sv-small sv-muted">
          Showing {list.data.items.length} of {list.data.total}.
        </p>
      ) : null}
    </div>
  );
}
