import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineWxtModule } from 'wxt/modules';

type CopyOcrAssets = (options: {
  root: string;
  outDir: string;
  log: (line: string) => void;
}) => Promise<unknown>;

/**
 * Generates public/ocr/ (the offline OCR engine: tesseract wasm + traineddata, ~6 MB) right before WXT
 * copies public/ into the build, so CI and local builds always ship it without committing binaries.
 * WXT auto-loads every modules/*.ts. Idempotent and hash-verified: scripts/copy-ocr-assets.mjs.
 */
export default defineWxtModule((wxt) => {
  wxt.hooks.hook('build:before', async () => {
    const script = pathToFileURL(join(wxt.config.root, 'scripts', 'copy-ocr-assets.mjs')).href;
    const { copyOcrAssets } = (await import(script)) as { copyOcrAssets: CopyOcrAssets };
    await copyOcrAssets({
      root: wxt.config.root,
      outDir: join(wxt.config.publicDir, 'ocr'),
      log: (line) => wxt.logger.info(line),
    });
  });
});
