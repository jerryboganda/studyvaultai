/**
 * Highlighted snippets WITHOUT markup. A snippet is a list of `{ text, match }` segments whose texts are
 * verbatim slices of the source field; the UI renders them as text nodes (React children / textContent),
 * so stored page text containing `<script>` or `onerror=` can never become markup.
 */
import { analyzeWords, wordIndexTerms } from './analyzer';

export interface Segment {
  text: string;
  match: boolean;
}

export interface Snippet {
  /** Concatenating `segments[].text` yields exactly the visible window of the source text. */
  segments: Segment[];
  /** True when the field continues before / after the window (draw an ellipsis). */
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

export type Span = readonly [start: number, end: number];

/** Spans of `text` covered by words that produced one of the matched index `terms`. */
export function matchedSpans(
  text: string,
  terms: ReadonlySet<string>,
  stop?: ReadonlySet<string>,
): Span[] {
  const spans: Span[] = [];
  if (terms.size === 0 || text === '') return spans;
  for (const w of analyzeWords(text, stop)) {
    if (w.cjk) {
      const c = w.parts;
      const at = w.at!;
      const marked = c.map(
        (ch, i) =>
          terms.has(ch) ||
          (i + 1 < c.length && terms.has(ch + c[i + 1]!)) ||
          (i > 0 && terms.has(c[i - 1]! + ch)),
      );
      for (let i = 0; i < c.length; i++) {
        if (!marked[i]) continue;
        let j = i;
        while (j + 1 < c.length && marked[j + 1]) j++;
        spans.push([at[i]!, j + 1 < c.length ? at[j + 1]! : w.end]);
        i = j;
      }
    } else if (wordIndexTerms(w).some((t) => terms.has(t))) {
      spans.push([w.start, w.end]);
    }
  }
  return spans;
}

const SPACE = /\s/;
const SNAP_LIMIT = 24;

function isLowSurrogate(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Move `pos` back to the start of its word (bounded), never inside a surrogate pair. */
function snapBack(text: string, pos: number): number {
  let p = pos;
  while (p > 0 && pos - p < SNAP_LIMIT && !SPACE.test(text[p - 1]!)) p--;
  if (p > 0 && !SPACE.test(text[p - 1]!)) p = pos; // a very long word: keep the requested cut
  if (p > 0 && isLowSurrogate(text, p)) p--;
  return p;
}

/** Move `pos` forward to the end of its word (bounded), never inside a surrogate pair. */
function snapForward(text: string, pos: number): number {
  const len = text.length;
  let p = Math.min(pos, len);
  for (let k = 0; p < len && k < SNAP_LIMIT && !SPACE.test(text[p]!); k++) p++;
  if (p < len && isLowSurrogate(text, p)) p++;
  return p;
}

/**
 * Window `text` to about `maxLength` characters around the densest cluster of `spans` (sorted,
 * non-overlapping) and cut it into matched / unmatched segments.
 */
export function buildSnippet(text: string, spans: readonly Span[], maxLength: number): Snippet {
  const len = text.length;
  let start = 0;
  let end = len;
  if (len > maxLength) {
    if (spans.length === 0) {
      end = snapForward(text, maxLength);
    } else {
      const lead = Math.min(40, Math.floor(maxLength / 4));
      let best = 0;
      let bestCount = -1;
      for (let i = 0; i < spans.length; i++) {
        const we = Math.max(0, spans[i]![0] - lead) + maxLength;
        let count = 0;
        for (let j = i; j < spans.length && spans[j]![1] <= we; j++) count++;
        if (count > bestCount) {
          bestCount = count;
          best = i;
        }
      }
      start = snapBack(text, Math.max(0, spans[best]![0] - lead));
      end = Math.max(snapForward(text, start + maxLength), Math.min(len, spans[best]![1]));
    }
  }

  const segments: Segment[] = [];
  const push = (from: number, to: number, match: boolean): void => {
    if (to <= from) return;
    const piece = text.slice(from, to);
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += piece;
    else segments.push({ text: piece, match });
  };
  let cursor = start;
  for (const [s, e] of spans) {
    if (e <= start || s >= end) continue;
    const a = Math.max(s, start);
    const b = Math.min(e, end);
    if (a > cursor) {
      // two matches separated only by whitespace read as one highlight
      const joined = segments.at(-1)?.match === true && /^\s+$/.test(text.slice(cursor, a));
      push(cursor, a, joined);
    }
    push(a, b, true);
    cursor = b;
  }
  push(cursor, end, false);
  if (segments.length === 0) segments.push({ text: '', match: false });
  return { segments, truncatedStart: start > 0, truncatedEnd: end < len };
}
