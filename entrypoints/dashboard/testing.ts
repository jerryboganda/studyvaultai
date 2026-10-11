/**
 * Test-only in-memory stand-in for the vault, shaped like DashboardApi. It implements the semantics
 * the dashboard relies on (scope, kinds, tags, cursor paging, soft delete, notes, trash) with just
 * enough fidelity for component tests; the real engine is tested in packages/storage.
 */
import {
  INBOX_BANK_ID,
  StudyVaultError,
  type AnchorSet,
  type ColorId,
  type HighlightKind,
  type Note,
} from '@shared';
import type {
  BankInfo,
  DashboardItem,
  DuplicateCluster,
  FolderNode,
  HighlightDetail,
  HighlightPage,
  HighlightQuery,
  StorageUsage,
  TagWithCount,
  TrashItem,
  VaultCounts,
} from '@storage';
import type { SearchDocument } from '@shared';
import type { DashboardApi } from './api';

export interface FakeHighlight {
  id: string;
  quote: string;
  kind?: HighlightKind;
  color?: ColorId;
  priority?: number;
  comment?: string;
  bankIds?: string[];
  folderId?: string | null;
  tagIds?: string[];
  sourceId?: string;
  title?: string;
  host?: string;
  url?: string;
  capturedAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  resolveStatus?: 'unchecked' | 'resolved' | 'changed' | 'ambiguous' | 'orphaned';
  pdfPage?: number;
  documentId?: string;
  customFields?: Record<string, string | number | boolean>;
}

interface Row extends Required<Omit<FakeHighlight, 'pdfPage' | 'documentId'>> {
  pdfPage: number | null;
  documentId: string | null;
}

export class FakeVault {
  banks: BankInfo[] = [
    {
      id: INBOX_BANK_ID,
      name: 'Inbox',
      color: 'blue',
      isInbox: true,
      icon: null,
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  folders: Array<{ id: string; bankId: string; parentId: string | null; name: string }> = [];
  tags: Array<{ id: string; name: string }> = [];
  notes: Note[] = [];
  rows: Row[] = [];
  trashedNotes = new Set<string>();
  metaStore = new Map<string, unknown>();
  calls: Array<{ fn: string; args: unknown[] }> = [];
  fail: Partial<Record<string, Error>> = {};
  duplicates: DuplicateCluster[] = [];
  cachedPdfs: Array<{ id: string; title: string; bytes: number }> = [];
  purgeAt: string | null = null;
  seq = 0;
  clock = 1_000;

  constructor(highlights: FakeHighlight[] = []) {
    for (const h of highlights) this.addHighlight(h);
  }

  tick(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 11, 10, 0, 0) + this.clock * 1000).toISOString();
  }

