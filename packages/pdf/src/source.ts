/**
 * Getting PDF bytes into the reader. Nothing here uploads anything: a file is read locally, a web
 * address is fetched by the extension page itself, without cookies or any stored credential
 * (`credentials: 'omit'`), so a sign-in wall is reported, never bypassed (SECURITY_PRIVACY).
 */

/** Largest file the reader will load into memory (pdf.js needs the whole document in the worker). */
export const MAX_PDF_BYTES = 300 * 1024 * 1024;

export type FetchFailureKind =
  | 'permission'
  | 'sign-in'
  | 'not-found'
  | 'http-error'
  | 'redirected-non-pdf'
  | 'redirect-blocked'
  | 'not-pdf'
  | 'network'
  | 'offline'
  | 'too-large'
  | 'aborted';

export interface FetchFailure {
  kind: FetchFailureKind;
  message: string;
  status?: number;
}

export type FetchResult =
  | {
      ok: true;
      bytes: Uint8Array;
      finalUrl: string;
      redirected: boolean;
      contentType: string | null;
    }
  | { ok: false; failure: FetchFailure };

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxBytes?: number;
  onProgress?: (loaded: number, total: number | null) => void;
}

const PDF_TYPES = /^application\/(x-)?pdf\b/i;
const GENERIC_TYPES = /^(application|binary)\/octet-stream\b/i;

/** `%PDF-` may be preceded by up to 1024 bytes of junk (spec leniency used by every reader). */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

const fail = (kind: FetchFailureKind, message: string, status?: number): FetchResult => ({
  ok: false,
  failure: status === undefined ? { kind, message } : { kind, message, status },
});

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'another site';
  }
};

export async function fetchPdf(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const max = opts.maxBytes ?? MAX_PDF_BYTES;
  let res: Response;
  try {
    res = await doFetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return fail('aborted', 'Loading was cancelled.');
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return fail(
        'offline',
        'This device appears to be offline, so the file could not be downloaded. Everything already in StudyVault still works without a connection.',
      );
    }
    // A cross-origin redirect to a site we have no access to fails like any network error. Asking
    // again without following redirects tells the two apart (the second answer is opaque but typed).
    const redirected = await doFetch(url, {
      credentials: 'omit',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      signal: opts.signal,
    }).then(
      (r) => r.type === 'opaqueredirect',
      () => false,
    );
    if (redirected) {
      return fail(
        'redirect-blocked',
        'The address redirects to another site, which StudyVault does not have access to. That is often a sign-in page or a download server.',
      );
    }
    return fail(
      'network',
      'The file could not be reached. The site may block requests from extensions (CORS), or you may be offline.',
    );
  }

  const finalUrl = res.url || url;
  if (res.status === 401 || res.status === 403) {
    return fail(
      'sign-in',
      `${hostOf(finalUrl)} asked for a sign-in (HTTP ${res.status}). StudyVault does not use your browser's logins to fetch files.`,
      res.status,
    );
  }
  if (res.status === 404 || res.status === 410) {
    return fail(
      'not-found',
      'No file exists at that address any more (HTTP ' + res.status + ').',
      res.status,
    );
  }
  if (!res.ok)
    return fail('http-error', `The site answered with an error (HTTP ${res.status}).`, res.status);

  const contentType = res.headers.get('content-type');
  const isPdfType = contentType !== null && PDF_TYPES.test(contentType.trim());
  const maybePdf = isPdfType || contentType === null || GENERIC_TYPES.test(contentType.trim());
  if (!maybePdf) {
    return res.redirected
      ? fail(
          'redirected-non-pdf',
          `The address redirected to ${hostOf(finalUrl)}, which returned a web page (${contentType.split(';')[0]}) instead of a PDF. This is usually a sign-in page.`,
        )
      : contentType.trim().toLowerCase().startsWith('text/html')
        ? fail(
            'not-pdf',
            'The address returned a web page (text/html) instead of a PDF. That is usually a sign-in, cookie-consent or error page.',
          )
        : fail('not-pdf', `The address returned ${contentType.split(';')[0]}, not a PDF.`);
  }

  const declared = Number(res.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (total !== null && total > max) {
    return fail(
      'too-large',
      `The file is ${Math.round(total / 1048576)} MB; the reader opens files up to ${Math.round(max / 1048576)} MB.`,
    );
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      const all = new Uint8Array(await res.arrayBuffer());
      chunks.push(all);
      loaded = all.length;
    } else {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (loaded > max) {
          void reader.cancel();
          return fail(
            'too-large',
            `The file is larger than ${Math.round(max / 1048576)} MB, which is more than the reader opens.`,
          );
        }
        opts.onProgress?.(loaded, total);
      }
    }
  } catch (err) {
    if (opts.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return fail('aborted', 'Loading was cancelled.');
    }
    return fail('network', 'The download was interrupted before the whole file arrived.');
  }

  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  if (!hasPdfHeader(bytes)) {
    return res.redirected
      ? fail(
          'redirected-non-pdf',
          `The address redirected to ${hostOf(finalUrl)} and did not return a PDF. This is usually a sign-in page.`,
        )
      : fail('not-pdf', 'The address did not return a PDF file.');
  }
  return { ok: true, bytes, finalUrl, redirected: res.redirected, contentType };
}

/** Read a user-chosen File in chunks (progress + abort) without ever sending it anywhere. */
export async function readFile(
  file: Blob,
  opts: {
    signal?: AbortSignal;
    maxBytes?: number;
    onProgress?: (loaded: number, total: number) => void;
  } = {},
): Promise<Uint8Array> {
  const max = opts.maxBytes ?? MAX_PDF_BYTES;
  if (file.size > max) {
    throw new RangeError(
      `The file is ${Math.round(file.size / 1048576)} MB; the reader opens files up to ${Math.round(max / 1048576)} MB.`,
    );
  }
  const out = new Uint8Array(file.size);
  let at = 0;
  const reader = file.stream().getReader();
  for (;;) {
    if (opts.signal?.aborted) {
      void reader.cancel();
      throw new DOMException('Loading was cancelled.', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, at);
    at += value.length;
    opts.onProgress?.(at, file.size);
  }
  return out;
}
