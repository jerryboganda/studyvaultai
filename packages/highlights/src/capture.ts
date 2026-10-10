import type { HtmlAnchorSet } from '@shared';
import {
  MAX_CONTEXT_CHARS,
  MAX_HEADING_CHARS,
  MAX_QUOTE_CHARS,
  TEXT_ALGORITHM,
} from '@shared/constants';
import { structuralPath } from './structuralPath';
import {
  HOST_ATTRIBUTE,
  buildTextStream,
  collapseWhitespace,
  rangeToStreamOffsets,
  streamRangeToDomRange,
} from './textStream';
import type { CaptureFailure, CapturedAnchor, TextStream } from './types';

/** ADR-004: context = up to 32 chars of stream each side (the schema allows MAX_CONTEXT_CHARS). */
export const CONTEXT_CHARS = Math.min(32, MAX_CONTEXT_CHARS);

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Bounds the backwards walk on pathological DOMs so a capture can never stall the page. */
const MAX_HEADING_WALK = 200_000;

/** Previous node in document order: deepest last descendant of the previous sibling, else the parent. */
function previousInDocument(node: Node): Node | null {
  const sibling = node.previousSibling;
  if (!sibling) return node.parentNode;
  let n: Node = sibling;
  while (n.lastChild) n = n.lastChild;
  return n;
}

function clip(text: string): string {
  if (text.length <= MAX_HEADING_CHARS) return text;
  const last = text.charCodeAt(MAX_HEADING_CHARS - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff; // do not cut a surrogate pair in half
  return text.slice(0, splitsPair ? MAX_HEADING_CHARS - 1 : MAX_HEADING_CHARS);
}

/**
 * Text of the nearest heading that begins at or before `from` in document order. A heading that
 * contains `from` counts (it is an ancestor, so the reverse walk reaches it). Empty headings and the
 * StudyVault overlay are skipped.
 */
function nearestHeadingText(from: Node): string | null {
  let steps = 0;
  for (
    let n: Node | null = from;
    n && steps < MAX_HEADING_WALK;
    n = previousInDocument(n), steps++
  ) {
    if (n.nodeType !== 1 || !HEADING_TAGS.has((n as Element).localName)) continue;
    const el = n as Element;
    if (el.closest(`[${HOST_ATTRIBUTE}]`)) continue;
    const text = collapseWhitespace(el.textContent ?? '').trim();
    if (text) return clip(text);
  }
  return null;
}

/**
 * Captures an `HtmlAnchorSet` from a live selection range (ADR-004). `selectedText` is
 * `Selection.toString()`: it becomes `exactQuote` (provenance) and is never used for matching.
 *
 * Pass the `stream` you already built to avoid a second DOM walk; otherwise one is built from
 * `document.body`.
 */
export function captureAnchor(
  range: Range,
  selectedText: string,
  stream: TextStream = buildTextStream(),
): CapturedAnchor | { error: CaptureFailure } {
  const exactQuote = selectedText.trim();
  if (exactQuote.length === 0) return { error: 'empty' };
  if (exactQuote.length > MAX_QUOTE_CHARS) return { error: 'too-long' };

  const raw = rangeToStreamOffsets(stream, range);
  if (!raw) return { error: 'outside-root' };

  // Trim stream whitespace so an anchor never starts or ends on a collapsed space.
  const { text } = stream;
  let { start, end } = raw;
  while (start < end && text.charCodeAt(start) === 32) start++;
  while (end > start && text.charCodeAt(end - 1) === 32) end--;
  if (end <= start) return { error: 'empty' };
  if (end - start > MAX_QUOTE_CHARS) return { error: 'too-long' };

  // The text node holding the first quoted character: structural hint and heading search start here.
  const first = streamRangeToDomRange(stream, start, start + 1);
  if (!first) return { error: 'outside-root' }; // stream no longer matches the live DOM
  const startNode = first.startContainer;

  const anchorSet: HtmlAnchorSet = {
    type: 'html',
    textAlgorithm: TEXT_ALGORITHM,
    textQuote: {
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
      suffix: text.slice(end, end + CONTEXT_CHARS),
    },
    textPosition: { start, end },
    structuralPath: structuralPath(startNode.parentElement),
    contentSignature: stream.signature,
    documentTextLength: text.length,
  };

  return { anchorSet, exactQuote, headingContext: nearestHeadingText(startNode) };
}
