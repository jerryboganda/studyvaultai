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

/** `?view=chat` opens the chat view, `?view=graph` the graph; anything else is the highlight list. */
export function parseViewLink(search: string): 'chat' | 'graph' | 'syllabus' | 'rules' | null {
  const view = new URLSearchParams(search).get('view');
  return view === 'chat' || view === 'graph' || view === 'syllabus' || view === 'rules'
    ? view
    : null;
}

/** `?view=syllabus&syllabus=<id>`: which syllabus the editor opens on (an id-shaped value only). */
export function parseSyllabusLink(search: string): string | null {
  const id = new URLSearchParams(search).get('syllabus');
  return id !== null && ID.test(id) ? id : null;
}

export { dashboardPath } from '@ui/vault/dashboardLink';
