import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce, frameThrottle } from './timing';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('debounce', () => {
  it('fires once, after the quiet period', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    vi.advanceTimersByTime(60);
    d();
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending()).toBe(false);
  });

  it('maxWait stops a continuous stream of calls from starving the callback', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, 350);
    for (let t = 0; t < 400; t += 50) {
      d();
      vi.advanceTimersByTime(50);
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the pending call', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(false);
  });
});

describe('frameThrottle', () => {
  function fakeFrames() {
    const queue = new Map<number, FrameRequestCallback>();
    let next = 1;
    return {
      win: {
        requestAnimationFrame: (cb: FrameRequestCallback) => {
          queue.set(next, cb);
          return next++;
        },
        cancelAnimationFrame: (id: number) => void queue.delete(id),
      },
      run: () => {
        const cbs = [...queue.values()];
        queue.clear();
        cbs.forEach((cb) => cb(0));
      },
      size: () => queue.size,
    };
  }

  it('collapses many calls in one frame into one', () => {
    const frames = fakeFrames();
    const fn = vi.fn();
    const t = frameThrottle(frames.win, fn);
    t();
    t();
    t();
    expect(frames.size()).toBe(1);
    frames.run();
    expect(fn).toHaveBeenCalledTimes(1);
    t();
    frames.run();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel removes the scheduled frame', () => {
    const frames = fakeFrames();
    const fn = vi.fn();
    const t = frameThrottle(frames.win, fn);
    t();
    t.cancel();
    frames.run();
    expect(fn).not.toHaveBeenCalled();
  });
});
