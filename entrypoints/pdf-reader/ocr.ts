import { browser } from 'wxt/browser';
import type { OcrJobSummary, RunOcrJobOptions } from '@ocr/runner';
import type { OcrEngine } from '@ocr/types';

/**
 * The reader's handle on the local OCR engine (`@ocr`, tesseract.js in a dedicated worker, WebAssembly
 * and language data bundled with the extension, nothing fetched). Nothing is loaded until the first
 * `run`: the engine and the job runner are separate lazy chunks, and tesseract.js itself is a third
 * behind them, so opening a PDF that has text never downloads or parses any of it.
 */
export interface OcrService {
  /**
   * Recognise pages one at a time, saving each through `options.store` as soon as it is done. Resolves
   * with a summary for cancellation and for recognition failures (see `status`); rejects only when
   * the engine could not be loaded at all.
   */
  run(options: Omit<RunOcrJobOptions, 'engine'>): Promise<OcrJobSummary>;
  /** Terminate the worker now (frees its WebAssembly heap). The next run starts a fresh one. */
  dispose(): Promise<void>;
}

interface Loaded {
  engine: OcrEngine;
  runOcrJob: (options: RunOcrJobOptions) => Promise<OcrJobSummary>;
}

export interface OcrServiceOptions {
  /** Folder URL of the OCR assets. Default: the extension's own `ocr/` folder. */
  assetBaseUrl?: string;
  /** Test seam: replaces the lazily imported engine and runner. */
  load?: (assetBaseUrl: string) => Promise<Loaded>;
}

async function loadBundled(assetBaseUrl: string): Promise<Loaded> {
  // Submodules, not the package index: the index would pull engine.ts into the reader's main chunk.
  const [{ createOcrEngine }, { runOcrJob }] = await Promise.all([
    import('@ocr/engine'),
    import('@ocr/runner'),
  ]);
  return { engine: createOcrEngine({ assetBaseUrl }), runOcrJob };
}

export function createOcrService(options: OcrServiceOptions = {}): OcrService {
  let loaded: Promise<Loaded> | null = null;
  const load = (): Promise<Loaded> => {
    // The folder is not a typed public path (only its files are), hence the cast.
    const base = options.assetBaseUrl ?? browser.runtime.getURL('/ocr/' as never);
    loaded ??= (options.load ?? loadBundled)(base);
    // A failed load (chunk missing) may be retried by the next run.
    loaded.catch(() => {
      loaded = null;
    });
    return loaded;
  };
  return {
    async run(runOptions) {
      const { engine, runOcrJob } = await load();
      return runOcrJob({ ...runOptions, engine });
    },
    async dispose() {
      if (!loaded) return;
      const pending = loaded;
      loaded = null;
      const { engine } = await pending.catch(() => ({ engine: null }));
      await engine?.terminate();
    },
  };
}
