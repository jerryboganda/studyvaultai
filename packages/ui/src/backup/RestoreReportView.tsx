import type { RestoreReport } from '@backup';
import { InlineNotice } from '../Notice';
import { plural } from '../text';
import { describeConflict, describeInvalidRow } from './explain';
import { formatWhen, tableLabel } from './format';

const short = (key: string, max = 48) => (key.length > max ? `${key.slice(0, max)}…` : key);

/** Dry-run report in plain language. Nothing here has been written yet. */
export function RestoreReportView({ report }: { report: RestoreReport }) {
  const t = report.totals;
  const replace = report.mode === 'replace';
  const rows = Object.entries(report.tables).filter(([, r]) => r.archiveRows > 0 || r.liveRows > 0);
  const impact = report.replaceImpact;

  return (
    <div className="sv-stack" data-testid="restore-report">
      <dl className="bk-facts" data-testid="restore-archive-facts">
        <div>
          <dt>Backup made</dt>
          <dd>{formatWhen(report.archive.createdAt)}</dd>
        </div>
        <div>
          <dt>By</dt>
          <dd>
            {report.archive.createdBy.app} {report.archive.createdBy.version}
          </dd>
        </div>
        <div>
          <dt>Protection</dt>
          <dd>{report.archive.encrypted ? 'Encrypted (unlocked)' : 'Not encrypted'}</dd>
        </div>
        <div>
          <dt>Cached PDFs</dt>
          <dd>{report.archive.includesAttachments ? 'Included' : 'Not included'}</dd>
        </div>
        {report.migratedFromVersion !== null ? (
          <div>
            <dt>Data version</dt>
            <dd>
              Upgraded from version {report.migratedFromVersion} to {report.currentSchemaVersion}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="sv-stack sv-stack--tight">
        <h4 className="bk-subhead">
          {replace ? 'What replacing would do' : 'What merging would do'}
        </h4>
        {replace ? (
          <ul className="bk-summary" data-testid="restore-summary">
            <li>
              Your vault becomes the backup: {plural(t.valid - t.excluded, 'item')} from the file.
            </li>
            <li data-testid="restore-removed">
              <strong>
                {plural(impact.removedLiveOnlyRows, 'item')} that exist only in your vault will be
                deleted.
              </strong>
            </li>
            <li data-testid="restore-overwritten-newer">
              {impact.overwrittenNewerLiveRows === 0
                ? 'No item you changed after this backup was made will be overwritten.'
                : `${plural(impact.overwrittenNewerLiveRows, 'item')} you changed after this backup was made will go back to the backup’s older version.`}
            </li>
            {impact.clearedWithoutArchiveData.length > 0 ? (
              <li>
                Not in this backup, so emptied:{' '}
                {impact.clearedWithoutArchiveData.map(tableLabel).join(', ')}.
              </li>
            ) : null}
          </ul>
        ) : (
          <ul className="bk-summary" data-testid="restore-summary">
            <li data-testid="restore-add">{plural(t.add, 'new item')} will be added.</li>
            <li data-testid="restore-update">
              {plural(t.update, 'item')} will be updated because the backup has a newer version.
            </li>
            <li>
              {plural(t.skipLiveNewer, 'item')} will stay as they are because your version is newer.
            </li>
            <li>{plural(t.skipIdentical, 'item')} are already identical.</li>
            <li data-testid="restore-conflict">
              {t.conflict === 0
                ? 'No conflicts.'
                : `${plural(t.conflict, 'conflict')}: your version is kept (details below).`}
            </li>
            <li>
              {plural(t.liveOnly, 'item')} exist only in your vault and are kept: merging never
              deletes anything.
            </li>
          </ul>
        )}
        {t.invalid > 0 ? (
          <p data-testid="restore-invalid-count">
            {plural(t.invalid, 'item')} in the file did not match the data model and will be left
            out.
          </p>
        ) : null}
        {t.excluded > 0 ? (
          <p data-testid="restore-excluded-count">
            {plural(t.excluded, 'item')} will be left out because something they depend on is
            missing.
          </p>
        ) : null}
        {t.droppedByMigration > 0 ? (
          <p>{plural(t.droppedByMigration, 'item')} no longer exist in the current data version.</p>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <table className="bk-table" data-testid="restore-table">
          <caption className="sv-sr">Items by table</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">In backup</th>
              <th scope="col">Add</th>
              <th scope="col">Update</th>
              <th scope="col">Same</th>
              <th scope="col">Yours is newer</th>
              <th scope="col">Conflict</th>
              <th scope="col">Only in vault</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, r]) => (
              <tr key={name}>
                <th scope="row">{tableLabel(name)}</th>
                <td>{r.archiveRows}</td>
                <td>{r.add}</td>
                <td>{r.update}</td>
                <td>{r.skipIdentical}</td>
                <td>{r.skipLiveNewer}</td>
                <td>{r.conflict}</td>
                <td>{r.liveOnly}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {report.conflicts.total > 0 ? (
        <details data-testid="restore-conflicts">
          <summary>{plural(report.conflicts.total, 'conflict')}</summary>
          <ul className="bk-files">
            {report.conflicts.items.slice(0, 20).map((c) => (
              <li key={`${c.table}:${c.key}`}>
                {tableLabel(c.table)} <code className="bk-mono">{short(c.key)}</code>:{' '}
                {describeConflict(c.reason)}
              </li>
            ))}
            {report.conflicts.total > 20 ? (
              <li className="sv-muted">…and {report.conflicts.total - 20} more</li>
            ) : null}
          </ul>
        </details>
      ) : null}

      {report.orphans.total > 0 ? (
        <details open data-testid="restore-orphans">
          <summary>{plural(report.orphans.total, 'item')} point at missing data</summary>
          <ul className="bk-files">
            {report.orphans.items.slice(0, 20).map((o) => (
              <li key={`${o.table}:${o.key}:${o.field}`}>
                {tableLabel(o.table)} <code className="bk-mono">{short(o.key)}</code> refers to a
                missing {tableLabel(o.refTable).toLowerCase()} item
                {o.cascaded ? ' (which is itself left out)' : ''}.
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {report.invalidRows.total > 0 ? (
        <details open data-testid="restore-invalid">
          <summary>{plural(report.invalidRows.total, 'invalid item')}</summary>
          <ul className="bk-files">
            {report.invalidRows.items.slice(0, 20).map((r) => (
              <li key={`${r.table}:${r.line}`}>{describeInvalidRow(r)}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {report.skippedTables.length > 0 ? (
        <InlineNotice tone="info" title="Parts of the file are ignored">
          This version of StudyVault does not use: {report.skippedTables.join(', ')}.
        </InlineNotice>
      ) : null}
      {report.warnings
        .filter((w) => !w.startsWith('Ignored'))
        .map((w) => (
          <InlineNotice key={w} tone="warning">
            {w}
          </InlineNotice>
        ))}
    </div>
  );
}
