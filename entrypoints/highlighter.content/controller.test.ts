import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyVaultError, type CaptureResult } from '@shared';
import { bootOnce } from './boot';
import {
  FakeBackground,
  clearSelection,
  emulateUserModify,
  flushPromises,
  newId,
  select,
  setBody,
  startHarness,
  storedHighlight,
  type Harness,
  type HarnessOptions,
} from './testUtils';

const ARTICLE =
  '<article><h2>Cell biology</h2>' +
  '<p>The mitochondria is the powerhouse of the cell and makes ATP for energy.</p>' +
  '<p>Ribosomes build proteins from amino acids inside the cytoplasm.</p>' +
  '<a id="lnk" href="#x">link text inside the page</a></article>';

const MITO = 'mitochondria is the powerhouse of the cell';
const RIBO = 'Ribosomes build proteins from amino acids';

const harnesses: Harness[] = [];

async function boot(opts: HarnessOptions = {}): Promise<Harness> {
  const h = startHarness(opts);
  harnesses.push(h);
  await h.controller.ready;
  await flushPromises();
  return h;
}

/** A page selection plus the events a browser would deliver, then the debounce. */
async function selectText(needle: string, occurrence = 0): Promise<Range> {
  const range = select(needle, occurrence);
  document.dispatchEvent(new Event('selectionchange'));
  await vi.advanceTimersByTimeAsync(80);
  return range;
}

type ClickLike = {
  isTrusted: boolean;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  clientX: number;
  clientY: number;
  composedPath: () => EventTarget[];
  preventDefault: () => void;
  stopPropagation: () => void;
  stopImmediatePropagation: () => void;
};

/**
 * jsdom marks every script-dispatched event untrusted and the flag cannot be forged, so a "real
 * user click" is delivered by calling the controller's capture-phase listener directly.
 */
function clickDriver(listenerSpy: { mock: { calls: unknown[][] } }) {
  const call = listenerSpy.mock.calls.find((c) => c[0] === 'click');
  const listener = call?.[1] as (e: unknown) => void;
  const options = call?.[2] as AddEventListenerOptions | undefined;
  const spies = {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
  const click = (target: Element, init: Partial<ClickLike> = {}): typeof spies => {
    const event: ClickLike = {
      isTrusted: true,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      clientX: 10,
      clientY: 12,
      composedPath: () => {
        const path: EventTarget[] = [];
        for (let n: Node | null = target; n; n = n.parentNode) path.push(n);
        return path;
      },
      ...spies,
      ...init,
    };
    listener(event);
    return spies;
  };
  return { click, options, spies };
}

/** Same boundary points: the page selection is still the range the test made. */
function sameRangeText(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

const saveRequest = {
  kind: 'essential',
  color: 'amber',
  bankId: null,
  comment: '',
  priority: 3,
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  setBody(ARTICLE);
});

afterEach(() => {
  for (const h of harnesses.splice(0)) h.controller.destroy();
  clearSelection();
  vi.useRealTimers();
  setBody('');
  history.replaceState({}, '', '/');
  document.head.innerHTML = '';
  delete (window as { navigation?: unknown }).navigation;
});

describe('boot and page policy', () => {
  it('mounts the overlay, rehydrates stored highlights and answers ping', async () => {
    const background = new FakeBackground();
    const stored = storedHighlight(MITO);
    background.rows.set(stored.id, stored);
    const h = await boot({ background });

    expect(h.uiCreated).toBe(1);
    expect(h.painter.ids).toEqual([stored.id]);
    expect(h.painter.texts).toEqual([MITO]);
    expect(await h.handlers['content.ping']!({}, {} as never)).toEqual({
      ready: true,
      version: '9.9.9',
    });
  });

  it('a denied host mounts nothing but still answers ping and pageStatus', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const h = await boot({ settings: { denyList: ['localhost'] } });
    select(MITO);

    expect(h.uiCreated).toBe(0);
    expect(h.painters).toHaveLength(0);
    expect(h.background.calls).toEqual([]);
    expect(add.mock.calls.map((c) => c[0])).not.toContain('selectionchange');

    expect(await h.handlers['content.ping']!({}, {} as never)).toMatchObject({ ready: true });
    const status = await h.handlers['content.pageStatus']!({}, {} as never);
    expect(status.blocked).toBe('denied-site');
    expect(status.hasSelection).toBe(false);
    expect(status.counts.total).toBe(0);
    expect(
      await h.handlers['content.captureSelection']!(
        { method: 'shortcut', bankId: null },
        {} as never,
      ),
    ).toMatchObject({ status: 'blocked' });
    expect(await h.handlers['content.refresh']!({}, {} as never)).toEqual({ ok: true });
    expect(await h.handlers['content.reveal']!({ id: 'hl-00000001' }, {} as never)).toEqual({
      found: false,
    });
  });

  it('a subdomain of a denied host is denied too', async () => {
    const h = await boot({ settings: { denyList: ['localhost'] } });
    expect(h.uiCreated).toBe(0);
  });

  it('an unsupported scheme mounts nothing and refuses to describe the page', async () => {
    const fakeWin = new Proxy(window, {
      get(target, prop) {
        if (prop === 'location') return { href: 'chrome://settings/', hostname: 'settings' };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }) as Window & typeof globalThis;
    const h = await boot({ win: fakeWin });

    expect(h.uiCreated).toBe(0);
    expect(h.painters).toHaveLength(0);
    await expect(h.handlers['content.pageStatus']!({}, {} as never)).rejects.toMatchObject({
      code: 'unsupported_page',
    });
    expect(await h.handlers['content.ping']!({}, {} as never)).toMatchObject({ ready: true });
    expect(
      await h.handlers['content.captureSelection']!(
        { method: 'shortcut', bankId: null },
        {} as never,
      ),
    ).toMatchObject({ status: 'blocked' });
  });

  it('turning a site on the deny list unmounts live; removing it mounts again', async () => {
    const background = new FakeBackground();
    const stored = storedHighlight(MITO);
    background.rows.set(stored.id, stored);
    const h = await boot({ background });
    expect(h.painter.ids).toEqual([stored.id]);
    const first = h.painter;

    h.setSettings({ denyList: ['localhost'] });
    await flushPromises();
    expect(first.destroyed).toBe(true);
    expect(h.ui.destroyed).toBe(true);
    expect(background.epochListeners.size).toBe(0);

    h.setSettings({ denyList: [] });
    await flushPromises();
    expect(h.uiCreated).toBe(2);
    expect(h.painter).not.toBe(first);
    expect(h.painter.ids).toEqual([stored.id]);
  });

  it('keeps working without the overlay when it fails to start', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const background = new FakeBackground();
    const stored = storedHighlight(MITO);
    background.rows.set(stored.id, stored);
    const h = await boot({ background, uiFails: true });
    expect(h.painter.ids).toEqual([stored.id]);
    const result = await h.handlers['content.captureSelection']!(
      { method: 'shortcut', bankId: null },
      {} as never,
    );
    expect(result).toEqual({ status: 'no-selection' });
  });

  it('two executions in one world run one controller', async () => {
    const world = {};
    const made: Harness[] = [];
    const start = () => {
      const h = startHarness();
      made.push(h);
      harnesses.push(h);
      return h.controller;
    };
    const ctxA = startHarness();
    harnesses.push(ctxA);
    bootOnce(world, ctxA.ctx, start);
    bootOnce(world, ctxA.ctx, start);
    expect(made).toHaveLength(1);
    await made[0]!.controller.ready;
    expect(made[0]!.uiCreated).toBe(1);
  });
});

