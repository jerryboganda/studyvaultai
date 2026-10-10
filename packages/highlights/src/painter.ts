import type { ColorId } from '@shared';
import { COLOR_IDS, COLOR_SWATCH } from '@shared/constants';
import type { PaintEntry, PainterOptions } from './types';

const ACTIVE_NAME = 'sv-hl-active';
const nameFor = (color: ColorId): string => `sv-hl-${color}`;

/** Only these properties are honoured by ::highlight(); the active style must stay within them. */
const ACTIVE_CSS = `::highlight(${ACTIVE_NAME}){background-color:rgba(255,190,0,0.92);color:#111111;text-decoration-line:underline;text-decoration-thickness:2px;text-decoration-color:#7c2d12;}`;

function buildCss(): string {
  const rules = COLOR_IDS.map(
    (c) => `::highlight(${nameFor(c)}){background-color:${COLOR_SWATCH[c].bg};}`,
  );
  rules.push(ACTIVE_CSS);
  return rules.join('\n');
}

interface Sheet {
  replaceSync(css: string): void;
}

interface WindowLike {
  Highlight?: unknown;
  CSS?: { highlights?: { set?: unknown } };
  CSSStyleSheet?: { prototype?: { replaceSync?: unknown } };
  document?: { adoptedStyleSheets?: unknown };
}

/**
 * Paints resolved ranges with the CSS Custom Highlight API (ADR-004). No DOM nodes are created in
 * the page: the only side effects are registry entries named `sv-hl-*` and one constructed
 * stylesheet in `document.adoptedStyleSheets`. When the API is missing every method is a safe
 * no-op and `supported` is false, so the caller can say so in the UI.
 */
export class HighlightPainter {
  static isSupported(win?: Window): boolean {
    try {
      const w = (win ?? (typeof window === 'undefined' ? undefined : window)) as
        WindowLike | undefined;
      return (
        !!w &&
        typeof w.Highlight === 'function' &&
        typeof w.CSS?.highlights?.set === 'function' &&
        typeof w.CSSStyleSheet?.prototype?.replaceSync === 'function' &&
        !!w.document &&
        'adoptedStyleSheets' in w.document
      );
    } catch {
      return false;
    }
  }

  private ready: boolean;
  private readonly doc: Document;
  private readonly registry: Map<string, unknown> | null;
  private readonly HighlightCtor: (new (...ranges: Range[]) => unknown) | null;
  private sheet: Sheet | null = null;
  private entries = new Map<string, PaintEntry>();
  private names = new Set<string>();
  private activeId: string | null = null;

  constructor(doc: Document = document, opts: PainterOptions = {}) {
    this.doc = doc;
    const win = doc.defaultView as (Window & { CSS?: { highlights?: unknown } }) | null;
    const registry = (opts.registry ?? win?.CSS?.highlights ?? null) as Map<string, unknown> | null;
    const ctor = (opts.highlightCtor ??
      (win as unknown as { Highlight?: unknown } | null)?.Highlight ??
      null) as (new (...ranges: Range[]) => unknown) | null;
    const SheetCtor = (opts.styleSheetCtor ??
      (win as unknown as { CSSStyleSheet?: unknown } | null)?.CSSStyleSheet ??
      null) as (new () => Sheet) | null;

    let ok = false;
    try {
      if (
        registry &&
        typeof registry.set === 'function' &&
        typeof ctor === 'function' &&
        typeof SheetCtor === 'function' &&
        'adoptedStyleSheets' in doc
      ) {
        const sheet = new SheetCtor();
        sheet.replaceSync(buildCss());
        this.sheet = sheet;
        this.adopt();
        ok = true;
      }
    } catch {
      this.sheet = null;
    }
    this.ready = ok;
    this.registry = ok ? registry : null;
    this.HighlightCtor = ok ? ctor : null;
  }

  /** False when the API is unavailable (or construction failed, or after destroy()): painting is a no-op. */
  get supported(): boolean {
    return this.ready;
  }

