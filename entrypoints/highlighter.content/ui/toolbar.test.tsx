import { act, createEvent, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLOR_SWATCH,
  DEFAULT_PALETTE,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  StudyVaultError,
  defaultSettings,
} from '@shared';
import {
  BIOLOGY,
  INBOX,
  cleanupUi,
  makeHighlight,
  makeResult,
  mountUi,
  pressFocusShortcut,
  rect,
  typeInto,
} from './testHarness';

const SELECTION = { text: 'Mitochondria are the powerhouse', rect: rect(100, 200, 120, 20) };

function show(ui: ReturnType<typeof mountUi>['ui'], selection = SELECTION): void {
  act(() => ui.showToolbar(selection));
}

afterEach(() => {
  cleanupUi();
  vi.useRealTimers();
});

describe('toolbar rendering', () => {
  it('is a labelled toolbar with Save, one button per kind, Note and More', () => {
    const { ui, q } = mountUi();
    show(ui);
    const toolbar = q.getByRole('toolbar', { name: /StudyVault/ });
    expect(toolbar).toBeTruthy();
    expect(q.getByRole('button', { name: 'Save selection' })).toBeTruthy();
    for (const kind of HIGHLIGHT_KINDS) {
      expect(q.getByRole('button', { name: `Save as ${KIND_LABELS[kind].label}` })).toBeTruthy();
    }
    expect(q.getByRole('button', { name: 'Add a note' })).toBeTruthy();
    expect(q.getByRole('button', { name: 'More options' })).toBeTruthy();
    expect(q.getAllByRole('button')).toHaveLength(HIGHLIGHT_KINDS.length + 3);
  });

  it('shows the glyph for every kind so colour is never the only cue', () => {
    const { ui, q } = mountUi();
    show(ui);
    for (const kind of HIGHLIGHT_KINDS) {
      const button = q.getByRole('button', { name: `Save as ${KIND_LABELS[kind].label}` });
      expect(button.textContent).toContain(KIND_LABELS[kind].glyph);
    }
  });

  it('paints each kind swatch from the settings palette', () => {
    const settings = defaultSettings();
    settings.palette = { ...DEFAULT_PALETTE, essential: 'green', question: 'purple' };
    const { ui, q } = mountUi({ settings });
    show(ui);
    const probe = document.createElement('i');
    const solid = (color: keyof typeof COLOR_SWATCH): string => {
      probe.style.background = COLOR_SWATCH[color].solid;
      return probe.style.background;
    };
    const swatchOf = (kind: string): string =>
      (
        q
          .getByRole('button', { name: `Save as ${KIND_LABELS[kind as 'essential'].label}` })
          .querySelector('.sv-swatch') as HTMLElement
      ).style.background;
    expect(swatchOf('essential')).toBe(solid('green'));
    expect(swatchOf('question')).toBe(solid('purple'));
    expect(swatchOf('formula')).toBe(solid('blue'));
  });

  it('places the toolbar next to the selection using the pure placement function', () => {
    const { ui, container } = mountUi();
    show(ui, { text: 'abc', rect: rect(100, 200, 50, 20) });
    const unit = container.querySelector('.sv-unit') as HTMLElement;
    // jsdom has no layout (0x0 toolbar): centred on x = 125, above y = 200 - 8.
    expect(unit.style.transform).toBe('translate(125px, 192px)');
    expect(unit.dataset.placement).toBe('above');
    show(ui, { text: 'abc', rect: rect(300, 400, 50, 20) });
    expect(unit.style.transform).toBe('translate(325px, 392px)');
  });

  it('hideToolbar removes it', () => {
    const { ui, q } = mountUi();
    show(ui);
    act(() => ui.hideToolbar());
    expect(q.queryByRole('toolbar')).toBeNull();
  });
});

