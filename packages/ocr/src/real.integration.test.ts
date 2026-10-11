// @vitest-environment node
//
// Optional: runs the REAL tesseract.js with the packaged traineddata on a rendered "STUDY HALL" PNG.
//   node scripts/copy-ocr-assets.mjs && SV_OCR_REAL=1 pnpm exec vitest run packages/ocr/src/real.integration.test.ts
//
// What this proves: our engine's result conversion against genuine tesseract output, and that the
// shipped eng.traineddata.gz is loadable and accurate. What it does NOT prove: the browser path. In
// Node, tesseract.js ignores workerPath/corePath and uses its own worker thread and the core from
// node_modules, so the packaged worker.min.js and tesseract-core-simd-lstm.* are not exercised here
// (they were verified separately in headless Chromium under the extension CSP).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createOcrEngine } from './engine';
import type { CreateWorkerFn } from './engine';
import { buildPageTextStream } from './stream';

const ASSETS = join(process.cwd(), 'public', 'ocr');
const enabled = process.env.SV_OCR_REAL === '1' && existsSync(join(ASSETS, 'eng.traineddata.gz'));

// 5x7 bitmap glyphs, scaled up; plenty for LSTM Tesseract at this size.
const GLYPHS: Record<string, string[]> = {
  S: ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'],
  T: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
  U: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  D: ['XXXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'XXXX.'],
  Y: ['X...X', 'X...X', '.X.X.', '..X..', '..X..', '..X..', '..X..'],
  H: ['X...X', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  L: ['X....', 'X....', 'X....', 'X....', 'X....', 'X....', 'XXXXX'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

function renderText(text: string, scale: number, margin: number) {
  const cols = text.length * 6 - 1;
  const width = cols * scale + margin * 2;
  const height = 7 * scale + margin * 2;
  const pixels = new Uint8Array(width * height).fill(255);
  [...text].forEach((ch, index) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']!;
    glyph.forEach((row, gy) => {
      [...row].forEach((cell, gx) => {
        if (cell !== 'X') return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = margin + (index * 6 + gx) * scale + dx;
            const y = margin + gy * scale + dy;
            pixels[y * width + x] = 0;
          }
        }
      });
    });
  });
  return { width, height, pixels };
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    Buffer.from(pixels.buffer, y * width, width).copy(raw, y * (width + 1) + 1);
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Node's tesseract.js: only langPath is meaningful (see the file header). */
const nodeCreateWorker: CreateWorkerFn = async (language, oem, options) => {
  const mod = (await import('tesseract.js')) as unknown as {
    createWorker: (
      l: string,
      o: number,
      opts: Record<string, unknown>,
    ) => ReturnType<CreateWorkerFn>;
  };
  return mod.createWorker(language, oem, {
    langPath: ASSETS,
    cacheMethod: 'none',
    gzip: true,
    logger: options.logger,
    errorHandler: options.errorHandler,
  });
};

describe.skipIf(!enabled)('real tesseract.js with the packaged eng.traineddata.gz', () => {
  it('reads "STUDY HALL" with sane boxes and progress', { timeout: 180_000 }, async () => {
    const { width, height, pixels } = renderText('STUDY HALL', 8, 48);
    const png = encodeGrayPng(width, height, pixels);
    const engine = createOcrEngine({
      assetBaseUrl: 'http://127.0.0.1/ocr/',
      createWorker: nodeCreateWorker,
      idleTimeoutMs: 0,
    });
    const phases: string[] = [];
    try {
      const page = await engine.recognize(png, {
        width,
        height,
        pageNumber: 1,
        scale: 4,
        onProgress: (e) => phases.push(`${e.phase}:${e.progress}`),
      });
      console.log(
        `[ocr real] text=${JSON.stringify(page.text)} confidence=${page.confidence} ` +
          `words=${page.words.map((w) => `${w.text}@${JSON.stringify(w.bbox)}`).join(' ')} ` +
          `version=${page.engine.version}`,
      );
      expect(buildPageTextStream(page).text).toBe('STUDY HALL');
      expect(page.words.length).toBe(2);
      expect(page.confidence).toBeGreaterThan(50);
      for (const word of page.words) {
        expect(word.bbox.x).toBeGreaterThanOrEqual(0);
        expect(word.bbox.y).toBeGreaterThanOrEqual(0);
        expect(word.bbox.x + word.bbox.w).toBeLessThanOrEqual(width);
        expect(word.bbox.y + word.bbox.h).toBeLessThanOrEqual(height);
        expect(word.bbox.w).toBeGreaterThan(20);
      }
      // "STUDY" is left of "HALL" and both sit on the same line.
      expect(page.words[0]!.bbox.x).toBeLessThan(page.words[1]!.bbox.x);
      expect(page.lines).toHaveLength(1);
      expect(phases.at(-1)).toBe('recognizing:1');
    } finally {
      await engine.terminate();
    }
  });
});
