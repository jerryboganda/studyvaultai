import { beforeEach, describe, expect, it } from 'vitest';
import { cyrb53Hex } from './hash';
import {
  buildTextStream,
  collapseWhitespace,
  rangeToStreamOffsets,
  streamRangeToDomRange,
  streamTextOfRange,
} from './textStream';
import { rangeOver, setBody } from './testUtils';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildTextStream: sv-text-v1 rules', () => {
  it('collapses whitespace runs to one space', () => {
    setBody('<p>Hello   \n\t world</p>');
    expect(buildTextStream().text).toBe('Hello world');
  });

  it('collapses across text nodes and treats NBSP as whitespace', () => {
    setBody('<p>foo </p><p> bar\n\n\tbaz&nbsp;&nbsp;qux</p><span>&nbsp;</span><i> end</i>');
    expect(buildTextStream().text).toBe('foo bar baz qux end');
  });

  it('adds no virtual separators between blocks or inline elements', () => {
    setBody('<p>one</p><p>two</p><span>a</span><span>b</span>one<br>two');
    expect(buildTextStream().text).toBe('onetwoabonetwo');
  });

  it('drops whitespace at the start of the stream but keeps a single trailing space', () => {
    setBody('   \n <p>  x </p>\n');
    expect(buildTextStream().text).toBe('x ');
  });

  it('keeps hidden text so visibility changes cannot shift offsets', () => {
    setBody('<p style="display:none">hidden</p><p hidden>also</p><p>shown</p>');
    expect(buildTextStream().text).toBe('hiddenalsoshown');
  });

  it('does not normalise Unicode or fold case', () => {
    setBody('<p>Café café Ångström</p>');
    expect(buildTextStream().text).toBe('Café café Ångström');
  });

  it('keeps emoji surrogate pairs, ZWJ sequences and RTL text byte for byte', () => {
    const s = '\u{1F469}‍\u{1F52C} مرحبا שלום';
    setBody(`<p>${s}</p>`);
    expect(buildTextStream().text).toBe(s);
  });

  describe.each([
    ['script', '<script>var secret = 1;</script>'],
    ['style', '<style>p { color: red }</style>'],
    ['noscript', '<noscript>enable js</noscript>'],
    ['template', '<template><b>tpl</b></template>'],
    ['textarea', '<textarea>typed text</textarea>'],
    ['select/option', '<select><option>Choice</option></select>'],
    ['iframe', '<iframe>fallback</iframe>'],
    ['object', '<object>fallback</object>'],
    ['canvas', '<canvas>fallback</canvas>'],
    ['svg', '<svg><text>vector</text><title>t</title></svg>'],
    ['StudyVault host', '<div data-studyvault><span>overlay text</span></div>'],
  ])('excluded subtree: %s', (_name, html) => {
    it('never contributes text and does not break adjacent words', () => {
      setBody(`<p>before ${html} after</p>`);
      expect(buildTextStream().text).toBe('before after');
    });
  });

  it('skips a nested excluded subtree deep inside included content', () => {
    setBody('<div><p>a<span><svg><g><text>no</text></g></svg>b</span></p></div>');
    expect(buildTextStream().text).toBe('ab');
  });

  it('honours an explicit root and returns an empty stream for an excluded root', () => {
    setBody('<p id="a">alpha</p><p id="b">beta</p><script id="s">x</script>');
    expect(buildTextStream(document.getElementById('b')!).text).toBe('beta');
    expect(buildTextStream(document.getElementById('s')!).text).toBe('');
  });

  it('derives the signature lazily and deterministically', () => {
    setBody('<p>Some stable text</p>');
    const a = buildTextStream();
    const b = buildTextStream();
    expect(a.signature).toBe(cyrb53Hex('Some stable text'));
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toMatch(/^[0-9a-f]{14}$/);
    setBody('<p>Some stable texu</p>');
    expect(buildTextStream().signature).not.toBe(a.signature);
  });
});

describe('segments', () => {
  const html =
    '<p>foo  <b>bar</b>\n baz</p><p>  qux&nbsp;</p><ul><li>one</li><li>two   three</li></ul>';

  it('partition the stream contiguously and map back to the original characters', () => {
    setBody(html);
    const { text, segments } = buildTextStream();
    let cursor = 0;
    for (const seg of segments) {
      expect(seg.streamStart).toBe(cursor);
      expect(seg.streamEnd).toBeGreaterThan(seg.streamStart);
      expect(seg.nodeEnd).toBeGreaterThan(seg.nodeStart);
      expect(seg.nodeEnd).toBeLessThanOrEqual(seg.node.data.length);
      const fromNode = collapseWhitespace(seg.node.data.slice(seg.nodeStart, seg.nodeEnd));
      expect(fromNode).toBe(text.slice(seg.streamStart, seg.streamEnd));
      cursor = seg.streamEnd;
    }
    expect(cursor).toBe(text.length);
  });

  it('merges adjacent characters of one node into few segments', () => {
    setBody('<p>one two three four five six seven</p>');
    expect(buildTextStream().segments).toHaveLength(1);
  });
});

