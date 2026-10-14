/**
 * How the dashboard is opened and what it reads from its own address.
 *
 *   dashboard.html?highlight=<id>   open with this highlight in the preview
 *   dashboard.html?bank=<id>        open scoped to a bank
 *   dashboard.html?q=<query>        open with a search
 *
 * The address is untrusted input (any web page can try to open an extension URL it knows): ids must
 * look like ids and the query is bounded; nothing here is executed or rendered as markup.
 */
import { MAX_QUERY_LENGTH } from '@search';

const ID = /^[0-9A-Za-z_-]{8,64}$/;

export interface DeepLink {
  highlight: string | null;
  bank: string | null;
  q: string | null;
}

export function parseDeepLink(search: string): DeepLink {
  const params = new URLSearchParams(search);
  const id = (name: string) => {
    const value = params.get(name);
    return value !== null && ID.test(value) ? value : null;
  };
  const q = params.get('q');
  return {
    highlight: id('highlight'),
    bank: id('bank'),
    q: q !== null && q.trim() !== '' ? q.slice(0, MAX_QUERY_LENGTH) : null,
  };
}

/** Every view that has an address (`?view=`). */
export const LINKED_VIEWS = [
  'home',
  'library',
  'more',
  'chat',
  'graph',
  'syllabus',
  'rules',
  'duplicates',
  'trash',
  'storage',
] as const;
export type LinkedView = (typeof LINKED_VIEWS)[number];

/** `?view=chat` opens the chat view, `?view=library` the highlight list; null for anything else. */
export function parseViewLink(search: string): LinkedView | null {
  const view = new URLSearchParams(search).get('view');
  return (LINKED_VIEWS as readonly string[]).includes(view ?? '') ? (view as LinkedView) : null;
}

/** The view a page opens on: `?view=`, else the list for a highlight, bank or query link, else Home. */
export function initialView(search: string): LinkedView {
  const link = parseDeepLink(search);
  return (
    parseViewLink(search) ?? (link.highlight || link.bank || link.q !== null ? 'library' : 'home')
  );
}

/** `?view=syllabus&syllabus=<id>`: which syllabus the editor opens on (an id-shaped value only). */
export function parseSyllabusLink(search: string): string | null {
  const id = new URLSearchParams(search).get('syllabus');
  return id !== null && ID.test(id) ? id : null;
}

export { dashboardPath } from '@ui/vault/dashboardLink';
