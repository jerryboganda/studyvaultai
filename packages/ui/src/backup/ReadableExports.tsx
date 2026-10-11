import { useState } from 'react';
import {
  HIGHLIGHT_CSV_COLUMNS,
  buildHighlightViews,
  exportAnki,
  exportHighlightsCsv,
  exportMarkdown,
  safeFilename,
  zipFiles,
  type AnkiExport,
} from '@backup';
import { Button } from '../Button';
import { useAsync } from '../hooks';
import { InlineNotice } from '../Notice';
import { plural } from '../text';
import type { BackupDeps, DownloadFile } from './deps';
import { explainBackupError } from './explain';
import { fileStamp } from './format';
import { BACKUP_TITLE } from './scope';

type Format = 'markdown' | 'csv' | 'anki';
type Layout = 'per-bank' | 'per-folder' | 'single';

interface Prepared {
  file: DownloadFile;
  /** Lines for the "what you are about to get" box. */
  highlights: number;
  fileNames: string[];
  anki: AnkiExport | null;
  notes: string[];
}

const FORMAT_HELP: Record<Format, string> = {
  markdown:
    'Notes you can read anywhere, each quote followed by its source. Works with Obsidian, Logseq and plain editors.',
  csv: 'One row per highlight and bank, for spreadsheets and your own scripts.',
  anki: 'A text file Anki can import, built from your flashcards.',
};

/**
 * Human-readable exports (Markdown / CSV / Anki) of everything or of chosen banks. The result is
 * shown first, including the exact field mapping for Anki, and only then downloaded.
 */
