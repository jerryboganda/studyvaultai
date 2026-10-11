import DOMPurify, { type Config } from 'dompurify';
import temml from 'temml';
import { MATH_MAX_FORMULA_CHARS } from './markdownBudget';
import './math.css';

/**
 * TeX -> MathML for the Markdown renderer (ADR-015). This module is the lazy part: it is only ever
 * reached through `import()` in mathLoader.ts, the first time a note holds a formula, so pages without
 * math never load temml.
 *
 * The pipeline, and what each stage refuses (a formula that fails any stage is shown as its source
 * text by the caller; nothing is ever half-typeset):
 *
 *  1. Pre-checks on the TeX: a length cap and no macro-definition or expansion-control primitives.
 *     Definitions are the only way temml can multiply its own output (a 5,000-character body used a
 *     thousand times is five million tokens), and a formula never needs one: macros do not outlive a
 *     formula, so each `$...$` is self-contained.
 *  2. temml 0.14.0 with `trust: false` (\includegraphics), `strict: true` (\class, \id, \style and
 *     \data are refused, and so is Unicode it would only guess at), `throwOnError: true` (an error
 *     throws instead of producing a styled error span), and `maxExpand`/`maxSize` limits. `render` is
 *     used, not `renderToString`: it builds nodes with createElementNS and the CSSOM, so no HTML parser
 *     is involved (no mutation-XSS, no parser depth limit) and no `style=""` markup is parsed under
 *     the page's `style-src 'self'`.
 *  3. DOMPurify, in place, with an explicit allow-list of MathML elements and attributes. Anything it
 *     removes (`DOMPurify.removed`) rejects the formula: a dropped element would change the mathematics.
 *  4. `admit`: a second, independent walk that checks what DOMPurify's name lists cannot: every element
 *     is in the MathML namespace, attribute and `style` VALUES match closed patterns, only the classes
 *     that math.css defines are kept, text appears only in token elements, and the tree is no larger
 *     or deeper than a formula needs.
 *
 * No `semantics`/`annotation`: MathML Core renders only the first child of `semantics`, so a TeX
 * annotation is `display: none` and never reaches assistive technology; it would also be the classic
 * vehicle for namespace-confusion attacks. Chromium maps `math` and its children to the accessibility
 * tree, which is what a screen reader reads; no `aria-label` is added because it would replace that
 * structure with the TeX source (ADR-015, "Accessibility").
 */

export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/**
 * Output limits per formula. Real formulas are well under both (a 6x6 matrix is about 150 elements);
 * a dense 1,000-character formula is about 1,000, and each element costs about 85 us (markdownBudget.ts).
 */
export const MAX_ELEMENTS = 2_000;
export const MAX_DEPTH = 40;

/** Elements temml emits for ordinary mathematics. Chromium has no `menclose`: math.css draws its boxes. */
const TAGS = [
  'math',
  'mrow',
  'mi',
  'mn',
  'mo',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mtable',
  'mtr',
  'mtd',
  'mover',
  'munder',
  'munderover',
  'mstyle',
  'mpadded',
  'mphantom',
  'menclose',
  'mmultiscripts',
  'mprescripts',
  'none',
];
const TAG_SET: ReadonlySet<string> = new Set(TAGS);
/** The only elements that hold text. */
const TEXT_TAGS: ReadonlySet<string> = new Set(['mi', 'mn', 'mo', 'mtext']);

const NUM = String.raw`[+-]?(?:\d{1,3}(?:\.\d{1,6})?|\.\d{1,6})`;
const pattern = (body: string) => new RegExp(`^(?:${body})$`);
/** A MathML length: `0.2778em`, `-1width`, `0.1px`, `0`. */
const MML_LENGTH = pattern(`${NUM}(?:em|ex|px|pt|%|width|height|depth)?`);
const BOOLEAN = pattern('true|false');

/**
 * Attribute name -> allowed value. This is every attribute temml 0.14.0 puts on the elements above for
 * the constructs it can be asked for here (measured over a corpus of about 90 formulas and the
 * `setAttribute` sites of its source). Missing on purpose: href, id, title, actiontype, encoding,
 * xmlns, mathcolor, mathbackground (colours are not carried: they would ignore the theme, and
 * `\color` falls back to source text), and everything from `\tag`/`\label`/`\ref`.
 */
