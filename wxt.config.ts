import { defineConfig } from 'wxt';

// Module boundaries from ARCHITECTURE.md are kept as aliased directories (ADR-001).
const alias = {
  '@shared': 'packages/shared/src',
  '@runtime': 'packages/runtime/src',
  '@storage': 'packages/storage/src',
  '@highlights': 'packages/highlights/src',
  '@ui': 'packages/ui/src',
  '@search': 'packages/search/src',
  '@study': 'packages/study/src',
  '@ai': 'packages/ai/src',
  '@pdf': 'packages/pdf/src',
  '@ocr': 'packages/ocr/src',
  '@sync': 'packages/sync/src',
  '@backup': 'packages/backup/src',
};

// The e2e variant (scripts/build-e2e.mjs sets SV_E2E=1) is the SAME production build plus loopback host
// permissions and an open overlay shadow root. It is an env flag, not `--mode e2e`: WXT maps a custom
// mode onto NODE_ENV, which would silently bundle React's DEV build into the tested extension.
const E2E = process.env.SV_E2E === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Parallel agents build into their own folder (SV_OUT_DIR=.output-<name>) so bundles never clobber.
  outDir: process.env.SV_OUT_DIR ?? '.output',
  ...(E2E ? { outDirTemplate: '{{browser}}-mv{{manifestVersion}}-e2e' } : {}),
  imports: false, // explicit imports only; keeps ESLint/TS honest and content-script bundles small
  alias,
  vite: () => ({ define: { __SV_E2E__: JSON.stringify(E2E) } }),
  manifest: {
    name: 'StudyVault AI',
    description:
      'Local-first study companion: highlight any page, save cited quotes into knowledge banks, review later.',
    minimum_chrome_version: '120',
    // Least privilege (ADR-003): no install-time host access. Sites are enabled per tab via
    // activeTab, or persistently via optional host permissions the user grants explicitly.
    permissions: ['storage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // Optional sync only (docs/adr/009). Both are requested at runtime, from the click that turns
    // sync on, and are never granted at install: "identity" opens the sign-in window
    // (chrome.identity.launchWebAuthFlow), "alarms" lets the worker sync on a timer.
    optional_permissions: ['identity', 'alarms'],
    action: { default_title: 'StudyVault AI' },
    commands: {
      'open-side-panel': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Open the StudyVault side panel',
      },
      'quick-save': {
        suggested_key: { default: 'Alt+Shift+H' },
        description: 'Quick-save the current selection',
      },
      // Chrome allows at most four suggested keys; previous-highlight and focus-search are
      // user-assignable only (no `suggested_key`), so a fifth or sixth suggestion is not made.
      // [ and ] are not valid manifest keys, so the in-page Alt+Shift+] / [ stay as extra routes.
      'focus-toolbar': {
        suggested_key: { default: 'Alt+Shift+Y' },
        description: 'Move keyboard focus into the selection toolbar',
      },
      'next-highlight': {
        suggested_key: { default: 'Alt+Shift+Period' },
        description: 'Go to the next highlight on the page',
      },
      'previous-highlight': {
        description: 'Go to the previous highlight on the page',
      },
      'focus-search': {
        description: 'Search your highlights: open the side panel on the search box',
      },
    },
    // Defence in depth. Local features (capture, banks, search, review, backup, OCR) make no network
    // request. Three user-initiated paths do, and their endpoints are chosen by the USER so they cannot
    // be listed statically: the optional AI call, the optional sync, and opening a PDF from a web
    // address. So connect-src allows https: (and loopback, for local models and dev); each call
    // additionally needs a user action, a feature flag / consent token and a per-origin host permission.
    // See docs/adr/009. Everything else is fixed to the extension itself:
    //  - 'wasm-unsafe-eval' permits compiling WebAssembly ONLY (OCR engine, PDF decoders); eval() and
    //    new Function() stay blocked (docs/adr/008). Nothing here allows inline script.
    //  - style-src 'self' has no 'unsafe-inline': React/pdf.js assign styles through the CSSOM, which
    //    CSP allows; only <style> tags and style="" markup are refused.
    //  - img-src data: is for the PDF reader's wavy-underline mask (an inline SVG in reader.css).
    //  - worker-src 'self': the pdf.js and tesseract workers are extension files (tesseract is started
    //    with workerBlobURL:false). Chromium still lets extension code start a blob: Worker under
    //    'self'; that is no gain for injected script, which script-src already stops (docs/adr/009).
    content_security_policy: {
      extension_pages:
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; worker-src 'self'; media-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'",
    },
  },
  hooks: {
    // registration:'runtime' makes WXT copy content-script `matches` into host_permissions.
    // We register scripts ourselves from optional permissions, so install-time hosts must stay empty.
    'build:manifestGenerated': (wxt, manifest) => {
      delete manifest.host_permissions;
      // e2e variant only: the native chrome.permissions.request prompt cannot be driven by
      // Playwright, so the test build is granted loopback origins up front. Never shipped.
      if (E2E) manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
      // `wxt` dev server only (never a build): Vite injects <style> tags and serves workers and
      // assets from http://localhost:PORT, which the strict fetch directives would refuse. Dev
      // keeps only the script/connect/frame rules, as before the hardening. scripts/check-build.mjs
      // pins the built policy, so this cannot reach a build.
      const csp = manifest.content_security_policy;
      if (wxt.config.command === 'serve' && typeof csp === 'object' && csp.extension_pages) {
        const strictOnly = ['default-src', 'style-src', 'img-src', 'font-src', 'worker-src'];
        csp.extension_pages = csp.extension_pages
          .split(';')
          .map((d) => d.trim())
          .filter((d) => d && !strictOnly.includes(d.split(/\s+/)[0] ?? ''))
          .join('; ');
      }
    },
  },
  zip: { name: 'studyvault-ai' },
});