describe('page selection protection', () => {
  it('prevents the default action of pointerdown and mousedown on every button', () => {
    const { ui, q } = mountUi();
    show(ui);
    for (const button of q.getAllByRole('button')) {
      for (const type of ['pointerDown', 'mouseDown'] as const) {
        const event = createEvent[type](button);
        fireEvent(button, event);
        expect(event.defaultPrevented, `${type} on ${button.getAttribute('aria-label')}`).toBe(
          true,
        );
      }
    }
  });

  it('lets text fields take the press so the caret and typing work', async () => {
    const { ui, q } = mountUi();
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Add a note' }));
    const field = q.getByRole('textbox');
    const event = createEvent.mouseDown(field);
    fireEvent(field, event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not move focus into the overlay when the toolbar appears', () => {
    const page = document.createElement('button');
    document.body.append(page);
    page.focus();
    const { ui } = mountUi();
    show(ui);
    expect(document.activeElement).toBe(page);
  });
});

describe('saving', () => {
  it('Save quick-saves with the default kind into the last-used bank', async () => {
    const settings = { ...defaultSettings(), defaultKind: 'formula' as const };
    const { ui, host, q } = mountUi({ settings });
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));
    expect(host.save).toHaveBeenCalledWith({
      kind: 'formula',
      color: settings.palette.formula,
      bankId: null,
      comment: '',
      priority: 3,
    });
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(host.dismissSelection).toHaveBeenCalledTimes(1);
    expect(q.queryByRole('toolbar')).toBeNull();
  });

  it('a kind button saves immediately with that kind and its palette colour', async () => {
    const settings = defaultSettings();
    settings.palette = { ...DEFAULT_PALETTE, exception: 'teal' };
    const { ui, host, q } = mountUi({ settings });
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save as Exception' }));
    expect(host.save).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exception', color: 'teal', bankId: null }),
    );
  });

  it('announces success in a polite live region', async () => {
    const { ui, host, q } = mountUi();
    host.save.mockResolvedValueOnce(makeResult({ bank: BIOLOGY }));
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));
    const text = await q.findByText('Saved to Biology');
    expect(text.closest('[aria-live="polite"]')).toBeTruthy();
  });

  it('offers Undo for a created highlight and soft-deletes it through the host', async () => {
    const { ui, host, q } = mountUi();
    host.save.mockResolvedValueOnce(
      makeResult({ highlight: makeHighlight({ id: 'hl-new00001' }) }),
    );
    show(ui);
    const user = userEvent.setup();
    await user.click(q.getByRole('button', { name: 'Save selection' }));
    await user.click(await q.findByRole('button', { name: 'Undo' }));
    expect(host.undo).toHaveBeenCalledWith('hl-new00001');
    expect(await q.findByText('Save undone')).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a duplicate in the same bank says so and offers no Undo', async () => {
    const { ui, host, q } = mountUi();
    host.save.mockResolvedValueOnce(makeResult({ status: 'duplicate', addedToBank: false }));
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));
    expect(await q.findByText('Already saved in Inbox')).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a duplicate that gained a bank says it was added, without Undo', async () => {
    const { ui, host, q } = mountUi();
    host.save.mockResolvedValueOnce(
      makeResult({ status: 'duplicate', addedToBank: true, bank: BIOLOGY }),
    );
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));
    expect(await q.findByText('Already saved - added to Biology')).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a restored highlight says Restored and can be undone', async () => {
    const { ui, host, q } = mountUi();
    host.save.mockResolvedValueOnce(makeResult({ status: 'restored' }));
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));
    expect(await q.findByText(/^Restored/)).toBeTruthy();
    expect(q.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('on failure shows the real message, keeps the toolbar and allows a retry', async () => {
    const { ui, host, q } = mountUi();
    host.save.mockRejectedValueOnce(new StudyVaultError('quota_exceeded', 'Disk is full.'));
    show(ui);
    const user = userEvent.setup();
    await user.click(q.getByRole('button', { name: 'Save selection' }));
    const alert = await q.findByText('Disk is full.');
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(q.getByRole('toolbar')).toBeTruthy();
    expect(host.dismissSelection).not.toHaveBeenCalled();

    await user.click(q.getByRole('button', { name: 'Save selection' }));
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(host.save).toHaveBeenCalledTimes(2);
  });

  it('does not repeat an error the host already reported', async () => {
    const { ui, host, q } = mountUi();
    host.save.mockImplementationOnce(async () => {
      ui.toast({ text: 'Browser storage is full.', tone: 'error' });
      throw new StudyVaultError('quota_exceeded', 'raw: QuotaExceededError');
    });
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));
    expect(await q.findByText('Browser storage is full.')).toBeTruthy();
    expect(q.queryByText(/QuotaExceededError/)).toBeNull();
    expect(q.getAllByRole('alert')[0]?.textContent).toContain('Browser storage is full.');
  });

  it('ignores a second click while a save is in flight', async () => {
    const { ui, host, q } = mountUi();
    let release: (() => void) | undefined;
    host.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(makeResult());
        }),
    );
    show(ui);
    const user = userEvent.setup();
    const save = q.getByRole('button', { name: 'Save selection' });
    await user.click(save);
    await user.click(save);
    expect(host.save).toHaveBeenCalledTimes(1);
    expect(q.getByRole('toolbar').getAttribute('aria-busy')).toBe('true');
    await act(async () => release?.());
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
  });
});

