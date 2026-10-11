import { OCR_LANGUAGE } from './assets';
import { OcrError } from './errors';
import type { OcrLine, OcrPage, OcrRotation, OcrWord, PixelBox } from './types';

export interface ConversionMeta {
  pageNumber: number;
  /** Original image size (what the caller passed). */
  width: number;
  height: number;
  /** sent / original per axis; recogniser boxes are divided by these. */
  factorX: number;
  factorY: number;
  /** Rotation of the image the boxes refer to relative to the page box (includes `orientation`). */
  rotation: OcrRotation;
  /** Turn applied to the image before recognition; omitted from the page when 0 or absent. */
  orientation?: OcrRotation;
  scale: number | null;
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Control characters and whitespace runs out; OCR text is untrusted and rendered as text nodes only. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const WS = /[\t\n\v\f\r \u00A0]+/g;
export const cleanWordText = (s: string): string => s.replace(CONTROL, '').replace(WS, ' ').trim();

/**
 * Converts tesseract.js' `blocks` tree (block > paragraph > line > word, boxes as x0/y0/x1/y1) into the
 * flat reading-order model, mapping boxes back to original image pixels.
 */
export function convertRecognition(data: unknown, meta: ConversionMeta): OcrPage {
  if (!isRecord(data)) throw new OcrError('failed', 'the OCR engine returned no result');
  const words: OcrWord[] = [];
  const lines: OcrLine[] = [];

  const box = (raw: unknown): PixelBox | null => {
    if (!isRecord(raw)) return null;
    const x0 = clamp(Math.round(num(raw.x0) / meta.factorX), 0, meta.width);
    const x1 = clamp(Math.round(num(raw.x1) / meta.factorX), 0, meta.width);
    const y0 = clamp(Math.round(num(raw.y0) / meta.factorY), 0, meta.height);
    const y1 = clamp(Math.round(num(raw.y1) / meta.factorY), 0, meta.height);
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  };

  for (const block of asArray(data.blocks)) {
    for (const paragraph of asArray(isRecord(block) ? block.paragraphs : null)) {
      for (const rawLine of asArray(isRecord(paragraph) ? paragraph.lines : null)) {
        if (!isRecord(rawLine)) continue;
        const first = words.length;
        for (const rawWord of asArray(rawLine.words)) {
          if (!isRecord(rawWord) || typeof rawWord.text !== 'string') continue;
          const text = cleanWordText(rawWord.text);
          const bbox = box(rawWord.bbox);
          if (!text || !bbox) continue;
          words.push({
            text,
            confidence: clamp(num(rawWord.confidence), 0, 100),
            bbox,
            line: lines.length,
          });
        }
        if (words.length === first) continue;
        const lineWords = words.slice(first);
        const lineBox =
          box(rawLine.bbox) ??
          (() => {
            const x0 = Math.min(...lineWords.map((w) => w.bbox.x));
            const y0 = Math.min(...lineWords.map((w) => w.bbox.y));
            const x1 = Math.max(...lineWords.map((w) => w.bbox.x + w.bbox.w));
            const y1 = Math.max(...lineWords.map((w) => w.bbox.y + w.bbox.h));
            return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          })();
        lines.push({
          text: lineWords.map((w) => w.text).join(' '),
          confidence: clamp(num(rawLine.confidence), 0, 100),
          bbox: lineBox,
          first,
          end: words.length,
        });
      }
    }
  }

  return {
    pageNumber: meta.pageNumber,
    width: meta.width,
    height: meta.height,
    rotation: meta.rotation,
    ...(meta.orientation ? { orientation: meta.orientation } : {}),
    scale: meta.scale,
    confidence: words.length === 0 ? 0 : clamp(num(data.confidence), 0, 100),
    text: lines.map((l) => l.text).join('\n'),
    words,
    lines,
    engine: {
      name: 'tesseract',
      version: typeof data.version === 'string' ? data.version.slice(0, 64) : 'unknown',
      language: OCR_LANGUAGE,
    },
    recognizedAt: new Date().toISOString(),
  };
}
