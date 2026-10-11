import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { inlineBudget, renderBudget, type BudgetReason } from './markdownBudget';
import { maskMath, mathExtension } from './markdownMath';
import { typesetMath } from './mathLoader';

/**
 * Notes are user-typed Markdown (DATA_MODEL: Note.body) and must be rendered through a sanitiser.
 * Pipeline: marked (GFM) -> DOMPurify with a strict allow-list -> DocumentFragment. Raw HTML in the
 * source never reaches the parser's output as markup (it is turned into visible text first), images
 * are not loaded (their alt text is shown), only http(s) links survive, and every link opens in a new
 * tab with rel="noopener noreferrer". The result is a node tree, not an HTML string, so no
 * `innerHTML` is involved on the page.
 *
 * TeX (`$...$`, `$$...$$`) comes out of that pipeline as its source text in `<code class="math">`
 * (markdownMath.ts, ADR-015); `class` is the one extra attribute, kept only on `code` with exactly
 * those values. A last, separate step (mathLoader.ts) swaps the formulas for typeset MathML once the
 * lazily loaded typesetter is there; the MathML never passes through this file's sanitiser, it has its
 * own allow-list (mathTypeset.ts), and the source text stays when anything is refused.
 *
 * Rendering is bounded in time (markdownBudget.ts). marked is quadratic or worse on some inputs, and a
 * note may be 100,000 characters, so the text is measured first and, when it is over budget, shown as
 * plain text with a note saying so. `renderMarkdown` never throws and never takes longer than the
 * budget allows, whatever the text.
 */

const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];
const ALLOWED_ATTR = ['href', 'title', 'start', 'class'];
const MATH_CLASSES = new Set(['math', 'math math-display']);

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const parser = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  ...mathExtension(escapeHtml),
  renderer: {
    // Raw HTML is data, not markup: show it literally.
    html: (token) => escapeHtml(token.text),
    // Nothing is fetched on the user's behalf: show the alt text instead of an <img>.
    image: (token) => escapeHtml(token.text),
  },
});

let purifier: ReturnType<typeof DOMPurify> | null = null;

function getPurifier() {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  instance.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    if (node.nodeName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    // marked also emits class="language-x" on fenced code: only our own math classes survive.
    if (node.hasAttribute('class')) {
      const keep = node.nodeName === 'CODE' && MATH_CLASSES.has(node.getAttribute('class') ?? '');
      if (!keep) node.removeAttribute('class');
    }
  });
  purifier = instance;
  return instance;
}

function sanitise(html: string): DocumentFragment {
  return getPurifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Absolute http(s) only: no javascript:, data:, blob:, mailto: or relative addresses.
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM_FRAGMENT: true,
  });
}

/** Shown above text that was not formatted. Plain words: it is read by assistive technology as is. */
export const FALLBACK_NOTE = 'Shown as plain text because it is too complex to format.';
/** A text longer than this is cut when shown as plain text (notes are capped at 100,000). */
export const FALLBACK_MAX_CHARS = 200_000;

/**
 * The text itself, as text, with its line breaks, and a visible note saying it was not formatted. Built
 * from DOM text nodes, so nothing in the source is read as markup and no sanitiser is needed.
 */
function plainText(source: string, reason: BudgetReason | 'error'): DocumentFragment {
  const cut = source.length > FALLBACK_MAX_CHARS;
  let shown = cut ? source.slice(0, FALLBACK_MAX_CHARS) : source;
  // do not end on half of a surrogate pair
  if (cut && /[\ud800-\udbff]$/.test(shown)) shown = shown.slice(0, -1);
  const note = document.createElement('p');
  note.className = 'md-fallback-note';
  note.textContent = cut
    ? `${FALLBACK_NOTE} Only the first ${FALLBACK_MAX_CHARS.toLocaleString('en-US')} characters are shown.`
    : FALLBACK_NOTE;
  const pre = document.createElement('pre');
  pre.className = 'md-fallback';
  // resolved from the note's own text, not from the page that hosts it
  pre.dir = 'auto';
  pre.dataset.reason = reason;
  pre.textContent = shown;
  const fragment = document.createDocumentFragment();
  fragment.append(note, pre);
  return fragment;
}

type Bounded = { html: string } | { reason: BudgetReason | 'error' };

/**
 * marked's two passes with the budget between them. `Marked#parse` is `lex` then `parser`, and `lex`
 * is `blockTokens` then `inlineTokens` over `inlineQueue`; running the passes here, the queue is the
 * list of exactly the runs the second pass will scan, which is what `inlineBudget` measures. No
 * extension queues runs of its own, so the queue after the block pass is complete. The output equals
 * `parser.parse(source)` (markdownRender.budget.test.ts compares them).
 */
function parseBounded(source: string): Bounded {
  const raw = renderBudget(source);
  if (!raw.ok) return { reason: raw.reason ?? 'too-complex' };
  try {
    const lexer = new parser.Lexer(parser.defaults);
    lexer.blockTokens(source.replace(/\r\n|\r/g, '\n'), lexer.tokens);
    const inline = inlineBudget(
      lexer.inlineQueue.map((run) => run.src),
      raw.micros,
      maskMath,
    );
    if (!inline.ok) return { reason: inline.reason ?? 'too-complex' };
    for (let i = 0; i < lexer.inlineQueue.length; i++) {
      const run = lexer.inlineQueue[i]!;
      lexer.inlineTokens(run.src, run.tokens);
    }
    return { html: parser.parser(lexer.tokens, parser.defaults) as string };
  } catch {
    // A stack overflow in a very deeply nested text, or marked's own "infinite loop" guard.
    return { reason: 'error' };
  }
}

/**
 * The typeset step. It runs on the sanitised tree and after every size check (the two budget passes
 * and the formula cap in mathBudget), and nothing it does can fail the render: a throw leaves the
 * formulas that were not replaced as source text.
 */
function withMath(fragment: DocumentFragment, onMathReady?: () => void): DocumentFragment {
  try {
    typesetMath(fragment, onMathReady);
  } catch {
    // the source text is a complete rendering
  }
  return fragment;
}

/**
 * The sanitised node tree for `source`. Requires a DOM (extension pages, jsdom). Never throws and is
 * bounded in time: text that is too long, too deeply nested or too expensive for marked comes back
 * as plain text with a note (`FALLBACK_NOTE`), see markdownBudget.ts.
 *
 * Formulas are typeset when the typesetter is already loaded. When it is not, they are returned as
 * source text, the load is started, and `onMathReady` (if given) is called once it has finished
 * loading: the caller renders again and gets the typeset version. It is not called when there is no
 * formula, when the load fails, or when the typesetter was already there.
 */
export function renderMarkdown(source: string, onMathReady?: () => void): DocumentFragment {
  const text = typeof source === 'string' ? source : '';
  const bounded = parseBounded(text);
  if ('html' in bounded) {
    let fragment: DocumentFragment;
    try {
      fragment = sanitise(bounded.html);
    } catch {
      return plainText(text, 'error');
    }
    return withMath(fragment, onMathReady);
  }
  return plainText(text, bounded.reason);
}

/**
 * The one-call marked pipeline, with no budget. Tests use it as the reference that the bounded
 * pipeline must equal for text that is within budget (formulas included: same typeset step). Never
 * call it on user text.
 */
export function renderMarkdownUnbounded(source: string): DocumentFragment {
  return withMath(sanitise(parser.parse(source) as string));
}

/** Same output as markup text; for tests and for places that need a string. */
export function renderMarkdownToHtml(source: string): string {
  const holder = document.createElement('div');
  holder.append(renderMarkdown(source));
  return holder.innerHTML;
}
