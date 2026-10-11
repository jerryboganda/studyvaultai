import { sourceKeys, type HighlightView } from '@shared';
import {
  buildTextStream,
  resolveMany,
  streamTextOfRange,
  type PaintEntry,
  type Resolution,
  type ResolutionStatus,
  type TextStream,
} from '@highlights';
import { ReportTracker, type ReportItem, type ReportRow } from './reportTracker';
import { RetryBudget } from './retryBudget';

/** The part of `HighlightPainter` this module needs (a fake in tests). */
export interface PainterLike {
  readonly supported: boolean;
  paint(entries: readonly PaintEntry[]): void;
  setActive(id: string | null): void;
  /** Settings.highlightStyle as is ('auto' lets the painter follow prefers-contrast). */
  setStyle?(style: 'auto' | 'normal' | 'strong'): void;
  hitTest(x: number, y: number): string | null;
  clear(): void;
  destroy(): void;
}

export interface PageRef {
  url: string;
  canonicalUrl: string | null;
}

export interface Counts {
  total: number;
  resolved: number;
  changed: number;
  ambiguous: number;
  orphaned: number;
  pending: number;
}

export interface RehydratorDeps {
  painter: PainterLike;
  /** Identity of the page as it is NOW; null when it cannot hold highlights. */
  page(): PageRef | null;
  fetchHighlights(page: PageRef): Promise<HighlightView[]>;
  report(items: ReportItem[]): Promise<unknown>;
  buildStream?: () => TextStream;
  /** Unresolved outcomes are only reported once the page has been quiet this long. */
  settleMs?: number;
  retry?: RetryBudget;
  /**
   * Quiet mode: false = resolve and report as usual but publish no range to the page. Read at every
   * repaint, so a settings change only needs `repaint()`.
   */
  paintEnabled?: () => boolean;
  /**
   * Polled by every timer. False once the host context is gone (extension reloaded or updated under
   * the page): the timer then does nothing, so an orphaned script winds down by itself.
   */
  alive?: () => boolean;
}

type State = ResolutionStatus | 'pending';

interface Entry {
  /** As last returned by the service worker (or saved/restored by this tab). */
  view: HighlightView;
  state: State;
  confidence: number | null;
  /** Non-null exactly when the highlight is painted (resolved / changed). */
  range: Range | null;
  /** Stream text of `range` at resolution time: detects text that was edited under a live range. */
  text: string | null;
}

const MAX_REPORT_BATCH = 500;
/**
 * Waits before the 1st..nth re-fetch after a failed load (worker asleep, restarting, a message lost
 * during navigation). After the last one the page is left alone until something gives a reason to
 * look again: a data-change signal, the tab becoming visible, a route change.
 */
const LOAD_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const painted = (s: State): boolean => s === 'resolved' || s === 'changed';

/** The identity the worker matches highlights by (`page.highlights`); null when it has none. */
function keyOf(page: PageRef | null): string | null {
  const keys = page ? sourceKeys(page.url, page.canonicalUrl) : null;
  return keys ? `${keys.urlKey}\n${keys.visitedKey}` : null;
}

/**
 * Keeps the page's painted highlights in step with the stored ones (ADR-004 "Dynamic pages"):
 * fetch -> resolve everything against one stream -> paint resolved/changed only -> report changed
 * outcomes. Every method is safe to call at any time; navigation makes in-flight work stale.
 */
export class Rehydrator {
  private entries = new Map<string, Entry>();
  private stream: TextStream | null = null;
  /** Bumped on every route change; async results of an older generation are discarded. */
  private epoch = 0;
  /** Local edit counter: a fetch that started before an edit must not undo it. */
  private seq = 0;
  private readonly touched = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private deferTimer: ReturnType<typeof setTimeout> | undefined;
  private loadRetryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive failed loads since the last success or the last caller with a reason to look again. */
  private loadFailures = 0;
  /** `keyOf(page)` of the newest load: a route change onto the same key forgets nothing. */
  private loadedKey: string | null = null;
  private destroyed = false;
  private readonly tracker = new ReportTracker();
  private readonly retry: RetryBudget;

  constructor(private readonly deps: RehydratorDeps) {
    this.retry = deps.retry ?? new RetryBudget();
  }

