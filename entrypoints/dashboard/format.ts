/** Display formatting (pure). Dates are shown in the viewer's own time zone. */

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
  safeFormat(iso, { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' });

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
  import: 'a Markdown or CSV import',
};
export const describeCaptureMethod = (method: string) => CAPTURE_METHODS[method] ?? method;

/** "1,234 highlights": a count with thousands separators and the right plural. */
export function countLabel(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
