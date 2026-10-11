/**
 * The OCR engine files copied into the extension by scripts/copy-ocr-assets.mjs
 * (list + hashes: packages/ocr/assets.manifest.json; a test keeps both in sync).
 *
 * Core choice: tesseract-core-simd-lstm. LSTM-only (the legacy engine is 2x the size and unused),
 * WebAssembly SIMD (baseline since Chrome 91; our minimum is 120) for the speed of the 128-bit
 * kernels, deterministic (relaxed-SIMD results may differ per CPU), and the separate .js + .wasm form
 * (2.9 MB) instead of the base64 .wasm.js form (3.9 MB). The scalar core is only 2 KB smaller.
 * Language data: eng 4.0.0_best_int (LSTM-only, int8-quantised "best" model, 2.9 MB gzipped).
 */
export const OCR_LANGUAGE = 'eng';

export const OCR_ASSET_FILES = {
  worker: 'worker.min.js',
  core: 'tesseract-core-simd-lstm.js',
  /** Fetched by the core glue from the same folder as the worker script; never passed to tesseract. */
  wasm: 'tesseract-core-simd-lstm.wasm',
  langData: 'eng.traineddata.gz',
} as const;

export interface OcrAssetUrls {
  /** Folder URL with a trailing slash. */
  base: string;
  workerPath: string;
  corePath: string;
  langPath: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Builds every URL tesseract.js will ever load from the one injected base. tesseract.js falls back to
 * jsDelivr for any of workerPath/corePath/langPath that is missing, so all three are always set, and
 * the base itself must be an extension origin (loopback http is allowed for dev harnesses only).
 */
export function resolveAssetUrls(assetBaseUrl: string): OcrAssetUrls {
  let url: URL;
  try {
    url = new URL(assetBaseUrl);
  } catch {
    throw new TypeError(`OCR assetBaseUrl must be an absolute URL, got "${assetBaseUrl}"`);
  }
  const extension = url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:';
  const loopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (!extension && !loopback) {
    throw new TypeError(
      `OCR assetBaseUrl must be an extension URL (browser.runtime.getURL('/ocr/')), got ${url.protocol}//${url.host}`,
    );
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new TypeError('OCR assetBaseUrl must not carry a query, fragment or credentials');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const base = url.href;
  return {
    base,
    workerPath: base + OCR_ASSET_FILES.worker,
    corePath: base + OCR_ASSET_FILES.core,
    langPath: base.slice(0, -1),
  };
}
