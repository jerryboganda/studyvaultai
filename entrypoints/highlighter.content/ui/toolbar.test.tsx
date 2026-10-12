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
  act,
  cleanupUi,
  createEvent,
  fireEvent,
  makeHighlight,
  focusToolbar,
  makeResult,
  mountUi,
  rect,
} from './testHarness';

const SELECTION = { text: 'Mitochondria are the powerhouse', rect: rect(100, 200, 120, 20) };
const NOTE = 'Save and add a note in the side panel';

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
    expect(q.getByRole('button', { name: NOTE })).toBeTruthy();
    expect(q.getByRole('button', { name: 'More options' })).toBeTruthy();
    expect(q.getAllByRole('button')).toHaveLength(HIGHLIGHT_KINDS.length + 3);
  });

  it('does not advertise a key: the Focus toolbar shortcut is remappable', () => {
    const { ui, q } = mountUi();
    show(ui);
    expect(q.getByRole('toolbar').hasAttribute('aria-keyshortcuts')).toBe(false);
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
    // jsdom has no layout (0x0 toolbar): centred on x = 125, above y = 200 - 12 (the gap).
    expect(unit.style.transform).toBe('translate(125px, 188px)');
    expect(unit.dataset.placement).toBe('above');
    show(ui, { text: 'abc', rect: rect(300, 400, 50, 20) });
    expect(unit.style.transform).toBe('translate(325px, 388px)');
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

  it('lets a native select take the press so its list can open', async () => {
    const { ui, q } = mountUi();
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'More options' }));
    const select = q.getByRole('combobox', { name: 'Type' });
    for (const type of ['pointerDown', 'mouseDown'] as const) {
      const event = createEvent[type](select);
      fireEvent(select, event);
      expect(event.defaultPrevented, type).toBe(false);
    }
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

describe('Note (the note itself is typed in the side panel)', () => {
  it('saves first, then opens the side panel on the new highlight', async () => {
    const settings = { ...defaultSettings(), defaultKind: 'formula' as const };
    const { ui, host, q } = mountUi({ settings });
    let release: (() => void) | undefined;
    host.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(makeResult({ highlight: makeHighlight({ id: 'hl-new00001' }) }));
        }),
    );
    show(ui);
    act(() => {
      fireEvent.click(q.getByRole('button', { name: NOTE }));
    });
    // The highlight does not exist yet, so there is nothing to point the panel at.
    expect(host.openInSidePanel).not.toHaveBeenCalled();
    expect(host.save).toHaveBeenCalledWith({
      kind: 'formula',
      color: settings.palette.formula,
      bankId: null,
      comment: '',
      priority: 3,
    });

    await act(async () => release?.());
    expect(await q.findByText('Saved - write your note in the side panel')).toBeTruthy();
    expect(host.openInSidePanel).toHaveBeenCalledTimes(1);
    expect(host.openInSidePanel).toHaveBeenCalledWith('hl-new00001');
    expect(host.dismissSelection).toHaveBeenCalledTimes(1);
    expect(q.queryByRole('toolbar')).toBeNull();
    expect(q.queryByRole('textbox')).toBeNull();
  });

  it('keeps Undo for a new highlight and says so for a duplicate without it', async () => {
    const { ui, host, q } = mountUi();
    show(ui);
    const user = userEvent.setup();
    await user.click(q.getByRole('button', { name: NOTE }));
    await user.click(await q.findByRole('button', { name: 'Undo' }));
    expect(host.undo).toHaveBeenCalledWith('hl-00000001');

    host.save.mockResolvedValueOnce(makeResult({ status: 'duplicate' }));
    show(ui, { text: 'another', rect: rect(100, 200, 120, 20) });
    await user.click(q.getByRole('button', { name: NOTE }));
    expect(await q.findByText('Already saved - write your note in the side panel')).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('says why when the side panel cannot be opened, and keeps the plain saved notice', async () => {
    const { ui, host, q } = mountUi();
    host.openInSidePanel.mockResolvedValue(false);
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: NOTE }));
    expect(await q.findByText(/Could not open the side panel/)).toBeTruthy();
    expect(q.getAllByRole('alert').length).toBeGreaterThan(0);
    // Saved all the same: no claim that the note can be written in a panel that is not there.
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(q.queryByText(/write your note/)).toBeNull();
    expect(q.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(host.dismissSelection).toHaveBeenCalledTimes(1);
  });

  it('survives a host that rejects instead of resolving false', async () => {
    const { ui, host, q } = mountUi();
    host.openInSidePanel.mockRejectedValue(new Error('Extension context invalidated'));
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: NOTE }));
    expect(await q.findByText(/Could not open the side panel/)).toBeTruthy();
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
  });

  it('does not repeat an error the host already reported', async () => {
    const { ui, host, q } = mountUi();
    host.openInSidePanel.mockImplementationOnce(async () => {
      ui.toast({ text: 'The side panel is not available here.', tone: 'error' });
      return false;
    });
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: NOTE }));
    expect(await q.findByText('The side panel is not available here.')).toBeTruthy();
    expect(q.queryByText(/Could not open the side panel/)).toBeNull();
  });

  it('still opens the panel for its own highlight when a newer selection arrived meanwhile', async () => {
    const { ui, host, q } = mountUi();
    let release!: () => void;
    host.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(makeResult({ highlight: makeHighlight({ id: 'hl-first001' }) }));
        }),
    );
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: NOTE }));
    show(ui, { text: 'Ribosomes make protein', rect: rect(100, 300, 120, 20) });
    await act(async () => release());

    expect(await q.findByText('Saved - write your note in the side panel')).toBeTruthy();
    expect(host.openInSidePanel).toHaveBeenCalledWith('hl-first001');
    expect(host.dismissSelection).not.toHaveBeenCalled();
    expect(q.getByRole('toolbar')).toBeTruthy();
  });

  it('keeps the toolbar and the selection when the save failed', async () => {
    const { ui, host, q } = mountUi();
    host.save.mockRejectedValueOnce(new StudyVaultError('quota_exceeded', 'Disk is full.'));
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: NOTE }));
    expect(await q.findByText('Disk is full.')).toBeTruthy();
    // Nothing was saved, so there is no note to write: the panel is not opened.
    expect(host.openInSidePanel).not.toHaveBeenCalled();
    expect(host.dismissSelection).not.toHaveBeenCalled();
    expect(q.getByRole('toolbar')).toBeTruthy();
  });
});

