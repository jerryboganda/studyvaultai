import {
  MAX_QUOTE_CHARS,
  StudyVaultError,
  captureBlock,
  defaultSettings,
  type CaptureInput,
  type CaptureMethod,
  type CaptureResult,
  type CaptureSelectionResult,
  type PageStatus,
  type Settings,
  type TabRpc,
} from '@shared';
import { HOST_ATTRIBUTE, HighlightPainter, buildTextStream, captureAnchor } from '@highlights';
import type { Handlers, callBackground } from '@runtime';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { CaptureHost, CaptureUi, CreateCaptureUi, SaveRequest } from './contract';
import {
  inspectSelection,
  isInsideHost,
  rectAt,
  rectOf,
  sameRange,
  withoutEditableContext,
} from './eligibility';
import { canonicalHref, fitUrl, readPageInfo } from './page';
import { Rehydrator, type PageRef, type PainterLike } from './rehydrator';
import { affectsPageText } from './mutations';
import { RouteWatcher } from './routeWatcher';
import { scrollRangeToCenter } from './scroll';
import { debounce, frameThrottle } from './timing';

export interface ControllerDeps {
  ctx: ContentScriptContext;
  win: Window & typeof globalThis;
  /** Manifest version, answered to `content.ping`. */
  version: string;
  call: typeof callBackground;
  /** Registers the TabRpc handlers; returns the unsubscribe function. */
  serve(handlers: Handlers<TabRpc>): () => void;
  getSettings(): Promise<Settings>;
  watchSettings(onChange: (settings: Settings) => void): () => void;
  watchDataEpoch(onChange: () => void): () => void;
  createUi: CreateCaptureUi;
  createPainter?: (doc: Document) => PainterLike;
}

export interface Controller {
  /** Settings are loaded and the page policy has been applied (UI mounted or deliberately not). */
  readonly ready: Promise<void>;
  /** Idempotent. Removes every listener, observer, timer, painted highlight and UI node. */
  destroy(): void;
}

const SELECTION_DEBOUNCE_MS = 60;
const REFRESH_DEBOUNCE_MS = 250;
const MUTATION_DEBOUNCE_MS = 400;
/**
 * A page that never stops mutating (a ticker every 100 ms) must still be looked at about once a
 * second, or text that arrives late would stay unpainted for as long as the page stays busy.
 */
const MUTATION_MAX_WAIT_MS = 1000;
const REVEAL_FLASH_MS = 2000;
const DEFAULT_PRIORITY = 3;

/** A failure whose message is already written for the user. */
class CaptureProblem extends StudyVaultError {
  constructor(message: string) {
    super('invalid_request', message);
  }
}

const ANCHOR_FAILURES = {
  empty:
    "StudyVault can't read this part of the page (it may be inside an embedded component). Try selecting nearby text.",
  'too-long': `That selection is longer than ${MAX_QUOTE_CHARS.toLocaleString('en-US')} characters. Select less text.`,
  'outside-root': 'The selected text changed on the page. Select it again.',
} as const;

interface StoredSelection {
  /** A clone, so it survives the page selection moving when focus enters our UI. */
  range: Range;
  text: string;
}

interface SaveOptions {
  kind: CaptureInput['kind'];
  color: CaptureInput['color'];
  bankId: string | null;
  userComment: string;
  priority: number;
  captureMethod: CaptureMethod;
}

interface Session {
  painter: PainterLike;
  rehydrator: Rehydrator;
  ui: CaptureUi | null;
  cleanups: Array<() => void>;
  revealTimer: ReturnType<typeof setTimeout> | undefined;
}

const isHostNode = (n: Node): boolean =>
  n.nodeType === 1 && (n as Element).hasAttribute(HOST_ATTRIBUTE);

function pathHasHost(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof Node && isHostNode(n));
}

function describeError(err: unknown): string {
  if (err instanceof CaptureProblem) return err.message;
  if (err instanceof StudyVaultError) {
    switch (err.code) {
      case 'forbidden':
        return err.message;
      case 'quota_exceeded':
        return 'Browser storage is full, so nothing was saved. Free some space and try again.';
      case 'storage_unavailable':
        return 'StudyVault storage is unavailable right now. Try again in a moment.';
      case 'unsupported_page':
      case 'no_receiver':
        return 'StudyVault lost contact with the extension. Reload this page, then try again.';
      case 'invalid_request':
        return 'StudyVault could not accept this selection from the page.';
      default:
        return 'Could not save the selection. Try again.';
    }
  }
  return 'Could not save the selection. Try again.';
}

