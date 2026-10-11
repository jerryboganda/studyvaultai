import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownToHtml } from './markdownRender';

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
      expect(['href', 'title', 'start', 'target', 'rel']).toContain(attr.name);
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

  const hostile: Array<[string, string]> = [
    ['script tag', '<script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['svg onload', '<svg onload=alert(1)></svg>'],
    ['svg script', '<svg><script>alert(1)</script></svg>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['object', '<object data="javascript:alert(1)"></object>'],
    ['embed', '<embed src="javascript:alert(1)">'],
    ['style', '<style>body{display:none}</style>'],
    ['inline style', '<p style="background:url(javascript:alert(1))">x</p>'],
    ['form', '<form action="https://evil.example"><input name=a><button>go</button></form>'],
    ['details ontoggle', '<details open ontoggle=alert(1)>x</details>'],
    ['math', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
    ['base', '<base href="https://evil.example/">'],
    ['link', '<link rel="stylesheet" href="https://evil.example/x.css">'],
    ['anchor javascript raw', '<a href="javascript:alert(1)">x</a>'],
    ['anchor onclick raw', '<a href="https://ok.example" onclick="alert(1)">x</a>'],
    ['md javascript', '[x](javascript:alert(1))'],
    ['md javascript mixed case', '[x](JaVaScRiPt:alert(1))'],
    ['md javascript entity', '[x](&#106;avascript:alert(1))'],
    ['md javascript tab', '[x](java\tscript:alert(1))'],
    ['md data', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['md vbscript', '[x](vbscript:msgbox(1))'],
    ['md blob', '[x](blob:https://example.com/uuid)'],
    ['md file', '[x](file:///etc/passwd)'],
    ['md mailto', '[x](mailto:someone@example.com)'],
    ['md relative', '[x](/relative/path)'],
    ['md protocol relative', '[x](//evil.example/x)'],
    ['md fragment', '[x](#anchor)'],
    ['md title injection', '[x](https://ok.example "t\\" onmouseover=\\"alert(1)")'],
    ['md autolink javascript', '<javascript:alert(1)>'],
    ['md reference javascript', '[x][r]\n\n[r]: javascript:alert(1)'],
    ['nested in emphasis', '**<img src=x onerror=alert(1)>**'],
    ['html in table', '| a |\n|---|\n| <img src=x onerror=alert(1)> |'],
    ['html in heading', '# <script>alert(1)</script>'],
    ['code span stays text', '`<script>alert(1)</script>`'],
  ];

  it.each(hostile)('neutralises %s', (_name, source) => {
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
    const deep = '> '.repeat(200) + 'x';
    const long = 'a'.repeat(100_000);
    expect(() => audit(deep)).not.toThrow();
    expect(audit(long).textContent?.trim()).toHaveLength(100_000);
    expect(() => audit('['.repeat(2000) + ']'.repeat(2000))).not.toThrow();
  });
});
