import type { BrowserContext, Page } from '@playwright/test';

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
