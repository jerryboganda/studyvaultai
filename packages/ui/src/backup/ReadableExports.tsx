import { useState } from 'react';
import {
  Braces,
  Eye,
  FileDown,
  FileText,
  Layers,
  Library,
  ListChecks,
  Sheet,
  SlidersHorizontal,
} from 'lucide-react';
import {
  HIGHLIGHT_CSV_COLUMNS,
  buildHighlightViews,
  exportAnki,
  exportHighlightsCsv,
  exportHighlightsJson,
  exportMarkdown,
  safeFilename,
  zipFiles,
  type AnkiExport,
} from '@backup';
import { Button } from '../Button';
import { InfoTip } from '../design/InfoTip';
import { useAsync } from '../hooks';
import { InlineNotice } from '../Notice';
import { plural } from '../text';
import type { BackupDeps, DownloadFile } from './deps';
import { explainBackupError } from './explain';
import { fileStamp } from './format';
import { Chip, Choices, Disclosure, type ChoiceOption } from './kit';
import { BACKUP_TITLE } from './scope';

type Format = 'markdown' | 'csv' | 'anki' | 'json';
type Layout = 'per-bank' | 'per-folder' | 'single';

interface Prepared {
  file: DownloadFile;
  /** Lines for the "what you are about to get" box. */
  highlights: number;
  fileNames: string[];
  anki: AnkiExport | null;
  notes: string[];
}

/** The format picture cards. */
const FORMATS: Record<Format, Omit<ChoiceOption<Format>, 'value'>> = {
  markdown: { label: 'Markdown', hint: 'Notes apps', icon: FileText, tone: 'primary' },
  csv: { label: 'CSV', hint: 'Spreadsheets', icon: Sheet, tone: 'success' },
  anki: { label: 'Anki', hint: 'Flashcards', icon: Layers, tone: 'violet' },
  json: { label: 'JSON', hint: 'Scripts', icon: Braces, tone: 'neutral' },
};

const FORMAT_HELP: Record<Format, string> = {
  markdown:
    'Notes you can read anywhere, each quote followed by its source. Works with Obsidian, Logseq and plain editors.',
  csv: 'One row per highlight and bank, for spreadsheets and your own scripts.',
  anki: 'A text file Anki can import, built from your flashcards.',
  json: 'One JSON file for scripts and other tools: every highlight with its quote, source, notes, tags and banks. StudyVault does not import it back; to move your study data use the backup file.',
};

