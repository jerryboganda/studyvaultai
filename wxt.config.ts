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
      // Chrome allows at most four suggested keys; previous-highlight is user-assignable.
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
    },
    // Defence in depth. Core features make no network request at all. The OPTIONAL AI and sync
    // features talk to an endpoint the USER configures, which cannot be listed statically, so https:
    // (and loopback, for local models) is allowed here; each such call additionally needs the feature
    // flag, an explicit consent token / sign-in, and a per-origin host permission. See docs/adr/009.
    // 'wasm-unsafe-eval' permits compiling WebAssembly ONLY (the OCR engine and PDF decoders need it);
    // it does not allow eval()/new Function(), which stay blocked. See docs/adr/008.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-src 'none'; form-action 'none'",
    },
  },
  hooks: {
    // registration:'runtime' makes WXT copy content-script `matches` into host_permissions.
    // We register scripts ourselves from optional permissions, so install-time hosts must stay empty.
    'build:manifestGenerated': (_wxt, manifest) => {
      delete manifest.host_permissions;
      // e2e variant only: the native chrome.permissions.request prompt cannot be driven by
      // Playwright, so the test build is granted loopback origins up front. Never shipped.
      if (E2E) manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
    },
  },
  zip: { name: 'studyvault-ai' },
});
