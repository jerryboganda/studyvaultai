import type { ReactNode } from 'react';
import {
  CalendarClock,
  CircleCheck,
  Equal,
  FileArchive,
  History,
  Lock,
  LockOpen,
  Plus,
  RefreshCw,
  Replace,
  ShieldCheck,
  Table,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { RestoreReport } from '@backup';
import type { Tone } from '../design/motion';
import { InlineNotice } from '../Notice';
import { plural } from '../text';
import { describeConflict, describeInvalidRow } from './explain';
import { formatWhen, tableLabel } from './format';
import { Disclosure, Fact, Facts } from './kit';

const short = (key: string, max = 48) => (key.length > max ? `${key.slice(0, max)}…` : key);

/**
 * One count of the dry run as a tile: icon, number and a short name for the eye; the whole sentence
 * (with its test id) for screen readers, so nothing is said twice.
 */
function Tile({
  icon: Icon,
  tone = 'neutral',
  value,
  label,
  testId,
  children,
}: {
  icon: LucideIcon;
  tone?: Tone;
  value: number;
  /** <= 2 words. */
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <li className="bk-tile">
      <span className={`bk-sumicon sv-art--${tone}`} aria-hidden="true">
        <Icon strokeWidth={2.6} />
      </span>
      <span className="bk-tile__num" aria-hidden="true">
        {value}
      </span>
      <span className="bk-tile__label" aria-hidden="true">
        {label}
      </span>
      <span className="sv-vh" data-testid={testId}>
        {children}
      </span>
    </li>
  );
}

/** Dry-run report in plain language. Nothing here has been written yet. */
export function RestoreReportView({ report }: { report: RestoreReport }) {
  const t = report.totals;
  const replace = report.mode === 'replace';
  const rows = Object.entries(report.tables).filter(([, r]) => r.archiveRows > 0 || r.liveRows > 0);
  const impact = report.replaceImpact;

  return (
    <div className="sd-stack" data-testid="restore-report">
      <Facts testId="restore-archive-facts">
        <Fact icon={CalendarClock} label="Backup made">
          {formatWhen(report.archive.createdAt)}
        </Fact>
        <Fact icon={FileArchive} label="By">
          {report.archive.createdBy.app} {report.archive.createdBy.version}
        </Fact>
        <Fact icon={report.archive.encrypted ? Lock : LockOpen} label="Protection">
          {report.archive.encrypted ? 'Encrypted (unlocked)' : 'Not encrypted'}
        </Fact>
        <Fact icon={FileArchive} label="Cached PDFs">
          {report.archive.includesAttachments ? 'Included' : 'Not included'}
        </Fact>
        {report.migratedFromVersion !== null ? (
          <Fact icon={RefreshCw} label="Data version">
            Upgraded from version {report.migratedFromVersion} to {report.currentSchemaVersion}
          </Fact>
        ) : null}
      </Facts>

      <div className="sd-stack">
        <h4 className="bk-subhead">{replace ? 'If you replace' : 'If you merge'}</h4>
        {replace ? (
          <>
            <ul className="bk-tiles" data-testid="restore-summary">
              <Tile
                icon={Replace}
                tone="primary"
                value={t.valid - t.excluded}
                label="From the file"
              >
                Your vault becomes the backup: {plural(t.valid - t.excluded, 'item')} from the file.
              </Tile>
              <Tile
                icon={Trash2}
                tone={impact.removedLiveOnlyRows > 0 ? 'danger' : 'neutral'}
                value={impact.removedLiveOnlyRows}
                label="Deleted"
                testId="restore-removed"
              >
                {plural(impact.removedLiveOnlyRows, 'item')} only in your vault will be deleted.
              </Tile>
              <Tile
                icon={History}
                tone={impact.overwrittenNewerLiveRows > 0 ? 'warning' : 'neutral'}
                value={impact.overwrittenNewerLiveRows}
                label="Rolled back"
                testId="restore-overwritten-newer"
              >
                {impact.overwrittenNewerLiveRows === 0
                  ? 'No item you changed after this backup was made will be overwritten.'
                  : `${plural(impact.overwrittenNewerLiveRows, 'item')} you changed after this backup was made will go back to the backup’s older version.`}
              </Tile>
            </ul>
            {impact.clearedWithoutArchiveData.length > 0 ? (
              <p className="sd-line bk-warnline">
                <Trash2 aria-hidden="true" strokeWidth={2.6} />
                Not in this backup, so emptied:{' '}
                {impact.clearedWithoutArchiveData.map(tableLabel).join(', ')}.
              </p>
            ) : null}
          </>
        ) : (
          <ul className="bk-tiles" data-testid="restore-summary">
            <Tile icon={Plus} tone="success" value={t.add} label="New" testId="restore-add">
              {plural(t.add, 'new item')} will be added.
            </Tile>
            <Tile
              icon={RefreshCw}
              tone="primary"
              value={t.update}
              label="Updated"
              testId="restore-update"
            >
              {plural(t.update, 'item')} will be updated because the backup has a newer version.
            </Tile>
            <Tile icon={ShieldCheck} value={t.skipLiveNewer} label="Yours newer">
              {plural(t.skipLiveNewer, 'item')} will stay as they are because your version is newer.
            </Tile>
            <Tile icon={Equal} value={t.skipIdentical} label="Same">
              {plural(t.skipIdentical, 'item')} are already identical.
            </Tile>
            <Tile
              icon={t.conflict === 0 ? CircleCheck : TriangleAlert}
              tone={t.conflict === 0 ? 'success' : 'warning'}
              value={t.conflict}
              label="Conflicts"
              testId="restore-conflict"
            >
              {t.conflict === 0
                ? 'No conflicts.'
                : `${plural(t.conflict, 'conflict')}: your version is kept (details below).`}
            </Tile>
            <Tile icon={ShieldCheck} tone="success" value={t.liveOnly} label="Only yours">
              {plural(t.liveOnly, 'item')} only in your vault are kept: merging never deletes
              anything.
            </Tile>
          </ul>
        )}
        {t.invalid > 0 ? (
          <p className="sd-line" data-testid="restore-invalid-count">
            {plural(t.invalid, 'item')} in the file did not match the data model and will be left
            out.
          </p>
        ) : null}
        {t.excluded > 0 ? (
          <p className="sd-line" data-testid="restore-excluded-count">
            {plural(t.excluded, 'item')} will be left out because something they depend on is
            missing.
          </p>
        ) : null}
        {t.droppedByMigration > 0 ? (
          <p className="sd-line">
            {plural(t.droppedByMigration, 'item')} no longer exist in the current data version.
          </p>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <Disclosure summary="By kind" icon={Table}>
          <div className="bk-tablewrap" tabIndex={0} role="region" aria-label="Items by kind">
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
          </div>
        </Disclosure>
      ) : null}

      {report.conflicts.total > 0 ? (
        <details className="sd-more" data-testid="restore-conflicts">
          <summary>{plural(report.conflicts.total, 'conflict')}</summary>
          <ul className="bk-files sd-more__body">
            {report.conflicts.items.slice(0, 20).map((c) => (
              <li key={`${c.table}:${c.key}`}>
                {tableLabel(c.table)} <code className="sd-mono">{short(c.key)}</code>:{' '}
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
        <details open className="sd-more" data-testid="restore-orphans">
          <summary>{plural(report.orphans.total, 'item')} point at missing data</summary>
          <ul className="bk-files sd-more__body">
            {report.orphans.items.slice(0, 20).map((o) => (
              <li key={`${o.table}:${o.key}:${o.field}`}>
                {tableLabel(o.table)} <code className="sd-mono">{short(o.key)}</code> refers to a
                missing {tableLabel(o.refTable).toLowerCase()} item
                {o.cascaded ? ' (which is itself left out)' : ''}.
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {report.invalidRows.total > 0 ? (
        <details open className="sd-more" data-testid="restore-invalid">
          <summary>{plural(report.invalidRows.total, 'invalid item')}</summary>
          <ul className="bk-files sd-more__body">
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
