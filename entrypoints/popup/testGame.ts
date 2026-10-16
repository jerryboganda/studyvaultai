import { vi } from 'vitest';
import type { GameState, GameView } from '@ui/game';

/** Test-only: a `useGame()` answer for the popup tests (the ledger itself is tested in @ui/game). */
export type GameFake = GameView & {
  refresh: ReturnType<typeof vi.fn>;
  retryBackfill: ReturnType<typeof vi.fn>;
};

const backfill = { status: 'done' as const, done: 0, total: 0, error: null };

/** A ready ledger: 18 of 30 XP today, a 12-day streak, level 3; Game mode on unless `mode: false`. */
export function readyGame(over: { mode?: boolean; xp?: number; met?: boolean } = {}): GameState {
  return {
    ready: true,
    mode: over.mode ?? true,
    backfill,
    goal: { value: 30, chosen: true },
    today: {
      dayKey: '2026-10-14',
      xp: over.xp ?? 18,
      met: over.met ?? false,
      reviews: 8,
      saves: 3,
      cards: 0,
      sessions: 1,
    },
    totalXp: 400,
    level: { level: 3, floorXp: 150, nextXp: 300 },
    streak: { current: 12, longest: 20, todayCounts: false, freezes: 1 },
    badges: [],
    days: [],
    pending: [],
  } as unknown as GameState;
}

export function gameState(
  over: { data?: GameState | undefined; error?: string | null; retryable?: boolean } = {},
): GameFake {
  return {
    data: 'data' in over ? over.data : readyGame(),
    error: over.error ?? null,
    retryable: over.retryable ?? true,
    loading: false,
    refreshing: false,
    reload: vi.fn(),
    refresh: vi.fn(),
    retryBackfill: vi.fn(async () => undefined),
  } as unknown as GameFake;
}
