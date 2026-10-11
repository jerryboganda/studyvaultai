import { BackupError } from './errors';
import { cleanText } from './text';
import { buildHighlightViews, locationLabel, type ExportDataset } from './views';

export interface CsvOptions {
  delimiter?: ',' | ';' | '\t';
  /**
   * Prefix cells that a spreadsheet would run as a formula (start with = + - @ tab or CR) with an
   * apostrophe. On by default: quotes come from arbitrary web pages. Imports undo it.
   */
  formulaGuard?: boolean;
  /** UTF-8 byte order mark: Excel needs it to open non-ASCII text correctly. Default false. */
  bom?: boolean;
  /** Record separator. RFC 4180 says CRLF (default). */
  newline?: '\r\n' | '\n';
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** One RFC 4180 field (quoted when it holds the delimiter, a quote, CR or LF, or edge spaces). */
export function csvCell(value: unknown, options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  let s: string;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'string') s = cleanText(value);
  else if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  else s = cleanText(JSON.stringify(value) ?? '');
  if (options.formulaGuard !== false && FORMULA_START.test(s)) s = `'${s}`;
  const needsQuotes = s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s);
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly (readonly unknown[])[], options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  const nl = options.newline ?? '\r\n';
  const body = rows.map((r) => r.map((c) => csvCell(c, options)).join(delimiter)).join(nl);
  return `${options.bom ? '\u{FEFF}' : ''}${body}${rows.length > 0 ? nl : ''}`;
}

export const HIGHLIGHT_CSV_COLUMNS = [
  'id',
  'bank',
  'folder',
  'quote',
  'comment',
  'source_title',
  'source_url',
  'captured_at',
  'location',
  'heading',
  'kind',
  'color',
  'priority',
  'tags',
  'notes',
  'quote_hash',
  'deleted',
] as const;

/**
 * One row per highlight per bank it is filed in (a highlight in two banks appears twice). `tags`
 * are joined with ", ", `notes` with a blank line. The quote column is the exact captured quote.
 */
export function exportHighlightsCsv(
  data: ExportDataset,
  options: CsvOptions & { includeDeleted?: boolean } = {},
): string {
  const views = buildHighlightViews(
    data,
    options.includeDeleted === undefined ? {} : { includeDeleted: options.includeDeleted },
  );
  const rows: unknown[][] = [[...HIGHLIGHT_CSV_COLUMNS]];
  for (const v of views) {
    const ms =
      v.memberships.length > 0 ? v.memberships : [{ bankName: '', folderPath: [] as string[] }];
    for (const m of ms) {
      rows.push([
        v.id,
        m.bankName,
        m.folderPath.join(' / '),
        v.quote,
        v.comment,
        v.sourceTitle,
        v.sourceUrl ?? '',
        v.capturedAt ?? '',
        locationLabel(v) ?? '',
        v.heading ?? '',
        v.kind,
        v.color,
        v.priority ?? '',
        v.tags.join(', '),
        v.notes.map((n) => (n.title ? `${n.title}: ${n.body}` : n.body)).join('\n\n'),
        v.quoteHash,
        v.deleted ? 'true' : 'false',
      ]);
    }
  }
  return toCsv(rows, options);
}

/** Plain JSON view for people and scripts (lossless export is `exportBackup`/`exportJson`). */
export function exportHighlightsJson(
  data: ExportDataset,
  options: { includeDeleted?: boolean } = {},
): string {
  const views = buildHighlightViews(data, options);
  return `${JSON.stringify(
    views.map((v) => ({
      id: v.id,
      quote: v.quote,
      comment: v.comment,
      source: { title: v.sourceTitle, url: v.sourceUrl, type: v.sourceType },
      capturedAt: v.capturedAt,
      location: { page: v.page, textStart: v.textStart, textEnd: v.textEnd, heading: v.heading },
      kind: v.kind,
      color: v.color,
      priority: v.priority,
      tags: v.tags,
      notes: v.notes,
      banks: v.memberships.map((m) => ({ name: m.bankName, folder: m.folderPath })),
      customFields: v.customFields,
      quoteHash: v.quoteHash,
      deleted: v.deleted,
    })),
    null,
    2,
  )}\n`;
}

export interface CsvParseLimits {
  maxRecords: number;
  maxColumns: number;
  maxFieldChars: number;
}

export const DEFAULT_CSV_LIMITS: CsvParseLimits = {
  maxRecords: 10_001,
  maxColumns: 64,
  maxFieldChars: 100_000,
};

/** Strict RFC 4180 reader. Rejects unterminated quotes, over-long fields and too many records. */
export function parseCsv(
  input: string,
  delimiter: ',' | ';' | '\t' = ',',
  limits: CsvParseLimits = DEFAULT_CSV_LIMITS,
): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  const bad = (m: string): never => {
    throw new BackupError('import_invalid', `CSV: ${m}`);
  };
  const endField = () => {
    if (record.length >= limits.maxColumns) bad(`more than ${limits.maxColumns} columns`);
    record.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    // a lone empty field is a blank line
    if (!(record.length === 1 && record[0] === '' && !wasQuoted)) {
      if (records.length >= limits.maxRecords) {
        throw new BackupError(
          'limit_exceeded',
          `CSV has more than ${limits.maxRecords - 1} rows.`,
          {
            maxRecords: limits.maxRecords,
          },
        );
      }
      records.push(record);
    }
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (field.length > limits.maxFieldChars)
      bad(`a field is longer than ${limits.maxFieldChars} characters`);
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
      wasQuoted = true;
    } else if (c === delimiter) endField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else field += c;
  }
  if (quoted) bad('a quoted field is never closed');
  if (field !== '' || record.length > 0) endRecord();
  return records;
}
