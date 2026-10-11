import type { ColorId, HighlightKind } from '@shared';
import { COLOR_IDS, COLOR_SWATCH, HIGHLIGHT_KINDS } from '@shared/constants';
import type { PaintEntry, PainterOptions } from './types';

const ACTIVE_NAME = 'sv-hl-active';
const nameFor = (color: ColorId, kind?: HighlightKind): string =>
  kind ? `sv-hl-${color}-${kind}` : `sv-hl-${color}`;

export type DecorationStyle = 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';

export interface KindDecoration {
  style: DecorationStyle;
  /** Underline thickness in CSS px at normal strength; 'strong' and forced-colors add 1px. */
  thickness: number;
  /** Human description of the cue, for legends (the kind's own name/glyph lives in KIND_LABELS). */
  label: string;
}

/**
 * The non-colour cue of every semantic kind: a unique (decoration style, thickness) pair, so the kind
 * is readable on the page without relying on hue (UX_DESIGN.md: colour-coded highlights need a
 * non-colour cue). Single source of truth for the painter and for the Options-page legend.
 */
export const KIND_DECORATION: Record<HighlightKind, KindDecoration> = {
  essential: { style: 'solid', thickness: 2, label: 'Solid underline' },
  formula: { style: 'double', thickness: 3, label: 'Double underline' },
  exception: { style: 'wavy', thickness: 2, label: 'Wavy underline' },
  differential: { style: 'dashed', thickness: 2, label: 'Dashed underline' },
  weak_area: { style: 'dotted', thickness: 4, label: 'Thick dotted underline' },
  correction: { style: 'solid', thickness: 4, label: 'Thick solid underline' },
  question: { style: 'dotted', thickness: 2, label: 'Dotted underline' },
};

/**
 * 'auto' (the default) renders as 'normal' but upgrades to 'strong' while the OS asks for more
 * contrast (`prefers-contrast: more`). 'normal' / 'strong' are explicit and ignore that preference.
 * Forced-colors mode always switches to system colours, whatever the mode.
 */
export type HighlightStyleMode = 'auto' | 'normal' | 'strong';

/**
 * Contrast design. A translucent fill is 1.27-1.50:1 against a white page and can never be the cue
 * (it must keep the text readable), so the cue is the per-kind underline, and its colour is
 * `color-mix(<hue> 30%, currentcolor)`: derived from the page's own text colour, it is as legible as
 * the text on both light and dark pages (>= 3:1 against the page AND against its own fill; asserted
 * in painter.test.ts for a white page with #111111 text and a #101318 page with #e8eaed text), while
 * the 30% hue keeps the palette identity. A fixed "dark-ish solid" cannot do this: one that reaches
 * 3:1 against bare white and bare #101318 sits in luminance 0.12-0.30 and then falls to 1.2-2.2:1
 * against its own translucent fill on the dark page, where the underline is actually drawn.
 */
const HUE_SHARE = 30;
/** 'strong' fill: alpha + 0.12, capped at 0.55 so light text on a dark page keeps >= 3:1 with the fill. */
const STRONG_ALPHA_BOOST = 0.12;
const STRONG_ALPHA_CAP = 0.55;
const RGBA = /^(rgba\([^)]*,\s*)([\d.]+)\)$/;

type Strength = 'normal' | 'strong' | 'forced';

function fillFor(color: ColorId, strong: boolean): string {
  const bg = COLOR_SWATCH[color].bg;
  const m = strong ? RGBA.exec(bg) : null;
  if (!m) return bg;
  return `${m[1]}${Math.min(STRONG_ALPHA_CAP, +(Number(m[2]) + STRONG_ALPHA_BOOST).toFixed(2))})`;
}

