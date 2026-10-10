/**
 * Bounds re-resolution of highlights that are not painted (lazy-loaded or late-rendered content):
 * at most `maxAttempts` passes within `windowMs` of the navigation, then nothing until the route
 * changes. Keeps a permanently orphaned highlight from costing a stream rebuild per mutation.
 */
export class RetryBudget {
  private startedAt: number;
  private used = 0;

  constructor(
    readonly maxAttempts = 8,
    readonly windowMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = this.now();
  }

  /** New navigation: the budget starts over. */
  reset(): void {
    this.startedAt = this.now();
    this.used = 0;
  }

  /** Spends one attempt; false when the budget is used up or the window has closed. */
  tryConsume(): boolean {
    if (this.used >= this.maxAttempts) return false;
    if (this.now() - this.startedAt > this.windowMs) return false;
    this.used += 1;
    return true;
  }

  get remaining(): number {
    const open = this.now() - this.startedAt <= this.windowMs;
    return open ? this.maxAttempts - this.used : 0;
  }
}
