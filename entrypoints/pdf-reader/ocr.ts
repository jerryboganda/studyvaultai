import type { OcrPort } from '@pdf';

/**
 * OCR wiring point. The ocr task delivers `@ocr`; until its recogniser is adapted to the OcrPort
 * shape here, the reader's "OCR this document" action stays disabled and says why. Replace the
 * body with the adapter, e.g. `return createOcrPort()`, and nothing else in the reader changes.
 */
export function getOcrPort(): OcrPort | undefined {
  return undefined;
}
