import temml from 'temml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MATH_MAX_FORMULA_CHARS } from './markdownBudget';
import { MATHML_NS, MAX_DEPTH, MAX_ELEMENTS, admit, cleanMath, typeset } from './mathTypeset';
import { installMathmlStyle } from './mathTestSupport';

/**
 * The typesetter itself (mathTypeset.ts): temml 0.14.0 through DOMPurify's MathML pass and the
 * independent `admit` walk, in jsdom. The Markdown integration is in markdownRender.math.test.ts.
 */

installMathmlStyle();

const ELEMENTS = new Set([
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
const ATTRIBUTES = new Set([
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

/** Everything the typesetter promises, checked on the node tree. Returns the element count. */
function audit(el: Element, label = ''): number {
  let count = 0;
  const walk = (node: Element) => {
    count++;
    expect(node.namespaceURI, `namespace of <${node.localName}> ${label}`).toBe(MATHML_NS);
    expect(ELEMENTS.has(node.localName), `<${node.localName}> ${label}`).toBe(true);
    for (const attr of Array.from(node.attributes)) {
      expect(ATTRIBUTES.has(attr.name), `${attr.name} on <${node.localName}> ${label}`).toBe(true);
      expect(attr.value, `${attr.name} ${label}`).not.toMatch(
        /[<>"'`\\]|url\(|javascript|expression/i,
      );
    }
    if (node.hasAttribute('style')) {
      expect(node.getAttribute('style')).not.toMatch(/color|background|position|display|url|\(/i);
    }
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) walk(child as Element);
      else expect(child.nodeType, `child node of <${node.localName}> ${label}`).toBe(3);
    }
  };
  walk(el);
  return count;
}

const render = (tex: string, display = false) => {
  const el = typeset(tex, display);
  expect(el, tex).not.toBeNull();
  audit(el!, tex);
  return el!;
};

/** A node tree from markup, the way a hostile or buggy generator would hand one over. */
function parse(markup: string): Element {
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  return holder.firstElementChild!;
}

afterEach(() => vi.restoreAllMocks());

describe('typeset: ordinary mathematics becomes MathML', () => {
  it('builds a <math> element in the MathML namespace', () => {
    const math = render(String.raw`e^{i\pi} + 1 = 0`);
    expect(math.localName).toBe('math');
    expect(math.namespaceURI).toBe(MATHML_NS);
    expect(math.hasAttribute('display')).toBe(false);
    expect(math.querySelector('msup')).not.toBeNull();
    expect(math.textContent).toBe('eiπ+1=0');
  });

  it('marks displayed math with display="block"', () => {
    expect(render(String.raw`\frac12`, true).getAttribute('display')).toBe('block');
    expect(render(String.raw`\frac12`, false).hasAttribute('display')).toBe(false);
  });

  it('fractions', () => {
    const frac = render(String.raw`\frac{a+b}{c}`).querySelector('mfrac')!;
    expect(frac.children).toHaveLength(2);
    expect(frac.children[0]!.textContent).toBe('a+b');
    expect(frac.children[1]!.textContent).toBe('c');
    expect(render(String.raw`\frac{a}{b}`).outerHTML).toBe(
      '<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>',
    );
    expect(render(String.raw`\binom{n}{k}`).textContent).toContain('n');
  });

  it('sums, products and integrals with limits', () => {
    const sum = render(String.raw`\sum_{i=1}^{n} i`);
    expect(sum.querySelector('msubsup > mo')?.textContent).toBe('∑');
    const integral = render(String.raw`\int_0^1 x\,dx`, true);
    expect(integral.querySelector('msubsup > mo')?.textContent).toBe('∫');
    expect(
      render(String.raw`\prod_{k=1}^{\infty} k`, true).querySelector('munderover'),
    ).not.toBeNull();
  });

  it('roots', () => {
    expect(render(String.raw`\sqrt{x}`).querySelector('msqrt')).not.toBeNull();
    expect(render(String.raw`\sqrt[3]{8}`).querySelector('mroot')).not.toBeNull();
  });

  it('matrices: rows, cells, fences and cell spacing from the CSSOM', () => {
    const matrix = render(String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`, true);
    expect(matrix.querySelectorAll('mtr')).toHaveLength(2);
    expect(matrix.querySelectorAll('mtd')).toHaveLength(4);
    const fences = [...matrix.querySelectorAll('mo[fence="true"]')].map((m) => m.textContent);
    expect(fences).toEqual(['(', ')']);
    // temml sets padding through el.style: it is in the attribute, in a form the validator accepts
    expect(matrix.querySelector('mtd')!.getAttribute('style')).toMatch(/padding-(?:left|right)/);
    for (const env of ['bmatrix', 'vmatrix', 'Bmatrix', 'matrix']) {
      expect(
        render(String.raw`\begin{${env}} 1 & 0 \\ 0 & 1 \end{${env}}`, true).querySelectorAll(
          'mtd',
        ),
      ).toHaveLength(4);
    }
  });

  it('cases, aligned environments and arrays with rules', () => {
    expect(
      render(String.raw`\begin{cases} x & x>0 \\ -x & x\le 0 \end{cases}`, true).querySelectorAll(
        'mtr',
      ),
    ).toHaveLength(2);
    expect(
      render(String.raw`\begin{aligned} a &= b + c \\ &= d \end{aligned}`, true).querySelectorAll(
        'mtr',
      ),
    ).toHaveLength(2);
    const array = render(String.raw`\begin{array}{c|c} a & b \\ \hline c & d \end{array}`, true);
    expect(array.querySelector('mtd')!.getAttribute('style')).toMatch(/border/);
  });

  it('numbered environments are typeset without their numbers', () => {
    const align = render(String.raw`\begin{align} a &= b \\ c &= d \end{align}`, true);
    expect(align.querySelectorAll('mtr')).toHaveLength(2);
    expect(align.textContent).not.toContain('(1)');
    expect(render(String.raw`\begin{equation} a = b \end{equation}`, true).textContent).toBe('a=b');
    // display-only environments stay source text inline, as temml itself reports
    expect(typeset(String.raw`\begin{align} a &= b \end{align}`, false)).toBeNull();
  });

  it('chemistry: subscripts, superscripts, arrows and \\ce', () => {
    const water = render(String.raw`\mathrm{H_2O}`);
    expect(water.querySelector('msub > mn')?.textContent).toBe('2');
    expect(render(String.raw`\text{Na}^+ + \text{Cl}^- \to \text{NaCl}`).textContent).toContain(
      '→',
    );
    expect(render(String.raw`\ce{H2O}`).querySelector('msub')).not.toBeNull();
    expect(
      render(String.raw`\mathrm{SO_4^{2-}} \rightleftharpoons \mathrm{H^+}`).querySelector(
        'msubsup',
      ),
    ).not.toBeNull();
  });

  it('accents, over and under constructs, delimiters, fonts, spacing', () => {
    for (const tex of [
      String.raw`\vec{v} \cdot \hat{n} + \bar{x} + \tilde{y} + \dot{z}`,
      String.raw`\overline{AB} + \underline{CD}`,
      String.raw`\widehat{ABC} + \widetilde{xyz}`,
      String.raw`\overbrace{a+b}^{2} + \underbrace{x+y}_{2}`,
      String.raw`\left( \frac{a}{b} \right)^2 \left[ x \right]`,
      String.raw`\mathbf{F} = m\mathbf{a}, \mathbb{R}, \mathcal{L}, \mathfrak{g}`,
      String.raw`\boldsymbol{\mu} + \pmb{\sigma}`,
      String.raw`a \quad b \qquad c \, d \; e \! f`,
      String.raw`\cancel{x} + \bcancel{y} + \xcancel{z}`,
      String.raw`\boxed{E = mc^2} + \fbox{abc}`,
      String.raw`f'(x) = \lim_{h\to 0} \frac{f(x+h)-f(x)}{h}`,
      String.raw`\operatorname{Var}(X) = E[X^2] - E[X]^2`,
      String.raw`\xrightarrow{f} \xleftarrow[g]{h}`,
      String.raw`\sideset{_a^b}{_c^d}\sum`,
      String.raw`{}^{14}_{6}\mathrm{C}`,
      String.raw`\hspace{1em} x \; y`,
      String.raw`\text{if } x > 0 \text{ then } y`,
      String.raw`\alpha, \beta, \Gamma, \varepsilon, \hbar, \nabla \cdot \vec{E}`,
    ]) {
      render(tex, true);
    }
  });

  it('keeps the meaningful classes of boxes and strikes and drops the rest', () => {
    const cancel = render(String.raw`\cancel{x}`);
    expect(cancel.querySelector('menclose')!.getAttribute('notation')).toBe('updiagonalstrike');
    expect(cancel.querySelector('.tml-cancel.upstrike')).not.toBeNull();
    expect(render(String.raw`\overline{x}`).querySelector('menclose.tml-overline')).not.toBeNull();
    // classes for other engines are removed, never left behind
    const hat = render(String.raw`\vec{v} + \tilde{y} + f'`);
    expect(hat.querySelector('[class*="wbk-"], .tml-vec, .tml-prime, .tml-display')).toBeNull();
  });

  it('every typeset element lives in the MathML namespace with allow-listed attributes only', () => {
    const el = render(
      String.raw`\begin{bmatrix} \frac{1}{2} & \sqrt{3} \\ \overline{x} & \cancel{y} \end{bmatrix}`,
      true,
    );
    expect(audit(el)).toBeGreaterThan(10);
  });
});

describe('typeset: what is refused falls back to source text (null)', () => {
  it.each([
    // trust: temml refuses these when trust is false, and strict refuses the html* family
    ['\\includegraphics', String.raw`\includegraphics{https://tracker.example/p.png}`],
    ['\\class', String.raw`\class{x}{y}`],
    ['\\id', String.raw`\id{x}{y}`],
    ['\\style', String.raw`\style{background:url(https://tracker.example/x)}{y}`],
    ['\\data', String.raw`\data{a=b}{y}`],
    // not temml commands at all: unsupported, thrown with throwOnError
    ['\\href', String.raw`\href{javascript:alert(1)}{x}`],
    ['\\url', String.raw`\url{https://example.com}`],
    ['\\htmlClass', String.raw`\htmlClass{a}{x}`],
    ['\\htmlStyle', String.raw`\htmlStyle{color:red}{x}`],
    ['\\htmlId', String.raw`\htmlId{a}{x}`],
    ['\\htmlData', String.raw`\htmlData{a=b}{x}`],
    // colours are not carried
    ['\\color', String.raw`\color{red} x`],
    ['\\textcolor', String.raw`\textcolor{blue}{x}`],
    ['\\colorbox', String.raw`\colorbox{yellow}{x}`],
    ['\\fcolorbox', String.raw`\fcolorbox{red}{yellow}{x}`],
    // nodes that are not MathML (temml's reference is an HTML <a>, left out of the <math> element)
    ['\\ref', String.raw`\ref{a}`],
    ['\\eqref', String.raw`\eqref{a}`],
    ['\\mathllap', String.raw`\mathllap{x}`],
    ['\\rule (a black box that ignores the theme)', String.raw`\rule{1em}{1pt}`],
    ['\\phase', String.raw`\phase{x}`],
    ['\\textcircled', String.raw`\textcircled{x}`],
    // macro definitions and expansion control
    ['\\def', String.raw`\def\a{x}\a`],
    ['\\gdef', String.raw`\gdef\a{x}\a`],
    ['\\edef', String.raw`\edef\a{x}\a`],
    ['\\newcommand', String.raw`\newcommand{\a}{x}\a`],
    ['\\renewcommand', String.raw`\renewcommand{\a}{x}`],
    ['\\let', String.raw`\let\a=\alpha \a`],
    ['\\global', String.raw`\global\def\a{x}`],
    ['\\expandafter', String.raw`\expandafter x y`],
    ['\\csname', String.raw`\csname a\endcsname`],
    // errors
    ['an unknown command', String.raw`\notacommand{x}`],
    ['an unbalanced brace', String.raw`\frac{a}{b`],
    ['a stray ampersand', 'a & b'],
    ['an environment closed by the wrong name', String.raw`\begin{matrix} a \end{cases}`],
    ['nothing', ''],
    ['only spaces', '   \n '],
  ])('%s', (_name, tex) => {
    expect(typeset(tex, false)).toBeNull();
    expect(typeset(tex, true)).toBeNull();
  });

  it('refuses a formula over the length cap and accepts one at it', () => {
    const half = MATH_MAX_FORMULA_CHARS / 2;
    expect(typeset('x+'.repeat(half) + 'x', false)).toBeNull(); // cap + 1
    expect(typeset('x+'.repeat(half - 1) + 'xx', false)).not.toBeNull(); // the cap
  });

  it('refuses a formula nested deeper than the limit instead of being cut by a parser', () => {
    const deep = (n: number) => '\\frac{1}{'.repeat(n) + 'x' + '}'.repeat(n);
    expect(typeset(deep(Math.floor(MAX_DEPTH / 2) - 4), false)).not.toBeNull();
    expect(typeset(deep(MAX_DEPTH), false)).toBeNull();
    // very deep input is refused (depth limit) or overflows a recursion; never an exception
    for (const tex of [deep(90), 'x^{'.repeat(220) + 'x' + '}'.repeat(220)]) {
      expect(() => typeset(tex, false), tex.slice(0, 12)).not.toThrow();
      expect(typeset(tex, false), tex.slice(0, 12)).toBeNull();
    }
    // redundant braces are collapsed by temml, so they are not depth
    expect(typeset('{'.repeat(450) + 'x' + '}'.repeat(450), false)).not.toBeNull();
  });

  it('refuses output over the element limit, however short its source is', () => {
    // `\coh` is 4 characters of TeX and 11 elements: 240 of them are 960 characters and 2,641 elements
    const dense = '\\coh'.repeat(240);
    expect(dense.length).toBeLessThanOrEqual(MATH_MAX_FORMULA_CHARS);
    const render = vi.spyOn(temml, 'render');
    expect(typeset(dense, true)).toBeNull();
    expect(render).toHaveBeenCalledTimes(1); // it was built, and refused before it was sanitised
    // the same shape within the limit is typeset
    const el = typeset('\\coh'.repeat(MAX_ELEMENTS / 11 / 2), true);
    expect(el).not.toBeNull();
    expect(audit(el!)).toBeLessThan(MAX_ELEMENTS);
  });

  it('drops the label of \\label and keeps the formula', () => {
    // temml emits an empty <mrow class="tml-label">; references are not supported, so it is inert
    const el = render(String.raw`\label{a} x`);
    expect(el.textContent).toBe('x');
    expect(el.querySelector('[class]')).toBeNull();
  });

  it('refuses a result with no content (a lone reference leaves an empty <math>)', () => {
    expect(typeset(String.raw`\ref{a}`, false)).toBeNull();
  });

  it('turns a temml failure of any kind into null, never an exception', () => {
    const render = vi.spyOn(temml, 'render');
    render.mockImplementationOnce(() => {
      throw new TypeError('internal error');
    });
    expect(typeset('x', false)).toBeNull();
    render.mockImplementationOnce(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    expect(typeset('x', false)).toBeNull();
    // and it recovers: the next formula is typeset
    expect(typeset('x', false)).not.toBeNull();
  });

  it('passes temml the limits and never trusts', () => {
    const render = vi.spyOn(temml, 'render');
    typeset('x', true);
    expect(render).toHaveBeenCalledTimes(1);
    const options = render.mock.calls[0]![2]!;
    expect(options).toMatchObject({
      displayMode: true,
      throwOnError: true,
      trust: false,
      strict: true,
      maxExpand: 1_000,
      maxSize: [10, 100],
    });
    // no escape hatches
    expect(options).not.toHaveProperty('macros');
    expect(options).not.toHaveProperty('annotate');
  });
});

describe('cleanMath: hostile node trees are refused or reduced to allow-listed nodes', () => {
  /** `markup` is what a compromised generator or a parser quirk could hand over. */
  const hostile: Array<[string, string]> = [
    ['script', '<math><mi>x</mi><script>alert(1)</script></math>'],
    ['svg script', '<math><svg><script>alert(1)</script></svg></math>'],
    ['svg onload', '<math><svg onload="alert(1)"></svg></math>'],
    ['img onerror', '<math><mi><img src=x onerror="alert(1)"></mi></math>'],
    ['iframe', '<math><mtext><iframe src="https://evil.example"></iframe></mtext></math>'],
    [
      'mglyph in table in mtext (namespace confusion)',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
    ],
    ['mglyph with src', '<math><mglyph src="https://tracker.example/p.png"></mglyph></math>'],
    ['malignmark', '<math><mi>x</mi><malignmark></malignmark></math>'],
    ['style element', '<math><mi>x</mi><style>mi{color:red}</style></math>'],
    [
      'annotation-xml with html',
      '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>',
    ],
    [
      'annotation-xml with svg',
      '<math><semantics><mi>x</mi><annotation-xml encoding="image/svg+xml"><svg onload=alert(1)></svg></annotation-xml></semantics></math>',
    ],
    [
      'semantics with a tex annotation',
      '<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>',
    ],
    [
      'maction',
      '<math><maction actiontype="statusline"><mi>x</mi><mtext>y</mtext></maction></math>',
    ],
    ['mfenced', '<math><mfenced open="(" close=")"><mi>x</mi></mfenced></math>'],
    ['ms', '<math><ms>text</ms></math>'],
    ['a link in mtext', '<math><mtext><a href="javascript:alert(1)">x</a></mtext></math>'],
    ['a link element in math', '<math><a href="https://example.org"><mi>x</mi></a></math>'],
    ['b in mtext (html integration)', '<math><mtext><b>x</b></mtext></math>'],
    ['html mi inside mi (namespace confusion)', '<math><mi><mi>x</mi></mi></math>'],
    ['html mrow inside mtext', '<math><mtext><mrow>x</mrow></mtext></math>'],
    ['svg root', '<svg><mi>x</mi></svg>'],
    ['not math at the root', '<mrow><mi>x</mi></mrow>'],
    ['onclick', '<math><mi onclick="alert(1)">x</mi></math>'],
    ['onmouseover', '<math onmouseover="alert(1)"><mi>x</mi></math>'],
    ['xlink:href', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>'],
    ['href on math', '<math href="javascript:alert(1)"><mi>x</mi></math>'],
    ['href on mrow', '<math><mrow href="https://evil.example"><mi>x</mi></mrow></math>'],
    ['id', '<math><mi id="x">x</mi></math>'],
    ['name', '<math><mi name="x">x</mi></math>'],
    ['data attribute', '<math><mi data-x="1">x</mi></math>'],
    ['aria-label', '<math aria-label="TeX source"><mi>x</mi></math>'],
    ['role', '<math role="img"><mi>x</mi></math>'],
    ['tabindex', '<math tabindex="0"><mi>x</mi></math>'],
    ['xmlns', '<math xmlns="http://www.w3.org/1999/xhtml"><mi>x</mi></math>'],
    ['mathcolor', '<math><mi mathcolor="red">x</mi></math>'],
    ['mathbackground', '<math><mi mathbackground="red">x</mi></math>'],
    ['unknown class', '<math><mi class="evil">x</mi></math>'],
    ['the code math class', '<math class="math"><mi>x</mi></math>'],
    ['style color', '<math><mi style="color:red">x</mi></math>'],
    ['style url', '<math><mi style="background:url(https://tracker.example/p.png)">x</mi></math>'],
    ['style javascript url', '<math><mi style="background:url(javascript:alert(1))">x</mi></math>'],
    [
      'style position',
      '<math><mi style="position:fixed;top:0;left:0;width:100%;height:100%">x</mi></math>',
    ],
    ['style expression', '<math><mi style="width:expression(alert(1))">x</mi></math>'],
    ['style var', '<math><mi style="padding-left:var(--x)">x</mi></math>'],
    ['style calc', '<math><mi style="padding-left:calc(1em + 1px)">x</mi></math>'],
    ['style import', '<math><mi style="padding-left:1em;@import url(x)">x</mi></math>'],
    ['style comment', '<math><mi style="padding-left:1em/**/;color:red">x</mi></math>'],
    ['bad display', '<math display="javascript:alert(1)"><mi>x</mi></math>'],
    ['bad mathvariant', '<math><mi mathvariant="bold;color:red">x</mi></math>'],
    ['bad length', '<math><mspace width="1em;position:fixed"></mspace></math>'],
    ['bad notation', '<math><menclose notation="actuarial"><mi>x</mi></menclose></math>'],
    ['text directly in mrow', '<math><mrow>loose text</mrow></math>'],
    ['text directly in math', '<math>loose text</math>'],
    ['comment', '<math><!--x--><mi>x</mi></math>'],
    ['cdata-like', '<math><mtext><![CDATA[<img src=x onerror=alert(1)>]]></mtext></math>'],
    ['two roots', '<math><mi>x</mi></math><math><mi>y</mi></math>'],
    ['template', '<math><template><mi>x</mi></template></math>'],
  ];

  it.each(hostile)('%s', (_name, markup) => {
    const holder = document.createElement('div');
    holder.innerHTML = markup;
    // whatever the quirks of the parser, the answer is "no" or a tree that passes the same audit
    const node = holder.firstElementChild;
    if (!node) return;
    const clean = cleanMath(node);
    if (clean) audit(clean, markup);
    else expect(clean).toBeNull();
  });

  it.each(
    hostile.filter(
      ([name]) =>
        !['two roots', 'comment', 'template', 'cdata-like', 'text directly in math'].includes(name),
    ),
  )('%s is refused outright (null)', (_name, markup) => {
    expect(cleanMath(parse(markup))).toBeNull();
  });

  it('accepts a plain, valid tree', () => {
    const el = cleanMath(
      parse(
        '<math display="block"><mrow><mi mathvariant="normal">x</mi><mo lspace="0.2222em" rspace="0.2222em">+</mo><mn>1</mn></mrow></math>',
      ),
    );
    expect(el?.outerHTML).toContain('<mi mathvariant="normal">x</mi>');
    expect(admit(el!)).toBe(true);
  });

  it('accepts the style declarations temml uses and nothing else', () => {
    const ok = (style: string) =>
      cleanMath(
        parse(`<math><mtable><mtr><mtd style="${style}"><mi>x</mi></mtd></mtr></mtable></math>`),
      );
    expect(ok('padding-left: 0em; padding-right: 5.9776pt;')).not.toBeNull();
    expect(ok('border-bottom: 0.06em solid; width: 50%')).not.toBeNull();
    expect(ok('padding: 1em 0 0 0')).not.toBeNull();
    expect(ok('padding-left: 1em; color: red')).toBeNull();
    expect(ok('float: left')).toBeNull();
    expect(ok('padding-left')).toBeNull();
    expect(ok('padding-left: 1000em')).toBeNull();
  });

  it('refuses a tree over the element or depth limits', () => {
    const wide = `<math><mrow>${'<mi>x</mi>'.repeat(MAX_ELEMENTS)}</mrow></math>`;
    expect(cleanMath(parse(wide))).toBeNull();
    const deep = `<math>${'<mrow>'.repeat(MAX_DEPTH)}<mi>x</mi>${'</mrow>'.repeat(MAX_DEPTH)}</math>`;
    expect(cleanMath(parse(deep))).toBeNull();
    const fits = `<math>${'<mrow>'.repeat(MAX_DEPTH - 3)}<mi>x</mi>${'</mrow>'.repeat(MAX_DEPTH - 3)}</math>`;
    expect(cleanMath(parse(fits))).not.toBeNull();
  });
});
