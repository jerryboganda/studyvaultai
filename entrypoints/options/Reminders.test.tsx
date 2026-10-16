import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultSettings, parseSettings, type Settings } from '@shared';
import { ToastProvider } from '@ui';
import { STUDY_SETTINGS_KEY, defaultStudySettings } from '@ui/review/settings';
import { makeChromeFakes } from '@ui/testing/fakes';
import { Reminders } from './Reminders';
import type { Update } from './Preferences';

configure({ asyncUtilTimeout: 10_000 });

let chrome: ReturnType<typeof makeChromeFakes>;
let held: boolean;

/** Chrome's permission, stateful: request grants (or not), contains and the events agree. */
function wirePermission(grant: boolean) {
  held = false;
  chrome.permissions.contains.mockImplementation(async () => held);
  chrome.permissions.request.mockImplementation(async () => {
    held = grant;
    if (grant) chrome.permissions.onAdded.emit();
    return grant;
  });
}

function Harness({
  initial,
  onUpdate,
  seen,
}: {
  initial: Settings;
  onUpdate?: () => Promise<void>;
  seen?: (s: Settings) => void;
}) {
  const [settings, setSettings] = useState(initial);
  const update: Update = async (mutate) => {
    await onUpdate?.();
    const next = parseSettings(mutate(settings));
    setSettings(next);
    seen?.(next);
  };
  return (
    <ToastProvider>
      <Reminders settings={settings} update={update} />
    </ToastProvider>
  );
}

const withReminders = (reminders: Settings['reminders']): Settings => ({
  ...defaultSettings(),
  reminders,
});

beforeEach(async () => {
  fakeBrowser.reset();
  chrome = makeChromeFakes();
  Object.assign(browser, chrome);
  wirePermission(true);
  await browser.storage.local.set({
    [STUDY_SETTINGS_KEY]: { ...defaultStudySettings(), timeZone: 'Europe/Berlin' },
  });
});
afterEach(cleanup);

const toggle = () => screen.getByRole('checkbox', { name: 'Badge on icon' }) as HTMLInputElement;
const timeFieldset = () =>
  screen.getByTestId('reminders-time').closest('fieldset') as HTMLFieldSetElement;

