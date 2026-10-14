import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, renderHook, waitFor } from '@testing-library/react';
import { browser } from 'wxt/browser';
import { getDb, setGameMode } from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { STUDY_SETTINGS_KEY, defaultStudySettings } from '../review/settings';
import { useCelebrations } from './useCelebrations';
import { useGame } from './useGame';

vi.setConfig({ testTimeout: 30_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 10_000 });

const UTC = { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 0 };

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(async () => {
  await freshDatabase();
  await browser.storage.local.set({ [STUDY_SETTINGS_KEY]: UTC });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('useGame', () => {
  it('shows progress, never a number, until the backfill it started is done', async () => {
    await save();
    const seen: Array<boolean | undefined> = [];
    const { result } = renderHook(() => {
      const game = useGame();
      seen.push(game.data?.ready);
      return game;
    });
    await waitFor(() => expect(result.current.data?.ready).toBe(true));
    expect(seen.indexOf(false)).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf(false)).toBeLessThan(seen.indexOf(true));
    const state = result.current.data!;
    if (!state.ready) throw new Error('not ready');
    expect(state.backfill.status).toBe('done');
    expect(state.totalXp).toBe(2); // the save made before the game existed
    expect(state.today.saves).toBe(1);
    expect(result.current.loading).toBe(false);
  });

  it('keeps the closed-day cache the state hands back', async () => {
    const { result } = renderHook(() => useGame());
    await waitFor(() => expect(result.current.data?.ready).toBe(true));
    await waitFor(async () =>
      expect((await getDb().meta.get('game.cache'))?.value).toMatchObject({
        v: 1,
        cutDay: expect.any(Number),
      }),
    );
  });

  it('follows writes from anywhere: a new save adds its XP without a reload', async () => {
    const { result } = renderHook(() => useGame());
    await waitFor(() => expect(result.current.data?.ready).toBe(true));
    await act(async () => {
      await save();
    });
    await waitFor(() => expect(result.current.data).toMatchObject({ totalXp: 2 }));
  });

  it('waits for Retry after a failed backfill instead of trying again by itself', async () => {
    const at = new Date().toISOString();
    await getDb().meta.put({
      key: 'game.backfill',
      value: {
        v: 1,
        runId: 'run-failed-1',
        rulesVersion: 1,
        status: 'failed',
        table: 'reviewLogs',
        after: null,
        added: 0,
        done: 0,
        total: 0,
        startedAt: at,
        heartbeatAt: at,
        error: 'quota_exceeded',
      },
      updatedAt: at,
    });
    const { result } = renderHook(() => useGame());
    await waitFor(() =>
      expect(result.current.data?.backfill).toMatchObject({
        status: 'failed',
        error: 'quota_exceeded',
      }),
    );
    await new Promise((r) => setTimeout(r, 1_500)); // longer than one progress poll
    expect(result.current.data?.ready).toBe(false);

    await act(() => result.current.retryBackfill());
    await waitFor(() => expect(result.current.data?.ready).toBe(true));
  });

  it('moves to the next study day at the rollover, with no write', async () => {
    const midnight = Date.parse('2026-03-03T00:00:00.000Z');
    let clock = midnight - 300; // the rollover timer fires in about 0.3 s of real time
    const { result } = renderHook(() => useGame({ now: () => clock }));
    await waitFor(() =>
      expect(result.current.data).toMatchObject({ ready: true, today: { dayKey: '2026-03-02' } }),
    );
    clock = midnight + 60_000;
    await waitFor(() =>
      expect(result.current.data).toMatchObject({ today: { dayKey: '2026-03-03' } }),
    );
  });
});

/** One extension page: its game state and its celebrations. */
const page = (o: { enabled?: boolean } = {}) =>
  renderHook((p: { enabled?: boolean }) => useCelebrations(useGame().data, p), {
    initialProps: o,
  });

describe('useCelebrations', () => {
  it('a milestone is celebrated by exactly one of two open pages, once', async () => {
    const one = page();
    const two = page();
    await waitFor(() => expect(getDb().meta.get('game.seen')).resolves.toBeDefined());
    await act(async () => {
      await save(); // the first save: badge "First save", dated today, after the baseline
    });
    await waitFor(() =>
      expect([one.result.current.current?.key, two.result.current.current?.key]).toContain(
        'badge:first_save',
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    const shown = [one, two].filter((p) => p.result.current.current !== null);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.result.current.current).toMatchObject({
      kind: 'badge',
      badgeId: 'first_save',
    });

    act(() => shown[0]!.result.current.dismiss());
    expect(shown[0]!.result.current.current).toBeNull();
    // A third page opened later has nothing left to show.
    const three = page();
    await waitFor(() => expect(getDb().meta.get('game.seen')).resolves.toBeDefined());
    await new Promise((r) => setTimeout(r, 300));
    expect(three.result.current.current).toBeNull();
  });

  it('claims nothing while the page is hidden, and claims once it is shown', async () => {
    setVisibility('hidden');
    const p = page();
    await waitFor(() => expect(getDb().meta.get('game.seen')).resolves.toBeDefined());
    await act(async () => {
      await save();
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(p.result.current.current).toBeNull();
    expect((await getDb().meta.get('game.seen'))?.value).toMatchObject({ keys: [] });

    act(() => setVisibility('visible'));
    await waitFor(() => expect(p.result.current.current?.key).toBe('badge:first_save'));
  });

  it('waits for the point to celebrate (the done screen), never mid-card', async () => {
    const p = page({ enabled: false });
    await waitFor(() => expect(getDb().meta.get('game.seen')).resolves.toBeDefined());
    await act(async () => {
      await save();
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(p.result.current.current).toBeNull();
    expect((await getDb().meta.get('game.seen'))?.value).toMatchObject({ keys: [] });

    p.rerender({ enabled: true });
    await waitFor(() => expect(p.result.current.current?.key).toBe('badge:first_save'));
    p.rerender({ enabled: false }); // a new session started before it was dismissed: it waits
    expect(p.result.current.current).toBeNull();
    p.rerender({ enabled: true });
    expect(p.result.current.current?.key).toBe('badge:first_save');
  });

  it('shows nothing while Game mode is off, and no backlog when it is switched back on', async () => {
    const p = page();
    await waitFor(() => expect(getDb().meta.get('game.seen')).resolves.toBeDefined());
    await act(async () => {
      await setGameMode(false);
      await save();
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(p.result.current.current).toBeNull();
    await act(async () => {
      await setGameMode(true);
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(p.result.current.current).toBeNull();
    expect((await getDb().meta.get('game.seen'))?.value).toMatchObject({ keys: [] });
  });

  it('drops what was waiting when Game mode is switched off', async () => {
    const p = page();
    await waitFor(() => expect(getDb().meta.get('game.seen')).resolves.toBeDefined());
    await act(async () => {
      await save();
    });
    await waitFor(() => expect(p.result.current.current?.key).toBe('badge:first_save'));
    await act(async () => {
      await setGameMode(false);
    });
    await waitFor(() => expect(p.result.current.current).toBeNull());
    await act(async () => {
      await setGameMode(true);
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(p.result.current.current).toBeNull();
  });
});
