import type { PDFPageProxy } from 'pdfjs-dist';
import { loadPdfjs, type TextContent } from './engine';
import { createLinkLayer } from './linkLayer';
import { NO_LINKS, type PageLink, type PageLinks } from './links';
import type { PageText } from './pageText';
import type { PageDom } from './selection';

/**
 * Draws one page into a host element: canvas (pdf.js), selectable text layer (pdf.js TextLayer,
 * re-ordered into stream order) and three empty overlay layers owned by the caller (highlights,
 * search matches, the pending selection). Runs in a browser; jsdom has no canvas or layout, so the
 * pure parts (`orderTextLayer`) are unit-tested and the rest is covered by the browser e2e.
 */

/** Largest canvas the reader will allocate (pixels); the output scale is reduced to fit. */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** CSS px per PDF unit at 100% zoom (PDF points are 1/72 in, CSS px are 1/96 in). */
export const CSS_UNITS = 96 / 72;

export interface PageLayers {
  highlights: HTMLElement;
  find: HTMLElement;
  pending: HTMLElement;
  /** The page's link anchors (linkLayer.ts), above the text layer. */
  links: HTMLElement;
}

export interface RenderedPage {
  dom: PageDom;
  layers: PageLayers;
  destroy(): void;
}

export interface RenderArgs {
  pdfPage: PDFPageProxy;
  content: TextContent;
  pageText: PageText;
  pageNumber: number;
  host: HTMLElement;
  /** CSS px per PDF unit (zoom * CSS_UNITS). */
  scale: number;
  /** Absolute viewport rotation: the page's own /Rotate plus the reader's rotation. */
  rotation: number;
  signal: AbortSignal;
  /** The page's link annotations (none: no link layer content). */
  links?: PageLinks;
  /** A link was clicked or activated from the keyboard; following it is the caller's decision. */
  onLink?(link: PageLink): void;
}

/**
 * Put the text-layer spans into stream order (so a browser selection is contiguous in the stream) and
 * a `<br>` after each visual line (so copy/paste keeps line breaks). Returns the span <-> item maps.
 */
export function orderTextLayer(
  layer: HTMLElement,
  textDivs: readonly HTMLElement[],
  pt: PageText,
): { itemOf: Map<Node, number>; spanOf: Map<number, HTMLElement> } {
  const doc = layer.ownerDocument;
  const itemOf = new Map<Node, number>();
  const spanOf = new Map<number, HTMLElement>();
  textDivs.forEach((div, i) => {
    itemOf.set(div, i);
    spanOf.set(i, div);
  });
  const frag = doc.createDocumentFragment();
  const placed = new Set<number>();
  pt.order.forEach((item, k) => {
    const span = spanOf.get(item);
    if (!span) return;
    placed.add(item);
    frag.append(span);
    if (pt.lineEnds.has(k)) {
      const br = doc.createElement('br');
      br.setAttribute('role', 'presentation');
      frag.append(br);
    }
  });
  // Items with unusable geometry are not in the stream; keep them (and their text) where they were.
  textDivs.forEach((div, i) => {
    if (!placed.has(i) && div.parentNode === layer) frag.append(div);
  });
  layer.replaceChildren(frag);
  return { itemOf, spanOf };
}

// ---------------------------------------------------------------------------------------------
// Drag selection. The text layer ends in an empty "end of content" element that, while the pointer
// is down, covers the layer so a drag that leaves the text cannot jump the selection to the end of
// the page. It sits BELOW the text spans (reader.css gives spans z-index 1; without that it covered
// them and a mouse drag selected nothing, verified in Chromium) and, as pdf.js does, is kept right
// after the selection's moving end so a gap resolves to the selection's own edge.
// ---------------------------------------------------------------------------------------------

const guardedLayers = new Map<HTMLElement, HTMLElement>();
const guardedDocs = new WeakSet<Document>();

function resetEnd(end: HTMLElement, layer: HTMLElement): void {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  layer.classList.remove('selecting');
}

