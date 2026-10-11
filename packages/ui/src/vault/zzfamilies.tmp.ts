// @ts-nocheck
// Adversarial families for marked. Each builds a string of exactly `n` characters.
export const N = 100_000;
const fill = (unit, n = N) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

export const FAMILIES = {
  // emphasis delimiters
  'star-a': (n) => fill('*a', n),
  'star-only': (n) => fill('*', n),
  'under-a': (n) => fill('_a', n),
  'dstar-a': (n) => fill('**a', n),
  'a-star': (n) => fill('a*', n),
  'star-sp-a': (n) => fill('* a ', n),
  'star-a-under': (n) => fill('*a_', n),
  'tilde-a': (n) => fill('~~a', n),
  'tilde-only': (n) => fill('~', n),
  'under-only': (n) => fill('_', n),
  'star-open-punct': (n) => fill('*(', n),
  'star-word-star': (n) => fill('*a* ', n),
  'dstar-word': (n) => fill('**a ', n),
  'tstar-a': (n) => fill('***a', n),
  'star-a-star-star': (n) => fill('*a**', n),
  'star-cjk': (n) => fill('*あ', n),
  // brackets / links / images
  'lbracket': (n) => fill('[', n),
  'rbracket': (n) => fill(']', n),
  'lb-a': (n) => fill('[a', n),
  'lb-a-rb-lp': (n) => fill('[a](', n),
  'lb-a-rb': (n) => fill('[a]', n),
  'lb-a-rb-rb': (n) => fill('[a][b]', n),
  'img-lb': (n) => fill('![', n),
  'nested-brackets': (n) => '['.repeat(n / 2) + ']'.repeat(n / 2),
  'link-open-paren': (n) => fill('[a](b(', n),
  'link-angle': (n) => fill('[a](<', n),
  'ref-defs': (n) => fill('[a]: /u\n', n),
  'ref-defs-and-uses': (n) => fill('[a]: /u\n', n / 2) + fill('[a][a] ', n / 2),
  'ref-defs-many-uses': (n) => '[a]: /u\n' + fill('[a] [a] [a] ', n),
  'ref-storm-distinct': (n) => {
    let s = '';
    for (let i = 0; s.length < n / 2; i++) s += `[r${i}]: /u\n`;
    let t = '';
    for (let i = 0; s.length + t.length < n; i++) t += `[r${i}] `;
    return (s + t).slice(0, n);
  },
  'lb-code': (n) => fill('[`', n),
  'lb-bs': (n) => fill('[\\', n),
  'lb-text-ref-use': (n) => '[a]: /u\n' + fill('[x [a] ', n),
  // code spans / escapes / html / entities
  'backtick': (n) => fill('`', n),
  'backtick-a': (n) => fill('`a', n),
  'backtick-2-a': (n) => fill('``a', n),
  'backtick-incr': (n) => {
    let s = '';
    for (let i = 1; s.length < n; i++) s += '`'.repeat(i) + 'a ';
    return s.slice(0, n);
  },
  'backslash': (n) => fill('\\', n),
  'lt': (n) => fill('<', n),
  'lt-a': (n) => fill('<a ', n),
  'lt-a-attr': (n) => fill('<a b="', n),
  'lt-bang': (n) => fill('<!--', n),
  'lt-div': (n) => fill('<div>\n', n),
  'lt-at': (n) => fill('<a@b', n),
  'amp': (n) => fill('&', n),
  'amp-word': (n) => fill('&a', n),
  'url-like': (n) => fill('http://a.b/', n),
  'www-like': (n) => fill('www.a.b ', n),
  'email-like': (n) => fill('a@b.c ', n),
  'email-dots': (n) => fill('a.', n),
  'colon-url': (n) => fill('a:', n),
  // block structures
  'bq': (n) => fill('> ', n),
  'bq-lines': (n) => fill('> a\n', n),
  'bq-nest-lines': (n) => {
    let s = '';
    for (let i = 1; s.length < n; i++) s += '> '.repeat(Math.min(i, 400)) + 'a\n';
    return s.slice(0, n);
  },
  'bq-lazy': (n) => fill('> a\nb\n', n),
  'list-dash': (n) => fill('- a\n', n),
  'list-nested-indent': (n) => {
    let s = '';
    for (let i = 0; s.length < n; i++) s += '  '.repeat(Math.min(i, 200)) + '- a\n';
    return s.slice(0, n);
  },
  'list-nested-inline': (n) => fill('- ', n),
  'list-ol-inline': (n) => fill('1. ', n),
  'list-mixed-loose': (n) => fill('- a\n\n', n),
  'list-ol-nest': (n) => {
    let s = '';
    for (let i = 0; s.length < n; i++) s += '   '.repeat(Math.min(i, 150)) + '1. a\n';
    return s.slice(0, n);
  },
  'list-tasks': (n) => fill('- [ ] a\n', n),
  'table-rows': (n) => '|a|b|\n|-|-|\n' + fill('|a|b|\n', n),
  'table-wide': (n) => '|' + 'a|'.repeat(n / 4) + '\n|' + '-|'.repeat(n / 4) + '\n',
  'table-pipes': (n) => fill('|', n),
  'table-esc': (n) => '|a|\n|-|\n|' + fill('\\|', n),
  'heading-hash': (n) => fill('#', n),
  'heading-lines': (n) => fill('# a\n', n),
  'setext': (n) => fill('a\n===\n', n),
  'hr': (n) => fill('---\n', n),
  'hr-sp': (n) => fill('- - ', n),
  'fence-open': (n) => fill('```\n', n),
  'fence-lang': (n) => fill('```a\nb\n', n),
  'tilde-fence': (n) => fill('~~~\n', n),
  'indent-code': (n) => fill('    a\n', n),
  'long-line-words': (n) => fill('word ', n),
  'long-line-a': (n) => fill('a', n),
  'long-line-trailing-sp': (n) => 'a' + ' '.repeat(n - 2) + 'b',
  'lines-trailing-sp': (n) => fill('a  \n', n),
  'blank-lines': (n) => fill('\n', n),
  'spaces-nl': (n) => fill(' \n', n),
  'tab-lines': (n) => fill('\t\n', n),
  'paragraphs': (n) => fill('a\n\n', n),
  'html-comment': (n) => '<!--' + fill('a', n),
  'html-pre': (n) => fill('<pre>\n', n),
  'html-script': (n) => '<script>' + fill('a\n', n),
  'footnote-like': (n) => fill('[^a]: b\n', n),
  'emoji-ast': (n) => fill('*😀', n),
  'ast-nl': (n) => fill('*a\n', n),
  'star-nl-sp': (n) => fill('*\n', n),
  'underscore-words': (n) => fill('a_b_', n),
  'star-in-link-text': (n) => fill('[*a](', n),
};

