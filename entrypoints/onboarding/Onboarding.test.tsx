import 'fake-indexeddb/auto';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { getSettings } from '@runtime';
import { listBankInfos, listFolderTree } from '@storage';
import { freshDatabase } from '@storage/test-vault';
import {
  ONBOARDING_KEY,
  defaultOnboardingState,
  getOnboardingState,
} from '@ui/shell/onboardingState';
import { COMMANDS, makeChromeFakes } from '@ui/testing/fakes';
import { Onboarding } from './Onboarding';
import type { PresetPorts } from './presets';
import { BanksStep } from './Steps';
import { TID } from './testids';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

let chrome: ReturnType<typeof makeChromeFakes>;

beforeEach(async () => {
  await freshDatabase(); // also resets fakeBrowser
  chrome = makeChromeFakes();
  Object.assign(browser, chrome);
  Object.assign(browser.windows, { getCurrent: vi.fn(async () => ({ id: 9 })) });
});
afterEach(cleanup);

const heading = () => screen.getByRole('heading', { level: 2 }).textContent;
async function go(label: RegExp | string = 'Next') {
  await userEvent.click(await screen.findByRole('button', { name: label }));
}

/** Walk from the first step to `target` by pressing Next. */
async function walkTo(target: string) {
  await screen.findByTestId(TID.step('welcome'));
  const order = ['welcome', 'privacy', 'access', 'banks', 'look', 'keys', 'done'];
  for (const id of order.slice(0, order.indexOf(target))) {
    await screen.findByTestId(TID.step(id));
    if (id === 'welcome') await go('Start');
    else await go('Next');
  }
  await screen.findByTestId(TID.step(target));
}

describe('the tour', () => {
  it('opens on what StudyVault does, says everything stays on the device, and can be skipped', async () => {
    render(<Onboarding />);
    expect(await screen.findByTestId(TID.step('welcome'))).toBeTruthy();
    expect(heading()).toBe('What StudyVault does');
    expect(screen.getByText('Everything stays on this device by default')).toBeTruthy();
    expect(screen.getByTestId(TID.skip)).toBeTruthy();
    expect(screen.getByTestId(TID.progress).textContent).toMatch(/Step 1 of 7/);
    // Focus starts on the step heading, so the keyboard and a screen reader begin at its top.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 })),
    );
    // Nothing is stored just by looking.
    expect((await browser.storage.local.get(ONBOARDING_KEY))[ONBOARDING_KEY]).toBeUndefined();
  });

  it('moves focus to each new step heading and stores the place', async () => {
    render(<Onboarding />);
    await go('Start');
    await waitFor(() => expect(heading()).toBe('Your privacy choices'));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 })),
    );
    await waitFor(async () =>
      expect(await getOnboardingState()).toMatchObject({ status: 'pending', step: 'privacy' }),
    );
    await userEvent.click(screen.getByTestId(TID.back));
    await waitFor(() => expect(heading()).toBe('What StudyVault does'));
  });

  it('skipping stores it, changes nothing else, and says how to come back', async () => {
    render(<Onboarding />);
    await walkTo('privacy');
    await userEvent.click(screen.getByTestId(TID.skip));
    expect(await screen.findByTestId(TID.skipped)).toBeTruthy();
    expect(screen.getByText(/open this tour again any time from Settings/)).toBeTruthy();
    await waitFor(async () => expect((await getOnboardingState()).status).toBe('skipped'));
    expect((await listBankInfos()).filter((b) => !b.isInbox)).toEqual([]);
  });

  it('resumes where it stopped, with the chosen preset and unticked folders', async () => {
    await browser.storage.local.set({
      [ONBOARDING_KEY]: {
        schemaVersion: 1,
        status: 'pending',
        step: 'banks',
        preset: { id: 'radiology', excluded: ['Diagnostic Radiology/Breast'] },
        applied: null,
        updatedAt: '2026-10-11T10:00:00.000Z',
      },
    });
    render(<Onboarding />);
    expect(await screen.findByTestId(TID.step('banks'))).toBeTruthy();
    expect((screen.getByTestId(TID.preset('radiology')) as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByTestId(TID.node('Diagnostic Radiology/Breast')) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByTestId(TID.plan).textContent).toMatch(/with 11 folders/);
  });

  it('a finished tour opened again starts from the beginning', async () => {
    await browser.storage.local.set({
      [ONBOARDING_KEY]: {
        schemaVersion: 1,
        status: 'completed',
        step: 'done',
        preset: { id: 'blank', excluded: [] },
        applied: null,
        updatedAt: '2026-10-11T10:00:00.000Z',
      },
    });
    render(<Onboarding />);
    expect(await screen.findByTestId(TID.step('welcome'))).toBeTruthy();
    // Looking again does not unfinish it.
    expect((await getOnboardingState()).status).toBe('completed');
  });
});

