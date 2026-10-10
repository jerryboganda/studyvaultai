import { cyrb53Hex } from './hash';
import type { TextSegment, TextStream } from './types';

// Node.DOCUMENT_POSITION_* / nodeType values, inlined so this file has no global-constructor dependency.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const POSITION_PRECEDING = 2;
const POSITION_CONTAINED_BY = 16;

/** The StudyVault overlay host carries this attribute; its subtree never enters the stream. */
export const HOST_ATTRIBUTE = 'data-studyvault';

const SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'textarea',
  'select',
  'option',
  'iframe',
  'object',
  'canvas',
  'svg',
]);

// ADR-004: [\t\n\v\f\r<space><NBSP>]+ -> one space. No other Unicode normalisation, ever.
// Two instances: the /g regex used with exec() keeps lastIndex state, so it must not be shared.
const WS_SCAN = /[\t\n\v\f\r \u00A0]+/g;
const WS_REPLACE = /[\t\n\v\f\r \u00A0]+/g;

export function isSkippedElement(el: Element): boolean {
  return SKIPPED_TAGS.has(el.localName) || el.hasAttribute(HOST_ATTRIBUTE);
}

/** Applies the stream's whitespace rule to arbitrary text (no start-of-stream drop). */
export function collapseWhitespace(s: string): string {
  return s.replace(WS_REPLACE, ' ');
}

function ownerDocument(node: Node): Document {
  return node.nodeType === 9 ? (node as Document) : (node.ownerDocument ?? document);
}

/** First node after `node` and all its descendants, in document order. */
function afterSubtree(node: Node): Node | null {
  for (let n: Node | null = node; n; n = n.parentNode) {
    if (n.nextSibling) return n.nextSibling;
  }
  return null;
}

/**
 * Builds the sv-text-v1 stream (ADR-004) for `root`. The same function runs at capture time and at
 * restore time, so consistency is by construction. Cost is linear in the number of DOM nodes.
 */
