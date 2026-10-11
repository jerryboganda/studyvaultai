import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useFocusRescue } from './focus';

afterEach(cleanup);

function Harness({
  items,
  pick,
}: {
  items: string[];
  pick?: (lost: HTMLElement) => HTMLElement | null;
}) {
  const rescue = useFocusRescue(pick);
  return (
    <div ref={rescue}>
      <button type="button">before</button>
      <section aria-label="Tags" data-testid="region">
        <ul>
          {items.map((i) => (
            <li key={i}>
              <button type="button">{i}</button>
            </li>
          ))}
        </ul>
      </section>
      <button type="button">after</button>
    </div>
  );
}

function Wrapped({ show }: { show: boolean }) {
  const rescue = useFocusRescue();
  return (
    <div ref={rescue} data-testid="root">
      {show ? (
        <section aria-label="Gone">
          <button type="button">one</button>
        </section>
      ) : null}
      <button type="button">after</button>
    </div>
  );
}

const button = (name: string) => screen.getByRole('button', { name });

describe('useFocusRescue', () => {
  it('moves focus to the region around a removed control instead of leaving it on <body>', async () => {
    const { rerender } = render(<Harness items={['one', 'two']} />);
    act(() => button('one').focus());
    expect(document.activeElement).toBe(button('one'));

    rerender(<Harness items={['two']} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('region')));
    // A landing place, not a new tab stop: it stays out of the Tab order.
    expect(screen.getByTestId('region').getAttribute('tabindex')).toBe('-1');
  });

  it('leaves focus alone when it moved to another control on purpose', async () => {
    const { rerender } = render(<Harness items={['one', 'two']} />);
    act(() => button('one').focus());
    act(() => button('after').focus());
    rerender(<Harness items={['two']} />);
    await Promise.resolve();
    expect(document.activeElement).toBe(button('after'));
  });

  it('does not take focus when nothing had it', async () => {
    const { rerender } = render(<Harness items={['one', 'two']} />);
    act(() => button('one').focus());
    act(() => button('one').blur());
    await Promise.resolve(); // the user's next action is a later task than the blur
    expect(document.activeElement).toBe(document.body);
    rerender(<Harness items={['two']} />);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.activeElement).toBe(document.body);
  });

  it('lets the owner name a better place for a control', async () => {
    const pick = (lost: HTMLElement) => (lost.textContent === 'one' ? button('after') : null);
    const { rerender } = render(<Harness items={['one', 'two']} pick={pick} />);
    act(() => button('one').focus());
    rerender(<Harness items={['two']} pick={pick} />);
    await waitFor(() => expect(document.activeElement).toBe(button('after')));
  });

  it('takes the container when the nearest region went away too', async () => {
    const { rerender } = render(<Wrapped show />);
    act(() => button('one').focus());
    rerender(<Wrapped show={false} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('root')));
  });
});
