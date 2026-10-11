import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { DEFAULT_PALETTE, INBOX_BANK_ID } from '@shared';
import { bgData, errorsOf, expect, openExt, test as pagesTest, type Env } from './helpers.pages';
import { launchSession, newUserDataDir, removeDir } from './helpers.lifecycle';
import { startFakeOidc, startSyncHarness, type FakeOidc, type SyncHarness } from './syncServer';

export { errorsOf, expect, openExt };
export type { Env, FakeOidc, SyncHarness };

/**
 * Helpers for sync.spec.ts: the optional sync feature in a real loaded extension, against the
 * repository's reference server and a stand-in OpenID Connect provider (./syncServer.ts).
 *
 * Everything is driven the way a person does it: the settings page controls, Chrome's real
 * `chrome.permissions.request` (the optional `identity` and `alarms` permissions are granted without a
 * prompt, the loopback hosts are in the e2e manifest) and Chrome's real
 * `chrome.identity.launchWebAuthFlow`. Direct IndexedDB access is READ-ONLY; highlights are made
 * through the worker's own `capture.save` / `highlight.update` RPCs, the same calls the content
 * script and the side panel send.
 */

export const test = pagesTest.extend<{ idp: FakeOidc; sync: SyncHarness }>({
  // Playwright requires an object-destructuring first argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  idp: async ({}, use) => {
    const idp = await startFakeOidc();
    await use(idp);
    await idp.close();
  },
  sync: async ({ idp, env }, use) => {
    const harness = await startSyncHarness({
      idp,
      extensionOrigin: `chrome-extension://${env.extensionId}`,
    });
    await use(harness);
    await harness.close();
  },
});

/** The pending line when something waits ("nothing waiting to upload" must not match). */
export const WAITING = /^[0-9]+ changes? waiting to upload$/;

export const PASSPHRASE = 'violet harbour 7 paper lanterns';
export const OTHER_PASSPHRASE = 'amber orchard 4 quiet engines';

export const syncConfigOf = (sync: SyncHarness, idp: FakeOidc) => ({
  serverUrl: sync.base,
  issuer: idp.issuer,
  clientId: idp.clientId,
});