/** Declarations of one colour(+kind) rule. Only properties honoured by ::highlight() are used. */
function bodyFor(color: ColorId, kind: HighlightKind | undefined, strength: Strength): string {
  const strong = strength !== 'normal';
  const forced = strength === 'forced';
  // Forced colours: the page palette is replaced by system colours, so the fill is dropped and every
  // highlight is a CanvasText underline, which always contrasts with Canvas. A kind-less highlight
  // gets under+overline so it can never read as one of the kinds.
  const fill = forced ? 'transparent' : fillFor(color, strong);
  if (!kind && !forced) return `background-color:${fill};`;
  const deco = kind ? KIND_DECORATION[kind] : { style: 'solid', thickness: 2 };
  const lines = kind ? 'underline' : 'underline overline';
  const line = forced
    ? 'CanvasText'
    : `color-mix(in srgb, ${COLOR_SWATCH[color].solid} ${HUE_SHARE}%, currentcolor)`;
  return `background-color:${fill};text-decoration-line:${lines};text-decoration-style:${deco.style};text-decoration-thickness:${deco.thickness + (strong ? 1 : 0)}px;text-decoration-color:${line};`;
}

/** The transient "show on page" emphasis: opaque fill with its own dark text and underline. */
function activeBody(strength: Strength): string {
  if (strength === 'forced') {
    return 'background-color:Highlight;color:HighlightText;text-decoration-line:underline;text-decoration-style:solid;text-decoration-thickness:3px;text-decoration-color:HighlightText;';
  }
  const thickness = strength === 'strong' ? 3 : 2;
  return `background-color:rgba(255,190,0,0.92);color:#111111;text-decoration-line:underline;text-decoration-style:solid;text-decoration-thickness:${thickness}px;text-decoration-color:#7c2d12;`;
}

/** One rule per distinct declaration block (selectors with identical bodies are listed together). */
function rulesFor(strength: Strength): string[] {
  const byBody = new Map<string, string[]>();
  const add = (name: string, body: string): void => {
    const names = byBody.get(body);
    if (names) names.push(name);
    else byBody.set(body, [name]);
  };
  for (const c of COLOR_IDS) {
    add(nameFor(c), bodyFor(c, undefined, strength));
    for (const k of HIGHLIGHT_KINDS) add(nameFor(c, k), bodyFor(c, k, strength));
  }
  add(ACTIVE_NAME, activeBody(strength));
  return [...byBody].map(
    ([body, names]) => `${names.map((n) => `::highlight(${n})`).join(',')}{${body}}`,
  );
}

function buildCss(mode: HighlightStyleMode): string {
  const css = rulesFor(mode === 'strong' ? 'strong' : 'normal');
  if (mode === 'auto') css.push('@media (prefers-contrast: more){', ...rulesFor('strong'), '}');
  css.push('@media (forced-colors: active){', ...rulesFor('forced'), '}'); // last: wins both
  return css.join('\n');
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
 * the page: the only side effects are registry entries named `sv-hl-*` (one per colour, or per
 * colour + kind: `sv-hl-<color>-<kind>`) and one constructed stylesheet in
 * `document.adoptedStyleSheets`. When the API is missing every method is a safe no-op and
 * `supported` is false, so the caller can say so in the UI.
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
        sheet.replaceSync(buildCss('auto'));
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

  /**
   * Swaps the strength of the fill and underlines in place (same stylesheet, no repaint needed).
   * See HighlightStyleMode; an unknown value is ignored.
   */
  setStyle(style: HighlightStyleMode): void {
    if (!this.supported || !this.sheet) return;
    if (style !== 'auto' && style !== 'normal' && style !== 'strong') return;
    try {
      this.sheet.replaceSync(buildCss(style));
    } catch {
      // keep the previous rules
    }
  }

  /** Replace-all: afterwards exactly `entries` are painted (colour(+kind) groups, plus the active one). */
  paint(entries: readonly PaintEntry[]): void {
    if (!this.supported || !this.registry || !this.HighlightCtor) return;
    try {
      this.adopt();
      this.entries = new Map();
      const byName = new Map<string, Range[]>();
      for (const entry of entries) {
        if (entry.range.collapsed) continue;
        this.entries.set(entry.id, entry);
        // An unknown kind (untrusted/stale data) degrades to the plain colour fill.
        const kind = entry.kind && HIGHLIGHT_KINDS.includes(entry.kind) ? entry.kind : undefined;
        const name = nameFor(entry.color, kind);
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
