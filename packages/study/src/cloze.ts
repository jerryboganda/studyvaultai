/**
 * Cloze markup: `{{c1::answer}}` or `{{c1::answer::hint}}`, several deletions, nesting allowed.
 *
 * Parsing is a single iterative pass (no regex backtracking, no recursion on input), malformed markup
 * degrades to literal text and never throws. Rendering produces typed segments, never HTML: the UI
 * puts each segment into a text node, so a quote that contains `<script>` stays inert text.
 *
 * Limits: `::` inside an answer starts the hint (as in Anki), `}}` cannot appear inside an answer, and
 * a hint is plain text (a `{{c` inside a hint is literal).
 */

export const MAX_CLOZE_DEPTH = 6;
export const MAX_CLOZE_INDEX = 99;

export type ClozeNode =
  | { kind: 'text'; text: string }
  | { kind: 'cloze'; index: number; children: ClozeNode[]; hint: string | null };

export interface ClozeDeletion {
  index: number;
  answer: string;
  hint: string | null;
}

export interface ParsedCloze {
  nodes: ClozeNode[];
  /** One entry per occurrence, in document order (outer before nested). */
  deletions: ClozeDeletion[];
  /** Distinct deletion indexes, ascending. */
  indexes: number[];
}

export type ClozeSegment =
  | { kind: 'text'; text: string }
  | { kind: 'blank'; index: number; hint: string | null }
  | { kind: 'answer'; index: number; text: string };

interface Frame {
  index: number;
  open: string;
  nodes: ClozeNode[];
  inHint: boolean;
  hint: string;
}

const OPEN = /^\{\{c(\d{1,2})::/;

function pushText(nodes: ClozeNode[], text: string): void {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last?.kind === 'text') last.text += text;
  else nodes.push({ kind: 'text', text });
}

function plainText(nodes: readonly ClozeNode[]): string {
  let out = '';
  for (const n of nodes) out += n.kind === 'text' ? n.text : plainText(n.children);
  return out;
}

/** A frame that never closed (or had an empty answer) is kept as the literal text it was typed as. */
function spliceLiteral(frame: Frame, tail: string, into: ClozeNode[]): void {
  pushText(into, frame.open);
  for (const n of frame.nodes) {
    if (n.kind === 'text') pushText(into, n.text);
    else into.push(n);
  }
  pushText(into, tail);
}

export function parseCloze(markup: string): ParsedCloze {
  const root: ClozeNode[] = [];
  const stack: Frame[] = [];
  let buf = '';
  const top = (): Frame | undefined => stack[stack.length - 1];
  const sink = (): ClozeNode[] => top()?.nodes ?? root;
  const flush = (): void => {
    pushText(sink(), buf);
    buf = '';
  };

  let i = 0;
  while (i < markup.length) {
    const cur = top();
    const inHint = cur?.inHint === true;
    if (!inHint && markup.startsWith('{{c', i) && stack.length < MAX_CLOZE_DEPTH) {
      const m = OPEN.exec(markup.slice(i, i + 8));
      const index = m ? Number(m[1]) : 0;
      if (m && index >= 1) {
        flush();
        stack.push({ index, open: m[0], nodes: [], inHint: false, hint: '' });
        i += m[0].length;
        continue;
      }
    }
    if (cur && !inHint && markup.startsWith('::', i)) {
      flush();
      cur.inHint = true;
      i += 2;
      continue;
    }
    if (cur && markup.startsWith('}}', i)) {
      const frame = stack.pop() as Frame;
      if (frame.inHint) frame.hint = buf;
      else pushText(frame.nodes, buf);
      buf = '';
      const parent = sink();
      const answer = plainText(frame.nodes);
      if (answer.trim() === '') {
        spliceLiteral(frame, frame.inHint ? `::${frame.hint}}}` : '}}', parent);
      } else {
        parent.push({
          kind: 'cloze',
          index: frame.index,
          children: frame.nodes,
          hint: frame.inHint && frame.hint.trim() !== '' ? frame.hint.trim() : null,
        });
      }
      i += 2;
      continue;
    }
    buf += markup[i];
    i += 1;
  }
  // Unclosed frames, innermost first, become literal text again.
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.inHint) frame.hint = buf;
    else pushText(frame.nodes, buf);
    const tail = frame.inHint ? `::${frame.hint}` : '';
    buf = '';
    spliceLiteral(frame, tail, sink());
  }
  pushText(root, buf);

  const deletions: ClozeDeletion[] = [];
  const walk = (nodes: readonly ClozeNode[]): void => {
    for (const n of nodes) {
      if (n.kind !== 'cloze') continue;
      deletions.push({ index: n.index, answer: plainText(n.children), hint: n.hint });
      walk(n.children);
    }
  };
  walk(root);
  const indexes = [...new Set(deletions.map((d) => d.index))].sort((a, b) => a - b);
  return { nodes: root, deletions, indexes };
}