describe('selection watcher', () => {
  it('shows the toolbar after the debounce for an eligible selection', async () => {
    const h = await boot();
    select(MITO);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(30);
    expect(h.ui.toolbar).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(h.ui.toolbar).toHaveLength(1);
    expect(h.ui.toolbar[0]!.text).toBe(MITO);
  });

  it('does not show the toolbar when it is disabled in settings', async () => {
    const h = await boot({ settings: { toolbarEnabled: false } });
    await selectText(MITO);
    expect(h.ui.toolbar).toHaveLength(0);
  });

  it('hides the toolbar when the selection collapses', async () => {
    const h = await boot();
    await selectText(MITO);
    expect(h.ui.toolbar).toHaveLength(1);
    clearSelection();
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(80);
    expect(h.ui.hidden).toBe(1);
  });

  it('does not re-show the toolbar for the same selection', async () => {
    const h = await boot();
    await selectText(MITO);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(80);
    expect(h.ui.toolbar).toHaveLength(1);
  });

  it.each([
    ['textarea', '<textarea id="f">typing words here please</textarea>'],
    ['text input', '<input id="f" type="text" value="typing words here please">'],
    ['password input', '<input id="f" type="password" value="hunter2 hunter2">'],
  ])('ignores a selection made in a %s', async (_name, field) => {
    const h = await boot();
    setBody(ARTICLE + field);
    const el = document.getElementById('f') as HTMLInputElement;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('h2')!);
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(80);
    expect(h.ui.toolbar).toHaveLength(0);
  });

  it('ignores a selection inside a contenteditable region', async () => {
    const h = await boot();
    setBody('<div contenteditable="true"><p>Editable words that the user is typing now</p></div>');
    await selectText('Editable words that');
    expect(h.ui.toolbar).toHaveLength(0);
  });

  it('never shows the toolbar for a selection that passes through an editor', async () => {
    const h = await boot();
    setBody(
      '<p id="a">Public text before the editor.</p>' +
        '<div contenteditable="true">PRIVATE-DRAFT: text the user is still typing.</div>' +
        '<p id="b">Public text after the editor.</p>',
    );
    const range = document.createRange();
    range.setStart(document.getElementById('a')!.firstChild!, 0);
    range.setEnd(document.getElementById('b')!.firstChild!, 11);
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(80);
    expect(h.ui.toolbar).toHaveLength(0);

    document.getSelection()!.selectAllChildren(document.body); // Select All
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(80);
    expect(h.ui.toolbar).toHaveLength(0);
    await expect(h.host.save(saveRequest)).rejects.toThrow(); // nothing stored to save
    expect(h.background.callsOf('capture.save')).toHaveLength(0);
  });

  it('ignores a selection that is inside the StudyVault overlay', async () => {
    const h = await boot();
    setBody(ARTICLE + '<div data-studyvault><p>Overlay words are never captured</p></div>');
    await selectText('Overlay words are never');
    expect(h.ui.toolbar).toHaveLength(0);
  });

  it('waits for the pointer to be released before showing the toolbar', async () => {
    const h = await boot();
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    select(MITO);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(200);
    expect(h.ui.toolbar).toHaveLength(0); // still dragging

    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(h.ui.toolbar).toHaveLength(1); // finalised immediately, no debounce
  });

  it('repositions on scroll and resize, once per frame', async () => {
    const h = await boot();
    await selectText(MITO);
    expect(h.ui.toolbar).toHaveLength(1);

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(40);
    expect(h.ui.toolbar).toHaveLength(2);
  });

  it('hides the toolbar when the selected text is removed from the page', async () => {
    const h = await boot();
    await selectText(MITO);
    document.querySelector('article')!.remove();
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(40);
    expect(h.ui.hidden).toBe(1);
  });
});