function guardSelection(doc: Document): void {
  if (guardedDocs.has(doc)) return;
  guardedDocs.add(doc);
  let pointerDown = false;
  let previous: Range | null = null;
  const resetAll = (): void => guardedLayers.forEach(resetEnd);
  doc.addEventListener('pointerdown', () => {
    pointerDown = true;
  });
  doc.addEventListener('pointerup', () => {
    pointerDown = false;
    resetAll();
  });
  doc.defaultView?.addEventListener('blur', () => {
    pointerDown = false;
    resetAll();
  });
  doc.addEventListener('keyup', () => {
    if (!pointerDown) resetAll();
  });
  doc.addEventListener('selectionchange', () => {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0) {
      guardedLayers.forEach((_end, layer) => layer.classList.remove('selecting'));
      return;
    }
    const active = new Set<HTMLElement>();
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      for (const layer of guardedLayers.keys()) {
        if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
      }
    }
    for (const [layer, end] of guardedLayers) {
      if (active.has(layer)) layer.classList.add('selecting');
      else resetEnd(end, layer);
    }
    const range = selection.getRangeAt(0);
    let modifyStart = false;
    try {
      modifyStart =
        previous !== null &&
        (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
    } catch {
      /* the previous range lives in a tree that was redrawn: treat the end as the moving one */
    }
    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (anchor && !modifyStart && range.endOffset === 0) {
      // The range ends at the very start of a node: the last selected text is the previous one.
      do {
        while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor?.previousSibling ?? null;
      } while (anchor && anchor.childNodes.length === 0);
    }
    const layer = (anchor?.parentElement ?? null)?.closest<HTMLElement>('.sv-textlayer');
    const end = layer ? guardedLayers.get(layer) : undefined;
    if (layer && end && anchor?.parentElement) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    previous = range.cloneRange();
  });
}

export async function renderPageInto(args: RenderArgs): Promise<RenderedPage> {
  const { pdfPage, content, pageText, host, scale, rotation, signal } = args;
  const pdfjs = await loadPdfjs();
  const doc = host.ownerDocument;
  const cssViewport = pdfPage.getViewport({ scale, rotation });
  const width = cssViewport.width;
  const height = cssViewport.height;
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;

  const dpr = doc.defaultView?.devicePixelRatio || 1;
  const outputScale = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height)));
  const canvas = doc.createElement('canvas');
  canvas.className = 'sv-pdf-canvas';
  canvas.width = Math.max(1, Math.floor(width * outputScale));
  canvas.height = Math.max(1, Math.floor(height * outputScale));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  // The canvas is a picture of the page; the text layer is what assistive technology reads.
  canvas.setAttribute('aria-hidden', 'true');

  const textLayer = doc.createElement('div');
  textLayer.className = 'sv-textlayer';
  // pdf.js sizes text with --total-scale-factor (scale * the page's /UserUnit, normally 1).
  const total = scale * cssViewport.userUnit;
  textLayer.style.setProperty('--total-scale-factor', String(total));

  const layer = (name: string): HTMLElement => {
    const el = doc.createElement('div');
    el.className = `sv-pdf-layer sv-pdf-layer--${name}`;
    return el;
  };
  const listener = new AbortController();
  const linkLayer = createLinkLayer(host, listener.signal, (link) => args.onLink?.(link));
  const layers: PageLayers = {
    highlights: layer('highlights'),
    find: layer('find'),
    pending: layer('pending'),
    links: linkLayer.el,
  };

  const cleanup = (): void => {
    guardedLayers.delete(textLayer);
    listener.abort();
    canvas.width = 0;
    canvas.height = 0;
    host.replaceChildren();
    pdfPage.cleanup();
  };

  host.replaceChildren(
    canvas,
    layers.find,
    textLayer,
    layers.links,
    layers.pending,
    layers.highlights,
  );

  const renderTask = pdfPage.render({
    canvas,
    viewport: pdfPage.getViewport({ scale: scale * outputScale, rotation }),
  });
  const onAbort = (): void => renderTask.cancel();
  signal.addEventListener('abort', onAbort, { once: true });

  const layout = new pdfjs.TextLayer({
    textContentSource: content,
    container: textLayer,
    viewport: cssViewport,
  });
  // setLayerDimensions uses CSS round(); sizes are set in plain px so Chrome 120-124 lay it out too.
  const raw = cssViewport.rawDims as { pageWidth: number; pageHeight: number };
  textLayer.style.width = `${raw.pageWidth * total}px`;
  textLayer.style.height = `${raw.pageHeight * total}px`;

  try {
    await Promise.all([renderTask.promise, layout.render()]);
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) {
    cleanup();
    throw new DOMException('Render cancelled.', 'AbortError');
  }

  const { itemOf, spanOf } = orderTextLayer(textLayer, layout.textDivs, pageText);
  const end = doc.createElement('div');
  end.className = 'endOfContent';
  textLayer.append(end);
  // While the pointer is down the end-of-content sentinel covers the layer (see guardSelection).
  guardSelection(doc);
  guardedLayers.set(textLayer, end);
  textLayer.addEventListener('mousedown', () => textLayer.classList.add('selecting'), {
    signal: listener.signal,
  });
  linkLayer.paint(args.links ?? NO_LINKS, rotation, args.pageNumber);

  return {
    dom: {
      pageNumber: args.pageNumber,
      pageEl: host,
      textLayer,
      itemOf,
      spanOf,
      text: pageText,
      rotation,
    },
    layers,
    destroy: cleanup,
  };
}
