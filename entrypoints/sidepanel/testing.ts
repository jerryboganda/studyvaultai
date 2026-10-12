/**
 * Test-only extras for the side panel's mocked `@storage`: the vault functions the panel uses
 * beyond what `@ui/testing/fakes` provides (tags, notes, folders, due counts, search feed). They
 * share the FakeStore's item list and notify its watchers, so live queries re-run like Dexie's.
 * Never imported by production code.
 */
import {
  StudyVaultError,
  type FilingOutcome,
  type FilingSuggestion,
  type Note,
  type SearchDocument,
} from '@shared';
import type { DueSummary, FolderNode, TagLite } from '@storage';
import { store } from '@ui/testing/fakes';

interface FakeTag extends TagLite {
  nameKey: string;
}

class PanelExtras {
  tags: FakeTag[] = [];
  links = new Map<string, Set<string>>();
  notes: Note[] = [];
  folders: Record<string, FolderNode[]> = {};
  due = { total: 0, new: 0, learning: 0, review: 0 };
  /** What the search index is built from. */
  searchDocs: SearchDocument[] = [];
  failNext: Partial<Record<string, Error>> = {};
  /** The filing rules' pending suggestions (chrome.storage.session in production). */
  suggestions: FilingSuggestion[] = [];
  /** What the next acceptFiling answers instead of filing (e.g. the bank was deleted). */
  acceptAnswer: FilingOutcome | null = null;
  private seq = 0;

  reset() {
    this.tags = [];
    this.links.clear();
    this.notes = [];
    this.folders = {};
    this.due = { total: 0, new: 0, learning: 0, review: 0 };
    this.searchDocs = [];
    this.failNext = {};
    this.suggestions = [];
    this.acceptAnswer = null;
    this.seq = 0;
  }

  private call(fn: string, args: unknown[]) {
    store.calls.push({ fn, args });
    const err = this.failNext[fn];
    if (err) {
      delete this.failNext[fn];
      throw err;
    }
  }

  private liveItem(id: string) {
    const item = store.items.find((i) => i.highlight.id === id);
    if (!item) throw new StudyVaultError('not_found', 'Highlight not found');
    return item;
  }

