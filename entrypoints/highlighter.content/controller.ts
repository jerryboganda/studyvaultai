import {
  KIND_LABELS,
  MAX_QUOTE_CHARS,
  StudyVaultError,
  captureBlock,
  defaultSettings,
  type CaptureInput,
  type CaptureMethod,
  type CaptureResult,
  type CaptureSelectionResult,
  type HighlightView,
  type PageStatus,
  type Settings,
  type TabRpc,
} from '@shared';
import {
  HOST_ATTRIBUTE,
  HighlightPainter,
  buildTextStream,
  captureAnchor,
  type TextStream,
} from '@highlights';
import { HANDLER_TIMEOUT_MS, type Handlers, type callBackground } from '@runtime';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { CaptureHost, CaptureUi, CreateCaptureUi, SaveRequest } from './contract';
import {
  inspectSelection,
  isEditingContext,
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
/** A router that pushes several URLs in a row (redirects, canonicalisation) loads once, at the end. */
const ROUTE_DEBOUNCE_MS = 150;
const ROUTE_MAX_WAIT_MS = 1000;
const REVEAL_FLASH_MS = 2000;
const DEFAULT_PRIORITY = 3;
const QUOTE_ANNOUNCE_CHARS = 80;
/**
 * Calls to the worker give up before the RPC handler that waits on them does (the runtime answers
 * `content.*` requests with its own error after HANDLER_TIMEOUT_MS, in words about "the background
 * worker"). The failure that reaches the user then names the call that was slow.
 */
const RPC_TIMEOUT_MS = HANDLER_TIMEOUT_MS - 3_000;
/** What the runtime's call() says when nobody answered in time (packages/runtime messaging.ts). */
const NO_ANSWER = /^No answer to /;

const LOST_CONTACT =
  'StudyVault lost contact with the extension. Reload this page, then try again.';
const TOO_SLOW = 'StudyVault is taking too long to respond. Try again in a moment.';
const SIDE_PANEL_FAILED = 'Could not open the StudyVault side panel. Try again.';

/**
 * Keyboard route to the painted highlights: Alt+Shift+] is the next one in document order and
 * Alt+Shift+[ the previous one (wrapping). Physical keys, like the overlay's Alt+Shift+T, so the
 * shortcut does not depend on where a layout puts the brackets. Ignored while typing or editing.
 */
function highlightStep(e: KeyboardEvent): 1 | -1 | 0 {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return 0;
  if (e.code === 'BracketRight') return 1;
  return e.code === 'BracketLeft' ? -1 : 0;
}

/** A failure whose message is already written for the user. */
class CaptureProblem extends StudyVaultError {
  constructor(message: string) {
    super('invalid_request', message);
  }
}

/**
 * The worker did not answer within the call budget: it is slow or busy, not gone. (A transport that
 * really has no receiver reports `no_receiver` too, but at once and with another message; reloading
 * the page is the wrong advice for a slow worker.)
 */
class WorkerSlow extends StudyVaultError {
  constructor() {
    super('internal', TOO_SLOW);
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
  if (err instanceof CaptureProblem || err instanceof WorkerSlow) return err.message;
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
        return LOST_CONTACT;
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
  /** The highlight last reached by keyboard, click or reveal: where next / previous continue from. */
  let navigated: string | null = null;
  /** A next / previous step is in progress: its highlight keeps the active style until the reader leaves. */
  let navigating = false;

  /**
   * Is this script still the extension's? `ctx.isValid` is what notices an extension that was
   * reloaded or updated under the page (WXT then runs its invalidation callbacks); where it only
   * reports, this tears the controller down itself. Polled from every observer and timer, because
   * an orphaned script otherwise keeps reacting to the page with calls that can no longer succeed.
   */
  const alive = (): boolean => {
    if (!destroyed && ctx.isValid) return true;
    destroy();
    return false;
  };

  /** Every worker call: bounded below the RPC handler budget, and a timeout says it was one. */
  const rpc: typeof call = async (type, payload, options) => {
    try {
      return await call(type, payload, { timeoutMs: RPC_TIMEOUT_MS, ...options });
    } catch (err) {
      throw err instanceof StudyVaultError &&
        err.code === 'no_receiver' &&
        NO_ANSWER.test(err.message)
        ? new WorkerSlow()
        : err;
    }
  };

  const blockReason = (): 'denied-site' | null =>
    captureBlock(win.location.href, settings.denyList) ? 'denied-site' : null;

  const pageRef = (): PageRef | null => {
    const url = fitUrl(win.location.href);
    return url ? { url, canonicalUrl: canonicalHref(doc) } : null;
  };

  /**
   * Hands a stored highlight to the rehydrator. The write has already succeeded when this runs: a
   * failure to place it on the page must not be reported as a failure to save (the next refresh
   * paints it).
   */
  function place(view: HighlightView, opts?: { stream?: TextStream; generation?: number }): void {
    try {
      session?.rehydrator.upsert(view, opts);
    } catch (err) {
      console.warn('[StudyVault] could not place a stored highlight on the page', err);
    }
  }

  /** The counterpart of `place()` for a delete that has already succeeded. */
  function unplace(id: string): void {
    try {
      session?.rehydrator.drop(id);
    } catch (err) {
      console.warn('[StudyVault] could not take a deleted highlight off the page', err);
    }
  }

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

    const result = await rpc('capture.save', {
      page,
      exactQuote: anchored.exactQuote,
      anchorSet: withoutEditableContext(anchored.anchorSet, stream),
      headingContext: anchored.headingContext,
      ...opts,
    });
    // The highlight is stored; paint it from the stream the anchor came from.
    place(result.highlight, { stream, generation });
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
    await rpc('highlight.delete', { id });
    unplace(id);
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

    listBanks: () => rpc('banks.list', {}),
    createBank: (name) => rpc('bank.create', { name }),
    undo: removeHighlight,
    remove: removeHighlight,

    async update(id, patch) {
      const generation = session?.rehydrator.generation;
      const view = await rpc('highlight.update', { id, patch });
      place(view, { generation });
      return view;
    },

    async restore(id) {
      const generation = session?.rehydrator.generation;
      const view = await rpc('highlight.restore', { id });
      place(view, { generation });
      return view;
    },

    dismissSelection,

    // No await before the message: chrome.sidePanel.open() needs the user gesture, and callBackground
    // hands the message to the runtime synchronously, so the click handler's activation still holds.
    openInSidePanel(highlightId) {
      const fail = (text: string): false => {
        session?.ui?.toast({ text, tone: 'error' });
        return false;
      };
      return rpc('sidepanel.open', { focusHighlightId: highlightId }).then(
        ({ opened }) => opened || fail(SIDE_PANEL_FAILED),
        (err: unknown) =>
          fail(
            err instanceof StudyVaultError &&
              (err.code === 'no_receiver' || err.code === 'unsupported_page')
              ? LOST_CONTACT
              : SIDE_PANEL_FAILED,
          ),
      );
    },
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
    if (!ui || !alive()) return;
    // Mid-drag, or the user is working inside our overlay (focus moves there and the page
    // selection may collapse): keep whatever is stored.
    if (pointerActive || uiPointer || isInsideHost(doc.activeElement)) return;
    if (!settings.toolbarEnabled) return hideSelection();
    const verdict = inspectSelection(doc);
    if (!verdict.ok) return hideSelection();
    leaveNavigation(); // the reader is selecting text now, not stepping through highlights
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
  // Reaching a highlight (side panel "show on page", keyboard next / previous)
  // -------------------------------------------------------------------------------------------

  /**
   * Scrolls the highlight to the centre and emphasises it: for two seconds (a reveal from the side
   * panel) or, with `hold`, until the reader leaves (a step, whose popover stays open as long as
   * they like). False, with nothing moved, when its text is hidden (closed tab panel or
   * accordion): there is nowhere to scroll to. Quiet mode scrolls too but publishes nothing, the
   * emphasis included.
   */
  function showHighlight(
    s: Session,
    id: string,
    range: Range,
    opts: { instant?: boolean; hold?: boolean } = {},
  ): boolean {
    if (!scrollRangeToCenter(win, range, { instant: opts.instant })) return false;
    if (s.revealTimer !== undefined) clearTimeout(s.revealTimer);
    s.revealTimer = undefined;
    navigated = id;
    navigating = false;
    if (!settings.paintHighlights) return true;
    s.painter.setActive(id);
    if (opts.hold) {
      navigating = true;
    } else {
      s.revealTimer = setTimeout(() => {
        s.revealTimer = undefined;
        if (alive()) s.painter.setActive(null);
      }, REVEAL_FLASH_MS);
    }
    return true;
  }

  /**
   * The reader moved on (pressed on the page, Escape, focus back on the page, selected text, another
   * route): the emphasis a step held goes. Nothing else ends it, so it outlives its 2 s flash for
   * as long as the popover is read.
   */
  function leaveNavigation(): void {
    if (!navigating) return;
    navigating = false;
    session?.painter.setActive(null);
  }

  /**
   * The document selection is the caret that Tab and a screen reader's cursor continue from, so a
   * step moves it to the highlight (collapsed: nothing is selected, nothing is copied). Not while
   * the user is in a field: that would take the focus out of it.
   */
  function moveCaretTo(range: Range): void {
    if (isEditingContext(doc)) return;
    try {
      doc.getSelection()?.collapse(range.startContainer, range.startOffset);
    } catch {
      // the range left the document in the meantime
    }
  }

  /** "Highlight 2 of 5, Formula: <quote>. 1 not placed on this page." */
  function describeStep(s: Session, view: HighlightView, position: number, total: number): string {
    const quote = [...view.exactQuote.replace(/\s+/g, ' ').trim()];
    const clipped =
      quote.length > QUOTE_ANNOUNCE_CHARS
        ? `${quote.slice(0, QUOTE_ANNOUNCE_CHARS).join('')}…`
        : quote.join('');
    const unplaced = Math.max(0, s.rehydrator.counts().total - total);
    return (
      `Highlight ${position} of ${total}, ${KIND_LABELS[view.kind].label}: ${clipped}` +
      `${/[.!?…]$/.test(clipped) ? '' : '.'}` +
      `${unplaced > 0 ? ` ${unplaced} not placed on this page.` : ''}`
    );
  }

  /**
   * Next / previous painted highlight in document order: scroll to it, hold its emphasis, put the
   * caret there, announce where the reader is and open its popover (focus moves in). The in-page
   * shortcut and the manifest commands both come here. False when there is none to show.
   */
  function stepHighlight(s: Session, ui: CaptureUi | null, step: 1 | -1): boolean {
    const list = s.rehydrator.painted();
    const n = list.length;
    if (n === 0) {
      ui?.toast({ text: 'No highlights on this page yet.', tone: 'info' });
      return false;
    }
    let from = navigated === null ? -1 : list.findIndex((h) => h.id === navigated);
    if (from < 0) {
      // Not reached by keyboard yet: continue from the reader's position, the top edge of the
      // viewport (first highlight at or below it). Without layout every top is 0: first / last.
      const edge = list.findIndex((h) => rectOf(h.range).top >= 0);
      const below = edge < 0 ? n : edge;
      from = step === 1 ? below - 1 : below;
    }
    for (let k = 1; k <= n; k++) {
      const at = (((from + step * k) % n) + n) % n;
      const hit = list[at]!;
      const view = s.rehydrator.viewOf(hit.id);
      // Hidden highlights are skipped, so the shortcut never "does nothing" while others exist.
      if (!view || !showHighlight(s, hit.id, hit.range, { instant: true, hold: true })) continue;
      moveCaretTo(hit.range);
      ui?.announce(describeStep(s, view, at + 1, n));
      // The jump was instant, so the range's rect is final and the popover anchors to it.
      ui?.showHighlightPopover(view, rectOf(hit.range));
      return true;
    }
    ui?.toast({ text: 'No visible highlights on this page.', tone: 'info' });
    return false;
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
        if (!uiPointer) leaveNavigation(); // a press on the page ends a step-through
      },
      capturing,
    );
    // Focus coming back to the page (the popover closed and handed it back) ends it too.
    listen(
      doc,
      'focusin',
      (e) => {
        if (!pathHasHost(e)) leaveNavigation();
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
        if ((e as KeyboardEvent).key === 'Escape') leaveNavigation(); // also closes the popover
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
        navigated = id;
        ui.showHighlightPopover(view, range ? rectOf(range) : rectAt(ev.clientX, ev.clientY));
      },
      capturing,
    );

    // Alt+Shift+] / Alt+Shift+[ (see highlightStep). Not passive: the handled key is not also
    // delivered to the page's own shortcuts as a default action. Registered through listen(), so
    // it goes away with the session (unmount, deny list, context invalidation).
    listen(
      doc,
      'keydown',
      (e) => {
        const ev = e as KeyboardEvent;
        const step = highlightStep(ev);
        const ui = s.ui;
        if (step === 0 || session !== s || !ui || !ev.isTrusted || !alive()) return;
        // A key pressed inside the overlay belongs to the overlay (its note field types text).
        if (pathHasHost(ev) || isEditingContext(doc, ev.composedPath()[0] ?? null)) return;
        ev.preventDefault();
        stepHighlight(s, ui, step);
      },
      { capture: true },
    );

    // Rehydration triggers: data changes elsewhere, route changes, DOM mutations, and the page
    // coming back to the reader (a background tab or a bfcache restore missed what changed).
    const refreshSoon = debounce(() => {
      if (alive()) void s.rehydrator.refresh();
    }, REFRESH_DEBOUNCE_MS);
    s.cleanups.push(
      refreshSoon.cancel,
      deps.watchDataEpoch(() => refreshSoon()),
    );
    listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'visible') refreshSoon();
    });
    listen(win, 'pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) refreshSoon();
    });

    const retrySoon = debounce(
      () => {
        if (alive()) s.rehydrator.retryPass();
      },
      MUTATION_DEBOUNCE_MS,
      MUTATION_MAX_WAIT_MS,
    );
    s.cleanups.push(retrySoon.cancel);

    // A route change forgets the old page at once (nothing of it may show on the new one); only the
    // load waits, so a router that pushes several URLs in a row costs one fetch and one resolve.
    const loadRouteSoon = debounce(
      () => {
        if (alive()) void s.rehydrator.refresh();
      },
      ROUTE_DEBOUNCE_MS,
      ROUTE_MAX_WAIT_MS,
    );
    s.cleanups.push(loadRouteSoon.cancel);
    const routes = new RouteWatcher(win, () => {
      hideSelection();
      leaveNavigation();
      retrySoon.cancel();
      s.rehydrator.routeChanged();
      loadRouteSoon();
    });
    routes.start();
    s.cleanups.push(() => routes.stop());

    const observer = new win.MutationObserver((records) => {
      if (!alive()) return; // orphaned by an extension update: stop reacting to the page
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
    painter.setStyle?.(settings.highlightStyle);
    const rehydrator = new Rehydrator({
      painter,
      page: pageRef,
      fetchHighlights: async (page) => (await rpc('page.highlights', page)).highlights,
      report: (items) => rpc('highlight.reportResolution', { items }),
      paintEnabled: () => settings.paintHighlights,
      alive,
      // A note written in the side panel reaches this tab with a load: an open popover follows it.
      onLoaded: () => session?.ui?.refreshHighlightPopover((id) => rehydrator.viewOf(id)),
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
    navigated = null;
    navigating = false;
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
    const before = settings;
    settings = next;
    settingsChanged = true;
    const s = session;
    s?.ui?.applySettings(next);
    if (!next.toolbarEnabled) hideSelection();
    if (s && next.highlightStyle !== before.highlightStyle) {
      s.painter.setStyle?.(next.highlightStyle);
    }
    if (s && next.paintHighlights !== before.paintHighlights) {
      // Quiet mode on: take everything back from the page's registry now, the emphasis included.
      if (s.revealTimer !== undefined) clearTimeout(s.revealTimer);
      s.revealTimer = undefined;
      navigating = false;
      if (!next.paintHighlights) s.painter.setActive(null);
      s.rehydrator.repaint();
    }
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
      // Resolved but hidden (display:none panel, closed <details>) is not "found on the page".
      return { found: showHighlight(s, id, range) };
    },

    // Manifest command "focus-toolbar": the in-page Alt+Shift+T is Chrome's own accelerator.
    'content.focusToolbar': async () => {
      await ready;
      return { focused: (alive() && session?.ui?.focusToolbar()) === true };
    },

    // Manifest commands "next-highlight" / "previous-highlight": the same code path as the in-page
    // Alt+Shift+] / [ route, which stays as it was.
    'content.stepHighlight': async ({ direction }) => {
      await ready;
      const s = session;
      if (!s || !alive()) return { found: false };
      return { found: stepHighlight(s, s.ui, direction === 'next' ? 1 : -1) };
    },
  });

  function destroy(): void {
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
  }

  return { ready, destroy };
}