  get generation(): number {
    return this.epoch;
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  counts(): Counts {
    const c: Counts = { total: 0, resolved: 0, changed: 0, ambiguous: 0, orphaned: 0, pending: 0 };
    for (const e of this.entries.values()) {
      c.total += 1;
      c[e.state] += 1;
    }
    return c;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  viewOf(id: string): HighlightView | undefined {
    return this.entries.get(id)?.view;
  }

  /** The live range of a painted highlight, or null when it is not currently resolved on the page. */
  rangeOf(id: string): Range | null {
    const range = this.entries.get(id)?.range ?? null;
    return range && !range.collapsed && range.startContainer.isConnected ? range : null;
  }

  /** Painted highlights in document order (nested ones: the outer one first). */
  painted(): Array<{ id: string; range: Range }> {
    const list: Array<{ id: string; range: Range }> = [];
    for (const id of this.entries.keys()) {
      const range = this.rangeOf(id);
      if (range) list.push({ id, range });
    }
    return list.sort((a, b) => {
      try {
        return (
          a.range.compareBoundaryPoints(a.range.START_TO_START, b.range) ||
          b.range.compareBoundaryPoints(b.range.END_TO_END, a.range)
        );
      } catch {
        return 0; // a range left the document between rangeOf() and here
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  /**
   * Fetch + resolve + paint. Concurrent calls coalesce into at most one follow-up run. A caller asks
   * because it has a reason to look again, so a spent retry budget starts over.
   */
  refresh(): Promise<void> {
    this.loadFailures = 0;
    return this.enqueue();
  }

  private enqueue(): Promise<void> {
    if (this.queued) return this.queued;
    const run = this.chain.then(() => {
      this.queued = null;
      return this.load();
    });
    // Never rejects: a failed load must not wedge the queue or surface in the page.
    const safe = run.catch((err: unknown) => console.warn('[StudyVault] rehydrate failed', err));
    this.queued = safe;
    this.chain = safe;
    return safe;
  }

  private async load(): Promise<void> {
    if (!this.live()) return;
    const page = this.deps.page();
    if (!page) return;
    const epoch = this.epoch;
    const startSeq = this.seq;
    this.loadedKey = keyOf(page);

    let views: HighlightView[];
    try {
      views = await this.deps.fetchHighlights(page);
    } catch {
      // Worker asleep or unreachable: what is painted stays painted, and the page is not left
      // blank for good: look again after a growing pause.
      if (!this.destroyed && epoch === this.epoch) this.armLoadRetry();
      return;
    }
    if (this.destroyed || epoch !== this.epoch) return;
    this.loadFailures = 0;
    this.disarmLoadRetry();

    // Local edits made while the request was in flight win over the (older) fetched rows.
    const editedSince = (id: string): boolean => (this.touched.get(id) ?? 0) > startSeq;
    const next = new Map<string, Entry>();
    for (const view of views) {
      const local = this.entries.get(view.id);
      if (editedSince(view.id)) {
        if (local) next.set(view.id, local);
        continue;
      }
      next.set(view.id, { view, state: 'pending', confidence: null, range: null, text: null });
    }
    for (const [id, local] of this.entries) {
      if (!next.has(id) && editedSince(id)) next.set(id, local);
    }
    this.entries = next;

    const fresh = [...next].filter(([, e]) => e.state === 'pending').map(([id]) => id);
    this.resolve(fresh);
    this.repaint();
    this.flush();
  }

  // -------------------------------------------------------------------------------------------
  // Local edits (save / update / delete / restore)
  // -------------------------------------------------------------------------------------------

  /**
   * Adds or replaces a highlight this tab just saved, updated or restored. Pass the `generation`
   * read before the request: a result that arrives after a route change belongs to the old page.
   */
  upsert(view: HighlightView, opts: { stream?: TextStream; generation?: number } = {}): void {
    if (this.destroyed) return;
    if (opts.generation !== undefined && opts.generation !== this.epoch) return;
    this.touched.set(view.id, ++this.seq);
    const prev = this.entries.get(view.id);
    if (prev && prev.state !== 'pending') {
      // Anchors never change after capture, so the resolution still holds; only metadata moved.
      this.entries.set(view.id, { ...prev, view });
    } else {
      this.entries.set(view.id, {
        view,
        state: 'pending',
        confidence: null,
        range: null,
        text: null,
      });
      this.resolve([view.id], opts.stream);
    }
    this.repaint();
    this.flush();
  }

  drop(id: string): void {
    if (this.destroyed) return;
    this.touched.set(id, ++this.seq);
    if (this.entries.delete(id)) this.repaint();
  }

  // -------------------------------------------------------------------------------------------
  // Page events
  // -------------------------------------------------------------------------------------------

  /** The document changed: the cached text stream no longer describes it. */
  invalidate(): void {
    this.stream = null;
  }

  /**
   * SPA navigation, the part that must not wait: the old route's results are made stale and its
   * paint is cleared, so nothing of it can show on the new page. A route whose source keys equal
   * the loaded page's (same highlights, e.g. a URL the worker folds onto the same source) forgets
   * nothing, so the page does not flicker. Either way the page text is new: the cached stream goes
   * and the retry budget starts over. The caller loads (debounced) with `refresh()`.
   */
  routeChanged(): void {
    this.stream = null;
    this.retry.reset();
    const key = keyOf(this.deps.page());
    if (key !== null && key === this.loadedKey) return;
    this.epoch += 1;
    this.entries = new Map();
    this.touched.clear();
    this.loadedKey = null;
    this.loadFailures = 0;
    this.deps.painter.clear();
    this.disarmSettle();
    this.disarmDeferred();
    this.disarmLoadRetry();
  }

  /** SPA navigation: `routeChanged()` and load the new route's highlights at once. */
  onRouteChange(): Promise<void> {
    this.routeChanged();
    return this.refresh();
  }

  /**
   * After a (debounced) burst of DOM mutations. Re-resolves only what can have changed:
   *  - highlights that are not painted (lazy content may have arrived), at the rate the retry
   *    budget allows; a pass it refuses is deferred to when it is due, never dropped;
   *  - painted highlights whose range was detached, collapsed or edited under them.
   * Everything else keeps its live Range; nothing is re-scanned.
   */
  retryPass(): void {
    if (!this.live()) return;
    this.invalidate();
    const stale: string[] = [];
    const missing: string[] = [];
    for (const [id, e] of this.entries) {
      if (e.state === 'pending') continue; // a load is about to resolve it
      if (e.range === null) missing.push(id);
      else if (isStale(e)) stale.push(id);
    }
    const targets = stale;
    const retrying = missing.length > 0 && this.retry.begin();
    if (retrying) targets.push(...missing);
    else if (missing.length > 0) this.deferPass();
    if (targets.length === 0) return;
    try {
      this.resolve(targets);
    } finally {
      // Only a pass that really built a stream and resolved is charged to the budget.
      if (retrying) this.retry.end();
    }
    this.repaint();
    this.flush();
  }

  destroy(): void {
    this.destroyed = true;
    this.disarmSettle();
    this.disarmDeferred();
    this.disarmLoadRetry();
    this.entries = new Map();
    this.touched.clear();
    this.stream = null;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private getStream(): TextStream {
    this.stream ??= (this.deps.buildStream ?? (() => buildTextStream()))();
    return this.stream;
  }

  /**
   * Resolves `ids` against `stream` (built on demand: no highlight to resolve, no stream). Every
   * other highlight of the page is passed as a sibling, so a passage that lost its own text cannot
   * be bound onto the text a neighbour owns just because the neighbour is not part of this batch.
   * Never throws and never leaves an entry `pending`: whatever the engine cannot answer for is
   * `orphaned` (and is looked at again by the next retry pass).
   */
  private resolve(ids: readonly string[], stream?: TextStream): void {
    const targets: Array<{ id: string; anchorSet: HighlightView['anchorSet'] }> = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) targets.push({ id, anchorSet: e.view.anchorSet });
    }
    if (targets.length === 0) return;
    const batch = new Set(ids);
    const siblings: Array<HighlightView['anchorSet']> = [];
    for (const [id, e] of this.entries) if (!batch.has(id)) siblings.push(e.view.anchorSet);

    const results = new Map<string, Resolution>();
    try {
      const text = stream ?? this.getStream();
      try {
        for (const [id, res] of resolveMany(targets, text, { siblings })) results.set(id, res);
      } catch {
        // One anchor the engine cannot handle must not take the rest of the batch down with it.
        for (const target of targets) {
          try {
            for (const [id, res] of resolveMany([target], text, { siblings })) results.set(id, res);
          } catch {
            // orphaned below
          }
        }
      }
    } catch (err) {
      console.warn('[StudyVault] could not read the page text', err);
    }

    for (const { id } of targets) {
      const e = this.entries.get(id);
      if (!e) continue;
      const res = results.get(id);
      const usable = res !== undefined && painted(res.status) && res.range !== null;
      e.state = usable ? res.status : res?.status === 'ambiguous' ? 'ambiguous' : 'orphaned';
      e.confidence = usable || res?.status === 'ambiguous' ? res.confidence : 0;
      e.range = usable ? res.range : null;
      try {
        e.text = e.range ? streamTextOfRange(e.range) : null;
      } catch {
        e.state = 'orphaned';
        e.confidence = 0;
        e.range = null;
        e.text = null;
      }
    }
  }

  /** Publishes the resolved ranges to the painter (none in quiet mode: nothing reaches the page). */
  repaint(): void {
    const list: PaintEntry[] = [];
    if (this.deps.paintEnabled?.() ?? true) {
      for (const [id, e] of this.entries) {
        if (e.range) list.push({ id, color: e.view.color, kind: e.view.kind, range: e.range });
      }
    }
    this.deps.painter.paint(list);
  }

  /**
   * Reports outcomes that differ from the stored ones. Resolved/changed go out at once; ambiguous
   * and orphaned wait for `settleMs` of quiet (a half-rendered page would otherwise be recorded as
   * lost, then corrected a moment later: two writes and a flicker in every open panel).
   */
  private flush(final = false): void {
    if (this.destroyed) return;
    const rows: ReportRow[] = [];
    for (const [id, e] of this.entries) {
      if (e.state === 'pending') continue;
      rows.push({
        id,
        server: { status: e.view.resolveStatus, confidence: e.view.resolveConfidence },
        local: { status: e.state, confidence: e.confidence },
      });
    }
    const items = this.tracker.pending(rows);
    const ready = final
      ? items
      : items.filter((i) => i.status === 'resolved' || i.status === 'changed');
    this.send(ready);
    if (!final && ready.length < items.length) this.armSettle();
    else if (!final) this.disarmSettle();
  }

  private send(items: ReportItem[]): void {
    if (items.length === 0) return;
    this.tracker.markSent(items);
    for (let i = 0; i < items.length; i += MAX_REPORT_BATCH) {
      const chunk = items.slice(i, i + MAX_REPORT_BATCH);
      this.deps.report(chunk).catch(() => this.tracker.unmark(chunk));
    }
  }

  private armSettle(): void {
    this.disarmSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      if (this.live()) this.flush(true);
    }, this.deps.settleMs ?? 1500);
  }

  private disarmSettle(): void {
    if (this.settleTimer !== undefined) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  /** The text may have arrived in the last mutation burst: look again as soon as the budget allows. */
  private deferPass(): void {
    if (this.deferTimer !== undefined) return;
    this.deferTimer = setTimeout(() => {
      this.deferTimer = undefined;
      this.retryPass();
    }, this.retry.waitMs + 1);
  }

  private disarmDeferred(): void {
    if (this.deferTimer !== undefined) clearTimeout(this.deferTimer);
    this.deferTimer = undefined;
  }

  /** The next re-fetch after a failed load, `LOAD_RETRY_MS` apart; none once they are used up. */
  private armLoadRetry(): void {
    this.disarmLoadRetry();
    const wait = LOAD_RETRY_MS[this.loadFailures];
    if (wait === undefined) return;
    this.loadFailures += 1;
    this.loadRetryTimer = setTimeout(() => {
      this.loadRetryTimer = undefined;
      if (this.live()) void this.enqueue();
    }, wait);
  }

  private disarmLoadRetry(): void {
    if (this.loadRetryTimer !== undefined) clearTimeout(this.loadRetryTimer);
    this.loadRetryTimer = undefined;
  }

  /** Not destroyed, and the host context (if one is wired in) is still the one that started us. */
  private live(): boolean {
    return !this.destroyed && (this.deps.alive?.() ?? true);
  }
}

function isStale(e: Entry): boolean {
  const range = e.range;
  if (!range) return false;
  try {
    return (
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected ||
      range.collapsed ||
      streamTextOfRange(range) !== e.text
    );
  } catch {
    return true;
  }
}