const ATTRIBUTES: ReadonlyMap<string, RegExp> = new Map([
  ['display', pattern('block|inline')],
  [
    'mathvariant',
    pattern(
      'normal|bold|italic|bold-italic|double-struck|fraktur|bold-fraktur|script|bold-script|' +
        'sans-serif|bold-sans-serif|sans-serif-italic|sans-serif-bold-italic|monospace',
    ),
  ],
  ['displaystyle', BOOLEAN],
  ['scriptlevel', pattern(String.raw`[+-]?\d{1,2}`)],
  ['fence', BOOLEAN],
  ['stretchy', BOOLEAN],
  ['separator', BOOLEAN],
  ['symmetric', BOOLEAN],
  ['movablelimits', BOOLEAN],
  ['largeop', BOOLEAN],
  ['accent', BOOLEAN],
  ['form', pattern('prefix|infix|postfix')],
  ['linebreak', pattern('newline|nobreak|auto|goodbreak|badbreak')],
  ['lspace', MML_LENGTH],
  ['rspace', MML_LENGTH],
  ['width', MML_LENGTH],
  ['height', MML_LENGTH],
  ['depth', MML_LENGTH],
  ['voffset', MML_LENGTH],
  ['minsize', MML_LENGTH],
  ['maxsize', MML_LENGTH],
  ['linethickness', MML_LENGTH],
  ['mathsize', MML_LENGTH],
  [
    'notation',
    pattern(
      '(?:top|bottom|box|horizontalstrike|updiagonalstrike downdiagonalstrike|updiagonalstrike|downdiagonalstrike)',
    ),
  ],
]);

/**
 * `style` declarations temml sets through the CSSOM: spacing around cells and boxes, rules of arrays and
 * `\boxed`, `\pmb`'s weight, and the `math-depth` of fractions and accents. Nothing else: no colour, no
 * position, no display, no transform, no url(). A value has no parenthesis, quote, backslash or colon,
 * so no function or URL can occur in one.
 */
const CSS_LENGTH = `${NUM}(?:em|ex|px|pt|%)?`;
const CSS_SINGLE = pattern(CSS_LENGTH);
const CSS_BOX = pattern(`${CSS_LENGTH}(?: ${CSS_LENGTH}){0,3}`);
const CSS_RULE = pattern(`${NUM}(?:em|px|pt) (?:solid|double|dashed)(?: currentcolor)?`);
const STYLES: ReadonlyMap<string, RegExp> = new Map([
  ['padding', CSS_BOX],
  ['padding-top', CSS_SINGLE],
  ['padding-right', CSS_SINGLE],
  ['padding-bottom', CSS_SINGLE],
  ['padding-left', CSS_SINGLE],
  ['margin-left', CSS_SINGLE],
  ['margin-right', CSS_SINGLE],
  ['width', CSS_SINGLE],
  ['height', CSS_SINGLE],
  ['border', CSS_RULE],
  ['border-top', CSS_RULE],
  ['border-right', CSS_RULE],
  ['border-bottom', CSS_RULE],
  ['border-left', CSS_RULE],
  ['math-depth', pattern(String.raw`\d{1,2}`)],
  ['font-weight', pattern('bold')],
  ['text-align', pattern('left|right|center')],
]);

/** Classes that math.css defines. Anything else with meaning is refused; see DROPPED. */
const KEPT_CLASSES: ReadonlySet<string> = new Set([
  'tml-left',
  'tml-right',
  'tml-jot',
  'tml-small',
  'tml-sml-pad',
  'tml-med-pad',
  'tml-lrg-pad',
  'chr-sml',
  'chr-med',
  'chr-lrg',
  'chr-sml-vec',
  'chr-med-vec',
  'chr-lrg-vec',
  'tml-overline',
  'tml-underline',
  'tml-fbox',
  'tml-cancel',
  'upstrike',
  'downstrike',
  'sout',
  'tml-xcancel',
  'tml-hat-1',
  'tml-hat-2',
  'tml-hat-3',
  'tml-hat-4',
  'tml-tilde-2',
  'tml-tilde-3',
  'tml-tilde-4',
]);
/**
 * Classes temml adds for other engines or for features that are not carried here (equation numbers,
 * labels, the Temml font). They carry no meaning in Chromium, so they are removed, not refused.
 */
const DROPPED =
  /^(?:wbk-[a-z0-9-]+|tml-(?:display|prime|vec|tag|tageqn|eqn|label)|mathcal|mathscr)$/;

/**
 * TeX that defines or controls the expansion of macros. Refused so that a formula cannot make temml
 * build more output than its source is long (see the header). `\\newcommand` and friends included.
 */
const MACRO_PRIMITIVES =
  /\\(?:global|long|outer|[gex]?def|let|futurelet|(?:re|provide)?newcommand|expandafter|noexpand|csname|endcsname)(?![A-Za-z])/;

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** Its own instance: markdownRender.ts's hooks (links, the `math` code class) must not see MathML. */
const getPurifier = () => (purifier ??= DOMPurify(window));

