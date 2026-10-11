// Test double for tesseract.js: same call surface as the real worker, no wasm. Mirrors the real
// library's quirks that matter to the engine: terminate() leaves in-flight promises hanging forever,
// and recognition results are `{ data: { blocks, confidence, version } }` with x0/y0/x1/y1 boxes.
import type { CreateWorkerFn, TesseractWorkerLike, TesseractWorkerOptions } from './engine';

export interface FakeWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence?: number;
}

/** Builds the `data` object tesseract.js returns for `blocks: true`. */
export function tesseractData(lines: FakeWord[][], confidence = 90): { data: unknown } {
  return {
    data: {
      text: lines.map((l) => l.map((w) => w.text).join(' ')).join('\n'),
      confidence,
      version: '5.1.0-fake',
      blocks: [
        {
          paragraphs: [
            {
              lines: lines.map((words) => ({
                confidence: 88,
                bbox: {
                  x0: Math.min(...words.map((w) => w.x0)),
                  y0: Math.min(...words.map((w) => w.y0)),
                  x1: Math.max(...words.map((w) => w.x1)),
                  y1: Math.max(...words.map((w) => w.y1)),
                },
                words: words.map((w) => ({
                  text: w.text,
                  confidence: w.confidence ?? 91,
                  bbox: { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 },
                })),
              })),
            },
          ],
        },
      ],
    },
  };
}

export interface PendingRecognition {
  image: Uint8Array;
  options: Record<string, string | number | boolean>;
  output: Record<string, boolean>;
  worker: FakeWorker;
  resolve(result: { data: unknown }): void;
  reject(error: unknown): void;
}

export class FakeWorker implements TesseractWorkerLike {
  terminated = false;
  readonly pending: PendingRecognition[] = [];
  private errorListeners: ((event: { message?: string }) => void)[] = [];
  readonly worker = {
    addEventListener: (_type: 'error', listener: (event: { message?: string }) => void): void => {
      this.errorListeners.push(listener);
    },
  };

  constructor(readonly owner: FakeTesseract) {}

  recognize(
    image: Uint8Array,
    options: Record<string, string | number | boolean> = {},
    output: Record<string, boolean> = {},
  ): Promise<{ data: unknown }> {
    return new Promise((resolve, reject) => {
      const job: PendingRecognition = { image, options, output, worker: this, resolve, reject };
      this.pending.push(job);
      this.owner.onRecognize?.(job);
    });
  }

  terminate(): Promise<void> {
    this.terminated = true;
    return Promise.resolve();
  }

  /** Simulates the browser reporting a crashed worker. */
  crash(message = 'Uncaught RangeError: Maximum call stack size exceeded'): void {
    for (const listener of this.errorListeners) listener({ message });
  }
}

export class FakeTesseract {
  readonly created: {
    language: string;
    oem: number;
    options: TesseractWorkerOptions;
    worker: FakeWorker;
  }[] = [];
  /** When set, createWorker rejects with this (once per call while set). */
  createError: unknown;
  /** Delay worker start until `release()`; lets tests cancel during initialisation. */
  holdStart = false;
  private startGate: (() => void)[] = [];
  /** Called for every recognize(); default leaves it pending for the test to settle. */
  onRecognize: ((job: PendingRecognition) => void) | null = null;

  readonly createWorker: CreateWorkerFn = async (language, oem, options) => {
    if (this.createError !== undefined) throw this.createError;
    const worker = new FakeWorker(this);
    this.created.push({ language, oem, options, worker });
    for (const [status, progress] of [
      ['loading tesseract core', 1],
      ['initializing tesseract', 1],
      ['loading language traineddata', 1],
      ['initializing api', 1],
    ] as const) {
      options.logger({ status, progress });
    }
    if (this.holdStart) await new Promise<void>((resolve) => this.startGate.push(resolve));
    return worker;
  };

  release(): void {
    for (const open of this.startGate.splice(0)) open();
  }

  get workers(): FakeWorker[] {
    return this.created.map((c) => c.worker);
  }
}
