import { HOST_ATTRIBUTE, streamTextOfRange, type TextStream } from '@highlights';
import { MAX_QUOTE_CHARS, type HtmlAnchorSet } from '@shared';

const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
/** EDITABLE minus hidden inputs (no text, no UI), for finding editors a selection passes through. */
const SPANNED = EDITABLE.replace('input,', 'input:not([type="hidden"]),');

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

/**
 * An editing surface made by CSS alone: Chromium's `-webkit-user-modify` is inherited, so the
 * computed value on the element already answers for its ancestors. `contenteditable`, `:read-write`
 * and `isContentEditable` all say "no" for these, and no attribute selector can find them.
 */
function isCssEditable(el: Element): boolean {
  try {
    const value = el.ownerDocument.defaultView
      ?.getComputedStyle(el)
      .getPropertyValue('-webkit-user-modify');
    return value === 'read-write' || value === 'read-write-plaintext-only';
  } catch {
    return false;
  }
}

/** Form fields, rich-text editors and ARIA text boxes: never captured (privacy, and anchors there are meaningless). */
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  return (
    (el as HTMLElement).isContentEditable === true ||
    el.closest(EDITABLE) !== null ||
    isCssEditable(el)
  );
}

/** The focused element, looking through open shadow roots; null while focus is in our overlay. */
function focusedElement(doc: Document): Element | null {
  let el = doc.activeElement;
  if (isInsideHost(el)) return null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * Chromium reports text selected inside <input>/<textarea> as a COLLAPSED document selection, so
 * "selected in a field" is told apart from "nothing selected" by the field's own offsets. Only
 * offsets are read, never the value.
 */
function hasFieldSelection(el: Element | null): boolean {
  try {
    const field = el as HTMLInputElement | null;
    return typeof field?.selectionStart === 'number' && field.selectionStart !== field.selectionEnd;
  } catch {
    return false; // input types without a text selection throw on some engines
  }
}

const sizeOf = (n: Node): number =>
  n.nodeType === 1 || n.nodeType === 9 || n.nodeType === 11
    ? n.childNodes.length
    : (n as CharacterData).length;

const indexIn = (n: Node): number => Array.prototype.indexOf.call(n.parentNode!.childNodes, n);

/**
 * The same selected content with its boundary points moved out of nodes they only touch. A
 * triple-click on a paragraph ends at offset 0 of the next block (`<div contenteditable>`, 0): that
 * boundary lies INSIDE the editor yet takes none of it, so it is moved to just before the editor.
 * Likewise a start at the very end of a node moves to just after it. Only moves across positions
 * that hold no content, so what the range selects is unchanged.
 */
function withoutTouchedEdges(range: Range): Range {
  let end = { node: range.endContainer, offset: range.endOffset };
  while (end.offset === 0 && end.node.parentNode) {
    end = { offset: indexIn(end.node), node: end.node.parentNode };
  }
  let start = { node: range.startContainer, offset: range.startOffset };
  while (start.offset === sizeOf(start.node) && start.node.parentNode) {
    start = { offset: indexIn(start.node) + 1, node: start.node.parentNode };
  }
  const core = range.cloneRange();
  core.setEnd(end.node, end.offset);
  core.setStart(start.node, start.offset);
  return core;
}

/**
 * Does the range pass through a form field or editor? The ends and the common ancestor are
 * checked by the caller; this catches a drag or Select All whose ends are plain text but whose
 * middle holds an editor, the text of which `Selection.toString()` would carry into the quote.
 * A range that only touches a field's edge does not intersect it.
 */
function spansEditable(range: Range): boolean {
  const scope = range.commonAncestorContainer as Partial<ParentNode>;
  if (typeof scope.querySelectorAll !== 'function') return false;
  if (Array.from(scope.querySelectorAll(SPANNED)).some((el) => range.intersectsNode(el))) {
    return true;
  }
  // CSS-only editors carry nothing to select on: ask the style of the text the range takes in.
  const root = range.commonAncestorContainer;
  const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  const seen = new Set<Element>();
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const owner = text.parentElement;
    if (!owner || seen.has(owner) || !range.intersectsNode(text)) continue;
    seen.add(owner);
    if (isCssEditable(owner)) return true;
  }
  return false;
}