describe('save pipeline', () => {
  async function toolbarShown(h: Harness, needle = MITO): Promise<Range> {
    const range = await selectText(needle);
    expect(h.ui.toolbar.at(-1)?.text).toBe(needle);
    return range;
  }

  it('saves the selection with provenance and paints it', async () => {
    document.head.innerHTML = '<link rel="canonical" href="/notes/cells">';
    document.title = 'Cell notes';
    const h = await boot();
    await toolbarShown(h);

    const result = await h.host.save({
      ...saveRequest,
      kind: 'formula',
      color: 'blue',
      comment: 'review',
    });
    expect(result.status).toBe('created');

    const payload = h.background.callsOf('capture.save')[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      exactQuote: MITO,
      kind: 'formula',
      color: 'blue',
      userComment: 'review',
      priority: 3,
      bankId: null,
      captureMethod: 'toolbar',
      headingContext: 'Cell biology',
      page: {
        url: window.location.href,
        canonicalUrl: `${window.location.origin}/notes/cells`,
        title: 'Cell notes',
      },
    });
    expect((payload.anchorSet as { textQuote: { exact: string } }).textQuote.exact).toBe(MITO);
    expect(h.painter.ids).toEqual([result.highlight.id]);
    expect(h.painter.painted[0]!.color).toBe('blue');
    // Reported as resolved so the side panel shows it as anchored.
    expect(h.background.callsOf('highlight.reportResolution')).toHaveLength(1);
  });

  it('does not store the start of a draft editor that sits right after the quote', async () => {
    const h = await boot();
    setBody(
      '<h2>Comments</h2><p>Public text before the draft editor.</p>' +
        '<div contenteditable="true">PRIVATE-DRAFT: text the user is still typing.</div>',
    );
    await selectText('Public text before the draft editor.');
    const result = await h.host.save(saveRequest);
    expect(result.status).toBe('created');
    const payload = h.background.callsOf('capture.save')[0]!.payload as {
      exactQuote: string;
      anchorSet: { textQuote: { prefix: string; suffix: string } };
    };
    expect(payload.exactQuote).toBe('Public text before the draft editor.');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE-DRAFT');
    expect(payload.anchorSet.textQuote.suffix).toBe('');
    expect(h.painter.texts).toEqual(['Public text before the draft editor.']); // still resolves
  });

  it('saves a triple-clicked paragraph that sits right above an editor, without any of the draft', async () => {
    const h = await boot();
    setBody(
      '<h2>Comments</h2><p id="para">Public text before the draft editor.</p>' +
        '<div id="ed" contenteditable="true">PRIVATE-DRAFT: text the user is still typing.</div>',
    );
    // Chromium: a triple-click ends at offset 0 of the next block, here the editor itself.
    const range = document.createRange();
    range.setStart(document.getElementById('para')!.firstChild!, 0);
    range.setEnd(document.getElementById('ed')!, 0);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(80);
    expect(h.ui.toolbar.at(-1)?.text).toBe('Public text before the draft editor.');

    await h.host.save(saveRequest);
    const payload = h.background.callsOf('capture.save')[0]!.payload as {
      exactQuote: string;
      anchorSet: { textQuote: { exact: string; suffix: string } };
    };
    expect(payload.exactQuote).toBe('Public text before the draft editor.');
    expect(payload.anchorSet.textQuote.suffix).toBe('');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE-DRAFT');
    expect(h.painter.texts).toEqual(['Public text before the draft editor.']);
  });

  describe('a CSS-only editor (-webkit-user-modify: read-write)', () => {
    let restore: () => void;
    beforeEach(() => {
      restore = emulateUserModify();
    });
    afterEach(() => restore());

    it('is never offered the toolbar, and never stores the start of its draft as context', async () => {
      const h = await boot();
      setBody(
        '<p id="a">Public text before the editor.</p>' +
          '<div id="ed" data-user-modify="read-write">PRIVATE-DRAFT: still typing</div>' +
          '<p id="b">Public text after the editor.</p>',
      );
      // Drag across the editor: refused whole.
      const across = document.createRange();
      across.setStart(document.getElementById('a')!.firstChild!, 0);
      across.setEnd(document.getElementById('b')!.firstChild!, 11);
      document.getSelection()!.addRange(across);
      document.dispatchEvent(new Event('selectionchange'));
      await vi.advanceTimersByTimeAsync(80);
      expect(h.ui.toolbar).toHaveLength(0);

      // A selection beside it is fine, but its stored context stops where the draft begins.
      await selectText('Public text before the editor.');
      expect(h.ui.toolbar).toHaveLength(1);
      await h.host.save(saveRequest);
      const payload = h.background.callsOf('capture.save')[0]!.payload;
      expect(JSON.stringify(payload)).not.toContain('PRIVATE-DRAFT');
      expect(
        (payload as { anchorSet: { textQuote: { suffix: string } } }).anchorSet.textQuote.suffix,
      ).toBe('');
    });

    it('is refused by quick-save too', async () => {
      const h = await boot();
      setBody(
        '<p id="a">Public text before the editor.</p>' +
          '<div id="ed" data-user-modify="read-write">PRIVATE-DRAFT: still typing</div>',
      );
      select('PRIVATE-DRAFT: still');
      const out = await h.handlers['content.captureSelection']!(
        { method: 'shortcut', bankId: null },
        {} as never,
      );
      expect(out).toMatchObject({ status: 'blocked' });
      expect(h.background.callsOf('capture.save')).toHaveLength(0);
    });
  });

  it('the selection survives interaction with the overlay (range cloned before focus moves)', async () => {
    const h = await boot();
    await toolbarShown(h);

    // The overlay takes focus; the page selection collapses as a side effect.
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div data-studyvault><textarea id="note"></textarea></div>',
    );
    const note = document.getElementById('note') as HTMLTextAreaElement;
    note.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    note.focus();
    clearSelection();
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(80);

    expect(h.ui.hidden).toBe(0); // toolbar stays: this is not a click on the page
    const result = await h.host.save({ ...saveRequest, comment: 'typed in the composer' });
    expect(result.highlight.exactQuote).toBe(MITO);
    const payload = h.background.callsOf('capture.save')[0]!.payload as { exactQuote: string };
    expect(payload.exactQuote).toBe(MITO);
  });

  it('keeps the selection when focus enters the overlay by keyboard alone', async () => {
    const h = await boot();
    await toolbarShown(h);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div data-studyvault><button id="ob">Save</button></div>',
    );
    (document.getElementById('ob') as HTMLButtonElement).focus(); // Tab, no pointer involved
    clearSelection();
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(80);
    expect(h.ui.hidden).toBe(0);
    expect((await h.host.save(saveRequest)).highlight.exactQuote).toBe(MITO);
  });

  it('a click on the page (outside the overlay) discards the stored selection', async () => {
    const h = await boot();
    await toolbarShown(h);
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    clearSelection();
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(h.ui.hidden).toBe(1);
    await expect(h.host.save(saveRequest)).rejects.toThrow(/Select the text again/);
    expect(h.background.callsOf('capture.save')).toHaveLength(0);
    expect(h.ui.toasts.at(-1)).toMatchObject({ tone: 'error' });
  });

  it('a failed save keeps the quote, tells the user, and a retry succeeds', async () => {
    const h = await boot();
    await toolbarShown(h);
    h.background.failNext('capture.save', new StudyVaultError('storage_unavailable', 'db closed'));

    await expect(h.host.save(saveRequest)).rejects.toThrow();
    const toast = h.ui.toasts.at(-1)!;
    expect(toast.tone).toBe('error');
    expect(toast.text).toMatch(/storage is unavailable/i);
    expect(toast.action?.label).toBe('Retry');
    expect(h.painter.ids).toEqual([]);

    // The selection is still stored: the user can simply press Save again...
    const again = await h.host.save(saveRequest);
    expect(again.highlight.exactQuote).toBe(MITO);
    expect(h.painter.ids).toEqual([again.highlight.id]);
  });

  it('the Retry action saves the original quote even after the selection changed', async () => {
    const h = await boot();
    await toolbarShown(h);
    h.background.failNext('capture.save', new StudyVaultError('unsupported_page', 'no receiver'));
    await expect(h.host.save(saveRequest)).rejects.toThrow();
    const retry = h.ui.toasts.at(-1)!.action!;

    await selectText(RIBO); // the user moves on to another sentence
    retry.run();
    await flushPromises();

    const saves = h.background.callsOf('capture.save');
    expect(saves).toHaveLength(2);
    expect((saves[1]!.payload as { exactQuote: string }).exactQuote).toBe(MITO);
    expect(h.ui.toasts.at(-1)).toMatchObject({ tone: 'success' });
    expect(h.ui.toasts.at(-1)!.text).toMatch(/Saved to Inbox/);
  });

  it('a permission failure is explained and not offered as a retry', async () => {
    const h = await boot();
    await toolbarShown(h);
    h.background.failNext(
      'capture.save',
      new StudyVaultError('forbidden', 'StudyVault is turned off on localhost.'),
    );
    await expect(h.host.save(saveRequest)).rejects.toThrow();
    const toast = h.ui.toasts.at(-1)!;
    expect(toast.text).toBe('StudyVault is turned off on localhost.');
    expect(toast.action).toBeUndefined();
  });

  it('tells the user when the selected text vanished before saving', async () => {
    const h = await boot();
    await toolbarShown(h);
    document.querySelector('article')!.innerHTML = '<p>Entirely different content now.</p>';
    await expect(h.host.save(saveRequest)).rejects.toThrow();
    expect(h.ui.toasts.at(-1)!.text).toMatch(/Select it again|changed on the page/);
    expect(h.background.callsOf('capture.save')).toHaveLength(0);
  });

  it('does not paint a save result that arrives after navigating away', async () => {
    const h = await boot();
    await toolbarShown(h);
    const release = h.background.hold('capture.save');
    const saving = h.host.save(saveRequest);
    await flushPromises();

    history.pushState({}, '', '/another-page');
    document.body.appendChild(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(50);

    release();
    await saving;
    expect(h.painter.ids).toEqual([]);
  });

  describe('a selection made while an earlier save is still in flight', () => {
    async function inFlight(h: Harness) {
      await toolbarShown(h, MITO);
      const release = h.background.hold('capture.save');
      const saving = h.host.save(saveRequest);
      await flushPromises();
      const second = await selectText(RIBO); // the reader moves on (toolbar for the new text)
      expect(h.ui.toolbar.at(-1)?.text).toBe(RIBO);
      return { release, saving, second };
    }

    it('is neither cleared nor un-toolbarred when the earlier save completes', async () => {
      const h = await boot();
      const { release, saving, second } = await inFlight(h);
      const shown = h.ui.toolbar.length;

      release();
      await saving;
      h.host.dismissSelection(); // what the overlay does once the save has resolved
      await flushPromises();

      expect(document.getSelection()!.toString()).toBe(RIBO);
      expect(sameRangeText(document.getSelection()!.getRangeAt(0), second)).toBe(true);
      // The overlay closes its toolbar right after dismissSelection(): the newer one is shown again.
      expect(h.ui.toolbar.length).toBeGreaterThan(shown);
      expect(h.ui.toolbar.at(-1)?.text).toBe(RIBO);
      expect(h.ui.hidden).toBe(0);

      // ...and it is still saveable, as itself.
      const again = await h.host.save(saveRequest);
      expect(again.highlight.exactQuote).toBe(RIBO);
      expect(h.painter.texts.sort()).toEqual([MITO, RIBO].sort());
    });

    it('a dismissSelection after the save has settled dismisses whatever is selected then', async () => {
      const h = await boot();
      const { release, saving } = await inFlight(h);
      release();
      await saving;
      await vi.advanceTimersByTimeAsync(10); // the completion window is over
      h.host.dismissSelection(); // e.g. Escape on the new toolbar
      expect(document.getSelection()!.rangeCount).toBe(0);
      await expect(h.host.save(saveRequest)).rejects.toThrow();
    });

    it('the selection that WAS saved is still cleared and dismissed', async () => {
      const h = await boot();
      await toolbarShown(h, MITO);
      await h.host.save(saveRequest);
      h.host.dismissSelection();
      expect(document.getSelection()!.rangeCount).toBe(0);
      expect(h.ui.toolbar).toHaveLength(1); // nothing re-shown
    });

    it('quick-save completing does not close the toolbar of a newer selection', async () => {
      const h = await boot();
      select(MITO);
      const release = h.background.hold('capture.save');
      const quick = h.handlers['content.captureSelection']!(
        { method: 'shortcut', bankId: null },
        {} as never,
      );
      await flushPromises();
      await selectText(RIBO);
      expect(h.ui.toolbar.at(-1)?.text).toBe(RIBO);

      release();
      await quick;
      expect(document.getSelection()!.toString()).toBe(RIBO);
      expect(h.ui.hidden).toBe(0);
      expect((await h.host.save(saveRequest)).highlight.exactQuote).toBe(RIBO);
    });
  });

  it('dismissSelection clears our stored selection and the page selection', async () => {
    const h = await boot();
    await toolbarShown(h);
    h.host.dismissSelection();
    expect(document.getSelection()!.rangeCount).toBe(0);
    await expect(h.host.save(saveRequest)).rejects.toThrow();
  });

  it('listBanks and createBank go through the background', async () => {
    const h = await boot();
    expect((await h.host.listBanks()).banks.map((b) => b.name)).toEqual(['Inbox']);
    const bank = await h.host.createBank('Anatomy');
    expect(bank.name).toBe('Anatomy');
    expect(h.background.callsOf('bank.create')).toHaveLength(1);
  });
});

