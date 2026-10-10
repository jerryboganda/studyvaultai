import { HOST_ATTRIBUTE } from '@highlights';
import { elementOf, isInsideHost } from './eligibility';

/** Same set the text stream skips (ADR-004), plus <head>: none of it can change an anchor. */
const INERT =
  'head, script, style, noscript, template, textarea, select, option, iframe, object, canvas, svg';

const isHostNode = (n: Node): boolean =>
  n.nodeType === 1 && (n as Element).hasAttribute(HOST_ATTRIBUTE);

/** Added/removed node that can contribute text to the stream. */
function carriesText(n: Node): boolean {
  if (n.nodeType === 3) return true;
  if (n.nodeType !== 1) return false; // comments etc.
  const el = n as Element;
  return !isHostNode(n) && el.closest(INERT) === null;
}

/**
 * Can this mutation change what the text stream (and so any anchor) looks like? Our own overlay,
 * <head>, scripts, styles and form controls cannot. Filtering them keeps analytics tags and
 * CSS-in-JS from spending the bounded retry budget before the real content has arrived.
 */
export function affectsPageText(r: MutationRecord): boolean {
  if (isInsideHost(r.target)) return false;
  if (elementOf(r.target)?.closest(INERT)) return false;
  if (r.type === 'characterData') return true;
  return Array.from(r.addedNodes).some(carriesText) || Array.from(r.removedNodes).some(carriesText);
}
