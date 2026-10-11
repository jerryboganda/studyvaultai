import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared';
import {
  act,
  cleanupUi,
  createEvent,
  fireEvent,
  makeHighlight,
  microtasks,
  mountUi,
  rect,
  within,
} from './testHarness';

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
    // jsdom has no layout: 0x0, above the anchor by the 12px gap.
    expect(dialog.style.transform).toBe('translate(180px, 288px)');
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
    expect(m.q.getByText('<script>window.__svXss = 2</script>')).toBeTruthy();
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

  it('has focus inside as soon as it is placed, not a frame later, and still remembers the page', async () => {
    // CI (Linux): Escape arrived 13 ms after Alt+Shift+] and went to the page, because Preact runs
    // passive effects after the next frame. Not wrapped in act: act would flush those effects.
    const page = document.createElement('a');
    page.setAttribute('href', '#');
    page.textContent = 'page link';
    document.body.append(page);
    page.focus();
    const m = mountUi();
    m.ui.showHighlightPopover(makeHighlight(), ANCHOR);
    await microtasks();
    const dialog = m.q.getByRole('dialog', { name: 'Highlight details' });
    expect(m.shadow.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(page);
  });

  it('focuses the dialog only once it is visible: a hidden element cannot take focus', () => {
    // jsdom does not refuse to focus a visibility:hidden element, so record what Chrome would see.
    const real = HTMLElement.prototype.focus;
    const seen: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (this.getAttribute('role') === 'dialog') seen.push(this.style.visibility || 'visible');
      real.call(this, options);
    });
    const m = mountUi();
    const { dialog } = open(m);
    expect(dialog.style.visibility).not.toBe('hidden');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('hidden');
    expect(m.shadow.activeElement).toBe(dialog);
  });

  it('Escape leaves focus on the page body when the element it came from is gone', () => {
    const page = document.createElement('button');
    page.textContent = 'page button';
    document.body.append(page);
    page.focus();
    const m = mountUi();
    const { dialog } = open(m);
    expect(m.shadow.activeElement).toBe(dialog);

    page.remove();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('does not trap Tab: it is a non-modal dialog, so Tab and Shift+Tab are left alone', () => {
    const m = mountUi();
    const { dialog } = open(m);
    const close = within(dialog).getByRole('button', { name: 'Close' });
    for (const [target, shiftKey] of [
      [close, false],
      [dialog, true],
    ] as const) {
      const event = createEvent.keyDown(target, { key: 'Tab', shiftKey });
      fireEvent(target, event);
      expect(event.defaultPrevented, `Tab on ${target.getAttribute('aria-label') ?? 'close'}`).toBe(
        false,
      );
    }
    // Still open: only Escape, the buttons or a press outside close it.
    expect(m.q.queryByRole('dialog')).toBeTruthy();
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

describe('the note', () => {
  it('is read-only text with a button that edits it in the side panel', () => {
    const m = mountUi();
    const { dialog } = open(m, { userComment: 'in my own words' });
    expect(within(dialog).getByText('in my own words')).toBeTruthy();
    expect(within(dialog).getByText('Note')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Edit note in side panel' })).toBeTruthy();
  });

  it('says so when there is none, and still offers the side panel', () => {
    const m = mountUi();
    const { dialog } = open(m, { userComment: '' });
    expect(within(dialog).getByText('No note yet.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Edit note in side panel' })).toBeTruthy();
  });

  it('shows only the start of a very long note', () => {
    const m = mountUi();
    open(m, { userComment: `${'a'.repeat(499)}b${'c'.repeat(5000)}` });
    const shown = m.container.querySelector('.sv-note-text') as HTMLElement;
    expect(shown.textContent?.length).toBe(500);
    expect(shown.textContent?.endsWith('…')).toBe(true);
  });

  it('opens the side panel on this highlight inside the click, then closes the popover', async () => {
    const m = mountUi();
    let resolve!: (opened: boolean) => void;
    m.host.openInSidePanel.mockImplementationOnce(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    );
    open(m, { id: 'hl-note0001', userComment: 'old note' });
    act(() => {
      fireEvent.click(m.q.getByRole('button', { name: 'Edit note in side panel' }));
    });
    expect(m.host.openInSidePanel).toHaveBeenCalledTimes(1);
    expect(m.host.openInSidePanel).toHaveBeenCalledWith('hl-note0001');
    // Not closed before the panel is really open.
    expect(m.q.queryByRole('dialog')).toBeTruthy();

    await act(async () => resolve(true));
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(m.host.update).not.toHaveBeenCalled();
  });

  it('stays open and says why when the side panel cannot be opened', async () => {
    const m = mountUi();
    m.host.openInSidePanel.mockResolvedValueOnce(false);
    open(m, { userComment: 'old note' });
    await userEvent.setup().click(m.q.getByRole('button', { name: 'Edit note in side panel' }));
    expect(await m.q.findByText(/Could not open the side panel/)).toBeTruthy();
    expect(m.q.getByRole('dialog', { name: 'Highlight details' })).toBeTruthy();
  });

  it('is not the page document: there is no text field for a page script to observe', () => {
    const m = mountUi();
    const { dialog } = open(m, { userComment: 'x' });
    expect(dialog.querySelector('input, textarea, [contenteditable]')).toBeNull();
  });

  it('follows a note written elsewhere while the popover is open, in the same dialog', () => {
    const m = mountUi();
    const { dialog } = open(m, { userComment: '' });
    expect(within(dialog).getByText('No note yet.')).toBeTruthy();

    // The side panel saved a note; the page's next load carries it (controller -> refresh).
    const written = makeHighlight({ userComment: 'typed in the side panel' });
    act(() => m.ui.refreshHighlightPopover((id) => (id === written.id ? written : undefined)));

    expect(within(dialog).getByText('typed in the side panel')).toBeTruthy();
    expect(within(dialog).queryByText('No note yet.')).toBeNull();
    expect(m.q.getByRole('dialog', { name: 'Highlight details' })).toBe(dialog);
    expect(m.shadow.activeElement).toBe(dialog); // focus and place are kept

    // A highlight the page no longer has leaves what is shown as it is.
    act(() => m.ui.refreshHighlightPopover(() => undefined));
    expect(within(dialog).getByText('typed in the side panel')).toBeTruthy();
  });

  it('a refresh never opens a popover, and ignores a popover that is shut', () => {
    const m = mountUi();
    const latest = vi.fn(() => makeHighlight({ userComment: 'ignored' }));
    act(() => m.ui.refreshHighlightPopover(latest));
    expect(m.q.queryByRole('dialog')).toBeNull();

    open(m);
    fireEvent.click(m.q.getByRole('button', { name: 'Close' }));
    act(() => m.ui.refreshHighlightPopover(latest));
    expect(m.q.queryByRole('dialog')).toBeNull();
    expect(latest).not.toHaveBeenCalled();
  });
});

describe('editing', () => {
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
    expect(m.q.getByText('Saved')).toBeTruthy();
  });

  it('changing the priority sends only the priority', async () => {
    const m = mountUi();
    open(m);
    fireEvent.change(m.q.getByRole('combobox', { name: 'Priority' }), { target: { value: '5' } });
    await vi.waitFor(() =>
      expect(m.host.update).toHaveBeenCalledWith('hl-00000001', { priority: 5 }),
    );
  });

  it('a change keeps the note shown in step with what the host returns', async () => {
    const m = mountUi();
    m.host.update.mockResolvedValueOnce(
      makeHighlight({ priority: 5, userComment: 'edited elsewhere' }),
    );
    open(m, { userComment: 'old note' });
    fireEvent.change(m.q.getByRole('combobox', { name: 'Priority' }), { target: { value: '5' } });
    expect(await m.q.findByText('edited elsewhere')).toBeTruthy();
  });

  it('reports a failed change and keeps showing the stored value', async () => {
    const m = mountUi();
    m.host.update.mockRejectedValueOnce(new Error('Service worker is restarting'));
    open(m, { priority: 2 });
    fireEvent.change(m.q.getByRole('combobox', { name: 'Priority' }), { target: { value: '5' } });
    expect(await m.q.findByText(/Could not save: Service worker is restarting/)).toBeTruthy();
    expect((m.q.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement).value).toBe('2');
  });

  it('a change that fails after the popover closed is reported through a toast', async () => {
    let fail!: (e: Error) => void;
    const m = mountUi();
    m.host.update.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { dialog } = open(m);
    fireEvent.change(m.q.getByRole('combobox', { name: 'Priority' }), { target: { value: '4' } });
    await vi.waitFor(() => expect(m.host.update).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(m.q.queryByRole('dialog')).toBeNull();
    await act(async () => fail(new Error('No connection')));
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

  it('waits for a change that is still being written before it deletes', async () => {
    const m = mountUi();
    let finish!: () => void;
    m.host.update.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(makeHighlight({ priority: 5 }));
        }),
    );
    open(m);
    fireEvent.change(m.q.getByRole('combobox', { name: 'Priority' }), { target: { value: '5' } });
    act(() => {
      fireEvent.click(m.q.getByRole('button', { name: 'Delete' }));
    });
    await act(async () => undefined);
    expect(m.host.remove).not.toHaveBeenCalled();

    await act(async () => finish());
    await vi.waitFor(() => expect(m.host.remove).toHaveBeenCalledTimes(1));
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
