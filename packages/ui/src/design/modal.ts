import { useEffect, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden], [inert]'),
  );
}

/** Keeps Tab and Shift+Tab inside `root` (explicit, so it holds where showModal is missing). */
export function trapTab(e: KeyboardEvent, root: HTMLElement) {
  if (e.key !== 'Tab') return;
  const items = focusables(root);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Shows a native <dialog> as modal for as long as it is mounted (page behind inert, top layer,
 * ::backdrop) and gives focus back to the control that opened it when it unmounts.
 */
export function useModalDialog(ref: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // jsdom (unit tests) predates showModal; the open attribute is the same visible state.
    if (typeof el.showModal === 'function') {
      if (!el.open) el.showModal();
    } else el.setAttribute('open', '');
    return () => {
      if (typeof el.close === 'function' && el.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}
