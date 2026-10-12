import { useEffect, useRef, useState } from 'react';
import { KIND_LABELS } from '@shared';
import { BackupError, MAX_DOCUMENT_BYTES, type ImportFormat, type ImportRowSet } from '@backup';
import type { ImportExternalResult } from '@storage';
import { Button } from '../Button';
import { useAsync } from '../hooks';
import { InlineNotice } from '../Notice';
import { plural, truncate } from '../text';
import type { BackupDeps } from './deps';
import { describeRejection, explainBackupError, type ErrorExplanation } from './explain';
import { formatBytes, formatWhen } from './format';

type Kind = 'markdown' | 'csv' | 'document';

interface Parsed {
  name: string;
  kind: Kind;
  rowSet: ImportRowSet;
}

/** DOCX, PPTX, EPUB and HTML are read by the document reader; the rest are refused with a reason. */
const DOCUMENT_FILE = /\.(docx|pptx|epub|html?|xhtml|apkg|colpkg|doc|ppt)$/i;
const kindOf = (name: string): Kind =>
  DOCUMENT_FILE.test(name) ? 'document' : /\.(csv|tsv)$/i.test(name) ? 'csv' : 'markdown';

/** How each format reads in "X read as ...", what one record is, and what its position means. */
const FORMAT: Record<ImportFormat, { label: string; unit: string; where: string; from: string }> = {
  markdown: { label: 'Markdown', unit: 'record', where: 'Line', from: 'a Markdown file' },
  csv: { label: 'CSV', unit: 'record', where: 'Line', from: 'a CSV file' },
  anki: { label: 'an Anki text export', unit: 'note', where: 'Note', from: 'an Anki export' },
  html: { label: 'an HTML page', unit: 'paragraph', where: 'Paragraph', from: 'an HTML file' },
  epub: { label: 'an EPUB book', unit: 'paragraph', where: 'Paragraph', from: 'an EPUB file' },
  docx: {
    label: 'a Word document',
    unit: 'paragraph',
    where: 'Paragraph',
    from: 'a Word document',
  },
  pptx: { label: 'a PowerPoint file', unit: 'slide', where: 'Slide', from: 'a PowerPoint file' },
};

/** The list shows this many candidates at first; all are still imported unless unticked. */
const FIRST_ROWS = 200;

