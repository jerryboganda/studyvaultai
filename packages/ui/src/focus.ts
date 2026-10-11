import { useCallback, useLayoutEffect, useRef } from 'react';

/** Places lost focus may land: the named regions around the control that had it. */
const HOME =
  '[data-focus-home], dialog, [role="dialog"], [role="tabpanel"], section, article, main, aside, nav';

/**
 * Hands focus on when the control that has it is removed from the page (a deleted chip, a toolbar
 * that closes because its own button was pressed). The browser then drops focus on <body> and a
 * keyboard or screen-reader user starts again from the top of the page (WCAG 2.4.3).
 *
 * Returns a ref callback for the element that holds the controls. Only a loss is repaired: focus
 * that moved anywhere else (a dialog, another control) is left alone. Without `pick` focus goes to
 * the innermost region around the control that is still on the page (it is given tabindex="-1" if
 * it has none, so it can take focus without joining the Tab order); `pick` may name a better place
 * for that control and returns null to take the region.
 */
export function useFocusRescue(pick?: (lost: HTMLElement) => HTMLElement | null | undefined) {
  const choose = useRef(pick);
  useLayoutEffect(() => {
    choose.current = pick;
  });

  return useCallback((root: HTMLElement | null) => {
    if (!root) return undefined;
    let last: HTMLElement | null = null;
    let homes: HTMLElement[] = [];

    const observer = new MutationObserver(() => {
      if (last === null || last.isConnected) return;
      const lost = last;
      const region = homes.find((h) => h.isConnected);
      last = null;
      homes = [];
      observer.disconnect();
      const active = document.activeElement;
      if (active !== null && active !== document.body) return; // focus went somewhere on purpose
      const target = choose.current?.(lost) ?? region ?? root;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });

    // Watching costs something on a busy page (a PDF text layer), so only while a control has focus.
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLElement)) return;
      last = e.target;
      homes = [];
      for (let el = last.parentElement; el && el !== root; el = el.parentElement) {
        if (el.matches(HOME)) homes.push(el);
      }
      observer.observe(root, { childList: true, subtree: true });
    };
    // Chrome reports the removal of a focused control as a blur too; only a control that is still in
    // the page afterwards has been left on purpose.
    const onFocusOut = (e: FocusEvent) => {
      const left = e.target;
      queueMicrotask(() => {
        if (last !== null && last === left && last.isConnected) {
          last = null;
          homes = [];
          observer.disconnect();
        }
      });
    };

    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      observer.disconnect();
    };
  }, []);
}
