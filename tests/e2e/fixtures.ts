import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer, type FixtureServer } from './server';

/** Production build: asserted for least-privilege manifest shape. */
const OUT_DIR = process.env.SV_OUT_DIR ?? '.output';
export const PROD_EXTENSION_PATH = path.resolve(OUT_DIR, 'chrome-mv3');
/** `pnpm build:e2e` (SV_E2E=1): identical code, plus loopback host permissions (see wxt.config.ts). */
export const E2E_EXTENSION_PATH = path.resolve(OUT_DIR, 'chrome-mv3-e2e');

type Fixtures = {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
};

type WorkerFixtures = {
  fixtureServer: FixtureServer;
};

/**
 * Real Chromium with the built extension loaded unpacked (not mocked APIs).
 * Branded Google Chrome 137+ ignores --load-extension, so Playwright's bundled Chromium is used;
 * `channel: 'chromium'` selects the new headless mode, which supports extensions.
 */
function makeTest(extensionPath: string) {
  return base.extend<Fixtures, WorkerFixtures>({
    fixtureServer: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const server = await startFixtureServer();
        await use(server);
        await server.close();
      },
      { scope: 'worker' },
    ],
    // Playwright requires an object-destructuring first argument, even when empty.
    // eslint-disable-next-line no-empty-pattern
    context: async ({}, use) => {
      if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
        throw new Error(
          `Extension not built at ${extensionPath}. Run \`pnpm test:e2e\` or build first.`,
        );
      }
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyvault-e2e-'));
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      });
      await use(context);
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
    serviceWorker: async ({ context }, use) => {
      const existing = context.serviceWorkers()[0];
      await use(existing ?? (await context.waitForEvent('serviceworker')));
    },
    extensionId: async ({ serviceWorker }, use) => {
      await use(new URL(serviceWorker.url()).host);
    },
  });
}

export const test = makeTest(E2E_EXTENSION_PATH);
export const prodTest = makeTest(PROD_EXTENSION_PATH);
export const expect = test.expect;
