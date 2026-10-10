import { z } from 'zod';

/**
 * Highlights a content script soft-deleted, kept in chrome.storage.session (survives worker
 * suspension, cleared on browser restart, unreachable from content scripts).
 *
 * Why it exists: `getHighlightSource` returns null for soft-deleted rows, so the worker cannot
 * otherwise prove that an "Undo" (`highlight.restore`) from a page targets that page's own
 * highlight. A restore from a page is only honoured for an id this same tab deleted.
 */

const KEY = 'recentDeletes';
const MAX_ENTRIES = 50;

const Entry = z.object({
  tabId: z.number(),
  id: z.string(),
  urlKey: z.string(),
  visitedKey: z.string(),
});
export type DeletedEntry = z.infer<typeof Entry>;

export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface DeleteLedger {
  add(entry: DeletedEntry): Promise<void>;
  find(tabId: number, id: string): Promise<DeletedEntry | null>;
}

export function createDeleteLedger(area: SessionArea): DeleteLedger {
  const read = async () =>
    z
      .array(Entry)
      .catch([])
      .parse((await area.get(KEY))[KEY]);
  return {
    async add(entry) {
      const rest = (await read()).filter((e) => !(e.tabId === entry.tabId && e.id === entry.id));
      await area.set({ [KEY]: [...rest, entry].slice(-MAX_ENTRIES) });
    },
    async find(tabId, id) {
      return (await read()).find((e) => e.tabId === tabId && e.id === id) ?? null;
    },
  };
}