describe('editing existing highlights from the page', () => {
  async function withOne() {
    const background = new FakeBackground();
    const stored = storedHighlight(MITO);
    background.rows.set(stored.id, stored);
    const h = await boot({ background });
    return { h, stored, background };
  }

  it('update repaints with the new colour', async () => {
    const { h, stored } = await withOne();
    await h.host.update(stored.id, { color: 'green' });
    expect(h.painter.painted.map((p) => p.color)).toEqual(['green']);
  });

  it('remove un-paints, restore paints it again', async () => {
    const { h, stored } = await withOne();
    await h.host.remove(stored.id);
    expect(h.painter.ids).toEqual([]);
    await h.host.restore(stored.id);
    expect(h.painter.ids).toEqual([stored.id]);
  });

  it('undo of a save is a delete of exactly that highlight', async () => {
    const h = await boot();
    await selectText(RIBO);
    const saved = await h.host.save(saveRequest);
    await h.host.undo(saved.highlight.id);
    expect(h.background.callsOf('highlight.delete')[0]!.payload).toEqual({
      id: saved.highlight.id,
    });
    expect(h.painter.ids).toEqual([]);
  });
});

describe('rehydration', () => {
  it('paints stored highlights and reports their outcome once', async () => {
    const background = new FakeBackground();
    const a = storedHighlight(MITO);
    const b = storedHighlight(RIBO);
    background.rows.set(a.id, a);
    background.rows.set(b.id, b);
    const h = await boot({ background });
    expect(h.painter.ids).toEqual([a.id, b.id].sort());

    const reports = background.callsOf('highlight.reportResolution');
    expect(reports).toHaveLength(1);
    expect((reports[0]!.payload as { items: unknown[] }).items).toHaveLength(2);
  });

  it('never paints ambiguous or orphaned highlights', async () => {
    const background = new FakeBackground();
    const ok = storedHighlight(MITO);
    const lost = storedHighlight(RIBO);
    lost.anchorSet.textQuote.exact = 'a quotation that does not occur anywhere on this page';
    background.rows.set(ok.id, ok);
    background.rows.set(lost.id, lost);
    const h = await boot({ background });
    expect(h.painter.ids).toEqual([ok.id]);
    const status = await h.handlers['content.pageStatus']!({}, {} as never);
    expect(status.counts).toMatchObject({ total: 2, resolved: 1, orphaned: 1 });
  });

  it('report-storm guard: our own report does not cause another report', async () => {
    const background = new FakeBackground();
    const rows = [storedHighlight(MITO), storedHighlight(RIBO)];
    for (const r of rows) background.rows.set(r.id, r);
    const h = await boot({ background });
    expect(background.callsOf('highlight.reportResolution')).toHaveLength(1);
    const fetchesAfterBoot = background.callsOf('page.highlights').length;

    // FakeBackground bumped the data epoch when it stored the report, exactly like production.
    await vi.advanceTimersByTimeAsync(300);
    expect(background.callsOf('page.highlights').length).toBe(fetchesAfterBoot + 1);
    // ...and the re-fetch found nothing new to say, now or later.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(background.callsOf('highlight.reportResolution')).toHaveLength(1);
    expect(background.callsOf('page.highlights').length).toBe(fetchesAfterBoot + 1);
    expect(h.painter.ids).toHaveLength(2);
  });

  it('a save notifies once and settles (no refresh/report loop)', async () => {
    const h = await boot();
    await selectText(MITO);
    await h.host.save(saveRequest);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.background.callsOf('highlight.reportResolution')).toHaveLength(1);
    expect(h.background.callsOf('page.highlights').length).toBeLessThanOrEqual(3);
  });

  it('data changes elsewhere repaint after one debounced refresh', async () => {
    const h = await boot();
    const fetches = h.background.callsOf('page.highlights').length;
    const added = storedHighlight(RIBO);
    h.background.rows.set(added.id, added);
    h.background.bump();
    h.background.bump();
    h.background.bump();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.painter.ids).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.background.callsOf('page.highlights').length).toBe(fetches + 1);
    expect(h.painter.ids).toEqual([added.id]);
  });

  it('content.refresh re-fetches immediately', async () => {
    const h = await boot();
    const added = storedHighlight(RIBO);
    h.background.rows.set(added.id, added);
    expect(await h.handlers['content.refresh']!({}, {} as never)).toEqual({ ok: true });
    expect(h.painter.ids).toEqual([added.id]);
  });

  it('SPA route change (history.pushState, no Navigation API) clears and repaints for the new URL', async () => {
    const background = new FakeBackground();
    const first = storedHighlight(MITO);
    background.rows.set(first.id, first);
    const h = await boot({ background });
    expect(h.painter.ids).toEqual([first.id]);

    // The app swaps the view and pushes a new URL.
    const second = (() => {
      setBody('<main><p>Route two explains osmosis and diffusion across membranes.</p></main>');
      return storedHighlight('osmosis and diffusion across membranes');
    })();
    background.rows.clear();
    background.rows.set(second.id, second);
    history.pushState({}, '', '/route-two');
    document.body.appendChild(document.createElement('span')); // a mutation reaches the observer
    await vi.advanceTimersByTimeAsync(50);
    await flushPromises();

    expect(h.painter.clearCalls).toBeGreaterThanOrEqual(1);
    const lastFetch = background.callsOf('page.highlights').at(-1)!.payload as { url: string };
    expect(lastFetch.url).toBe(`${window.location.origin}/route-two`);
    expect(h.painter.ids).toEqual([second.id]);
  });

  it('uses the Navigation API when it exists', async () => {
    const nav = new EventTarget();
    (window as { navigation?: unknown }).navigation = nav;
    const background = new FakeBackground();
    const h = await boot({ background });
    const fetches = background.callsOf('page.highlights').length;

    history.pushState({}, '', '/via-navigation-api');
    nav.dispatchEvent(new Event('navigatesuccess'));
    await flushPromises();
    expect(background.callsOf('page.highlights').length).toBe(fetches + 1);
    expect(h.painter.clearCalls).toBe(1);
  });

  it('an anchor jump on the same page is not a route change', async () => {
    const background = new FakeBackground();
    const h = await boot({ background });
    const fetches = background.callsOf('page.highlights').length;
    history.pushState({}, '', '/#section-2');
    document.body.appendChild(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(100);
    expect(background.callsOf('page.highlights').length).toBe(fetches);
    expect(h.painter.clearCalls).toBe(0);
  });
});

