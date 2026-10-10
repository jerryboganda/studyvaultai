/** Test-only helpers (never imported by production code). */
import { captureAnchor } from './capture';
import { buildTextStream } from './textStream';
import type { CapturedAnchor, TextStream } from './types';

export function setBody(html: string): void {
  document.body.innerHTML = html;
}

export function textNodesOf(root: Node = document.body): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/**
 * A Range over the `occurrence`-th match of `needle` in the raw concatenation of all text nodes
 * (including text inside scripts etc.), the way a user selection would cover it.
 */
export function rangeOver(needle: string, occurrence = 0, root: Node = document.body): Range {
  const nodes = textNodesOf(root);
  let raw = '';
  const starts: number[] = [];
  for (const n of nodes) {
    starts.push(raw.length);
    raw += n.data;
  }
  let at = -1;
  for (let k = 0; k <= occurrence; k++) {
    at = raw.indexOf(needle, at + 1);
    if (at === -1) throw new Error(`needle not found (occurrence ${occurrence}): ${needle}`);
  }
  const end = at + needle.length;
  const range = document.createRange();
  for (let i = 0; i < nodes.length; i++) {
    const s = starts[i]!;
    const e = s + nodes[i]!.data.length;
    if (at >= s && at < e) range.setStart(nodes[i]!, at - s);
    if (end > s && end <= e) {
      range.setEnd(nodes[i]!, end - s);
      break;
    }
  }
  return range;
}

export interface Captured extends CapturedAnchor {
  range: Range;
  stream: TextStream;
}

/** Captures `needle` exactly as the content script would (selection text = Range.toString()). */
export function capture(needle: string, occurrence = 0): Captured {
  const range = rangeOver(needle, occurrence);
  const stream = buildTextStream();
  const result = captureAnchor(range, range.toString(), stream);
  if ('error' in result) throw new Error(`capture failed: ${result.error}`);
  return { ...result, range, stream };
}

/** captureAnchor for an explicit range/text pair; throws with the failure code for readable tests. */
export function captureRange(
  range: Range,
  selectedText: string,
  stream = buildTextStream(),
): CapturedAnchor {
  const result = captureAnchor(range, selectedText, stream);
  if ('error' in result) throw new Error(`capture failed: ${result.error}`);
  return result;
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
