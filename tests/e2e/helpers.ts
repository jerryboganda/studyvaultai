import { expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Inject the content script into `page` through the extension's real `tab.activate` RPC, sent from
 * an extension page (the same path the popup uses). The e2e build already holds loopback host
 * permissions, so no native permission prompt is involved.
 */
export async function activateTab(
  context: BrowserContext,
  extensionId: string,
  page: Page,
): Promise<void> {
  const ext = await context.newPage();
  try {
    await ext.goto(`chrome-extension://${extensionId}/options.html`);
    const url = page.url();
    const result = await ext.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === pageUrl);
      if (!tab?.id)
        return { ok: false, error: { code: 'not_found', message: `no tab for ${pageUrl}` } };
      return chrome.runtime.sendMessage({ v: 1, type: 'tab.activate', payload: { tabId: tab.id } });
    }, url);
    if (!result?.ok) throw new Error(`tab.activate failed: ${JSON.stringify(result)}`);
  } finally {
    await ext.close();
  }
}

/** Texts currently painted by the CSS Custom Highlight API on the page (any sv-hl-* registry). */
export async function paintedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const [name, hl] of CSS.highlights) {
      if (!name.startsWith('sv-hl-') || name === 'sv-hl-active') continue;
      for (const range of hl as unknown as Iterable<AbstractRange>) {
        const r = range as Range;
        out.push(r.toString());
      }
    }
    return out;
  });
}

/**
 * Wait until the game backfill the worker starts on install and browser start (ADR-022,
 * `runGameBackfill`) has finished and its one dataEpoch bump has landed. Until then that job can
 * write and move `dataEpoch` at any moment, so a test that takes the epoch as a "nothing changed"
 * baseline must call this first. `ext` is any extension page.
 */
export async function settleGameBackfill(ext: Page): Promise<void> {
  await expect
    .poll(
      () =>
        ext.evaluate(async () => {
          // Never create the database by opening it: the product must be the one that does.
          if (!(await indexedDB.databases()).some((d) => d.name === 'studyvault')) return 'no db';
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('studyvault');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          try {
            if (!db.objectStoreNames.contains('meta')) return 'no meta';
            const row = await new Promise<{ value?: { status?: string } } | undefined>(
              (resolve, reject) => {
                const req = db
                  .transaction('meta', 'readonly')
                  .objectStore('meta')
                  .get('game.backfill');
                req.onsuccess = () => resolve(req.result as never);
                req.onerror = () => reject(req.error);
              },
            );
            return row?.value?.status ?? 'not started';
          } finally {
            db.close();
          }
        }),
      { timeout: 30_000, message: 'the game backfill should finish' },
    )
    .toBe('done');
  // The bump follows the 'done' marker's commit: wait until the token holds still for 500 ms. The
  // first probe only records a value (expect.poll probes at once, then every interval).
  const epoch = () =>
    ext.evaluate(async () => (await chrome.storage.local.get('dataEpoch')).dataEpoch as unknown);
  let last: unknown = Symbol('unread');
  await expect
    .poll(
      async () => {
        const now = await epoch();
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [500], timeout: 10_000, message: 'dataEpoch should stop changing' },
    )
    .toBe(true);
}
