/**
 * Fixed-window counter per key. In-process: enough for one instance and for tests. Behind several
 * instances use the proxy's or a shared store's limiter; this one is the last line, not the only one.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(max: number, windowMs: number, maxKeys = 50_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** Count one request. Returns how long to wait when over the limit, else 0. */
  hit(key: string, nowMs: number): number {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= nowMs) {
      if (this.windows.size >= this.maxKeys) this.sweep(nowMs);
      w = { count: 0, resetAt: nowMs + this.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count > this.max ? Math.max(1, w.resetAt - nowMs) : 0;
  }

  private sweep(nowMs: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= nowMs) this.windows.delete(k);
    // Still full of live windows (an attack): drop the oldest rather than grow without bound.
    if (this.windows.size >= this.maxKeys) {
      for (const k of this.windows.keys()) {
        this.windows.delete(k);
        if (this.windows.size < this.maxKeys * 0.9) break;
      }
    }
  }
}
