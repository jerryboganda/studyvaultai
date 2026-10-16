import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoTip } from './InfoTip';

afterEach(cleanup);

const TEXT = 'One freeze saves your streak on a missed day.';

function setup() {
  const onOuterEscape = vi.fn();
  render(
    // Stands in for a dialog or wizard that closes on Escape.
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape') onOuterEscape();
      }}
    >
      <InfoTip label="About freezes">{TEXT}</InfoTip>
      <button type="button">Elsewhere</button>
    </div>,
  );
  const button = screen.getByRole('button', { name: 'About freezes' });
  const pop = () => document.getElementById(button.getAttribute('aria-controls')!)!;
  return { button, pop, onOuterEscape };
}

describe('InfoTip', () => {
  it('is a disclosure: aria-controls the popover, and its text describes the button while closed', () => {
    const { button, pop } = setup();
    expect(pop().hidden).toBe(true);
    expect(pop().textContent).toContain(TEXT);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(
      TEXT,
    );
  });

  it('click, Enter and Space toggle it; hovering alone never opens it', async () => {
    const user = userEvent.setup();
    const { button, pop } = setup();
    await user.hover(button);
    expect(pop().hidden).toBe(true);

    await user.click(button);
    expect(pop().hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await user.unhover(button); // stays open: it was opened on purpose
    expect(pop().hidden).toBe(false);
    await user.keyboard('{Enter}');
    expect(pop().hidden).toBe(true);
    await user.keyboard(' ');
    expect(pop().hidden).toBe(false);
  });

  it('Escape closes only the popover, returns focus, and the next Escape reaches the parent', async () => {
    const user = userEvent.setup();
    const { button, pop, onOuterEscape } = setup();
    await user.click(button);
    await user.tab(); // onto the popover's close button
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));

    await user.keyboard('{Escape}');
    expect(pop().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(onOuterEscape).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onOuterEscape).toHaveBeenCalledTimes(1);
  });

  it('the close button and a click outside close it', async () => {
    const user = userEvent.setup();
    const { button, pop } = setup();
    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(pop().hidden).toBe(true);
    expect(document.activeElement).toBe(button);

    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(pop().hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Elsewhere' }));
  });
});
