import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { GameState, GameView } from '@ui/game';
import { BADGES } from '@ui/game';
import type { DueCount } from '@ui/review';
import { HomeView } from './HomeView';
import { Harness } from './testHarness';
import { FakeVault } from './testing';
import { loadTreeData } from './treeData';

const mocks = vi.hoisted(() => ({
  game: null as unknown as GameView,
  due: null as unknown as DueCount,
  setDailyGoal: vi.fn(async () => undefined),
}));

vi.mock('@ui/game', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useGame: () => mocks.game,
}));
vi.mock('@ui/review', async (original) => {
  const real = await original<{ defaultStudySettings(): unknown }>();
  return {
    ...real,
    useDueCount: () => mocks.due,
    useStudySettings: () => ({ settings: real.defaultStudySettings(), error: null }),
  };
});
vi.mock('@storage', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  setDailyGoal: mocks.setDailyGoal,
}));

const view = (data: GameState | undefined, extra: Partial<GameView> = {}): GameView =>
  ({
    data,
    error: null,
    retryable: false,
    loading: data === undefined,
    refreshing: false,
    reload: vi.fn(),
    refresh: vi.fn(),
    retryBackfill: vi.fn(async () => undefined),
    ...extra,
  }) as GameView;

const days = Array.from({ length: 84 }, (_, i) => ({
  dayKey: `2026-${String(7 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
  xp: i % 3 === 0 ? 0 : 20,
  goal: 30,
  met: false,
  frozen: i === 80,
}));

function ready(over: Partial<Extract<GameState, { ready: true }>> = {}): GameState {
  return {
    ready: true,
    rulesVersion: 1,
    mode: true,
    backfill: { status: 'done', done: 10, total: 10, error: null },
    pending: [],
    cacheUpdate: null,
    goal: { value: 30, chosen: true },
    today: {
      dayKey: '2026-10-14',
      xp: 18,
      met: false,
      reviews: 8,
      saves: 3,
      cards: 1,
      sessions: 0,
    },
    totalXp: 340,
    level: { level: 4, floorXp: 300, nextXp: 500 },
    streak: { current: 12, longest: 20, todayCounts: false, freezes: 1 },
    badges: BADGES.map((b, i) => ({
      id: b.id,
      unlockedDayKey: i < 2 ? `2026-10-0${i + 1}` : null,
      value: i === 4 ? 60 : 0,
      target: b.target,
    })),
    days,
    ...over,
  } as GameState;
}

const dueOf = (count: number | null): DueCount => ({
  count,
  summary:
    count === null
      ? null
      : ({
          total: { new: 2, learning: 1, review: count - 3, total: count },
          byBank: { 'bank-bio': { new: 0, learning: 0, review: 4, total: 4 } },
        } as unknown as DueCount['summary']),
  resumable: null,
  loading: count === null,
  error: null,
  retryable: false,
  refresh: vi.fn(),
});

beforeEach(() => {
  fakeBrowser.reset();
  mocks.game = view(ready());
  mocks.due = dueOf(14);
  mocks.setDailyGoal.mockClear();
});
afterEach(cleanup);

async function open(o: { treeError?: string | null } = {}) {
  const vault = new FakeVault([
    { id: 'hl-00000001', quote: 'A', bankIds: ['bank-bio'] },
    { id: 'hl-00000002', quote: 'B', bankIds: ['bank-bio'] },
  ]);
  vault.addBank('bank-bio', 'Biology', 'green');
  vault.study = { 'bank-bio': { cards: 7, retention: 0.72 } };
  const api = vault.api();
  const tree = await loadTreeData(api);
  const props = {
    onOpenBank: vi.fn(),
    onAllBanks: vi.fn(),
    onNewBank: vi.fn(),
    onRetryTree: vi.fn(),
  };
  render(
    <Harness api={api} tree={tree}>
      <HomeView
        {...props}
        due={mocks.due}
        treeError={o.treeError ?? null}
        more={<p>More tiles</p>}
      />
    </Harness>,
  );
  return { vault, ...props };
}

describe('HomeView', () => {
  it('greets, says how many cards are ready with the mix, and links Start review', async () => {
    await open();
    const hero = screen.getByTestId('home-hero');
    expect(within(hero).getByRole('heading', { level: 1 }).textContent).toMatch(/^Good /);
    expect(hero.textContent).toContain('14 cards ready');
    expect(within(hero).getByRole('list', { name: 'Due mix' }).textContent).toContain('2 new');
    const start = screen.getByTestId('home-start-review');
    expect(start.textContent).toContain('Start review');
    expect(start.getAttribute('href')).toContain('review.html?start=1');
    expect(start.getAttribute('target')).toBe('_blank');
  });

  it('offers the review page, not a session, when nothing is due', async () => {
    mocks.due = dueOf(0);
    await open();
    expect(screen.getByTestId('home-hero').textContent).toContain('Nothing due right now');
    const link = screen.getByTestId('home-start-review');
    expect(link.textContent).toContain('Open review');
    expect(link.getAttribute('href')).not.toContain('start=1');
  });

  it('shows the goal ring, streak, freezes and level from the game state', async () => {
    await open();
    const today = screen.getByTestId('home-today');
    expect(within(today).getByRole('img', { name: 'Daily goal: 18 of 30 XP' })).toBeTruthy();
    expect(today.textContent).toContain('12 day streak');
    expect(within(today).getByRole('img', { name: '1 of 2 streak freezes' })).toBeTruthy();
    const level = within(today).getByRole('progressbar', { name: 'Level 4' });
    expect(level.getAttribute('aria-valuenow')).toBe('40');
    expect(level.getAttribute('aria-valuemax')).toBe('200');
    expect(screen.getByRole('grid', { name: /Streak calendar/ })).toBeTruthy();
  });

  it('hides every game part with Game mode off and shows plain counts instead', async () => {
    mocks.game = view(ready({ mode: false }));
    await open();
    const today = screen.getByTestId('home-today');
    expect(today.textContent).toContain('8 reviewed');
    expect(today.textContent).toContain('3 saved');
    expect(today.textContent).toContain('1 card made');
    expect(screen.queryByRole('img', { name: /Daily goal/ })).toBeNull();
    expect(screen.queryByRole('grid', { name: /Streak calendar/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Badges' })).toBeNull();
    expect(screen.queryByTestId('home-goal-save')).toBeNull();
  });

  it('shows real backfill progress and no numbers until the ledger is ready', async () => {
    mocks.game = view({
      ready: false,
      mode: true,
      backfill: { status: 'running', done: 250, total: 1000, error: null },
    });
    await open();
    const today = screen.getByTestId('home-today');
    expect(today.textContent).toContain('Counting your XP');
    expect(within(today).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('250');
    expect(today.textContent).not.toContain('XP of');
    expect(screen.queryByRole('img', { name: /Daily goal/ })).toBeNull();
  });

  it('names the wait without XP while Game mode is off', async () => {
    mocks.game = view({
      ready: false,
      mode: false,
      backfill: { status: 'running', done: 1, total: 4, error: null },
    });
    await open();
    const today = screen.getByTestId('home-today');
    expect(today.textContent).toContain('Counting today');
    expect(today.textContent).not.toContain('XP');
  });

  it('shows an empty state, not a calendar of zeros, before any XP was earned', async () => {
    mocks.game = view(ready({ days: days.map((d) => ({ ...d, xp: 0, frozen: false })) }));
    await open();
    expect(screen.getByText('No study days yet')).toBeTruthy();
    expect(screen.queryByRole('grid', { name: /Streak calendar/ })).toBeNull();
  });

  it('lets a failed backfill be tried again', async () => {
    const retryBackfill = vi.fn(async () => undefined);
    mocks.game = view(
      { ready: false, mode: true, backfill: { status: 'failed', done: 0, total: 0, error: 'x' } },
      { retryBackfill },
    );
    await open();
    fireEvent.click(
      within(screen.getByTestId('home-today')).getByRole('button', { name: /Try again/ }),
    );
    expect(retryBackfill).toHaveBeenCalled();
  });

  it('asks once for a daily goal and saves the choice', async () => {
    mocks.game = view(ready({ goal: { value: 30, chosen: false } }));
    await open();
    const card = screen.getByRole('region', { name: 'Pick your daily goal' });
    expect(within(card).getByRole('radio', { name: /Regular/ })).toHaveProperty('checked', true);
    fireEvent.click(within(card).getByRole('radio', { name: /Serious/ }));
    fireEvent.click(screen.getByTestId('home-goal-save'));
    await waitFor(() => expect(mocks.setDailyGoal).toHaveBeenCalledWith(50));
  });

  it('lists the banks with saved and card counts, retention, due badges and New bank', async () => {
    const { onOpenBank, onNewBank, vault } = await open();
    const banks = await screen.findAllByTestId('home-bank');
    const bio = banks.find((b) => b.textContent?.includes('Biology'))!;
    await waitFor(() => expect(bio.textContent).toContain('2 saved · 7 cards'));
    expect(within(bio).getByRole('progressbar', { name: 'Biology recall' })).toBeTruthy();
    expect(bio.textContent).toContain('72%');
    expect(bio.textContent).toContain('4 due');
    // The Inbox has no cards: no bar, "n/a", never a made-up 0%.
    const inbox = banks.find((b) => b.textContent?.includes('Inbox'))!;
    expect(within(inbox).queryByRole('progressbar')).toBeNull();
    expect(vault.called('bankStudy')).not.toHaveLength(0);

    fireEvent.click(bio);
    expect(onOpenBank).toHaveBeenCalledWith('bank-bio');
    fireEvent.click(screen.getByTestId('home-new-bank'));
    expect(onNewBank).toHaveBeenCalled();
  });

  it('says when the banks could not be read, with a retry', async () => {
    const { onRetryTree } = await open({ treeError: 'Storage is unavailable' });
    expect(screen.getByText('Could not read your banks.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(onRetryTree).toHaveBeenCalled();
  });

  it('shows earned badges and the next one, and opens the badges sheet', async () => {
    await open();
    const card = screen.getByRole('region', { name: 'Badges' });
    expect(card.textContent).toContain(`2/${BADGES.length}`);
    expect(card.textContent).toContain('Next up:');
    expect(card.textContent).toContain(BADGES[4]!.name);
    fireEvent.click(screen.getByTestId('home-badges-all'));
    const sheet = await screen.findByTestId('badges-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Level 4' })).toBeTruthy();
    const locked = within(sheet).getByRole('button', { name: /First 100 cards, locked/ });
    fireEvent.click(locked);
    expect(locked.getAttribute('aria-pressed')).toBe('true');
    expect(sheet.textContent).toContain('Make 100 cards');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('badges-sheet')).toBeNull());
  });
});
