import { defineWxtModule } from 'wxt/modules';

/**
 * React is aliased to Preact for the content script only (docs/adr/012). A string alias also covers
 * every subpath, so this maps react/jsx-runtime, react/jsx-dev-runtime, react-dom/client and
 * react-dom/test-utils to their preact/compat counterparts. vitest.config.ts reads the same table,
 * so the overlay's tests run against the runtime that ships.
 */
export const PREACT_ALIAS: Readonly<Record<string, string>> = {
  react: 'preact/compat',
  'react-dom': 'preact/compat',
};

/** WXT names a content script after its folder without the `.content` suffix. */
const CONTENT_SCRIPT = 'highlighter';

/**
 * WXT builds each content script on its own (an IIFE), apart from the HTML pages, and calls this
 * hook with the build's entrypoints and the merged Vite config. The alias is added only when that
 * build is the highlighter, so the pdf.js reader, dashboard, popup, side panel and options pages
 * keep React. WXT auto-loads every modules/*.ts.
 */
export default defineWxtModule((wxt) => {
  wxt.hooks.hook('vite:build:extendConfig', (entrypoints, config) => {
    const isContentScript = entrypoints.some(
      (e) => e.type === 'content-script' && e.name === CONTENT_SCRIPT,
    );
    if (!isContentScript) return;

    const current = config.resolve?.alias ?? [];
    const existing = Array.isArray(current)
      ? current
      : Object.entries(current).map(([find, replacement]) => ({ find, replacement }));
    const preact = Object.entries(PREACT_ALIAS).map(([find, replacement]) => ({
      find,
      replacement,
    }));
    config.resolve = { ...config.resolve, alias: [...preact, ...existing] };
  });
});
