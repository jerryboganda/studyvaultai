import type { HighlightView } from '@shared';
import {
  buildTextStream,
  resolveMany,
  streamTextOfRange,
  type PaintEntry,
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
const painted = (s: State): boolean => s === 'resolved' || s === 'changed';

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

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  /** Fetch + resolve + paint. Concurrent calls coalesce into at most one follow-up run. */
  refresh(): Promise<void> {
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
    if (this.destroyed) return;
    const page = this.deps.page();
    if (!page) return;
    const epoch = this.epoch;
    const startSeq = this.seq;

    let views: HighlightView[];
    try {
      views = await this.deps.fetchHighlights(page);
    } catch {
      return; // worker asleep or unreachable: what is painted stays painted
    }
    if (this.destroyed || epoch !== this.epoch) return;

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
    this.resolve(fresh, this.getStream());
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
      this.resolve([view.id], opts.stream ?? this.getStream());
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

  /** SPA navigation: forget the old page, start a fresh budget, load the new route's highlights. */
  onRouteChange(): Promise<void> {
    this.epoch += 1;
    this.entries = new Map();
    this.touched.clear();
    this.stream = null;
    this.deps.painter.clear();
    this.disarmSettle();
    this.retry.reset();
    return this.refresh();
  }

  /**
   * After a (debounced) burst of DOM mutations. Re-resolves only what can have changed:
   *  - highlights that are not painted (lazy content may have arrived), within the retry budget;
   *  - painted highlights whose range was detached, collapsed or edited under them.
   * Everything else keeps its live Range; nothing is re-scanned.
   */
  retryPass(): void {
    if (this.destroyed) return;
    this.invalidate();
    const stale: string[] = [];
    const missing: string[] = [];
    for (const [id, e] of this.entries) {
      if (e.state === 'pending') continue; // a load is about to resolve it
      if (e.range === null) missing.push(id);
      else if (isStale(e)) stale.push(id);
    }
    const targets = stale;
    if (missing.length > 0 && this.retry.tryConsume()) targets.push(...missing);
    if (targets.length === 0) return;
    this.resolve(targets, this.getStream());
    this.repaint();
    this.flush();
  }

  destroy(): void {
    this.destroyed = true;
    this.disarmSettle();
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

  private resolve(ids: readonly string[], stream: TextStream): void {
    const targets: Array<{ id: string; anchorSet: HighlightView['anchorSet'] }> = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) targets.push({ id, anchorSet: e.view.anchorSet });
    }
    if (targets.length === 0) return;
    for (const [id, res] of resolveMany(targets, stream)) {
      const e = this.entries.get(id);
      if (!e) continue;
      const usable = painted(res.status) && res.range !== null;
      e.state = usable ? res.status : res.status === 'ambiguous' ? 'ambiguous' : 'orphaned';
      e.confidence = usable || res.status === 'ambiguous' ? res.confidence : 0;
      e.range = usable ? res.range : null;
      e.text = e.range ? streamTextOfRange(e.range) : null;
    }
  }

  private repaint(): void {
    const list: PaintEntry[] = [];
    for (const [id, e] of this.entries) {
      if (e.range) list.push({ id, color: e.view.color, range: e.range });
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
      this.flush(true);
    }, this.deps.settleMs ?? 1500);
  }

  private disarmSettle(): void {
    if (this.settleTimer !== undefined) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
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
