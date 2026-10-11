import { act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { StudyVaultError, defaultSettings } from '@shared';
import {
  BIOLOGY,
  INBOX,
  cleanupUi,
  makeHighlight,
  mountUi,
  pressFocusShortcut,
  rect,
} from './testHarness';

const SELECTION = { text: 'Mitochondria are the powerhouse', rect: rect(100, 200, 120, 20) };

type Mounted = ReturnType<typeof mountUi>;

function show(ui: Mounted['ui'], text = SELECTION.text): void {
  act(() => ui.showToolbar({ text, rect: SELECTION.rect }));
}

async function openAdvanced(m: Mounted) {
  show(m.ui);
  await userEvent.setup().click(m.q.getByRole('button', { name: 'More options' }));
  const dialog = m.q.getByRole('dialog', { name: 'Save with details' });
  const bank = await within(dialog).findByRole('combobox', { name: 'Bank' });
  return { dialog, bank: bank as HTMLSelectElement, d: within(dialog) };
}

afterEach(cleanupUi);

describe('More options panel', () => {
  it('opens a labelled dialog and moves focus into it', async () => {
    const m = mountUi();
    const { dialog } = await openAdvanced(m);
    expect(m.shadow.activeElement).toBe(dialog);
    expect(m.q.getByRole('button', { name: 'More options' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('lists banks, preselects the last-used one and saves every field', async () => {
    const m = mountUi();
    const { bank, d } = await openAdvanced(m);
    expect(m.host.listBanks).toHaveBeenCalledTimes(1);
    expect(Array.from(bank.options).map((o) => o.textContent)).toEqual([
      'Inbox (default)',
      'Biology',
    ]);
    expect(bank.value).toBe(BIOLOGY.id);

    fireEvent.change(bank, { target: { value: INBOX.id } });
    fireEvent.change(d.getByRole('combobox', { name: 'Type' }), { target: { value: 'formula' } });
    fireEvent.change(d.getByRole('combobox', { name: 'Priority' }), { target: { value: '5' } });
    await userEvent.setup().click(d.getByRole('button', { name: 'Save' }));

    expect(m.host.save).toHaveBeenCalledWith({
      kind: 'formula',
      color: defaultSettings().palette.formula,
      bankId: INBOX.id,
      comment: '',
      priority: 5,
    });
    expect(await m.q.findByText('Saved to Inbox')).toBeTruthy();
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.host.dismissSelection).toHaveBeenCalled();
  });

  it('falls back to the Inbox when the last-used bank no longer exists', async () => {
    const m = mountUi({
      host: { listBanks: async () => ({ banks: [INBOX, BIOLOGY], lastBankId: 'bank-gone0001' }) },
    });
    const { bank } = await openAdvanced(m);
    expect(bank.value).toBe(INBOX.id);
  });

  it('handles an empty bank list by offering the default Inbox and saving without a bank id', async () => {
    const m = mountUi({ host: { listBanks: async () => ({ banks: [], lastBankId: null }) } });
    const { bank, d } = await openAdvanced(m);
    expect(bank.disabled).toBe(true);
    expect(bank.options[0]?.textContent).toBe('Inbox (default)');
    await userEvent.setup().click(d.getByRole('button', { name: 'Save' }));
    expect(m.host.save).toHaveBeenCalledWith(expect.objectContaining({ bankId: null }));
  });

  it('shows a loading state, and Save still works with the default bank meanwhile', async () => {
    const m = mountUi({ host: { listBanks: () => new Promise(() => undefined) } });
    show(m.ui);
    const user = userEvent.setup();
    await user.click(m.q.getByRole('button', { name: 'More options' }));
    const dialog = m.q.getByRole('dialog');
    expect(within(dialog).getByText('Loading banks…')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(m.host.save).toHaveBeenCalledWith(expect.objectContaining({ bankId: null }));
  });

  it('shows the load error with a working Retry', async () => {
    const m = mountUi();
    m.host.listBanks.mockRejectedValueOnce(new Error('Extension context lost'));
    show(m.ui);
    const user = userEvent.setup();
    await user.click(m.q.getByRole('button', { name: 'More options' }));
    const dialog = m.q.getByRole('dialog');
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Extension context lost');

    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByRole('combobox', { name: 'Bank' })).toBeTruthy();
    expect(m.host.listBanks).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog and the choices when saving fails, then saves on retry', async () => {
    const m = mountUi();
    m.host.save.mockRejectedValueOnce(
      new StudyVaultError('storage_unavailable', 'Storage is asleep.'),
    );
    const { d } = await openAdvanced(m);
    fireEvent.change(d.getByRole('combobox', { name: 'Priority' }), { target: { value: '4' } });
    const user = userEvent.setup();
    await user.click(d.getByRole('button', { name: 'Save' }));

    expect(await m.q.findByText('Storage is asleep.')).toBeTruthy();
    expect((d.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement).value).toBe('4');
    expect(m.q.getByRole('toolbar')).toBeTruthy();

    await user.click(d.getByRole('button', { name: 'Save' }));
    expect(await m.q.findByText('Saved to Inbox')).toBeTruthy();
    expect(m.host.save).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 4 }));
    expect(m.q.queryByRole('dialog')).toBeNull();
  });

  it('shows bank names and the selected text as text, never as markup', async () => {
    const hostileBank = '<img src=x onerror="window.__svXss = 3">';
    const hostileQuote = '<script>window.__svXss = 2</script>';
    const m = mountUi({
      host: {
        listBanks: async () => ({
          banks: [INBOX, { ...BIOLOGY, name: hostileBank }],
          lastBankId: BIOLOGY.id,
        }),
      },
    });
    show(m.ui, hostileQuote);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'More options' }));
    const bank = (await m.q.findByRole('combobox', { name: 'Bank' })) as HTMLSelectElement;
    expect(bank.options[1]?.textContent).toBe(hostileBank);
    expect(m.q.getByText(hostileQuote)).toBeTruthy();
    expect(m.container.querySelector('img, script')).toBeNull();
    expect((window as unknown as { __svXss?: number }).__svXss).toBeUndefined();
  });
});