describe('keyboard', () => {
  it('Alt+Shift+T moves focus into the toolbar and nothing else', () => {
    const { ui, shadow, q, host } = mountUi();
    const page = document.createElement('button');
    page.textContent = 'page';
    document.body.append(page);
    page.focus();
    show(ui);

    const event = pressFocusShortcut();
    expect(event.defaultPrevented).toBe(true);
    expect(shadow.activeElement).toBe(q.getByRole('button', { name: 'Save selection' }));
    expect(host.save).not.toHaveBeenCalled();
    expect(host.dismissSelection).not.toHaveBeenCalled();
  });

  it('Alt+Shift+T is left alone when there is nothing to focus', () => {
    mountUi();
    expect(pressFocusShortcut().defaultPrevented).toBe(false);
  });

  it('keeps a single tab stop and moves it with the arrow, Home and End keys', async () => {
    const { ui, shadow, q } = mountUi();
    show(ui);
    const stops = (): number =>
      q.getAllByRole('button').filter((b) => b.getAttribute('tabindex') === '0').length;
    expect(stops()).toBe(1);

    pressFocusShortcut();
    const user = userEvent.setup();
    const first = q.getByRole('button', { name: 'Save selection' });
    expect(shadow.activeElement).toBe(first);

    await user.keyboard('{ArrowRight}');
    expect(shadow.activeElement).toBe(q.getByRole('button', { name: 'Save as Essential fact' }));
    expect(stops()).toBe(1);
    expect(shadow.activeElement?.getAttribute('tabindex')).toBe('0');

    await user.keyboard('{End}');
    expect(shadow.activeElement).toBe(q.getByRole('button', { name: 'More options' }));
    await user.keyboard('{ArrowRight}');
    expect(shadow.activeElement).toBe(first);
    await user.keyboard('{ArrowLeft}');
    expect(shadow.activeElement).toBe(q.getByRole('button', { name: 'More options' }));
    await user.keyboard('{Home}');
    expect(shadow.activeElement).toBe(first);
  });

  it('Enter and Space activate the focused button', async () => {
    const { ui, host } = mountUi();
    show(ui);
    pressFocusShortcut();
    await userEvent.setup().keyboard('{ArrowRight}{Enter}');
    expect(host.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'essential' }));
  });

  it('Escape dismisses the toolbar and returns focus to the page element', async () => {
    const { ui, host, q } = mountUi();
    const page = document.createElement('button');
    page.textContent = 'page';
    document.body.append(page);
    page.focus();
    show(ui);
    pressFocusShortcut();
    await userEvent.setup().keyboard('{Escape}');
    expect(q.queryByRole('toolbar')).toBeNull();
    expect(document.activeElement).toBe(page);
    expect(host.dismissSelection).toHaveBeenCalledTimes(1);
  });

  it('after a keyboard save, focus returns to the page and the toast stays reachable', async () => {
    const { ui, q } = mountUi();
    const page = document.createElement('button');
    document.body.append(page);
    page.focus();
    show(ui);
    pressFocusShortcut();
    await userEvent.setup().keyboard('{Enter}');
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(document.activeElement).toBe(page);

    pressFocusShortcut();
    expect(document.activeElement).not.toBe(page);
    expect((document.activeElement as HTMLElement).shadowRoot?.activeElement?.textContent).toBe(
      'Undo',
    );
  });
});

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers());

  it('removes an Undo toast after about six seconds', () => {
    const { ui, q } = mountUi();
    act(() =>
      ui.toast({
        text: 'Saved to Inbox',
        tone: 'success',
        action: { label: 'Undo', run: vi.fn() },
      }),
    );
    expect(q.getByText('Saved to Inbox')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(5900));
    expect(q.queryByText('Saved to Inbox')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(200));
    expect(q.queryByText('Saved to Inbox')).toBeNull();
  });

  it('keeps a toast while the pointer or focus is on it', () => {
    const { ui, q } = mountUi();
    act(() =>
      ui.toast({
        text: 'Saved to Inbox',
        tone: 'success',
        action: { label: 'Undo', run: vi.fn() },
      }),
    );
    const card = q.getByText('Saved to Inbox').closest('.sv-toast') as HTMLElement;
    fireEvent.mouseEnter(card);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(q.queryByText('Saved to Inbox')).toBeTruthy();
    fireEvent.mouseLeave(card);
    act(() => void vi.advanceTimersByTime(6100));
    expect(q.queryByText('Saved to Inbox')).toBeNull();
  });

  it('runs a host-supplied action once and dismisses the toast', () => {
    const { ui, q } = mountUi();
    const run = vi.fn();
    act(() => ui.toast({ text: 'Could not save', tone: 'error', action: { label: 'Retry', run } }));
    fireEvent.click(q.getByRole('button', { name: 'Retry' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.queryByText('Could not save')).toBeNull();
  });

  it('replaces an identical toast instead of stacking', () => {
    const { ui, q } = mountUi();
    act(() => {
      ui.toast({ text: 'Same', tone: 'info' });
      ui.toast({ text: 'Same', tone: 'info' });
    });
    expect(q.getAllByText('Same')).toHaveLength(1);
  });

  it('Escape on a toast dismisses it', () => {
    const { ui, q } = mountUi();
    act(() => ui.toast({ text: 'Heads up', tone: 'info' }));
    fireEvent.keyDown(q.getByRole('button', { name: 'Dismiss notification' }), { key: 'Escape' });
    expect(q.queryByText('Heads up')).toBeNull();
  });

  it('renders the error tone in an alert region and others in a polite status region', () => {
    const { ui, q } = mountUi();
    act(() => {
      ui.toast({ text: 'Oops', tone: 'error' });
      ui.toast({ text: 'Fine', tone: 'success' });
    });
    expect(q.getByRole('alert').textContent).toContain('Oops');
    const status = q.getAllByRole('status')[0] as HTMLElement;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Fine');
  });
});