export function buildTextStream(
  root: Node = document.body ?? document.documentElement,
): TextStream {
  const segments: TextSegment[] = [];
  let text = '';
  let lastWasSpace = false;
  // The 1:1 segment that the next character may extend (adjacent text and single whitespace chars merge,
  // so a 1 MB page yields thousands of segments rather than hundreds of thousands).
  let open: TextSegment | null = null;

  const extend = (node: Text, a: number, b: number): void => {
    const len = text.length;
    if (open && open.node === node && open.nodeEnd === a && open.streamEnd === len) {
      open.nodeEnd = b;
      open.streamEnd = len + (b - a);
    } else {
      open = { node, nodeStart: a, nodeEnd: b, streamStart: len, streamEnd: len + (b - a) };
      segments.push(open);
    }
  };

  const visit = (node: Text): void => {
    const data = node.data;
    if (data.length === 0) return;
    WS_SCAN.lastIndex = 0;
    let i = 0;
    for (let m = WS_SCAN.exec(data); m; m = WS_SCAN.exec(data)) {
      const a = m.index;
      const b = a + m[0].length;
      if (a > i) {
        extend(node, i, a);
        text += data.slice(i, a);
        lastWasSpace = false;
      }
      // A whitespace run is dropped at the start of the stream and after another space (this also
      // collapses runs that straddle text nodes).
      if (text.length > 0 && !lastWasSpace) {
        if (b - a === 1) {
          extend(node, a, b);
        } else {
          segments.push({
            node,
            nodeStart: a,
            nodeEnd: b,
            streamStart: text.length,
            streamEnd: text.length + 1,
          });
          open = null;
        }
        text += ' ';
        lastWasSpace = true;
      }
      i = b;
    }
    if (i < data.length) {
      extend(node, i, data.length);
      text += i === 0 ? data : data.slice(i);
      lastWasSpace = false;
    }
  };

  if (root.nodeType === TEXT_NODE) {
    visit(root as Text);
  } else if (!(root.nodeType === ELEMENT_NODE && isSkippedElement(root as Element))) {
    let node: Node | null = root.firstChild;
    while (node) {
      if (node.nodeType === TEXT_NODE) {
        visit(node as Text);
      } else if (node.nodeType === ELEMENT_NODE && !isSkippedElement(node as Element)) {
        if (node.firstChild) {
          node = node.firstChild;
          continue;
        }
      }
      while (node && !node.nextSibling) {
        node = node.parentNode;
        if (node === root) node = null;
      }
      node = node ? node.nextSibling : null;
    }
  }

  let signature: string | undefined;
  return {
    text,
    segments,
    root,
    // Hashing a 1 MB stream costs a few ms; most callers (capture without a signature check,
    // painting) never need it, so it is computed on first use.
    get signature(): string {
      signature ??= cyrb53Hex(text);
      return signature;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// DOM -> stream
// ---------------------------------------------------------------------------------------------

/** Index of the first segment whose node does not come before `ref` in document order. */
function firstSegmentNotBefore(segments: readonly TextSegment[], ref: Node, mask: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((ref.compareDocumentPosition(segments[mid]!.node) & mask) !== 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Number of stream characters that lie before the DOM boundary point (container, offset). */
function streamOffsetOfPoint(stream: TextStream, container: Node, offset: number): number {
  const { segments, text } = stream;
  const n = segments.length;

  if (container.nodeType === TEXT_NODE) {
    const first = firstSegmentNotBefore(segments, container, POSITION_PRECEDING);
    for (let j = first; j < n; j++) {
      const s = segments[j]!;
      if (s.node !== container || offset <= s.nodeStart) return s.streamStart;
      if (offset < s.nodeEnd) {
        const oneToOne = s.nodeEnd - s.nodeStart === s.streamEnd - s.streamStart;
        return oneToOne ? s.streamStart + (offset - s.nodeStart) : s.streamEnd;
      }
    }
    return text.length;
  }

  if (
    container.nodeType === ELEMENT_NODE ||
    container.nodeType === 9 ||
    container.nodeType === 11
  ) {
    const child = container.childNodes[offset];
    if (child) {
      const i = firstSegmentNotBefore(segments, child, POSITION_PRECEDING);
      return i < n ? segments[i]!.streamStart : text.length;
    }
    // Boundary after the last child: everything inside the container is before the point.
    const i = firstSegmentNotBefore(
      segments,
      container,
      POSITION_PRECEDING | POSITION_CONTAINED_BY,
    );
    return i < n ? segments[i]!.streamStart : text.length;
  }

  // Comment / processing instruction: the point sits at that node's position.
  const i = firstSegmentNotBefore(segments, container, POSITION_PRECEDING);
  return i < n ? segments[i]!.streamStart : text.length;
}

/**
 * Converts a DOM range into raw stream offsets. Handles text-node boundaries and element-container
 * boundaries (a triple-click ends at offset 0 of the next block). Returns null when the range lies
 * outside the stream root. The result can be empty or contain leading/trailing stream whitespace;
 * callers trim. O(log n) in the number of segments.
 */
export function rangeToStreamOffsets(
  stream: TextStream,
  range: Range,
): { start: number; end: number } | null {
  try {
    const { root } = stream;
    const ancestor = range.commonAncestorContainer;
    if (!root.contains(ancestor) && !ancestor.contains(root)) return null;
    const start = streamOffsetOfPoint(stream, range.startContainer, range.startOffset);
    const end = streamOffsetOfPoint(stream, range.endContainer, range.endOffset);
    return { start: Math.min(start, end), end: Math.max(start, end) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// stream -> DOM
// ---------------------------------------------------------------------------------------------

/**
 * Converts stream offsets back into a DOM range. The start prefers the segment that begins at the
 * offset, the end prefers the segment that ends there, so a range never spills into a neighbouring
 * text node. Returns null for out-of-range offsets, nodes that left the root, or a stale stream.
 */
export function streamRangeToDomRange(
  stream: TextStream,
  start: number,
  end: number,
): Range | null {
  const { segments, text, root } = stream;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > text.length || start >= end || segments.length === 0) return null;

  // Segments partition [0, text.length) in order, so both lookups are plain binary searches.
  // start: last segment with streamStart <= start (then start < streamEnd by contiguity).
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid]!.streamStart <= start) lo = mid + 1;
    else hi = mid;
  }
  const startSeg = segments[lo - 1];
  // end: first segment with streamEnd >= end.
  lo = 0;
  hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid]!.streamEnd < end) lo = mid + 1;
    else hi = mid;
  }
  const endSeg = segments[lo];
  if (!startSeg || !endSeg || start >= startSeg.streamEnd || end <= endSeg.streamStart) return null;

  const startOffset = startSeg.nodeStart + (start - startSeg.streamStart);
  const endOffset =
    end === endSeg.streamEnd ? endSeg.nodeEnd : endSeg.nodeStart + (end - endSeg.streamStart);

  try {
    if (!root.contains(startSeg.node) || !root.contains(endSeg.node)) return null;
    const range = ownerDocument(root).createRange();
    range.setStart(startSeg.node, startOffset);
    range.setEnd(endSeg.node, endOffset);
    return range.collapsed ? null : range;
  } catch {
    return null; // IndexSizeError: the node shrank since the stream was built
  }
}

/**
 * The text of a live DOM range as the stream would see it: skipped subtrees contribute nothing and
 * whitespace is collapsed. This is an independent DOM walk (it does not read the segment map), which
 * is what makes it a real check of a mapping. Cost is proportional to the range, not the document.
 */
export function streamTextOfRange(range: Range): string {
  const sc = range.startContainer;
  const ec = range.endContainer;
  const so = range.startOffset;
  const eo = range.endOffset;

  // Outermost skipped ancestor-or-self of the start boundary: everything up to its end is excluded.
  let skipped: Element | null = null;
  for (let n: Node | null = sc; n; n = n.parentNode) {
    if (n.nodeType === ELEMENT_NODE && isSkippedElement(n as Element)) skipped = n as Element;
  }

  let node: Node | null;
  if (skipped) {
    if (skipped.contains(ec)) return '';
    node = afterSubtree(skipped);
  } else if (sc.nodeType === TEXT_NODE) {
    node = sc;
  } else if (sc.nodeType === ELEMENT_NODE || sc.nodeType === 9 || sc.nodeType === 11) {
    node = sc.childNodes[so] ?? afterSubtree(sc);
  } else {
    node = afterSubtree(sc);
  }

  // Exclusive stop node. A text end container is handled inline (inclusive, sliced) instead.
  let endNode: Node | null = null;
  if (ec.nodeType === ELEMENT_NODE || ec.nodeType === 9 || ec.nodeType === 11) {
    endNode = ec.childNodes[eo] ?? afterSubtree(ec);
  } else if (ec.nodeType !== TEXT_NODE) {
    endNode = afterSubtree(ec);
  }

  let out = '';
  while (node && node !== endNode) {
    if (node.nodeType === TEXT_NODE) {
      let data = (node as Text).data;
      if (node === sc && node === ec) data = data.slice(so, eo);
      else if (node === sc) data = data.slice(so);
      else if (node === ec) data = data.slice(0, eo);
      out += data;
      if (node === ec) break;
    } else if (node.nodeType === ELEMENT_NODE) {
      if (isSkippedElement(node as Element)) {
        if (node.contains(ec)) break;
        node = afterSubtree(node);
        continue;
      }
      if (node.firstChild) {
        node = node.firstChild;
        continue;
      }
    }
    node = afterSubtree(node);
  }
  return collapseWhitespace(out);
}
