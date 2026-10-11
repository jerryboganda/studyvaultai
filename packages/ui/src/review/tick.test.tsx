import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTick } from './hooks';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

describe('useTick', () => {
  it('ticks on its interval while the page is shown', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTick(1_000));
    expect(result.current).toBe(0);
    act(() => void vi.advanceTimersByTime(3_000));
    expect(result.current).toBe(3);
  });

  it('does not tick while the page is hidden, and ticks once when it is shown again', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTick(1_000));

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(result.current).toBe(0);

    setVisibility('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current).toBe(1);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(2);
  });

  it('removes its listeners when it unmounts', () => {
    vi.useFakeTimers();
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useTick(1_000));
    unmount();
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
