// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { FINGERPRINT_MAX_BYTES, documentFingerprint } from './fingerprint';
import { isLikelyPdfUrl, parseReaderParams, parseSrc, pdfReaderPath } from './readerUrl';
import { fetchPdf, hasPdfHeader, readFile } from './source';
import { buildPdf, proseFixture } from './testing/pdfWriter';
import { pageHasText, samplePageNumbers, summarizeTextStatus } from './textStatus';

const PDF = buildPdf(proseFixture(1));

function respond(
  body: Uint8Array | string,
  init: { status?: number; type?: string | null; url?: string; redirected?: boolean } = {},
): typeof fetch {
  return async () => {
    const headers = new Headers();
    if (init.type !== null) headers.set('content-type', init.type ?? 'application/pdf');
    const res = new Response(body as BodyInit, { status: init.status ?? 200, headers });
    Object.defineProperty(res, 'url', { value: init.url ?? 'https://example.org/a.pdf' });
    Object.defineProperty(res, 'redirected', { value: init.redirected ?? false });
    return res;
  };
}

describe('fetchPdf', () => {
  it('returns the bytes of a PDF (content type decides, not the extension)', async () => {
    const r = await fetchPdf('https://example.org/download?id=7', {
      fetchImpl: respond(PDF, { url: 'https://cdn.example.org/blob', redirected: true }),
      isOriginGranted: async (pattern) => pattern === 'https://cdn.example.org/*',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes.length).toBe(PDF.length);
      expect(r.redirected).toBe(true);
      expect(hasPdfHeader(r.bytes)).toBe(true);
    }
  });

  it('sends no cookies and no referrer', async () => {
    let seen: RequestInit | undefined;
    await fetchPdf('https://example.org/a.pdf', {
      fetchImpl: async (_u, init) => {
        seen = init;
        return respond(PDF)('x');
      },
    });
    expect(seen).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it.each([
    [401, 'sign-in'],
    [403, 'sign-in'],
    [404, 'not-found'],
    [500, 'http-error'],
  ])('HTTP %i is reported as %s', async (status, kind) => {
    const r = await fetchPdf('https://example.org/a.pdf', {
      fetchImpl: respond('no', { status, type: 'text/html' }),
    });
    expect(r).toMatchObject({ ok: false, failure: { kind, status } });
  });

  it('a redirect to an HTML page is called out as a probable sign-in page', async () => {
    const r = await fetchPdf('https://example.org/a.pdf', {
      fetchImpl: respond('<html>login</html>', {
        type: 'text/html; charset=utf-8',
        url: 'https://login.example.org/sso',
        redirected: true,
      }),
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'redirected-non-pdf' } });
    if (!r.ok) expect(r.failure.message).toContain('login.example.org');
  });

  it('HTML without a redirect is "not a PDF"', async () => {
    const r = await fetchPdf('https://example.org/a.pdf', {
      fetchImpl: respond('<html/>', { type: 'text/html' }),
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'not-pdf' } });
  });

  it('octet-stream is accepted only when the bytes are a PDF', async () => {
    const good = await fetchPdf('https://example.org/x', {
      fetchImpl: respond(PDF, { type: 'application/octet-stream' }),
    });
    expect(good.ok).toBe(true);
    const bad = await fetchPdf('https://example.org/x', {
      fetchImpl: respond('<html>', { type: 'application/octet-stream' }),
    });
    expect(bad).toMatchObject({ ok: false, failure: { kind: 'not-pdf' } });
  });

  it('a network/CORS/CSP failure is reported with its likely causes and a fallback', async () => {
    const r = await fetchPdf('https://example.org/a.pdf', {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'network' } });
  });

  it('a cross-origin redirect we cannot follow is told apart from a plain network error', async () => {
    const calls: Array<RequestInit['redirect']> = [];
    const r = await fetchPdf('https://example.org/a.pdf', {
      fetchImpl: async (_u, init) => {
        calls.push(init?.redirect);
        if (init?.redirect === 'manual') {
          const res = new Response(null, { status: 200 });
          Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
          return res;
        }
        throw new TypeError('Failed to fetch');
      },
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'redirect-blocked' } });
    expect(calls).toEqual(['follow', 'manual']);
  });

  it('enforces the size limit from the header and while streaming', async () => {
    const big = await fetchPdf('https://example.org/a.pdf', {
      fetchImpl: respond(PDF),
      maxBytes: 100,
    });
    expect(big).toMatchObject({ ok: false, failure: { kind: 'too-large' } });
  });

  it('reports progress', async () => {
    const seen: number[] = [];
    await fetchPdf('https://example.org/a.pdf', {
      fetchImpl: respond(PDF),
      onProgress: (l) => seen.push(l),
    });
    expect(seen.at(-1)).toBe(PDF.length);
  });

  it('abort is its own outcome', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await fetchPdf('https://example.org/a.pdf', {
      signal: ac.signal,
      fetchImpl: async (_u, init) => {
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return respond(PDF)('x');
      },
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'aborted' } });
  });
});

