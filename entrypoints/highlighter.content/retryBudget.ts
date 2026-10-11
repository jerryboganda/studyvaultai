/** Longest wait ever imposed, so one very slow pass (or a clock that jumped) cannot silence retries. */
const MAX_SPACING_MS = 60_000;

/**
 * Bounds the CPU spent re-resolving highlights that are not painted (lazy-loaded or late-rendered
 * content). A pass may start once the previous one has paid for itself: the wait is at least
 * `minIntervalMs` and at least `costFactor` times how long that pass took, so retries use at most
 * about 1 / (1 + costFactor) of the page's time however large the page is or however many
 * highlights are unresolved.
 *
 * There is no attempt cap or deadline. A page that is busy for a long time (a ticker, a live feed)
 * and receives its text late (infinite scroll, "load more") must still get that text painted, and
 * a rate bound already keeps a permanently orphaned highlight cheap.
 */
export class RetryBudget {
  private nextAt = 0;
  private startedAt = 0;

  constructor(
    readonly minIntervalMs = 1_000,
    readonly costFactor = 20,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** New navigation: the next pass is due at once. */
  reset(): void {
    this.nextAt = 0;
  }

  /** Milliseconds until a pass is due (0 when one is). */
  get waitMs(): number {
    const t = this.now();
    // A clock that went backwards must not stall retries for the difference.
    if (this.nextAt - t > MAX_SPACING_MS) this.nextAt = t;
    return Math.max(0, this.nextAt - t);
  }

  /** Starts a pass if one is due. Pair every `true` with `end()`. */
  begin(): boolean {
    if (this.waitMs > 0) return false;
    this.startedAt = this.now();
    return true;
  }

  /** The pass started by `begin()` finished: it decides when the next one is due. */
  end(): void {
    const t = this.now();
    const cost = Math.max(0, t - this.startedAt);
    this.nextAt =
      t + Math.min(MAX_SPACING_MS, Math.max(this.minIntervalMs, cost * this.costFactor));
  }
}
