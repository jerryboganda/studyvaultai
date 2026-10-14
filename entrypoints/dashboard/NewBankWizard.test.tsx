import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { NewBankWizard } from './NewBankWizard';
import { Harness } from './testHarness';
import { FakeVault } from './testing';
import { EMPTY_TREE_DATA } from './treeData';

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

function open() {
  const vault = new FakeVault();
  const onClose = vi.fn();
  const onOpenBank = vi.fn();
  render(
    <Harness api={vault.api()} tree={EMPTY_TREE_DATA}>
      <NewBankWizard onClose={onClose} onOpenBank={onOpenBank} />
    </Harness>,
  );
  return { vault, onClose, onOpenBank };
}

const wizard = () => screen.getByRole('dialog', { name: 'New bank' });
const next = () => fireEvent.click(within(wizard()).getByRole('button', { name: 'Next' }));
const title = () => within(wizard()).getByRole('heading', { level: 2 }).textContent;

describe('NewBankWizard', () => {
  it('walks Name, Icon, Colour and Looks good, then makes the bank with all three', async () => {
    const { vault, onOpenBank } = open();
    expect(title()).toBe('Name your bank');
    expect(within(wizard()).getByRole('progressbar').getAttribute('aria-valuetext')).toBe(
      'Step 1 of 4: Name your bank',
    );
    fireEvent.change(screen.getByTestId('name-input'), { target: { value: '  Physics ' } });
    next();
    expect(title()).toBe('Pick an icon');
    fireEvent.click(within(wizard()).getByRole('radio', { name: 'DNA' }));
    next();
    expect(title()).toBe('Pick a colour');
    fireEvent.click(within(wizard()).getByRole('radio', { name: /Purple/ }));
    next();
    expect(title()).toBe('Looks good?');
    expect(wizard().textContent).toContain('Physics');

    fireEvent.click(within(wizard()).getByRole('button', { name: 'Create bank' }));
    const done = await screen.findByTestId('new-bank-done');
    expect(within(done).getByRole('heading', { name: 'Bank ready!' })).toBeTruthy();
    expect(vault.called('createBank')[0]!.args).toEqual(['Physics']);
    const id = vault.banks.at(-1)!.id;
    expect(vault.called('setBankColor')[0]!.args).toEqual([id, 'purple']);
    expect(vault.called('setBankIcon')[0]!.args).toEqual([id, '🧬']);

    fireEvent.click(screen.getByTestId('new-bank-open'));
    expect(onOpenBank).toHaveBeenCalledWith(id);
  });

  it('stays on the name step with an error until a name is typed, and Back keeps answers', () => {
    const { vault } = open();
    next();
    expect(title()).toBe('Name your bank');
    const input = screen.getByTestId('name-input');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(within(wizard()).getByRole('alert').textContent).toContain('Enter a name');
    expect(vault.called('createBank')).toHaveLength(0);

    fireEvent.change(input, { target: { value: 'Physics' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(title()).toBe('Pick an icon');
    fireEvent.click(within(wizard()).getByRole('button', { name: 'Back' }));
    expect((screen.getByTestId('name-input') as HTMLInputElement).value).toBe('Physics');
  });

  it('keeps the wizard open with the reason when the bank cannot be made', async () => {
    const { vault } = open();
    vault.fail.createBank = new Error('Storage is unavailable');
    fireEvent.change(screen.getByTestId('name-input'), { target: { value: 'Physics' } });
    next();
    next();
    next();
    fireEvent.click(within(wizard()).getByRole('button', { name: 'Create bank' }));
    expect(await within(wizard()).findByText('Storage is unavailable')).toBeTruthy();
    expect(screen.queryByTestId('new-bank-done')).toBeNull();

    delete vault.fail.createBank;
    fireEvent.click(within(wizard()).getByRole('button', { name: 'Create bank' }));
    await screen.findByTestId('new-bank-done');
  });

  it('asks before discarding typed answers on Close', async () => {
    const { onClose } = open();
    fireEvent.change(screen.getByTestId('name-input'), { target: { value: 'Physics' } });
    fireEvent.click(within(wizard()).getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(wizard()).getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes the done screen with Done', async () => {
    const { onClose } = open();
    fireEvent.change(screen.getByTestId('name-input'), { target: { value: 'Physics' } });
    next();
    next();
    next();
    fireEvent.click(within(wizard()).getByRole('button', { name: 'Create bank' }));
    const done = await screen.findByTestId('new-bank-done');
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
