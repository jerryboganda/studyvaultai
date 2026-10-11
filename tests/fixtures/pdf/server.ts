import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A throwaway HTTP server for the reader's web-open flow. Every answer is declared by the test, and
 * every request is recorded (headers included) so a test can prove what the reader did NOT send.
 * Loopback only: the e2e build holds loopback host permissions, so no native prompt is involved.
 */

export interface PdfRoute {
  status?: number;
  /** Content-Type; null sends none. Default application/pdf. */
  type?: string | null;
  body?: Uint8Array | string;
  /** Extra response headers (e.g. Location for a redirect). */
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

export interface PdfServer {
  /** http://127.0.0.1:PORT */
  origin: string;
  requests: RecordedRequest[];
  /** Add or replace an answer while the server runs. */
  route(path: string, answer: PdfRoute): void;
  close(): Promise<void>;
}

export async function startPdfServer(routes: Record<string, PdfRoute> = {}): Promise<PdfServer> {
  const table = new Map(Object.entries(routes));
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://pdf.local').pathname;
    requests.push({ method: req.method ?? 'GET', path, headers: req.headers });
    const answer = table.get(path);
    if (!answer) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const headers: Record<string, string> = { 'cache-control': 'no-store', ...answer.headers };
    const type = answer.type === undefined ? 'application/pdf' : answer.type;
    if (type !== null) headers['content-type'] = type;
    res.writeHead(answer.status ?? 200, headers);
    res.end(answer.body === undefined ? undefined : Buffer.from(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    route: (path, answer) => void table.set(path, answer),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
