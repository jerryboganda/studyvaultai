import { browser } from 'wxt/browser';
import { callTab } from '@runtime';
import type { CardSourceContext } from '@storage';
import { safeHref } from '@ui';
import { pdfReaderPath } from '@pdf/readerUrl';

/**
 * "Jump to source": open the page (or the PDF reader at the page and highlight) a card came from.
 *
 * Honest about what it can do: a web page opens in a new tab and StudyVault asks its content script
 * to scroll to the passage, but the script only runs where the user granted access, so the result
 * says whether the passage was actually found.
 */

export type JumpResult =
  { ok: true; scrolled: boolean; message: string } | { ok: false; message: string };

export interface JumpDeps {
  createTab(url: string): Promise<{ id?: number }>;
  /** Resolves when the tab finished loading, or false after the timeout. */
  waitForLoad(tabId: number, timeoutMs: number): Promise<boolean>;
  reveal(tabId: number, highlightId: string): Promise<boolean>;
  extensionUrl(path: string): string;
  sleep(ms: number): Promise<void>;
}

export const browserJumpDeps: JumpDeps = {
  createTab: (url) => browser.tabs.create({ url }),
  waitForLoad: (tabId, timeoutMs) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        browser.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve(value);
      };
      const onUpdated = (id: number, change: { status?: string }) => {
        if (id === tabId && change.status === 'complete') finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      browser.tabs.onUpdated.addListener(onUpdated);
      // It may already be complete (cached page): ask once.
      browser.tabs.get(tabId).then(
        (tab) => {
          if (tab.status === 'complete') finish(true);
        },
        () => finish(false),
      );
    }),
  reveal: async (tabId, highlightId) =>
    (await callTab(tabId, 'content.reveal', { id: highlightId })).found,
  extensionUrl: (path) => browser.runtime.getURL(`/${path}` as never),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const LOAD_TIMEOUT_MS = 15_000;
const REVEAL_ATTEMPTS = 4;
const REVEAL_DELAY_MS = 700;

export async function openSource(
  context: Pick<CardSourceContext, 'jump' | 'highlightId'>,
  deps: JumpDeps = browserJumpDeps,
): Promise<JumpResult> {
  const { jump } = context;
  if (!jump) {
    return {
      ok: false,
      message:
        'This card has no linked source: it is a free-standing card, or its highlight was deleted.',
    };
  }
  try {
    if (jump.kind === 'pdf') {
      const path = pdfReaderPath({
        doc: jump.documentId,
        page: jump.pageNumber,
        highlight: jump.highlightId,
      });
      await deps.createTab(deps.extensionUrl(path));
      return {
        ok: true,
        scrolled: true,
        message: `Opened the PDF reader${jump.pageNumber ? ` on page ${jump.pageNumber}` : ''}.`,
      };
    }
    const url = safeHref(jump.url);
    if (!url) return { ok: false, message: 'The saved address of this source cannot be opened.' };
    const tab = await deps.createTab(url);
    const highlightId = context.highlightId;
    if (tab.id === undefined || !highlightId) {
      return { ok: true, scrolled: false, message: 'Opened the source page.' };
    }
    if (!(await deps.waitForLoad(tab.id, LOAD_TIMEOUT_MS))) {
      return {
        ok: true,
        scrolled: false,
        message: 'Opened the source page; it was slow to load, so the passage was not located.',
      };
    }
    for (let attempt = 0; attempt < REVEAL_ATTEMPTS; attempt += 1) {
      try {
        if (await deps.reveal(tab.id, highlightId)) {
          return { ok: true, scrolled: true, message: 'Opened the source and showed the passage.' };
        }
      } catch {
        // No content script yet (still starting) or none at all: try again, then say so.
      }
      await deps.sleep(REVEAL_DELAY_MS);
    }
    return {
      ok: true,
      scrolled: false,
      message:
        'Opened the source page. StudyVault could not show the passage there (it may not be active on that site, or the text changed); your saved quote is unchanged.',
    };
  } catch (err) {
    return {
      ok: false,
      message: `Could not open the source: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