describe('a newer selection while a save is in flight', () => {
  function inFlight(host: ReturnType<typeof mountUi>['host']): () => void {
    let release!: () => void;
    host.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(makeResult());
        }),
    );
    return () => release();
  }

  it('is not dismissed or closed when the earlier save completes', async () => {
    const { ui, host, q } = mountUi();
    const release = inFlight(host);
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));

    show(ui, { text: 'Ribosomes make protein', rect: rect(100, 300, 120, 20) });
    await act(async () => release());

    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(host.dismissSelection).not.toHaveBeenCalled();
    expect(q.getByRole('toolbar')).toBeTruthy();
    expect(q.getByRole('button', { name: 'Save selection' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

  it('keeps the newer selection usable: its own save is dismissed normally', async () => {
    const { ui, host, q } = mountUi();
    const release = inFlight(host);
    show(ui);
    const user = userEvent.setup();
    await user.click(q.getByRole('button', { name: 'Save selection' }));
    show(ui, { text: 'Ribosomes make protein', rect: rect(100, 300, 120, 20) });
    await act(async () => release());
    await q.findByText('Saved to Inbox');

    await user.click(q.getByRole('button', { name: 'Save selection' }));
    expect(host.save).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(host.dismissSelection).toHaveBeenCalledTimes(1));
    expect(q.queryByRole('toolbar')).toBeNull();
  });

  it('does not treat a scroll (same text, new rect) as a different selection', async () => {
    const { ui, host, q } = mountUi();
    const release = inFlight(host);
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));
    show(ui, { ...SELECTION, rect: rect(100, 150, 120, 20) });
    await act(async () => release());

    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(host.dismissSelection).toHaveBeenCalledTimes(1);
    expect(q.queryByRole('toolbar')).toBeNull();
  });

  it('leaves a toolbar that was already hidden alone', async () => {
    const { ui, host, q } = mountUi();
    const release = inFlight(host);
    show(ui);
    await userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));
    act(() => ui.hideToolbar());
    await act(async () => release());

    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(host.dismissSelection).not.toHaveBeenCalled();
  });
});

