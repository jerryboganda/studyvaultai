import { z } from 'zod';
import { Id } from './schema';

/**
 * What the service worker remembers about auto-filing for one highlight, in chrome.storage.session
 * (docs/adr/017-filing-rules.md): a suggestion that waits for the person, and the record that lets
 * "Undo" put a highlight back where it was. Session storage survives the worker being suspended and
 * is cleared when the browser closes, so a suggestion is never older than one browser session; it
 * is never synced, backed up or written to the database, and "Delete all data" clears it.
 *
 * A page (content script) only ever names a highlight id; these records say where it goes, so a
 * page cannot pick a bank.
 */

export const FILING_SUGGESTION_PREFIX = 'sv.filing.suggest.';
export const FILING_UNDO_PREFIX = 'sv.filing.undo.';

export const filingSuggestionKey = (highlightId: string): string =>
  `${FILING_SUGGESTION_PREFIX}${highlightId}`;
export const filingUndoKey = (highlightId: string): string =>
  `${FILING_UNDO_PREFIX}${highlightId}`;

/** A record this old is ignored and removed (a toast is gone in seconds; the chip needs a day). */
export const FILING_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Most records kept of each kind; the oldest go first. */
export const FILING_SESSION_MAX_RECORDS = 100;

export const FilingSuggestion = z.object({
  highlightId: Id,
  /** Date.now() when it was made. */
  at: z.number(),
  ruleName: z.string().max(200),
  /** The placement to apply: exactly what the person was shown. */
  bankId: Id,
  bankName: z.string().max(200),
  folderId: Id.nullable(),
  folderName: z.string().max(200).nullable(),
  addTagIds: z.array(Id).max(100),
});
export type FilingSuggestion = z.infer<typeof FilingSuggestion>;

export const FilingUndoRecord = z.object({
  highlightId: Id,
  at: z.number(),
  /** Where filing put the highlight. Undo only acts while it is still exactly there. */
  bankId: Id,
  folderId: Id.nullable(),
  /** The memberships it had before. */
  previous: z.array(z.object({ bankId: Id, folderId: Id.nullable(), addedAt: z.string() })).max(100),
  /** The tags filing linked (tags the highlight already had are not listed). */
  addedTagIds: z.array(Id).max(100),
});
export type FilingUndoRecord = z.infer<typeof FilingUndoRecord>;