describe('privacy choices', () => {
  it('shows AI and sync as off, with the safe answers selected, and never enables them', async () => {
    render(<Onboarding />);
    await walkTo('privacy');
    expect(within(screen.getByTestId(TID.aiStatus)).getByText('Off')).toBeTruthy();
    expect(within(screen.getByTestId(TID.syncStatus)).getByText('Off')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /AI/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /sync/i })).toBeNull();
    const privateBox = screen.getByTestId(TID.privateWindows) as HTMLInputElement;
    const paint = screen.getByTestId(TID.paintHighlights) as HTMLInputElement;
    expect(privateBox.checked).toBe(false);
    expect(paint.checked).toBe(true);
    // The exposure is explained next to the switch, not behind a link.
    expect(paint.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(paint.getAttribute('aria-describedby')!)!.textContent).toMatch(
      /scripts that a site itself runs can read which passages you marked/,
    );
    expect(screen.getByText(/starter list of common sign-in, mail, payment, bank/)).toBeTruthy();
    const settings = await getSettings();
    expect(settings.features).toMatchObject({ ai: false, sync: false });
  });

  it('saves the two switches straight away', async () => {
    render(<Onboarding />);
    await walkTo('privacy');
    // One at a time: jsdom has no Web Locks, which in Chrome serialise the two writes.
    await userEvent.click(screen.getByTestId(TID.privateWindows));
    await waitFor(async () => expect((await getSettings()).allowIncognitoCapture).toBe(true));
    await userEvent.click(screen.getByTestId(TID.paintHighlights));
    await waitFor(async () => expect((await getSettings()).paintHighlights).toBe(false));
    expect((await getSettings()).allowIncognitoCapture).toBe(true);
  });

  it('reports a setting that could not be saved', async () => {
    render(<Onboarding />);
    await walkTo('privacy');
    vi.spyOn(browser.storage.local, 'set').mockRejectedValueOnce(new Error('Quota exceeded'));
    await userEvent.click(screen.getByTestId(TID.privateWindows));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Your choice was not saved/);
    expect(alert.textContent).toMatch(/Quota exceeded/);
  });
});

describe('site access', () => {
  it('explains this tab, this site and all sites and requests nothing', async () => {
    render(<Onboarding />);
    await walkTo('access');
    for (const level of ['This tab', 'This site', 'All sites']) {
      expect(screen.getByText(level)).toBeTruthy();
    }
    expect(screen.getByText('Nothing is requested during this tour')).toBeTruthy();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    await go('Next');
    await screen.findByTestId(TID.step('banks'));
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });
});

