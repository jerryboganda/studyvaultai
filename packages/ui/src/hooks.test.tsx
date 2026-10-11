import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useActiveTab, useAsync, useSettings, useShortcuts } from './hooks';

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

describe('useActiveTab retry', () => {
  it('queries again after a failure and clears the error', async () => {
    const calls = deferredQueries();
    const { result } = renderHook(() => useActiveTab());
    await act(async () => calls[0]!.reject(new Error('No window')));
    expect(result.current.error).toBe('No window');

    act(() => result.current.retry());
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => calls[1]!.resolve(tab(3, 'https://c.example/')));
    expect(result.current.tab).toMatchObject({ id: 3 });
    expect(result.current.error).toBeNull();
  });
});

describe('useSettings retry', () => {
  it('reads again after a failed read', async () => {
    const get = vi
      .spyOn(browser.storage.local, 'get')
      .mockRejectedValueOnce(new Error('Disk unavailable'));
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.error).toBe('Disk unavailable'));

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.settings).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('useAsync refresh', () => {
  it('keeps the old data and error visible while a refresh is in flight', async () => {
    let attempt = 0;
    let release: (v: string) => void = () => undefined;
    const { result } = renderHook(() =>
      useAsync<string>(() => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error('first failed'));
        return new Promise((resolve) => {
          release = resolve;
        });
      }, []),
    );
    await waitFor(() => expect(result.current.error).toBe('first failed'));
    expect(result.current.refreshing).toBe(false);

    act(() => result.current.refresh());

    expect(result.current.error).toBe('first failed'); // not blanked
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    await act(async () => release('fine'));
    expect(result.current.data).toBe('fine');
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
  });
});

describe('useShortcuts', () => {
  const listed = [
    { name: 'quick-save', description: 'Quick-save', shortcut: 'Alt+Shift+H' },
    { name: 'previous-highlight', description: 'Previous', shortcut: '' },
    { name: '', description: 'nameless', shortcut: 'X' },
  ];
  const useCommands = (getAll: unknown) => {
    (browser as unknown as { commands: unknown }).commands = { getAll };
  };

  it('reads the commands Chrome reports and drops nameless entries', async () => {
    useCommands(vi.fn(async () => listed));
    const { result } = renderHook(() => useShortcuts());
    await waitFor(() => expect(result.current.commands).not.toBeNull());
    expect(result.current.commands).toEqual([
      { name: 'quick-save', description: 'Quick-save', shortcut: 'Alt+Shift+H' },
      { name: 'previous-highlight', description: 'Previous', shortcut: '' },
    ]);
  });

  it('re-reads when the page regains focus (shortcuts are edited in another tab)', async () => {
    const getAll = vi.fn(async () => listed.slice(0, 1));
    useCommands(getAll);
    const { result } = renderHook(() => useShortcuts());
    await waitFor(() => expect(result.current.commands).toHaveLength(1));
    getAll.mockResolvedValue([{ ...listed[0]!, shortcut: 'Ctrl+Shift+1' }]);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.commands?.[0]?.shortcut).toBe('Ctrl+Shift+1'));
  });

  it('reports a synchronous failure and recovers on retry', async () => {
    const getAll = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('commands API is not available');
      })
      .mockResolvedValue(listed.slice(0, 1));
    useCommands(getAll);
    const { result } = renderHook(() => useShortcuts());
    await waitFor(() => expect(result.current.error).toBe('commands API is not available'));
    expect(result.current.commands).toBeNull();

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.commands).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });
});