  addBank(id: string, name: string, color: ColorId = 'green') {
    this.banks.push({
      id,
      name,
      color,
      isInbox: false,
      icon: null,
      position: this.banks.length,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  addHighlight(h: FakeHighlight): Row {
    const at = this.tick();
    const row: Row = {
      id: h.id,
      quote: h.quote,
      kind: h.kind ?? 'essential',
      color: h.color ?? 'amber',
      priority: h.priority ?? 3,
      comment: h.comment ?? '',
      bankIds: h.bankIds ?? [INBOX_BANK_ID],
      folderId: h.folderId ?? null,
      tagIds: h.tagIds ?? [],
      sourceId: h.sourceId ?? 'source-0001',
      title: h.title ?? 'Cell biology notes',
      host: h.host ?? 'example.com',
      url: h.url ?? 'https://example.com/cells',
      capturedAt: h.capturedAt ?? at,
      updatedAt: h.updatedAt ?? at,
      deletedAt: h.deletedAt ?? null,
      resolveStatus: h.resolveStatus ?? 'resolved',
      pdfPage: h.pdfPage ?? null,
      documentId: h.documentId ?? null,
      customFields: h.customFields ?? {},
    };
    this.rows.push(row);
    return row;
  }

  record(fn: string, ...args: unknown[]) {
    this.calls.push({ fn, args });
    const err = this.fail[fn];
    if (err) throw err;
  }
  called(fn: string) {
    return this.calls.filter((c) => c.fn === fn);
  }

  live() {
    return this.rows.filter((r) => r.deletedAt === null);
  }
  row(id: string): Row {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new StudyVaultError('not_found', 'Highlight not found');
    return r;
  }
  bankLite(id: string) {
    const b = this.banks.find((x) => x.id === id);
    return {
      id,
      name: b?.name ?? id,
      color: b?.color ?? ('blue' as ColorId),
      isInbox: b?.isInbox ?? false,
    };
  }
  folderPath(folderId: string | null) {
    const out: Array<{ id: string; name: string }> = [];
    let cursor = folderId;
    while (cursor) {
      const f = this.folders.find((x) => x.id === cursor);
      if (!f) break;
      out.unshift({ id: f.id, name: f.name });
      cursor = f.parentId;
    }
    return out;
  }
  subtree(folderId: string): Set<string> {
    const out = new Set([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of this.folders) {
        if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
          out.add(f.id);
          grew = true;
        }
      }
    }
    return out;
  }

  anchor(r: Row): AnchorSet {
    return r.pdfPage === null
      ? {
          type: 'html',
          textAlgorithm: 'sv-text-v1',
          textQuote: { exact: r.quote, prefix: '', suffix: '' },
          textPosition: { start: 0, end: Math.max(1, r.quote.length) },
          structuralPath: null,
          contentSignature: 'sig',
          documentTextLength: 100,
        }
      : {
          type: 'pdf',
          textAlgorithm: 'sv-pdf-text-v1',
          documentFingerprint: r.documentId ?? 'doc-fingerprint',
          pageNumber: r.pdfPage,
          rotation: 0,
          rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.05 }],
          textQuote: { exact: r.quote, prefix: '', suffix: '' },
          textPosition: { start: 0, end: Math.max(1, r.quote.length) },
          contentSignature: 'sig',
          documentTextLength: 100,
        };
  }

  item(r: Row): DashboardItem {
    const notes = this.notes.filter(
      (n) => n.highlightId === r.id && n.deletedAt === null && !this.trashedNotes.has(n.id),
    );
    return {
      highlight: {
        id: r.id,
        sourceId: r.sourceId,
        exactQuote: r.quote,
        anchorSet: this.anchor(r),
        kind: r.kind,
        color: r.color,
        priority: r.priority,
        userComment: r.comment,
        headingContext: null,
        bankIds: r.bankIds,
        capturedAt: r.capturedAt,
        resolveStatus: r.resolveStatus,
        resolveConfidence: 1,
      },
      source: {
        id: r.sourceId,
        title: r.title,
        host: r.host,
        originalUrl: r.url,
        canonicalUrl: null,
        urlKey: r.url,
        type: r.pdfPage === null ? 'web' : 'pdf',
        ...(r.documentId ? { documentId: r.documentId } : {}),
      },
      banks: r.bankIds.map((b) => this.bankLite(b)),
      tags: r.tagIds.flatMap((t) => {
        const tag = this.tags.find((x) => x.id === t);
        return tag ? [{ id: tag.id, name: tag.name, color: null }] : [];
      }),
      locations: r.bankIds.map((b) => ({
        bank: this.bankLite(b),
        folderPath: b === r.bankIds[0] ? this.folderPath(r.folderId) : [],
      })),
      noteCount: notes.length,
      customFields: r.customFields,
      createdAt: r.capturedAt,
      updatedAt: r.updatedAt,
    };
  }

  matches(r: Row, q: HighlightQuery): boolean {
    if (r.deletedAt !== null) return false;
    if (q.folderId) {
      if (!r.folderId || !this.subtree(q.folderId).has(r.folderId)) return false;
    } else if (q.bankId && !r.bankIds.includes(q.bankId)) return false;
    if (q.kinds?.length && !q.kinds.includes(r.kind)) return false;
    if (q.priorities?.length && !q.priorities.includes(r.priority)) return false;
    if (q.resolveStatuses?.length && !q.resolveStatuses.includes(r.resolveStatus)) return false;
    if (q.sourceId && r.sourceId !== q.sourceId) return false;
    if (q.tagIds?.length) {
      const has = (t: string) => r.tagIds.includes(t);
      if (!(q.tagMode === 'all' ? q.tagIds.every(has) : q.tagIds.some(has))) return false;
    }
    if (q.hasNote !== undefined) {
      const n = this.notes.some((x) => x.highlightId === r.id && !this.trashedNotes.has(x.id));
      if (n !== q.hasNote) return false;
    }
    if (q.dateRange) {
      const v = r[q.dateRange.field ?? 'capturedAt'];
      if (q.dateRange.from && v < q.dateRange.from) return false;
      if (q.dateRange.to && v > q.dateRange.to) return false;
    }
    return true;
  }