describe('bank presets', () => {
  async function toBanks() {
    render(<Onboarding />);
    await walkTo('banks');
  }

  it('blank: nothing is created and Next just continues', async () => {
    await toBanks();
    expect((screen.getByTestId(TID.preset('blank')) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId(TID.create)).toBeNull();
    await go('Next');
    await screen.findByTestId(TID.step('look'));
    expect((await listBankInfos()).filter((b) => !b.isInbox)).toEqual([]);
  });

  it('Diagnostic Radiology: previews the taxonomy, creates it once, and re-running adds nothing', async () => {
    await toBanks();
    await userEvent.click(screen.getByTestId(TID.preset('radiology')));
    const tree = screen.getByRole('list', { name: 'Preview of Diagnostic Radiology' });
    expect(within(tree).getAllByRole('checkbox')).toHaveLength(13); // the bank and 12 folders
    expect(screen.getByTestId(TID.plan).textContent).toMatch(/with 12 folders/);
    // Nothing exists before the button.
    expect((await listBankInfos()).filter((b) => !b.isInbox)).toEqual([]);

    await userEvent.click(screen.getByTestId(TID.node('Diagnostic Radiology/Breast')));
    expect(screen.getByTestId(TID.plan).textContent).toMatch(/with 11 folders/);
    await waitFor(async () =>
      expect((await getOnboardingState()).preset).toEqual({
        id: 'radiology',
        excluded: ['Diagnostic Radiology/Breast'],
      }),
    );

    await userEvent.click(screen.getByTestId(TID.create));
    expect((await screen.findByTestId(TID.applied)).textContent).toBe(
      'Created the bank "Diagnostic Radiology" with 11 folders.',
    );
    const banks = (await listBankInfos()).filter((b) => !b.isInbox);
    expect(banks.map((b) => b.name)).toEqual(['Diagnostic Radiology']);
    const names = (await listFolderTree(banks[0]!.id)).map((n) => n.folder.name);
    expect(names).toHaveLength(11);
    expect(names).not.toContain('Breast');
    await waitFor(async () =>
      expect((await getOnboardingState()).applied).toMatchObject({
        bankName: 'Diagnostic Radiology',
        createdBank: true,
        createdFolders: 11,
      }),
    );

    // Back to the step and press Create again: it finds everything and adds nothing.
    await go('Next');
    await screen.findByTestId(TID.step('look'));
    await userEvent.click(screen.getByTestId(TID.back));
    await screen.findByTestId(TID.step('banks'));
    await userEvent.click(screen.getByTestId(TID.create));
    expect((await screen.findByTestId(TID.applied)).textContent).toMatch(
      /already there, so nothing was added/,
    );
    expect((await listBankInfos()).filter((b) => !b.isInbox)).toHaveLength(1);
    expect(await listFolderTree(banks[0]!.id)).toHaveLength(11);
  });

  it('unticking a folder leaves out what is inside it and shows why', async () => {
    await toBanks();
    await userEvent.click(screen.getByTestId(TID.preset('medicine')));
    const child = screen.getByTestId(TID.node('Medicine/Clinical/Surgery')) as HTMLInputElement;
    expect(child.checked).toBe(true);
    await userEvent.click(screen.getByTestId(TID.node('Medicine/Clinical')));
    expect(child.checked).toBe(false);
    expect(child.disabled).toBe(true);
    expect(screen.getAllByText(/left out with its parent/).length).toBeGreaterThan(0);
  });

  it('unticking the bank disables Create with its reason', async () => {
    await toBanks();
    await userEvent.click(screen.getByTestId(TID.preset('general')));
    await userEvent.click(screen.getByTestId(TID.node('General study')));
    expect(screen.getByTestId(TID.create).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId(TID.plan).textContent).toMatch(/Nothing is selected/);
  });

  it('a failure is shown with Try again, keeps what was made, and the retry finishes the job', async () => {
    // The step on its own, over a vault that refuses the fourth folder once.
    const banks: Array<{ id: string; name: string; isInbox: boolean }> = [];
    const folders: Array<{ id: string; name: string; parentFolderId: string | null }> = [];
    let failures = 1;
    const ports: PresetPorts = {
      listBanks: async () => banks,
      createBank: async (name) => {
        const bank = { id: `bank-${banks.length + 1}`, name, isInbox: false };
        banks.push(bank);
        return bank;
      },
      listFolders: async () => folders,
      createFolder: async ({ name, parentFolderId }) => {
        if (folders.length === 3 && failures-- > 0) throw new Error('Disk full');
        const folder = { id: `f-${folders.length + 1}`, name, parentFolderId };
        folders.push(folder);
        return folder;
      },
    };
    const state = {
      ...defaultOnboardingState(),
      preset: { id: 'general', excluded: [] as string[] },
    };
    render(
      <BanksStep
        heading={createRef<HTMLHeadingElement>()}
        state={state}
        ports={ports}
        onPreset={() => undefined}
        onExcluded={() => undefined}
        onApplied={() => undefined}
        onNext={() => undefined}
      />,
    );

    await userEvent.click(screen.getByTestId(TID.create));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/The bank was not fully created/);
    expect(alert.textContent).toMatch(/Disk full/);
    expect(alert.textContent).toMatch(/trying again adds only what is missing/);
    expect(folders).toHaveLength(3);

    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect((await screen.findByTestId(TID.applied)).textContent).toBe(
      'Added 4 folders to the existing bank "General study" (3 were already there).',
    );
    expect(banks).toHaveLength(1);
    expect(folders).toHaveLength(7);
    expect(new Set(folders.map((f) => f.name)).size).toBe(7);
  });
});

