import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  PENDING_FOCUS_KEY,
  PENDING_FOCUS_MAX_AGE_MS,
  freshPendingFocus,
  type PendingFocus,
} from '@shared';
import { truncate, useLatest, useToast } from '@ui';

/**
 * The hand-over the service worker writes when the page overlay asks for a note
 * (`sidepanel.open`, ADR-005): scroll to that highlight and put the cursor in its note field.
 *
 * It is read when the panel mounts (the panel was closed and the request opened it) and on every
 * storage change (the panel was already open). The card may not be on screen yet, so the focus
 * step is retried after every render until the note field exists. An entry is acted on once, then
 * removed; an entry older than PENDING_FOCUS_MAX_AGE_MS is ignored and removed.
 */

const remove = () => void browser.storage.session.remove(PENDING_FOCUS_KEY).catch(() => undefined);

function findNote(highlightId: string): { note: HTMLTextAreaElement; quote: string } | null {
  for (const card of document.querySelectorAll<HTMLElement>('[data-highlight-id]')) {
    if (card.dataset.highlightId !== highlightId) continue;
    const note = card.querySelector('textarea');
    if (note) return { note, quote: card.querySelector('blockquote')?.textContent ?? '' };
  }
  return null;
}

/** `onRequest` runs when a request arrives, so the caller can switch to the view with the cards. */
export function usePendingFocus(onRequest: () => void): void {
  const [pending, setPending] = useState<PendingFocus | null>(null);
  const handled = useRef<string | null>(null);
  const request = useLatest(onRequest);
  const { announce } = useToast();

  useEffect(() => {
    let live = true;
    const take = (raw: unknown) => {
      if (!live) return;
      const fresh = freshPendingFocus(raw, Date.now());
      if (raw != null && fresh === null) remove(); // stale or malformed: drop it
      setPending(fresh);
      if (fresh !== null) request.current();
    };
    browser.storage.session.get(PENDING_FOCUS_KEY).then(
      (stored) => take(stored[PENDING_FOCUS_KEY]),
      () => undefined, // nothing to hand over is not an error
    );
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && PENDING_FOCUS_KEY in changes) {
        take(changes[PENDING_FOCUS_KEY]?.newValue);
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [request]);

  // A request whose highlight never shows up (another window's page, deleted meanwhile) expires.
  useEffect(() => {
    if (pending === null) return undefined;
    const left = Math.max(0, pending.at + PENDING_FOCUS_MAX_AGE_MS - Date.now());
    const timer = setTimeout(remove, left);
    return () => clearTimeout(timer);
  }, [pending]);

  // No dependency list on purpose: the card is rendered by other components, so this looks again
  // after every render. It does nothing unless a request is waiting and has not been handled.
  useEffect(() => {
    if (pending === null) return;
    const stamp = `${pending.at}:${pending.highlightId}`;
    if (handled.current === stamp) return;
    const found = findNote(pending.highlightId);
    if (found === null) return;
    const { note, quote } = found;
    handled.current = stamp;
    note.scrollIntoView?.({ block: 'center' });
    note.focus();
    note.setSelectionRange(note.value.length, note.value.length);
    // Focus moved because the page overlay asked for it: say where it went.
    announce(`Editing note for "${truncate(quote, 60)}"`);
    remove();
  });
}