const SANITISER_CONFIG = {
  // `#text` is a node name to DOMPurify: without it every text node of a formula would be removed
  ALLOWED_TAGS: [...TAGS, '#text'],
  ALLOWED_ATTR: [...ATTRIBUTES.keys(), 'class', 'style'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: false,
  // The node is sanitised where it is: no clone into another document, no wrapper element that
  // would show up in `removed`, and the result is the same element the caller built.
  IN_PLACE: true,
} satisfies Config;

function styleAdmitted(text: string): boolean {
  for (const declaration of text.split(';')) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(':');
    if (colon < 0) return false;
    const rule = STYLES.get(declaration.slice(0, colon).trim().toLowerCase());
    if (!rule?.test(declaration.slice(colon + 1).trim())) return false;
  }
  return true;
}

/** True when the element is allowed to stay; removes the classes that are meaningless here. */
function elementAdmitted(el: Element): boolean {
  if (el.namespaceURI !== MATHML_NS || !TAG_SET.has(el.localName)) return false;
  for (const attr of Array.from(el.attributes)) {
    // no namespaced attribute (xlink:href, xmlns:*) whatever its name
    if (attr.namespaceURI !== null || attr.prefix !== null) return false;
    const name = attr.localName;
    if (name === 'class') {
      for (const token of attr.value.split(/\s+/).filter(Boolean)) {
        if (KEPT_CLASSES.has(token)) continue;
        if (!DROPPED.test(token)) return false;
        el.classList.remove(token);
      }
      if (!el.classList.length) el.removeAttribute('class');
    } else if (name === 'style') {
      if (!styleAdmitted(attr.value)) return false;
    } else if (!ATTRIBUTES.get(name)?.test(attr.value)) {
      return false;
    }
  }
  return true;
}

/**
 * The whole tree under `root` is MathML that this module understands, within the size limits. Pure
 * check (apart from dropping the classes above): nothing is repaired, so a tree that is not exactly
 * right is refused as a whole.
 */
export function admit(root: Element): boolean {
  let count = 0;
  const stack: Array<[Element, number]> = [[root, 1]];
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [el, depth] = item;
    if (++count > MAX_ELEMENTS || depth > MAX_DEPTH) return false;
    if (!elementAdmitted(el)) return false;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1) stack.push([child as Element, depth + 1]);
      else if (child.nodeType !== 3 || !TEXT_TAGS.has(el.localName)) return false;
    }
  }
  // an empty <math> is what temml leaves when its only output was a node that is not MathML (\ref)
  return root.localName === 'math' && root.firstChild !== null;
}

/**
 * Sanitise a detached `<math>` element built by temml (or, in tests, by anything else) in place:
 * DOMPurify with the allow-list above, then `admit`. Returns the element, or null when anything at
 * all was removed or refused (the element must then be thrown away: it may be half-sanitised).
 */
export function cleanMath(root: Element): Element | null {
  const instance = getPurifier();
  try {
    instance.sanitize(root, SANITISER_CONFIG);
  } catch {
    // DOMPurify refuses an in-place root that is not an allowed element
    return null;
  }
  if (instance.removed.length > 0 || !admit(root)) return null;
  return root;
}

/** The typesetter handed to mathLoader.ts. `tex` has no `$` delimiters. */
export function typeset(tex: string, display: boolean): Element | null {
  if (!tex.trim() || tex.length > MATH_MAX_FORMULA_CHARS || MACRO_PRIMITIVES.test(tex)) return null;
  try {
    const math = document.createElementNS(MATHML_NS, 'math');
    temml.render(tex, math as unknown as MathMLElement, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: true,
      maxExpand: 1_000,
      // [em, pt]: the largest space or rule a formula may ask for
      maxSize: [10, 100],
    });
    // Numbered AMS environments (align, equation, gather) leave an empty <span class="tml-eqn"> in each
    // row, which temml's stylesheet turns into "(1)" with a CSS counter. Numbers are not carried (there
    // is no \ref), so the empty span is dropped; any other HTML node is still refused below.
    for (const span of Array.from(math.querySelectorAll('span.tml-eqn'))) {
      if (!span.firstChild) span.remove();
    }
    // An oversize result is refused before the sanitiser walks it: mhchem alone can turn 1,000
    // characters into thousands of nodes, and the walk is most of the cost per element.
    if (math.getElementsByTagName('*').length >= MAX_ELEMENTS) return null;
    if (display) math.setAttribute('display', 'block');
    return cleanMath(math);
  } catch {
    // a TeX error, a stack overflow in a very deep formula, or a refused node: the source stays
    return null;
  }
}
