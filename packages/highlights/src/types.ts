import type { ColorId, HtmlAnchorSet } from '@shared';

/**
 * Public contract of @highlights (ADR-004). Implementations live next to this file.
 * This package is DOM-only: no Chrome APIs, no React, no storage.
 */

/** One contiguous run of stream text that maps 1:1 onto characters of a single Text node. */
export interface TextSegment {
  node: Text;
  /** Offsets into `node.data`. A collapsed whitespace run is one segment whose node range is the whole run. */
  nodeStart: number;
  nodeEnd: number;
  /** Offsets into `TextStream.text`. For a collapsed whitespace run this is exactly one space. */
  streamStart: number;
  streamEnd: number;
}

export interface TextStream {
  readonly text: string;
  readonly segments: readonly TextSegment[];
  readonly root: Node;
  /** cyrb53 hex of `text`; equals `HtmlAnchorSet.contentSignature` when the page text is unchanged. */
  readonly signature: string;
}

export type CaptureFailure = 'empty' | 'too-long' | 'outside-root';

export interface CapturedAnchor {
  anchorSet: HtmlAnchorSet;
  /** What the user saw (`selectedText` trimmed, internal whitespace preserved). Provenance only. */
  exactQuote: string;
  /** Text of the nearest preceding heading element (h1-h6), if any. */
  headingContext: string | null;
}

export type ResolutionStatus = 'resolved' | 'changed' | 'ambiguous' | 'orphaned';
export type ResolutionMethod = 'quote' | 'context' | 'position' | 'fuzzy' | 'none';

export interface Resolution {
  status: ResolutionStatus;
  /** 1 = exact unique match with agreeing context. Fuzzy matches report their similarity. */
  confidence: number;
  /** Non-null only for `resolved` and `changed`. `ambiguous`/`orphaned` are never given a range. */
  range: Range | null;
  method: ResolutionMethod;
  /** Number of exact occurrences of the quote that were found (0 for fuzzy/orphaned). */
  candidateCount: number;
}

export interface PaintEntry {
  id: string;
  color: ColorId;
  range: Range;
}

export interface PainterOptions {
  /** Defaults to `CSS.highlights` of the document's window. Injectable for tests. */
  registry?: Map<string, unknown>;
  highlightCtor?: new (...ranges: Range[]) => unknown;
  /** Defaults to the document window's `CSSStyleSheet` (constructable stylesheets). Injectable for tests. */
  styleSheetCtor?: new () => { replaceSync(css: string): void };
}
