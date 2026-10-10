export interface Debounced {
  (): void;
  cancel(): void;
  pending(): boolean;
}

/**
 * Trailing-edge debounce. `maxWait` bounds starvation: a page that mutates continuously would
 * otherwise postpone the work forever. Timer functions are looked up at call time so fake timers
 * (tests) and `ctx` teardown behave.
 */
export function debounce(fn: () => void, wait: number, maxWait = Infinity): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt = 0;

  const fire = (): void => {
    timer = undefined;
    firstAt = 0;
    fn();
  };

  const debounced = (() => {
    const now = Date.now();
    if (timer === undefined) firstAt = now;
    else clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(wait, firstAt + maxWait - now)));
  }) as Debounced;

  debounced.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    firstAt = 0;
  };
  debounced.pending = () => timer !== undefined;
  return debounced;
}

export interface FrameThrottled {
  (): void;
  cancel(): void;
}

/** At most one call per animation frame (scroll/resize repositioning). */
export function frameThrottle(
  win: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>,
  fn: () => void,
): FrameThrottled {
  let frame = 0;
  const throttled = (() => {
    if (frame !== 0) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      fn();
    });
  }) as FrameThrottled;
  throttled.cancel = () => {
    if (frame !== 0) win.cancelAnimationFrame(frame);
    frame = 0;
  };
  return throttled;
}