describe('readFile', () => {
  it('reads a Blob in chunks and never exceeds the limit', async () => {
    const seen: number[] = [];
    const out = await readFile(new Blob([PDF as BlobPart]), { onProgress: (n) => seen.push(n) });
    expect(out).toEqual(PDF);
    expect(seen.at(-1)).toBe(PDF.length);
    await expect(readFile(new Blob([PDF as BlobPart]), { maxBytes: 10 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('reader address', () => {
  it('accepts plain https addresses and derives the single origin to request', () => {
    expect(parseSrc('https://example.org/files/a.pdf?x=1#page=3')).toEqual({
      ok: true,
      url: 'https://example.org/files/a.pdf?x=1',
      origin: 'https://example.org',
      pattern: 'https://example.org/*',
      host: 'example.org',
    });
  });

  it.each([
    ['http://example.org/a.pdf', 'Only https'],
    ['javascript:alert(1)', 'Only https'],
    ['file:///C:/a.pdf', 'Only https'],
    ['https://user:pw@example.org/a.pdf', 'user name or password'],
    ['not a url', 'not a valid'],
    [`https://example.org/${'a'.repeat(2100)}`, 'too long'],
  ])('rejects %s', (raw, text) => {
    const r = parseSrc(raw);
    expect(r).toMatchObject({ ok: false });
    expect(r && !r.ok && r.message).toContain(text);
  });

  it('round-trips through the helper the popup uses', () => {
    const path = pdfReaderPath({
      src: 'https://example.org/a b.pdf',
      page: 4,
      highlight: 'hl-0001abcd',
    });
    expect(path.startsWith('pdf-reader.html?')).toBe(true);
    const parsed = parseReaderParams(path.slice(path.indexOf('?')));
    expect(parsed.page).toBe(4);
    expect(parsed.highlight).toBe('hl-0001abcd');
    expect(parsed.incognito).toBe(false);
    expect(parseReaderParams('?doc=' + 'a'.repeat(64)).doc).toBe('a'.repeat(64));
    expect(parseReaderParams('?doc=../etc').doc).toBeNull();
    expect(parsed.src).toMatchObject({ ok: true, host: 'example.org' });
    expect(pdfReaderPath()).toBe('pdf-reader.html');
    expect(parseReaderParams('').src).toBeNull();
  });
});

describe('reader address: private opener', () => {
  it('carries "the opener was private" only when it was, and reads only the exact value 1', () => {
    expect(pdfReaderPath({ src: 'https://example.org/a.pdf' })).not.toContain('incognito');
    expect(pdfReaderPath({ src: 'https://example.org/a.pdf', incognito: false })).not.toContain(
      'incognito',
    );
    const path = pdfReaderPath({ src: 'https://example.org/a.pdf', incognito: true });
    expect(path).toContain('incognito=1');
    expect(parseReaderParams(path.slice(path.indexOf('?'))).incognito).toBe(true);
    for (const q of ['?incognito=0', '?incognito=true', '?incognito=', '?incognito=11']) {
      expect(parseReaderParams(q).incognito, q).toBe(false);
    }
  });
});

describe('fingerprint and text status helpers', () => {
  it('very large files fall back to the pdf.js fingerprint with a note', async () => {
    const fake = { byteLength: FINGERPRINT_MAX_BYTES + 1 } as unknown as Uint8Array;
    const fp = await documentFingerprint(fake, 'f'.repeat(32));
    expect(fp).toMatchObject({ kind: 'pdfjs', id: 'f'.repeat(32) });
    expect(fp.note).toContain('quick fingerprint');
  });

  it('samples evenly including first and last, and summarises', () => {
    expect(samplePageNumbers(5)).toEqual([1, 2, 3, 4, 5]);
    const s = samplePageNumbers(1000);
    expect(s).toHaveLength(16);
    expect(s[0]).toBe(1);
    expect(s.at(-1)).toBe(1000);
    expect(pageHasText({ text: '12' })).toBe(false);
    expect(pageHasText({ text: 'a real sentence of text' })).toBe(true);
    expect(
      summarizeTextStatus(
        new Map([
          [1, true],
          [2, true],
        ]),
      ),
    ).toBe('text');
    expect(summarizeTextStatus(new Map([[1, false]]))).toBe('scanned');
    expect(
      summarizeTextStatus(
        new Map([
          [1, true],
          [2, false],
        ]),
      ),
    ).toBe('partial');
  });
});

describe('loopback http and PDF-looking addresses', () => {
  it('accepts plain http only for localhost and 127.0.0.1', () => {
    expect(parseSrc('http://127.0.0.1:8080/a.pdf')).toMatchObject({
      ok: true,
      origin: 'http://127.0.0.1:8080',
      pattern: 'http://127.0.0.1:8080/*',
      host: '127.0.0.1',
    });
    expect(parseSrc('http://localhost:3000/doc')).toMatchObject({ ok: true, host: 'localhost' });
    for (const raw of ['http://example.org/a.pdf', 'http://[::1]/a.pdf', 'http://10.0.0.5/a.pdf']) {
      expect(parseSrc(raw)).toMatchObject({ ok: false });
    }
  });

  it('isLikelyPdfUrl reads the text only', () => {
    const yes = [
      'https://example.org/papers/a.PDF',
      'https://example.org/a.pdf?download=1',
      'http://127.0.0.1:9/x.pdf#page=3',
      'https://arxiv.org/pdf/2101.00001',
      'https://arxiv.org/pdf/2101.00001v2',
      'https://example.org/viewer?file=/docs/a.pdf',
      'https://example.org/get?pdf=render',
      'https://example.org/get?format=pdf',
    ];
    const no = [
      'https://example.org/',
      'https://example.org/pdf/converter',
      'https://example.org/a.pdf.html',
      'https://example.org/?q=pdf+reader',
      'ftp://example.org/a.pdf',
      'file:///C:/a.pdf',
      'chrome://pdf-viewer',
      'not a url',
      '',
    ];
    for (const u of yes) expect(isLikelyPdfUrl(u), u).toBe(true);
    for (const u of no) expect(isLikelyPdfUrl(u), u).toBe(false);
    expect(isLikelyPdfUrl(null)).toBe(false);
    expect(isLikelyPdfUrl(undefined)).toBe(false);
  });
});

describe('fetchPdf failure messages', () => {
  it('says "offline" when the device is offline, not "CORS"', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    try {
      const r = await fetchPdf('https://example.org/a.pdf', {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      });
      expect(r).toMatchObject({ ok: false, failure: { kind: 'offline' } });
      expect(r.ok === false && r.failure.message).toContain('offline');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a web page served at a .pdf address is named as a web page', async () => {
    const r = await fetchPdf('https://example.org/report.pdf', {
      fetchImpl: respond('<html>Please sign in</html>', { type: 'text/html; charset=utf-8' }),
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'not-pdf' } });
    expect(r.ok === false && r.failure.message).toContain('web page (text/html)');
  });

  it('an extension-less address that answers application/pdf opens', async () => {
    const r = await fetchPdf('https://example.org/download/42', { fetchImpl: respond(PDF) });
    expect(r.ok).toBe(true);
  });
});

describe('fetchPdf: where a redirect may end', () => {
  const ASKED = 'https://example.org/download?id=7';

  /** A PDF answer whose body reports being cancelled, so "never read" can be asserted. */
  function observed(init: { url: string; type?: string; status?: number }) {
    const seen = { cancelled: false };
    const fetchImpl: typeof fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(PDF);
          c.close();
        },
        cancel() {
          seen.cancelled = true;
        },
      });
      const headers = new Headers({ 'content-type': init.type ?? 'application/pdf' });
      const res = new Response(body, { status: init.status ?? 200, headers });
      Object.defineProperty(res, 'url', { value: init.url });
      Object.defineProperty(res, 'redirected', { value: true });
      return res;
    };
    return { fetchImpl, seen };
  }

  it('the origin that was asked for needs no one to be asked', async () => {
    const isOriginGranted = vi.fn(async () => false);
    const r = await fetchPdf(ASKED, {
      fetchImpl: respond(PDF, { url: 'https://example.org/files/a.pdf', redirected: true }),
      isOriginGranted,
    });
    expect(r.ok).toBe(true);
    expect(isOriginGranted).not.toHaveBeenCalled();
  });

  it('another origin must be granted: otherwise it is named, its body is cancelled and not read', async () => {
    const { fetchImpl, seen } = observed({ url: 'https://cdn.example.net/blob?sig=1' });
    const onProgress = vi.fn();
    const r = await fetchPdf(ASKED, {
      fetchImpl,
      onProgress,
      isOriginGranted: async () => false,
    });
    expect(r).toMatchObject({
      ok: false,
      failure: {
        kind: 'redirect-needs-access',
        redirectTo: { host: 'cdn.example.net', pattern: 'https://cdn.example.net/*' },
      },
    });
    expect(r.ok === false && r.failure.message).toContain('cdn.example.net');
    expect(seen.cancelled).toBe(true);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('a granted destination is read, and is asked about by its exact origin pattern', async () => {
    const asked: string[] = [];
    const r = await fetchPdf(ASKED, {
      fetchImpl: respond(PDF, { url: 'https://cdn.example.net:8443/blob', redirected: true }),
      isOriginGranted: async (pattern) => {
        asked.push(pattern);
        return true;
      },
    });
    expect(r.ok).toBe(true);
    expect(asked).toEqual(['https://cdn.example.net:8443/*']);
  });

  it('with no way to ask, only the origin that was asked for passes', async () => {
    const r = await fetchPdf(ASKED, {
      fetchImpl: respond(PDF, { url: 'https://cdn.example.net/blob', redirected: true }),
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'redirect-needs-access' } });
  });

  it('a permission check that fails counts as "not granted"', async () => {
    const r = await fetchPdf(ASKED, {
      fetchImpl: respond(PDF, { url: 'https://cdn.example.net/blob', redirected: true }),
      isOriginGranted: async () => {
        throw new Error('permissions unavailable');
      },
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'redirect-needs-access' } });
  });

  it.each([
    'http://192.168.0.1/a.pdf',
    'http://example.org/a.pdf',
    'file:///C:/a.pdf',
    'data:application/pdf;base64,JVBERi0=',
    'blob:https://example.org/0b0e2f9a',
    'javascript:alert(1)',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.pdf',
    'https://user:pw@cdn.example.net/a.pdf',
  ])('an address the reader would never open is refused even when "granted": %s', async (end) => {
    const isOriginGranted = vi.fn(async () => true);
    const r = await fetchPdf(ASKED, {
      fetchImpl: respond(PDF, { url: end, redirected: true }),
      isOriginGranted,
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'redirect-blocked' } });
    expect(r.ok === false && r.failure.message).toContain('will not download from');
    expect(isOriginGranted).not.toHaveBeenCalled();
  });

  it('plain http is accepted for localhost only, and is its own origin', async () => {
    const asked: string[] = [];
    const r = await fetchPdf(ASKED, {
      fetchImpl: respond(PDF, { url: 'http://127.0.0.1:9000/a.pdf', redirected: true }),
      isOriginGranted: async (pattern) => {
        asked.push(pattern);
        return false;
      },
    });
    expect(r).toMatchObject({
      ok: false,
      failure: { kind: 'redirect-needs-access', redirectTo: { host: '127.0.0.1' } },
    });
    expect(asked).toEqual(['http://127.0.0.1:9000/*']);
  });

  it('reports what the destination answered with, without needing it to be granted', async () => {
    const signIn = await fetchPdf(ASKED, {
      fetchImpl: respond('no', {
        status: 401,
        type: 'text/html',
        url: 'https://login.example.net/sso',
        redirected: true,
      }),
    });
    expect(signIn).toMatchObject({ ok: false, failure: { kind: 'sign-in', status: 401 } });
    const page = await fetchPdf(ASKED, {
      fetchImpl: respond('<html/>', {
        type: 'text/html',
        url: 'https://login.example.net/sso',
        redirected: true,
      }),
    });
    expect(page).toMatchObject({ ok: false, failure: { kind: 'redirected-non-pdf' } });
  });

  it('a long signed final address is held to the same rules, not to the 2,048-character bound', async () => {
    const end = `https://cdn.example.net/blob?sig=${'a'.repeat(3000)}`;
    const r = await fetchPdf(ASKED, {
      fetchImpl: respond(PDF, { url: end, redirected: true }),
      isOriginGranted: async (pattern) => pattern === 'https://cdn.example.net/*',
    });
    expect(r.ok).toBe(true);
  });

  it('still sends no cookies and no referrer, and still follows redirects (hops are not visible)', async () => {
    let seen: RequestInit | undefined;
    await fetchPdf(ASKED, {
      fetchImpl: async (_u, init) => {
        seen = init;
        return respond(PDF)('x');
      },
    });
    expect(seen).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
    });
  });
});
