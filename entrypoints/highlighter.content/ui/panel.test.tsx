import { act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { StudyVaultError, defaultSettings } from '@shared';
import {
  BIOLOGY,
  INBOX,
  cleanupUi,
  mountUi,
  pressFocusShortcut,
  rect,
  typeInto,
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

describe('note composer', () => {
  it('opens a labelled dialog with the note field focused', async () => {
    const m = mountUi();
    show(m.ui);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Add a note' }));
    const dialog = m.q.getByRole('dialog', { name: 'Add a note' });
    expect(m.shadow.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Note' }));
    expect(m.q.getByRole('button', { name: 'Add a note' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('saves the note with the default kind into the last-used bank', async () => {
    const m = mountUi();
    show(m.ui);
    const user = userEvent.setup();
    await user.click(m.q.getByRole('button', { name: 'Add a note' }));
    const dialog = m.q.getByRole('dialog');
    typeInto(within(dialog).getByRole('textbox'), '  in my own words  ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(m.host.save).toHaveBeenCalledWith({
      kind: 'essential',
      color: 'amber',
      bankId: null,
      comment: 'in my own words',
      priority: 3,
    });
    expect(await m.q.findByText('Saved to Inbox')).toBeTruthy();
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.host.dismissSelection).toHaveBeenCalled();
  });

  it('Ctrl+Enter in the field saves', async () => {
    const m = mountUi();
    show(m.ui);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Add a note' }));
    const field = m.q.getByRole('textbox');
    typeInto(field, 'quick');
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(m.host.save).toHaveBeenCalledWith(expect.objectContaining({ comment: 'quick' }));
  });

  it('keeps the dialog and typed text when saving fails, then saves on retry', async () => {
    const m = mountUi();
    m.host.save.mockRejectedValueOnce(
      new StudyVaultError('storage_unavailable', 'Storage is asleep.'),
    );
    show(m.ui);
    const user = userEvent.setup();
    await user.click(m.q.getByRole('button', { name: 'Add a note' }));
    const dialog = m.q.getByRole('dialog');
    typeInto(within(dialog).getByRole('textbox'), 'precious');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await m.q.findByText('Storage is asleep.')).toBeTruthy();
    expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('precious');
    expect(m.q.getByRole('toolbar')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await m.q.findByText('Saved to Inbox')).toBeTruthy();
    expect(m.q.queryByRole('dialog')).toBeNull();
  });

  it('shows the selected text as plain text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__svXss = 1"><script>window.__svXss = 2</script>';
    const m = mountUi();
    show(m.ui, hostile);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Add a note' }));
    expect(m.q.getByText(hostile)).toBeTruthy();
    expect(m.container.querySelector('img, script')).toBeNull();
    expect((window as unknown as { __svXss?: number }).__svXss).toBeUndefined();
  });
});

describe('advanced panel', () => {
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
    typeInto(d.getByRole('textbox', { name: 'Note' }), 'remember this');
    await userEvent.setup().click(d.getByRole('button', { name: 'Save' }));

    expect(m.host.save).toHaveBeenCalledWith({
      kind: 'formula',
      color: defaultSettings().palette.formula,
      bankId: INBOX.id,
      comment: 'remember this',
      priority: 5,
    });
    expect(await m.q.findByText('Saved to Inbox')).toBeTruthy();
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

  it('creates a bank inline, selects it and saves into it', async () => {
    const m = mountUi();
    const { d, bank } = await openAdvanced(m);
    const user = userEvent.setup();
    await user.click(d.getByRole('button', { name: 'New bank' }));
    const name = d.getByRole('textbox', { name: 'Bank name' });
    expect(m.shadow.activeElement).toBe(name);
    typeInto(name, '  Pathology ');
    await user.click(d.getByRole('button', { name: 'Create' }));

    expect(m.host.createBank).toHaveBeenCalledWith('Pathology');
    await d.findByRole('option', { name: 'Pathology' });
    expect(bank.value).toBe('bank-new00001');
    expect(d.queryByRole('textbox', { name: 'Bank name' })).toBeNull();

    await user.click(d.getByRole('button', { name: 'Save' }));
    expect(m.host.save).toHaveBeenCalledWith(expect.objectContaining({ bankId: 'bank-new00001' }));
  });

  it('validates bank names before calling the host', async () => {
    const m = mountUi();
    const { d } = await openAdvanced(m);
    const user = userEvent.setup();
    await user.click(d.getByRole('button', { name: 'New bank' }));
    const name = d.getByRole('textbox', { name: 'Bank name' });

    await user.click(d.getByRole('button', { name: 'Create' }));
    expect((await d.findByRole('alert')).textContent).toBe('Enter a name for the bank.');
    expect(name.getAttribute('aria-invalid')).toBe('true');

    typeInto(name, 'BIOLOGY');
    expect(d.queryByRole('alert')).toBeNull(); // typing clears the message
    await user.click(d.getByRole('button', { name: 'Create' }));
    expect((await d.findByRole('alert')).textContent).toContain('already exists');

    typeInto(name, 'x'.repeat(81));
    await user.click(d.getByRole('button', { name: 'Create' }));
    expect((await d.findByRole('alert')).textContent).toContain('80 characters');
    expect(m.host.createBank).not.toHaveBeenCalled();
  });

  it('keeps the form and the name when the host rejects the bank', async () => {
    const m = mountUi({
      host: {
        createBank: async () => {
          throw new StudyVaultError('invalid_request', 'That name is reserved.');
        },
      },
    });
    const { d } = await openAdvanced(m);
    const user = userEvent.setup();
    await user.click(d.getByRole('button', { name: 'New bank' }));
    typeInto(d.getByRole('textbox', { name: 'Bank name' }), 'Inbox 2');
    await user.click(d.getByRole('button', { name: 'Create' }));
    expect((await d.findByRole('alert')).textContent).toBe('That name is reserved.');
    expect((d.getByRole('textbox', { name: 'Bank name' }) as HTMLInputElement).value).toBe(
      'Inbox 2',
    );
  });

  it('shows bank names as text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__svXss = 3">';
    const m = mountUi({
      host: {
        listBanks: async () => ({
          banks: [INBOX, { ...BIOLOGY, name: hostile }],
          lastBankId: BIOLOGY.id,
        }),
      },
    });
    const { bank } = await openAdvanced(m);
    expect(bank.options[1]?.textContent).toBe(hostile);
    expect(m.container.querySelector('img')).toBeNull();
  });
});

describe('closing', () => {
  it('Escape closes only the panel and returns focus to the button that opened it', async () => {
    const m = mountUi();
    show(m.ui);
    pressFocusShortcut();
    const user = userEvent.setup();
    await user.keyboard('{End}{ArrowLeft}');
    const noteButton = m.q.getByRole('button', { name: 'Add a note' });
    expect(m.shadow.activeElement).toBe(noteButton);
    await user.keyboard('{Enter}');
    expect(m.q.getByRole('dialog')).toBeTruthy();
    expect(m.shadow.activeElement?.tagName).toBe('TEXTAREA');

    await user.keyboard('{Escape}');
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.q.getByRole('toolbar')).toBeTruthy();
    expect(m.shadow.activeElement).toBe(noteButton);
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
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Add a note' }));
    expect(m.shadow.activeElement?.tagName).toBe('TEXTAREA');

    fireEvent.keyDown(m.q.getByRole('textbox'), { key: 'Escape' });
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(page);
    expect(m.q.getByRole('toolbar')).toBeTruthy();
  });

  it('Cancel closes the panel and leaves the toolbar for another choice', async () => {
    const m = mountUi();
    show(m.ui);
    const user = userEvent.setup();
    await user.click(m.q.getByRole('button', { name: 'Add a note' }));
    await user.click(within(m.q.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.q.getByRole('toolbar')).toBeTruthy();
    expect(m.host.save).not.toHaveBeenCalled();
  });

  it('Note and More toggle their own panel and switch between each other', async () => {
    const m = mountUi();
    show(m.ui);
    const user = userEvent.setup();
    const note = m.q.getByRole('button', { name: 'Add a note' });
    const more = m.q.getByRole('button', { name: 'More options' });
    await user.click(note);
    typeInto(m.q.getByRole('textbox'), 'kept');
    await user.click(more);
    const dialog = await m.q.findByRole('dialog', { name: 'Save with details' });
    expect(
      (within(dialog).getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement).value,
    ).toBe('kept');
    await user.click(more);
    expect(m.q.queryByRole('dialog')).toBeNull();
  });
});
