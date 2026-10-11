import { HtmlAnchorSet } from '@shared';
import { MAX_QUOTE_CHARS } from '@shared/constants';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureAnchor } from './capture';
import { structuralPath } from './structuralPath';
import { buildTextStream } from './textStream';
import { capture, rangeOver, setBody } from './testUtils';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('captureAnchor', () => {
  it('produces an anchor set that passes the shared zod schema', () => {
    setBody('<article><h2>Cell biology</h2><p>The <b>mitochondria</b> produce ATP.</p></article>');
    const { anchorSet } = capture('mitochondria produce ATP');
    expect(HtmlAnchorSet.safeParse(anchorSet).success).toBe(true);
    expect(anchorSet.textAlgorithm).toBe('sv-text-v1');
    expect(anchorSet.type).toBe('html');
  });

  it('records quote, 32-char context, position, signature and length from the stream', () => {
    setBody('<p>The quick brown fox jumps over the lazy dog while the sun sets slowly.</p>');
    const { anchorSet, stream } = capture('jumps over the lazy dog');
    const text = 'The quick brown fox jumps over the lazy dog while the sun sets slowly.';
    const start = text.indexOf('jumps');
    expect(anchorSet.textQuote.exact).toBe('jumps over the lazy dog');
    expect(anchorSet.textPosition).toEqual({
      start,
      end: start + 'jumps over the lazy dog'.length,
    });
    expect(anchorSet.textQuote.prefix).toBe(text.slice(Math.max(0, start - 32), start));
    expect(anchorSet.textQuote.suffix).toBe(text.slice(start + 23, start + 23 + 32));
    expect(anchorSet.textQuote.prefix.length).toBeLessThanOrEqual(32);
    expect(anchorSet.contentSignature).toBe(stream.signature);
    expect(anchorSet.documentTextLength).toBe(text.length);
  });

  it('uses a shorter prefix at the very start of the document', () => {
    setBody('<p>Alpha beta gamma</p>');
    const { anchorSet } = capture('Alpha');
    expect(anchorSet.textQuote.prefix).toBe('');
    expect(anchorSet.textPosition.start).toBe(0);
  });

  it('trims stream whitespace at both ends before taking offsets', () => {
    setBody('<p>one <b> two three </b> four</p>');
    const { anchorSet, exactQuote } = capture(' two three ');
    expect(anchorSet.textQuote.exact).toBe('two three');
    expect(exactQuote).toBe('two three');
    expect(anchorSet.textPosition).toEqual({ start: 4, end: 13 });
  });

  it('keeps exactQuote as the trimmed selection text, preserving internal whitespace', () => {
    setBody('<p>first</p><p>second</p>');
    const range = rangeOver('first');
    range.setEnd(document.body.lastChild!.firstChild!, 6);
    const result = captureAnchor(range, '  first\n\nsecond \n', buildTextStream());
    if ('error' in result) throw new Error(result.error);
    expect(result.exactQuote).toBe('first\n\nsecond');
    expect(result.anchorSet.textQuote.exact).toBe('firstsecond'); // stream has no separators
  });

  it('handles element-container (triple-click) selections', () => {
    setBody('<p id="p1">Triple click me</p><p id="p2">next block</p>');
    const range = document.createRange();
    range.setStart(document.getElementById('p1')!, 0);
    range.setEnd(document.getElementById('p2')!, 0);
    const result = captureAnchor(range, 'Triple click me\n', buildTextStream());
    if ('error' in result) throw new Error(result.error);
    expect(result.anchorSet.textQuote.exact).toBe('Triple click me');
  });

  describe('failures', () => {
    it('empty selection text', () => {
      setBody('<p>hello</p>');
      expect(captureAnchor(rangeOver('hello'), '   \n', buildTextStream())).toEqual({
        error: 'empty',
      });
    });

    it('range that only covers whitespace', () => {
      setBody('<p>a</p><p>   </p><p>b</p>');
      const r = document.createRange();
      const mid = document.body.childNodes[1]!;
      r.selectNodeContents(mid);
      expect(captureAnchor(r, 'x', buildTextStream())).toEqual({ error: 'empty' });
    });

    it('selection inside an excluded subtree', () => {
      setBody('<p>a</p><div data-studyvault>overlay words</div>');
      expect(captureAnchor(rangeOver('overlay'), 'overlay', buildTextStream())).toEqual({
        error: 'empty',
      });
    });

    it('quote longer than MAX_QUOTE_CHARS', () => {
      setBody(`<p>${'word '.repeat(MAX_QUOTE_CHARS / 4)}</p>`);
      const range = document.createRange();
      range.selectNodeContents(document.body);
      const result = captureAnchor(range, range.toString(), buildTextStream());
      expect(result).toEqual({ error: 'too-long' });
    });

    it('a quote of exactly MAX_QUOTE_CHARS is accepted', () => {
      const long = 'x'.repeat(MAX_QUOTE_CHARS);
      setBody(`<p>${long}</p>`);
      const result = capture(long);
      expect(result.anchorSet.textQuote.exact).toHaveLength(MAX_QUOTE_CHARS);
      expect(HtmlAnchorSet.safeParse(result.anchorSet).success).toBe(true);
    });

    it('range outside the root (document <head>)', () => {
      document.head.innerHTML = '<title>Page title words</title>';
      setBody('<p>body text</p>');
      const range = rangeOver('title words', 0, document.head);
      expect(captureAnchor(range, 'title words', buildTextStream())).toEqual({
        error: 'outside-root',
      });
    });
  });

  describe('headingContext', () => {
    it('is the nearest preceding heading', () => {
      setBody(
        '<h1>Biology</h1><section><h2>Cells</h2><p>intro</p></section><section><h3>Organelles</h3><div><p>The <b>ribosome</b> builds proteins.</p></div></section>',
      );
      expect(capture('ribosome builds').headingContext).toBe('Organelles');
    });

    it('finds a heading inside an earlier sibling subtree', () => {
      setBody('<div><div><h2>Deep heading</h2></div></div><p>Some paragraph text</p>');
      expect(capture('paragraph').headingContext).toBe('Deep heading');
    });

    it('uses the heading itself when the quote is inside it', () => {
      setBody('<h1>Top</h1><h2>The <em>Krebs</em> cycle</h2><p>x</p>');
      expect(capture('Krebs').headingContext).toBe('The Krebs cycle');
    });

    it('is null when no heading precedes the quote', () => {
      setBody('<p>No heading here</p><h2>Later</h2>');
      expect(capture('No heading').headingContext).toBeNull();
    });

    it('collapses whitespace and clips to 300 chars', () => {
      const long = 'Heading '.repeat(80);
      setBody(`<h2>  ${long} \n</h2><p>quote text here</p>`);
      const h = capture('quote text').headingContext!;
      expect(h.length).toBeLessThanOrEqual(300);
      expect(h.startsWith('Heading Heading')).toBe(true);
    });

    it('ignores headings inside the StudyVault host', () => {
      setBody('<h1>Real</h1><div data-studyvault><h2>Overlay</h2></div><p>the quote</p>');
      expect(capture('the quote').headingContext).toBe('Real');
    });

    it('falls back to the previous public heading when the nearest one is in an editor', () => {
      setBody(
        '<h1>Public chapter</h1><div role="textbox"><h2>Typed draft heading</h2></div><p>the quote</p>',
      );
      expect(capture('the quote').headingContext).toBe('Public chapter');
    });

    it('treats contenteditable="" as editable but contenteditable="false" as plain content', () => {
      setBody('<div contenteditable=""><h2>Editable</h2></div><p>first quote</p>');
      expect(capture('first quote').headingContext).toBeNull();
      setBody('<div contenteditable="false"><h2>Static</h2></div><p>second quote</p>');
      expect(capture('second quote').headingContext).toBe('Static');
    });

    it('ignores headings inside template, noscript and svg subtrees', () => {
      setBody(
        '<h1>Visible</h1><noscript><h2>Fallback</h2></noscript><svg><foreignObject><h3>In svg</h3></foreignObject></svg><p>the quote</p>',
      );
      expect(capture('the quote').headingContext).toBe('Visible');
    });

    it('drops aria-hidden permalink glyphs and zero-width characters, keeps real text', () => {
      setBody(
        '<h2>Dosing<span aria-hidden="true"> # </span><a href="#d">\u00A7</a>\u200B guide</h2><p>the quote</p>',
      );
      expect(capture('the quote').headingContext).toBe('Dosing guide');
    });

    it('keeps aria-hidden text that is real content and a literal "C#"', () => {
      setBody('<h2><span aria-hidden="true">Chapter 2</span> and C#</h2><p>the quote</p>');
      expect(capture('the quote').headingContext).toBe('Chapter 2 and C#');
    });

    it('keeps heading text split across inline elements and ignores style/script inside', () => {
      setBody(
        '<h2>The <em>Krebs</em><style>.x{color:red}</style> <script>1</script>cycle</h2><p>the quote</p>',
      );
      expect(capture('the quote').headingContext).toBe('The Krebs cycle');
    });
  });

  describe('structuralPath', () => {
    it('is a nth-of-type chain stopping at an element with an id', () => {
      setBody('<main id="m"><section><p>a</p><p>b <i>target</i></p></section></main>');
      const { anchorSet } = capture('target');
      expect(anchorSet.structuralPath).toBe(
        'main[id="m"] > section:nth-of-type(1) > p:nth-of-type(2) > i:nth-of-type(1)',
      );
    });

    it('is at most 8 levels deep', () => {
      let html = 'deep text';
      for (let i = 0; i < 12; i++) html = `<div>${html}</div>`;
      setBody(html);
      const path = capture('deep text').anchorSet.structuralPath!;
      expect(path.split(' > ')).toHaveLength(8);
    });

    it('never throws and returns null for nothing', () => {
      expect(structuralPath(null)).toBeNull();
      expect(structuralPath(undefined)).toBeNull();
      expect(structuralPath(document.createTextNode('x') as unknown as Element)).toBeNull();
    });

    it('stays within the schema limit even for a huge id', () => {
      setBody(`<div id="${'x'.repeat(2000)}"><p>hi there</p></div>`);
      const path = structuralPath(document.querySelector('p'));
      expect(path === null || path.length <= 1024).toBe(true);
    });

    it('escapes quotes in ids so the hint stays a valid selector', () => {
      setBody("<div id='a\"b\\c'><p>hi there</p></div>");
      const path = structuralPath(document.querySelector('p'))!;
      expect(path).toBe('div[id="a\\"b\\\\c"] > p:nth-of-type(1)');
      expect(document.querySelector(path)).toBe(document.querySelector('p'));
    });
  });
});