describe('selection changes and settings', () => {
  it('a new selection text resets an open composer; the same text keeps it', async () => {
    const { ui, q } = mountUi();
    show(ui);
    const user = userEvent.setup();
    await user.click(q.getByRole('button', { name: 'Add a note' }));
    typeInto(q.getByRole('textbox'), 'draft');

    show(ui, { ...SELECTION, rect: rect(100, 150, 120, 20) }); // scrolled: same text
    expect((q.getByRole('textbox') as HTMLTextAreaElement).value).toBe('draft');

    show(ui, { text: 'something else', rect: rect(100, 150, 120, 20) });
    expect(q.queryByRole('textbox')).toBeNull();
    expect(q.getByRole('toolbar')).toBeTruthy();
  });

  it('applySettings updates theme, density and palette live', () => {
    const { ui, hostEl, q } = mountUi();
    show(ui);
    expect(hostEl.getAttribute('data-theme')).toBe('system');
    const settings = { ...defaultSettings(), theme: 'dark' as const, density: 'compact' as const };
    settings.palette = { ...DEFAULT_PALETTE, formula: 'red' };
    act(() => ui.applySettings(settings));
    expect(hostEl.getAttribute('data-theme')).toBe('dark');
    expect(hostEl.getAttribute('data-density')).toBe('compact');
    const probe = document.createElement('i');
    probe.style.background = COLOR_SWATCH.red.solid;
    const swatch = q
      .getByRole('button', { name: 'Save as Formula' })
      .querySelector('.sv-swatch') as HTMLElement;
    expect(swatch.style.background).toBe(probe.style.background);
  });

  it('destroy removes the tree and every document listener', () => {
    const { ui, container, host } = mountUi();
    show(ui);
    act(() => ui.destroy());
    expect(container.childElementCount).toBe(0);
    expect(pressFocusShortcut().defaultPrevented).toBe(false);
    act(() => ui.toast({ text: 'late', tone: 'info' }));
    expect(container.childElementCount).toBe(0);
    expect(host.save).not.toHaveBeenCalled();
    expect(INBOX.id).toBeTruthy();
  });
});