describe('keyboard', () => {
  it('focusToolbar moves focus into the toolbar and does nothing else', () => {
    const { ui, shadow, q, host } = mountUi();
    const page = document.createElement('button');
    page.textContent = 'page';
    document.body.append(page);
    page.focus();
    show(ui);

    expect(focusToolbar(ui)).toBe(true);
    expect(shadow.activeElement).toBe(q.getByRole('button', { name: 'Save selection' }));
    expect(host.save).not.toHaveBeenCalled();
    expect(host.dismissSelection).not.toHaveBeenCalled();
  });

  it('focusToolbar returns false and leaves focus alone when there is nothing to focus', () => {
    const { ui } = mountUi();
    const page = document.createElement('button');
    document.body.append(page);
    page.focus();
    expect(focusToolbar(ui)).toBe(false);
    expect(document.activeElement).toBe(page);
  });

  it('focusToolbar reports false when focus did not land (surface not visible yet)', () => {
    const { ui, container } = mountUi();
    show(ui);
    const real = HTMLElement.prototype.focus;
    // Chrome ignores focus() on a visibility:hidden element; jsdom does not, so model that.
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (this.closest<HTMLElement>('.sv-unit')?.style.visibility === 'hidden') return;
      real.call(this, options);
    });
    (container.querySelector('.sv-unit') as HTMLElement).style.visibility = 'hidden';
    expect(focusToolbar(ui)).toBe(false);
    vi.restoreAllMocks();
  });

  it('listens for no key: Alt+Shift+T belongs to the browser even while the toolbar shows', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const { ui, host } = mountUi();
    expect(add.mock.calls.filter(([type]) => /^key/.test(String(type)))).toEqual([]);
    show(ui);
    act(() =>
      ui.toast({
        text: 'Saved to Inbox',
        tone: 'success',
        action: { label: 'Undo', run: vi.fn() },
      }),
    );

    const event = createEvent.keyDown(document.body, {
      key: 'T',
      code: 'KeyT',
      altKey: true,
      shiftKey: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(host.save).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it('keeps a single tab stop and moves it with the arrow, Home and End keys', async () => {
    const { ui, shadow, q } = mountUi();
    show(ui);
    const stops = (): number =>
      q.getAllByRole('button').filter((b) => b.getAttribute('tabindex') === '0').length;
    expect(stops()).toBe(1);

    focusToolbar(ui);
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
    focusToolbar(ui);
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
    focusToolbar(ui);
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
    focusToolbar(ui);
    await userEvent.setup().keyboard('{Enter}');
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(document.activeElement).toBe(page);

    expect(focusToolbar(ui)).toBe(true);
    expect(document.activeElement).not.toBe(page);
    expect((document.activeElement as HTMLElement).shadowRoot?.activeElement?.textContent).toBe(
      'Undo',
    );
  });

  it('focusToolbar lands on the newest Undo, and on the toolbar before any toast', () => {
    const { ui, shadow, q } = mountUi();
    const older = vi.fn();
    const newer = vi.fn();
    act(() => {
      ui.toast({ text: 'Saved to Inbox', tone: 'success', action: { label: 'Undo', run: older } });
      ui.toast({
        text: 'Saved to Biology',
        tone: 'success',
        action: { label: 'Undo', run: newer },
      });
    });
    expect(focusToolbar(ui)).toBe(true);
    // Enter on the focused button must undo the latest save, not the first toast on screen.
    fireEvent.click(shadow.activeElement as HTMLElement);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();

    show(ui);
    act(() =>
      ui.toast({ text: 'Saved again', tone: 'success', action: { label: 'Undo', run: vi.fn() } }),
    );
    expect(focusToolbar(ui)).toBe(true);
    expect(shadow.activeElement).toBe(q.getByRole('button', { name: 'Save selection' }));
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

  describe('Undo is reachable by keyboard', () => {
    const undoToast = (ui: ReturnType<typeof mountUi>['ui']): void =>
      act(() =>
        ui.toast({
          text: 'Saved to Inbox',
          tone: 'success',
          action: { label: 'Undo', run: vi.fn() },
        }),
      );

    it('does not time out while keyboard focus is inside it, and starts the clock on leaving', () => {
      const { ui, q } = mountUi();
      undoToast(ui);
      const undo = q.getByRole('button', { name: 'Undo' });
      act(() => undo.focus());
      act(() => void vi.advanceTimersByTime(60_000));
      expect(q.queryByText('Saved to Inbox')).toBeTruthy();

      act(() => undo.blur());
      act(() => void vi.advanceTimersByTime(5900));
      expect(q.queryByText('Saved to Inbox')).toBeTruthy();
      act(() => void vi.advanceTimersByTime(200));
      expect(q.queryByText('Saved to Inbox')).toBeNull();
    });

    it('a pointer that comes and goes does not release a toast that holds keyboard focus', () => {
      const { ui, q } = mountUi();
      undoToast(ui);
      const undo = q.getByRole('button', { name: 'Undo' });
      const card = undo.closest('.sv-toast') as HTMLElement;
      act(() => undo.focus());
      fireEvent.mouseEnter(card);
      fireEvent.mouseLeave(card);
      act(() => void vi.advanceTimersByTime(60_000));
      expect(q.queryByText('Saved to Inbox')).toBeTruthy();
    });

    it('moving focus from Undo to Dismiss is not leaving the toast', () => {
      const { ui, q } = mountUi();
      undoToast(ui);
      act(() => q.getByRole('button', { name: 'Undo' }).focus());
      act(() => q.getByRole('button', { name: 'Dismiss notification' }).focus());
      act(() => void vi.advanceTimersByTime(60_000));
      expect(q.queryByText('Saved to Inbox')).toBeTruthy();
    });

    it('says how to reach the action without naming a key', () => {
      const { ui, q } = mountUi();
      undoToast(ui);
      const hint = q.getByText('Undo: use the Focus toolbar shortcut');
      // Inside the polite region, so it is announced with the toast; not part of the toast text.
      expect(hint.closest('[aria-live="polite"]')).toBeTruthy();
      expect(q.getByText('Saved to Inbox').textContent).toBe('Saved to Inbox');
      expect(hint.textContent).not.toMatch(/Alt|Ctrl|Shift|Cmd|⌘/);

      act(() =>
        ui.toast({
          text: 'Could not save',
          tone: 'error',
          action: { label: 'Retry', run: vi.fn() },
        }),
      );
      expect(q.getByText('Retry: use the Focus toolbar shortcut')).toBeTruthy();
    });

    it('a toast without an action has no hint', () => {
      const { ui, q } = mountUi();
      act(() => ui.toast({ text: 'Save undone', tone: 'info' }));
      expect(q.queryByText(/Focus toolbar shortcut/)).toBeNull();
    });

    it('keeps the 6 s default for a pointer save and allows 15 s after a keyboard save', async () => {
      const { ui, host, q } = mountUi();
      show(ui);
      // Pointer: the press never focuses an overlay button, so nothing is focused inside.
      await act(async () => {
        fireEvent.click(q.getByRole('button', { name: 'Save selection' }));
      });
      expect(q.getByText('Saved to Inbox')).toBeTruthy();
      act(() => void vi.advanceTimersByTime(6100));
      expect(q.queryByText('Saved to Inbox')).toBeNull();

      // Keyboard: focus is on the toolbar button when it is activated.
      show(ui, { text: 'Ribosomes make protein', rect: rect(100, 300, 120, 20) });
      focusToolbar(ui);
      await act(async () => {
        fireEvent.click(q.getByRole('button', { name: 'Save selection' }));
      });
      expect(host.save).toHaveBeenCalledTimes(2);
      expect(q.getByText('Saved to Inbox')).toBeTruthy();
      act(() => void vi.advanceTimersByTime(14_900));
      expect(q.queryByText('Saved to Inbox')).toBeTruthy();
      act(() => void vi.advanceTimersByTime(200));
      expect(q.queryByText('Saved to Inbox')).toBeNull();
    });
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
  it('a new selection text resets an open panel; the same text keeps it', async () => {
    const { ui, q } = mountUi();
    show(ui);
    const user = userEvent.setup();
    await user.click(q.getByRole('button', { name: 'More options' }));
    fireEvent.change(q.getByRole('combobox', { name: 'Priority' }), { target: { value: '5' } });

    show(ui, { ...SELECTION, rect: rect(100, 150, 120, 20) }); // scrolled: same text
    expect((q.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement).value).toBe('5');

    show(ui, { text: 'something else', rect: rect(100, 150, 120, 20) });
    expect(q.queryByRole('dialog')).toBeNull();
    expect(q.getByRole('toolbar')).toBeTruthy();
  });

  it('applySettings updates theme, density and palette live, inside the shadow root', () => {
    const { ui, hostEl, container, q } = mountUi();
    show(ui);
    const root = container.querySelector('.sv-root') as HTMLElement;
    expect(root.getAttribute('data-theme')).toBe('system');
    const settings = { ...defaultSettings(), theme: 'dark' as const, density: 'compact' as const };
    settings.palette = { ...DEFAULT_PALETTE, formula: 'red' };
    act(() => ui.applySettings(settings));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-density')).toBe('compact');
    // The host is visible to page scripts: it carries the marker and nothing the user chose.
    expect(hostEl.getAttributeNames()).toEqual(['data-studyvault']);
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
    expect(ui.focusToolbar()).toBe(false);
    act(() => ui.announce('late'));
    act(() => ui.toast({ text: 'late', tone: 'info' }));
    expect(container.childElementCount).toBe(0);
    expect(host.save).not.toHaveBeenCalled();
    expect(INBOX.id).toBeTruthy();
  });
});

describe('caption row: the full name of the hovered or focused button', () => {
  const caption = (container: HTMLElement): HTMLElement =>
    container.querySelector('.sv-caption') as HTMLElement;

  it('is in the unit, outside the toolbar and hidden from assistive technology', () => {
    const { ui, container } = mountUi();
    show(ui);
    const row = caption(container);
    expect(row.closest('.sv-unit')).toBeTruthy();
    expect(row.closest('[role="toolbar"]')).toBeNull();
    // The accessible name is on the button; reading the row as well would say everything twice.
    expect(row.getAttribute('aria-hidden')).toBe('true');
  });

  it('is laid out while empty, so showing a name does not resize or move the unit', () => {
    const { ui, container, q } = mountUi();
    show(ui);
    const unit = container.querySelector('.sv-unit') as HTMLElement;
    const before = unit.style.transform;
    expect(caption(container).hasAttribute('data-empty')).toBe(true);
    // A no-break space keeps the line box, which is what reserves the height.
    expect(caption(container).textContent).toBe(' ');

    act(() => q.getByRole('button', { name: 'Save as Essential fact' }).focus());
    expect(caption(container).textContent).toBe('Save as Essential fact');
    expect(caption(container).hasAttribute('data-empty')).toBe(false);
    expect(unit.style.transform).toBe(before);
    expect(unit.dataset.placement).toBe('above');
  });

  it('names a button on focus, keeps title and aria-label, and clears on blur', () => {
    const { ui, container, q } = mountUi();
    show(ui);
    const kind = q.getByRole('button', { name: 'Save as Question' });
    expect(kind.getAttribute('title')).toBe('Save as Question');
    act(() => kind.focus());
    expect(caption(container).textContent).toBe('Save as Question');
    act(() => kind.blur());
    expect(caption(container).hasAttribute('data-empty')).toBe(true);
  });

  it('names a button on hover; hover wins over focus and focus shows again afterwards', () => {
    const { ui, container, q } = mountUi();
    show(ui);
    const saved = q.getByRole('button', { name: 'Save selection' });
    const kind = q.getByRole('button', { name: 'Save as Formula' });
    act(() => saved.focus());
    fireEvent.mouseEnter(kind);
    expect(caption(container).textContent).toBe('Save as Formula');
    fireEvent.mouseLeave(kind);
    expect(caption(container).textContent).toBe('Save selection');
  });

  it('follows the arrow keys', async () => {
    const { ui, container } = mountUi();
    show(ui);
    focusToolbar(ui);
    await userEvent.setup().keyboard('{ArrowRight}');
    expect(caption(container).textContent).toBe('Save as Essential fact');
  });

  it('is plain text, whatever the name', () => {
    const { ui, container } = mountUi();
    show(ui);
    expect(caption(container).children).toHaveLength(0);
  });
});

describe('announce: a silent live region, separate from the toasts', () => {
  const region = (container: HTMLElement): HTMLElement =>
    container.querySelector('[data-sv-announcer]') as HTMLElement;

  it('exists from the start, is polite and visually hidden', () => {
    const { container } = mountUi();
    const r = region(container);
    expect(r.getAttribute('aria-live')).toBe('polite');
    expect(r.className).toBe('sv-sr');
    expect(r.textContent).toBe('');
  });

  it('puts the text in the region and no toast on screen', () => {
    const { ui, container, q } = mountUi();
    act(() => ui.announce('Highlight 2 of 5, Essential fact: "Mitochondria"'));
    expect(region(container).textContent).toBe('Highlight 2 of 5, Essential fact: "Mitochondria"');
    expect(container.querySelector('.sv-toast')).toBeNull();
    // The toast regions stay the only role=status / role=alert in the tree.
    expect(q.getAllByRole('status')).toHaveLength(1);
    expect(q.getAllByRole('alert')).toHaveLength(1);
  });

  it('renders markup in the text as text', () => {
    const { ui, container } = mountUi();
    const markup = '<img src=x onerror="window.__svXss = 5">';
    act(() => ui.announce(markup));
    expect(region(container).querySelector('img')).toBeNull();
    expect(region(container).textContent).toBe(markup);
  });

  it('replaces the message node so an identical text is announced again', () => {
    const { ui, container } = mountUi();
    act(() => ui.announce('Highlight 1 of 2'));
    const first = region(container).firstElementChild;
    act(() => ui.announce('Highlight 1 of 2'));
    const second = region(container).firstElementChild;
    expect(second?.textContent).toBe('Highlight 1 of 2');
    expect(second).not.toBe(first);
    expect(first?.isConnected).toBe(false);
    expect(region(container).childElementCount).toBe(1);
  });

  it('ignores empty text and clears itself so it does not linger', () => {
    vi.useFakeTimers();
    const { ui, container } = mountUi();
    act(() => ui.announce('   '));
    expect(region(container).textContent).toBe('');
    act(() => ui.announce('Highlight 1 of 2'));
    act(() => void vi.advanceTimersByTime(8100));
    expect(region(container).textContent).toBe('');
  });

  it('a new announcement postpones the clearing of the previous one', () => {
    vi.useFakeTimers();
    const { ui, container } = mountUi();
    act(() => ui.announce('one'));
    act(() => void vi.advanceTimersByTime(5000));
    act(() => ui.announce('two'));
    act(() => void vi.advanceTimersByTime(5000));
    expect(region(container).textContent).toBe('two');
  });
});
