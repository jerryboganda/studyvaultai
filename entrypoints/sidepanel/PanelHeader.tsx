import { Flame, House, RefreshCw, Settings } from 'lucide-react';
import { IconButton, ProgressRing, StatChip, VaultBuddy } from '@ui';
import type { GameState } from '@ui/game';

/**
 * Side panel header (UX_DESIGN 7.2): the mascot, today's goal ring and the streak (Game mode on
 * only), then Dashboard and Settings. While the game ledger is being built it says so quietly and
 * shows no number; a failed build offers Retry. The game is display only here: nothing is written.
 */
export function PanelHeader({
  game,
  onRetryGame,
  onDashboard,
  onSettings,
}: {
  /** undefined while unknown or unreadable: then nothing game-related is drawn. */
  game: GameState | undefined;
  onRetryGame(): void;
  onDashboard(): void;
  onSettings(): void;
}) {
  return (
    <header className="panel__head">
      <h1 className="sv-sr">StudyVault</h1>
      <VaultBuddy pose="wave" size={40} className="panel__buddy" />
      <GameStatus game={game} onRetry={onRetryGame} />
      {/* One group, so a narrow (zoomed) header wraps both buttons together, never one alone. */}
      <span className="panel__actions">
        <IconButton icon={House} label="Open dashboard" onClick={onDashboard} />
        <IconButton icon={Settings} label="Settings" tipSide="left" onClick={onSettings} />
      </span>
    </header>
  );
}

export function GameStatus({ game, onRetry }: { game: GameState | undefined; onRetry(): void }) {
  if (!game?.mode) return null;
  if (!game.ready) {
    return game.backfill.status === 'failed' ? (
      <span className="panel__game">
        <span className="panel__counting">XP not counted</span>
        <IconButton icon={RefreshCw} label="Count XP again" size="sm" onClick={onRetry} />
      </span>
    ) : (
      <span className="panel__game panel__counting" data-testid="game-counting">
        Counting XP…
      </span>
    );
  }
  const { today, goal, streak } = game;
  return (
    <span className="panel__game" data-testid="game-status">
      <ProgressRing
        value={today.xp}
        max={goal.value}
        label="Daily goal"
        unit="XP"
        size={42}
        stroke={6}
        className="panel__ring"
      >
        <span className="panel__ringNum">{today.xp}</span>
      </ProgressRing>
      <StatChip icon={Flame} value={streak.current} label="day streak" tone="flame" hideLabel />
    </span>
  );
}
