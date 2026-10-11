/**
 * "The selection changed", turned into one evaluation after a short pause, and held back while the
 * primary pointer button is down.
 *
 * The save bar is shown from the evaluated selection. Evaluating mid-drag put the bar on screen
 * under the pointer, so the rest of the drag selected the bar's own text and ran on into the next
 * page (a saved quote that was not the one the person chose). A drag is evaluated once, when the
 * button is released; keyboard, double-click and programmatic selections have no button held and
 * are evaluated after the pause as before.
 *
 * Built to be wrong in only one direction. Only signals that cannot lie decide the state:
 *  - held:     a primary-button press (`pointerdown`/`mousedown`), or a move that reports the button
 *              down (`buttons & 1`). A pending evaluation is cancelled the moment the hold starts.
 *  - released: the primary button's `pointerup`/`mouseup`, a `pointercancel`, or a `dragend`.
 * A move that reports `buttons === 0` and a window `blur` are deliberately NOT release signals: the
 * browser also dispatches those mid-drag (synthetic moves after a layout change or an auto-scroll,
 * focus changes), and reading them as "released" is what put the bar under the pointer.
 * A release that is never seen (outside the window, a lost event) cannot hold the bar back for
 * longer than `valveMs`: once nothing has happened for that long the selection is evaluated anyway.
 *
 * Second line of defence: while a drag that began in the page's text is active the root element
 * carries `data-sv-drag`, and the save bar (reader.css) then ignores the pointer. If the bar is ever
 * on screen mid-drag, the drag still selects the page's text. A press on the bar itself never sets
 * the mark (its own click must land). The mark is removed with the hold, and after `valveMs` of quiet.
 */

export interface SelectionGate {
  /** Call on every `selectionchange`. */
  notify(): void;
  dispose(): void;
}

export interface SelectionGateOptions {
  /** Quiet time after the last change before the selection is evaluated. */
  delayMs?: number;
  /** Longest a held button keeps a still selection from being evaluated. */
  valveMs?: number;
}

/** Attribute set on the root element while a drag is active; reader.css reads it. */
export const DRAG_ATTRIBUTE = 'data-sv-drag';
/** Where a press starts a drag worth protecting: the text of a page. */
const TEXT_SELECTOR = '.sv-textlayer';

export function createSelectionGate(
  doc: Document,
  evaluate: () => void,
  { delayMs = 80, valveMs = 1500 }: SelectionGateOptions = {},
): SelectionGate {
  const root = doc.documentElement;
  let held = false;
  /** The press began in a page's text: the bar must let the pointer through while it is held. */
  let textDrag = false;
  let pause: ReturnType<typeof setTimeout> | undefined;
  let valve: ReturnType<typeof setTimeout> | undefined;

  const mark = (on: boolean): void => {
    if (on) root.setAttribute(DRAG_ATTRIBUTE, '');
    else root.removeAttribute(DRAG_ATTRIBUTE);
  };
  const stopPause = (): void => {
    clearTimeout(pause);
    pause = undefined;
  };
  const stopValve = (): void => {
    clearTimeout(valve);
    valve = undefined;
  };
  const evaluateAfterPause = (): void => {
    stopPause();
    pause = setTimeout(() => {
      pause = undefined;
      evaluate();
    }, delayMs);
  };
  /** Something happened under a held button: wait for it to go quiet before evaluating. */
  const armValve = (): void => {
    mark(textDrag);
    stopValve();
    valve = setTimeout(() => {
      valve = undefined;
      stopPause();
      mark(false); // quiet: the bar may take pointer events again
      evaluate(); // still held, still quiet: do not wait for an event that may never come
    }, valveMs);
  };
  const hold = (fromText: boolean): void => {
    held = true;
    textDrag = fromText;
    stopPause(); // an evaluation that was already waiting must not fire under the drag
    armValve();
  };
  const letGo = (): void => {
    if (!held) return;
    held = false;
    textDrag = false;
    stopValve();
    mark(false);
    evaluateAfterPause();
  };

  const onPress = (e: Event): void => {
    if ((e as MouseEvent).button !== 0) return;
    const target = e.target as Element | null;
    hold(typeof target?.closest === 'function' && target.closest(TEXT_SELECTOR) !== null);
  };
  const onMove = (e: Event): void => {
    if (((e as MouseEvent).buttons & 1) === 0) return;
    // Still dragging is not quiet; and a press that was missed is noticed here.
    if (held) armValve();
    else hold(false);
  };
  const onRelease = (e: Event): void => {
    // Another button's release (a context menu) says nothing about the primary one.
    if (e.type === 'pointercancel' || e.type === 'dragend' || (e as MouseEvent).button === 0) {
      letGo();
    }
  };

  const listeners: Array<[string, (e: Event) => void]> = [
    ['pointerdown', onPress],
    ['mousedown', onPress],
    ['pointermove', onMove],
    ['mousemove', onMove],
    ['pointerup', onRelease],
    ['mouseup', onRelease],
    ['pointercancel', onRelease],
    ['dragend', onRelease],
  ];
  for (const [type, fn] of listeners) doc.addEventListener(type, fn, true);

  return {
    notify: () => {
      if (held) armValve();
      else evaluateAfterPause();
    },
    dispose: () => {
      stopPause();
      stopValve();
      mark(false);
      for (const [type, fn] of listeners) doc.removeEventListener(type, fn, true);
    },
  };
}