export interface ClozeRenderOptions {
  /** Deletion index being tested; null hides every deletion at once. */
  activeIndex: number | null;
  /** false: question side (active deletions blanked); true: answer side. */
  reveal: boolean;
}

export function renderCloze(
  source: string | ParsedCloze,
  { activeIndex, reveal }: ClozeRenderOptions,
): ClozeSegment[] {
  const parsed = typeof source === 'string' ? parseCloze(source) : source;
  const out: ClozeSegment[] = [];
  const emitText = (text: string): void => {
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += text;
    else if (text) out.push({ kind: 'text', text });
  };
  const walk = (nodes: readonly ClozeNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'text') {
        emitText(n.text);
      } else if (activeIndex !== null && n.index !== activeIndex) {
        walk(n.children); // context: shown as plain text
      } else if (reveal) {
        out.push({ kind: 'answer', index: n.index, text: plainText(n.children) });
      } else {
        out.push({ kind: 'blank', index: n.index, hint: n.hint });
      }
    }
  };
  walk(parsed.nodes);
  return out;
}

/** Plain-text form of rendered segments: blanks become `[...]` or `[hint]`. */
export function segmentsToText(segments: readonly ClozeSegment[]): string {
  return segments.map((s) => (s.kind === 'blank' ? `[${s.hint ?? '...'}]` : s.text)).join('');
}

export interface ClozeRange {
  start: number;
  end: number;
  /** Defaults to the position of the range (1, 2, ...). */
  index?: number;
  hint?: string;
}

/**
 * Wraps user-selected spans of a plain string in cloze markup. Throws RangeError for spans that are
 * out of bounds, overlap, are empty, or contain markup delimiters that would corrupt the cloze.
 */
export function makeClozeMarkup(text: string, ranges: readonly ClozeRange[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  sorted.forEach((r, n) => {
    if (
      !Number.isInteger(r.start) ||
      !Number.isInteger(r.end) ||
      r.start < cursor ||
      r.end <= r.start ||
      r.end > text.length
    ) {
      throw new RangeError(`Invalid cloze range ${r.start}-${r.end}`);
    }
    const span = text.slice(r.start, r.end);
    if (span.trim() === '' || span.includes('::') || span.includes('}}') || span.includes('{{')) {
      throw new RangeError('Selection is empty or contains cloze delimiters');
    }
    const hint = r.hint?.trim();
    if (hint && (hint.includes('}}') || hint.includes('{{') || hint.includes('::'))) {
      throw new RangeError('Hint contains cloze delimiters');
    }
    const index = r.index ?? n + 1;
    if (!Number.isInteger(index) || index < 1 || index > MAX_CLOZE_INDEX) {
      throw new RangeError(`Invalid cloze index ${index}`);
    }
    out += `${text.slice(cursor, r.start)}{{c${index}::${span}${hint ? `::${hint}` : ''}}}`;
    cursor = r.end;
  });
  return out + text.slice(cursor);
}
