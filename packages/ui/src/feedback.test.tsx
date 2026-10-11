import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorBoundary } from './ErrorBoundary';
import { Kbd } from './Kbd';
import { ToastProvider, useToast } from './Toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Toast: announcements, errors and focus', () => {
  function Controls() {
    const toast = useToast();
    return (
      <>
        <button onClick={() => toast.announce('Removed example.com.')}>say</button>
        <button onClick={() => toast.push({ tone: 'error', message: 'Disk is full' })}>fail</button>
        <button
          onClick={() =>
            toast.push({
              message: 'Deleted.',
              action: { label: 'Undo', onClick: () => undefined },
              focusAction: true,
            })
          }
        >
          undoable
        </button>
      </>
    );
  }
  function Harness({ returnFocus }: { returnFocus?: () => HTMLElement | null }) {
    return (
      <ToastProvider returnFocus={returnFocus}>
        <Controls />
        <main id="stable" tabIndex={-1}>
          content
        </main>
      </ToastProvider>
    );
  }

  it('announces through the one polite region without showing a toast', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('say'));
    expect(screen.getByRole('status').textContent).toContain('Removed example.com.');
    expect(document.querySelector('.sv-toast')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('announces the same sentence again (a repeat is a change)', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('say'));
    const first = screen.getByRole('status').textContent;
    await userEvent.click(screen.getByText('say'));
    expect(screen.getByRole('status').textContent).not.toBe(first);
    expect(screen.getByRole('status').textContent?.trim()).toBe('Removed example.com.');
  });

  it('an error toast is an alert with a text prefix, no timer and a dismiss button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByText('fail'));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Error:');
    expect(alert.textContent).toContain('Disk is full');
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the region comes before the page content in the DOM', () => {
    const { container } = render(<Harness />);
    const region = container.querySelector('[role="status"]')!;
    const content = container.querySelector('main')!;
    expect(region.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('focusAction puts focus on Undo; closing it hands focus to the stable element', async () => {
    render(<Harness returnFocus={() => document.getElementById('stable')} />);
    await userEvent.click(screen.getByText('undoable'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
    expect(document.activeElement).toBe(document.getElementById('stable'));
  });
});

describe('ErrorBoundary', () => {
  function Boom(): never {
    throw new Error('render exploded');
  }

  it('shows a recoverable message with the [StudyVault] log prefix instead of a blank page', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary surface="popup">
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('StudyVault could not show the popup');
    expect(alert.textContent).toContain('render exploded');
    expect(alert.textContent).toContain('not affected');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('[StudyVault] '))).toBe(true);
  });

  it('Try again renders the children again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = true;
    function Maybe() {
      if (broken) throw new Error('first render fails');
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary surface="side panel">
        <Maybe />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    broken = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeTruthy();
  });
});

describe('ConfirmDialog', () => {
  function Host({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>ask</button>
        {open ? (
          <ConfirmDialog
            title="Delete it?"
            confirmLabel="Delete"
            danger
            onConfirm={() => {
              setOpen(false);
              onConfirm();
            }}
            onCancel={() => setOpen(false)}
          >
            <p>This cannot be undone.</p>
          </ConfirmDialog>
        ) : null}
      </>
    );
  }

  it('is a labelled dialog that starts on Cancel and returns focus to the opener', async () => {
    render(<Host onConfirm={() => undefined} />);
    const opener = screen.getByText('ask');
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Delete it?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('confirm runs the callback once', async () => {
    const onConfirm = vi.fn();
    render(<Host onConfirm={onConfirm} />);
    await userEvent.click(screen.getByText('ask'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Kbd', () => {
  it('shows the key, or an honest "Not set"', () => {
    render(
      <>
        <Kbd shortcut="Alt+Shift+H" />
        <Kbd shortcut="" />
      </>,
    );
    expect(screen.getByText('Alt+Shift+H').tagName).toBe('KBD');
    expect(screen.getByText('Not set')).toBeTruthy();
  });
});
