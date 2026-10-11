import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { PREACT_ALIAS } from './modules/content-script-preact.ts';

/**
 * The content script ships with Preact (docs/adr/012), so its tests must run the same runtime. Only
 * imports made from inside entrypoints/highlighter.content are redirected; every other suite keeps
 * React. The build applies the same table to that entrypoint's bundle (modules/content-script-preact.ts).
 */
const contentScriptPreact: Plugin = {
  name: 'sv:content-script-preact',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !/[\\/]entrypoints[\\/]highlighter\.content[\\/]/.test(importer)) return null;
    for (const [from, to] of Object.entries(PREACT_ALIAS)) {
      if (source === from || source.startsWith(`${from}/`)) {
        return this.resolve(to + source.slice(from.length), importer, {
          ...options,
          skipSelf: true,
        });
      }
    }
    return null;
  },
};

export default defineConfig({
  plugins: [WxtVitest(), contentScriptPreact],
  test: {
    environment: 'jsdom',
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'entrypoints/**/*.test.ts',
      'entrypoints/**/*.test.tsx',
      'server/**/*.test.ts',
      // Real public-domain PDFs through the reader's loader (tests/fixtures/pdf/real/SOURCES.md).
      'tests/fixtures/pdf/real/**/*.test.ts',
    ],
    restoreMocks: true,
    // Several suites build 5k-10k row fixtures; a loaded CI runner must not turn that into a flake.
    testTimeout: 30_000,
  },
});
