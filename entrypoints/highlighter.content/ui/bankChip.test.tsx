import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared';
import {
  BIOLOGY,
  INBOX,
  act,
  cleanupUi,
  focusToolbar,
  makeResult,
  mountUi,
  rect,
  within,
} from './testHarness';

/** The toolbar's bank chip and its menu (UX_DESIGN 7.6), and the save toast's "+2 XP" chip. */

const SELECTION = { text: 'Mitochondria are the powerhouse', rect: rect(100, 200, 120, 20) };
type Mounted = ReturnType<typeof mountUi>;

function show(m: Mounted): void {
  act(() => m.ui.showToolbar(SELECTION));
}

const chip = (m: Mounted) => m.q.getByRole('button', { name: /^Bank/ });

afterEach(() => {
  cleanupUi();
  vi.useRealTimers();
});

describe('bank chip', () => {
  it('names the bank a save goes to: the last-used one, once the list has loaded', async () => {
    const m = mountUi();
    show(m);
    await vi.waitFor(() => expect(chip(m).getAttribute('aria-label')).toBe('Bank: Biology'));
    expect(chip(m).textContent).toContain('Biology');
    expect(chip(m).getAttribute('aria-haspopup')).toBe('menu');
    expect(chip(m).getAttribute('aria-expanded')).toBe('false');
    expect(m.host.listBanks).toHaveBeenCalledTimes(1);
  });

  it('says only "Bank" while loading or when the list failed, and quick save still works', async () => {
    const m = mountUi({ host: { listBanks: async () => Promise.reject(new Error('asleep')) } });
    show(m);
    await act(async () => undefined);
    expect(chip(m).getAttribute('aria-label')).toBe('Bank');
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Save selection' }));
    // No toast for the list: the save goes to the worker's default bank.
    expect(m.host.save).toHaveBeenCalledWith(expect.objectContaining({ bankId: null }));
    expect(m.q.queryByText(/asleep/)).toBeNull();
  });

  it('opens a menu of banks with the current one checked; picking one moves every save there', async () => {
    const m = mountUi();
    show(m);
    const user = userEvent.setup();
    await user.click(chip(m));
    const menu = m.q.getByRole('menu', { name: 'Save to bank' });
    expect(chip(m).getAttribute('aria-expanded')).toBe('true');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['Inbox', 'false'],
      ['Biology', 'true'],
    ]);
    // Focus moved into the menu, on the checked bank.
    expect(m.shadow.activeElement).toBe(items[1]);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Inbox' }));
    expect(m.q.queryByRole('menu')).toBeNull();
    expect(chip(m).getAttribute('aria-label')).toBe('Bank: Inbox');

    await user.click(m.q.getByRole('button', { name: 'Save as Formula' }));
    expect(m.host.save).toHaveBeenCalledWith(expect.objectContaining({ bankId: INBOX.id }));
  });

  it('shares the pick with Save with details, both ways', async () => {
    const m = mountUi();
    show(m);
    const user = userEvent.setup();
    await user.click(chip(m));
    await user.click(m.q.getByRole('menuitemradio', { name: 'Inbox' }));
    await user.click(m.q.getByRole('button', { name: 'More options' }));
    const bank = (await m.q.findByRole('combobox', { name: 'Bank' })) as HTMLSelectElement;
    expect(bank.value).toBe(INBOX.id);
  });

  it('is a menu button by keyboard: Down opens it, arrows move, Escape returns to the chip', async () => {
    const m = mountUi();
    show(m);
    await act(async () => undefined);
    focusToolbar(m.ui);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(m.shadow.activeElement).toBe(chip(m));
    await user.keyboard('{ArrowDown}');
    const menu = m.q.getByRole('menu');
    expect(m.shadow.activeElement).toBe(
      within(menu).getByRole('menuitemradio', { name: 'Biology' }),
    );
    await user.keyboard('{ArrowDown}');
    expect(m.shadow.activeElement).toBe(
      within(menu).getByRole('menuitem', { name: 'New bank...' }),
    );
    await user.keyboard('{Home}');
    expect(m.shadow.activeElement).toBe(within(menu).getByRole('menuitemradio', { name: 'Inbox' }));

    await user.keyboard('{Escape}');
    expect(m.q.queryByRole('menu')).toBeNull();
    // Only the menu closed: the toolbar and the selection stay.
    expect(m.q.getByRole('toolbar')).toBeTruthy();
    expect(m.host.dismissSelection).not.toHaveBeenCalled();
    expect(m.shadow.activeElement).toBe(chip(m));
  });

  it('Enter on a bank picks it and hands focus back to the chip', async () => {
    const m = mountUi();
    show(m);
    await act(async () => undefined);
    focusToolbar(m.ui);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(m.q.queryByRole('menu')).toBeNull();
    expect(chip(m).getAttribute('aria-label')).toBe('Bank: Inbox');
    expect(m.shadow.activeElement).toBe(chip(m));
  });

  it('New bank opens the side panel from the click (no name is typed in the page)', async () => {
    const m = mountUi();
    show(m);
    await userEvent.setup().click(chip(m));
    act(() => {
      m.q.getByRole('menuitem', { name: 'New bank...' }).click();
    });
    expect(m.host.openInSidePanel).toHaveBeenCalledWith(null);
    expect(m.host.createBank).not.toHaveBeenCalled();
    expect(m.q.queryByRole('menu')).toBeNull();
  });

  it('shows a load error with a working Retry inside the menu', async () => {
    const m = mountUi();
    m.host.listBanks.mockRejectedValueOnce(new Error('Extension context lost'));
    show(m);
    const user = userEvent.setup();
    await user.click(chip(m));
    const menu = m.q.getByRole('menu');
    expect(menu.textContent).toContain('Extension context lost');
    await user.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(await within(menu).findByRole('menuitemradio', { name: 'Biology' })).toBeTruthy();
    expect(m.host.listBanks).toHaveBeenCalledTimes(2);
  });

  it('with no bank yet, says "Bank" and offers only New bank (saves go to the default Inbox)', async () => {
    const m = mountUi({ host: { listBanks: async () => ({ banks: [], lastBankId: null }) } });
    show(m);
    await userEvent.setup().click(chip(m));
    expect(chip(m).getAttribute('aria-label')).toBe('Bank');
    expect(m.q.queryAllByRole('menuitemradio')).toEqual([]);
    expect(m.q.getByRole('menuitem', { name: 'New bank...' })).toBeTruthy();
    // Nothing above it to separate from.
    expect(m.q.queryByRole('separator')).toBeNull();
  });

  it('More and the bank menu are one popup at a time', async () => {
    const m = mountUi();
    show(m);
    const user = userEvent.setup();
    await user.click(chip(m));
    await user.click(m.q.getByRole('button', { name: 'More options' }));
    expect(m.q.queryByRole('menu')).toBeNull();
    expect(m.q.getByRole('dialog', { name: 'Save with details' })).toBeTruthy();
    await user.click(chip(m));
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.q.getByRole('menu')).toBeTruthy();
  });

  it('shows bank names as text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__svXss = 4">';
    const m = mountUi({
      host: {
        listBanks: async () => ({
          banks: [INBOX, { ...BIOLOGY, name: hostile }],
          lastBankId: BIOLOGY.id,
        }),
      },
    });
    show(m);
    await userEvent.setup().click(chip(m));
    expect(m.q.getByRole('menuitemradio', { name: hostile })).toBeTruthy();
    expect(m.container.querySelector('img')).toBeNull();
  });
});