// ---- added after the first calibration ----
const cjk = '細胞膜はリン脂質二重層であり、選択的透過性を持つ。タンパク質が埋め込まれている。';
const arabic = 'الغشاء البلازمي هو طبقة ثنائية من الدهون الفسفورية وهو شبه منفذ بشكل انتقائي. ';
FAMILIES['cjk-text'] = (n) => fill(cjk, n);
FAMILIES['arabic-text'] = (n) => fill(arabic, n);
FAMILIES['prose'] = (n) => fill('The plasma membrane is a phospholipid bilayer, with embedded proteins; it is selectively permeable (see Alberts, 2015). ', n);
FAMILIES['prose-bold'] = (n) => fill('The **plasma membrane** is a *phospholipid bilayer* with `channel` proteins and a [link](https://example.com/x). ', n);
FAMILIES['url-long'] = (n) => 'http://a.b/' + fill('x.', n);
FAMILIES['url-underscore'] = (n) => 'https://example.com/' + fill('some_path_', n);
FAMILIES['base64-blob'] = (n) => fill('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo_abcdefghijklmnopqrstuvwxyz-0123456789', n);
FAMILIES['dollar-prices'] = (n) => fill('It costs $5 and $10 today. ', n);
FAMILIES['math-inline'] = (n) => fill('Let $a_1 + b_2 = c_3$ and $x^2 * y_i$ hold. ', n);
FAMILIES['math-display'] = (n) => fill('$$\n\int_0^1 x\,dx = \frac{1}{2}\n$$\n\n', n);
FAMILIES['bold-glossary'] = (n) => fill('- **Term**: a definition of the term, with *emphasis*.\n', n);
FAMILIES['bold-paragraph'] = (n) => fill('**bold** word, ', n);
FAMILIES['snake-case'] = (n) => fill('my_variable_name = other_value_here; ', n);
FAMILIES['code-heavy-fence'] = (n) => '```c\n' + fill('int *p = &a[0]; /* __init__ _x_ */\n', n) + '\n```\n';
FAMILIES['numbered-citations'] = (n) => fill('Membranes are fluid [1][2] and selective [3]. ', n);
FAMILIES['table-realistic'] = (n) => '| Transport | Energy | Example |\n|---|---|---|\n' + fill('| Facilitated | none | GLUT4 *carrier* |\n', n);
FAMILIES['bang-a'] = (n) => fill('!a', n);
