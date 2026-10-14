import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Rail } from './Rail';

afterEach(cleanup);

const rail = (dueCount: number | null) =>
  render(
    <Rail
      current="home"
      dueCount={dueCount}
      onGo={vi.fn()}
      onPalette={vi.fn()}
      onSettings={vi.fn()}
      viewOptions={null}
    />,
  );

describe('Rail', () => {
  it('puts the due count on Review, in its name as well as on the icon', () => {
    rail(14);
    const review = screen.getByTestId('nav-review');
    expect(review.textContent).toContain('14');
    expect(screen.getByRole('link', { name: 'Review (14 due)' })).toBe(review);
  });

  it('shows no badge while the count is unknown or nothing is due', () => {
    rail(null);
    expect(screen.getByRole('link', { name: 'Review' }).querySelector('.dash-nav__count')).toBe(
      null,
    );
    cleanup();
    rail(0);
    expect(screen.getByRole('link', { name: 'Review' }).querySelector('.dash-nav__count')).toBe(
      null,
    );
  });
});
