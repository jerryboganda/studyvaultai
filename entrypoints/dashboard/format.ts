/** Display formatting (pure). Dates are shown in the viewer's own time zone. */

import type { ResolveStatus } from '@shared';

/** Page status in at most two words, for chips (the full wording stays in the preview). */
export const STATUS_SHORT: Record<ResolveStatus, string> = {
  unchecked: 'Not checked',
  resolved: 'Found',
  changed: 'Changed',
  ambiguous: 'Many matches',
  orphaned: 'Not found',
};

function safeFormat(iso: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  } catch {
    return iso;
  }
}

export const formatDate = (iso: string) => safeFormat(iso, { dateStyle: 'medium' });

/** "11 Oct 2026, 14:05 GMT+3" */
export const formatDateTime = (iso: string) =>
  // Not dateStyle/timeStyle: Intl rejects them together with timeZoneName (the raw ISO showed).
  safeFormat(iso, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

export function timeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'local time';
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const CAPTURE_METHODS: Record<string, string> = {
  toolbar: 'the selection toolbar',
  shortcut: 'a keyboard shortcut',
  'context-menu': 'the context menu',
  import: 'a file import',
};

/** The file format of an import, from `customFields.importedFrom` (`ImportFormat`, @backup). */
const IMPORT_FORMATS: Record<string, string> = {
  markdown: 'a Markdown import',
  csv: 'a CSV import',
  anki: 'an Anki text import',
  docx: 'a Word document import',
  pptx: 'a PowerPoint import',
  epub: 'an EPUB import',
  html: 'an HTML import',
};

/** `fields` is the highlight's `customFields`: an import names its format there, a capture does not. */
export function describeCaptureMethod(
  method: string,
  fields?: Readonly<Record<string, string | number | boolean>>,
): string {
  const from = fields?.importedFrom;
  if (method === 'import' && typeof from === 'string' && Object.hasOwn(IMPORT_FORMATS, from)) {
    return IMPORT_FORMATS[from] as string;
  }
  return CAPTURE_METHODS[method] ?? method;
}

/** "1,234 highlights": a count with thousands separators and the right plural. */
export function countLabel(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
