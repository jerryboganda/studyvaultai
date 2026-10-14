import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Flame, Layers, Library, Plus, Search, Sparkles, Trash } from 'lucide-react';
import { BarMeter } from './BarMeter';
import { ChunkyButton, IconButton } from './Buttons';
import { Confetti } from './Confetti';
import { EmptyState } from './EmptyState';
import { Heatmap } from './Heatmap';
import { IconTabBar } from './IconTabBar';
import { MoreGrid } from './MoreGrid';
import { ProgressRing } from './ProgressRing';
import { StatChip } from './StatChip';
import { VaultBuddy } from './VaultBuddy';
import { useXpFloat } from './XpFloat';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: reduce && media.includes('prefers-reduced-motion'),
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
}

describe('ProgressRing', () => {
  it('names the goal with its numbers and links an optional description', () => {
    render(
      <ProgressRing value={18} max={30} unit="XP" label="Daily goal" description="12 XP to go">
        18
      </ProgressRing>,
    );
    const ring = screen.getByRole('img', { name: 'Daily goal: 18 of 30 XP' });
    expect(document.getElementById(ring.getAttribute('aria-describedby')!)?.textContent).toBe(
      '12 XP to go',
    );
    // Sun tone draws the outline arc under the yellow one.
    expect(ring.querySelectorAll('.sv-ring__edge, .sv-ring__value')).toHaveLength(2);
  });

  it('at or past the goal stays full, says done and shows a check badge', () => {
    render(<ProgressRing value={35} max={30} unit="XP" label="Daily goal" />);
    const ring = screen.getByRole('img', { name: 'Daily goal: 35 of 30 XP, done' });
    expect(ring.querySelector('.sv-ring__done')?.getAttribute('aria-hidden')).toBe('true');
    const value = ring.querySelector<SVGCircleElement>('.sv-ring__value')!;
    const [arc, gap] = value.getAttribute('stroke-dasharray')!.split(' ').map(Number);
    expect(arc).toBeCloseTo(gap!); // the whole circumference
  });

  it('draws no arc at zero (a round cap would leave a dot)', () => {
    render(<ProgressRing value={0} max={30} label="Daily goal" />);
    const ring = screen.getByRole('img', { name: 'Daily goal: 0 of 30' });
    expect(ring.querySelectorAll('.sv-ring__edge, .sv-ring__value')).toHaveLength(0);
  });
});

