import { describe, expect, it, vi } from 'vitest';
import { HOSTILE_MARKDOWN } from './markdownHostile';
import { MATH_DISPLAY_MAX, MATH_INLINE_MAX } from './markdownMath';
import { renderMarkdown, renderMarkdownToHtml } from './markdownRender';

// This file is about the source-text rendering of TeX: what a note shows while the typesetter loads,
// and what it keeps whenever the typesetter refuses a formula. The lazily loaded typesetter is replaced
// by one that refuses everything, so the renderer's own contract is what is asserted; the real
// typesetter has mathTypeset.test.ts and markdownRender.math.test.ts.
vi.mock('./mathTypeset', () => ({ typeset: () => null }));

const ALLOWED = new Set([
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

/** Everything the sanitiser promises, checked on the node tree rather than on a string. */
function audit(source: string) {
  const holder = document.createElement('div');
  holder.append(renderMarkdown(source));
  const all = [...holder.querySelectorAll('*')];
  for (const el of all) {
    expect(
      ALLOWED.has(el.tagName.toLowerCase()),
      `<${el.tagName}> in ${JSON.stringify(source)}`,
    ).toBe(true);
    for (const attr of [...el.attributes]) {
      expect(attr.name.startsWith('on'), `${attr.name} in ${JSON.stringify(source)}`).toBe(false);
      expect(['href', 'title', 'start', 'target', 'rel', 'class']).toContain(attr.name);
    }
    // The only class that may survive is the math marker, and only on <code>.
    if (el.hasAttribute('class')) {
      expect(el.tagName, `class on <${el.tagName}> in ${JSON.stringify(source)}`).toBe('CODE');
      expect(['math', 'math math-display']).toContain(el.getAttribute('class'));
    }
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      expect(el.getAttribute('href')).toMatch(/^https?:\/\//i);
      expect(el.getAttribute('rel')).toBe('noopener noreferrer');
      expect(el.getAttribute('target')).toBe('_blank');
    }
  }
  return holder;
}

describe('renderMarkdown', () => {
  it('renders ordinary Markdown', () => {
    const holder = audit('# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two\n\n> quote');
    expect(holder.querySelector('h1')?.textContent).toBe('Title');
    expect(holder.querySelector('strong')?.textContent).toBe('bold');
    expect(holder.querySelectorAll('li')).toHaveLength(2);
    expect(holder.querySelector('blockquote')?.textContent).toContain('quote');
  });

  it('opens http(s) links in a new tab without opener access', () => {
    const holder = audit('[site](https://example.com/page?q=1) and [plain](http://example.org)');
    const links = [...holder.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/page?q=1',
      'http://example.org',
    ]);
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
    }
  });

  it('shows raw HTML as text instead of markup', () => {
    const holder = audit('Hello <b onclick="alert(1)">there</b> <script>alert(1)</script>');
    expect(holder.querySelector('script')).toBeNull();
    expect(holder.querySelector('b')).toBeNull();
    expect(holder.textContent).toContain('<script>alert(1)</script>');
    expect(holder.textContent).toContain('<b onclick="alert(1)">');
  });

  it('does not load images; the alt text is shown', () => {
    const holder = audit(
      '![a diagram](https://tracker.example/pixel.png) and <img src=x onerror=alert(1)>',
    );
    expect(holder.querySelector('img')).toBeNull();
    expect(holder.textContent).toContain('a diagram');
  });

  // The battery is shared with the typeset-math tests (markdownHostile.ts). In this file the typesetter
  // is never loaded, so these are the sources as shown while it loads and when it refuses a formula.
  it.each(HOSTILE_MARKDOWN)('neutralises %s', (_name, source) => {
    const holder = audit(source);
    // No script can run: nothing outside the allow-list and no handler attribute exists (audit).
    expect(
      holder.querySelector('script, iframe, object, embed, style, form, svg, math'),
    ).toBeNull();
    // And nothing was silently dropped: the text of what was typed is still readable somewhere.
    expect(holder.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('keeps hostile code inside a code block as text', () => {
    const html = renderMarkdownToHtml('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
  });

  it('survives pathological input', () => {
    const long = 'a'.repeat(100_000);
    expect(audit(long).textContent?.trim()).toHaveLength(100_000);
    // Too deep or too expensive for marked: shown as plain text (markdownBudget.ts; the cases and the
    // timings are in markdownRender.budget.test.ts), so the audit of formatted output does not apply.
    const deep = '> '.repeat(200) + 'x';
    const holder = document.createElement('div');
    expect(() => holder.append(renderMarkdown(deep))).not.toThrow();
    expect(holder.querySelector('pre.md-fallback')?.textContent).toBe(deep);
    const brackets = '['.repeat(2000) + ']'.repeat(2000);
    const other = document.createElement('div');
    expect(() => other.append(renderMarkdown(brackets))).not.toThrow();
    expect(other.textContent).toContain(brackets);
  });
});

// ---------------------------------------------------------------------------------------------
// TeX is kept as its source (ADR-015). Nothing here is typeset, so what matters is that the text
// survives byte for byte, that Markdown does not mangle it, and that it stays inert.
// ---------------------------------------------------------------------------------------------

/** The elements that carry a class, as [class, text]. */
const spans = (holder: HTMLElement) =>
  [...holder.querySelectorAll('code[class]')].map((c) => [c.className, c.textContent]);

describe('renderMarkdown: TeX math as source text', () => {
  it('marks inline math and keeps every character of the source', () => {
    const source = String.raw`Euler: $e^{i\pi} + 1 = 0$ holds.`;
    const holder = audit(source);
    expect(spans(holder)).toEqual([['math', String.raw`$e^{i\pi} + 1 = 0$`]]);
    expect(holder.textContent?.trim()).toBe(source);
    expect(renderMarkdownToHtml('$x$')).toContain('<code class="math">$x$</code>');
  });

  it('marks display math, with its line breaks, as one block between paragraphs', () => {
    const tex = String.raw`$$
\int_0^1 x\,dx = \frac{1}{2}
$$`;
    const holder = audit(`Before\n\n${tex}\n\nAfter`);
    expect(spans(holder)).toEqual([['math math-display', tex]]);
    const block = holder.querySelector('code.math-display')!;
    expect(block.parentElement?.tagName).toBe('P');
    expect([...holder.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Before',
      tex,
      'After',
    ]);
  });

  it('shows a display span inside a paragraph as display math too', () => {
    const holder = audit('so $$x^2 + y^2$$ holds');
    expect(spans(holder)).toEqual([['math math-display', '$$x^2 + y^2$$']]);
    expect(holder.textContent?.trim()).toBe('so $$x^2 + y^2$$ holds');
  });

  it('does not read Markdown, HTML or entities inside a formula', () => {
    const source = String.raw`$a_1 * b_2 * c_3$ and $x_i_j$ and $\{a,b\}$ and $a<b>c$ and $d&amp;e$`;
    const holder = audit(source);
    expect(holder.querySelector('em, strong, del')).toBeNull();
    expect(spans(holder).map(([, text]) => text)).toEqual([
      String.raw`$a_1 * b_2 * c_3$`,
      '$x_i_j$',
      String.raw`$\{a,b\}$`,
      '$a<b>c$',
      '$d&amp;e$',
    ]);
    expect(holder.textContent?.trim()).toBe(source);
  });

  it('lets emphasis wrap a formula whose own stars are not delimiters', () => {
    const holder = audit('*see $a*b$ now*');
    const em = holder.querySelector('em');
    expect(em?.textContent).toBe('see $a*b$ now');
    expect(em?.querySelector('code.math')?.textContent).toBe('$a*b$');
  });

  it('keeps list-, heading- and quote-looking lines inside a display block', () => {
    const tex = '$$\n- a\n+ b\n# c\n> d\n1. e\n$$';
    const holder = audit(`intro\n${tex}\noutro`);
    expect(holder.querySelector('ul, ol, h1, blockquote')).toBeNull();
    expect(spans(holder)).toEqual([['math math-display', tex]]);
    expect([...holder.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'intro',
      tex,
      'outro',
    ]);
  });

  it('keeps a blank line inside one display block', () => {
    const tex = '$$\na\n\nb\n$$';
    const holder = audit(tex);
    expect(spans(holder)).toEqual([['math math-display', tex]]);
  });

  it('works inside lists, quotes, tables, headings and link text', () => {
    const holder = audit(
      [
        '- item $a_b$',
        '',
        '> $$',
        '> q^2',
        '> $$',
        '',
        '| h |',
        '|---|',
        '| $c_d$ |',
        '',
        '# Title $e_f$',
        '',
        '[$g_h$](https://example.com)',
      ].join('\n'),
    );
    expect(holder.querySelector('li code.math')?.textContent).toBe('$a_b$');
    expect(holder.querySelector('blockquote code.math-display')?.textContent).toBe('$$\nq^2\n$$');
    expect(holder.querySelector('td code.math')?.textContent).toBe('$c_d$');
    expect(holder.querySelector('h1 code.math')?.textContent).toBe('$e_f$');
    expect(holder.querySelector('a code.math')?.textContent).toBe('$g_h$');
  });

  it.each([
    ['prices', 'It costs $5 and $10 today.'],
    ['spaces inside', 'Pay $ 5 $ now'],
    ['a digit after the closer', 'range $5-$6'],
    ['one dollar sign', 'a single $ here'],
    ['an unclosed display', '$$ never closed\n\nnext'],
    ['an empty display', '$$   $$'],
    ['a blank display block', '$$\n\n$$'],
    ['across a line break', '$a\nb$'],
  ])('leaves %s as ordinary text', (_name, source) => {
    const holder = audit(source);
    expect(holder.querySelector('code')).toBeNull();
    expect(holder.textContent?.replace(/\s+/g, ' ').trim()).toBe(source.replace(/\s+/g, ' '));
  });

  it('treats an escaped dollar as a dollar sign', () => {
    const holder = audit(String.raw`\$x\$ and \$\$y\$\$`);
    expect(holder.querySelector('code')).toBeNull();
    expect(holder.textContent?.trim()).toBe('$x$ and $$y$$');
  });

  it('honours an escaped dollar inside a formula', () => {
    const holder = audit(String.raw`price is $a \$ b$ ok`);
    expect(spans(holder)).toEqual([['math', String.raw`$a \$ b$`]]);
  });

  it('does not touch code spans or fenced code', () => {
    const holder = audit('`$x_1$` and\n\n```\n$$\ny\n$$\n```');
    expect(holder.querySelector('code[class]')).toBeNull();
    expect(holder.querySelector('p code')?.textContent).toBe('$x_1$');
    expect(holder.querySelector('pre code')?.textContent).toBe('$$\ny\n$$\n');
  });

  it('never lets the class attribute through on anything else', () => {
    const holder = audit('```math\nx\n```\n\n<p class="math">y</p>\n\n<code class="math">z</code>');
    expect(holder.querySelector('[class]')).toBeNull();
    expect(holder.textContent).toContain('<code class="math">z</code>');
  });

  it('bounds a span: past the cap it is plain text, at the cap it is math', () => {
    const at = `$${'x'.repeat(MATH_INLINE_MAX)}$`;
    const past = `$${'x'.repeat(MATH_INLINE_MAX + 1)}$`;
    expect(spans(audit(at))).toEqual([['math', at]]);
    expect(spans(audit(past))).toEqual([]);
    const displayAt = `$$${'y'.repeat(MATH_DISPLAY_MAX)}$$`;
    const displayPast = `$$${'y'.repeat(MATH_DISPLAY_MAX + 1)}$$`;
    expect(spans(audit(displayAt))).toEqual([['math math-display', displayAt]]);
    expect(spans(audit(displayPast))).toEqual([]);
  });

  it('survives input built to make a TeX scanner slow', () => {
    const cases = [
      '$a '.repeat(8_000),
      '$'.repeat(20_000),
      '$$\n'.repeat(2_000),
      '$$ a\n'.repeat(2_000),
      'para\n\n$$ x\n'.repeat(1_500),
      '- item\n$$ y\n'.repeat(1_500),
      '$a$'.repeat(3_000),
      '*$a*'.repeat(1_500),
      `$${'\\'.repeat(400)}$`.repeat(50),
      `$$${'x '.repeat(4_000)}`,
    ];
    for (const source of cases) {
      // One render and a cheap check: a per-element audit of tens of thousands of nodes is the slow part.
      const holder = document.createElement('div');
      expect(() => holder.append(renderMarkdown(source)), source.slice(0, 20)).not.toThrow();
      expect(holder.textContent?.length ?? 0).toBeGreaterThan(0);
      expect(holder.querySelector('script, iframe, style, img, svg, math, a')).toBeNull();
    }
  });

  it.each([
    String.raw`\href{javascript:alert(1)}{x}`,
    String.raw`\url{javascript:alert(1)}`,
    String.raw`\includegraphics{https://tracker.example/pixel.png}`,
    String.raw`\style{background:url(https://tracker.example/x)}{x}`,
  ])('shows the TeX command %s as source, not as a link, image or style', (tex) => {
    const holder = audit(`before $${tex}$ after`);
    expect(spans(holder)).toEqual([['math', `$${tex}$`]]);
    expect(holder.querySelector('a, img, [style]')).toBeNull();
  });
});
