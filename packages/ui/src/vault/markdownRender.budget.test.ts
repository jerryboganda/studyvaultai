import { beforeAll, describe, expect, it } from 'vitest';
import { RENDER_MAX_CHARS } from './markdownBudget';
import {
  FALLBACK_MAX_CHARS,
  FALLBACK_NOTE,
  renderMarkdown,
  renderMarkdownToHtml,
  renderMarkdownUnbounded,
} from './markdownRender';

/**
 * Bounded rendering (markdownBudget.ts) on the real pipeline: marked, DOMPurify, jsdom.
 *
 * Timings are jsdom's. Its DOM is far slower than a browser's (a note with 3,000 elements costs about a
 * second to build here and a small fraction of that in Chrome), so the 250 ms bound is asserted on the
 * hostile shapes, which are refused before any DOM is built; documents that are rendered are checked
 * for what they produce, with a bound that only catches a freeze.
 */

const CAP = RENDER_MAX_CHARS;
const fill = (unit: string, chars = CAP) =>
  unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
const holderOf = (fragment: DocumentFragment) => {
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder;
};

/** The fallback's parts, or null when the text was formatted. */
function fallback(holder: HTMLElement) {
  const pre = holder.querySelector<HTMLElement>('pre.md-fallback');
  if (!pre) return null;
  return {
    pre,
    text: pre.textContent ?? '',
    reason: pre.dataset.reason,
    note: holder.querySelector('p.md-fallback-note')?.textContent ?? '',
  };
}

beforeAll(() => {
  // the first render in a process compiles marked's regular expressions: not what is measured here
  renderMarkdown(
    '# Warm\n\n**a** *b* `c` [d](https://example.com)\n\n- e\n- f\n\n| g |\n|---|\n| h |\n',
  );
});