/**
 * Import highlights from a file (untrusted): Markdown, CSV, an Anki text export, a Word, PowerPoint,
 * EPUB or HTML file. It is a dry run first: what was read, what was skipped and why, and the
 * candidates to untick. Only the ticked rows are written, in one step, marked "imported, needs
 * review", and the whole import can be undone from the result (the highlights go to the Trash).
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
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<ErrorExplanation | null>(null);
  const [result, setResult] = useState<ImportExternalResult | null>(null);
  const [undone, setUndone] = useState<number | null>(null);
  const [reviewEpoch, setReviewEpoch] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // The review panel (and the button that was pressed in it) is replaced by the result: say so.
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result, undone]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setReading(file.name);
    setError(null);
    setResult(null);
    setUndone(null);
    setParsed(null);
    setShowAll(false);
    setExcluded(new Set());
    try {
      if (file.size > MAX_DOCUMENT_BYTES) {
        throw new BackupError('limit_exceeded', 'The file is larger than the import limit.', {
          maxBytes: MAX_DOCUMENT_BYTES,
        });
      }
      const kind = kindOf(file.name);
      const rowSet =
        kind === 'document'
          ? await deps.parseDocument(file.name, await deps.readBytes(file))
          : await deps.parseExternal(kind, await deps.readText(file), file.name);
      setParsed({ name: file.name, kind, rowSet });
    } catch (err) {
      setError(explainBackupError(err));
    } finally {
      setBusy(false);
      setReading(null);
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
      setUndone(null);
      setParsed(null);
      setReviewEpoch((n) => n + 1);
    } catch (err) {
      setError(explainBackupError(err));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const { removed } = await deps.undoImport(result.batchId);
      setUndone(removed);
      setReviewEpoch((n) => n + 1);
    } catch (err) {
      setError(explainBackupError(err));
    } finally {
      setBusy(false);
    }
  }

  const format: ImportFormat | null = parsed
    ? (parsed.rowSet.format ?? (parsed.kind === 'csv' ? 'csv' : 'markdown'))
    : null;
  const spec = format ? FORMAT[format] : null;
  const where = (position: number, locator?: string | null) =>
    locator ?? `${spec?.where ?? 'Line'} ${position}`;
  const rows = parsed ? parsed.rowSet.highlights : [];
  const shown = showAll ? rows : rows.slice(0, FIRST_ROWS);

  return (
    <div className="sv-stack" data-testid="backup-external">
      <h3>Import highlights from a file</h3>
      <p>
        For notes from other tools, a spreadsheet, an Anki export, or a document you want to study
        from. Imported highlights are not captures from a web page, so they are marked{' '}
        <strong>imported, needs review</strong> and nothing is added until you confirm the list
        below.
      </p>
      <div className="sv-field">
        <label className="sv-label" htmlFor="bk-external-file">
          File to import
        </label>
        <input
          ref={fileRef}
          id="bk-external-file"
          type="file"
          aria-describedby="bk-external-help"
          accept=".md,.markdown,.txt,.csv,.tsv,.docx,.pptx,.epub,.html,.htm,.xhtml,.apkg,.colpkg,.doc,.ppt,text/markdown,text/csv,text/plain,text/html"
          disabled={busy}
          data-testid="backup-external-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            void pick(f);
          }}
        />
        <p id="bk-external-help" className="sv-small sv-muted" data-testid="backup-external-help">
          Reads Markdown (.md), CSV (.csv, .tsv), Anki “Notes in Plain Text” (.txt), Word (.docx),
          PowerPoint (.pptx), EPUB (.epub) and HTML (.html). One highlight per paragraph, or per
          slide for PowerPoint; text only, nothing is fetched from the internet. Files up to{' '}
          {formatBytes(MAX_DOCUMENT_BYTES)}. Not supported: Anki .apkg packages (export “Notes in
          Plain Text” from Anki instead), old .doc and .ppt files (save as .docx or .pptx), and
          password-protected or DRM-protected files.
        </p>
      </div>

      {reading ? (
        <p className="sv-small" role="status" data-testid="backup-external-reading">
          Reading {reading}…
        </p>
      ) : null}

      {error ? (
        <InlineNotice tone="error" title={error.title} live>
          {error.body}
          {error.lines.length > 0 ? (
            <ul className="bk-files" data-testid="backup-external-error-detail">
              {error.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </InlineNotice>
      ) : null}

      {parsed && spec ? (
        <div className="sv-stack" data-testid="backup-external-review">
          <p data-testid="backup-external-stats">
            <strong>{parsed.name}</strong> read as {spec.label}:{' '}
            {plural(parsed.rowSet.stats.records, spec.unit)}, {parsed.rowSet.stats.accepted} can be
            imported, {parsed.rowSet.stats.duplicates} duplicate
            {parsed.rowSet.stats.duplicates === 1 ? '' : 's'} skipped,{' '}
            {parsed.rowSet.stats.rejected} rejected.
          </p>

          {parsed.rowSet.warnings && parsed.rowSet.warnings.length > 0 ? (
            <InlineNotice tone="warning" title="Not everything in the file comes across">
              <ul className="bk-files" data-testid="backup-external-warnings">
                {parsed.rowSet.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </InlineNotice>
          ) : null}

          {rows.length > 0 ? (
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
                  onClick={() => setExcluded(new Set(rows.map((h) => h.position)))}
                  data-testid="backup-external-none"
                >
                  Select none
                </Button>
              </div>
              <ul className="bk-candidates" data-testid="backup-external-rows">
                {shown.map((h) => (
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
                            h.locator ?? `line ${h.position}`,
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
              {rows.length > shown.length ? (
                <div className="sv-row">
                  <p className="sv-small sv-muted" data-testid="backup-external-capped">
                    Showing the first {shown.length} of {rows.length}. The rest are imported too
                    unless you press Select none.
                  </p>
                  <Button data-testid="backup-external-show-all" onClick={() => setShowAll(true)}>
                    Show all {rows.length}
                  </Button>
                </div>
              ) : null}
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
                    {where(d.position, d.locator)}:{' '}
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
                    {where(r.position, r.locator)} {describeRejection(r.reason)}.
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
                fileRef.current?.focus();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div ref={resultRef} tabIndex={-1} data-testid="backup-external-outcome">
          {undone === null ? (
            <InlineNotice
              tone="success"
              live
              title="Import finished"
              action={
                result.created > 0 ? (
                  <Button
                    busy={busy}
                    data-testid="backup-external-undo"
                    onClick={() => void undo()}
                  >
                    Undo this import
                  </Button>
                ) : undefined
              }
            >
              <span data-testid="backup-external-result">
                {plural(result.created, 'highlight')} added
                {result.duplicates > 0 ? `, ${plural(result.duplicates, 'duplicate')} skipped` : ''}
                {result.tagsCreated > 0 ? `, ${plural(result.tagsCreated, 'new tag')}` : ''}. They
                are marked “imported, needs review” below until you confirm them. Undo moves them to
                the Trash; they can be restored from there.
              </span>
            </InlineNotice>
          ) : (
            <InlineNotice tone="success" live title="Import undone">
              <span data-testid="backup-external-undone">
                {plural(undone, 'highlight')} moved to the Trash. Restore them from the Trash if you
                change your mind.
              </span>
            </InlineNotice>
          )}
        </div>
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
                from {FORMAT[item.importedFrom as ImportFormat]?.from ?? 'a file'}
                {item.file ? ` (${item.file}${item.locator ? `, ${item.locator}` : ''})` : ''}
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
