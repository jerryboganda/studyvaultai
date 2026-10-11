import type { MarkedExtension, Tokens } from 'marked';

/**
 * TeX in Markdown (`$x^2$`, `$$ ... $$`), shown as its own source text. ADR-015 records why this is
 * not a typeset renderer: the smallest MIT TeX-to-MathML library measured 164 KB minified, over the
 * 120 KB ceiling, and the shared extension total is within 14 KB of its budget.
 *
 * What this does: the span is lifted out BEFORE Markdown sees it, so `_`, `*`, `\`, `<` and `&` in a
 * formula are not read as emphasis, escapes, HTML or entities, and it is emitted as
 * `<code class="math">` with its delimiters, so copy, search, export and backup see exactly what was
 * typed. Nothing is evaluated, fetched or interpreted (`\href`, `\url`, `\includegraphics` are text).
 *
 * Delimiter rules (pandoc's, so "costs $5 and $10" is not math):
 *  - `$` opens only if the next character is not whitespace; it closes only if the previous one is
 *    not whitespace and the next one is not a digit. A backslash escapes the next character inside.
 *  - inline math stays on one line and is at most MATH_INLINE_MAX characters.
 *  - `$$ ... $$` may span lines and blank lines; as a block it must start a line and end its closing
 *    line; the same span inside a paragraph is displayed too. At most MATH_DISPLAY_MAX characters.
 *  - an unmatched or over-long span is ordinary text. `\$` is a literal dollar sign (Markdown escape).
 */
export const MATH_INLINE_MAX = 500;
export const MATH_DISPLAY_MAX = 10_000;
/** How far ahead a paragraph is searched for the start of a `$$` block (bounds the work per call). */
const START_WINDOW = 2_000;

// `(?:\\.|[^\\$\n])` and `(?:\\[\s\S]|(?!\$\$)[^\\])` are unambiguous at their first character, so the
// engine never backtracks exponentially; each attempt is bounded by the caps above.
const INLINE_BODY = String.raw`\$(?![\s$])(?:\\.|[^\\$\n]){1,${MATH_INLINE_MAX}}?(?<!\s)\$(?!\d)`;
const DISPLAY_BODY = String.raw`\$\$(?:\\[\s\S]|(?!\$\$)[^\\]){1,${MATH_DISPLAY_MAX}}\$\$`;
const INLINE = new RegExp(`^${INLINE_BODY}`);
const DISPLAY = new RegExp(`^${DISPLAY_BODY}`);
const BLOCK = new RegExp(String.raw`^ {0,3}${DISPLAY_BODY}[ \t]*(?:\n|$)`);
const ANY_SPAN = new RegExp(`${DISPLAY_BODY}|${INLINE_BODY}`, 'g');
const BLANK_LINE = /\n[ \t]*\n/;
const BLOCK_LINE = /\n {0,3}\$\$/;

/** Same length as the input, so em/strong delimiter positions stay aligned with the source. */
export const maskMath = (src: string): string =>
  src.includes('$') ? src.replace(ANY_SPAN, (m) => 'a'.repeat(m.length)) : src;

const hasContent = (span: string, delimiter: number): boolean =>
  /\S/.test(span.slice(delimiter, span.length - delimiter));

/** A complete `$$` block at the start of `src` whose body is not blank, or undefined. */
function blockAt(src: string): RegExpExecArray | undefined {
  const m = BLOCK.exec(src);
  return m && hasContent(m[0].trim(), 2) ? m : undefined;
}

/** `escape` HTML-escapes text; the renderer's own function, so there is one definition of "safe text". */
export function mathExtension(escape: (text: string) => string): MarkedExtension {
  return {
    hooks: { emStrongMask: maskMath },
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        // Cut a running paragraph where a complete `$$` block begins, so `+ c` or `- c` lines inside a
        // formula are not read as a list. Only a complete block counts (a stray `$$` splits nothing),
        // only the first candidate of the paragraph is looked at, and the look is windowed: marked
        // calls this once per paragraph or list line, so the work must not grow with the document.
        start(src) {
          const head = src.slice(0, START_WINDOW);
          const blank = head.search(BLANK_LINE); // a paragraph ends at its first blank line
          const para = blank < 0 ? head : head.slice(0, blank);
          // A candidate needs a newline before it: index 0 of marked's slice may be mid-line.
          const at = BLOCK_LINE.exec(para)?.index;
          return at !== undefined && blockAt(src.slice(at + 1)) ? at + 1 : undefined;
        },
        tokenizer(src): Tokens.Generic | undefined {
          const m = blockAt(src);
          return m ? { type: 'mathBlock', raw: m[0], text: m[0].trim() } : undefined;
        },
        renderer: (token) =>
          `<p><code class="math math-display">${escape(token.text as string)}</code></p>\n`,
      },
      {
        name: 'mathInline',
        level: 'inline',
        start(src) {
          const i = src.indexOf('$');
          return i < 0 ? undefined : i;
        },
        tokenizer(src): Tokens.Generic | undefined {
          const display = DISPLAY.exec(src);
          const m = display ?? INLINE.exec(src);
          if (!m) return undefined;
          if (display && !hasContent(m[0], 2)) return undefined;
          return { type: 'mathInline', raw: m[0], text: m[0] };
        },
        renderer: (token) => {
          const text = token.text as string;
          const cls = text.startsWith('$$') ? 'math math-display' : 'math';
          return `<code class="${cls}">${escape(text)}</code>`;
        },
      },
    ],
  };
}
