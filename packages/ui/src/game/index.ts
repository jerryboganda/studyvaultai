// Game layer UI hooks (ADR-022). Import from '@ui/game'.
//   useGame()                    live GameState, runs the backfill, keeps the cache, rollover refresh
//   useCelebrations(state, o)    today's celebrations, claimed once per device, one at a time
// Writes the screens call directly from '@storage': setDailyGoal, setGameMode.
export { BACKFILL_POLL_MS, useGame, type GameView } from './useGame';
export { useCelebrations, type CelebrationQueue } from './useCelebrations';
export type { BackfillView, GameState } from '@storage';
export type { BadgeId, Celebration, DailyGoal } from '@study';
export { BADGES, DAILY_GOALS, DEFAULT_DAILY_GOAL, XP, xpForLevel } from '@study';
