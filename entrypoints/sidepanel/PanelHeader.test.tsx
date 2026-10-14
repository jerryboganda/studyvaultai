import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultSettings } from '@shared';
import type { GameState } from '@ui/game';
import { moreTargets } from './MoreTab';
import { PanelHeader } from './PanelHeader';

afterEach(cleanup);

const backfill = { status: 'done', done: 1, total: 1, error: null } as const;

function ready(over: { mode?: boolean; xp?: number; goal?: 10 | 30 | 50 | 100; streak?: number }) {
  return {
    ready: true,
    mode: over.mode ?? true,
    backfill,
    goal: { value: over.goal ?? 30, chosen: true },
    today: { xp: over.xp ?? 18 },
    streak: { current: over.streak ?? 12, longest: 12, todayCounts: true, freezes: 1 },
  } as unknown as GameState;
}

function header(game: GameState | undefined) {
  const handlers = { onRetryGame: vi.fn(), onDashboard: vi.fn(), onSettings: vi.fn() };
  render(<PanelHeader game={game} {...handlers} />);
  return handlers;
}

describe('side panel header', () => {
  it('shows the goal ring and streak from the real state while Game mode is on', () => {
    header(ready({ xp: 18, goal: 30, streak: 12 }));
    expect(screen.getByRole('img', { name: 'Daily goal: 18 of 30 XP' })).toBeTruthy();
    expect(screen.getByText('day streak', { exact: false }).closest('.sv-stat')?.textContent).toBe(
      '12 day streak',
    );
  });

  it('marks the goal done past the target and keeps counting', () => {
    header(ready({ xp: 42, goal: 30 }));
    expect(screen.getByRole('img', { name: 'Daily goal: 42 of 30 XP, done' })).toBeTruthy();
  });

  it('hides every game number while Game mode is off', () => {
    header(ready({ mode: false }));
    expect(screen.queryByRole('img', { name: /Daily goal/ })).toBeNull();
    expect(screen.queryByText(/streak/)).toBeNull();
    expect(screen.queryByTestId('game-status')).toBeNull();
  });

  it('shows no number while the ledger is being built, and nothing while unknown', () => {
    header({ ready: false, mode: true, backfill: { ...backfill, status: 'running' } } as never);
    expect(screen.getByTestId('game-counting').textContent).toBe('Counting XP…');
    expect(screen.queryByRole('img', { name: /Daily goal/ })).toBeNull();
    cleanup();

    header(undefined);
    expect(screen.queryByTestId('game-counting')).toBeNull();
    expect(screen.queryByTestId('game-status')).toBeNull();
  });

  it('offers a retry when the ledger could not be built', async () => {
    const { onRetryGame } = header({
      ready: false,
      mode: true,
      backfill: { ...backfill, status: 'failed', error: 'Disk full' },
    } as never);
    await userEvent.click(screen.getByRole('button', { name: 'Count XP again' }));
    expect(onRetryGame).toHaveBeenCalledOnce();
  });

  it('opens the dashboard and settings from icon buttons with names', async () => {
    const { onDashboard, onSettings } = header(undefined);
    await userEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onDashboard).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { level: 1, name: 'StudyVault' })).toBeTruthy();
  });
});

describe('More tiles', () => {
  const ids = (f: Parameters<typeof moreTargets>[0]) => moreTargets(f).map((t) => t.id);

  it('starts with Recent, then the contract order, and only real destinations', () => {
    expect(ids(defaultSettings().features)).toEqual([
      'recent',
      'exam',
      'syllabus',
      'cards',
      'stats',
      'rules',
      'backup',
      'duplicates',
      'trash',
      'graph',
      'storage',
      'pdf',
      'ai',
      'chat',
      'sync',
    ]);
  });

  it('badges switched-off features and sends them to their setup', () => {
    const tiles = moreTargets({ review: true, pdfReader: false, ai: false, sync: false });
    const tile = (id: string) => tiles.find((t) => t.id === id)!;
    expect(tile('ai').status).toBe('Off');
    expect(tile('sync').status).toBe('Off');
    expect(tile('chat').target).toEqual({ to: 'options', section: 'ai' });
    expect(tile('pdf').target).toEqual({ to: 'options', section: 'capture' });
    expect(tile('exam').status).toBeUndefined();
  });

  it('opens chat and the reader directly once they are on', () => {
    const tiles = moreTargets({ review: true, pdfReader: true, ai: true, sync: true });
    const tile = (id: string) => tiles.find((t) => t.id === id)!;
    expect(tiles.some((t) => t.status === 'Off')).toBe(false);
    expect(tile('chat').target).toEqual({ to: 'dashboard', target: { view: 'chat' } });
    expect(tile('pdf').target).toMatchObject({ to: 'page' });
  });

  it('opens Trash and Duplicates on their dashboard views', () => {
    const tile = (id: string) => moreTargets(null).find((t) => t.id === id)!;
    expect(tile('trash').target).toEqual({ to: 'page', path: 'dashboard.html?view=trash' });
    expect(tile('duplicates').target).toEqual({
      to: 'page',
      path: 'dashboard.html?view=duplicates',
    });
  });

  it('claims nothing while settings are unknown', () => {
    expect(moreTargets(null).some((t) => t.status === 'Off')).toBe(false);
  });
});