describe('theme, shortcuts and the end', () => {
  it('theme and density apply and persist at once', async () => {
    render(<Onboarding />);
    await walkTo('look');
    await userEvent.click(screen.getByTestId(TID.theme('dark')));
    await waitFor(async () => expect((await getSettings()).theme).toBe('dark'));
    await userEvent.click(screen.getByTestId(TID.density('compact')));
    await waitFor(async () => expect((await getSettings()).density).toBe('compact'));
    expect((await getSettings()).theme).toBe('dark');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });

  it('lists the keys exactly as Chrome reports them, "Not set" included', async () => {
    render(<Onboarding />);
    await walkTo('keys');
    const list = await screen.findByTestId(TID.shortcuts);
    const rows = within(list).getAllByRole('listitem');
    for (const c of COMMANDS) {
      const row = rows.find((r) => r.textContent?.includes(c.description));
      expect(row, c.name).toBeTruthy();
      expect(row!.textContent).toContain(c.shortcut || 'Not set');
    }
    expect(list.textContent).toContain('Alt+Shift+]');
  });

  it('finish: opens the side panel from the click, then completes and says it is done', async () => {
    render(<Onboarding />);
    await walkTo('done');
    const open = screen.getByTestId(TID.openPanel);
    await waitFor(() => expect(open.getAttribute('aria-disabled')).toBeNull());
    expect(screen.getByText(/Click the StudyVault icon in the Chrome toolbar/)).toBeTruthy();
    expect(screen.getByText('Alt+Shift+S')).toBeTruthy();

    await userEvent.click(open);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 9 });
    expect(await screen.findByText(/The side panel is open next to this tab/)).toBeTruthy();

    await userEvent.click(screen.getByTestId(TID.finish));
    expect(await screen.findByTestId(TID.finished)).toBeTruthy();
    await waitFor(async () =>
      expect(await getOnboardingState()).toMatchObject({ status: 'completed', step: 'done' }),
    );
  });

  it('a side panel that cannot be opened is explained, with the manual way', async () => {
    chrome.sidePanel.open.mockRejectedValueOnce(new Error('No user gesture'));
    render(<Onboarding />);
    await walkTo('done');
    const open = screen.getByTestId(TID.openPanel);
    await waitFor(() => expect(open.getAttribute('aria-disabled')).toBeNull());
    await userEvent.click(open);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/No user gesture/);
    expect(alert.textContent).toMatch(/toolbar icon/);
  });

  it('says what was created on the last step', async () => {
    render(<Onboarding />);
    await walkTo('banks');
    await userEvent.click(screen.getByTestId(TID.preset('general')));
    await userEvent.click(screen.getByTestId(TID.create));
    await screen.findByTestId(TID.applied);
    await go('Next');
    await go('Next');
    await go('Next');
    expect((await screen.findByTestId(TID.summary)).textContent).toBe(
      'Your bank "General study" is ready with 7 folders.',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Durability: what the page says is what is stored, at the moment it says it
// ---------------------------------------------------------------------------------------------

describe('state is stored when the page says so', () => {
  /** `storage.local.set` that holds back (or fails) writes of the tour's state that match. */
  function interceptTourWrites(match: (state: Record<string, unknown>) => boolean) {
    const real = browser.storage.local.set.bind(browser.storage.local);
    const held: { release(): void; fail(e: Error): void } = {
      release: () => undefined,
      fail: () => undefined,
    };
    let settle: { ok(): void; fail(e: Error): void } | null = null;
    const gate = new Promise<void>((resolve, reject) => {
      settle = { ok: resolve, fail: reject };
    });
    gate.catch(() => undefined);
    held.release = () => settle?.ok();
    held.fail = (e) => settle?.fail(e);
    vi.spyOn(browser.storage.local, 'set').mockImplementation(async (items) => {
      const state = (items as Record<string, unknown> | undefined)?.[ONBOARDING_KEY] as
        Record<string, unknown> | undefined;
      if (state && match(state)) await gate;
      return real(items as never);
    });
    return held;
  }

  it('skipping: the skipped screen waits for the write, and the state read right then says skipped', async () => {
    render(<Onboarding />);
    await walkTo('privacy');
    const held = interceptTourWrites((s) => s.status === 'skipped');

    await userEvent.click(screen.getByTestId(TID.skip));
    // The write is still in flight: the tour has not claimed to be skipped.
    expect(screen.queryByTestId(TID.skipped)).toBeNull();
    expect(screen.getByTestId(TID.step('privacy'))).toBeTruthy();
    expect((await getOnboardingState()).status).toBe('pending');

    held.release();
    await screen.findByTestId(TID.skipped);
    // No waitFor: the moment the screen is there, the store already agrees.
    expect((await getOnboardingState()).status).toBe('skipped');
  });

  it('finishing: the finished screen waits for the write, and the state read right then says completed', async () => {
    render(<Onboarding />);
    await walkTo('done');
    const held = interceptTourWrites((s) => s.status === 'completed');

    await userEvent.click(screen.getByTestId(TID.finish));
    expect(screen.queryByTestId(TID.finished)).toBeNull();
    expect((await getOnboardingState()).status).toBe('pending');

    held.release();
    await screen.findByTestId(TID.finished);
    expect(await getOnboardingState()).toMatchObject({ status: 'completed', step: 'done' });
  });

  it('a write that fails keeps the tour on screen with the reason, and Skip works again', async () => {
    render(<Onboarding />);
    await walkTo('privacy');
    vi.spyOn(browser.storage.local, 'set').mockRejectedValueOnce(new Error('Quota exceeded'));

    await userEvent.click(screen.getByTestId(TID.skip));
    expect(await screen.findByText(/Your place was not saved/)).toBeTruthy();
    expect(screen.getByText(/Quota exceeded/)).toBeTruthy();
    expect(screen.queryByTestId(TID.skipped)).toBeNull();
    expect(screen.getByTestId(TID.step('privacy'))).toBeTruthy();

    await userEvent.click(screen.getByTestId(TID.skip));
    await screen.findByTestId(TID.skipped);
    expect((await getOnboardingState()).status).toBe('skipped');
  });

  it('a choice is written in the same turn as the click, before the handler returns', async () => {
    render(<Onboarding />);
    await walkTo('banks');
    const set = vi.spyOn(browser.storage.local, 'set');

    // fireEvent does not wait: whatever is stored must already have been handed over.
    fireEvent.click(screen.getByTestId(TID.preset('radiology')));
    const written = set.mock.calls
      .map((c) => (c[0] as Record<string, unknown>)[ONBOARDING_KEY])
      .filter(Boolean);
    expect(written.at(-1)).toMatchObject({
      status: 'pending',
      step: 'banks',
      preset: { id: 'radiology', excluded: [] },
    });

    fireEvent.click(screen.getByTestId(TID.node('Diagnostic Radiology/Breast')));
    const after = set.mock.calls
      .map((c) => (c[0] as Record<string, unknown>)[ONBOARDING_KEY])
      .filter(Boolean);
    expect(after.at(-1)).toMatchObject({
      preset: { id: 'radiology', excluded: ['Diagnostic Radiology/Breast'] },
    });
  });

  it('closing the tab right after a click and opening the tour again restores step and choice', async () => {
    render(<Onboarding />);
    await walkTo('banks');
    fireEvent.click(screen.getByTestId(TID.preset('general')));
    fireEvent.click(screen.getByTestId(TID.node('General study/Readings')));
    cleanup(); // the tab is gone before anything had time to settle

    render(<Onboarding />);
    expect(await screen.findByTestId(TID.step('banks'))).toBeTruthy();
    expect((screen.getByTestId(TID.preset('general')) as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByTestId(TID.node('General study/Readings')) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('writes again when the page is hidden or put away, if a write was lost', async () => {
    render(<Onboarding />);
    await walkTo('banks');
    vi.spyOn(browser.storage.local, 'set').mockRejectedValueOnce(new Error('Disk busy'));
    fireEvent.click(screen.getByTestId(TID.preset('radiology')));
    await screen.findByText(/Your place was not saved/);
    expect((await getOnboardingState()).preset.id).toBe('blank'); // the first write was lost

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(async () =>
      expect(await getOnboardingState()).toMatchObject({
        step: 'banks',
        preset: { id: 'radiology' },
      }),
    );
  });

  it('writes nothing on the way out when nothing was changed here', async () => {
    render(<Onboarding />);
    await screen.findByTestId(TID.step('welcome'));
    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 50));
    expect((await browser.storage.local.get(ONBOARDING_KEY))[ONBOARDING_KEY]).toBeUndefined();
  });
});