const refused: Record<string, string> = {
  'emphasis: *a': fill('*a'),
  'emphasis: _a': fill('_a'),
  'emphasis: **a ': fill('**a '),
  'emphasis: ***a': fill('***a'),
  'emphasis: *a_': fill('*a_'),
  'emphasis: *a, one per line': fill('*a\n'),
  'emphasis: a_b_': fill('a_b_'),
  'emphasis: a*': fill('a*'),
  'emphasis: ~~a': fill('~~a'),
  'emphasis: *(': fill('*('),
  'emphasis: *a* spans, no space': fill('*a*a'),
  'emphasis: nested openers then closers': `${fill('*a ', 50_000)}${fill('a* ', 50_000)}`,
  'brackets: [': fill('['),
  'brackets: [a': fill('[a'),
  'brackets: [a](': fill('[a]('),
  'brackets: [\\': fill('[\\'),
  'brackets: ![': fill('!['),
  'brackets: [`': fill('[`'),
  'brackets in link text: [*a](': fill('[*a]('),
  'brackets: [x [a] after a definition': `[a]: /u\n${fill('[x [a] ', CAP - 8)}`,
  'nested brackets': `${'['.repeat(CAP / 2)}${']'.repeat(CAP / 2)}`,
  'code spans: increasing runs': Array.from({ length: 450 }, (_, i) => `${'`'.repeat(i + 1)}a `)
    .join('')
    .slice(0, CAP),
  'code spans: `a': fill('`a'),
  'tags: <': fill('<'),
  'tags: <a b="': fill('<a b="'),
  'escapes: \\': fill('\\'),
  'autolinks: www.a.b': fill('www.a.b '),
  'autolinks: a@b.c': fill('a@b.c '),
  'images: !a': fill('!a'),
  'quote depth: > ': fill('> '),
  'quote depth growing by line': Array.from({ length: 300 }, (_, i) => `${'> '.repeat(i + 1)}x`)
    .join('\n')
    .slice(0, CAP),
  'list depth: 1. ': fill('1. '),
  'list depth: > - ': fill('> - '),
  'list depth by indentation': Array.from({ length: 400 }, (_, i) => `${' '.repeat(2 * i)}- x`)
    .join('\n')
    .slice(0, CAP),
  'lines: list items': fill('- a\n'),
  'lines: task items': fill('- [ ] a\n'),
  'lines: lazy quote lines': fill('> a\nb\n'),
  'lines: paragraphs': fill('a\n\n'),
  'lines: headings': fill('# a\n'),
  'lines: table rows': `|a|b|\n|-|-|\n${fill('|a|b|\n', CAP - 12)}`,
  'lines: hard breaks': fill('a  \n'),
  'lines: code fences': fill('```\n'),
  'lines: thematic breaks': fill('---\n'),
  'math: $\\': fill('$\\'),
  'math: $a ': fill('$a '),
  'math: $': fill('$'),
  'math: $$': fill('$$'),
  'math: $$ lines': fill('$$\n'),
  'math: $_': fill('$_'),
  'math: formulas with emphasis marks': fill('$a_1 * b_2$*a'),
  'too long': 'a'.repeat(CAP + 1),
};

describe('renderMarkdown: text that is too expensive is shown as plain text', () => {
  it.each(Object.entries(refused))('%s', (_name, source) => {
    const started = performance.now();
    const holder = holderOf(renderMarkdown(source));
    const elapsed = performance.now() - started;

    const shown = fallback(holder);
    expect(shown, 'was formatted').not.toBeNull();
    // the visible note, as a paragraph, before the text
    expect(shown!.note).toBe(FALLBACK_NOTE);
    expect(holder.firstElementChild?.tagName).toBe('P');
    expect(shown!.pre.previousElementSibling?.tagName).toBe('P');
    // every character and line break, as text, and nothing else on the page
    expect(shown!.text).toBe(source);
    expect([...holder.children].map((c) => c.tagName)).toEqual(['P', 'PRE']);
    expect(holder.querySelector('script, img, a, iframe')).toBeNull();
    expect(elapsed).toBeLessThan(250);
  });

  it('names why, for diagnostics', () => {
    const reason = (source: string) => fallback(holderOf(renderMarkdown(source)))?.reason;
    expect(reason('a'.repeat(CAP + 1))).toBe('too-long');
    expect(reason(`${'> '.repeat(40)}x`)).toBe('too-deep');
    expect(reason(fill('**a '))).toBe('too-complex');
  });

  it('keeps hostile markup as text inside the plain rendering', () => {
    const source = `<script>alert(1)</script><img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n${fill('*a', 60_000)}`;
    const holder = holderOf(renderMarkdown(source));
    expect(fallback(holder)).not.toBeNull();
    expect(holder.querySelector('script, img, a, [onerror]')).toBeNull();
    expect(holder.textContent).toContain('<script>alert(1)</script>');
    expect(renderMarkdownToHtml(source)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('reads its direction from the text, not from the page', () => {
    const arabic = `${fill('*ب', 60_000)}`;
    const shown = fallback(holderOf(renderMarkdown(arabic)));
    expect(shown?.pre.dir).toBe('auto');
  });

  it('cuts a text past FALLBACK_MAX_CHARS and says so', () => {
    const source = fill('a ', FALLBACK_MAX_CHARS + 50_000);
    const shown = fallback(holderOf(renderMarkdown(source)));
    expect(shown!.text).toHaveLength(FALLBACK_MAX_CHARS);
    expect(shown!.note).toContain(FALLBACK_NOTE);
    expect(shown!.note).toContain('200,000');
    // no half of a surrogate pair at the cut
    const emoji = `${'a'.repeat(FALLBACK_MAX_CHARS - 1)}😀${'b'.repeat(10)}`;
    const cut = fallback(holderOf(renderMarkdown(emoji)))!.text;
    expect(cut.codePointAt(cut.length - 1)).toBe('a'.codePointAt(0));
  });
});

describe('renderMarkdown: never throws', () => {
  it('survives input that overflows the stack or makes marked give up', () => {
    for (const source of [
      '> '.repeat(5_000),
      '1. '.repeat(5_000),
      '> - '.repeat(3_000),
      `${'\n'.repeat(10)}${'    '.repeat(10_000)}- x`,
      '\u0000'.repeat(1_000),
      '\ud800'.repeat(1_000),
    ]) {
      expect(() => renderMarkdown(source), source.slice(0, 12)).not.toThrow();
    }
  });

  it('shows something for what is not a string', () => {
    for (const value of [undefined, null, 42, {}]) {
      expect(() => renderMarkdown(value as unknown as string)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// What must not change: text within budget renders exactly as the unbounded pipeline renders it.
// ---------------------------------------------------------------------------------------------

const html = (fragment: DocumentFragment) => holderOf(fragment).innerHTML;

/** A plausible study note of about `chars` characters: prose, lists, a table, code, math, links. */
function studyNote(chars: number): string {
  const section = (i: number) =>
    String.raw`## ${i}. The cell membrane and transport

The **plasma membrane** is a *phospholipid bilayer* with embedded proteins (see [Alberts, Molecular Biology of the Cell](https://example.com/mbc/${i})). It is _selectively permeable_: small non-polar molecules such as O2 and CO2 cross freely, while ions and polar molecules need ` +
    '`channel`' +
    String.raw` or ` +
    '`carrier`' +
    String.raw` proteins. Resting potential is about -70 mV, and the Nernst equation $E = \frac{RT}{zF}\ln\frac{[X]_o}{[X]_i}$ gives the equilibrium potential for one ion. It costs $5 and $10, which is not math.

### Key points

- **Simple diffusion**: down the gradient, no energy, no protein.
- **Facilitated diffusion**: channels (gated) or carriers (saturable, specific).
  - Voltage-gated Na+ channels open at about -55 mV.
  - Ligand-gated channels such as the nicotinic ACh receptor.
    - Subunits: alpha, beta, gamma, delta.
- **Active transport**: primary (Na+/K+ ATPase, 3 Na+ out, 2 K+ in) and secondary (SGLT1).
- [ ] Re-read the section on osmosis
- [x] Make flashcards for the transporters

1. Identify the gradient.
2. Decide whether a protein is needed.
3. Check whether ATP is consumed directly.

> "The membrane is not a passive wall but a dynamic, regulated interface."
> This is the central idea of the chapter.

| Transport | Energy | Protein | Example |
|---|---|---|---|
| Simple diffusion | none | none | O2 |
| Facilitated | none | channel or carrier | GLUT4 |
| Primary active | ATP | pump | Na+/K+ ATPase |

` +
    '```python' +
    String.raw`
def nernst(z, conc_out, conc_in, T=310):
    # E = (RT / zF) * ln(Co / Ci)   -- _x_ and *y* are code here
    R, F = 8.314, 96485
    return (R * T) / (z * F) * math.log(conc_out / conc_in)
` +
    '```' +
    String.raw`

Display math:

$$
V_m = \frac{RT}{F}\ln\frac{P_K[K]_o + P_{Na}[Na]_o}{P_K[K]_i + P_{Na}[Na]_i}
$$

---

Further reading: [Khan Academy](https://example.org/khan) and https://example.edu/slides/${i}.pdf. Contact: tutor@example.edu. <b>Raw HTML</b> is shown as text &amp; entities are decoded.

`;
  let out = '# Cell physiology revision\n\n';
  for (let i = 1; out.length < chars; i++) out += section(i);
  return out.slice(0, chars);
}

describe('renderMarkdown: ordinary documents are not changed by the budget', () => {
  const documents: Record<string, string> = {
    'a heading, emphasis, a list and a quote':
      '# Title\n\nSome **bold** and *italic* and ~~struck~~ text.\n\n- one\n- two\n  - nested\n\n> quote\n> more\n',
    'a table': '| a | b |\n|---|:-:|\n| 1 | **2** |\n| `3` | [4](https://example.com) |\n',
    'a fenced code block with markup characters':
      '```js\nconst a = b * c; // *not emphasis* _x_ <b>\nlet snake_case = "$5 and $10";\n```\n\nafter',
    'an indented code block': 'para\n\n    code *here*\n    more_code_\n\nafter',
    'ordered and task lists': '1. a\n2. b\n   - [ ] todo\n   - [x] done\n3. c\n',
    'reference links and a definition':
      'See [the guide][g] and [other][].\n\n[g]: https://example.com/guide "Guide"\n[other]: https://example.org\n',
    'setext headings and rules': 'Title\n=====\n\nSub\n---\n\n***\n\ntext\n',
    'a lazy quote': '> first line\nsecond line\n\n> next\n',
    'math and prices':
      'Euler: $e^{i\\pi} + 1 = 0$, it costs $5 and $10.\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n',
    'raw HTML and entities':
      '<div onclick="x()">raw</div> &amp; &lt;b&gt; <script>alert(1)</script>\n',
    'hard breaks, escapes and autolinks':
      'line one  \nline two\\\nline three \\*not em\\* https://example.com/a_b_c www.example.com/x a@b.co\n',
    'CRLF line endings': '# Title\r\n\r\n- a\r\n- b\r\n\r\n> q\r\n',
    'right-to-left and CJK text':
      'غشاء البلازما **طبقة** ثنائية\n\n細胞膜は*リン脂質*二重層である。\n',
    'emphasis around punctuation and words':
      '**bold**, *em*. (_under_) "**quoted**" a*b*c snake_case_name 2*3*4\n',
    'images become their alt text': '![alt text](https://tracker.example/p.png) and <img src=x>\n',
  };

  it.each(Object.entries(documents))('%s', (_name, source) => {
    const bounded = renderMarkdown(source);
    expect(fallback(holderOf(bounded.cloneNode(true) as DocumentFragment))).toBeNull();
    const out = html(bounded);
    expect(out).toBe(html(renderMarkdownUnbounded(source)));
    expect(out.length).toBeGreaterThan(0);
  });

  it('keeps literal output stable (a few documents, written out)', () => {
    expect(renderMarkdownToHtml('# T\n\n**b** *i* `c`\n\n- a\n- b\n')).toBe(
      '<h1>T</h1>\n<p><strong>b</strong> <em>i</em> <code>c</code></p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n',
    );
    expect(renderMarkdownToHtml('| a |\n|---|\n| 1 |')).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n</tr>\n</tbody></table>\n',
    );
    expect(renderMarkdownToHtml('```\n*x* _y_\n```')).toBe('<pre><code>*x* _y_\n</code></pre>\n');
    expect(renderMarkdownToHtml('$x_1$ and **b**')).toBe(
      '<p><code class="math">$x_1$</code> and <strong>b</strong></p>\n',
    );
  });

  it('renders a 20,000-character study note exactly as the unbounded pipeline does', () => {
    const note = studyNote(20_000);
    expect(note).toHaveLength(20_000);
    const bounded = renderMarkdown(note);
    const holder = holderOf(bounded.cloneNode(true) as DocumentFragment);
    expect(fallback(holder)).toBeNull();
    // it has what it was written with
    expect(holder.querySelectorAll('h2').length).toBeGreaterThan(5);
    expect(holder.querySelectorAll('table').length).toBeGreaterThan(5);
    expect(holder.querySelectorAll('pre code').length).toBeGreaterThan(5);
    expect(holder.querySelectorAll('code.math-display').length).toBeGreaterThan(5);
    expect(holder.querySelectorAll('li').length).toBeGreaterThan(50);
    expect(holder.querySelectorAll('a').length).toBeGreaterThan(10);
    expect(html(bounded)).toBe(html(renderMarkdownUnbounded(note)));
  });

  it('still formats a note at the 100,000-character cap', () => {
    const note = studyNote(CAP);
    expect(note).toHaveLength(CAP);
    const started = performance.now();
    const bounded = renderMarkdown(note);
    // jsdom builds about 3,000 elements here; a bound that only catches a freeze
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(fallback(holderOf(bounded.cloneNode(true) as DocumentFragment))).toBeNull();
    expect(html(bounded)).toBe(html(renderMarkdownUnbounded(note)));
  }, 60_000);

  it('formats long text that is not expensive', () => {
    const accepted: Record<string, string> = {
      'one long line': 'a'.repeat(CAP),
      'one long paragraph of words': fill('word '),
      'a long paragraph of prose': fill(
        'The plasma membrane is a phospholipid bilayer; it is selective (see Alberts, 2015). ',
      ),
      'delimiters with nothing to open': fill('*'),
      underscores: fill('_'),
      tildes: fill('~'),
      'closing brackets': fill(']'),
      ampersands: fill('&a'),
      'reference definitions, which print nothing': fill('[a]: /u\n'),
      'blank lines': '\n'.repeat(CAP),
      'text in a script with no delimiters': fill(
        '細胞膜はリン脂質二重層であり、選択的透過性を持つ。',
      ),
      'a fence with thousands of lines of markup characters': `\`\`\`\n${fill('*a_ [b](c) <d> $e\\ \n', 90_000)}\n\`\`\`\n`,
    };
    for (const [name, source] of Object.entries(accepted)) {
      const started = performance.now();
      const holder = holderOf(renderMarkdown(source));
      expect(performance.now() - started, name).toBeLessThan(2_000);
      expect(fallback(holder), name).toBeNull();
    }
  });
});
