export type {
  CaptureFailure,
  CapturedAnchor,
  PaintEntry,
  PainterOptions,
  Resolution,
  ResolutionMethod,
  ResolutionStatus,
  TextSegment,
  TextStream,
} from './types';
export {
  HOST_ATTRIBUTE,
  buildTextStream,
  rangeToStreamOffsets,
  streamRangeToDomRange,
  streamTextOfRange,
} from './textStream';
export { cyrb53, cyrb53Hex } from './hash';
export { structuralPath } from './structuralPath';
export { CONTEXT_CHARS, captureAnchor } from './capture';
export { resolveAnchor, resolveMany } from './resolve';
export type { ResolveManyOptions } from './resolve';
export { bestApproxSubstring, boundedEditDistance, similarity } from './fuzzy';
export type { ApproxMatch } from './fuzzy';
export { HighlightPainter } from './painter';
