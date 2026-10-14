import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import wxtConfig from '../wxt.config.ts';

// Dev-only screen gallery (never part of the extension build): serves the real extension pages on
// localhost against a fake `chrome` and an in-memory database, plus the redesign mockups.
const repo = fileURLToPath(new URL('..', import.meta.url));
const at = (dir: string) => fileURLToPath(new URL(`../${dir}`, import.meta.url));

// The fake runtime.getManifest() answers with the real manifest fields (wxt.config.ts) and the
// package version, as WXT writes them; host_permissions is deleted at build time there too.
const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8')) as { version: string };
const manifest = {
  ...(wxtConfig.manifest as Record<string, unknown>),
  version: pkg.version,
  host_permissions: [],
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    // Same module boundaries as wxt.config.ts (ADR-001).
    alias: {
      '@shared': at('packages/shared/src'),
      '@runtime': at('packages/runtime/src'),
      '@storage': at('packages/storage/src'),
      '@highlights': at('packages/highlights/src'),
      '@ui': at('packages/ui/src'),
      '@search': at('packages/search/src'),
      '@study': at('packages/study/src'),
      '@ai': at('packages/ai/src'),
      '@pdf': at('packages/pdf/src'),
      '@ocr': at('packages/ocr/src'),
      '@sync': at('packages/sync/src'),
      '@backup': at('packages/backup/src'),
      // The only wxt module the pages reach at runtime; the fake installs itself on first import.
      'wxt/browser': at('gallery/shim/chrome.ts'),
    },
  },
  define: { __SV_E2E__: 'false', __SV_GALLERY_MANIFEST__: JSON.stringify(manifest) },
  oxc: { jsx: { runtime: 'automatic' } },
  server: { port: 5199, strictPort: true, fs: { allow: [repo] } },
});
