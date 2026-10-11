// Production wiring for the injected deps. Only code that RUNS when `systemClock()` is called touches
// globals, so importing @ai stays side-effect free and the pipeline stays testable in Node.
import type { PipelineDeps } from './deps';

export type SystemClock = Pick<
  PipelineDeps,
  'now' | 'random' | 'randomId' | 'sha256' | 'sleep' | 'timeout'
>;

function timer(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Date, Math.random, WebCrypto (service worker, extension pages and Node >= 20 all provide it). */
export function systemClock(): SystemClock {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    randomId: () => globalThis.crypto.randomUUID(),
    sha256: async (text) =>
      toHex(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    sleep: timer,
    timeout: timer,
  };
}