describe('mutations', () => {
  async function withLazyHighlight() {
    const background = new FakeBackground();
    setBody(
      ARTICLE +
        '<section id="lazy"><p>Lazy section covering enzymes and substrate binding sites.</p></section>',
    );
    const lazy = storedHighlight('section covering enzymes and substrate binding');
    background.rows.set(lazy.id, lazy);
    document.getElementById('lazy')!.remove();
    const h = await boot({ background });
    expect(h.painter.ids).toEqual([]);
    // Let the settled "orphaned" report and the refresh it triggers finish, so tests below only
    // see passes caused by their own mutations.
    await vi.advanceTimersByTimeAsync(3000);
    return { h, lazy, background };
  }

  const addLazy = () =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<section id="lazy"><p>Lazy section covering enzymes and substrate binding sites.</p></section>',
    );

  it('paints a highlight whose text arrives later', async () => {
    const { h, lazy } = await withLazyHighlight();
    addLazy();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.painter.ids).toEqual([lazy.id]);
  });

  it('coalesces a burst of mutations into one pass', async () => {
    const { h } = await withLazyHighlight();
    const before = h.painter.paintCalls;
    for (let i = 0; i < 50; i++) {
      document.body.appendChild(document.createElement('i'));
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(h.painter.paintCalls - before).toBe(1);
  });

  it('retries at a bounded rate however often the page mutates', async () => {
    const { h } = await withLazyHighlight();
    const base = h.painter.paintCalls;

    // A text node is rewritten every 100 ms for 30 s while the highlight stays unresolved.
    const ticker = document.body.appendChild(document.createElement('b'));
    for (let i = 0; i < 300; i++) {
      ticker.textContent = `tick ${i}`;
      await vi.advanceTimersByTimeAsync(100);
    }
    const passes = h.painter.paintCalls - base;
    // About once a second (never starved by the 100 ms mutations), never once per mutation.
    expect(passes).toBeGreaterThanOrEqual(20);
    expect(passes).toBeLessThanOrEqual(31);
  });

  it('paints text that arrives 20 s into a page that mutates every 100 ms, within about 2 s', async () => {
    const { h, lazy } = await withLazyHighlight();
    const ticker = document.body.appendChild(document.createElement('b'));
    const base = h.painter.paintCalls;

    let arrivedAt = -1;
    let paintedAt = -1;
    for (let ms = 0; ms < 25_000; ms += 100) {
      ticker.textContent = `tick ${ms / 100}`;
      if (ms === 20_000) {
        addLazy();
        arrivedAt = ms;
      }
      await vi.advanceTimersByTimeAsync(100);
      if (paintedAt < 0 && h.painter.ids.includes(lazy.id)) paintedAt = ms + 100;
    }
    expect(arrivedAt).toBe(20_000);
    expect(paintedAt).toBeGreaterThan(20_000);
    expect(paintedAt - arrivedAt).toBeLessThanOrEqual(2_000);
    // CPU stays bounded: roughly one pass per second over the 25 s, not one per mutation (250).
    expect(h.painter.paintCalls - base).toBeLessThanOrEqual(27);
  });

  it('a pass refused for spacing still runs later when no further mutation comes', async () => {
    const { h, lazy } = await withLazyHighlight();
    document.body.appendChild(document.createElement('b')).textContent = 'first';
    await vi.advanceTimersByTimeAsync(450); // a pass finds nothing and starts the spacing
    addLazy(); // the text arrives right after it, and the page then goes quiet
    await vi.advanceTimersByTimeAsync(450); // debounce fires: refused as too soon
    expect(h.painter.ids).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.painter.ids).toEqual([lazy.id]);
  });

  it('ignores mutations that come from the StudyVault overlay', async () => {
    const { h } = await withLazyHighlight();
    const host = document.createElement('div');
    host.setAttribute('data-studyvault', '');
    document.body.appendChild(host);
    await vi.advanceTimersByTimeAsync(500);
    const base = h.painter.paintCalls;

    for (let i = 0; i < 20; i++) {
      host.appendChild(document.createElement('span')).textContent = String(i);
      await vi.advanceTimersByTimeAsync(450);
    }
    expect(h.painter.paintCalls).toBe(base);
  });

  it('script, style and head mutations never cause a pass', async () => {
    const { h } = await withLazyHighlight();
    const base = h.painter.paintCalls;
    for (let i = 0; i < 20; i++) {
      document.head.appendChild(document.createElement('style')).textContent = `p{order:${i}}`;
      document.body.appendChild(document.createElement('script'));
      await vi.advanceTimersByTimeAsync(450);
    }
    expect(h.painter.paintCalls).toBe(base);

    addLazy(); // the first real pass is still due at once
    await vi.advanceTimersByTimeAsync(500);
    expect(h.painter.ids).toHaveLength(1);
  });

  it('still observes the page when the body element is replaced', async () => {
    const { h, lazy } = await withLazyHighlight();
    const body = document.createElement('body');
    body.innerHTML =
      ARTICLE +
      '<section><p>Lazy section covering enzymes and substrate binding sites.</p></section>';
    document.documentElement.replaceChild(body, document.body);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.painter.ids).toEqual([lazy.id]);
  });

  it('repaints when the framework replaces the highlighted nodes', async () => {
    const background = new FakeBackground();
    const stored = storedHighlight(MITO);
    background.rows.set(stored.id, stored);
    const h = await boot({ background });
    const first = h.painter.painted[0]!.range;

    document.querySelector('article')!.outerHTML = ARTICLE;
    await vi.advanceTimersByTimeAsync(500);
    expect(h.painter.ids).toEqual([stored.id]);
    const second = h.painter.painted[0]!.range;
    expect(second).not.toBe(first);
    expect(second.startContainer.isConnected).toBe(true);
    expect(second.toString()).toBe(MITO);
  });
});

describe('click on a highlight', () => {
  async function withHighlight() {
    const add = vi.spyOn(document, 'addEventListener');
    const background = new FakeBackground();
    const stored = storedHighlight(MITO);
    background.rows.set(stored.id, stored);
    const h = await boot({ background });
    h.painter.hit = stored.id;
    return { h, stored, driver: clickDriver(add) };
  }

  it('opens the popover and leaves the page click untouched', async () => {
    const { h, stored, driver } = await withHighlight();
    const spies = driver.click(document.getElementById('lnk')!);

    expect(h.ui.popovers).toHaveLength(1);
    expect(h.ui.popovers[0]!.view.id).toBe(stored.id);
    // Observation only: no preventDefault (links keep working), no stopPropagation (page handlers
    // still run), and a passive capture listener cannot cancel anything anyway.
    expect(spies.preventDefault).not.toHaveBeenCalled();
    expect(spies.stopPropagation).not.toHaveBeenCalled();
    expect(spies.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(driver.options).toMatchObject({ capture: true, passive: true });
  });

  it('does nothing when the click is not on a highlight', async () => {
    const { h, driver } = await withHighlight();
    h.painter.hit = null;
    driver.click(document.getElementById('lnk')!);
    expect(h.ui.popovers).toHaveLength(0);
  });

  it('ignores clicks that end a text selection, modified clicks and secondary buttons', async () => {
    const { h, driver } = await withHighlight();
    const link = document.getElementById('lnk')!;
    select(RIBO);
    driver.click(link);
    clearSelection();
    driver.click(link, { ctrlKey: true });
    driver.click(link, { metaKey: true });
    driver.click(link, { shiftKey: true });
    driver.click(link, { altKey: true });
    driver.click(link, { button: 2 });
    expect(h.ui.popovers).toHaveLength(0);
  });

  it('ignores clicks scripted by the page', async () => {
    const { h } = await withHighlight();
    document.getElementById('lnk')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.ui.popovers).toHaveLength(0);
  });

  it('ignores clicks inside the overlay', async () => {
    const { h, driver } = await withHighlight();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div data-studyvault><button id="ob">x</button></div>',
    );
    driver.click(document.getElementById('ob')!);
    expect(h.ui.popovers).toHaveLength(0);
  });

  it('anchors the popover to the highlight, or to the click point when it has no geometry', async () => {
    const { h, driver } = await withHighlight();
    driver.click(document.getElementById('lnk')!, { clientX: 33, clientY: 44 });
    // jsdom has no layout: the range reports a zero rect, which is still a defined anchor.
    expect(h.ui.popovers[0]!.anchor).toBeDefined();
  });
});

describe('openInSidePanel', () => {
  it('sends the request in the same task as the call, then resolves to opened', async () => {
    const h = await boot();
    const id = newId();
    const pending = h.host.openInSidePanel(id);
    // No await in between: the user gesture of the click that got us here must still be live.
    expect(h.background.callsOf('sidepanel.open')).toEqual([
      { type: 'sidepanel.open', payload: { focusHighlightId: id } },
    ]);
    expect(await pending).toBe(true);
    expect(h.ui.toasts).toHaveLength(0);
  });

  it('opens without focusing a highlight', async () => {
    const h = await boot();
    expect(await h.host.openInSidePanel(null)).toBe(true);
    expect(h.background.callsOf('sidepanel.open')[0]!.payload).toEqual({ focusHighlightId: null });
  });

  it('resolves to false and tells the user when the worker could not open it', async () => {
    const h = await boot();
    h.background.sidePanelOpens = false;
    expect(await h.host.openInSidePanel(null)).toBe(false);
    expect(h.ui.toasts.at(-1)).toMatchObject({
      tone: 'error',
      text: expect.stringContaining('side panel'),
    });
  });

  it('never rejects: a lost extension connection becomes false and a reload hint', async () => {
    const h = await boot();
    h.background.failNext('sidepanel.open', new StudyVaultError('no_receiver', 'gone'));
    await expect(h.host.openInSidePanel(newId())).resolves.toBe(false);
    expect(h.ui.toasts.at(-1)).toMatchObject({
      tone: 'error',
      text: expect.stringContaining('Reload this page'),
    });

    h.background.failNext('sidepanel.open', new StudyVaultError('internal', 'boom'));
    await expect(h.host.openInSidePanel(null)).resolves.toBe(false);
    expect(h.ui.toasts.at(-1)).toMatchObject({ tone: 'error' });
  });
});