describe('New bank...', () => {
  it('opens the side panel from the click instead of asking for a name in the page', async () => {
    const m = mountUi();
    const { d } = await openAdvanced(m);
    const button = d.getByRole('button', { name: 'New bank...' });
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    expect(d.getByText('A new bank is named in the side panel.')).toBeTruthy();

    act(() => {
      fireEvent.click(button);
    });
    // Synchronously: chrome.sidePanel.open needs this click's user gesture.
    expect(m.host.openInSidePanel).toHaveBeenCalledTimes(1);
    expect(m.host.openInSidePanel).toHaveBeenCalledWith(null);
    expect(d.queryByRole('textbox')).toBeNull();
    expect(m.host.createBank).not.toHaveBeenCalled();
    expect(m.q.getByRole('dialog', { name: 'Save with details' })).toBeTruthy();
  });

  it('reports a side panel that could not be opened', async () => {
    const m = mountUi();
    m.host.openInSidePanel.mockResolvedValueOnce(false);
    const { d } = await openAdvanced(m);
    await userEvent.setup().click(d.getByRole('button', { name: 'New bank...' }));
    expect((await m.q.findByRole('alert')).textContent).toContain('Could not open the side panel');
  });

  it('does not repeat an error the host already reported', async () => {
    const m = mountUi();
    m.host.openInSidePanel.mockImplementationOnce(async () => {
      m.ui.toast({ text: 'The side panel is not available here.', tone: 'error' });
      return false;
    });
    const { d } = await openAdvanced(m);
    await userEvent.setup().click(d.getByRole('button', { name: 'New bank...' }));
    expect(await m.q.findByText('The side panel is not available here.')).toBeTruthy();
    expect(m.q.queryByText(/Could not open the side panel/)).toBeNull();
  });

  it('shows a bank created in the side panel when the page window regains focus', async () => {
    const m = mountUi();
    const { d, bank } = await openAdvanced(m);
    fireEvent.change(bank, { target: { value: INBOX.id } });
    const created = { id: 'bank-new00001', name: 'Pathology', color: 'purple', isInbox: false };
    m.host.listBanks.mockResolvedValueOnce({
      banks: [INBOX, BIOLOGY, created],
      lastBankId: created.id,
    });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await d.findByRole('option', { name: 'Pathology' });
    // The user's own choice is kept.
    expect(bank.value).toBe(INBOX.id);
  });

  it('keeps the list when a refresh on focus fails', async () => {
    const m = mountUi();
    const { bank } = await openAdvanced(m);
    m.host.listBanks.mockRejectedValueOnce(new Error('asleep'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(bank.isConnected).toBe(true);
    expect(m.q.queryByText(/Could not load your banks/)).toBeNull();
  });

  it('stops listening for focus once the panel is closed', async () => {
    const m = mountUi();
    await openAdvanced(m);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'More options' }));
    expect(m.q.queryByRole('dialog')).toBeNull();
    m.host.listBanks.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(m.host.listBanks).not.toHaveBeenCalled();
  });
});