  readonly module = {
    listFilingSuggestions: async () => [...this.suggestions],
    acceptFiling: async (id: string): Promise<FilingOutcome> => {
      this.call('acceptFiling', [id]);
      if (this.acceptAnswer) {
        this.suggestions = this.suggestions.filter((s) => s.highlightId !== id);
        store.notify();
        return this.acceptAnswer;
      }
      const found = this.suggestions.find((s) => s.highlightId === id);
      if (!found) {
        return {
          status: 'unavailable',
          ruleName: '',
          reason: 'This suggestion is no longer available.',
        };
      }
      this.suggestions = this.suggestions.filter((s) => s.highlightId !== id);
      store.notify();
      return {
        status: 'filed',
        ruleName: found.ruleName,
        bank: { id: found.bankId, name: found.bankName, color: 'green', isInbox: false },
        folderName: found.folderName,
        addedTags: found.addTagIds.length,
      };
    },
    dismissFiling: async (id: string) => {
      this.call('dismissFiling', [id]);
      this.suggestions = this.suggestions.filter((s) => s.highlightId !== id);
    },
    undoFiling: async (id: string) => {
      this.call('undoFiling', [id]);
      return { restored: true, reason: null as string | null };
    },
    listTags: async () =>
      this.tags.map((tag) => ({
        tag,
        count: [...this.links.values()].filter((set) => set.has(tag.id)).length,
      })),
    createTag: async (name: string) => {
      this.call('createTag', [name]);
      const key = name.trim().toLowerCase();
      const existing = this.tags.find((t) => t.nameKey === key);
      if (existing) return { tag: existing, created: false };
      const tag: FakeTag = {
        id: `tag-${String(++this.seq).padStart(8, '0')}`,
        name: name.trim(),
        color: null,
        nameKey: key,
      };
      this.tags.push(tag);
      return { tag, created: true };
    },
    attachTags: async (input: { highlightIds: string[]; tagIds: string[] }) => {
      this.call('attachTags', [input]);
      let linked = 0;
      for (const id of input.highlightIds) {
        this.liveItem(id);
        const set = this.links.get(id) ?? new Set<string>();
        for (const t of input.tagIds) {
          if (set.has(t)) continue;
          set.add(t);
          linked++;
        }
        this.links.set(id, set);
      }
      store.notify();
      return { linked };
    },
    detachTags: async (input: { highlightIds: string[]; tagIds: string[] }) => {
      this.call('detachTags', [input]);
      let unlinked = 0;
      for (const id of input.highlightIds) {
        for (const t of input.tagIds) if (this.links.get(id)?.delete(t)) unlinked++;
      }
      store.notify();
      return { unlinked };
    },
    createNote: async (input: {
      highlightId?: string | null;
      sourceId?: string | null;
      body: string;
    }) => {
      this.call('createNote', [input]);
      const now = '2026-10-11T12:00:00.000Z';
      const note: Note = {
        id: `note-${String(++this.seq).padStart(8, '0')}`,
        schemaVersion: 2 as never,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        highlightId: input.highlightId ?? null,
        sourceId: input.sourceId ?? null,
        title: '',
        body: input.body,
        pinned: false,
      };
      this.notes.push(note);
      store.notify();
      return note;
    },
    updateNote: async (id: string, patch: { body?: string }) => {
      this.call('updateNote', [id, patch]);
      const note = this.notes.find((n) => n.id === id);
      if (!note) throw new StudyVaultError('not_found', 'Note not found');
      if (patch.body !== undefined) note.body = patch.body;
      store.notify();
      return note;
    },
    getHighlightDetail: async (id: string) => {
      const item = this.liveItem(id);
      const tagIds = this.links.get(id) ?? new Set<string>();
      return {
        ...item,
        tags: this.tags
          .filter((t) => tagIds.has(t.id))
          .map(({ id, name, color }) => ({ id, name, color })),
        notes: this.notes.filter((n) => n.highlightId === id),
        locations: [],
        noteCount: 0,
        customFields: {},
        duplicates: [],
      };
    },
    listHighlights: async (query: { bankId?: string; limit?: number } = {}) => {
      store.calls.push({ fn: 'listHighlights', args: [query] });
      const items = store.items
        .filter((i) => query.bankId === undefined || i.banks.some((b) => b.id === query.bankId))
        .slice(0, query.limit ?? 50);
      return { items, nextCursor: null };
    },
    listFolderTree: async (bankId: string) => this.folders[bankId] ?? [],
    getDueSummary: async (): Promise<DueSummary> => ({
      now: '2026-10-11T12:00:00.000Z',
      dayKey: '2026-10-11',
      dayEndsAt: '2026-10-12T00:00:00.000Z',
      total: { ...this.due },
      deferred: { review: 0, new: 0 },
      nextLearningAt: null,
      byDeck: {},
      byBank: {},
    }),
    loadStudySession: async () => null,
    // The search host's feed: nothing indexed unless a test overrides these.
    listSearchDocuments: async (o: { afterId?: string; limit?: number } = {}) => {
      this.call('listSearchDocuments', [o]);
      return this.searchDocs
        .filter((d) => o.afterId === undefined || d.id > o.afterId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, o.limit ?? 500);
    },
    listSearchDocumentsChangedSince: async () => [],
    getLastPurgeAt: async () => null,
    getStorageUsage: async () => ({ rows: { highlights: this.searchDocs.length }, totalRows: 0 }),
    withDb: async <T>(fn: (db: unknown) => Promise<T>) =>
      fn({ meta: { get: async () => undefined } }),
    withWritableDb: async <T>(fn: (db: unknown) => Promise<T>) =>
      fn({
        meta: { put: async () => undefined },
        transaction: async (_mode: string, _table: unknown, run: () => Promise<unknown>) => run(),
      }),
  };
}

export const extras = new PanelExtras();
