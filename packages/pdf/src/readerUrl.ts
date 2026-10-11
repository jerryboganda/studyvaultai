/**
 * Reader address helpers. Deliberately free of pdf.js and of any other import so the popup, the side
 * panel and the dashboard can use `import { pdfReaderPath } from '@pdf/readerUrl'` without bundling
 * the engine.
 */

export const READER_PAGE = 'pdf-reader.html';
/** Longest address the reader accepts (same bound as stored URLs). */
export const MAX_SRC_CHARS = 2048;

export interface ReaderTarget {
  /** https address of a PDF on the web (the reader asks permission for that one origin). */
  src?: string | null;
  /** Document id (content fingerprint) of a PDF whose bytes StudyVault keeps. */
  doc?: string | null;
  /** 1-based page to open on. */
  page?: number | null;
  /** Highlight id to scroll to and flash. */
  highlight?: string | null;
  /**
   * The tab that asked for the reader is private. A hint that can only make the reader more careful:
   * the reader asks the browser which window it is in and treats either answer as "private".
   */
  incognito?: boolean;
}

/** Extension-relative path that opens the reader. Pass it to `runtime.getURL`. */
export function pdfReaderPath(target: ReaderTarget = {}): string {
  const params = new URLSearchParams();
  if (target.src) params.set('src', target.src);
  if (target.doc) params.set('doc', target.doc);
  if (target.page && Number.isInteger(target.page) && target.page > 0) {
    params.set('page', String(target.page));
  }
  if (target.highlight) params.set('highlight', target.highlight);
  if (target.incognito === true) params.set('incognito', '1');
  const q = params.toString();
  return q ? `${READER_PAGE}?${q}` : READER_PAGE;
}

/** Hosts whose plain-http addresses are accepted: the CSP's loopback allowance (ADR-009), no more. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Path of a PDF-like address: `.pdf`, or `/pdf/<id with a digit>` (arXiv-style). */
const PDF_PATH = /\.pdf$|^\/pdf\/[^/]*\d[^/]*$/i;
const PDF_QUERY_KEYS = new Set(['format', 'type', 'filetype', 'ext', 'mime', 'contenttype']);

/**
 * Whether an address looks like a PDF by its text alone (no request is made): http(s) path ending in
 * `.pdf`, an arXiv-style `/pdf/2101.00001`, or a query that says so (`?file=a.pdf`, `?pdf=render`,
 * `format=pdf`). A hint, not a promise: the reader still checks the bytes. Used by the context menu
 * and offered to the popup and side panel.
 */
export function isLikelyPdfUrl(url: string | null | undefined): boolean {
  if (!url || url.length > MAX_SRC_CHARS * 4) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (PDF_PATH.test(u.pathname)) return true;
  for (const [key, value] of u.searchParams) {
    const k = key.toLowerCase().replace(/[-_]/g, '');
    const v = value.toLowerCase();
    if (k === 'pdf') return true;
    if (/\.pdf$/.test(v.split('#')[0] ?? '')) return true;
    if (PDF_QUERY_KEYS.has(k) && (v === 'pdf' || v === 'application/pdf')) return true;
  }
  return false;
}

export type SrcCheck =
  | { ok: true; url: string; origin: string; pattern: string; host: string }
  | { ok: false; message: string };

/**
 * `?src=` is untrusted input from whoever built the link. Only https addresses are accepted (plain
 * http only for localhost / 127.0.0.1, which the extension CSP already allows for local servers): no
 * credentials in the address, no other scheme, bounded length. Null when there is no `src`.
 */
export function parseSrc(raw: string | null): SrcCheck | null {
  if (raw === null || raw === '') return null;
  if (raw.length > MAX_SRC_CHARS)
    return { ok: false, message: 'That address is too long to open.' };
  return checkAddress(raw);
}

/**
 * The scheme, credential and origin rules of `parseSrc` without its length bound: the address a
 * redirect ended at (a signed download link can be long) is held to the same rules as the first one.
 */
export function checkAddress(raw: string): SrcCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, message: 'That is not a valid web address.' };
  }
  const loopbackHttp = u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !loopbackHttp) {
    return {
      ok: false,
      message: `Only https addresses can be opened from the web (this one is ${u.protocol.replace(':', '') || 'unknown'}). Download the file and open it from your computer instead.`,
    };
  }
  if (u.username !== '' || u.password !== '') {
    return { ok: false, message: 'Addresses that contain a user name or password are not opened.' };
  }
  u.hash = '';
  return { ok: true, url: u.href, origin: u.origin, pattern: `${u.origin}/*`, host: u.hostname };
}

export interface ReaderParams {
  src: SrcCheck | null;
  doc: string | null;
  page: number | null;
  highlight: string | null;
  /** `?incognito=1`: the opener was a private tab (see ReaderTarget.incognito). */
  incognito: boolean;
}

const ID = /^[0-9A-Za-z_-]{8,128}$/;

export function parseReaderParams(search: string): ReaderParams {
  const q = new URLSearchParams(search);
  const p = Number(q.get('page'));
  const doc = q.get('doc');
  const highlight = q.get('highlight');
  return {
    src: parseSrc(q.get('src')),
    doc: doc !== null && ID.test(doc) ? doc : null,
    page: Number.isInteger(p) && p > 0 ? p : null,
    highlight: highlight !== null && ID.test(highlight) ? highlight : null,
    incognito: q.get('incognito') === '1',
  };
}