describe('keyboard route to highlights (Alt+Shift+] next, Alt+Shift+[ previous)', () => {
  const LINK = 'link text inside the page';

  type KeyLike = {
    isTrusted: boolean;
    altKey: boolean;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    repeat: boolean;
    code: string;
    composedPath: () => EventTarget[];
    preventDefault: () => void;
  };

  /** Like clickDriver: jsdom cannot make a trusted keydown, so call the controller's listener. */
  async function withHighlights(opts: HarnessOptions = {}) {
    const add = vi.spyOn(document, 'addEventListener');
    const background = opts.background ?? new FakeBackground();
    const rows = [storedHighlight(MITO), storedHighlight(RIBO), storedHighlight(LINK)];
    for (const r of rows) background.rows.set(r.id, r);
    const h = await boot({ ...opts, background });
    const call = add.mock.calls
      .filter((c) => c[0] === 'keydown' && !(c[2] as { passive?: boolean } | undefined)?.passive)
      .at(-1);
    const listener = call?.[1] as (e: unknown) => void;
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as never;
    const press = (init: Partial<KeyLike> = {}, target: Node = document.body) => {
      const preventDefault = vi.fn();
      const event: KeyLike = {
        isTrusted: true,
        altKey: true,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
        repeat: false,
        code: 'BracketRight',
        composedPath: () => {
          const path: EventTarget[] = [];
          for (let n: Node | null = target; n; n = n.parentNode) path.push(n);
          return path;
        },
        preventDefault,
        ...init,
      };
      listener(event);
      return { preventDefault, options: call?.[2] as AddEventListenerOptions | undefined };
    };
    const ids = rows.map((r) => r.id) as [string, string, string];
    return { h, background, rows, ids, press, scrollBy, listener };
  }

  const shown = (h: Harness): string[] => h.ui.popovers.map((p) => p.view.id);

  afterEach(() => {
    delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  });

  it('steps through the painted highlights in document order, wrapping at both ends', async () => {
    const { h, ids, press, scrollBy } = await withHighlights();
    expect(h.painter.ids).toHaveLength(3);

    const first = press();
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(first.options).toMatchObject({ capture: true });
    expect(first.options?.passive).not.toBe(true); // it must be able to preventDefault
    press();
    press();
    press(); // wraps
    expect(shown(h)).toEqual([ids[0], ids[1], ids[2], ids[0]]);

    press({ code: 'BracketLeft' }); // back from the first: wraps to the last
    press({ code: 'BracketLeft' });
    expect(shown(h).slice(-2)).toEqual([ids[2], ids[1]]);

    // Scrolls instantly (the popover is anchored to the final position) and flashes the highlight.
    expect(scrollBy.mock.calls.at(-1)![0]).toMatchObject({ behavior: 'instant' });
    expect(h.painter.active).toBe(ids[1]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(h.painter.active).toBeNull();
  });

  it('follows document order, not the order they were stored in', async () => {
    const background = new FakeBackground();
    setBody(ARTICLE);
    const late = storedHighlight(LINK);
    const early = storedHighlight(MITO);
    background.rows.set(late.id, late); // inserted first
    background.rows.set(early.id, early);
    const add = vi.spyOn(document, 'addEventListener');
    const h = await boot({ background });
    const listener = add.mock.calls
      .filter((c) => c[0] === 'keydown' && !(c[2] as { passive?: boolean } | undefined)?.passive)
      .at(-1)![1] as (e: unknown) => void;
    window.scrollBy = vi.fn() as never;
    const key = { isTrusted: true, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false };
    listener({
      ...key,
      repeat: false,
      code: 'BracketRight',
      composedPath: () => [],
      preventDefault() {},
    });
    expect(shown(h)).toEqual([early.id]);
  });

  it('starts from the reader position: the first highlight at or below the top of the viewport', async () => {
    const { h, ids, press } = await withHighlights();
    // MITO is above the fold, RIBO just below its top edge, the link further down.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        const text = this.toString();
        const top = text.includes('mitochondria') ? -500 : text.includes('Ribosomes') ? 100 : 900;
        return { top, height: 20, left: 0, width: 50, right: 50, bottom: top + 20 };
      },
    });
    press();
    expect(shown(h)).toEqual([ids[1]]);
  });

  it('previous with nothing reached yet goes to the last highlight above the viewport', async () => {
    const { h, ids, press } = await withHighlights();
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        const text = this.toString();
        const top = text.includes('link text') ? 900 : text.includes('Ribosomes') ? -100 : -500;
        return { top, height: 20, left: 0, width: 50, right: 50, bottom: top + 20 };
      },
    });
    press({ code: 'BracketLeft' });
    expect(shown(h)).toEqual([ids[1]]);
  });

  it('continues from the highlight the reader clicked', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const background = new FakeBackground();
    const rows = [storedHighlight(MITO), storedHighlight(RIBO), storedHighlight(LINK)];
    for (const r of rows) background.rows.set(r.id, r);
    const h = await boot({ background });
    window.scrollBy = vi.fn() as never;
    const click = clickDriver(add);
    h.painter.hit = rows[1]!.id;
    click.click(document.getElementById('lnk')!);
    expect(shown(h)).toEqual([rows[1]!.id]);

    const keydown = add.mock.calls
      .filter((c) => c[0] === 'keydown' && !(c[2] as { passive?: boolean } | undefined)?.passive)
      .at(-1)![1] as (e: unknown) => void;
    keydown({
      isTrusted: true,
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
      code: 'BracketRight',
      composedPath: () => [],
      preventDefault() {},
    });
    expect(shown(h)).toEqual([rows[1]!.id, rows[2]!.id]);
  });

  it('skips a highlight whose text is hidden, and says so when none can be shown', async () => {
    const { h, ids, press, scrollBy } = await withHighlights();
    let hiddenWords: string[] = ['mitochondria'];
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        return hiddenWords.some((w) => this.toString().includes(w))
          ? []
          : [{ width: 80, height: 18 }];
      },
    });
    press(); // MITO is in a closed panel: the next one is shown
    expect(shown(h)).toEqual([ids[1]]);

    hiddenWords = ['mitochondria', 'Ribosomes', 'link text'];
    const before = scrollBy.mock.calls.length;
    const out = press();
    expect(out.preventDefault).toHaveBeenCalledTimes(1);
    expect(shown(h)).toEqual([ids[1]]); // nothing new
    expect(scrollBy.mock.calls.length).toBe(before); // and nothing scrolled
    expect(h.ui.toasts.at(-1)).toMatchObject({ text: 'No visible highlights on this page.' });
  });

  it('announces when the page has no highlights', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const h = await boot();
    const keydown = add.mock.calls
      .filter((c) => c[0] === 'keydown' && !(c[2] as { passive?: boolean } | undefined)?.passive)
      .at(-1)![1] as (e: unknown) => void;
    keydown({
      isTrusted: true,
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
      code: 'BracketLeft',
      composedPath: () => [],
      preventDefault() {},
    });
    expect(h.ui.popovers).toHaveLength(0);
    expect(h.ui.toasts.at(-1)).toMatchObject({
      tone: 'info',
      text: 'No highlights on this page yet.',
    });
  });

  it('ignores other keys, other modifiers, key repeat and scripted events', async () => {
    const { h, press } = await withHighlights();
    for (const init of [
      { code: 'KeyT' },
      { shiftKey: false },
      { altKey: false },
      { ctrlKey: true }, // AltGr on Windows reports Ctrl+Alt
      { metaKey: true },
      { repeat: true },
      { isTrusted: false },
    ] as Array<Partial<KeyLike>>) {
      expect(press(init).preventDefault).not.toHaveBeenCalled();
    }
    expect(h.ui.popovers).toHaveLength(0);
    expect(h.ui.toasts).toHaveLength(0);
  });

  afterEach(() => {
    document.designMode = 'off';
  });

  it('stays out of the way while the user is editing', async () => {
    const { h, press } = await withHighlights();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<input id="f" type="text"><div id="ce" contenteditable="true" tabindex="0">draft</div>',
    );
    const field = document.getElementById('f') as HTMLInputElement;
    field.focus();
    expect(press({}, field).preventDefault).not.toHaveBeenCalled();
    field.blur();
    const editor = document.getElementById('ce')!;
    editor.focus();
    expect(press({}, editor).preventDefault).not.toHaveBeenCalled();
    editor.blur();
    // The target alone is enough (focus may already have moved on when a handler runs).
    expect(press({}, editor).preventDefault).not.toHaveBeenCalled();
    document.designMode = 'on';
    expect(press().preventDefault).not.toHaveBeenCalled();
    document.designMode = 'off';
    expect(h.ui.popovers).toHaveLength(0);
    expect(press().preventDefault).toHaveBeenCalledTimes(1); // and works again afterwards
    expect(h.ui.popovers).toHaveLength(1);
  });

  it('ignores keys pressed inside the overlay (its note field types text)', async () => {
    const { h, press } = await withHighlights();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div data-studyvault><button id="ob">x</button></div>',
    );
    expect(press({}, document.getElementById('ob')!).preventDefault).not.toHaveBeenCalled();
    expect(h.ui.popovers).toHaveLength(0);
  });

  it('does nothing when the overlay did not start, or the extension context is gone', async () => {
    const noUi = await withHighlights({ uiFails: true });
    expect(noUi.press().preventDefault).not.toHaveBeenCalled();
    noUi.h.controller.destroy();

    const gone = await withHighlights();
    gone.h.ctx.isValid = false;
    expect(gone.press().preventDefault).not.toHaveBeenCalled();
    expect(gone.h.ui.popovers).toHaveLength(0);
  });

  it('causes no refresh, no report and no timers beyond the 2 s flash', async () => {
    const { h, background, press } = await withHighlights();
    await vi.advanceTimersByTimeAsync(10_000); // the boot report and its echo have settled
    const timers = vi.getTimerCount();
    const fetches = background.callsOf('page.highlights').length;
    const reports = background.callsOf('highlight.reportResolution').length;
    for (let i = 0; i < 6; i++) press();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(background.callsOf('page.highlights')).toHaveLength(fetches);
    expect(background.callsOf('highlight.reportResolution')).toHaveLength(reports);
    expect(h.painter.active).toBeNull();
    expect(vi.getTimerCount()).toBe(timers); // the 2 s flash timer has run out, nothing else was armed
  });

  it('is detached with the session: nothing is left on the document after destroy', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { h, press, listener } = await withHighlights();
    const added = add.mock.calls.filter((c) => c[1] === listener);
    expect(added).toHaveLength(1);
    h.controller.destroy();
    expect(remove.mock.calls.filter((c) => c[0] === 'keydown' && c[1] === listener)).toHaveLength(
      1,
    );
    expect(h.ui.destroyed).toBe(true);
    // A late event through a retained reference still changes nothing.
    expect(press().preventDefault).not.toHaveBeenCalled();
    expect(h.ui.popovers).toHaveLength(0);
    expect(h.ui.toasts).toHaveLength(0);
  });
});

