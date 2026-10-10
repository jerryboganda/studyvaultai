import { HOST_ATTRIBUTE, streamTextOfRange } from '@highlights';
import { MAX_QUOTE_CHARS } from '@shared';

const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

export type Ineligible =
  | 'no-selection'
  | 'editable'
  | 'own-ui'
  | 'too-long'
  /** Text is selected but none of it is in the text stream (shadow DOM, svg, form controls). */
  | 'unreadable';

export type SelectionVerdict =
  | {
      ok: true;
      /** A clone: stays valid after the page selection moves. */ range: Range;
      text: string;
    }
  | { ok: false; reason: Ineligible };

export function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** True for our overlay host and anything inside it. */
export function isInsideHost(node: Node | null): boolean {
  return elementOf(node)?.closest(`[${HOST_ATTRIBUTE}]`) != null;
}

/** Form fields, rich-text editors and ARIA text boxes: never captured (privacy, and anchors there are meaningless). */
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  return (el as HTMLElement).isContentEditable === true || el.closest(EDITABLE) !== null;
}

function isEditableContext(doc: Document, sel: Selection, range: Range): boolean {
  if (doc.designMode === 'on') return true;
  // Text selected inside <input>/<textarea> is reported with the field's parent as anchor, so the
  // focused element is the reliable signal.
  if (isEditableElement(doc.activeElement)) return true;
  return [sel.anchorNode, sel.focusNode, range.commonAncestorContainer].some((n) =>
    isEditableElement(elementOf(n)),
  );
}

/**
 * Is the page's current selection something the toolbar / quick-save may capture?
 * The returned range is cloned here, before any UI can move focus and collapse the selection.
 */
export function inspectSelection(doc: Document): SelectionVerdict {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { ok: false, reason: 'no-selection' };
  const range = sel.getRangeAt(0);
  if ([sel.anchorNode, sel.focusNode, range.commonAncestorContainer].some(isInsideHost)) {
    return { ok: false, reason: 'own-ui' };
  }
  if (isEditableContext(doc, sel, range)) return { ok: false, reason: 'editable' };
  const text = sel.toString().trim();
  if (text.length === 0) return { ok: false, reason: 'no-selection' };
  if (text.length > MAX_QUOTE_CHARS) return { ok: false, reason: 'too-long' };
  // Independent walk over the range only (not the document): an anchor needs stream text.
  if (streamTextOfRange(range).trim().length === 0) return { ok: false, reason: 'unreadable' };
  return { ok: true, range: range.cloneRange(), text };
}

export function sameRange(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

const ZERO_RECT = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  toJSON: () => ({}),
} as DOMRect;

/** A zero-size rect at a viewport point (popover anchor when the range has no geometry). */
export function rectAt(x: number, y: number): DOMRect {
  return { ...ZERO_RECT, x, y, left: x, right: x, top: y, bottom: y } as DOMRect;
}

/** Bounding rect of a range; zeros where the environment has no layout (jsdom). */
export function rectOf(range: Range): DOMRect {
  try {
    if (typeof range.getBoundingClientRect === 'function') return range.getBoundingClientRect();
  } catch {
    // detached range
  }
  return ZERO_RECT;
}
