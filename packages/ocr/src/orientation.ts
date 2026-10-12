import { OcrError } from './errors';
import type { OcrPage, OcrRotation } from './types';

/*
 * Reading scans that are stored sideways or upside down, without the OSD language data.
 *
 * The recogniser reads text that runs left to right. A page whose lines run the other way comes back
 * as junk ("s (c) [7] s (c) NS 0 8 ..."), under a green "Recognised 1 page". Orientation is found by
 * trying: the page image is turned (90, 270, 180 degrees) and read again, and the reading that holds
 * the most confidently recognised text wins. Measured on the real scans in tests/fixtures/pdf/real
 * (tesseract.js 7, LSTM, 300 dpi, mean word confidence 0..100):
 *
 *   MSFC slides, stored sideways   turned 90: 88-90   as stored: 38-40   270: 36-40   180: 41-44
 *   NACA SR256, upright text page  as shown: 89       turned 90: 38      270: 33      180: 28
 *
 * so the mean confidence separates a right reading from a wrong one by 45 points or more, and the
 * confidently read characters by 4x or more. Two things the numbers also showed shaped this file:
 *   - a reading at a downscaled size (1/3, or a band of the page) is NOT cheap: the cost is the
 *     junk the recogniser invents out of a wrong orientation (a dense page: 6 s right, 14-16 s
 *     turned 90 or 270), not the pixels. Every try is therefore a full-size reading, so tries are
 *     comparable with each other and the winner needs no second pass;
 *   - which way the LINES run is visible without any recognition, from where the ink lies (rows
 *     versus columns), for 30 ms. It rules whole orientations out before they are paid for.
 */

/** Which way the lines of text of an image run, from where its ink lies. */
export type LineDirection = 'horizontal' | 'vertical' | 'unclear';

/**
 * Mean word confidence (0..100) from which a reading is taken as it is and no other is tried. Real
 * text measured 59-90 (a page of tables 59), junk from a wrong turn 28-46.
 */
export const TRUSTED_CONFIDENCE = 60;
/** A word at or above this confidence counts as read. */
export const CONFIDENT_WORD = 80;
/** A turned reading must hold this many times the confident characters of the upright one. */
export const TURN_MARGIN = 1.5;
/** ... and at least this many characters, so a few stray marks cannot turn a page. */
export const MIN_CONFIDENT_CHARS = 10;
/** Time allowed for all readings of one page (the one that is running is not interrupted). */
export const ORIENTATION_BUDGET_MS = 120_000;

/*
 * Row/column edge-energy ratio, measured on 55 real pages (the committed fixtures, shown upright):
 * pages of text 2.5-92 (most 8 and up), pages of tables and equations 1.5-4, photographs and charts
 * 0.5-1.3. A page stored sideways has the inverse ratio. Pages in between are `unclear` and are tried
 * in full.
 */
/** From this ratio the lines run horizontally. */
const HORIZONTAL_RATIO = 2;
/** At or below this ratio they run vertically. */
const VERTICAL_RATIO = 0.5;
/** Below this edge energy (0..255 ink units) there is not enough on the page to tell. */
const MIN_ENERGY = 4;

function edgeEnergy(profile: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 1; i < profile.length; i += 1) sum += (profile[i]! - profile[i - 1]!) ** 2;
  return profile.length > 1 ? sum / (profile.length - 1) : 0;
}

/**
 * Direction of the text lines from the mean ink of every row and every column of a (small) copy of the
 * page. Lines of text make the row profile alternate between ink and paper at every step, while the
 * column profile of the same page changes slowly: the energy of the first differences tells which
 * axis the lines run along. A page of figures, grids or very little text is `unclear`.
 */
export function lineDirectionFromProfiles(
  rows: ArrayLike<number>,
  cols: ArrayLike<number>,
): LineDirection {
  const er = edgeEnergy(rows);
  const ec = edgeEnergy(cols);
  if (Math.max(er, ec) < MIN_ENERGY) return 'unclear';
  const ratio = er / Math.max(ec, 1e-9);
  if (ratio >= HORIZONTAL_RATIO) return 'horizontal';
  if (ratio <= VERTICAL_RATIO) return 'vertical';
  return 'unclear';
}

