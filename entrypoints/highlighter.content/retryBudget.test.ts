import { describe, expect, it } from 'vitest';
import { RetryBudget } from './retryBudget';

describe('RetryBudget', () => {
  it('allows 8 attempts inside the window, then refuses', () => {
    let t = 0;
    const b = new RetryBudget(8, 30_000, () => t);
    for (let i = 0; i < 8; i++) {
      t += 500;
      expect(b.tryConsume()).toBe(true);
    }
    expect(b.remaining).toBe(0);
    expect(b.tryConsume()).toBe(false);
  });

  it('refuses once the 30 s window has passed even with attempts left', () => {
    let t = 0;
    const b = new RetryBudget(8, 30_000, () => t);
    t = 29_999;
    expect(b.tryConsume()).toBe(true);
    t = 30_001;
    expect(b.tryConsume()).toBe(false);
    expect(b.remaining).toBe(0);
  });

  it('reset (route change) starts a new window and a new count', () => {
    let t = 0;
    const b = new RetryBudget(2, 1_000, () => t);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
    t = 5_000;
    b.reset();
    expect(b.remaining).toBe(2);
    expect(b.tryConsume()).toBe(true);
  });
});
