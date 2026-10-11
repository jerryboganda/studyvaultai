export type OcrErrorCode =
  'asset-missing' | 'wasm-unsupported' | 'out-of-memory' | 'cancelled' | 'failed';

/** Shown to the user as-is. Technical text lives in `OcrError.detail`. */
export const OCR_ERROR_MESSAGES: Readonly<Record<OcrErrorCode, string>> = {
  'asset-missing':
    'The offline text-recognition files are missing from this extension build, so scanned pages cannot be read. Reinstall or update the extension.',
  'wasm-unsupported':
    'This browser cannot run the text-recognition engine (it needs WebAssembly with SIMD, Chrome or Edge 120 or later, and the extension must be allowed to run it).',
  'out-of-memory':
    'Text recognition ran out of memory on this page. Close other tabs or try a smaller page, then retry.',
  cancelled: 'Text recognition was cancelled.',
  failed: 'Text recognition failed on this page.',
};

export class OcrError extends Error {
  readonly code: OcrErrorCode;
  /** Technical reason for logs/support; never needed to understand `message`. */
  readonly detail: string | undefined;
  /** True when trying the same page again (with a fresh worker) can plausibly succeed. */
  readonly retryable: boolean;

  constructor(code: OcrErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(OCR_ERROR_MESSAGES[code], options);
    // Cancellation follows the platform convention so `error.name === 'AbortError'` checks work.
    this.name = code === 'cancelled' ? 'AbortError' : 'OcrError';
    this.code = code;
    this.detail = detail ? detail.slice(0, 400) : undefined;
    this.retryable = code === 'failed' || code === 'out-of-memory';
  }
}

export function isOcrError(value: unknown): value is OcrError {
  return value instanceof OcrError;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value && typeof value === 'object' && 'message' in value) {
    return String((value as { message: unknown }).message);
  }
  return value === undefined || value === null ? '' : String(value);
}

const OUT_OF_MEMORY =
  /out of memory|\boom\b|cannot enlarge memory|could not allocate memory|allocation failed|invalid array length|memory.*(exhaust|limit)/i;
const WASM_UNSUPPORTED =
  /content security policy|unsafe-eval|webassembly.*(not (defined|supported)|unsupported|disabled)|\bcompileerror\b|\blinkerror\b|\bsimd\b/i;
const ASSET_MISSING =
  /network error while fetching|failed to fetch|failed to load tesseractcore|importscripts|networkerror|err_file_not_found|err_blocked|\b404\b|traineddata/i;

/**
 * Maps whatever a tesseract worker, the browser or our own code threw onto the error taxonomy.
 * `phase` matters because a worker that fails to *start* with an empty message is almost always a
 * missing or blocked file (Chrome reports a 404 on a worker script as an empty ErrorEvent).
 */
export function toOcrError(error: unknown, phase: 'init' | 'recognize' = 'recognize'): OcrError {
  if (isOcrError(error)) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new OcrError('cancelled', error.message, { cause: error });
  }
  const text = describe(error);
  if (OUT_OF_MEMORY.test(text)) return new OcrError('out-of-memory', text, { cause: error });
  if (WASM_UNSUPPORTED.test(text)) return new OcrError('wasm-unsupported', text, { cause: error });
  if (ASSET_MISSING.test(text)) return new OcrError('asset-missing', text, { cause: error });
  if (phase === 'init' && text.trim() === '') {
    return new OcrError('asset-missing', 'worker failed to start with no message', {
      cause: error,
    });
  }
  return new OcrError('failed', text || 'unknown error', { cause: error });
}