/**
 * Turns to read, most likely first. Lines that run horizontally can only be upright or upside down;
 * lines that run vertically are sideways one way or the other (0 stays last in case the page was
 * misjudged); otherwise everything is tried. At most four readings, whatever the page.
 */
export function attemptOrder(direction: LineDirection): OcrRotation[] {
  switch (direction) {
    case 'horizontal':
      return [0, 180];
    case 'vertical':
      return [90, 270, 0];
    case 'unclear':
      return [0, 90, 270, 180];
  }
}

export interface Reading {
  orientation: OcrRotation;
  page: OcrPage;
  /** Mean word confidence 0..100 (0 when nothing was recognised). */
  mean: number;
  /** Characters of the words recognised with at least CONFIDENT_WORD confidence. */
  strong: number;
}

export function readingOf(orientation: OcrRotation, page: OcrPage): Reading {
  let strong = 0;
  for (const word of page.words) {
    if (word.confidence >= CONFIDENT_WORD) strong += word.text.length;
  }
  return { orientation, page, mean: page.words.length === 0 ? 0 : page.confidence, strong };
}

const isTrusted = (reading: Reading): boolean =>
  reading.page.words.length > 0 && reading.mean >= TRUSTED_CONFIDENCE;

/** The reading to keep: the upright one unless a turned one clearly holds more confident text. */
export function chooseReading(readings: readonly Reading[]): Reading {
  const upright = readings.find((r) => r.orientation === 0);
  let best = upright ?? readings[0]!;
  for (const r of readings) {
    if (r === best) continue;
    const score = r.strong / (r.orientation === 0 ? 1 : TURN_MARGIN);
    const bestScore = best.strong / (best.orientation === 0 ? 1 : TURN_MARGIN);
    if (score > bestScore && (r.orientation === 0 || r.strong >= MIN_CONFIDENT_CHARS)) best = r;
  }
  return best;
}

export interface UprightOptions {
  /** Reads the page turned clockwise by `turn` degrees; boxes and rotation come back mapped. */
  recognize(turn: OcrRotation): Promise<OcrPage>;
  direction: LineDirection;
  /** Called before every reading that is a turned one: the page is being checked. */
  onTurned?(turn: OcrRotation, index: number): void;
  signal?: AbortSignal;
  budgetMs?: number;
  now?: () => number;
}

export interface UprightResult {
  page: OcrPage;
  orientation: OcrRotation;
  /** Every reading made, in order (at most four). */
  readings: Reading[];
}

/**
 * Reads a page, turning it when its text runs sideways or upside down. Never loops: the readings are
 * the fixed list of `attemptOrder`, each at most once, stopping at the first trusted one and when the
 * time budget cannot cover another. An error on the FIRST reading is the caller's (as for any page);
 * an error on a later one only ends the search and the best reading so far is kept. Cancellation is
 * never swallowed.
 */
export async function recognizeUpright(options: UprightOptions): Promise<UprightResult> {
  const now = options.now ?? Date.now;
  const budget = options.budgetMs ?? ORIENTATION_BUDGET_MS;
  const order = attemptOrder(options.direction);
  const readings: Reading[] = [];
  const started = now();
  let lastCost = 0;
  for (const [index, turn] of order.entries()) {
    if (index > 0) {
      if (options.signal?.aborted) throw new OcrError('cancelled');
      if (now() - started + lastCost > budget) break;
    }
    if (turn !== 0) options.onTurned?.(turn, index);
    const t0 = now();
    let page: OcrPage;
    try {
      page = await options.recognize(turn);
    } catch (error) {
      if (
        index === 0 ||
        options.signal?.aborted ||
        (error as { code?: unknown })?.code === 'cancelled'
      ) {
        throw error;
      }
      break;
    }
    lastCost = now() - t0;
    const reading = readingOf(turn, page);
    readings.push(reading);
    if (isTrusted(reading)) break;
  }
  const chosen = chooseReading(readings);
  return { page: chosen.page, orientation: chosen.orientation, readings };
}
