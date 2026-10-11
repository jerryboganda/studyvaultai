/**
 * Page virtualisation (framework-free so it is unit-testable with a mock renderer): only pages that
 * are visible, plus `radius` neighbours on each side, hold a canvas and a text layer. Everything else
 * is released, so a 1000-page document costs the same memory as a 3-page window.
 */

export function pagesToKeep(visible: Iterable<number>, pageCount: number, radius = 1): number[] {
  const keep = new Set<number>();
  for (const v of visible) {
    for (let n = v - radius; n <= v + radius; n++) if (n >= 1 && n <= pageCount) keep.add(n);
  }
  return [...keep].sort((a, b) => a - b);
}

export interface LazyPagesHooks<H> {
  /** Draw page `pageNumber`; must stop and reject quietly when `signal` aborts. */
  render(pageNumber: number, signal: AbortSignal): Promise<H>;
  /** Free what render() created (canvas, text layer, pdf.js page resources). */
  release(pageNumber: number, handle: H): void;
  onError?(pageNumber: number, error: unknown): void;
}

interface Entry<H> {
  ac: AbortController;
  handle: H | null;
  failed: boolean;
}

export class LazyPages<H> {
  private readonly entries = new Map<number, Entry<H>>();
  private visible: number[] = [];
  private destroyed = false;

  constructor(
    private readonly hooks: LazyPagesHooks<H>,
    private readonly pageCount: number,
    private readonly radius = 1,
  ) {}

  /** Page numbers that currently hold (or are acquiring) resources. */
  get active(): number[] {
    return [...this.entries.keys()].sort((a, b) => a - b);
  }

  setVisible(pages: Iterable<number>): void {
    if (this.destroyed) return;
    this.visible = [...pages];
    this.sync();
  }

  /** Zoom or rotation changed: every kept page is drawn again. */
  invalidate(): void {
    if (this.destroyed) return;
    for (const n of [...this.entries.keys()]) this.drop(n);
    this.sync();
  }

  destroy(): void {
    this.destroyed = true;
    for (const n of [...this.entries.keys()]) this.drop(n);
  }

  private sync(): void {
    const keep = new Set(pagesToKeep(this.visible, this.pageCount, this.radius));
    for (const n of [...this.entries.keys()]) if (!keep.has(n)) this.drop(n);
    for (const n of keep) if (!this.entries.has(n)) this.start(n);
  }

  private start(n: number): void {
    const entry: Entry<H> = { ac: new AbortController(), handle: null, failed: false };
    this.entries.set(n, entry);
    this.hooks.render(n, entry.ac.signal).then(
      (handle) => {
        if (entry.ac.signal.aborted || this.entries.get(n) !== entry) this.hooks.release(n, handle);
        else entry.handle = handle;
      },
      (err: unknown) => {
        if (entry.ac.signal.aborted) return;
        entry.failed = true; // stays listed until it scrolls away or invalidate(): no retry loop
        this.hooks.onError?.(n, err);
      },
    );
  }

  private drop(n: number): void {
    const entry = this.entries.get(n);
    if (!entry) return;
    this.entries.delete(n);
    entry.ac.abort();
    if (entry.handle !== null) this.hooks.release(n, entry.handle);
  }
}