describe('rangeToStreamOffsets', () => {
  it('maps a range inside one text node', () => {
    setBody('<p>The quick brown fox</p>');
    const stream = buildTextStream();
    const r = rangeOver('quick');
    expect(rangeToStreamOffsets(stream, r)).toEqual({ start: 4, end: 9 });
  });

  it('maps a range across inline elements', () => {
    setBody('<p>The <a href="#">quick</a> <strong>brown <em>fox</em></strong> jumps</p>');
    const stream = buildTextStream();
    const r = rangeOver('quick brown fox');
    const o = rangeToStreamOffsets(stream, r)!;
    expect(stream.text.slice(o.start, o.end)).toBe('quick brown fox');
  });

  it('maps element-container boundaries (triple-click ends at offset 0 of the next block)', () => {
    setBody('<p id="p1">First paragraph.</p><p id="p2">Second paragraph.</p>');
    const stream = buildTextStream();
    const r = document.createRange();
    r.setStart(document.getElementById('p1')!, 0);
    r.setEnd(document.getElementById('p2')!, 0);
    const o = rangeToStreamOffsets(stream, r)!;
    expect(stream.text.slice(o.start, o.end)).toBe('First paragraph.');
  });

  it('maps a boundary after the last child of the body', () => {
    setBody('<p>one</p><p>two</p>');
    const stream = buildTextStream();
    const r = document.createRange();
    r.setStart(document.body.firstChild!, 0);
    r.setEnd(document.body, document.body.childNodes.length);
    expect(rangeToStreamOffsets(stream, r)).toEqual({ start: 0, end: 6 });
  });

  it('maps boundaries placed in whitespace-only and skipped nodes without throwing', () => {
    setBody('<p>one</p>\n<script>zzz</script>\n<p>two</p>');
    const stream = buildTextStream();
    const script = document.querySelector('script')!.firstChild!;
    const r = document.createRange();
    r.setStart(script, 1);
    r.setEnd(script, 2);
    const o = rangeToStreamOffsets(stream, r)!;
    expect(o.start).toBe(o.end); // nothing from the script is in the stream
  });

  it('returns null for a range outside the stream root', () => {
    setBody('<p id="a">alpha</p><p id="b">beta</p>');
    const stream = buildTextStream(document.getElementById('a')!);
    expect(rangeToStreamOffsets(stream, rangeOver('beta'))).toBeNull();
  });

  it('collapsed whitespace: boundary inside a multi-space run still maps', () => {
    setBody('<p>foo      bar</p>');
    const stream = buildTextStream();
    const r = rangeOver('bar');
    expect(rangeToStreamOffsets(stream, r)).toEqual({ start: 4, end: 7 });
  });
});

describe('streamRangeToDomRange', () => {
  it('start prefers the segment that begins at the offset, end the one that ends there', () => {
    setBody('<p id="a">ab</p><p id="b">cd</p>');
    const stream = buildTextStream();
    const a = document.getElementById('a')!.firstChild!;
    const b = document.getElementById('b')!.firstChild!;

    const first = streamRangeToDomRange(stream, 0, 2)!;
    expect([first.endContainer, first.endOffset]).toEqual([a, 2]); // not (b, 0)
    const second = streamRangeToDomRange(stream, 2, 4)!;
    expect([second.startContainer, second.startOffset]).toEqual([b, 0]); // not (a, 2)
    expect(first.toString()).toBe('ab');
    expect(second.toString()).toBe('cd');
  });

  it('rejects invalid offsets', () => {
    setBody('<p>hello</p>');
    const stream = buildTextStream();
    expect(streamRangeToDomRange(stream, -1, 2)).toBeNull();
    expect(streamRangeToDomRange(stream, 2, 2)).toBeNull();
    expect(streamRangeToDomRange(stream, 3, 2)).toBeNull();
    expect(streamRangeToDomRange(stream, 0, 6)).toBeNull();
    expect(streamRangeToDomRange(stream, 0.5, 2)).toBeNull();
  });

  it('round-trips every (start, end) pair on a whitespace-heavy document', () => {
    setBody('<p>foo  <b>bar</b>\n baz</p><p>  qux&nbsp;x</p><i>a</i> <i>b</i>');
    const stream = buildTextStream();
    const n = stream.text.length;
    let checked = 0;
    for (let s = 0; s < n; s++) {
      for (let e = s + 1; e <= n; e++) {
        const range = streamRangeToDomRange(stream, s, e);
        expect(range, `range ${s}-${e}`).not.toBeNull();
        expect(rangeToStreamOffsets(stream, range!)).toEqual({ start: s, end: e });
        expect(streamTextOfRange(range!)).toBe(stream.text.slice(s, e));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('returns null when the stream is stale (node removed or shortened)', () => {
    setBody('<p id="a">alpha beta</p><p id="b">gamma</p>');
    const stream = buildTextStream();
    document.getElementById('b')!.remove();
    expect(streamRangeToDomRange(stream, 11, 16)).toBeNull();
    (document.getElementById('a')!.firstChild as Text).data = 'al';
    expect(streamRangeToDomRange(stream, 0, 10)).toBeNull();
  });
});

describe('streamTextOfRange', () => {
  it('excludes skipped subtrees inside the range and collapses whitespace', () => {
    setBody('<p>one <script>nope()</script> two</p><p>three <textarea>t</textarea>four</p>');
    const r = rangeOver('one ');
    r.setEnd(document.body, document.body.childNodes.length);
    expect(streamTextOfRange(r)).toBe('one twothree four'); // no separator between blocks
  });

  it('returns empty text for a range entirely inside an excluded subtree', () => {
    setBody('<p>a</p><style>body { }</style>');
    expect(streamTextOfRange(rangeOver('body'))).toBe('');
  });
});