describe('tab RPC', () => {
  const sender = {} as never;

  it('pageStatus reports counts, identity, painting support and selection', async () => {
    document.head.innerHTML = '<link rel="canonical" href="https://localhost/c">';
    document.title = 'Cells';
    const background = new FakeBackground();
    const a = storedHighlight(MITO);
    background.rows.set(a.id, a);
    const h = await boot({ background });
    h.painter.supported = false;
    select(RIBO);

    const status = await h.handlers['content.pageStatus']!({}, sender);
    expect(status).toMatchObject({
      url: window.location.href,
      canonicalUrl: 'https://localhost/c',
      title: 'Cells',
      paintingSupported: false,
      hasSelection: true,
      blocked: null,
      counts: { total: 1, resolved: 1, changed: 0, ambiguous: 0, orphaned: 0, pending: 0 },
    });
  });

  it('pageStatus says when the toolbar is off', async () => {
    const h = await boot({ settings: { toolbarEnabled: false } });
    expect((await h.handlers['content.pageStatus']!({}, sender)).blocked).toBe('toolbar-disabled');
  });

  it('captureSelection saves the live selection with the shortcut method', async () => {
    const h = await boot({ settings: { defaultKind: 'formula' } });
    select(RIBO);
    const result = (await h.handlers['content.captureSelection']!(
      { method: 'shortcut', bankId: null },
      sender,
    )) as CaptureResult;

    expect(result.status).toBe('created');
    const payload = h.background.callsOf('capture.save')[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      exactQuote: RIBO,
      kind: 'formula',
      color: 'blue',
      captureMethod: 'shortcut',
      bankId: null,
    });
    expect(h.painter.ids).toEqual([result.highlight.id]);
    expect(document.getSelection()!.rangeCount).toBe(0);
    const toast = h.ui.toasts.at(-1)!;
    expect(toast.tone).toBe('success');
    toast.action!.run();
    await flushPromises();
    expect(h.background.callsOf('highlight.delete')).toHaveLength(1);
  });

  it('captureSelection passes the chosen bank and works while the toolbar is disabled', async () => {
    const h = await boot({ settings: { toolbarEnabled: false } });
    select(RIBO);
    await h.handlers['content.captureSelection']!(
      { method: 'context-menu', bankId: 'bank-00000007' },
      sender,
    );
    expect(h.background.callsOf('capture.save')[0]!.payload).toMatchObject({
      bankId: 'bank-00000007',
      captureMethod: 'context-menu',
    });
  });

  it('captureSelection with nothing selected, or in a field, saves nothing', async () => {
    const h = await boot();
    expect(
      await h.handlers['content.captureSelection']!({ method: 'shortcut', bankId: null }, sender),
    ).toEqual({ status: 'no-selection' });

    setBody(ARTICLE + '<textarea id="f">some words typed by the user</textarea>');
    const f = document.getElementById('f') as HTMLTextAreaElement;
    f.focus();
    select(RIBO);
    const blocked = await h.handlers['content.captureSelection']!(
      { method: 'shortcut', bankId: null },
      sender,
    );
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(h.background.callsOf('capture.save')).toHaveLength(0);
  });

  describe('text selected inside a form field (Chromium reports the document selection as collapsed)', () => {
    it.each([
      ['text input', '<input id="f" type="text" value="selectable value inside an input">'],
      ['password input', '<input id="f" type="password" value="hunter2-secret">'],
      ['textarea', '<textarea id="f">text inside a textarea that must not be captured</textarea>'],
    ])(
      'captureSelection from a %s is blocked with an explanation, never "no selection"',
      async (_n, field) => {
        const h = await boot();
        setBody(ARTICLE + field);
        const f = document.getElementById('f') as HTMLInputElement;
        f.focus();
        clearSelection();
        f.setSelectionRange(0, 6);
        const valueRead = vi.spyOn(HTMLInputElement.prototype, 'value', 'get');
        const textRead = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'get');

        const res = await h.handlers['content.captureSelection']!(
          { method: 'shortcut', bankId: null },
          sender,
        );
        expect(res).toMatchObject({
          status: 'blocked',
          reason: expect.stringMatching(/form fields or editors/),
        });
        expect(h.background.callsOf('capture.save')).toHaveLength(0);
        expect(valueRead).not.toHaveBeenCalled(); // a field value is never read
        expect(textRead).not.toHaveBeenCalled();
        expect(JSON.stringify([h.background.calls, h.ui.toasts])).not.toMatch(
          /hunter2|selectable value|text inside a textarea/,
        );
      },
    );

    it('a caret in a field with nothing selected is still "no-selection"', async () => {
      const h = await boot();
      setBody(ARTICLE + '<input id="f" type="text" value="abc def">');
      const f = document.getElementById('f') as HTMLInputElement;
      f.focus();
      f.setSelectionRange(3, 3);
      expect(
        await h.handlers['content.captureSelection']!({ method: 'shortcut', bankId: null }, sender),
      ).toEqual({ status: 'no-selection' });
    });
  });

  it('captureSelection refuses a selection that spans an editor, whole, and stores nothing', async () => {
    const h = await boot();
    setBody(
      '<h1 id="h">Mixed page</h1><p id="a">Public text before the draft editor.</p>' +
        '<div id="draft" contenteditable="true">PRIVATE-DRAFT: text the user is still typing in an editor.</div>' +
        '<p id="b">Public text after the draft editor.</p>',
    );
    const drag = document.createRange();
    drag.setStart(document.getElementById('a')!.firstChild!, 0);
    drag.setEnd(document.getElementById('b')!.firstChild!, 11);
    for (const make of [
      () => document.getSelection()!.addRange(drag),
      () => document.getSelection()!.selectAllChildren(document.body),
    ]) {
      clearSelection();
      make();
      expect(document.getSelection()!.toString()).toContain('PRIVATE-DRAFT'); // engine includes it
      const res = await h.handlers['content.captureSelection']!(
        { method: 'context-menu', bankId: null },
        sender,
      );
      expect(res).toMatchObject({
        status: 'blocked',
        reason: expect.stringMatching(/form fields or editors/),
      });
    }
    expect(h.background.callsOf('capture.save')).toHaveLength(0);
    expect(h.painter.painted).toEqual([]);
  });

  it('captureSelection explains text it cannot read instead of reporting an empty selection', async () => {
    const h = await boot();
    setBody(ARTICLE + '<svg><text id="t">chart label words here</text></svg>');
    select('chart label words');
    const result = await h.handlers['content.captureSelection']!(
      { method: 'shortcut', bankId: null },
      sender,
    );
    expect(result).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/can't read/),
    });
  });

  it('captureSelection surfaces a save failure to the caller and to the user', async () => {
    const h = await boot();
    select(RIBO);
    h.background.failNext('capture.save', new StudyVaultError('quota_exceeded', 'full'));
    await expect(
      h.handlers['content.captureSelection']!({ method: 'shortcut', bankId: null }, sender),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(h.ui.toasts.at(-1)).toMatchObject({ tone: 'error' });
  });

  describe('reveal', () => {
    it('scrolls the highlight to the centre and flashes it for two seconds', async () => {
      const background = new FakeBackground();
      const stored = storedHighlight(MITO);
      background.rows.set(stored.id, stored);
      const h = await boot({ background });
      const scrollBy = vi.fn();
      window.scrollBy = scrollBy as never;
      // jsdom has no layout engine: give ranges a rect 900px down a 600px-high viewport.
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          top: 900,
          height: 20,
          left: 0,
          width: 100,
          right: 100,
          bottom: 920,
          x: 0,
          y: 900,
        }),
      });
      Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

      expect(await h.handlers['content.reveal']!({ id: stored.id }, sender)).toEqual({
        found: true,
      });
      expect(scrollBy).toHaveBeenCalledWith({ top: 900 + 10 - 300, behavior: 'smooth' });
      expect(h.painter.active).toBe(stored.id);
      await vi.advanceTimersByTimeAsync(2100);
      expect(h.painter.active).toBeNull();
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    });

    it('jumps instantly for users who prefer reduced motion', async () => {
      const background = new FakeBackground();
      const stored = storedHighlight(MITO);
      background.rows.set(stored.id, stored);
      const h = await boot({ background });
      const scrollBy = vi.fn();
      window.scrollBy = scrollBy as never;
      window.matchMedia = ((q: string) => ({ matches: q.includes('reduce') })) as never;
      await h.handlers['content.reveal']!({ id: stored.id }, sender);
      expect(scrollBy.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
      delete (window as { matchMedia?: unknown }).matchMedia;
    });

    it('reports found=false for highlights that are not on the page', async () => {
      const background = new FakeBackground();
      const lost = storedHighlight(MITO);
      lost.anchorSet.textQuote.exact = 'a quotation that does not occur anywhere on this page';
      background.rows.set(lost.id, lost);
      const h = await boot({ background });
      expect(await h.handlers['content.reveal']!({ id: lost.id }, sender)).toEqual({
        found: false,
      });
      expect(await h.handlers['content.reveal']!({ id: newId() }, sender)).toEqual({
        found: false,
      });
      expect(h.painter.active).toBeNull();
    });

    it('reports found=false, and moves nothing, for a highlight whose text is hidden', async () => {
      const background = new FakeBackground();
      const stored = storedHighlight(MITO);
      background.rows.set(stored.id, stored);
      const h = await boot({ background });
      const scrollBy = vi.fn();
      window.scrollBy = scrollBy as never;
      const timers = vi.getTimerCount();
      // A display:none panel: the range resolves (hidden text is in the stream) but has no box.
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [],
      });
      try {
        expect(h.painter.ids).toEqual([stored.id]); // resolved, so the old code said found:true
        expect(await h.handlers['content.reveal']!({ id: stored.id }, sender)).toEqual({
          found: false,
        });
        expect(scrollBy).not.toHaveBeenCalled();
        expect(h.painter.active).toBeNull();
        expect(vi.getTimerCount()).toBe(timers); // no flash timer armed
      } finally {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      }
    });

    it('finds a highlight created elsewhere before the data-change refresh arrived', async () => {
      const h = await boot();
      window.scrollBy = vi.fn() as never;
      const fresh = storedHighlight(RIBO);
      h.background.rows.set(fresh.id, fresh);
      expect(await h.handlers['content.reveal']!({ id: fresh.id }, sender)).toEqual({
        found: true,
      });
    });
  });
});

