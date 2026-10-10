const MAX_LEVELS = 8;
const MAX_CHARS = 1024; // HtmlAnchorSet.structuralPath max

function quoteAttr(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, ' ')}"`;
}

function nthOfType(el: Element): number {
  let n = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.localName === el.localName && s.namespaceURI === el.namespaceURI) n++;
  }
  return n;
}

/**
 * Tag/nth-of-type chain (<= 8 levels, stopping at the first element with an id), as a valid CSS
 * selector. A hint only: DOM structure changes between visits, so resolution never trusts it.
 * Never throws; returns null when there is nothing useful to say.
 */
export function structuralPath(el: Element | null | undefined): string | null {
  try {
    if (!el || el.nodeType !== 1) return null;
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && depth < MAX_LEVELS; depth++) {
      const id = cur.getAttribute('id');
      if (id) {
        parts.unshift(`${cur.localName}[id=${quoteAttr(id)}]`);
        break;
      }
      parts.unshift(`${cur.localName}:nth-of-type(${nthOfType(cur)})`);
      cur = cur.parentElement;
    }
    const path = parts.join(' > ');
    return path.length > 0 && path.length <= MAX_CHARS ? path : null;
  } catch {
    return null;
  }
}
