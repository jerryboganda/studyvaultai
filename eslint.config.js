import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Layering from ARCHITECTURE.md: pure packages must not reach into Chrome, React or storage.
const pureDomain = {
  patterns: [
    { group: ['wxt', 'wxt/*'], message: 'Pure packages must not depend on WXT/Chrome APIs.' },
    { group: ['react', 'react-dom', 'react/*'], message: 'Pure packages must not import React.' },
    {
      group: ['dexie', '@storage', '@storage/*'],
      message: 'Pure packages must not import storage.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '.output*/**',
      '.wxt/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'public/ocr/**', // generated at build time by modules/ocr-assets.ts
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='eval']", message: 'eval is forbidden (MV3 CSP).' },
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'new Function is forbidden (MV3 CSP).',
        },
      ],
    },
  },
  {
    // Plain Node build/CI scripts.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', URL: 'readonly', console: 'readonly' } },
  },
  {
    // Playwright fixtures name their callback `use`, which the hooks rule mistakes for a React hook.
    files: ['tests/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
  {
    files: [
      'packages/shared/**',
      'packages/highlights/**',
      'packages/search/**',
      'packages/study/**',
      'packages/ai/**',
      'packages/pdf/**',
      'packages/ocr/**',
      'packages/sync/**',
      'packages/backup/**',
    ],
    rules: { 'no-restricted-imports': ['error', pureDomain] },
  },
  {
    // Content scripts run in untrusted page context: no direct database access.
    files: ['entrypoints/highlighter.content/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['dexie', '@storage', '@storage/*'], message: 'Use the message protocol.' },
          ],
        },
      ],
    },
  },
);
