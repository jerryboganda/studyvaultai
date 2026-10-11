import { HIGHLIGHT_KINDS, type HighlightKind, type ResolveStatus } from '@shared';
import type { SearchField, SearchHit, Snippet } from '@search';
import { describeResolveState } from '@ui/resolveState';
import type { SearchHostState } from '@ui/vault';
import { revealAvailability, type RevealAvailability } from './model';

/** Search tab view model. Pure: what a hit shows and which actions it offers. */

export const SEARCH_PAGE = 20;
const QUOTE_PREVIEW_CHARS = 280;

const KINDS = new Set<string>(HIGHLIGHT_KINDS);
const STATUSES = new Set<string>(['unchecked', 'resolved', 'changed', 'ambiguous', 'orphaned']);

export interface SearchRow {
  /** Index document id (a note hit has its own id, distinct from its highlight's). */
  key: string;
  /** The highlight every action applies to; null for a note that is attached to nothing. */
  highlightId: string | null;
  docType: 'highlight' | 'note';
  kind: HighlightKind | null;
  resolveStatus: ResolveStatus | null;
  priority: number | null;
  /** Quote text with the matched words flagged (a note hit leads with the note's own text). */
  quote: Snippet;
  /** A second matching field (your note, a tag, ...) shown under the quote. */
  match: { field: SearchField; snippet: Snippet } | null;
  title: string;
  host: string;
  banks: string[];
  tags: string[];
  hasNote: boolean;
}

const plain = (text: string, max: number): Snippet => ({
  segments: [{ text: text.length > max ? text.slice(0, max).trimEnd() : text, match: false }],
  truncatedStart: false,
  truncatedEnd: text.length > max,
});

/**
 * Hits as rows. The same highlight can match through its quote and through each of its notes:
 * only the first (best-ranked) hit of a highlight is kept, so nothing is listed twice.
 */
export function rowsFromHits(hits: readonly SearchHit[]): SearchRow[] {
  const seen = new Set<string>();
  const rows: SearchRow[] = [];
  for (const hit of hits) {
    const doc = hit.doc;
    const highlightId = doc.highlightId ?? (doc.docType === 'highlight' ? doc.id : null);
    const identity = highlightId ?? doc.id;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const quote = hit.highlights.find((h) => h.field === 'quote');
    const other = hit.highlights.find(
      (h) => h.field !== 'quote' && h.segments.some((s) => s.match),
    );
    rows.push({
      key: doc.id,
      highlightId,
      docType: doc.docType,
      kind: KINDS.has(doc.kind) ? (doc.kind as HighlightKind) : null,
      resolveStatus: STATUSES.has(doc.resolveStatus) ? (doc.resolveStatus as ResolveStatus) : null,
      priority: KINDS.has(doc.kind) ? doc.priority : null,
      quote: quote ?? plain(doc.quote, QUOTE_PREVIEW_CHARS),
      match: other ? { field: other.field, snippet: other } : null,
      title: doc.title,
      host: doc.host ?? '',
      banks: [...doc.banks],
      tags: [...doc.tags],
      hasNote: doc.docType === 'note' || doc.comment.trim() !== '',
    });
  }
  return rows;
}

export const FIELD_LABELS: Record<SearchField, string> = {
  quote: 'quote',
  comment: 'your note',
  tags: 'tag',
  title: 'page title',
  headingContext: 'heading',
  banks: 'bank',
  folderPath: 'folder',
  host: 'site',
};

/**
 * "Show on page" for a hit: the page must be the active tab with StudyVault running, the highlight
 * must belong to it, and it must be one the page could place (ambiguous and orphaned ones are not
 * painted, so there is nothing to show).
 */
export function hitReveal(opts: {
  live: boolean;
  onActivePage: boolean;
  resolveStatus: ResolveStatus | null;
}): RevealAvailability {
  const base = revealAvailability({ live: opts.live, onActivePage: opts.onActivePage });
  if (!base.enabled) return base;
  if (opts.resolveStatus && describeResolveState(opts.resolveStatus).attention) {
    return {
      enabled: false,
      reason: 'This highlight could not be placed on the page, so it is not painted there.',
    };
  }
  return base;
}

export interface IndexNote {
  tone: 'info' | 'warning' | 'error';
  text: string;
  /** Real counts while the index is built; `total` is null when the vault cannot say how many. */
  progress: { done: number; total: number | null } | null;
  /** Searches can be answered (possibly from an index that is still catching up). */
  usable: boolean;
  /** Offer Retry / Rebuild. */
  failed: boolean;
}

/** One honest sentence about the index, or null when it is simply ready. */
export function describeIndex(state: SearchHostState): IndexNote | null {
  switch (state.phase) {
    case 'idle':
    case 'restoring':
      return {
        tone: 'info',
        text: 'Opening the search index…',
        progress: null,
        usable: false,
        failed: false,
      };
    case 'building': {
      const why =
        state.reason === 'purge'
          ? 'Items were permanently deleted, so the search index is being rebuilt'
          : state.reason === 'requested'
            ? 'Rebuilding the search index'
            : 'Building the search index';
      const counted =
        state.total !== null && state.total > 0
          ? `${state.done.toLocaleString()} of ${state.total.toLocaleString()}`
          : `${state.done.toLocaleString()} so far`;
      return {
        tone: 'info',
        text: `${why}: ${counted}. Search answers when this finishes.`,
        progress: { done: state.done, total: state.total },
        usable: false,
        failed: false,
      };
    }
    case 'updating':
      return {
        tone: 'info',
        text: 'Catching up with your latest changes. Results may not include them yet.',
        progress: null,
        usable: true,
        failed: false,
      };
    case 'error':
      return {
        tone: 'error',
        text: `Search is unavailable: ${state.message}`,
        progress: null,
        usable: false,
        failed: true,
      };
    case 'ready':
      return state.rejected > 0
        ? {
            tone: 'warning',
            text: `${state.rejected.toLocaleString()} ${state.rejected === 1 ? 'item' : 'items'} could not be indexed and will not appear in search.`,
            progress: null,
            usable: true,
            failed: false,
          }
        : null;
  }
}
