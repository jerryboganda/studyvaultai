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
 * HARNESS WORKAROUND (remove when the product stops doing this; see the e2e agent report).
 *
 * The e2e build holds loopback host permissions up front (wxt.config.ts), and `site.sync()` treats
 * every granted origin as an always-on site: on install it registers the persistent content script
 * `sv-persistent` for http://127.0.0.1/* and http://localhost/*, so EVERY fixture page gets the
 * overlay without being activated. A shipped build has no install-time hosts, so there a tab is
 * "not running" until the user activates it, which is what most popup / side panel / permission
 * specs are about. The registration is dropped once, right after the worker's install-time sync has
 * made it; nothing in the product re-registers unless a test calls `site.sync` (or edits the deny
 * list / grants), which is the behaviour those tests want to exercise.
 */
async function dropInstallTimeRegistration(worker: Worker): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const dropped = await worker
      .evaluate(async () => {
        // The shipped build has no install-time hosts: nothing is registered, nothing to wait for.
        if (!chrome.runtime.getManifest().host_permissions?.length) return true;
        const found = await chrome.scripting.getRegisteredContentScripts({
          ids: ['sv-persistent'],
        });
        if (found.length === 0) return false;
        await chrome.scripting.unregisterContentScripts({ ids: ['sv-persistent'] });
        return true;
      })
      .catch(() => false);
    if (dropped || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
      const worker = existing ?? (await context.waitForEvent('serviceworker'));
      await dropInstallTimeRegistration(worker);
      await use(worker);
    },
    extensionId: async ({ serviceWorker }, use) => {
      await use(new URL(serviceWorker.url()).host);
    },
  });
}

export const test = makeTest(E2E_EXTENSION_PATH);
export const prodTest = makeTest(PROD_EXTENSION_PATH);
export const expect = test.expect;
