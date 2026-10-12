import temml from 'temml';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HOSTILE_MARKDOWN } from './markdownHostile';
import {
  MATH_MAX_FORMULAS,
  MATH_MAX_FORMULA_CHARS,
  MATH_MAX_TOTAL_CHARS,
  RENDER_MAX_CHARS,
} from './markdownBudget';
import { installMathmlStyle } from './mathTestSupport';
import { loadMath, mathReady } from './mathLoader';
import { MATHML_NS } from './mathTypeset';
import { renderMarkdown, renderMarkdownToHtml, renderMarkdownUnbounded } from './markdownRender';

/**
 * Typeset TeX through the real renderer (ADR-015): marked, DOMPurify, the lazily loaded temml, jsdom.
 * The typesetter is loaded once up front; the loading behaviour itself is in mathLoader.test.ts and
 * Markdown.test.tsx. The source-text rendering is covered by markdownRender.test.ts.
 */

installMathmlStyle();

const HTML = new Set([
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
]);
const MATHML = new Set([
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
]);
const MATH_ATTRIBUTES = new Set([
  'display',
  'mathvariant',
  'displaystyle',
  'scriptlevel',
  'fence',
  'stretchy',
  'separator',
  'symmetric',
  'movablelimits',
  'largeop',
  'accent',
  'form',
  'linebreak',
  'lspace',
  'rspace',
  'width',
  'height',
  'depth',
  'voffset',
  'minsize',
  'maxsize',
  'linethickness',
  'mathsize',
  'notation',
  'class',
  'style',
]);
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * Everything the renderer promises, on the node tree: HTML elements are the sanitiser's list and in the
 * HTML namespace; MathML elements are the typesetter's list, in the MathML namespace, and only inside
 * a <math> element; attributes are the two lists; no handler, no link outside <a>, no `style` that
 * carries anything but spacing.
 */