describe('the save toast in Game mode', () => {
  it('shows "+2 XP" when the save earned it', async () => {
    const m = mountUi();
    m.host.save.mockResolvedValueOnce(makeResult({ xp: 2 }));
    show(m);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Save selection' }));
    const toast = (await m.q.findByText('Saved to Inbox')).closest('.sv-toast') as HTMLElement;
    expect(within(toast).getByText('+2 XP')).toBeTruthy();
    // Announced with the toast, in the polite region.
    expect(toast.closest('[aria-live="polite"]')).toBeTruthy();
    // XP, Undo and Dismiss are one group, which wraps under the text as a whole when narrow.
    const group = within(toast).getByText('+2 XP').closest('.sv-toast-actions') as HTMLElement;
    expect(within(group).getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Dismiss notification' })).toBeTruthy();
  });

  it('shows no XP when the save earned none (Game mode off, or a duplicate)', async () => {
    const m = mountUi();
    show(m);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Save selection' }));
    await m.q.findByText('Saved to Inbox');
    expect(m.q.queryByText(/XP/)).toBeNull();
  });

  it('a toast from the page logic can carry XP too (keyboard and menu saves)', () => {
    const m = mountUi({ settings: defaultSettings() });
    act(() => m.ui.toast({ text: 'Saved to Biology', tone: 'success', xp: 2 }));
    expect(m.q.getByText('+2 XP')).toBeTruthy();
  });
});
