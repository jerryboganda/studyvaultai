// @ocr: local, cancellable, progress-reporting OCR (tesseract.js in a dedicated worker).
// Importing this module runs nothing; tesseract.js and its wasm load on the first recognize().
export { createOcrEngine, DEFAULT_MAX_PIXELS } from './engine';
export type {
  CreateWorkerFn,
  OcrEngineOptions,
  TesseractLogMessage,
  TesseractWorkerLike,
  TesseractWorkerOptions,
} from './engine';
export { OcrError, OCR_ERROR_MESSAGES, isOcrError, toOcrError } from './errors';
export type { OcrErrorCode } from './errors';
export { OCR_ASSET_FILES, OCR_LANGUAGE, resolveAssetUrls } from './assets';
export type { OcrAssetUrls } from './assets';
export {
  fitToPixelBudget,
  normalizeRotation,
  pageRectToPixelBox,
  pageRectToViewRect,
  pixelBoxToPageRect,
  unionBoxes,
} from './geometry';
export type { ImageSize, PixelBudget } from './geometry';
export {
  applyCorrections,
  emptyCorrections,
  hasCorrections,
  parseCorrections,
  revertLine,
  revertWord,
  setLineText,
  setWordText,
} from './corrections';
export type { CorrectedWord, OcrCorrections } from './corrections';
export { OCR_TEXT_ALGORITHM, buildPageTextStream, rectsForStreamRange } from './stream';
export type { OcrTextItem, PageTextStream } from './stream';
export { createOcrPort, runOcrJob } from './runner';
export type {
  OcrJobPageFailure,
  OcrJobPhase,
  OcrJobProgress,
  OcrJobSummary,
  OcrPort,
  OcrPortResult,
  OcrPortWord,
  RenderedPage,
  RunOcrJobOptions,
} from './runner';
export type {
  OcrEngine,
  OcrImageSource,
  OcrJobStore,
  OcrLine,
  OcrPage,
  OcrPhase,
  OcrProgress,
  OcrRotation,
  OcrWord,
  PixelBox,
  RecognizeOptions,
} from './types';