/** Worth offering "Retry": the same request can succeed later. */
function isTransient(err: unknown): boolean {
  if (err instanceof CaptureProblem) return false;
  return (
    err instanceof StudyVaultError &&
    [
      'unsupported_page',
      'no_receiver',
      'storage_unavailable',
      'quota_exceeded',
      'internal',
    ].includes(err.code)
  );
}

export function startController(deps: ControllerDeps): Controller {
  const { win, ctx, call } = deps;
  const doc = win.document;

  let settings: Settings = defaultSettings();
  let settingsChanged = false;
  let destroyed = false;
  let session: Session | null = null;

  let stored: StoredSelection | null = null;
  /** The selection a toolbar save has just completed for; read by the dismissSelection() after it. */
  let saved: StoredSelection | null = null;
  let toolbarVisible = false;
  /** A pointer gesture that started outside our UI is still in progress (drag selection). */
  let pointerActive = false;
  /** The last pointer gesture started inside our UI; sticky until the user acts on the page. */
  let uiPointer = false;

  const blockReason = (): 'denied-site' | null =>
    captureBlock(win.location.href, settings.denyList) ? 'denied-site' : null;

  const pageRef = (): PageRef | null => {
    const url = fitUrl(win.location.href);
    return url ? { url, canonicalUrl: canonicalHref(doc) } : null;
  };

  // -------------------------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------------------------

  async function capture(sel: StoredSelection, opts: SaveOptions): Promise<CaptureResult> {
    const s = session;
    if (!s) throw new CaptureProblem('StudyVault is not active on this page.');
    const page = readPageInfo(doc, win.location.href);
    if (!page) throw new CaptureProblem('This page address is too long to save.');
    const generation = s.rehydrator.generation;
    const stream = buildTextStream();
    const anchored = captureAnchor(sel.range, sel.text, stream);
    if ('error' in anchored) {
      // A collapsed or detached range means the page replaced the text under the selection.
      const gone = sel.range.collapsed || !sel.range.startContainer.isConnected;
      throw new CaptureProblem(ANCHOR_FAILURES[gone ? 'outside-root' : anchored.error]);
    }

    const result = await call('capture.save', {
      page,
      exactQuote: anchored.exactQuote,
      anchorSet: withoutEditableContext(anchored.anchorSet, stream),
      headingContext: anchored.headingContext,
      ...opts,
    });
    // The highlight is stored; paint it from the stream the anchor came from.
    s.rehydrator.upsert(result.highlight, { stream, generation });
    return result;
  }

  function notifySaved(result: CaptureResult): void {
    const bank = result.bank.name;
    const undoable = result.status === 'created' || result.status === 'restored';
    const text =
      result.status === 'created'
        ? `Saved to ${bank}`
        : result.status === 'restored'
          ? `Restored in ${bank}`
          : result.addedToBank
            ? `Already saved. Added to ${bank}`
            : `Already saved in ${bank}`;
    session?.ui?.toast({
      text,
      tone: 'success',
      action: undoable
        ? {
            label: 'Undo',
            run: () => {
              host.undo(result.highlight.id).catch((err: unknown) => {
                session?.ui?.toast({ text: describeError(err), tone: 'error' });
              });
            },
          }
        : undefined,
    });
  }

  /** Saves and, on failure, tells the user and offers a retry. The selection is never discarded. */
  async function saveReportingFailure(
    sel: StoredSelection,
    opts: SaveOptions,
  ): Promise<CaptureResult> {
    try {
      return await capture(sel, opts);
    } catch (err) {
      session?.ui?.toast({
        text: describeError(err),
        tone: 'error',
        action: isTransient(err)
          ? {
              label: 'Retry',
              run: () => {
                saveReportingFailure(sel, opts).then(notifySaved, () => undefined);
              },
            }
          : undefined,
      });
      throw err;
    }
  }

  function dismissSelection(): void {
    const done = saved;
    saved = null;
    const current = stored;
    if (done && current && !sameRange(done.range, current.range)) {
      // The save that just finished was for an older selection; the user has selected something
      // else since. That selection is not being dismissed. The overlay closes its toolbar right
      // after this call, so the newer selection's toolbar is shown again once that has happened.
      queueMicrotask(() => {
        if (stored !== current || !toolbarVisible) return;
        session?.ui?.showToolbar({ text: current.text, rect: rectOf(current.range) });
      });
      return;
    }
    stored = null;
    toolbarVisible = false;
    // Only the selection we captured is cleared, never a different one the user made since.
    const live = doc.getSelection();
    if (current && live && live.rangeCount === 1 && sameRange(live.getRangeAt(0), current.range)) {
      live.removeAllRanges();
    }
  }

  async function removeHighlight(id: string): Promise<void> {
    await call('highlight.delete', { id });
    session?.rehydrator.drop(id);
  }

  const host: CaptureHost = {
    settings: () => settings,

    async save(req: SaveRequest): Promise<CaptureResult> {
      const sel = stored;
      if (!sel) {
        const problem = new CaptureProblem(
          'The selection is no longer available. Select the text again.',
        );
        session?.ui?.toast({ text: problem.message, tone: 'error' });
        throw problem;
      }
      const result = await saveReportingFailure(sel, {
        kind: req.kind,
        color: req.color,
        bankId: req.bankId,
        userComment: req.comment,
        priority: req.priority,
        captureMethod: 'toolbar',
      });
      // The overlay's continuation runs next and calls dismissSelection(): say which selection it
      // belongs to, so a newer selection made while this save was in flight is left alone.
      saved = sel;
      setTimeout(() => {
        if (saved === sel) saved = null;
      }, 0);
      return result;
    },

    listBanks: () => call('banks.list', {}),
    createBank: (name) => call('bank.create', { name }),
    undo: removeHighlight,
    remove: removeHighlight,

    async update(id, patch) {
      const generation = session?.rehydrator.generation;
      const view = await call('highlight.update', { id, patch });
      session?.rehydrator.upsert(view, { generation });
      return view;
    },

    async restore(id) {
      const generation = session?.rehydrator.generation;
      const view = await call('highlight.restore', { id });
      session?.rehydrator.upsert(view, { generation });
      return view;
    },

    dismissSelection,
  };

  // -------------------------------------------------------------------------------------------
  // Selection -> toolbar
  // -------------------------------------------------------------------------------------------

  function hideSelection(): void {
    const wasVisible = toolbarVisible;
    stored = null;
    toolbarVisible = false;
    if (wasVisible) session?.ui?.hideToolbar();
  }

  function evaluateSelection(): void {
    const ui = session?.ui;
    // `isValid` also notices an extension that was reloaded under this page (then cleans up).
    if (!ui || !ctx.isValid) return;
    // Mid-drag, or the user is working inside our overlay (focus moves there and the page
    // selection may collapse): keep whatever is stored.
    if (pointerActive || uiPointer || isInsideHost(doc.activeElement)) return;
    if (!settings.toolbarEnabled) return hideSelection();
    const verdict = inspectSelection(doc);
    if (!verdict.ok) return hideSelection();
    if (stored && toolbarVisible && sameRange(stored.range, verdict.range)) return;
    stored = { range: verdict.range, text: verdict.text };
    toolbarVisible = true;
    ui.showToolbar({ text: verdict.text, rect: rectOf(verdict.range) });
  }

  function repositionToolbar(): void {
    const ui = session?.ui;
    if (!ui || !toolbarVisible || !stored) return;
    const { range, text } = stored;
    if (!range.startContainer.isConnected || range.collapsed) return hideSelection();
    ui.showToolbar({ text, rect: rectOf(range) });
  }

  // -------------------------------------------------------------------------------------------
  // Mount / unmount (page policy: deny list and scheme)
  // -------------------------------------------------------------------------------------------

  function wire(s: Session): void {
    const listen = (
      target: EventTarget,
      type: string,
      fn: (e: Event) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, fn, opts);
      s.cleanups.push(() => target.removeEventListener(type, fn, opts));
    };
    const capturing = { capture: true, passive: true } as const;

    // Selection watcher: debounced while the selection changes, final on pointerup / keyup.
    const evaluateSoon = debounce(evaluateSelection, SELECTION_DEBOUNCE_MS);
    s.cleanups.push(evaluateSoon.cancel);
    listen(doc, 'selectionchange', () => evaluateSoon());
    listen(
      doc,
      'pointerdown',
      (e) => {
        uiPointer = pathHasHost(e);
        pointerActive = !uiPointer;
      },
      capturing,
    );
    const pointerEnded = (): void => {
      pointerActive = false;
      if (uiPointer) return; // a click inside our UI says nothing about the page selection
      evaluateSoon.cancel();
      evaluateSelection();
    };
    listen(doc, 'pointerup', pointerEnded, capturing);
    listen(doc, 'pointercancel', pointerEnded, capturing);
    listen(doc, 'contextmenu', () => (pointerActive = false), capturing);
    listen(win, 'blur', () => (pointerActive = false));
    listen(
      doc,
      'keydown',
      (e) => {
        if (!pathHasHost(e)) uiPointer = false;
      },
      capturing,
    );
    listen(
      doc,
      'keyup',
      () => {
        pointerActive = false;
        evaluateSoon.cancel();
        evaluateSelection();
      },
      capturing,
    );

    const reposition = frameThrottle(win, repositionToolbar);
    s.cleanups.push(reposition.cancel);
    listen(win, 'scroll', reposition, capturing);
    listen(win, 'resize', reposition, { passive: true });

    // Click on a painted highlight. Observation only: the page's own click handling is untouched.
    listen(
      doc,
      'click',
      (e) => {
        const ev = e as MouseEvent;
        const ui = s.ui;
        if (!ui || !ev.isTrusted || ev.button !== 0) return;
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey || pathHasHost(ev)) return;
        const live = doc.getSelection();
        if (live && !live.isCollapsed) return;
        const id = s.painter.hitTest(ev.clientX, ev.clientY);
        const view = id === null ? undefined : s.rehydrator.viewOf(id);
        if (!id || !view) return;
        const range = s.rehydrator.rangeOf(id);
        ui.showHighlightPopover(view, range ? rectOf(range) : rectAt(ev.clientX, ev.clientY));
      },
      capturing,
    );

    // Rehydration triggers: data changes elsewhere, route changes, DOM mutations.
    const refreshSoon = debounce(() => void s.rehydrator.refresh(), REFRESH_DEBOUNCE_MS);
    s.cleanups.push(
      refreshSoon.cancel,
      deps.watchDataEpoch(() => refreshSoon()),
    );

    const retrySoon = debounce(
      () => s.rehydrator.retryPass(),
      MUTATION_DEBOUNCE_MS,
      MUTATION_MAX_WAIT_MS,
    );
    s.cleanups.push(retrySoon.cancel);

    const routes = new RouteWatcher(win, () => {
      hideSelection();
      retrySoon.cancel();
      void s.rehydrator.onRouteChange();
    });
    routes.start();
    s.cleanups.push(() => routes.stop());

    const observer = new win.MutationObserver((records) => {
      routes.check(); // pushState without Navigation API support fires no event of its own
      if (!records.some(affectsPageText)) return;
      s.rehydrator.invalidate();
      retrySoon();
    });
    // <html>, not <body>: some apps replace the body element wholesale.
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    s.cleanups.push(() => observer.disconnect());
  }

  async function mount(): Promise<void> {
    const painter = deps.createPainter?.(doc) ?? new HighlightPainter(doc);
    const rehydrator = new Rehydrator({
      painter,
      page: pageRef,
      fetchHighlights: async (page) => (await call('page.highlights', page)).highlights,
      report: (items) => call('highlight.reportResolution', { items }),
    });
    const s: Session = { painter, rehydrator, ui: null, cleanups: [], revealTimer: undefined };
    session = s;

    try {
      s.ui = await deps.createUi(ctx, host);
    } catch (err) {
      // Highlights and quick-save still work without the overlay.
      console.warn('[StudyVault] overlay failed to start', err);
    }
    if (session !== s) {
      s.ui?.destroy(); // unmounted (deny list, destroy) while the overlay was being built
      return;
    }

    wire(s);
    if (doc.readyState === 'loading') {
      // The body is still being parsed: resolving now would call every highlight lost.
      const onParsed = (): void => void rehydrator.refresh();
      doc.addEventListener('DOMContentLoaded', onParsed, { once: true });
      s.cleanups.push(() => doc.removeEventListener('DOMContentLoaded', onParsed));
    } else {
      await rehydrator.refresh();
    }
  }

  function unmount(): void {
    const s = session;
    session = null;
    stored = null;
    saved = null;
    toolbarVisible = false;
    pointerActive = false;
    uiPointer = false;
    if (!s) return;
    for (const cleanup of s.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // one failing teardown must not leave the rest attached
      }
    }
    if (s.revealTimer !== undefined) clearTimeout(s.revealTimer);
    s.rehydrator.destroy();
    s.painter.destroy();
    s.ui?.destroy();
  }

  async function applyPolicy(): Promise<void> {
    if (destroyed) return;
    if (blockReason()) unmount();
    else if (!session) await mount();
  }

  // -------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------

  const stopSettings = deps.watchSettings((next) => {
    settings = next;
    settingsChanged = true;
    session?.ui?.applySettings(next);
    if (!next.toolbarEnabled) hideSelection();
    void applyPolicy();
  });

  const ready = (async (): Promise<void> => {
    try {
      const loaded = await deps.getSettings();
      if (!settingsChanged) settings = loaded;
    } catch {
      // keep defaults: toolbar on, default deny list
    }
    await applyPolicy();
  })();

  // -------------------------------------------------------------------------------------------
  // Tab RPC (answered even where the overlay is not mounted)
  // -------------------------------------------------------------------------------------------

  const blockedKind = (): PageStatus['blocked'] =>
    blockReason() ?? (settings.toolbarEnabled ? null : 'toolbar-disabled');

  const stopServing = deps.serve({
    'content.ping': async () => ({ ready: true, version: deps.version }),

    'content.pageStatus': async () => {
      await ready;
      const page = pageRef();
      if (!page)
        throw new StudyVaultError('unsupported_page', 'This address cannot hold highlights.');
      const denied = blockReason() !== null;
      return {
        url: page.url,
        canonicalUrl: page.canonicalUrl,
        title: doc.title,
        counts: session?.rehydrator.counts() ?? {
          total: 0,
          resolved: 0,
          changed: 0,
          ambiguous: 0,
          orphaned: 0,
          pending: 0,
        },
        paintingSupported: session ? session.painter.supported : HighlightPainter.isSupported(win),
        hasSelection: !denied && inspectSelection(doc).ok,
        blocked: blockedKind(),
      };
    },

    'content.captureSelection': async ({ method, bankId }): Promise<CaptureSelectionResult> => {
      await ready;
      if (blockReason() || !session) {
        return {
          status: 'blocked',
          reason: `StudyVault is turned off on ${win.location.hostname}.`,
        };
      }
      const verdict = inspectSelection(doc);
      if (!verdict.ok) {
        switch (verdict.reason) {
          case 'editable':
            return {
              status: 'blocked',
              reason: 'StudyVault does not capture text from form fields or editors.',
            };
          case 'too-long':
            return { status: 'blocked', reason: ANCHOR_FAILURES['too-long'] };
          case 'unreadable':
            return { status: 'blocked', reason: ANCHOR_FAILURES.empty };
          default:
            return { status: 'no-selection' };
        }
      }
      const kind = settings.defaultKind;
      const result = await saveReportingFailure(
        { range: verdict.range, text: verdict.text },
        {
          kind,
          color: settings.palette[kind],
          bankId,
          userComment: '',
          priority: DEFAULT_PRIORITY,
          captureMethod: method,
        },
      );
      notifySaved(result);
      const live = doc.getSelection();
      if (live && live.rangeCount === 1 && sameRange(live.getRangeAt(0), verdict.range)) {
        live.removeAllRanges();
      }
      // The save was awaited: only close the toolbar if it still belongs to the selection saved.
      if (stored && sameRange(stored.range, verdict.range)) hideSelection();
      return result;
    },

    'content.refresh': async () => {
      await ready;
      await session?.rehydrator.refresh();
      return { ok: true };
    },

    'content.reveal': async ({ id }) => {
      await ready;
      const s = session;
      if (!s) return { found: false };
      let range = s.rehydrator.rangeOf(id);
      if (!range && !s.rehydrator.has(id)) {
        // Created elsewhere moments ago: the data-change refresh may not have arrived yet.
        await s.rehydrator.refresh();
        range = s.rehydrator.rangeOf(id);
      }
      if (!range || session !== s) return { found: false };
      scrollRangeToCenter(win, range);
      s.painter.setActive(id);
      if (s.revealTimer !== undefined) clearTimeout(s.revealTimer);
      s.revealTimer = setTimeout(() => {
        s.revealTimer = undefined;
        s.painter.setActive(null);
      }, REVEAL_FLASH_MS);
      return { found: true };
    },
  });

  return {
    ready,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      unmount();
      for (const stop of [stopServing, stopSettings]) {
        try {
          stop();
        } catch {
          // the extension runtime is already gone
        }
      }
    },
  };
}
