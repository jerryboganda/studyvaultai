import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';
import { InlineNotice } from './Notice';
import { Tabs } from './Tabs';
import { ToastProvider, useToast } from './Toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Button', () => {
  it('stays focusable but inert when disabled with a reason, and exposes the reason', async () => {
    const onClick = vi.fn();
    render(
      <Button disabledReason="Open the page first" onClick={onClick}>
        Show
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Show' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('Open the page first');
    const describedBy = button.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('Open the page first');
    button.focus();
    expect(document.activeElement).toBe(button);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('ignores clicks while busy and announces busy', async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('InlineNotice', () => {
  it('announces errors assertively and keeps a text cue besides the glyph', () => {
    render(<InlineNotice tone="error">Disk full</InlineNotice>);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Error:');
    expect(alert.textContent).toContain('Disk full');
  });

  it('is not a live region unless asked', () => {
    render(<InlineNotice tone="info">Heads up</InlineNotice>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Tabs', () => {
  function Harness() {
    return (
      <Tabs
        label="Sections"
        tabs={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta', count: 2 },
          { id: 'c', label: 'Gamma' },
        ]}
        value="b"
        onChange={onChange}
      >
        <p>panel</p>
      </Tabs>
    );
  }
  const onChange = vi.fn();

  it('wires tab to panel and rotates tabindex', () => {
    render(<Harness />);
    const beta = screen.getByRole('tab', { name: /^Beta/ });
    expect(beta.getAttribute('aria-selected')).toBe('true');
    expect(beta.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('tabindex')).toBe('-1');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(beta.id);
    expect(beta.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('moves with arrows (wrapping), Home and End', async () => {
    onChange.mockClear();
    render(<Harness />);
    screen.getByRole('tab', { name: /^Beta/ }).focus();
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard('{ArrowLeft}');
    await userEvent.keyboard('{Home}');
    await userEvent.keyboard('{End}');
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['c', 'a', 'a', 'c']);
  });
});

describe('Toast', () => {
  function Pusher({ withAction }: { withAction?: () => void }) {
    const toast = useToast();
    return (
      <button
        onClick={() =>
          toast.push({
            message: 'Highlight deleted.',
            action: withAction ? { label: 'Undo', onClick: withAction } : undefined,
          })
        }
      >
        push
      </button>
    );
  }

  it('is announced politely and dismisses itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByText('push'));
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Highlight deleted.');

    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(screen.queryByText('Highlight deleted.')).toBeNull();
  });

  it('runs its action once and closes', async () => {
    const undo = vi.fn();
    render(
      <ToastProvider>
        <Pusher withAction={undo} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByText('push'));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Highlight deleted.')).toBeNull();
  });

  it('stays while hovered so the action can be reached', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <Pusher withAction={() => undefined} />
      </ToastProvider>,
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByText('push'));
    await user.hover(screen.getByText('Highlight deleted.'));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Highlight deleted.')).toBeTruthy();
  });
});