  /** Re-adopts the stylesheet if page script replaced `adoptedStyleSheets` wholesale. */
  private adopt(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const current = (this.doc as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets;
    if (!Array.isArray(current) || !current.includes(sheet)) {
      (this.doc as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets = [
        ...(Array.isArray(current) ? current : []),
        sheet,
      ];
    }
  }

  /** Replace-all: afterwards exactly `entries` are painted (colour groups, plus the active one). */
  paint(entries: readonly PaintEntry[]): void {
    if (!this.supported || !this.registry || !this.HighlightCtor) return;
    try {
      this.adopt();
      this.entries = new Map();
      const byName = new Map<string, Range[]>();
      for (const entry of entries) {
        if (entry.range.collapsed) continue;
        this.entries.set(entry.id, entry);
        const name = nameFor(entry.color);
        const list = byName.get(name);
        if (list) list.push(entry.range);
        else byName.set(name, [entry.range]);
      }
      for (const name of this.names) {
        if (name !== ACTIVE_NAME && !byName.has(name)) this.registry.delete(name);
      }
      for (const [name, ranges] of byName) {
        this.registry.set(name, new this.HighlightCtor(...ranges));
        this.names.add(name);
      }
      this.applyActive();
    } catch {
      // A painter must never take the page down; the next paint() starts from a clean slate.
    }
  }

  /** Emphasises one highlight with a separate, stronger registry entry; null clears it. */
  setActive(id: string | null): void {
    if (!this.supported) return;
    this.activeId = id;
    try {
      this.applyActive();
    } catch {
      // see paint()
    }
  }

  private applyActive(): void {
    const registry = this.registry;
    const Ctor = this.HighlightCtor;
    if (!registry || !Ctor) return;
    const entry = this.activeId === null ? undefined : this.entries.get(this.activeId);
    if (!entry) {
      this.activeId = null;
      if (this.names.delete(ACTIVE_NAME)) registry.delete(ACTIVE_NAME);
      return;
    }
    const highlight = new Ctor(entry.range) as { priority?: number };
    highlight.priority = 1; // above every colour highlight when ranges overlap
    registry.set(ACTIVE_NAME, highlight);
    this.names.add(ACTIVE_NAME);
  }

  /**
   * Id of the painted highlight under (x, y) in viewport coordinates, or null. Ranges are not
   * hit-testable, so the point is mapped to a caret position and compared to the painted ranges;
   * the smallest enclosing range wins (a highlight nested inside another stays clickable).
   */
  hitTest(x: number, y: number): string | null {
    if (!this.supported || this.entries.size === 0) return null;
    try {
      const doc = this.doc as Document & {
        caretPositionFromPoint?: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      let node: Node | null = null;
      let offset = 0;
      const position = doc.caretPositionFromPoint?.(x, y);
      if (position) {
        node = position.offsetNode;
        offset = position.offset;
      } else {
        const caret = doc.caretRangeFromPoint?.(x, y);
        if (caret) {
          node = caret.startContainer;
          offset = caret.startOffset;
        }
      }
      if (!node) return null;

      let bestId: string | null = null;
      let bestSize = Infinity;
      for (const [id, entry] of this.entries) {
        const range = entry.range;
        let inside = false;
        try {
          inside = range.isPointInRange(node, offset);
        } catch {
          inside = false; // different tree / detached node
        }
        if (!inside || !rectsContain(range, x, y)) continue;
        const size = range.toString().length;
        if (size <= bestSize) {
          bestSize = size;
          bestId = id;
        }
      }
      return bestId;
    } catch {
      return null;
    }
  }

  /** Removes every painted highlight; the stylesheet stays for the next paint(). */
  clear(): void {
    if (!this.supported || !this.registry) return;
    for (const name of this.names) this.registry.delete(name);
    this.names.clear();
    this.entries = new Map();
    this.activeId = null;
  }

  /** clear() and un-adopt the stylesheet. The painter is inert afterwards. */
  destroy(): void {
    if (!this.supported) return;
    this.clear();
    try {
      const current = (this.doc as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets;
      if (Array.isArray(current) && this.sheet) {
        (this.doc as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets =
          current.filter((s) => s !== this.sheet);
      }
    } catch {
      // document already torn down
    }
    this.sheet = null;
    this.ready = false;
  }
}

/**
 * Caret positions snap to the nearest character edge, so a click in the margin after a highlighted
 * line end would count. Where the engine exposes geometry, require the point to be on a rect.
 * (jsdom has no layout; there the caret test alone applies.)
 */
function rectsContain(range: Range, x: number, y: number): boolean {
  if (typeof range.getClientRects !== 'function') return true;
  const rects = range.getClientRects();
  if (!rects || rects.length === 0) return true;
  const pad = 1;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
      return true;
    }
  }
  return false;
}
