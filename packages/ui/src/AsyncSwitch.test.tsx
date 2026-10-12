import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AsyncSwitch } from './AsyncSwitch';

afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A parent that stores the value only when the write succeeds, like a settings page. */
function Harness({ write }: { write(next: boolean): Promise<void> | void }) {
  const [stored, setStored] = useState(false);
  return (
    <AsyncSwitch
      label="Turn it on"
      hint="What this does."
      checked={stored}
      onChange={(next) => {
        const result = write(next);
        if (result === undefined) {
          setStored(next);
          return undefined;
        }
        return result.then(() => setStored(next));
      }}
    />
  );
}

const box = () => screen.getByRole('checkbox', { name: 'Turn it on' }) as HTMLInputElement;

describe('AsyncSwitch', () => {
  it('shows the new value at once, is busy and says so until the write settles', async () => {
    const gate = deferred();
    render(<Harness write={() => gate.promise} />);
    const user = userEvent.setup();
    await user.click(box());

    // Not snapped back although nothing was stored yet.
    expect(box().checked).toBe(true);
    expect(box().getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Saving…')).toBeTruthy();
    // The explanation stays the description.
    const described = box().getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(described)?.textContent).toBe('What this does.');

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(box().checked).toBe(true);
    expect(box().getAttribute('aria-busy')).toBeNull();
    expect(screen.queryByText('Saving…')).toBeNull();
  });

  it('ignores a second click while pending (it stays focusable)', async () => {
    const gate = deferred();
    const write = vi.fn(() => gate.promise);
    render(<Harness write={write} />);
    const user = userEvent.setup();
    await user.click(box());
    await user.click(box());
    expect(write).toHaveBeenCalledTimes(1);
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(false);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
  });

  it('rolls back to the stored value when the write fails', async () => {
    const gate = deferred();
    render(<Harness write={() => gate.promise} />);
    const user = userEvent.setup();
    await user.click(box());
    expect(box().checked).toBe(true);

    await act(async () => {
      gate.reject(new Error('disk full'));
      await gate.promise.catch(() => undefined);
    });
    expect(box().checked).toBe(false);
    expect(box().getAttribute('aria-busy')).toBeNull();
    expect(screen.queryByText('Saving…')).toBeNull();
  });

  it('a handler that finishes synchronously is never busy', async () => {
    render(<Harness write={() => undefined} />);
    await userEvent.setup().click(box());
    expect(box().checked).toBe(true);
    expect(box().getAttribute('aria-busy')).toBeNull();
  });
});
