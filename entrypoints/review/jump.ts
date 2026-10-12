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
 *
 * Patience is bounded and visible. A slow machine (or a heavy page) can take many seconds to finish
 * loading and to start the content script, which then still has to find the passage, so the tab gets
 * LOAD_TIMEOUT_MS to load and the content script REVEAL_WINDOW_MS to answer "found". While that
 * runs the caller is told what is happening (OPENING_MESSAGE, then LOOKING_MESSAGE).
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
  /** Milliseconds since an arbitrary origin (default Date.now); injectable for tests. */
  now?(): number;
}

export interface JumpOptions {
  /** What is happening right now, for a status line ("Opening the page…"). */
  onProgress?(message: string): void;
}

export const OPENING_MESSAGE = 'Opening the page…';
export const LOOKING_MESSAGE = 'Looking for the passage…';

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
        clearInterval(poll);
        resolve(value);
      };
      const onUpdated = (id: number, change: { status?: string }) => {
        if (id === tabId && change.status === 'complete') finish(true);
      };
      // The extension page that started the jump is hidden the moment the new tab takes the
      // foreground, so the event can be late or missed: ask the tab itself as well.
      const look = () => {
        browser.tabs.get(tabId).then(
          (tab) => {
            if (tab.status === 'complete') finish(true);
          },
          (err: unknown) => {
            // A tab that is gone will never finish; any other failure is transient, keep asking.
            if (/no tab with id|tab was closed|was removed/i.test(String(err))) finish(false);
          },
        );
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const poll = setInterval(look, LOAD_POLL_MS);
      browser.tabs.onUpdated.addListener(onUpdated);
      look(); // it may already be complete (cached page)
    }),
  reveal: async (tabId, highlightId) =>
    (await callTab(tabId, 'content.reveal', { id: highlightId })).found,
  extensionUrl: (path) => browser.runtime.getURL(`/${path}` as never),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** How long the new tab gets to finish loading. */
export const LOAD_TIMEOUT_MS = 30_000;
/** After it loaded: how long the content script gets to start, resolve the highlight and answer. */
export const REVEAL_WINDOW_MS = 20_000;
/** Pauses between "show it" attempts: quick at first, then every 2 s until the window is used up. */
const REVEAL_DELAYS_MS = [250, 500, 750, 1_000, 1_500, 2_000] as const;
const LOAD_POLL_MS = 500;

export async function openSource(
  context: Pick<CardSourceContext, 'jump' | 'highlightId'>,
  deps: JumpDeps = browserJumpDeps,
  options: JumpOptions = {},
): Promise<JumpResult> {
  const now = deps.now ?? Date.now;
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
    options.onProgress?.(OPENING_MESSAGE);
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
    options.onProgress?.(LOOKING_MESSAGE);
    const started = now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (await deps.reveal(tab.id, highlightId)) {
          return { ok: true, scrolled: true, message: 'Opened the source and showed the passage.' };
        }
      } catch {
        // No content script yet (still starting) or none at all: try again, then say so.
      }
      const left = REVEAL_WINDOW_MS - (now() - started);
      if (left <= 0) break;
      const pause = REVEAL_DELAYS_MS[Math.min(attempt, REVEAL_DELAYS_MS.length - 1)] as number;
      await deps.sleep(Math.min(pause, left));
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