describe('settings', () => {
  it('forwards settings changes to the overlay and hides the toolbar when it is disabled', async () => {
    const h = await boot();
    await selectText(MITO);
    h.setSettings({ toolbarEnabled: false });
    expect(h.ui.applied).toHaveLength(1);
    expect(h.ui.hidden).toBe(1);
    await selectText(RIBO);
    expect(h.ui.toolbar).toHaveLength(1);
  });
});

describe('context invalidation', () => {
  it('removes every listener, observer, timer, painted highlight and UI node', async () => {
    const docAdd = vi.spyOn(document, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    const winAdd = vi.spyOn(window, 'addEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');

    const background = new FakeBackground();
    const stored = storedHighlight(MITO);
    background.rows.set(stored.id, stored);
    const h = await boot({ background });
    await selectText(RIBO);

    const world = {};
    bootOnce(world, h.ctx, () => h.controller);
    h.ctx.invalidate();

    expect(h.ui.destroyed).toBe(true);
    expect(h.painter.destroyed).toBe(true);
    expect(h.served.active).toBe(false);
    expect(background.epochListeners.size).toBe(0);
    expect(disconnect).toHaveBeenCalled();

    const balance = (adds: unknown[][], removes: unknown[][]) => {
      const key = (c: unknown[]) => `${String(c[0])}`;
      const left = new Map<string, number>();
      for (const c of adds) left.set(key(c), (left.get(key(c)) ?? 0) + 1);
      for (const c of removes) left.set(key(c), (left.get(key(c)) ?? 0) - 1);
      return [...left].filter(([, n]) => n > 0);
    };
    // Only listeners added by the controller are in these spies' windows of interest.
    const leakedDoc = balance(docAdd.mock.calls, docRemove.mock.calls).filter(
      ([type]) => !type.startsWith('wxt:'),
    );
    const leakedWin = balance(winAdd.mock.calls, winRemove.mock.calls);
    expect(docAdd.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        'selectionchange',
        'pointerdown',
        'pointerup',
        'click',
        'keyup',
        'keydown',
      ]),
    );
    expect(winAdd.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['scroll', 'resize', 'popstate', 'hashchange']),
    );
    expect(leakedDoc).toEqual([]);
    expect(leakedWin).toEqual([]);

    // Nothing reacts any more.
    const toolbars = h.ui.toolbar.length;
    const calls = background.calls.length;
    await selectText(MITO);
    document.body.appendChild(document.createElement('div'));
    background.bump();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.ui.toolbar.length).toBe(toolbars);
    expect(background.calls.length).toBe(calls);
  });

  it('stops offering the toolbar once the extension context is gone', async () => {
    const h = await boot();
    h.ctx.isValid = false; // extension reloaded under the page; WXT reports it via isValid
    await selectText(MITO);
    expect(h.ui.toolbar).toHaveLength(0);
  });

  it('destroy is idempotent', async () => {
    const h = await boot();
    h.controller.destroy();
    expect(() => h.controller.destroy()).not.toThrow();
  });

  it('an overlay that finishes starting after destroy is torn down immediately', async () => {
    let open!: () => void;
    const uiGate = new Promise<void>((resolve) => (open = resolve));
    const h = startHarness({ uiGate });
    harnesses.push(h);
    await flushPromises();
    expect(h.uiCreated).toBe(1);

    h.controller.destroy();
    open();
    await h.controller.ready;
    await flushPromises();
    expect(h.ui.destroyed).toBe(true);
    expect(h.painters.every((p) => p.destroyed)).toBe(true);
  });
});
