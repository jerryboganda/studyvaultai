import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const HTML_DIR = path.resolve('tests/fixtures/html');

export interface FixtureServer {
  /** http://127.0.0.1:PORT */
  origin: string;
  /** http://localhost:PORT - same server, different origin (cross-origin iframe tests). */
  altOrigin: string;
  /** Switch the text served by /mutable.html (source-changed scenarios). */
  setVariant(variant: 'original' | 'edited' | 'removed' | 'prefixed'): void;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Deterministic large academic-style article (multi-column, footnotes) for performance runs. */
function largeArticle(paragraphs: number): string {
  const body: string[] = [];
  for (let i = 0; i < paragraphs; i++) {
    body.push(
      `<p id="p${i}">Paragraph ${i}. Section ${Math.floor(i / 10)} discusses the physiology of ` +
        `compartment ${i % 17} with reference to equation ${i % 9} and the unique marker ` +
        `<strong>token-${i}</strong> used for locating this passage. ` +
        `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ` +
        `incididunt ut labore et dolore magna aliqua.<sup>${i % 30}</sup></p>`,
    );
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Large article</title>
<style>article{column-count:2;column-gap:2rem;max-width:1100px;margin:0 auto;font:16px/1.5 serif}</style></head>
<body><article><h1>Large article</h1>${body.join('\n')}</article></body></html>`;
}

function mutable(variant: string): string {
  const target =
    'Calcium channels open when the membrane depolarises beyond the threshold potential.';
  const other = 'An unrelated filler paragraph keeps the page long enough to scroll.';
  let first = `<p id="target">${target} This sentence follows the target.</p>`;
  let before = '';
  if (variant === 'edited') {
    first = `<p id="target">${target.replace('depolarises', 'repolarises')} This sentence follows the target.</p>`;
  } else if (variant === 'removed') {
    first = '<p id="target">The paragraph that used to be here was removed by the publisher.</p>';
  } else if (variant === 'prefixed') {
    before =
      '<p>A newly inserted advertisement block shifts every character offset on the page.</p>'.repeat(
        3,
      );
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mutable page</title></head>
<body><main><h1>Mutable page</h1>${before}${first}<p>${other}</p></main></body></html>`;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  let variant = 'original';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local');
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/mutable.html')
      return send(200, CONTENT_TYPES['.html']!, mutable(variant));
    if (url.pathname === '/large.html') {
      const n = Number(url.searchParams.get('paragraphs') ?? '1500');
      return send(200, CONTENT_TYPES['.html']!, largeArticle(Math.min(Math.max(n, 1), 20000)));
    }
    if (url.pathname.startsWith('/spa/')) {
      const file = path.join(HTML_DIR, 'spa.html');
      return send(200, CONTENT_TYPES['.html']!, fs.readFileSync(file, 'utf8'));
    }
    const name = path.basename(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.join(HTML_DIR, name);
    if (!file.startsWith(HTML_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(404, 'text/plain; charset=utf-8', `Not found: ${escapeHtml(url.pathname)}`);
    }
    const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
    return send(200, type, fs.readFileSync(file, 'utf8'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    altOrigin: `http://localhost:${port}`,
    setVariant: (v) => {
      variant = v;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
