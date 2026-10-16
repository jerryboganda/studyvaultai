import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useState, version } from 'react';
import { BarMeter } from './BarMeter';
import { IconButton } from './Buttons';
import { ChoiceCards } from './ChoiceCards';
import { Heatmap } from './Heatmap';
import { IconTabBar } from './IconTabBar';
import { InfoTip } from './InfoTip';
import { ProgressRing } from './ProgressRing';
import { Wizard } from './Wizard';

/**
 * The same components under preact/compat (docs/adr/012): every `react` import in this file's
 * module graph resolves to Preact. lucide-react is a prebuilt dependency that Vitest loads outside
 * the mock, so its icons are stubbed with plain <svg>s here; the build alias covers it for real.
 */
vi.mock('react', async () => await import('preact/compat'));
vi.mock('react/jsx-runtime', async () => await import('preact/compat/jsx-runtime'));
vi.mock('react/jsx-dev-runtime', async () => await import('preact/compat/jsx-dev-runtime'));
vi.mock('lucide-react', async () => {
  const { h } = await import('preact');
  const icon = (props: Record<string, unknown>) =>
    h('svg', { 'aria-hidden': props['aria-hidden'] });
  const names = [
    'ArrowLeft',
    'ArrowRight',
    'CalendarDays',
    'Check',
    'CircleAlert',
    'Ellipsis',
    'Info',
    'Snowflake',
    'Table',
    'Trash',
    'X',
  ];
  return Object.fromEntries(names.map((n) => [n, icon]));
});

let host: HTMLElement | null = null;
afterEach(() => {
  if (host) render(null, host);
  host?.remove();
  host = null;
});
async function mount(node: preact.ComponentChild) {
  host = document.body.appendChild(document.createElement('div'));
  await act(() => render(node, host!));
}

function Flow() {
  const [name, setName] = useState('');
  const [pick, setPick] = useState<'a' | 'b' | null>(null);
  return (
    <Wizard
      label="Setup"
      onFinish={() => {}}
      steps={[
        {
          id: 'name',
          title: 'Your name',
          validate: () => (name ? null : 'Enter a name'),
          content: ({ error, errorId }) => (
            <input
              aria-label="Name"
              value={name}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setName((e.target as HTMLInputElement).value)}
            />
          ),
        },
        {
          id: 'pick',
          title: 'Pick one',
          content: (
            <ChoiceCards
              label="Option"
              value={pick}
              onChange={setPick}
              options={[
                { value: 'a', label: 'First' },
                { value: 'b', label: 'Second' },
              ]}
            />
          ),
        },
      ]}
    />
  );
}

describe('design components under preact/compat', () => {
  it('really resolves react to preact/compat here', () => {
    expect(version).not.toBe('19.3.0'); // React's own version; compat reports an 18.x shim
  });

  it('runs the wizard: validation focus, step heading focus, radio keyboard', async () => {
    const user = userEvent.setup();
    await mount(<Flow />);
    await act(() => user.click(screen.getByRole('button', { name: 'Next' })));
    expect(screen.getByRole('alert').textContent).toContain('Enter a name');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));

    await act(() => user.type(screen.getByRole('textbox', { name: 'Name' }), 'Sam'));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(() => user.click(screen.getByRole('button', { name: 'Next' })));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Pick one' }));

    await act(() => user.click(screen.getByText('First')));
    const second = screen.getByRole<HTMLInputElement>('radio', { name: 'Second' });
    await act(() => user.keyboard('{ArrowRight}'));
    expect(second.checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'First' }).checked).toBe(false);
    expect(document.activeElement).toBe(second);
  });

  it('InfoTip toggles and Escape closes; ring and meter render their state', async () => {
    const user = userEvent.setup();
    await mount(
      <>
        <InfoTip label="About goals">Pick a daily target.</InfoTip>
        <ProgressRing value={0} max={30} unit="XP" label="Daily goal" />
        <BarMeter value={0} max={4} label="Cards" />
      </>,
    );
    const button = screen.getByRole('button', { name: 'About goals' });
    await act(() => user.click(button));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await act(() => user.keyboard('{Escape}'));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);

    expect(screen.getByRole('img', { name: 'Daily goal: 0 of 30 XP' })).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Cards' });
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%');
  });

  it('tab bar roves; heatmap moves by week and Escape hides its tip; tooltip Escape stops there', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    function Tabs() {
      const [tab, setTab] = useState<'a' | 'b'>('a');
      return (
        <IconTabBar
          label="Panel"
          tabs={[{ id: 'a', label: 'Banks', icon: (() => null) as never }]}
          more={{ id: 'b' }}
          active={tab}
          onChange={setTab}
        >
          <p>{tab}</p>
        </IconTabBar>
      );
    }
    await mount(
      <div onKeyDown={(e) => e.key === 'Escape' && outer()}>
        <Tabs />
        <IconButton icon={(() => null) as never} label="Delete" />
        <Heatmap
          days={[5, 40, 0, 12, 30, 0, 9, 50]}
          goal={30}
          title="Streak"
          end={new Date(2026, 9, 14)}
          locale="en-US"
        />
      </div>,
    );
    screen.getByRole('tab', { name: 'Banks' }).focus();
    await act(() => user.keyboard('{ArrowRight}'));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'More' }));
    expect(screen.getByRole('tabpanel', { name: 'More' }).textContent).toBe('b');

    // Preact runs effects a frame later; act() flushes them, as time would for a real user.
    await act(() => screen.getByRole('button', { name: 'Delete' }).focus());
    await act(() => user.keyboard('{Escape}'));
    expect(outer).not.toHaveBeenCalled();

    const today = screen.getByRole('gridcell', { name: 'Wed, Oct 14: 50 XP, goal met, today' });
    await act(() => today.focus());
    expect(document.querySelector('.sv-heat__tip')?.textContent).toBe(
      today.getAttribute('aria-label'),
    );
    await act(() => user.keyboard('{ArrowLeft}'));
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /Oct 7: 5 XP/ }));
    await act(() => user.keyboard('{Escape}'));
    expect(document.querySelector('.sv-heat__tip')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });
});