describe('Reminders settings', () => {
  it('is off by default and says what that means, with the daily time unavailable', async () => {
    render(<Harness initial={defaultSettings()} />);
    expect(toggle().checked).toBe(false);
    expect(timeFieldset().disabled).toBe(true);
    const status = screen.getByTestId('reminders-status').textContent;
    expect(status).toMatch(/Badge\s*Off/);
    expect(status).toMatch(/Daily time\s*None/);
    // The honest limits are on the page (the detail behind (i)), not only in documentation.
    expect(screen.getByText(/Chrome has to be running/)).toBeTruthy();
    expect(screen.getByText(/Never system notifications or email/)).toBeTruthy();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('turning it on needs no permission and shows the pending choice while it saves', async () => {
    let finish: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const seen = vi.fn();
    render(<Harness initial={defaultSettings()} onUpdate={() => slow} seen={seen} />);
    await userEvent.click(toggle());

    expect(toggle().checked).toBe(true); // the person's choice, at once
    expect(toggle().getAttribute('aria-busy')).toBe('true');
    expect(seen).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(toggle().getAttribute('aria-busy')).toBeNull());
    expect(seen.mock.calls[0]![0].reminders).toEqual({ on: true, dailyAt: null });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(timeFieldset().disabled).toBe(false);
    expect(screen.getByTestId('reminders-status').textContent).toMatch(/Badge\s*On/);
    expect(screen.getByTestId('reminders-status').textContent).toMatch(/Daily time\s*None/);
  });

  it('puts the switch back and says why when the change cannot be saved', async () => {
    render(
      <Harness
        initial={defaultSettings()}
        onUpdate={() => Promise.reject(new Error('The disk is full.'))}
      />,
    );
    await userEvent.click(toggle());
    expect(await screen.findByText('The disk is full.')).toBeTruthy();
    expect(toggle().checked).toBe(false);
  });

  it('asks for the timer permission from the click that saves a time, then saves it', async () => {
    const order: string[] = [];
    chrome.permissions.request.mockImplementation(async () => {
      order.push('request');
      held = true;
      chrome.permissions.onAdded.emit();
      return true;
    });
    const seen = vi.fn((s: Settings) => order.push(`saved ${s.reminders.dailyAt}`));
    render(<Harness initial={withReminders({ on: true, dailyAt: null })} seen={seen} />);

    fireEvent.change(screen.getByTestId('reminders-time'), { target: { value: '18:30' } });
    const save = screen.getByTestId('reminders-save');
    fireEvent.click(save);
    // Synchronously inside the click: the first thing that happened, before any await resolved.
    expect(chrome.permissions.request).toHaveBeenCalledWith({ permissions: ['alarms'] });

    await waitFor(() => expect(order).toEqual(['request', 'saved 18:30']));
    const status = screen.getByTestId('reminders-status');
    await waitFor(() => expect(status.textContent).toMatch(/18:30 \(Europe\/Berlin\), next /));
    expect(screen.queryByTestId('reminders-permission-note')).toBeNull();
  });

  it('keeps the time when Chrome says no, and says it needs the permission and why', async () => {
    wirePermission(false);
    render(<Harness initial={withReminders({ on: true, dailyAt: null })} />);
    fireEvent.change(screen.getByTestId('reminders-time'), { target: { value: '07:45' } });
    await userEvent.click(screen.getByTestId('reminders-save'));

    const note = await screen.findByTestId('reminders-permission-note');
    expect(note.textContent).toMatch(/Chrome did not give it/);
    expect(note.textContent).toMatch(/only lets an extension run at a set time/);
    expect(note.textContent).toMatch(/count on the icon still works/);
    expect(screen.getByTestId('reminders-status').textContent).toMatch(/07:45 saved, not active/);

    // Allowing it later, from its own button, makes the time active without touching anything else.
    wirePermission(true);
    await userEvent.click(screen.getByTestId('reminders-allow'));
    await waitFor(() => expect(screen.queryByTestId('reminders-permission-note')).toBeNull());
    expect(screen.getByTestId('reminders-status').textContent).toMatch(/07:45 \(Europe\/Berlin\)/);
  });

  it('follows a permission that is taken away outside the page', async () => {
    held = true;
    render(<Harness initial={withReminders({ on: true, dailyAt: '18:00' })} />);
    await waitFor(() =>
      expect(screen.getByTestId('reminders-status').textContent).toMatch(/18:00 \(Europe/),
    );
    held = false;
    act(() => chrome.permissions.onRemoved.emit());
    expect(await screen.findByTestId('reminders-permission-note')).toBeTruthy();
  });

  it('removes the daily time, and refuses a time that is not one', async () => {
    held = true;
    const seen = vi.fn();
    render(<Harness initial={withReminders({ on: true, dailyAt: '18:00' })} seen={seen} />);
    await userEvent.click(screen.getByTestId('reminders-remove'));
    await waitFor(() => expect(seen).toHaveBeenCalled());
    expect(seen.mock.calls[0]![0].reminders.dailyAt).toBeNull();
    expect(screen.queryByTestId('reminders-remove')).toBeNull();

    fireEvent.change(screen.getByTestId('reminders-time'), { target: { value: '' } });
    const save = screen.getByTestId('reminders-save');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(save.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Choose a time first.',
    );
  });

  it('keeps a time that is saved while the count is off, and says it starts later', async () => {
    render(<Harness initial={withReminders({ on: false, dailyAt: '21:00' })} />);
    expect(screen.getByTestId('reminders-status').textContent).toMatch(
      /21:00 saved, starts with the badge/,
    );
  });

  it('says the badge is paused, not on, while review is turned off', async () => {
    render(
      <Harness
        initial={{
          ...withReminders({ on: true, dailyAt: null }),
          features: { ...defaultSettings().features, review: false },
        }}
      />,
    );
    expect(screen.getByTestId('reminders-status').textContent).toMatch(
      /Badge\s*Paused \(review off\)/,
    );
  });
});
