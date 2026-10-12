import { z } from 'zod';
import { Id } from './schema';

/**
 * Hand-over from the service worker to the side panel (chrome.storage.session, PENDING_FOCUS_KEY):
 * "scroll to this highlight and focus its note". The page overlay has no text input of its own
 * (ADR-005), so notes are typed in the panel.
 */
export const PendingFocus = z.object({ highlightId: Id, at: z.number() });
export type PendingFocus = z.infer<typeof PendingFocus>;

/** A panel that opens much later must not jump to a highlight the user asked for long ago. */
export const PENDING_FOCUS_MAX_AGE_MS = 30_000;

/** The hand-over if `raw` is a well-formed entry no older than the maximum age, else null. */
export function freshPendingFocus(raw: unknown, now: number): PendingFocus | null {
  const parsed = PendingFocus.safeParse(raw);
  if (!parsed.success) return null;
  const age = now - parsed.data.at;
  // A negative age is a clock that moved; keep it rather than lose the hand-over.
  return age <= PENDING_FOCUS_MAX_AGE_MS ? parsed.data : null;
}

/**
 * Hand-over for the manifest command "focus-search" (chrome.storage.session, PENDING_SEARCH_KEY):
 * "put the keyboard in your search box". The service worker writes it after opening the side panel
 * (target `panel`) or, when the dashboard is the page in front, for the dashboard itself. Like
 * PendingFocus it is read when the surface mounts and on every change, acted on once and removed.
 */
export const PENDING_SEARCH_KEY = 'sv.pendingSearch';

export const SearchFocusTarget = z.enum(['panel', 'dashboard']);
export type SearchFocusTarget = z.infer<typeof SearchFocusTarget>;

export const PendingSearch = z.object({ target: SearchFocusTarget, at: z.number() });
export type PendingSearch = z.infer<typeof PendingSearch>;

/**
 * What a surface does with the stored value: act on it (`mine`), leave it for the other surface
 * (`other`), or remove it (`drop`: malformed, or older than PENDING_FOCUS_MAX_AGE_MS).
 */
export function classifySearchRequest(
  raw: unknown,
  now: number,
  mine: SearchFocusTarget,
): 'mine' | 'other' | 'drop' {
  const parsed = PendingSearch.safeParse(raw);
  if (!parsed.success || now - parsed.data.at > PENDING_FOCUS_MAX_AGE_MS) return 'drop';
  return parsed.data.target === mine ? 'mine' : 'other';
}