  sorted(q: HighlightQuery): Row[] {
    const by = q.sort?.by ?? 'capturedAt';
    const dir = q.sort?.dir ?? 'desc';
    const key = (r: Row) => (by === 'priority' ? r.priority : r[by]);
    return this.rows
      .filter((r) => this.matches(r, q))
      .sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        const c = ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : 1;
        return dir === 'desc' ? -c : c;
      });
  }

  // --- DashboardApi ------------------------------------------------------------------------

  api(): DashboardApi {
    return buildApi(this);
  }

  searchDocs(): SearchDocument[] {
    const docs: SearchDocument[] = [];
    for (const r of this.rows) {
      const names = r.bankIds.map((b) => this.banks.find((x) => x.id === b)?.name ?? b);
      docs.push({
        id: r.id,
        docType: 'highlight',
        highlightId: r.id,
        title: r.title,
        url: r.url,
        host: r.host,
        quote: r.quote,
        comment: r.comment,
        headingContext: null,
        tags: r.tagIds.map((t) => this.tags.find((x) => x.id === t)?.name ?? t),
        banks: names,
        folderPath: this.folderPath(r.folderId).map((f) => f.name),
        kind: r.kind,
        priority: r.priority as 1 | 2 | 3 | 4 | 5,
        resolveStatus: r.resolveStatus,
        updatedAt: r.updatedAt,
        deletedAt: r.deletedAt,
      });
    }
    for (const n of this.notes) {
      const h = n.highlightId ? this.rows.find((r) => r.id === n.highlightId) : undefined;
      docs.push({
        id: n.id,
        docType: 'note',
        highlightId: n.highlightId,
        title: h?.title ?? n.title,
        url: h?.url ?? '',
        host: h?.host ?? '',
        quote: h?.quote ?? '',
        comment: n.title ? `${n.title}\n${n.body}` : n.body,
        headingContext: null,
        // like the real feed, a note document carries its highlight's facets
        tags: h ? h.tagIds.map((t) => this.tags.find((x) => x.id === t)?.name ?? t) : [],
        banks: h ? h.bankIds.map((b) => this.banks.find((x) => x.id === b)?.name ?? b) : [],
        folderPath: h ? this.folderPath(h.folderId).map((f) => f.name) : [],
        kind: h?.kind ?? null,
        priority: (h?.priority as 1 | 2 | 3 | 4 | 5 | undefined) ?? null,
        resolveStatus: h?.resolveStatus ?? null,
        updatedAt: n.updatedAt,
        deletedAt: this.trashedNotes.has(n.id) ? this.tick() : (h?.deletedAt ?? null),
      });
    }
    return docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

function buildApi(self: FakeVault): DashboardApi {
  const api: DashboardApi = {
    async listBankInfos() {
      self.record('listBankInfos');
      return self.banks.map((b) => ({ ...b }));
    },
    async listFolderTree(bankId) {
      self.record('listFolderTree', bankId);
      const build = (parent: string | null, depth: number): FolderNode[] =>
        self.folders
          .filter((f) => f.bankId === bankId && f.parentId === parent)
          .map((f) => {
            const children = build(f.id, depth + 1);
            const count = self.live().filter((r) => r.folderId === f.id).length;
            return {
              folder: {
                id: f.id,
                bankId,
                parentFolderId: f.parentId,
                name: f.name,
                position: 1,
                schemaVersion: 1,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                deletedAt: null,
              },
              depth,
              count,
              totalCount: count + children.reduce((n, c) => n + c.totalCount, 0),
              children,
            };
          });
      return build(null, 1);
    },
    async getCounts(): Promise<VaultCounts> {
      self.record('getCounts');
      const live = self.live();
      const banks: Record<string, number> = {};
      for (const r of live) for (const b of r.bankIds) banks[b] = (banks[b] ?? 0) + 1;
      return {
        total: live.length,
        banks,
        folders: {},
        tags: {},
        kinds: {},
        priorities: {},
        resolveStatuses: {},
      };
    },
    async listTags(): Promise<TagWithCount[]> {
      self.record('listTags');
      return self.tags.map((t) => ({
        tag: {
          id: t.id,
          name: t.name,
          nameKey: t.name.toLowerCase(),
          color: null,
          aliases: [],
          schemaVersion: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          deletedAt: null,
        },
        count: self.live().filter((r) => r.tagIds.includes(t.id)).length,
      }));
    },
    async listHighlights(query = {}): Promise<HighlightPage> {
      self.record('listHighlights', query);
      const all = self.sorted(query);
      const start = query.cursor ? Number(query.cursor) : 0;
      const limit = query.limit ?? 50;
      const items = all.slice(start, start + limit).map((r) => self.item(r));
      const end = start + limit;
      return { items, nextCursor: end < all.length ? String(end) : null };
    },
    async countHighlights(query = {}) {
      self.record('countHighlights', query);
      return self.rows.filter((r) => self.matches(r, query)).length;
    },
    async getHighlightDetail(id): Promise<HighlightDetail> {
      self.record('getHighlightDetail', id);
      const r = self.row(id);
      if (r.deletedAt !== null) throw new StudyVaultError('not_found', 'Highlight not found');
      const twins = self.live().filter((x) => x.id !== id && x.quote === r.quote);
      return {
        ...self.item(r),
        notes: self.notes
          .filter((n) => n.highlightId === id && !self.trashedNotes.has(n.id))
          .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
        duplicates: twins.map((t) => ({
          highlightId: t.id,
          sourceId: t.sourceId,
          sourceTitle: t.title,
          host: t.host,
          originalUrl: t.url,
          sourceType: 'web' as const,
          bankIds: t.bankIds,
          capturedAt: t.capturedAt,
          pageNumber: null,
        })),
        deletedAt: null,
        capturedUrl: r.url,
        capturedTitle: r.title,
        captureMethod: 'toolbar',
      };
    },
    async updateHighlight(id, patch) {
      self.record('updateHighlight', id, patch);
      const r = self.row(id);
      Object.assign(r, {
        ...(patch.kind ? { kind: patch.kind } : {}),
        ...(patch.color ? { color: patch.color } : {}),
        ...(patch.priority ? { priority: patch.priority } : {}),
        ...(patch.userComment !== undefined ? { comment: patch.userComment } : {}),
        updatedAt: self.tick(),
      });
      return self.item(r).highlight;
    },
    async softDeleteHighlight(id) {
      self.record('softDeleteHighlight', id);
      const r = self.row(id);
      r.deletedAt = self.tick();
      r.updatedAt = r.deletedAt;
    },
    async restoreHighlight(id) {
      self.record('restoreHighlight', id);
      const r = self.row(id);
      r.deletedAt = null;
      r.updatedAt = self.tick();
      return self.item(r).highlight;
    },
    async bulkDelete(ids) {
      self.record('bulkDelete', ids);
      for (const id of ids) {
        const r = self.row(id);
        r.deletedAt = self.tick();
        r.updatedAt = r.deletedAt;
      }
      return { requested: ids.length, changed: ids.length };
    },
    async bulkRestore(ids) {
      self.record('bulkRestore', ids);
      for (const id of ids) {
        const r = self.row(id);
        r.deletedAt = null;
        r.updatedAt = self.tick();
      }
      return { requested: ids.length, changed: ids.length };
    },
    async bulkSetKind(ids, kind) {
      self.record('bulkSetKind', ids, kind);
      for (const id of ids) Object.assign(self.row(id), { kind, updatedAt: self.tick() });
      return { requested: ids.length, changed: ids.length };
    },
    async bulkSetColor(ids, color) {
      self.record('bulkSetColor', ids, color);
      for (const id of ids) Object.assign(self.row(id), { color, updatedAt: self.tick() });
      return { requested: ids.length, changed: ids.length };
    },
    async bulkSetPriority(ids, priority) {
      self.record('bulkSetPriority', ids, priority);
      for (const id of ids) Object.assign(self.row(id), { priority, updatedAt: self.tick() });
      return { requested: ids.length, changed: ids.length };
    },
    async bulkMove(input) {
      self.record('bulkMove', input);
      for (const id of input.highlightIds) {
        const r = self.row(id);
        r.bankIds = input.fromBankId
          ? [...r.bankIds.filter((b) => b !== input.fromBankId), input.toBankId]
          : [input.toBankId];
        r.folderId = input.folderId ?? null;
        r.updatedAt = self.tick();
      }
      return { requested: input.highlightIds.length, changed: input.highlightIds.length };
    },
    async bulkTag(input) {
      self.record('bulkTag', input);
      for (const id of input.highlightIds) {
        const r = self.row(id);
        r.tagIds = [...new Set([...r.tagIds, ...(input.addTagIds ?? [])])].filter(
          (t) => !(input.removeTagIds ?? []).includes(t),
        );
        r.updatedAt = self.tick();
      }
      return { requested: input.highlightIds.length, changed: input.highlightIds.length };
    },
    async createTag(name) {
      self.record('createTag', name);
      const existing = self.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        return {
          created: false,
          tag: (await api.listTags()).find((t) => t.tag.id === existing.id)!.tag,
        };
      }
      const tag = { id: `tag-${String(++self.seq).padStart(5, '0')}`, name };
      self.tags.push(tag);
      return { created: true, tag: (await api.listTags()).find((t) => t.tag.id === tag.id)!.tag };
    },
    async attachTags({ highlightIds, tagIds }) {
      self.record('attachTags', highlightIds, tagIds);
      for (const id of highlightIds) {
        const r = self.row(id);
        r.tagIds = [...new Set([...r.tagIds, ...tagIds])];
        r.updatedAt = self.tick();
      }
      return { linked: highlightIds.length * tagIds.length };
    },
    async detachTags({ highlightIds, tagIds }) {
      self.record('detachTags', highlightIds, tagIds);
      for (const id of highlightIds) {
        const r = self.row(id);
        r.tagIds = r.tagIds.filter((t) => !tagIds.includes(t));
        r.updatedAt = self.tick();
      }
      return { unlinked: highlightIds.length * tagIds.length };
    },
    async createNote(input) {
      self.record('createNote', input);
      const at = self.tick();
      const note: Note = {
        id: `note-${String(++self.seq).padStart(5, '0')}`,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        highlightId: input.highlightId ?? null,
        sourceId: input.sourceId ?? null,
        title: input.title ?? '',
        body: input.body,
        pinned: input.pinned ?? false,
      };
      self.notes.push(note);
      if (note.highlightId) self.row(note.highlightId).updatedAt = at;
      return note;
    },
    async updateNote(id, patch) {
      self.record('updateNote', id, patch);
      const n = self.notes.find((x) => x.id === id);
      if (!n) throw new StudyVaultError('not_found', 'Note not found');
      Object.assign(n, patch, { updatedAt: self.tick() });
      return n;
    },
    async deleteNote(id) {
      self.record('deleteNote', id);
      self.trashedNotes.add(id);
    },
    // Like the real vault, setCustomFields MERGES into the stored fields.
    async setCustomFields(id, fields) {
      self.record('setCustomFields', id, fields);
      const row = self.row(id);
      row.customFields = { ...row.customFields, ...fields };
      return row.customFields;
    },
    async clearCustomField(id, key) {
      self.record('clearCustomField', id, key);
      const row = self.row(id);
      const { [key]: _removed, ...rest } = row.customFields ?? {};
      row.customFields = rest;
      return rest;
    },
    async addToBank({ highlightId, bankId, folderId }) {
      self.record('addToBank', { highlightId, bankId, folderId });
      const r = self.row(highlightId);
      if (!r.bankIds.includes(bankId)) r.bankIds.push(bankId);
      return { added: true, changed: true };
    },
    async removeFromBank({ highlightId, bankId }) {
      self.record('removeFromBank', { highlightId, bankId });
      const r = self.row(highlightId);
      r.bankIds = r.bankIds.filter((b) => b !== bankId);
      const rehomedToInbox = r.bankIds.length === 0;
      if (rehomedToInbox) r.bankIds = [INBOX_BANK_ID];
      return { removed: true, rehomedToInbox };
    },
    async moveHighlight({ highlightId, fromBankId, toBankId, folderId }) {
      self.record('moveHighlight', { highlightId, fromBankId, toBankId, folderId });
      const r = self.row(highlightId);
      r.bankIds = [...r.bankIds.filter((b) => b !== fromBankId), toBankId];
      r.folderId = folderId ?? null;
      return { changed: true };
    },
    async createBank(name) {
      self.record('createBank', name);
      const id = `bank-${String(++self.seq).padStart(5, '0')}`;
      self.addBank(id, name);
      return { id, name, color: 'green', isInbox: false };
    },
    async createFolder(input) {
      self.record('createFolder', input);
      const id = `folder-${String(++self.seq).padStart(4, '0')}`;
      self.folders.push({
        id,
        bankId: input.bankId,
        parentId: input.parentFolderId ?? null,
        name: input.name,
      });
      return { id } as never;
    },
    async renameBank(id, name) {
      self.record('renameBank', id, name);
      const b = self.banks.find((x) => x.id === id)!;
      b.name = name;
      return { ...b };
    },
    async renameFolder(id, name) {
      self.record('renameFolder', id, name);
      self.folders.find((x) => x.id === id)!.name = name;
      return { id } as never;
    },
    async moveFolder(input) {
      self.record('moveFolder', input);
      const f = self.folders.find((x) => x.id === input.id)!;
      f.parentId = input.parentFolderId;
      if (input.bankId) f.bankId = input.bankId;
      return { id: f.id } as never;
    },
    async reorderFolders(input) {
      self.record('reorderFolders', input);
      const ours = self.folders.filter(
        (f) => f.bankId === input.bankId && f.parentId === input.parentFolderId,
      );
      const rest = self.folders.filter((f) => !ours.includes(f));
      const ordered = input.orderedIds.map((id) => ours.find((f) => f.id === id)!);
      self.folders = [...rest, ...ordered];
      return [];
    },
    async reorderBanks(ids) {
      self.record('reorderBanks', ids);
      const byId = new Map(self.banks.map((b) => [b.id, b]));
      self.banks = [
        byId.get(INBOX_BANK_ID)!,
        ...ids.filter((i) => i !== INBOX_BANK_ID).map((i) => byId.get(i)!),
      ];
      return self.banks;
    },
    async deleteFolder(id) {
      self.record('deleteFolder', id);
      const f = self.folders.find((x) => x.id === id)!;
      for (const c of self.folders) if (c.parentId === id) c.parentId = f.parentId;
      for (const r of self.rows) if (r.folderId === id) r.folderId = f.parentId;
      self.folders = self.folders.filter((x) => x.id !== id);
      return { rehomedFolders: 0, rehomedHighlights: 0 };
    },
    async deleteBank(id) {
      self.record('deleteBank', id);
      self.banks = self.banks.filter((b) => b.id !== id);
      return { rehomedHighlights: 0 };
    },
    async mergeFolders({ sourceId, targetId }) {
      self.record('mergeFolders', { sourceId, targetId });
      let movedFolders = 0;
      for (const f of self.folders) {
        if (f.parentId === sourceId) {
          f.parentId = targetId;
          movedFolders++;
        }
      }
      let movedHighlights = 0;
      for (const r of self.rows) {
        if (r.folderId === sourceId) {
          r.folderId = targetId;
          movedHighlights++;
        }
      }
      self.folders = self.folders.filter((f) => f.id !== sourceId);
      return { movedFolders, movedHighlights };
    },
    async mergeBanks({ sourceId, targetId }) {
      self.record('mergeBanks', { sourceId, targetId });
      let movedHighlights = 0;
      for (const r of self.rows) {
        if (r.bankIds.includes(sourceId)) {
          r.bankIds = [...new Set(r.bankIds.map((b) => (b === sourceId ? targetId : b)))];
          movedHighlights++;
        }
      }
      self.banks = self.banks.filter((b) => b.id !== sourceId);
      return { movedFolders: 0, movedHighlights };
    },
    async setBankColor(id, color) {
      self.record('setBankColor', id, color);
      const b = self.banks.find((x) => x.id === id)!;
      b.color = color;
      return { ...b };
    },
    async setBankIcon(id, icon) {
      self.record('setBankIcon', id, icon);
      const b = self.banks.find((x) => x.id === id)!;
      b.icon = icon;
      return { ...b };
    },
    async listTrash(): Promise<TrashItem[]> {
      self.record('listTrash');
      return self.rows
        .filter((r) => r.deletedAt !== null)
        .map((r) => ({
          kind: 'highlight' as const,
          id: r.id,
          label: r.quote,
          context: r.title,
          deletedAt: r.deletedAt!,
        }));
    },
    async restore(refs) {
      self.record('restore', refs);
      let restored = 0;
      for (const ref of refs) {
        const id = typeof ref === 'string' ? ref : ref.id;
        const kind = typeof ref === 'string' ? 'highlight' : ref.kind;
        if (kind === 'note') {
          self.trashedNotes.delete(id);
          restored++;
        } else {
          self.row(id).deletedAt = null;
          restored++;
        }
      }
      return { restored };
    },
    async purge(refs) {
      self.record('purge', refs);
      const ids = new Set(refs.map((r) => (typeof r === 'string' ? r : r.id)));
      self.rows = self.rows.filter((r) => !ids.has(r.id));
      self.purgeAt = self.tick();
      return emptyPurge(ids.size);
    },
    async emptyTrash() {
      self.record('emptyTrash');
      const n = self.rows.filter((r) => r.deletedAt !== null).length;
      self.rows = self.rows.filter((r) => r.deletedAt === null);
      self.purgeAt = self.tick();
      return emptyPurge(n);
    },
    async findDuplicateClusters() {
      self.record('findDuplicateClusters');
      return self.duplicates;
    },
    async listSearchDocuments({ afterId, limit = 500 } = {}) {
      self.record('listSearchDocuments', { afterId, limit });
      return self
        .searchDocs()
        .filter((d) => afterId === undefined || d.id > afterId)
        .slice(0, limit);
    },
    async listSearchDocumentsChangedSince({ since, afterId, limit = 500 }) {
      self.record('listSearchDocumentsChangedSince', { since, afterId, limit });
      return self
        .searchDocs()
        .filter((d) => d.updatedAt >= since && (afterId === undefined || d.id > afterId))
        .slice(0, limit);
    },
    async getLastPurgeAt() {
      return self.purgeAt;
    },
    async listDocuments() {
      self.record('listDocuments');
      return self.cachedPdfs.map((p) => ({
        document: {
          id: p.id,
          title: p.title,
          pageCount: 10,
          byteLength: p.bytes,
          originalUrl: null,
          textStatus: 'text' as const,
          schemaVersion: 1 as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          deletedAt: null,
        },
        highlightCount: 2,
        cachedBytes: p.bytes,
      }));
    },
    async removeDocumentBytes(id) {
      self.record('removeDocumentBytes', id);
      const had = self.cachedPdfs.some((p) => p.id === id);
      self.cachedPdfs = self.cachedPdfs.filter((p) => p.id !== id);
      return had;
    },
    async getStorageUsage(): Promise<StorageUsage> {
      self.record('getStorageUsage');
      return {
        rows: {
          highlights: self.rows.length,
          notes: self.notes.length,
          banks: self.banks.length,
          attachments: self.cachedPdfs.length,
        },
        totalRows:
          self.rows.length + self.notes.length + self.banks.length + self.cachedPdfs.length,
        cachedPdfBytes: self.cachedPdfs.reduce((n, p) => n + p.bytes, 0),
        cachedPdfCount: self.cachedPdfs.length,
        estimate: { usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 },
      };
    },
    meta: {
      get: async (key) => self.metaStore.get(key),
      put: async (key, value) => void self.metaStore.set(key, value),
      putMany: async (entries) => {
        for (const e of entries) self.metaStore.set(e.key, e.value);
      },
    },
  };
  return api;
}

function emptyPurge(highlights: number) {
  return {
    purged: { highlight: highlights, note: 0, folder: 0, bank: 0, tag: 0, document: 0 },
    related: {
      memberships: 0,
      tagLinks: 0,
      notes: 0,
      sources: 0,
      folders: 0,
      knowledgePoints: 0,
      cards: 0,
      reviewLogs: 0,
      aiResults: 0,
      attachments: 0,
      ocrPages: 0,
    },
  };
}

export function manyHighlights(count: number, prefix = 'hl'): FakeHighlight[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(6, '0')}`,
    quote: `Quote number ${i} about mitochondria and membranes.`,
    kind: (['essential', 'formula', 'exception'] as const)[i % 3],
    priority: (i % 5) + 1,
  }));
}
