import { STUDYVAULT_SYNC_POLICY, type SyncPolicy } from '@sync';

/**
 * What the consent screen says is uploaded, generated from the sync policy (`STUDYVAULT_SYNC_POLICY`,
 * itself checked against the registered schemas) instead of being written by hand: a table that
 * joins the policy shows up here, and `consent.test.ts` fails until it has a plain-language label.
 * A table without a label is still listed, under its raw name, so nothing is ever hidden.
 */

export type SyncedGroupId =
  'highlights' | 'pages' | 'organisation' | 'notes' | 'flashcards' | 'history' | 'pdfs' | 'scans';

/** Policy table (IndexedDB table name) -> the group the consent screen shows it under. */
export const TABLE_GROUP: Readonly<Record<string, SyncedGroupId>> = {
  highlights: 'highlights',
  sources: 'pages',
  banks: 'organisation',
  folders: 'organisation',
  tags: 'organisation',
  highlightBanks: 'organisation',
  highlightTags: 'organisation',
  filingRules: 'organisation',
  syllabi: 'organisation',
  relations: 'organisation',
  notes: 'notes',
  knowledgePoints: 'flashcards',
  decks: 'flashcards',
  cards: 'flashcards',
  reviewLogs: 'history',
  documents: 'pdfs',
  ocrPages: 'scans',
};

export const GROUP_TEXT: Readonly<Record<SyncedGroupId, { label: string; detail: string }>> = {
  highlights: {
    label: 'Highlights',
    detail:
      'every saved quote with its position on the page, the address and title of the page as it was when you saved it, your comment, colour, priority and custom fields.',
  },
  pages: {
    label: 'Page addresses and titles',
    detail:
      'the address (as visited and the page’s own), the site name and the title of every page you highlighted.',
  },
  organisation: {
    label: 'Banks, folders and tags',
    detail:
      'their names and structure, which highlights are in which bank or carry which tag, your auto-filing rules (their conditions and targets), your syllabus outlines and the links you drew between highlights, notes and knowledge points.',
  },
  notes: { label: 'Notes', detail: 'the title and text of every note.' },
  flashcards: {
    label: 'Flashcards',
    detail:
      'knowledge points, decks and cards: the questions, answers, explanations and the deck settings.',
  },
  history: {
    label: 'Review history',
    detail: 'every answer you gave to a flashcard: when, how you rated it and how long you took.',
  },
  pdfs: {
    label: 'PDF details',
    detail:
      'the title, number of pages and size of each PDF, and the web address it was opened from. The PDF file itself is never sent.',
  },
  scans: {
    label: 'Text recognised in scanned PDF pages',
    detail:
      'the whole recognised text of each page, your corrections, and the position of every word.',
  },
};

export interface SyncedGroup {
  id: SyncedGroupId | 'other';
  label: string;
  detail: string;
  /** The tables (record types) behind this entry. */
  tables: string[];
}

export function syncedGroups(policy: SyncPolicy = STUDYVAULT_SYNC_POLICY): {
  groups: SyncedGroup[];
  /** Policy tables that have no label yet (the test requires this to be empty). */
  unlabelled: string[];
} {
  const order = Object.keys(GROUP_TEXT) as SyncedGroupId[];
  const byGroup = new Map<SyncedGroupId, string[]>();
  const unlabelled: string[] = [];
  for (const table of Object.keys(policy)) {
    const group = TABLE_GROUP[table];
    if (!group) {
      unlabelled.push(table);
      continue;
    }
    byGroup.set(group, [...(byGroup.get(group) ?? []), table]);
  }
  const groups: SyncedGroup[] = order
    .filter((id) => byGroup.has(id))
    .map((id) => ({ id, ...GROUP_TEXT[id], tables: byGroup.get(id)! }));
  if (unlabelled.length > 0) {
    groups.push({
      id: 'other',
      label: 'Other data',
      detail: `the stored items of these types: ${unlabelled.join(', ')}.`,
      tables: unlabelled,
    });
  }
  return { groups, unlabelled };
}

/** What stays on this device, whatever the setting. */
export const NEVER_UPLOADED =
  'The PDF files themselves, your settings and deny list, your AI settings, key and results, the search index and every page you did not save from.';

/**
 * What the server (and its operator) still learns when everything is end-to-end encrypted: the kind
 * of each item, its id, whether it was created, changed or deleted, a revision number, when, and
 * how big it is. For scanned-page text and PDF details the id contains the file's fingerprint (and
 * the page number).
 */
export const SERVER_STILL_SEES =
  'With a passphrase the server cannot read the content, but it still sees which kinds of items you have, their ids, whether each was created, changed or deleted, when, and how big it is. For PDFs and scanned pages the id contains the file’s fingerprint and the page number.';

/** The sign-in provider is a different party from the sync server. */
export const PROVIDER_LEARNS =
  'The sign-in provider learns that this extension signs in to sync, and when. It does not receive your study data.';
