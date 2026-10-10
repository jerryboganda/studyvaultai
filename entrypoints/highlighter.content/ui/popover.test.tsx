import { act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared';
import { cleanupUi, makeHighlight, mountUi, rect, typeInto } from './testHarness';

const ANCHOR = rect(100, 300, 160, 20);

function open(m: ReturnType<typeof mountUi>, over: Parameters<typeof makeHighlight>[0] = {}) {
  const highlight = makeHighlight(over);
  act(() => m.ui.showHighlightPopover(highlight, ANCHOR));
  return { highlight, dialog: m.q.getByRole('dialog', { name: 'Highlight details' }) };
}

afterEach(() => {
  cleanupUi();
  vi.useRealTimers();
});

describe('highlight popover', () => {
  it('shows the quote, kind chip with glyph and label, and positions next to the anchor', () => {
    const m = mountUi();
    const { dialog } = open(m, { kind: 'formula', color: 'blue', headingContext: 'Cell biology' });
    expect(m.q.getByText('Mitochondria are the powerhouse of the cell.')).toBeTruthy();
    const chip = dialog.querySelector('.sv-chip') as HTMLElement;
    expect(chip.textContent).toContain('ƒ');
    expect(chip.textContent).toContain('Formula');
    expect(m.q.getByText('Cell biology')).toBeTruthy();
    // jsdom has no layout: 0x0, above the anchor.
    expect(dialog.style.transform).toBe('translate(180px, 292px)');
  });

  it('renders quote, note and heading as plain text, never as markup', () => {
    const quote = '<img src=x onerror="window.__svXss = 1"> and <b>bold</b>';
    const m = mountUi();
    const { dialog } = open(m, {
      exactQuote: quote,
      userComment: '<script>window.__svXss = 2</script>',
      headingContext: '<i>Heading</i>',
    });
    expect(m.q.getByText(quote)).toBeTruthy();
    expect(m.q.getByText('<i>Heading</i>')).toBeTruthy();
    expect((m.q.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      '<script>window.__svXss = 2</script>',
    );
    expect(dialog.querySelector('img, b, i, script')).toBeNull();
    expect((window as unknown as { __svXss?: number }).__svXss).toBeUndefined();
  });

  it('moves focus into the dialog and Escape returns it to the page', () => {
    const page = document.createElement('a');
    page.setAttribute('href', '#');
    page.textContent = 'page link';
    document.body.append(page);
    page.focus();
    const m = mountUi();
    const { dialog } = open(m);
    expect(m.shadow.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(page);
  });

  it('closes on Close, and on a press anywhere on the page, but not on a press inside', () => {
    const m = mountUi();
    const outside = document.createElement('p');
    document.body.append(outside);
    const { dialog } = open(m);

    fireEvent.pointerDown(dialog);
    expect(m.q.queryByRole('dialog')).toBeTruthy();
    fireEvent.pointerDown(outside);
    expect(m.q.queryByRole('dialog')).toBeNull();

    open(m);
    fireEvent.click(m.q.getByRole('button', { name: 'Close' }));
    expect(m.q.queryByRole('dialog')).toBeNull();
  });
});

describe('editing', () => {
  it('saves the note after a pause and reports the status', async () => {
    vi.useFakeTimers();
    const m = mountUi();
    open(m);
    typeInto(m.q.getByRole('textbox', { name: 'Note' }), 'my own words');
    expect(m.q.getByText('Saving…')).toBeTruthy();
    expect(m.host.update).not.toHaveBeenCalled();

    await act(async () => void vi.advanceTimersByTime(599));
    expect(m.host.update).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(1));
    expect(m.host.update).toHaveBeenCalledTimes(1);
    expect(m.host.update).toHaveBeenCalledWith('hl-00000001', { userComment: 'my own words' });
    expect(m.q.getByText('Saved')).toBeTruthy();
  });

  it('collapses rapid typing into one save', async () => {
    vi.useFakeTimers();
    const m = mountUi();
    open(m);
    const field = m.q.getByRole('textbox', { name: 'Note' });
    typeInto(field, 'a');
    await act(async () => void vi.advanceTimersByTime(300));
    typeInto(field, 'ab');
    await act(async () => void vi.advanceTimersByTime(300));
    typeInto(field, 'abc');
    await act(async () => void vi.advanceTimersByTime(600));
    expect(m.host.update).toHaveBeenCalledTimes(1);
    expect(m.host.update).toHaveBeenCalledWith('hl-00000001', { userComment: 'abc' });
  });

  it('flushes an unsaved note immediately when the popover closes', async () => {
    vi.useFakeTimers();
    const m = mountUi();
    const { dialog } = open(m);
    typeInto(m.q.getByRole('textbox', { name: 'Note' }), 'do not lose me');
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.host.update).toHaveBeenCalledWith('hl-00000001', { userComment: 'do not lose me' });
  });

  it('changing the type sends the kind with its palette colour and updates the chip', async () => {
    const settings = defaultSettings();
    settings.palette = { ...settings.palette, question: 'purple' };
    const m = mountUi({ settings });
    const { dialog } = open(m);
    fireEvent.change(m.q.getByRole('combobox', { name: 'Type' }), {
      target: { value: 'question' },
    });
    await vi.waitFor(() =>
      expect(m.host.update).toHaveBeenCalledWith('hl-00000001', {
        kind: 'question',
        color: 'purple',
      }),
    );
    await vi.waitFor(() =>
      expect((dialog.querySelector('.sv-chip') as HTMLElement).textContent).toContain('Question'),
    );
  });

  it('changing the priority sends only the priority', async () => {
    const m = mountUi();
    open(m);
    fireEvent.change(m.q.getByRole('combobox', { name: 'Priority' }), { target: { value: '5' } });
    await vi.waitFor(() =>
      expect(m.host.update).toHaveBeenCalledWith('hl-00000001', { priority: 5 }),
    );
  });

  it('reports a failed save and retries with the same text', async () => {
    vi.useFakeTimers();
    const m = mountUi();
    m.host.update.mockRejectedValueOnce(new Error('Service worker is restarting'));
    open(m);
    typeInto(m.q.getByRole('textbox', { name: 'Note' }), 'draft');
    await act(async () => void vi.advanceTimersByTime(600));
    expect(m.q.getByText(/Could not save: Service worker is restarting/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(m.q.getByRole('button', { name: 'Retry' }));
    });
    expect(m.host.update).toHaveBeenCalledTimes(2);
    expect(m.host.update).toHaveBeenLastCalledWith('hl-00000001', { userComment: 'draft' });
    expect(m.q.getByText('Saved')).toBeTruthy();
  });

  it('a failed save during close is reported through a toast, not lost silently', async () => {
    vi.useFakeTimers();
    const m = mountUi();
    m.host.update.mockRejectedValueOnce(new Error('No connection'));
    const { dialog } = open(m);
    typeInto(m.q.getByRole('textbox', { name: 'Note' }), 'unsent');
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    expect(m.q.getByRole('alert').textContent).toContain('No connection');
  });
});

describe('deleting', () => {
  it('deletes, closes, and offers Undo that restores the highlight', async () => {
    const m = mountUi();
    open(m);
    const user = userEvent.setup();
    await user.click(m.q.getByRole('button', { name: 'Delete' }));

    expect(m.host.remove).toHaveBeenCalledWith('hl-00000001');
    expect(await m.q.findByText('Highlight deleted')).toBeTruthy();
    expect(m.q.queryByRole('dialog')).toBeNull();

    await user.click(m.q.getByRole('button', { name: 'Undo' }));
    expect(m.host.restore).toHaveBeenCalledWith('hl-00000001');
    expect(await m.q.findByText('Highlight restored')).toBeTruthy();
  });

  it('keeps the popover and says why when the delete fails', async () => {
    const m = mountUi();
    m.host.remove.mockRejectedValueOnce(new Error('Could not reach storage'));
    open(m);
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Delete' }));
    expect(await m.q.findByText(/Could not reach storage/)).toBeTruthy();
    expect(m.q.getByRole('dialog')).toBeTruthy();
    expect(m.q.queryByText('Highlight deleted')).toBeNull();
  });

  it('does not write a pending note for a highlight that was just deleted', async () => {
    vi.useFakeTimers();
    const m = mountUi();
    open(m);
    typeInto(m.q.getByRole('textbox', { name: 'Note' }), 'about to vanish');
    await act(async () => {
      fireEvent.click(m.q.getByRole('button', { name: 'Delete' }));
    });
    await act(async () => void vi.advanceTimersByTime(2000));
    expect(m.host.remove).toHaveBeenCalledTimes(1);
    expect(m.host.update).not.toHaveBeenCalled();
  });

  it('reports a failed restore', async () => {
    const m = mountUi();
    m.host.restore.mockRejectedValueOnce(new Error('Already gone'));
    open(m);
    const user = userEvent.setup();
    await user.click(m.q.getByRole('button', { name: 'Delete' }));
    await user.click(await m.q.findByRole('button', { name: 'Undo' }));
    expect(await m.q.findByText('Already gone')).toBeTruthy();
  });
});
