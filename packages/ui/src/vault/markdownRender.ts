import DOMPurify from 'dompurify';
import { Marked } from 'marked';

/**
 * Notes are user-typed Markdown (DATA_MODEL: Note.body) and must be rendered through a sanitiser.
 * Pipeline: marked (GFM) -> DOMPurify with a strict allow-list -> DocumentFragment. Raw HTML in the
 * source never reaches the parser's output as markup (it is turned into visible text first), images
 * are not loaded (their alt text is shown), only http(s) links survive, and every link opens in a new
 * tab with rel="noopener noreferrer". The result is a node tree, not an HTML string, so no
 * `innerHTML` is involved on the page.
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
const ALLOWED_ATTR = ['href', 'title', 'start'];

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
    if (node.nodeName === 'A' && node instanceof Element && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  purifier = instance;
  return instance;
}

/** The sanitised node tree for `source`. Requires a DOM (extension pages, jsdom). */
export function renderMarkdown(source: string): DocumentFragment {
  const html = parser.parse(source) as string;
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

/** Same output as markup text; for tests and for places that need a string. */
export function renderMarkdownToHtml(source: string): string {
  const holder = document.createElement('div');
  holder.append(renderMarkdown(source));
  return holder.innerHTML;
}