/**
 * Human-readable exports (Markdown / CSV / Anki / JSON) of everything or of chosen banks. The result is
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
      } else if (format === 'json') {
        const name = `studyvault-highlights-${stamp}.json`;
        setPrepared({
          file: {
            name,
            data: exportHighlightsJson(data),
            mime: 'application/json;charset=utf-8',
          },
          highlights,
          fileNames: [name],
          anki: null,
          notes: [
            'One entry per highlight, with every bank it is filed in. Notes, tags and custom fields are included; deleted items are not.',
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

  const check = (
    id: string,
    checked: boolean,
    set: (v: boolean) => void,
    testId: string,
    text: string,
  ) => (
    <div className="sv-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        data-testid={testId}
        onChange={(e) => {
          set(e.target.checked);
          invalidate();
        }}
      />
      <label htmlFor={id}>{text}</label>
    </div>
  );
  const radio = <T extends string>(
    name: string,
    id: T,
    value: T,
    set: (v: T) => void,
    testId: string,
    text: string,
  ) => (
    <div className="sv-check" key={id}>
      <input
        id={`${name}-${id}`}
        type="radio"
        name={name}
        checked={value === id}
        data-testid={testId}
        onChange={() => {
          set(id);
          invalidate();
        }}
      />
      <label htmlFor={`${name}-${id}`}>{text}</label>
    </div>
  );

  return (
    <div className="sd-card" data-testid="backup-readable">
      <div className="sd-row">
        <span className="sd-tile sd-tile--sm sv-art--sun" aria-hidden="true">
          <FileDown strokeWidth={2.4} />
        </span>
        <h3 className="sd-card__title">Readable copy</h3>
        <InfoTip label="About readable copies" align="start">
          For reading and sharing. To move your data to another computer, use “{BACKUP_TITLE}”.
        </InfoTip>
      </div>

      <h4 className="bk-subhead" id="bk-format-h">
        Format
      </h4>
      <Choices
        name="bk-format"
        labelledBy="bk-format-h"
        columns={4}
        value={format}
        onChange={(f) => {
          setFormat(f);
          invalidate();
        }}
        options={(['markdown', 'csv', 'anki', 'json'] as const).map((f) => ({
          value: f,
          ...FORMATS[f],
          testId: `readable-format-${f}`,
          ...(f === format ? { describedBy: 'bk-format-help' } : {}),
        }))}
      />
      <p id="bk-format-help" className="sd-line" data-testid="readable-format-help">
        {FORMAT_HELP[format]}
      </p>

      <h4 className="bk-subhead" id="bk-scope-h">
        What to export
      </h4>
      <Choices
        name="bk-scope"
        labelledBy="bk-scope-h"
        columns={2}
        value={scope}
        onChange={(v) => {
          setScope(v);
          invalidate();
        }}
        options={[
          {
            value: 'all',
            label: 'All banks',
            hint: 'Whole library',
            icon: Library,
            testId: 'readable-scope-all',
          },
          {
            value: 'banks',
            label: 'Some banks',
            hint: 'You pick',
            icon: ListChecks,
            testId: 'readable-scope-banks',
          },
        ]}
      />
      {scope === 'banks' ? (
        <div className="bk-choices" data-testid="readable-banks">
          {banks.loading ? <p className="sd-line">Loading banks…</p> : null}
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

      {format !== 'json' ? (
        <Disclosure summary="Options" icon={SlidersHorizontal} testId="readable-options">
          {format === 'markdown' ? (
            <fieldset className="bk-fieldset" data-testid="readable-markdown-options">
              <legend className="sv-label">Markdown layout</legend>
              {radio(
                'bk-layout',
                'per-bank',
                layout,
                setLayout,
                'readable-layout-per-bank',
                'One file per bank (folders become headings)',
              )}
              {radio(
                'bk-layout',
                'per-folder',
                layout,
                setLayout,
                'readable-layout-per-folder',
                'One file per folder, in folders named after your banks',
              )}
              {radio(
                'bk-layout',
                'single',
                layout,
                setLayout,
                'readable-layout-single',
                'One combined file',
              )}
              {check(
                'bk-obsidian',
                obsidian,
                setObsidian,
                'readable-obsidian',
                'Obsidian style: wiki links, block ids and an index note',
              )}
              {check(
                'bk-notes',
                includeNotes,
                setIncludeNotes,
                'readable-notes',
                'Include my notes under each highlight',
              )}
            </fieldset>
          ) : null}
          {format === 'csv'
            ? check(
                'bk-bom',
                bom,
                setBom,
                'readable-bom',
                'Excel-friendly (adds a UTF-8 byte order mark)',
              )
            : null}
          {format === 'anki' ? (
            <fieldset className="bk-fieldset" data-testid="readable-anki-options">
              <legend className="sv-label">Where the source citation goes</legend>
              {radio(
                'bk-placement',
                'back',
                placement,
                setPlacement,
                'readable-placement-back',
                'On the back of the card (Anki’s built-in note types)',
              )}
              {radio(
                'bk-placement',
                'field',
                placement,
                setPlacement,
                'readable-placement-field',
                'In a separate Source field (you create the note types first)',
              )}
            </fieldset>
          ) : null}
        </Disclosure>
      ) : null}

      <div className="sd-row">
        <Button
          variant="primary"
          busy={busy}
          disabledReason={noBanks ? 'Choose at least one bank.' : undefined}
          data-testid="readable-prepare"
          onClick={() => void prepare()}
        >
          Preview export
        </Button>
        {noBanks ? <span className="sd-line">Choose at least one bank.</span> : null}
      </div>

      {error ? (
        <InlineNotice tone="error" title={error.title}>
          {error.body}
        </InlineNotice>
      ) : null}

      {prepared ? (
        <div className="sd-stack bk-result" data-testid="readable-result">
          {prepared.highlights === 0 && !prepared.anki ? (
            <InlineNotice tone="info" title="There is nothing to export for this selection">
              No saved highlights match. Deleted items are never included.
            </InlineNotice>
          ) : (
            <>
              <div className="sd-row">
                <Chip icon={Eye} tone="info">
                  <span data-testid="readable-summary">
                    {format === 'anki'
                      ? `${plural(prepared.anki?.noteCount ?? 0, 'flashcard note')} will be exported.`
                      : `${plural(prepared.highlights, 'highlight')} in ${plural(
                          prepared.fileNames.length,
                          'file',
                        )}.`}
                  </span>
                </Chip>
              </div>
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
            <p key={n} className="sd-line">
              {n}
            </p>
          ))}

          {prepared.anki ? (
            <div className="sd-stack" data-testid="readable-anki-mapping">
              <h4 className="bk-subhead">Field mapping (checked before you download)</h4>
              <div
                className="bk-tablewrap"
                tabIndex={0}
                role="region"
                aria-label="Anki field mapping"
              >
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
              </div>
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
                <p className="sd-line">
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

          <div className="sd-row">
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
