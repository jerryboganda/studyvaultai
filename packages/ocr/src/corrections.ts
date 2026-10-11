import { cleanWordText } from './result';
import type { OcrPage, PixelBox } from './types';

/*
 * User corrections of OCR text. The recognised `OcrPage` is never edited: corrections live beside it
 * (they persist as one small JSON object per page) so "reset to OCR text" is exact, an engine upgrade
 * can re-recognise without losing human work, and machine output stays distinguishable from human text.
 */

export interface OcrCorrections {
  /** word index (into OcrPage.words) -> replacement text. '' removes the word. */
  words: Record<number, string>;
  /** line index (into OcrPage.lines) -> replacement text for the whole line. Wins over word edits in it. */
  lines: Record<number, string>;
}

export interface CorrectedWord {
  text: string;
  /** Always the OCR box; for a line edit, the line box split proportionally to token length. */
  bbox: PixelBox;
  line: number;
  confidence: number;
  source: 'ocr' | 'word-edit' | 'line-edit';
}

export const emptyCorrections = (): OcrCorrections => ({ words: {}, lines: {} });

const MAX_EDIT_CHARS = 2000;
const own = (record: Record<number, string>, key: number): string | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export function hasCorrections(c: OcrCorrections | undefined): boolean {
  return !!c && (Object.keys(c.words).length > 0 || Object.keys(c.lines).length > 0);
}

/** Defensive parse of persisted/imported corrections: unknown shapes become "no corrections". */
export function parseCorrections(
  value: unknown,
  limits: { words: number; lines: number } = { words: Infinity, lines: Infinity },
): OcrCorrections {
  const out = emptyCorrections();
  if (typeof value !== 'object' || value === null) return out;
  const pick = (source: unknown, target: Record<number, string>, max: number): void => {
    if (typeof source !== 'object' || source === null) return;
    for (const [key, text] of Object.entries(source)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < max && typeof text === 'string') {
        target[index] = text.slice(0, MAX_EDIT_CHARS);
      }
    }
  };
  pick((value as Record<string, unknown>).words, out.words, limits.words);
  pick((value as Record<string, unknown>).lines, out.lines, limits.lines);
  return out;
}

function splitLineEdit(text: string, lineBox: PixelBox, line: number): CorrectedWord[] {
  const tokens = cleanWordText(text).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const total = tokens.reduce((n, t) => n + t.length, 0) + tokens.length - 1;
  let cursor = 0;
  return tokens.map((token) => {
    const bbox = {
      x: lineBox.x + (lineBox.w * cursor) / total,
      y: lineBox.y,
      w: (lineBox.w * token.length) / total,
      h: lineBox.h,
    };
    cursor += token.length + 1;
    return { text: token, bbox, line, confidence: 100, source: 'line-edit' as const };
  });
}

/** Reading-order words after user corrections; every word keeps (a share of) its OCR box. */
export function applyCorrections(page: OcrPage, corrections?: OcrCorrections): CorrectedWord[] {
  const out: CorrectedWord[] = [];
  const edits = corrections ?? emptyCorrections();
  page.lines.forEach((line, lineIndex) => {
    const lineEdit = own(edits.lines, lineIndex);
    if (lineEdit !== undefined) {
      out.push(...splitLineEdit(lineEdit, line.bbox, lineIndex));
      return;
    }
    for (let i = line.first; i < line.end; i += 1) {
      const word = page.words[i];
      if (!word) continue;
      const edit = own(edits.words, i);
      // Persisted/imported pages are untrusted: normalise here so the stream rules always hold.
      const text = cleanWordText(edit ?? word.text);
      if (edit === undefined) {
        if (text) out.push({ ...word, text, source: 'ocr' });
        continue;
      }
      if (text) {
        out.push({ text, bbox: word.bbox, line: lineIndex, confidence: 100, source: 'word-edit' });
      }
    }
  });
  return out;
}

const without = (record: Record<number, string>, drop: (index: number) => boolean) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => !drop(Number(k))));

/** Immutable. Editing a word back to its OCR text removes the edit. */
export function setWordText(
  corrections: OcrCorrections,
  page: OcrPage,
  index: number,
  text: string,
): OcrCorrections {
  const word = page.words[index];
  if (!word) throw new RangeError(`word index ${index} is out of range`);
  const next = cleanWordText(text).slice(0, MAX_EDIT_CHARS);
  const words = without(corrections.words, (i) => i === index);
  if (next !== word.text) words[index] = next;
  return { words, lines: corrections.lines };
}

/** Immutable. Replaces a whole line; word edits inside that line are dropped (the line edit wins). */
export function setLineText(
  corrections: OcrCorrections,
  page: OcrPage,
  lineIndex: number,
  text: string,
): OcrCorrections {
  const line = page.lines[lineIndex];
  if (!line) throw new RangeError(`line index ${lineIndex} is out of range`);
  const next = cleanWordText(text).slice(0, MAX_EDIT_CHARS);
  const words = without(corrections.words, (i) => i >= line.first && i < line.end);
  const lines = without(corrections.lines, (i) => i === lineIndex);
  if (next !== line.text) lines[lineIndex] = next;
  return { words, lines };
}

export function revertWord(corrections: OcrCorrections, index: number): OcrCorrections {
  return { words: without(corrections.words, (i) => i === index), lines: corrections.lines };
}

export function revertLine(corrections: OcrCorrections, lineIndex: number): OcrCorrections {
  return { words: corrections.words, lines: without(corrections.lines, (i) => i === lineIndex) };
}