describe('BarMeter', () => {
  it('shows an empty bar at zero, with no stub', () => {
    render(<BarMeter value={0} max={4} label="Cards done" />);
    const bar = screen.getByRole('progressbar', { name: 'Cards done' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.hasAttribute('data-empty')).toBe(true);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%');
  });

  it('clamps out-of-range values and survives max 0', () => {
    const { rerender } = render(<BarMeter value={9} max={4} label="Level" valueText="Full" />);
    const bar = screen.getByRole('progressbar', { name: 'Level' });
    expect(bar.getAttribute('aria-valuenow')).toBe('4');
    expect(bar.getAttribute('aria-valuetext')).toBe('Full');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
    rerender(<BarMeter value={3} max={0} label="Level" />);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%');
  });
});

describe('EmptyState', () => {
  it('shows a decorative mascot, a heading, one line and one working action', async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No banks yet"
        text="Make one to start."
        action={{ label: 'New bank', icon: Plus, onClick }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No banks yet' })).toBeTruthy();
    expect(screen.getByText('Make one to start.')).toBeTruthy();
    expect(document.querySelector('.sv-buddy')?.getAttribute('aria-hidden')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'New bank' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders no button without an action', () => {
    render(<EmptyState title="All done" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Confetti', () => {
  it('renders nothing under prefers-reduced-motion and reports done at once', () => {
    stubReducedMotion(true);
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<Confetti onDone={onDone} />);
    expect(screen.queryByTestId('sv-confetti')).toBeNull();
    act(() => vi.advanceTimersByTime(0));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('otherwise plays one hidden burst that ends in under 5 s', () => {
    stubReducedMotion(false);
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<Confetti pieces={12} onDone={onDone} />);
    const burst = screen.getByTestId('sv-confetti');
    expect(burst.getAttribute('aria-hidden')).toBe('true');
    expect(burst.children).toHaveLength(12);
    for (const bit of burst.children) {
      const { animationDelay, animationDuration } = (bit as HTMLElement).style;
      expect(parseFloat(animationDelay) + parseFloat(animationDuration)).toBeLessThan(5);
    }
    act(() => vi.advanceTimersByTime(3700));
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

function XpHarness() {
  const xp = useXpFloat(150);
  return (
    <div>
      <button type="button" onClick={() => xp.award(2)}>
        Save
      </button>
      <span>{xp.node}</span>
    </div>
  );
}

describe('useXpFloat', () => {
  it('shows "+2 XP" hidden from screen readers, with no live region of its own, then removes it', async () => {
    const user = userEvent.setup();
    render(<XpHarness />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const float = document.querySelector('.sv-xpfloat')!;
    expect(float.textContent).toBe('+2 XP');
    expect(float.closest('[aria-hidden="true"]')).toBeTruthy();
    // The surface's one polite region speaks the XP with the save (UX_DESIGN 6.14).
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelector('[aria-live]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(document.querySelectorAll('.sv-xpfloat')).toHaveLength(1); // restarts, never stacks
    await waitFor(() => expect(document.querySelector('.sv-xpfloat')).toBeNull());
  });
});

describe('Heatmap', () => {
  // 10 days ending Wednesday 14 Oct 2026; goal 30.
  const days = [0, 10, 30, 45, 0, 20, 31, 0, 50, 18];
  const end = new Date(2026, 9, 14);

  it('is a keyboard grid: arrows move by day and week, cells name date and XP', async () => {
    const user = userEvent.setup();
    render(<Heatmap days={days} goal={30} title="Streak calendar" end={end} locale="en-US" />);
    const grid = screen.getByRole('grid', {
      name: 'Streak calendar: active 7 of 10 days, goal met on 4.',
    });
    const today = screen.getByRole('gridcell', { name: 'Wed, Oct 14: 18 XP, today' });
    expect(today.tabIndex).toBe(0);
    expect(grid.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);

    await user.tab(); // the table toggle
    await user.tab();
    expect(document.activeElement).toBe(today);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(
      screen.getByRole('gridcell', { name: 'Wed, Oct 7: 30 XP, goal met' }),
    );
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(
      screen.getByRole('gridcell', { name: 'Tue, Oct 6: 10 XP' }),
    );
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: 'Mon, Oct 5: 0 XP' }));
  });

  it('shows a tooltip for the focused day that Escape dismisses without moving focus', async () => {
    const user = userEvent.setup();
    const onOuterEscape = vi.fn();
    render(
      <div onKeyDown={(e) => e.key === 'Escape' && onOuterEscape()}>
        <Heatmap days={days} goal={30} title="Streak calendar" end={end} locale="en-US" />
      </div>,
    );
    const today = screen.getByRole('gridcell', { name: /Oct 14/ });
    act(() => today.focus());
    const tip = document.querySelector('.sv-heat__tip')!;
    expect(tip.textContent).toBe('Wed, Oct 14: 18 XP, today');
    expect(tip.getAttribute('aria-hidden')).toBe('true');

    await user.keyboard('{Escape}');
    expect(document.querySelector('.sv-heat__tip')).toBeNull();
    expect(document.activeElement).toBe(today);
    expect(onOuterEscape).not.toHaveBeenCalled(); // first Escape only closes the tip
    await user.keyboard('{Escape}');
    expect(onOuterEscape).toHaveBeenCalledTimes(1);
  });

  it('Escape hides a tip shown by hover alone (focus elsewhere) and stops there (WCAG 1.4.13)', async () => {
    const user = userEvent.setup();
    const onOuterEscape = vi.fn();
    render(
      <div onKeyDown={(e) => e.key === 'Escape' && onOuterEscape()}>
        <input aria-label="Elsewhere" />
        <Heatmap days={days} goal={30} title="Streak calendar" end={end} locale="en-US" />
      </div>,
    );
    const field = screen.getByRole('textbox', { name: 'Elsewhere' });
    field.focus();
    await user.hover(screen.getByRole('gridcell', { name: /Oct 7/ }));
    expect(document.querySelector('.sv-heat__tip')?.textContent).toBe(
      'Wed, Oct 7: 30 XP, goal met',
    );
    await user.keyboard('{Escape}');
    expect(document.querySelector('.sv-heat__tip')).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(onOuterEscape).not.toHaveBeenCalled();
  });

  it('marks a day saved by a freeze in the cell name, with a snowflake, and in the table', async () => {
    const user = userEvent.setup();
    render(
      <Heatmap
        days={days}
        goal={30}
        title="Streak calendar"
        end={end}
        locale="en-US"
        frozen={[4]}
      />,
    );
    const cell = screen.getByRole('gridcell', { name: 'Fri, Oct 9: 0 XP, freeze used' });
    expect(cell.querySelector('svg.sv-heat__ice')?.getAttribute('aria-hidden')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Show as table' }));
    expect(screen.getByRole('cell', { name: '0, freeze used' })).toBeTruthy();
  });

  it('swaps to a data table with the same numbers', async () => {
    const user = userEvent.setup();
    render(<Heatmap days={days} goal={30} title="Streak calendar" end={end} locale="en-US" />);
    await user.click(screen.getByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table');
    expect(table.querySelector('caption')?.textContent).toContain('active 7 of 10 days');
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 weeks
    expect(screen.getByRole('rowheader', { name: 'Oct 5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show calendar' })).toBeTruthy();
  });
});

describe('IconTabBar', () => {
  function Bar() {
    const [tab, setTab] = useState<'banks' | 'review' | 'search' | 'more'>('banks');
    return (
      <IconTabBar
        label="Side panel"
        tabs={[
          { id: 'banks', label: 'Banks', icon: Library },
          { id: 'review', label: 'Review', icon: Layers, count: 14 },
          { id: 'search', label: 'Search', icon: Search },
        ]}
        more={{ id: 'more' }}
        active={tab}
        onChange={setTab}
      >
        <p>{`${tab} panel`}</p>
      </IconTabBar>
    );
  }

  it('roves with arrows/Home/End, activates, and labels the panel by the active tab', async () => {
    const user = userEvent.setup();
    render(<Bar />);
    expect(screen.getByRole('tablist', { name: 'Side panel' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Banks',
      '14Review (14)',
      'Search',
      'More',
    ]);
    screen.getByRole('tab', { name: 'Banks' }).focus();
    await user.keyboard('{ArrowRight}');
    // Chrome names it "Review (14)"; jsdom's name computation drops the space.
    const review = screen.getByRole('tab', { name: /^Review ?\(14\)$/ });
    expect(document.activeElement).toBe(review);
    expect(review.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: /^Review/ }).textContent).toBe('review panel');

    await user.keyboard('{End}');
    expect(screen.getByRole('tabpanel', { name: 'More' })).toBeTruthy();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Banks' }));
    expect(screen.getAllByRole('tab').filter((t) => t.tabIndex === 0)).toHaveLength(1);
  });
});

describe('small pieces', () => {
  it('IconButton is named by its label; Escape hides its tooltip without moving focus', async () => {
    const user = userEvent.setup();
    render(<IconButton icon={Trash} label="Delete" />);
    const button = screen.getByRole('button', { name: 'Delete' });
    await user.tab();
    expect(document.activeElement).toBe(button);
    const wrap = button.parentElement!;
    expect(wrap.hasAttribute('data-tip-off')).toBe(false);
    await user.keyboard('{Escape}');
    expect(wrap.hasAttribute('data-tip-off')).toBe(true);
    expect(document.activeElement).toBe(button);
    await user.hover(button);
    expect(wrap.hasAttribute('data-tip-off')).toBe(false);
  });

  it('a shown tooltip takes the first Escape; a plain button lets Escape through', async () => {
    const user = userEvent.setup();
    const onOuterEscape = vi.fn();
    render(
      <div onKeyDown={(e) => e.key === 'Escape' && onOuterEscape()}>
        <IconButton icon={Trash} label="Delete" />
        <ChunkyButton>Plain</ChunkyButton>
      </div>,
    );
    screen.getByRole('button', { name: 'Delete' }).focus();
    await user.keyboard('{Escape}');
    expect(onOuterEscape).not.toHaveBeenCalled(); // only the tip closed
    await user.keyboard('{Escape}');
    expect(onOuterEscape).toHaveBeenCalledTimes(1); // tip already hidden: Escape goes on

    screen.getByRole('button', { name: 'Plain' }).focus();
    await user.keyboard('{Escape}');
    expect(onOuterEscape).toHaveBeenCalledTimes(2);
  });

  it('a ChunkyButton disabled with a reason stays focusable, says why and ignores clicks', async () => {
    const onClick = vi.fn();
    render(
      <ChunkyButton variant="primary" disabledReason="Pick a colour first" onClick={onClick}>
        Next
      </ChunkyButton>,
    );
    const button = screen.getByRole('button', { name: 'Next' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Pick a colour first',
    );
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('VaultBuddy is decorative unless titled; StatChip reads as one phrase; MoreGrid tiles work', async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <>
        <VaultBuddy pose="cheer" />
        <VaultBuddy pose="think" title="Vault buddy thinking" />
        <StatChip icon={Flame} value={12} label="day streak" tone="flame" />
        <MoreGrid
          label="More tools"
          items={[{ id: 'ai', label: 'AI', icon: Sparkles, status: 'Off', onSelect }]}
        />
      </>,
    );
    expect(container.querySelector('.sv-buddy--cheer')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('img', { name: 'Vault buddy thinking' })).toBeTruthy();
    expect(container.querySelector('.sv-stat')?.textContent).toBe('12 day streak');
    await userEvent.click(screen.getByRole('button', { name: /^AI,? ?,? ?Off$/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
