/**
 * "The selection changed", turned into one evaluation after a short pause, and held back while a
 * pointer button is down.
 *
 * The save bar is shown from the evaluated selection. Evaluating mid-drag put the bar on screen
 * under the pointer, so the rest of the drag selected the bar's own text and ran on into the next
 * page (a saved quote that was not the one the person chose). A drag is evaluated once, when the
 * button is released; keyboard, double-click and programmatic selections have no button held and
 * are evaluated after the pause as before.
 */

export interface SelectionGate {
  /** Call on every `selectionchange`. */
  notify(): void;
  dispose(): void;
}

export function createSelectionGate(
  doc: Document,
  evaluate: () => void,
  delayMs = 80,
): SelectionGate {
  const view = doc.defaultView;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let down = false;

  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(evaluate, delayMs);
  };
  const notify = (): void => {
    if (down) return; // evaluated on release
    schedule();
  };
  const press = (e: Event): void => {
    // Only the primary button selects text; a right-click menu must not hold the bar back.
    if ((e as PointerEvent).button === 0) down = true;
  };
  const release = (): void => {
    if (!down) return;
    down = false;
    schedule();
  };
  // A pointer that moves with no button held means the release was missed (outside the window).
  const move = (e: Event): void => {
    if (down && (e as PointerEvent).buttons === 0) release();
  };

  doc.addEventListener('pointerdown', press, true);
  doc.addEventListener('pointerup', release, true);
  doc.addEventListener('pointercancel', release, true);
  doc.addEventListener('pointermove', move, true);
  view?.addEventListener('blur', release);

  return {
    notify,
    dispose: () => {
      clearTimeout(timer);
      doc.removeEventListener('pointerdown', press, true);
      doc.removeEventListener('pointerup', release, true);
      doc.removeEventListener('pointercancel', release, true);
      doc.removeEventListener('pointermove', move, true);
      view?.removeEventListener('blur', release);
    },
  };
}