/** console.error output of the extension's service worker from now on (do not use across a stop). */
export function workerErrors(env: Env): string[] {
  const errors: string[] = [];
  env.serviceWorker.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

// ---------------------------------------------------------------------------------------------
// A second browser profile (its own user data directory) with the same extension
// ---------------------------------------------------------------------------------------------

export interface Profile {
  env: Env;
  userDataDir: string;
  /** Close the browser, keep the profile directory (a browser restart). */
  closeBrowser(): Promise<void>;
  /** Close the browser and remove the profile directory. */
  dispose(): Promise<void>;
}

/**
 * Launch another Chromium with the e2e extension loaded, in a new profile directory or in
 * `userDataDir` (a restart of that profile). An unpacked extension's id comes from its path, so it
 * is the same id as the fixture's, which the server's CORS allow-list relies on.
 */
export async function launchProfile(base: Env, userDataDir?: string): Promise<Profile> {
  const dir = userDataDir ?? newUserDataDir();
  const session = await launchSession(dir);
  const closeBrowser = async () => {
    await session.context.close().catch(() => undefined);
  };
  if (session.extensionId !== base.extensionId) {
    await closeBrowser();
    throw new Error(
      `the second profile got extension id ${session.extensionId}, not ${base.extensionId}`,
    );
  }
  const worker = session.context.serviceWorkers()[0];
  if (!worker) throw new Error('the second profile has no service worker');
  return {
    env: { ...base, context: session.context, serviceWorker: worker },
    userDataDir: dir,
    closeBrowser,
    async dispose() {
      await closeBrowser();
      removeDir(dir);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The sync settings section
// ---------------------------------------------------------------------------------------------

export const syncSection = (page: Page): Locator => page.getByTestId('sync-section');
export const syncStatusOf = (page: Page): Locator => syncSection(page).getByTestId('sync-status');
export const encryptionModeOf = (page: Page): Locator => syncSection(page).getByTestId('e2ee-mode');

/** The settings page, loaded far enough that the sync section is showing something. */
export async function openSyncSettings(env: Env): Promise<Page> {
  const page = await openExt(env, 'options');
  await expect(
    syncSection(page).getByRole('heading', { name: 'Sync between devices (optional)' }),
  ).toBeVisible();
  await expect(syncSection(page).getByText('Loading…')).toHaveCount(0);
  return page;
}

/** Fill the form, confirm the acknowledgement and press "Turn on sync…": Chrome's real prompt path. */
export async function turnOnSync(
  page: Page,
  config: { serverUrl: string; issuer: string; clientId: string },
): Promise<void> {
  const s = syncSection(page);
  await s.getByTestId('sync-server-url').fill(config.serverUrl);
  await s.getByTestId('sync-issuer').fill(config.issuer);
  await s.getByTestId('sync-client-id').fill(config.clientId);
  await s.getByTestId('sync-ack').check();
  await s.getByTestId('sync-enable').click();
  await expect(s.getByTestId('sync-connected')).toBeVisible();
}

/** "Sign in": the worker opens Chrome's real web-auth-flow window against the stand-in provider. */
export async function signIn(page: Page, subject: string): Promise<void> {
  const s = syncSection(page);
  await s.getByTestId('sync-sign-in').click();
  // Either the account line, or the page's own explanation of why sign-in did not complete.
  await expect
    .poll(
      async () => {
        const account = (await s.getByTestId('sync-account').textContent()) ?? '';
        if (account.includes(`Signed in as ${subject}`)) return 'signed in';
        const failed = s.getByText('Sign-in did not complete');
        if ((await failed.count()) > 0) {
          return `refused: ${await failed.locator('xpath=..').innerText()}`;
        }
        return 'waiting';
      },
      { message: 'sign-in should complete' },
    )
    .toBe('signed in');
}

/** Choose a passphrase in the encryption card (the first upload, or a device joining). */
export async function turnOnEncryption(page: Page, passphrase: string): Promise<void> {
  const s = syncSection(page);
  await s.getByTestId('e2ee-passphrase').fill(passphrase);
  await s.getByTestId('e2ee-confirm').fill(passphrase);
  await s.getByTestId('e2ee-lost-ack').check();
  await s.getByTestId('e2ee-setup').click();
  await expect(s.getByTestId('e2ee-message')).toContainText('End-to-end encryption is on');
}

export async function syncNow(page: Page): Promise<void> {
  await syncSection(page).getByTestId('sync-now').click();
}

// ---------------------------------------------------------------------------------------------
// Data: through the worker's RPCs, read back from IndexedDB (read-only)
// ---------------------------------------------------------------------------------------------

/** `capture.save` from an extension page; returns the new highlight's id. */
export async function saveQuote(
  page: Page,
  o: { url: string; title: string; quote: string; at?: number },
): Promise<string> {
  const at = o.at ?? 0;
  const result = await bgData<{ highlight: { id: string } }>(page, 'capture.save', {
    page: { url: o.url, canonicalUrl: null, title: o.title },
    exactQuote: o.quote,
    anchorSet: {
      type: 'html',
      textAlgorithm: 'sv-text-v1',
      textQuote: { exact: o.quote, prefix: '', suffix: '' },
      textPosition: { start: at, end: at + o.quote.length },
      structuralPath: null,
      contentSignature: 'e2e-sync',
      documentTextLength: 100_000,
    },
    headingContext: null,
    kind: 'essential',
    color: DEFAULT_PALETTE.essential,
    bankId: INBOX_BANK_ID,
    userComment: '',
    priority: 3,
    captureMethod: 'toolbar',
  });
  return result.highlight.id;
}

/** `highlight.update` from an extension page: the side panel's comment box, as an RPC. */
export async function setComment(page: Page, id: string, userComment: string): Promise<void> {
  await bgData(page, 'highlight.update', { id, patch: { userComment } });
}

/** Rows of one table of the vault database (read-only; never creates or upgrades it). */
export async function readTable<T = Record<string, unknown>>(
  page: Page,
  store: string,
): Promise<T[]> {
  return page.evaluate(async (name) => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (!Array.from(db.objectStoreNames).includes(name)) return [];
      return await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(name, 'readonly').objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, store) as Promise<T[]>;
}

export interface HighlightRow {
  id: string;
  exactQuote: string;
  userComment: string;
  deletedAt: string | null;
}

export const highlightRows = (page: Page) => readTable<HighlightRow>(page, 'highlights');

/** The `value` of one `meta` row, undefined when there is none. */
export async function metaValue<T = unknown>(page: Page, key: string): Promise<T | undefined> {
  const row = (await readTable<{ key: string; value: T }>(page, 'meta')).find((r) => r.key === key);
  return row?.value;
}

/** Everything in `chrome.storage.session` (memory only: tokens, the key, the status). */
export async function sessionStore(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => chrome.storage.session.get(null));
}

/**
 * Names of the alarms the extension has scheduled. Empty once the `alarms` permission is gone:
 * "Delete all data" gives it back, and the API object disappears with it.
 */
export async function alarmNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    chrome.alarms ? (await chrome.alarms.getAll()).map((a) => a.name).sort() : [],
  );
}

/** The current settings flag the worker enforces (through the page's own read of `settings`). */
export async function syncFlag(page: Page): Promise<boolean | undefined> {
  return page.evaluate(async () => {
    const got = await chrome.storage.local.get('settings');
    return (got.settings as { features?: { sync?: boolean } } | undefined)?.features?.sync;
  });
}

// ---------------------------------------------------------------------------------------------
// What the server holds
// ---------------------------------------------------------------------------------------------

/** The server's whole stored log as one string, for "contains / does not contain" assertions. */
export async function serverText(sync: SyncHarness): Promise<string> {
  return JSON.stringify((await sync.stored()).map((s) => s.op));
}

// ---------------------------------------------------------------------------------------------
// Accessibility (WCAG 2.2 AA, the tags the other specs use), light and dark
// ---------------------------------------------------------------------------------------------

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

async function axeReport(page: Page, include: string): Promise<string> {
  const { violations, passes } = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .include(include)
    .analyze();
  // A run that checked nothing (the section was not there) must not read as "no violations".
  if (passes.length === 0) return `axe applied no rule under ${include}`;
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n` +
        v.nodes
          .slice(0, 4)
          .map((n) => `   ${JSON.stringify(n.target)} ${n.html.slice(0, 160)}`)
          .join('\n'),
    )
    .join('\n');
}

/** Sync section (which holds the encryption card) has no WCAG 2.2 AA violation in this state. */
export async function expectAccessible(page: Page, state: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeReport(page, '#sync'), `sync section: ${state} (${scheme})`).toBe('');
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