/** The cheap checks: designMode, focus, and where the selection starts, ends and lives. */
function isEditableAtEdges(doc: Document, sel: Selection, range: Range, core: Range): boolean {
  if (doc.designMode === 'on') return true;
  // Text selected inside <input>/<textarea> is reported with the field's parent as anchor, so the
  // focused element is the reliable signal.
  if (isEditableElement(focusedElement(doc))) return true;
  // A shadow-retargeted anchor/focus is not one of the range's own boundary points.
  const retargeted = [sel.anchorNode, sel.focusNode].filter(
    (n) => n !== range.startContainer && n !== range.endContainer,
  );
  const edges = [
    ...retargeted,
    core.startContainer,
    core.endContainer,
    core.commonAncestorContainer,
  ];
  return edges.some((n) => isEditableElement(elementOf(n)));
}

/**
 * Is the user typing in, or about to type in, an editing surface? Keyboard shortcuts that could
 * collide with typed characters stay out of the way there. `target` is the key event's target.
 * The selection is not consulted: a caret or selection in an editor always comes with focus, while
 * a stale selection left in a field the user has tabbed out of would silence the shortcut.
 */
export function isEditingContext(doc: Document, target: EventTarget | null = null): boolean {
  if (doc.designMode === 'on') return true;
  if (target instanceof Element && isEditableElement(target)) return true;
  return isEditableElement(focusedElement(doc));
}

/**
 * Is the page's current selection something the toolbar / quick-save may capture?
 * The returned range is cloned here, before any UI can move focus and collapse the selection.
 */
export function inspectSelection(doc: Document): SelectionVerdict {
  if (hasFieldSelection(focusedElement(doc))) return { ok: false, reason: 'editable' };
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { ok: false, reason: 'no-selection' };
  const range = sel.getRangeAt(0);
  if ([sel.anchorNode, sel.focusNode, range.commonAncestorContainer].some(isInsideHost)) {
    return { ok: false, reason: 'own-ui' };
  }
  const core = withoutTouchedEdges(range);
  if (isEditableAtEdges(doc, sel, range, core)) return { ok: false, reason: 'editable' };
  const text = sel.toString().trim();
  // A selection too long to save is refused below; scanning it for editors would only cost time
  // (Ctrl+A on a long page).
  if (text.length <= MAX_QUOTE_CHARS && spansEditable(core)) {
    return { ok: false, reason: 'editable' };
  }
  if (text.length === 0) return { ok: false, reason: 'no-selection' };
  if (text.length > MAX_QUOTE_CHARS) return { ok: false, reason: 'too-long' };
  // Independent walk over the range only (not the document): an anchor needs stream text.
  if (streamTextOfRange(range).trim().length === 0) return { ok: false, reason: 'unreadable' };
  return { ok: true, range: range.cloneRange(), text };
}

/**
 * An anchor's prefix/suffix are the stream text beside the quote. A highlight that ends next to an
 * editor (a comment box under the article) would store the first characters of the user's draft in
 * its context. Cuts the context where editor text begins; a shorter context is what a quote at the
 * start or end of a document already has, so it still resolves.
 */
export function withoutEditableContext(anchor: HtmlAnchorSet, stream: TextStream): HtmlAnchorSet {
  const { prefix, suffix } = anchor.textQuote;
  const { start, end } = anchor.textPosition;
  const from = start - prefix.length;
  const to = end + suffix.length;
  let keepFrom = from;
  let keepTo = to;
  for (const seg of stream.segments) {
    if (seg.streamEnd <= from) continue;
    if (seg.streamStart >= to) break;
    const before = seg.streamEnd <= start;
    const after = seg.streamStart >= end;
    // Quote text was vetted by inspectSelection; asking the style engine is for the context only.
    if (!(before || after) || !isEditableElement(seg.node.parentElement)) continue;
    if (before) keepFrom = Math.max(keepFrom, seg.streamEnd);
    else keepTo = Math.min(keepTo, seg.streamStart);
  }
  if (keepFrom === from && keepTo === to) return anchor;
  return {
    ...anchor,
    textQuote: {
      ...anchor.textQuote,
      prefix: prefix.slice(keepFrom - from),
      suffix: suffix.slice(0, keepTo - end),
    },
  };
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
