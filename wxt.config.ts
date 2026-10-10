import { defineConfig } from 'wxt';

// Module boundaries from ARCHITECTURE.md are kept as aliased directories (ADR-001).
const alias = {
  '@shared': 'packages/shared/src',
  '@runtime': 'packages/runtime/src',
  '@storage': 'packages/storage/src',
  '@highlights': 'packages/highlights/src',
  '@ui': 'packages/ui/src',
};

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false, // explicit imports only; keeps ESLint/TS honest and content-script bundles small
  alias,
  manifest: {
    name: 'StudyVault AI',
    description:
      'Local-first study companion: highlight any page, save cited quotes into knowledge banks, review later.',
    minimum_chrome_version: '120',
    // Least privilege (ADR-003): no install-time host access. Sites are enabled per tab via
    // activeTab, or persistently via optional host permissions the user grants explicitly.
    permissions: ['storage', 'sidePanel', 'contextMenus', 'activeTab', 'scripting'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
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
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; base-uri 'self'",
    },
  },
  hooks: {
    // registration:'runtime' makes WXT copy content-script `matches` into host_permissions.
    // We register scripts ourselves from optional permissions, so install-time hosts must stay empty.
    'build:manifestGenerated': (wxt, manifest) => {
      delete manifest.host_permissions;
      // `wxt build --mode e2e` only: the native chrome.permissions.request prompt cannot be driven
      // by Playwright, so the test build is granted loopback origins up front. Never shipped.
      if (wxt.config.mode === 'e2e') {
        manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
      }
    },
  },
  zip: { name: 'studyvault-ai' },
});
