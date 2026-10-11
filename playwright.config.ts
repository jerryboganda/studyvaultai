import { defineConfig } from '@playwright/test';

// Extensions need a persistent context, so the harness (tests/e2e/fixtures.ts) launches Chromium
// itself. Run via `pnpm test:e2e`, which builds the extension first.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  // One retry absorbs runner hiccups, but a test that needs it is reported and FAILS the run:
  // a flaky pass must never be mistaken for a green suite.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
