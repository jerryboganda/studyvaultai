import { num, safeHttpUrl, str, strOrNull } from './text';
import type { Row } from './types';

/**
 * Plain row arrays as read from the vault (tables `banks`, `sources`, `highlights`,
 * `highlightBanks`, and optionally `folders`, `tags`, `highlightTags`, `notes`, `decks`, `cards`).
 * Field names are those of the Phase 1/2 schemas; anything missing degrades to empty, never throws.
 */
export interface ExportDataset {
  banks: readonly Row[];
  sources: readonly Row[];
  highlights: readonly Row[];
  highlightBanks: readonly Row[];
  folders?: readonly Row[];
  tags?: readonly Row[];
  highlightTags?: readonly Row[];
  notes?: readonly Row[];
  decks?: readonly Row[];
  cards?: readonly Row[];
}

export interface Membership {
  bankId: string;
  bankName: string;
  /** Folder names from the bank root down; empty when filed directly in the bank. */
  folderPath: string[];
  folderId: string | null;
}

export interface HighlightView {
  id: string;
  quote: string;
  quoteHash: string;
  comment: string;
  kind: string;
  color: string;
  priority: number | null;
  heading: string | null;
  capturedAt: string | null;
  sourceTitle: string;
  /** http(s) only; null for local PDFs and anything unsafe. */
  sourceUrl: string | null;
  sourceType: string;
  page: number | null;
  textStart: number | null;
  textEnd: number | null;
  tags: string[];
  notes: { title: string; body: string; pinned: boolean }[];
  memberships: Membership[];
  customFields: Record<string, string | number | boolean>;
  deleted: boolean;
}

const byId = (rows: readonly Row[] | undefined): Map<string, Row> =>
  new Map((rows ?? []).map((r) => [str(r.id), r]));

const isDeleted = (r: Row | undefined): boolean => r !== undefined && r.deletedAt != null;

export const UNFILED = 'Unfiled';
const MAX_DEPTH = 8;

/**
 * Join the tables into one view per highlight, in a deterministic order (capture time, then id).
 * Soft-deleted highlights/banks/folders/tags/notes are left out unless `includeDeleted`.
 */
export function buildHighlightViews(
  data: ExportDataset,
  options: { includeDeleted?: boolean } = {},
): HighlightView[] {
  const all = options.includeDeleted === true;
  const live = <T extends Row>(r: T | undefined): r is T =>
    r !== undefined && (all || !isDeleted(r));
  const banks = byId(data.banks);
  const sources = byId(data.sources);
  const folders = byId(data.folders);
  const tags = byId(data.tags);

  const folderPath = (folderId: string | null): string[] => {
    const path: string[] = [];
    let cur = folderId;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      const f = folders.get(cur);
      if (!f) break;
      path.unshift(str(f.name));
      cur = strOrNull(f.parentFolderId);
    }
    return path;
  };

  const memberships = new Map<string, Membership[]>();
  for (const m of data.highlightBanks) {
    const bank = banks.get(str(m.bankId));
    if (!live(bank)) continue;
    const folderId = strOrNull(m.folderId);
    const folder = folderId ? folders.get(folderId) : undefined;
    const list = memberships.get(str(m.highlightId)) ?? [];
    list.push({
      bankId: str(bank.id),
      bankName: str(bank.name),
      folderPath: folder && live(folder) ? folderPath(folderId) : [],
      folderId: folder && live(folder) ? folderId : null,
    });
    memberships.set(str(m.highlightId), list);
  }

  const tagNames = new Map<string, string[]>();
  for (const l of data.highlightTags ?? []) {
    const tag = tags.get(str(l.tagId));
    if (!live(tag)) continue;
    const list = tagNames.get(str(l.highlightId)) ?? [];
    list.push(str(tag.name));
    tagNames.set(str(l.highlightId), list);
  }

  const notes = new Map<string, HighlightView['notes']>();
  for (const n of data.notes ?? []) {
    if (!live(n) || typeof n.highlightId !== 'string') continue;
    const list = notes.get(n.highlightId) ?? [];
    list.push({ title: str(n.title), body: str(n.body), pinned: n.pinned === true });
    notes.set(n.highlightId, list);
  }

  const views: HighlightView[] = [];
  for (const h of data.highlights) {
    if (!live(h)) continue;
    const id = str(h.id);
    const source = sources.get(str(h.sourceId));
    const anchor = (h.anchorSet ?? {}) as Row;
    const position = (anchor.textPosition ?? {}) as Row;
    const sourceUrl =
      safeHttpUrl(h.capturedUrl) ??
      safeHttpUrl(source?.canonicalUrl) ??
      safeHttpUrl(source?.originalUrl);
    const custom: Record<string, string | number | boolean> = {};
    if (typeof h.customFields === 'object' && h.customFields !== null) {
      for (const [k, v] of Object.entries(h.customFields)) {
        if (
          k !== '__proto__' &&
          (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        ) {
          custom[k] = v;
        }
      }
    }
    views.push({
      id,
      quote: str(h.exactQuote),
      quoteHash: str(h.quoteHash),
      comment: str(h.userComment),
      kind: str(h.kind),
      color: str(h.color),
      priority: num(h.priority),
      heading: strOrNull(h.headingContext),
      capturedAt: strOrNull(h.capturedAt),
      sourceTitle:
        str(h.capturedTitle) || str(source?.title) || str(source?.host) || 'Untitled source',
      sourceUrl,
      sourceType: str(source?.type) || str(anchor.type) || 'web',
      page: anchor.type === 'pdf' ? num(anchor.pageNumber) : null,
      textStart: num(position.start),
      textEnd: num(position.end),
      tags: [...new Set(tagNames.get(id) ?? [])],
      notes: notes.get(id) ?? [],
      memberships: memberships.get(id) ?? [],
      customFields: custom,
      deleted: isDeleted(h),
    });
  }
  views.sort(
    (a, b) =>
      (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '') ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return views;
}

/** "page 3" for PDFs, "text offset 4210–4247" for web pages, null when unknown. */
export function locationLabel(v: HighlightView): string | null {
  if (v.page !== null) return `page ${v.page}`;
  if (v.textStart !== null && v.textEnd !== null) return `text offset ${v.textStart}–${v.textEnd}`;
  return null;
}