export function ReadableExports({ deps }: { deps: BackupDeps }) {
  const [scope, setScope] = useState<'all' | 'banks'>('all');
  // counting highlights per bank is only needed once the user wants to choose banks
  const banks = useAsync(
    () => (scope === 'banks' ? deps.listBanks() : Promise.resolve([])),
    [scope],
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [format, setFormat] = useState<Format>('markdown');
  const [layout, setLayout] = useState<Layout>('per-bank');
  const [obsidian, setObsidian] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [bom, setBom] = useState(false);
  const [placement, setPlacement] = useState<'back' | 'field'>('back');
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState<ReturnType<typeof explainBackupError> | null>(null);

  const noBanks = scope === 'banks' && picked.size === 0;

  function invalidate() {
    setPrepared(null);
    setError(null);
  }

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    invalidate();
  }

  async function prepare() {
    setBusy(true);
    setError(null);
    setPrepared(null);
    try {
      const data = await deps.loadDataset(scope === 'banks' ? [...picked] : undefined);
      const stamp = fileStamp(deps.now());
      const highlights = buildHighlightViews(data).length;
      if (format === 'markdown') {
        const files = exportMarkdown(data, {
          layout,
          obsidian,
          includeNotes,
          exportedAt: deps.now(),
        });
        const single = files.length === 1 ? files[0] : undefined;
        const file: DownloadFile = single
          ? {
              name: safeFilename(single.path.split('/').pop() ?? 'studyvault.md'),
              data: single.content,
              mime: 'text/markdown;charset=utf-8',
            }
          : {
              name: `studyvault-markdown-${stamp}.zip`,
              data: zipFiles(files, deps.now()),
              mime: 'application/zip',
            };
        setPrepared({
          file,
          highlights,
          fileNames: files.map((f) => f.path),
          anki: null,
          notes: single
            ? []
            : ['The files are packed into one ZIP; unzip it into your notes folder.'],
        });
      } else if (format === 'csv') {
        const content = exportHighlightsCsv(data, { bom });
        setPrepared({
          file: {
            name: `studyvault-highlights-${stamp}.csv`,
            data: content,
            mime: 'text/csv;charset=utf-8',
          },
          highlights,
          fileNames: [`studyvault-highlights-${stamp}.csv`],
          anki: null,
          notes: [
            `Columns: ${HIGHLIGHT_CSV_COLUMNS.join(', ')}.`,
            'A highlight filed in two banks has two rows. Cells that a spreadsheet would run as a formula start with an apostrophe.',
          ],
        });
      } else {
        const anki = exportAnki(data, { format: 'tsv', sourcePlacement: placement });
        setPrepared({
          file: {
            name: safeFilename(anki.filename),
            data: anki.content,
            mime: 'text/tab-separated-values;charset=utf-8',
          },
          highlights,
          fileNames: [anki.filename],
          anki,
          notes: [],
        });
      }
    } catch (err) {
      setError(explainBackupError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sv-stack" data-testid="backup-readable">
      <h3>Export to Markdown, CSV or Anki</h3>
      <p>
        Readable copies for other tools. They are for reading and sharing, not for restoring: to
        move your study data use “{BACKUP_TITLE}”.
      </p>

      <fieldset className="bk-fieldset">
        <legend className="sv-label">What to export</legend>
        <div className="sv-check">
          <input
            id="bk-scope-all"
            type="radio"
            name="bk-scope"
            checked={scope === 'all'}
            data-testid="readable-scope-all"
            onChange={() => {
              setScope('all');
              invalidate();
            }}
          />
          <label htmlFor="bk-scope-all">All banks</label>
        </div>
        <div className="sv-check">
          <input
            id="bk-scope-banks"
            type="radio"
            name="bk-scope"
            checked={scope === 'banks'}
            data-testid="readable-scope-banks"
            onChange={() => {
              setScope('banks');
              invalidate();
            }}
          />
          <label htmlFor="bk-scope-banks">Selected banks</label>
        </div>
        {scope === 'banks' ? (
          <div className="bk-indent" data-testid="readable-banks">
            {banks.loading ? <p className="sv-muted">Loading banks…</p> : null}
            {banks.error ? <p className="bk-error">{banks.error}</p> : null}
            {banks.data?.map((b) => (
              <div className="sv-check" key={b.id}>
                <input
                  id={`bk-bank-${b.id}`}
                  type="checkbox"
                  checked={picked.has(b.id)}
                  data-testid={`readable-bank-${b.id}`}
                  onChange={() => toggle(b.id)}
                />
                <label htmlFor={`bk-bank-${b.id}`}>
                  {b.name} <span className="sv-muted">({plural(b.count, 'highlight')})</span>
                </label>
              </div>
            ))}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="bk-fieldset">
        <legend className="sv-label">Format</legend>
        {(['markdown', 'csv', 'anki'] as const).map((f) => (
          <div className="sv-check" key={f}>
            <input
              id={`bk-format-${f}`}
              type="radio"
              name="bk-format"
              checked={format === f}
              data-testid={`readable-format-${f}`}
              aria-describedby={`bk-format-${f}-hint`}
              onChange={() => {
                setFormat(f);
                invalidate();
              }}
            />
            <div>
              <label htmlFor={`bk-format-${f}`}>
                {f === 'markdown'
                  ? 'Markdown'
                  : f === 'csv'
                    ? 'CSV (spreadsheet)'
                    : 'Anki import file'}
              </label>
              <p id={`bk-format-${f}-hint`} className="sv-small sv-muted">
                {FORMAT_HELP[f]}
              </p>
            </div>
          </div>
        ))}
      </fieldset>

      {format === 'markdown' ? (
        <fieldset className="bk-fieldset" data-testid="readable-markdown-options">
          <legend className="sv-label">Markdown layout</legend>
          {(
            [
              ['per-bank', 'One file per bank (folders become headings)'],
              ['per-folder', 'One file per folder, in folders named after your banks'],
              ['single', 'One combined file'],
            ] as const
          ).map(([id, text]) => (
            <div className="sv-check" key={id}>
              <input
                id={`bk-layout-${id}`}
                type="radio"
                name="bk-layout"
                checked={layout === id}
                data-testid={`readable-layout-${id}`}
                onChange={() => {
                  setLayout(id);
                  invalidate();
                }}
              />
              <label htmlFor={`bk-layout-${id}`}>{text}</label>
            </div>
          ))}
          <div className="sv-check">
            <input
              id="bk-obsidian"
              type="checkbox"
              checked={obsidian}
              data-testid="readable-obsidian"
              onChange={(e) => {
                setObsidian(e.target.checked);
                invalidate();
              }}
            />
            <label htmlFor="bk-obsidian">
              Obsidian style: wiki links between files, block ids and an index note
            </label>
          </div>
          <div className="sv-check">
            <input
              id="bk-notes"
              type="checkbox"
              checked={includeNotes}
              data-testid="readable-notes"
              onChange={(e) => {
                setIncludeNotes(e.target.checked);
                invalidate();
              }}
            />
            <label htmlFor="bk-notes">Include my notes under each highlight</label>
          </div>
        </fieldset>
      ) : null}

      {format === 'csv' ? (
        <div className="sv-check">
          <input
            id="bk-bom"
            type="checkbox"
            checked={bom}
            data-testid="readable-bom"
            onChange={(e) => {
              setBom(e.target.checked);
              invalidate();
            }}
          />
          <label htmlFor="bk-bom">Excel-friendly (adds a UTF-8 byte order mark)</label>
        </div>
      ) : null}

      {format === 'anki' ? (
        <fieldset className="bk-fieldset" data-testid="readable-anki-options">
          <legend className="sv-label">Where the source citation goes</legend>
          <div className="sv-check">
            <input
              id="bk-placement-back"
              type="radio"
              name="bk-placement"
              checked={placement === 'back'}
              data-testid="readable-placement-back"
              onChange={() => {
                setPlacement('back');
                invalidate();
              }}
            />
            <label htmlFor="bk-placement-back">
              Appended to the back of the card (works with Anki’s built-in note types)
            </label>
          </div>
          <div className="sv-check">
            <input
              id="bk-placement-field"
              type="radio"
              name="bk-placement"
              checked={placement === 'field'}
              data-testid="readable-placement-field"
              onChange={() => {
                setPlacement('field');
                invalidate();
              }}
            />
            <label htmlFor="bk-placement-field">
              In a separate Source field (you create the note types first)
            </label>
          </div>
        </fieldset>
      ) : null}

      <div className="sv-row">
        <Button
          variant="primary"
          busy={busy}
          disabledReason={noBanks ? 'Choose at least one bank.' : undefined}
          data-testid="readable-prepare"
          onClick={() => void prepare()}
        >
          Preview export
        </Button>
      </div>
      {noBanks ? <p className="sv-small sv-muted">Choose at least one bank.</p> : null}

      {error ? (
        <InlineNotice tone="error" title={error.title}>
          {error.body}
        </InlineNotice>
      ) : null}

      {prepared ? (
        <div className="sv-stack" data-testid="readable-result">
          {prepared.highlights === 0 && !prepared.anki ? (
            <InlineNotice tone="info" title="There is nothing to export for this selection">
              No saved highlights match. Deleted items are never included.
            </InlineNotice>
          ) : (
            <>
              <p data-testid="readable-summary">
                {format === 'anki'
                  ? `${plural(prepared.anki?.noteCount ?? 0, 'flashcard note')} will be exported.`
                  : `${plural(prepared.highlights, 'highlight')} in ${plural(
                      prepared.fileNames.length,
                      'file',
                    )}.`}
              </p>
              {prepared.fileNames.length > 1 ? (
                <ul className="bk-files" data-testid="readable-files">
                  {prepared.fileNames.slice(0, 12).map((n) => (
                    <li key={n} className="sv-wrap">
                      {n}
                    </li>
                  ))}
                  {prepared.fileNames.length > 12 ? (
                    <li className="sv-muted">…and {prepared.fileNames.length - 12} more</li>
                  ) : null}
                </ul>
              ) : null}
            </>
          )}
          {prepared.notes.map((n) => (
            <p key={n} className="sv-small sv-muted">
              {n}
            </p>
          ))}

          {prepared.anki ? (
            <div className="sv-stack sv-stack--tight" data-testid="readable-anki-mapping">
              <h4 className="bk-subhead">Field mapping (checked before you download)</h4>
              <table className="bk-table">
                <caption className="sv-sr">How file columns map to Anki fields</caption>
                <thead>
                  <tr>
                    <th scope="col">Column</th>
                    <th scope="col">Name</th>
                    <th scope="col">Becomes in Anki</th>
                  </tr>
                </thead>
                <tbody>
                  {prepared.anki.columns.map((c) => (
                    <tr key={c.index}>
                      <td>{c.index}</td>
                      <td>{c.name}</td>
                      <td>{c.maps}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {prepared.anki.noteTypes.length > 0 ? (
                <ul className="bk-files">
                  {prepared.anki.noteTypes.map((t) => (
                    <li key={t.name}>
                      {plural(t.notes, 'note')} as “{t.name}” (fields: {t.fields.join(', ')})
                    </li>
                  ))}
                </ul>
              ) : (
                <InlineNotice tone="info" title="No flashcards to export yet">
                  Anki files are built from flashcards, not from plain highlights. Create cards from
                  your highlights first.
                </InlineNotice>
              )}
              {prepared.anki.skipped.length > 0 ? (
                <p className="sv-small">
                  {plural(prepared.anki.skipped.length, 'card')} left out:{' '}
                  {[...new Set(prepared.anki.skipped.map((s) => s.reason))].join('; ')}.
                </p>
              ) : null}
              <ul className="sv-small sv-muted bk-files">
                {prepared.anki.instructions.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="sv-row">
            <Button
              variant="primary"
              data-testid="readable-download"
              disabledReason={
                prepared.anki
                  ? prepared.anki.noteCount === 0
                    ? 'There are no flashcards to put in this file.'
                    : undefined
                  : prepared.highlights === 0
                    ? 'There is nothing to download for this selection.'
                    : undefined
              }
              onClick={() => deps.download(prepared.file)}
            >
              Download {prepared.file.name}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
