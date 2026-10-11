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
