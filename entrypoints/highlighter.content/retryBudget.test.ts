import { describe, expect, it } from 'vitest';
import { RetryBudget } from './retryBudget';

describe('RetryBudget', () => {
  it('the first pass is due at once; the next waits at least the minimum interval', () => {
    let t = 10_000;
    const b = new RetryBudget(1_000, 20, () => t);
    expect(b.begin()).toBe(true);
    b.end(); // took 0 ms
    expect(b.waitMs).toBe(1_000);
    expect(b.begin()).toBe(false);
    t += 999;
    expect(b.begin()).toBe(false);
    t += 1;
    expect(b.waitMs).toBe(0);
    expect(b.begin()).toBe(true);
  });

  it('a pass pays back its cost: the wait grows with how long the pass took', () => {
    let t = 0;
    const b = new RetryBudget(1_000, 20, () => t);
    expect(b.begin()).toBe(true);
    t += 200; // an expensive pass (big page, many unresolved highlights)
    b.end();
    expect(b.waitMs).toBe(4_000); // 20 x 200 ms: at most ~5% of the page's time
    t += 3_999;
    expect(b.begin()).toBe(false);
    t += 1;
    expect(b.begin()).toBe(true);
  });

  it('has no attempt cap and no deadline: a pass is always due again eventually', () => {
    let t = 0;
    const b = new RetryBudget(1_000, 20, () => t);
    let passes = 0;
    // 10 minutes of a page that is never quiet: one pass per interval, not 8 in total.
    for (; t < 600_000; t += 100) {
      if (b.begin()) {
        passes += 1;
        b.end();
      }
    }
    expect(passes).toBe(600);
  });

  it('never imposes more than a minute, even for a pass that took forever', () => {
    let t = 0;
    const b = new RetryBudget(1_000, 20, () => t);
    b.begin();
    t += 10_000;
    b.end();
    expect(b.waitMs).toBe(60_000);
  });

  it('a clock that jumps backwards does not stall retries', () => {
    let t = 1_000_000;
    const b = new RetryBudget(1_000, 20, () => t);
    b.begin();
    b.end();
    t -= 3_600_000; // NTP / manual correction
    expect(b.waitMs).toBe(0);
    expect(b.begin()).toBe(true);
  });

  it('reset (route change) makes the next pass due at once', () => {
    const b = new RetryBudget(1_000, 20, () => 0);
    b.begin();
    b.end();
    expect(b.begin()).toBe(false);
    b.reset();
    expect(b.begin()).toBe(true);
  });
});