function audit(source: string) {
  const holder = document.createElement('div');
  holder.append(renderMarkdown(source));
  for (const el of holder.querySelectorAll('*')) {
    const name = el.localName;
    const where = `<${name}> in ${JSON.stringify(source)}`;
    if (el.namespaceURI === MATHML_NS) {
      expect(MATHML.has(name), where).toBe(true);
      expect(el.closest('math'), where).not.toBeNull();
      for (const attr of el.attributes) {
        expect(MATH_ATTRIBUTES.has(attr.name), `${attr.name} on ${where}`).toBe(true);
      }
      expect(el.getAttribute('style') ?? '', where).not.toMatch(/url|\(|color|position|display/i);
    } else {
      expect(el.namespaceURI, where).toBe(XHTML_NS);
      expect(HTML.has(name), where).toBe(true);
      expect(el.closest('math'), where).toBeNull();
      for (const attr of el.attributes) {
        expect(attr.name.startsWith('on'), `${attr.name} in ${where}`).toBe(false);
        expect(['href', 'title', 'start', 'target', 'rel', 'class']).toContain(attr.name);
      }
      if (el.hasAttribute('class')) {
        expect(name, where).toBe('code');
        expect(['math', 'math math-display']).toContain(el.getAttribute('class'));
      }
    }
  }
  return holder;
}

beforeAll(async () => {
  await loadMath();
  expect(mathReady()).toBe(true);
});

afterEach(() => vi.restoreAllMocks());

describe('renderMarkdown with the typesetter loaded', () => {
  it('typesets inline math in place and keeps the sentence around it', () => {
    const holder = audit(String.raw`Euler: $e^{i\pi} + 1 = 0$ holds.`);
    expect(holder.querySelector('code.math')).toBeNull();
    const math = holder.querySelector('p > math')!;
    expect(math.namespaceURI).toBe(MATHML_NS);
    expect(math.hasAttribute('display')).toBe(false);
    expect(math.querySelector('msup')).not.toBeNull();
    expect(holder.querySelector('p')!.textContent).toBe('Euler: eiπ+1=0 holds.');
  });

  it('typesets display math as its own block between paragraphs', () => {
    const holder = audit(String.raw`Before

$$
\int_0^1 x\,dx = \frac{1}{2}
$$

After`);
    expect(holder.querySelector('code.math')).toBeNull();
    const math = holder.querySelector('math')!;
    expect(math.getAttribute('display')).toBe('block');
    expect(math.parentElement?.tagName).toBe('P');
    expect(math.querySelector('mfrac')).not.toBeNull();
    expect([...holder.querySelectorAll('p')].map((p) => p.textContent?.trim())).toEqual([
      'Before',
      '∫01xdx=12',
      'After',
    ]);
  });

  it('shows a display span inside a paragraph as display math', () => {
    const holder = audit('so $$x^2 + y^2$$ holds');
    expect(holder.querySelector('p > math')?.getAttribute('display')).toBe('block');
  });

  it('works inside emphasis, links, lists, quotes, tables and headings', () => {
    const holder = audit(
      [
        '*see $a_i$ now*',
        '',
        '- item $b_j$',
        '',
        '> $$',
        '> q^2',
        '> $$',
        '',
        '| h |',
        '|---|',
        '| $c_k$ |',
        '',
        '# Title $e_f$',
        '',
        '[$g_h$](https://example.com)',
      ].join('\n'),
    );
    expect(holder.querySelector('code.math')).toBeNull();
    expect(holder.querySelector('em > math')).not.toBeNull();
    expect(holder.querySelector('li > math')).not.toBeNull();
    expect(holder.querySelector('blockquote math[display="block"]')).not.toBeNull();
    expect(holder.querySelector('td > math')).not.toBeNull();
    expect(holder.querySelector('h1 > math')).not.toBeNull();
    expect(holder.querySelector('a > math')).not.toBeNull();
  });

  it('leaves what is not math alone: prices, escapes, code', () => {
    const holder = audit('It costs $5 and $10.\n\n\\$x\\$ and `$y_1$`\n\n```\n$$\nz\n$$\n```');
    expect(holder.querySelector('math')).toBeNull();
    expect(holder.querySelector('p code')?.textContent).toBe('$y_1$');
    expect(holder.querySelector('pre code')?.textContent).toBe('$$\nz\n$$\n');
    expect(holder.textContent).toContain('It costs $5 and $10.');
  });

  it('renders matrices with cell spacing from the CSSOM', () => {
    const holder = audit(String.raw`$$\begin{pmatrix} a & b \\ c & d \end{pmatrix}$$`);
    expect(holder.querySelectorAll('math mtr')).toHaveLength(2);
    expect(holder.querySelector('mtd')?.getAttribute('style')).toMatch(/padding-left/);
  });

  it('keeps a formula that typesets and the source text of one that does not, in one note', () => {
    const holder = audit(String.raw`$\frac{a}{b}$ and $\color{red}x$ and $\notacommand$`);
    expect(holder.querySelectorAll('math')).toHaveLength(1);
    expect([...holder.querySelectorAll('code.math')].map((c) => c.textContent)).toEqual([
      String.raw`$\color{red}x$`,
      String.raw`$\notacommand$`,
    ]);
  });

  it('equals the unbounded reference for text within budget, math included', () => {
    const note = String.raw`# Notes

Euler: $e^{i\pi}+1=0$ and prices $5 and $10.

$$
\sum_{i=1}^n i = \frac{n(n+1)}{2}
$$

| a | b |
|---|---|
| $x_1$ | **$y$** |
`;
    const bounded = document.createElement('div');
    bounded.append(renderMarkdown(note));
    const reference = document.createElement('div');
    reference.append(renderMarkdownUnbounded(note));
    expect(bounded.innerHTML).toBe(reference.innerHTML);
    expect(bounded.querySelectorAll('math')).toHaveLength(4);
  });

  it('serialises the typeset note for tests that need a string', () => {
    expect(renderMarkdownToHtml('$x$')).toBe('<p><math><mi>x</mi></math></p>\n');
  });
});

describe('the hostile battery with the typesetter loaded', () => {
  it.each(HOSTILE_MARKDOWN)('neutralises %s', (_name, source) => {
    const holder = audit(source);
    expect(
      holder.querySelector(
        'script, iframe, object, embed, style, form, svg, img, input, link, meta, base, annotation, annotation-xml, semantics, maction, mglyph, [onerror], [onclick], [onload], [href]:not(a)',
      ),
    ).toBeNull();
    // every link is a plain https one, from the Markdown itself
    for (const a of holder.querySelectorAll('a')) {
      const href = a.getAttribute('href');
      if (href !== null) expect(href).toMatch(/^https?:\/\//);
    }
    // and nothing was silently dropped: what was typed is still readable somewhere
    expect(holder.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('shows the markup typed inside \\text as text, never as elements', () => {
    const holder = audit('$\\text{<img src=x onerror=alert(1)>}$');
    expect(holder.querySelector('img')).toBeNull();
    // temml writes the spaces of a text group as no-break spaces
    expect(holder.querySelector('math mtext')?.textContent?.replace(/\u00a0/g, ' ')).toBe(
      '<img src=x onerror=alert(1)>',
    );
    expect(holder.querySelector('math')!.outerHTML).toContain(
      '&lt;img&nbsp;src=x&nbsp;onerror=alert(1)&gt;',
    );
  });

  it('refuses the TeX that carries a link, an image, a class or a style', () => {
    for (const tex of [
      String.raw`\href{https://example.com}{x}`,
      String.raw`\url{https://example.com}`,
      String.raw`\includegraphics{https://tracker.example/p.png}`,
      String.raw`\class{a}{x}`,
      String.raw`\style{color:red}{x}`,
      String.raw`\htmlClass{a}{x}`,
      String.raw`\htmlStyle{color:red}{x}`,
      String.raw`\htmlData{a=b}{x}`,
      String.raw`\htmlId{a}{x}`,
    ]) {
      const holder = audit(`$${tex}$`);
      expect(holder.querySelector('math'), tex).toBeNull();
      expect(holder.querySelector('a, img, [style], [id]'), tex).toBeNull();
      expect(holder.querySelector('code.math')?.textContent, tex).toBe(`$${tex}$`);
    }
  });
});

describe('the budget runs before temml', () => {
  const formulas = (n: number, body = 'x_{i}') =>
    Array.from({ length: n }, (_, i) => `$${body}${i}$`).join(' ');

  it('typesets at most MATH_MAX_FORMULAS formulas and leaves the rest as source', () => {
    const holder = audit(formulas(MATH_MAX_FORMULAS + 40));
    expect(holder.querySelectorAll('math')).toHaveLength(MATH_MAX_FORMULAS);
    expect(holder.querySelectorAll('code.math')).toHaveLength(40);
    // the first ones are the typeset ones (document order), the rest are the source text
    expect(holder.querySelector('p')!.firstElementChild!.localName).toBe('math');
    expect(holder.querySelector('p')!.lastElementChild!.localName).toBe('code');
  });

  it('caps the total TeX typeset and still takes a shorter formula that fits after a longer one', () => {
    const wide = (n: number) => `$$${'a+'.repeat(MATH_MAX_FORMULA_CHARS / 2 - 1)}${n}$$`;
    const fits = Math.floor(MATH_MAX_TOTAL_CHARS / (MATH_MAX_FORMULA_CHARS - 1));
    const source = [...Array.from({ length: fits + 2 }, (_, i) => wide(i)), '$$z^2$$'].join('\n\n');
    const holder = audit(source);
    // `fits` big ones fill the budget, the other big ones stay source text, the small last one fits
    expect(holder.querySelectorAll('math')).toHaveLength(fits + 1);
    expect(holder.querySelectorAll('code.math')).toHaveLength(2);
    expect(holder.querySelector('p:last-child > math')).not.toBeNull();
  });

  it('leaves one formula over the per-formula cap as source and typesets its neighbours', () => {
    const long = `$$${'x+'.repeat(MATH_MAX_FORMULA_CHARS)}x$$`;
    const holder = audit(`$a$\n\n${long}\n\n$b$`);
    expect(holder.querySelectorAll('math')).toHaveLength(2);
    expect(holder.querySelectorAll('code.math')).toHaveLength(1);
  });

  it('never calls temml for a note the complexity budget refuses', () => {
    const render = vi.spyOn(temml, 'render');
    const holder = document.createElement('div');
    for (const source of [
      '$x$ ' + '*a'.repeat(50_000),
      '$x$\n' + '> '.repeat(40) + 'y',
      '$x$ ' + 'a'.repeat(RENDER_MAX_CHARS),
      '$x$ ' + '$\\'.repeat(40_000),
    ]) {
      holder.replaceChildren(renderMarkdown(source));
      expect(holder.querySelector('pre.md-fallback'), source.slice(0, 16)).not.toBeNull();
      expect(holder.querySelector('math')).toBeNull();
    }
    expect(render).not.toHaveBeenCalled();
  });

  it('never calls temml for a note with no formula', () => {
    const render = vi.spyOn(temml, 'render');
    renderMarkdown('# Title\n\nSome **bold** text, it costs $5 and $10.\n\n- a\n- b');
    expect(render).not.toHaveBeenCalled();
  });
});

describe('failure leaves the source text', () => {
  it('keeps every formula as typed when temml throws', () => {
    vi.spyOn(temml, 'render').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    const source = String.raw`a $x_1$ b

$$
\frac{1}{2}
$$`;
    const holder = document.createElement('div');
    expect(() => holder.append(renderMarkdown(source))).not.toThrow();
    expect([...holder.querySelectorAll('code.math')].map((c) => c.textContent)).toEqual([
      '$x_1$',
      String.raw`$$
\frac{1}{2}
$$`,
    ]);
    expect(holder.querySelector('math')).toBeNull();
  });

  it('survives a typesetter that returns something odd for every formula', async () => {
    // the real one is already loaded; a throwing replaceWith is the nastiest thing left to go wrong
    const replace = vi.spyOn(Element.prototype, 'replaceWith').mockImplementation(() => {
      throw new Error('cannot replace');
    });
    const holder = document.createElement('div');
    expect(() => holder.append(renderMarkdown('$x$ and $y$'))).not.toThrow();
    expect(replace).toHaveBeenCalled();
    expect(holder.textContent).toContain('x');
  });
});
