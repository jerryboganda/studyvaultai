import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useActiveTab } from './hooks';

const tab = (id: number, url: string) => [
  { id, windowId: 1, url, title: url, status: 'complete', active: true, index: 0 },
];

/** `tabs.query` whose answers are released by hand, in any order. */
function deferredQueries() {
  const calls: Array<{ resolve(v: unknown): void; reject(e: unknown): void }> = [];
  vi.spyOn(browser.tabs, 'query').mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        calls.push({ resolve, reject });
      }) as never,
  );
  return calls;
}

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

describe('useActiveTab', () => {
  it('shows the tab Chrome reports and follows tab switches', async () => {
    const calls = deferredQueries();
    const { result } = renderHook(() => useActiveTab());
    expect(result.current.loading).toBe(true);
    await act(async () => calls[0]!.resolve(tab(1, 'https://a.example/')));
    expect(result.current.tab).toMatchObject({ id: 1, url: 'https://a.example/' });

    await act(async () => {
      await fakeBrowser.tabs.onActivated.trigger({ tabId: 2, windowId: 1 });
    });
    await act(async () => calls[1]!.resolve(tab(2, 'https://b.example/')));
    expect(result.current.tab).toMatchObject({ id: 2, url: 'https://b.example/' });
  });

  it('an older query that answers late never overwrites the answer to a newer one', async () => {
    const calls = deferredQueries();
    const { result } = renderHook(() => useActiveTab()); // read 0 (mount)
    await act(async () => {
      await fakeBrowser.tabs.onActivated.trigger({ tabId: 2, windowId: 1 }); // read 1
    });
    expect(calls).toHaveLength(2);

    await act(async () => calls[1]!.resolve(tab(2, 'https://b.example/')));
    await act(async () => calls[0]!.resolve(tab(1, 'https://a.example/'))); // stale, arrives last
    expect(result.current.tab).toMatchObject({ id: 2, url: 'https://b.example/' });
  });

  it('an older query that fails late does not replace a newer success with an error', async () => {
    const calls = deferredQueries();
    const { result } = renderHook(() => useActiveTab());
    await act(async () => {
      await fakeBrowser.tabs.onActivated.trigger({ tabId: 2, windowId: 1 });
    });
    await act(async () => calls[1]!.resolve(tab(2, 'https://b.example/')));
    await act(async () => calls[0]!.reject(new Error('window closed')));
    expect(result.current.error).toBeNull();
    expect(result.current.tab?.id).toBe(2);
  });
});