describe('the page-side overlay has no free-text input', () => {
  // Page scripts can observe keystrokes typed inside the page document (capture-phase window
  // listeners), even through a closed shadow root. Text is typed in the side panel only.
  const FREE_TEXT = 'input, textarea, [contenteditable], [role="textbox"], [role="searchbox"]';

  const selectNames = (root: HTMLElement): string[] =>
    Array.from(root.querySelectorAll('select'))
      .map((el) => el.labels?.[0]?.textContent ?? '(unlabelled)')
      .sort();

  it('toolbar with the More panel open: only the bank, type and priority selects', async () => {
    const m = mountUi();
    await openAdvanced(m);
    expect(m.container.querySelectorAll(FREE_TEXT)).toHaveLength(0);
    expect(m.q.queryByRole('textbox')).toBeNull();
    expect(selectNames(m.container)).toEqual(['Bank', 'Priority', 'Type']);
  });

  it('toolbar alone and after a Note save', async () => {
    const m = mountUi();
    show(m.ui);
    expect(m.container.querySelectorAll(FREE_TEXT)).toHaveLength(0);
    expect(m.container.querySelectorAll('select')).toHaveLength(0);
    await userEvent.setup().click(m.q.getByRole('button', { name: /add a note/i }));
    await m.q.findByText(/write your note in the side panel/);
    expect(m.container.querySelectorAll(FREE_TEXT)).toHaveLength(0);
  });

  it('highlight popover, with and without a note: only the type and priority selects', () => {
    const m = mountUi();
    act(() => m.ui.showHighlightPopover(makeHighlight({ userComment: 'my note' }), rect()));
    expect(m.container.querySelectorAll(FREE_TEXT)).toHaveLength(0);
    expect(selectNames(m.container)).toEqual(['Priority', 'Type']);
    act(() => m.ui.showHighlightPopover(makeHighlight({ userComment: '' }), rect()));
    expect(m.container.querySelectorAll(FREE_TEXT)).toHaveLength(0);
  });

  it('toasts never hold a field', () => {
    const m = mountUi();
    act(() => {
      m.ui.toast({ text: 'a', tone: 'info' });
      m.ui.toast({ text: 'b', tone: 'error', action: { label: 'Retry', run: () => undefined } });
    });
    expect(m.container.querySelectorAll(FREE_TEXT)).toHaveLength(0);
  });
});

describe('closing', () => {
  it('Escape closes only the panel and returns focus to the button that opened it', async () => {
    const m = mountUi();
    show(m.ui);
    pressFocusShortcut();
    const user = userEvent.setup();
    await user.keyboard('{End}');
    const more = m.q.getByRole('button', { name: 'More options' });
    expect(m.shadow.activeElement).toBe(more);
    await user.keyboard('{Enter}');
    const dialog = m.q.getByRole('dialog');
    expect(m.shadow.activeElement).toBe(dialog);

    await user.keyboard('{Escape}');
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.q.getByRole('toolbar')).toBeTruthy();
    expect(m.shadow.activeElement).toBe(more);
    expect(m.host.dismissSelection).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(m.q.queryByRole('toolbar')).toBeNull();
    expect(m.host.dismissSelection).toHaveBeenCalledTimes(1);
  });

  it('after a pointer-opened panel, Escape returns focus to the page element', async () => {
    const m = mountUi();
    const page = document.createElement('button');
    document.body.append(page);
    page.focus();
    show(m.ui);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'More options' }));
    const dialog = m.q.getByRole('dialog');
    expect(m.shadow.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(page);
    expect(m.q.getByRole('toolbar')).toBeTruthy();
  });

  it('lists the panel controls in reading order, with no tabindex to reorder them', async () => {
    const m = mountUi();
    const { dialog } = await openAdvanced(m);
    const tabbable = Array.from(dialog.querySelectorAll<HTMLElement>('select, button, [tabindex]'));
    expect(tabbable.filter((el) => el !== dialog && el.hasAttribute('tabindex'))).toEqual([]);
    expect(
      tabbable.map((el) =>
        el instanceof HTMLSelectElement ? (el.labels?.[0]?.textContent ?? '') : el.textContent,
      ),
    ).toEqual(['Bank', 'New bank...', 'Type', 'Priority', 'Save', 'Cancel']);
  });

  it('Cancel closes the panel and leaves the toolbar for another choice', async () => {
    const m = mountUi();
    show(m.ui);
    const user = userEvent.setup();
    await user.click(m.q.getByRole('button', { name: 'More options' }));
    await user.click(within(m.q.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.q.getByRole('toolbar')).toBeTruthy();
    expect(m.host.save).not.toHaveBeenCalled();
  });

  it('More toggles its own panel', async () => {
    const m = mountUi();
    show(m.ui);
    const user = userEvent.setup();
    const more = m.q.getByRole('button', { name: 'More options' });
    await user.click(more);
    expect(m.q.getByRole('dialog', { name: 'Save with details' })).toBeTruthy();
    await user.click(more);
    expect(m.q.queryByRole('dialog')).toBeNull();
  });
});
