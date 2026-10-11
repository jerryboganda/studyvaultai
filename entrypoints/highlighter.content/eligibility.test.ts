import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_QUOTE_CHARS } from '@shared';
import { buildTextStream, captureAnchor } from '@highlights';
import {
  inspectSelection,
  isEditableElement,
  isEditingContext,
  isInsideHost,
  sameRange,
  withoutEditableContext,
} from './eligibility';
import { clearSelection, emulateUserModify, rangeOver, select, setBody } from './testUtils';

beforeEach(() => {
  clearSelection();
});
afterEach(() => {
  clearSelection();
  setBody('');
  document.designMode = 'off';
});

describe('inspectSelection', () => {
  it('accepts ordinary page text and returns a clone', () => {
    setBody('<p>The quick brown fox jumps over the lazy dog.</p>');
    const live = select('brown fox');
    const verdict = inspectSelection(document);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.text).toBe('brown fox');
    expect(verdict.range).not.toBe(live);
    expect(sameRange(verdict.range, live)).toBe(true);
    // The clone keeps its boundaries when the page selection goes away.
    clearSelection();
    expect(verdict.range.toString()).toBe('brown fox');
  });

  it('ignores a collapsed or empty selection', () => {
    setBody('<p>Some text here</p>');
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'no-selection' });
    const p = document.querySelector('p')!.firstChild!;
    document.getSelection()!.collapse(p, 3);
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'no-selection' });
  });

  it('ignores whitespace-only selections', () => {
    setBody('<p>a</p><div id="gap">   </div><p>b</p>');
    const gap = document.getElementById('gap')!.firstChild!;
    const range = document.createRange();
    range.setStart(gap, 0);
    range.setEnd(gap, 3);
    document.getSelection()!.addRange(range);
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'no-selection' });
  });

  it.each([
    ['textarea', '<textarea id="f">hello world text</textarea>'],
    ['text input', '<input id="f" type="text" value="hello world text">'],
    ['password input', '<input id="f" type="password" value="hunter2 hunter2">'],
    ['select', '<select id="f"><option>one two three</option></select>'],
  ])('ignores a selection while a %s has focus', (_name, html) => {
    setBody(`<p>Visible paragraph text</p>${html}`);
    (document.getElementById('f') as HTMLElement).focus();
    select('Visible paragraph'); // a script (or autofocus) can leave a field focused under a selection
    expect(document.activeElement?.id).toBe('f');
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
  });

  it('ignores selections inside contenteditable and role=textbox regions', () => {
    setBody(
      '<div contenteditable="true"><p id="ce">Editable words here</p></div>' +
        '<div role="textbox"><span>Aria textbox words</span></div>' +
        '<p>Plain words here</p>',
    );
    select('Editable words');
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
    select('Aria textbox');
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
    select('Plain words');
    expect(inspectSelection(document).ok).toBe(true);
  });

  describe('a selection made INSIDE a focused field (Chromium reports the document selection as collapsed)', () => {
    it.each([
      ['text input', '<input id="f" type="text" value="selectable value inside an input">'],
      ['password input', '<input id="f" type="password" value="hunter2-secret">'],
      ['textarea', '<textarea id="f">text inside a textarea that must not be captured</textarea>'],
    ])('is "editable" for a %s, and a bare caret is "no-selection"', (_name, html) => {
      setBody(`<p>Visible paragraph text</p>${html}`);
      const field = document.getElementById('f') as HTMLInputElement | HTMLTextAreaElement;
      field.focus();
      clearSelection(); // what Chromium's getSelection() reports for a field's own selection
      field.setSelectionRange(2, 9);
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
      field.setSelectionRange(4, 4);
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'no-selection' });
    });

    it('never reads the field value to decide', () => {
      setBody('<input id="f" type="text" value="hunter2-secret">');
      const field = document.getElementById('f') as HTMLInputElement;
      field.focus();
      field.setSelectionRange(0, 6);
      const read = vi.spyOn(HTMLInputElement.prototype, 'value', 'get');
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
      expect(read).not.toHaveBeenCalled();
    });

    it('sees a field inside an open shadow root through the host', () => {
      setBody('<p>Visible paragraph text</p><div id="comp"></div>');
      const shadow = document.getElementById('comp')!.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<input id="inner" type="text" value="shadow field value">';
      const inner = shadow.getElementById('inner') as HTMLInputElement;
      inner.focus();
      inner.setSelectionRange(0, 6);
      expect(document.activeElement?.id).toBe('comp'); // retargeted to the host
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
    });
  });

  describe('a selection that passes THROUGH a field or editor is refused whole', () => {
    const PAGE = (middle: string): string =>
      `<p id="a">Public text before the editor.</p>${middle}<p id="b">Public text after the editor.</p>`;

    function selectAcross(): Range {
      const range = document.createRange();
      range.setStart(document.getElementById('a')!.firstChild!, 0);
      range.setEnd(document.getElementById('b')!.firstChild!, 11);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return range;
    }

    it.each([
      ['contenteditable', '<div contenteditable="true">PRIVATE-DRAFT typed words</div>'],
      [
        'plaintext-only editor',
        '<div contenteditable="plaintext-only">PRIVATE-DRAFT typed words</div>',
      ],
      ['bare contenteditable attribute', '<div contenteditable>PRIVATE-DRAFT typed words</div>'],
      [
        'nested element of an editor',
        '<div contenteditable="true"><ul><li>PRIVATE-DRAFT typed</li></ul></div>',
      ],
      ['role=textbox', '<div role="textbox" tabindex="0">PRIVATE-DRAFT typed words</div>'],
      ['textarea', '<textarea>PRIVATE-DRAFT typed words</textarea>'],
      ['text input', '<input type="text" value="PRIVATE-DRAFT typed words">'],
      ['password input', '<input type="password" value="PRIVATE-DRAFT typed words">'],
      ['select', '<select><option>PRIVATE-DRAFT typed words</option></select>'],
    ])('refuses a drag from plain text across a %s', (_name, middle) => {
      setBody(PAGE(middle));
      const range = selectAcross();
      if (middle.includes('PRIVATE-DRAFT typed') && !/<(input|textarea|select)/.test(middle)) {
        // The engine really does put the editor's text into the selection string.
        expect(range.toString()).toContain('PRIVATE-DRAFT');
      }
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
    });

    it('refuses Select All on a page with an editor in the middle', () => {
      setBody(
        `<h1>Title</h1>${PAGE('<div contenteditable="true">PRIVATE-DRAFT typed words</div>')}`,
      );
      document.getSelection()!.selectAllChildren(document.body);
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
    });

    it('refuses everything while designMode is on, even a range between two plain paragraphs', () => {
      setBody(PAGE(''));
      selectAcross();
      document.designMode = 'on';
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
    });

    it('accepts a selection that ends where the editor begins (it holds none of its text)', () => {
      setBody(PAGE('<div contenteditable="true">PRIVATE-DRAFT typed words</div>'));
      const range = document.createRange();
      range.setStart(document.getElementById('a')!.firstChild!, 0);
      range.setEnd(document.body, 1); // after <p id="a">, before the editor
      document.getSelection()!.addRange(range);
      const verdict = inspectSelection(document);
      expect(verdict.ok).toBe(true);
      if (verdict.ok) expect(verdict.text).toBe('Public text before the editor.');
    });

    describe('a selection whose end merely touches the start of an editor (triple-click on the paragraph above it)', () => {
      /** What Chromium reports for that triple-click: the end is (editor, 0), inside the editor. */
      function tripleClickAbove(end: () => [Node, number]): Range {
        const range = document.createRange();
        range.setStart(document.getElementById('a')!.firstChild!, 0);
        range.setEnd(...end());
        const sel = document.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return range;
      }
      const editor = (): HTMLElement => document.getElementById('ed')!;

      it.each([
        [
          'contenteditable, end at (editor, 0)',
          '<div id="ed" contenteditable="true">PRIVATE-DRAFT typed words</div>',
          () => [editor(), 0] as [Node, number],
        ],
        [
          'contenteditable, end at (its text, 0)',
          '<div id="ed" contenteditable="true">PRIVATE-DRAFT typed words</div>',
          () => [editor().firstChild!, 0] as [Node, number],
        ],
        [
          'nested block of an editor, end at (block, 0)',
          '<div id="ed" contenteditable="true"><p id="d">PRIVATE-DRAFT typed words</p></div>',
          () => [document.getElementById('d')!, 0] as [Node, number],
        ],
        [
          'role=textbox, end at (textbox, 0)',
          '<div id="ed" role="textbox" tabindex="0">PRIVATE-DRAFT typed words</div>',
          () => [editor(), 0] as [Node, number],
        ],
      ])('is accepted: %s', (_name, middle, end) => {
        setBody(
          `<p id="a">Public paragraph above.</p>${middle}<p id="b">Public text after the editor.</p>`,
        );
        const live = tripleClickAbove(end);
        const verdict = inspectSelection(document);
        expect(verdict.ok).toBe(true);
        if (!verdict.ok) return;
        expect(verdict.text).toBe('Public paragraph above.');
        // The boundary points are untouched: callers compare the clone with the live selection.
        expect(sameRange(verdict.range, live)).toBe(true);
      });

      it('is accepted for a CSS-only editor too', () => {
        const restore = emulateUserModify();
        try {
          setBody(
            '<p id="a">Public paragraph above.</p>' +
              '<div id="ed" data-user-modify="read-write">PRIVATE-DRAFT typed words</div>',
          );
          tripleClickAbove(() => [editor(), 0]);
          const verdict = inspectSelection(document);
          expect(verdict.ok).toBe(true);
          if (verdict.ok) expect(verdict.text).toBe('Public paragraph above.');
        } finally {
          restore();
        }
      });

      it('is accepted when the START is the very end of an editor and the range runs below it', () => {
        setBody(
          '<div id="ed" contenteditable="true">PRIVATE-DRAFT typed words</div><p id="b">Public text after the editor.</p>',
        );
        const range = document.createRange();
        range.setStart(editor().firstChild!, editor().firstChild!.textContent!.length);
        range.setEnd(document.getElementById('b')!.firstChild!, 11);
        document.getSelection()!.addRange(range);
        const verdict = inspectSelection(document);
        expect(verdict.ok).toBe(true);
        if (verdict.ok) expect(verdict.text).toBe('Public text');
      });

      it.each([
        [
          'one child of the editor in the range',
          '<div id="ed" contenteditable="true">PRIVATE-DRAFT typed words</div>',
          () => [editor(), 1] as [Node, number],
        ],
        [
          'one character of the editor text in the range',
          '<div id="ed" contenteditable="true">PRIVATE-DRAFT typed words</div>',
          () => [editor().firstChild!, 1] as [Node, number],
        ],
        [
          'a nested block with its text in the range',
          '<div id="ed" contenteditable="true"><p id="d">PRIVATE-DRAFT typed words</p></div>',
          () => [document.getElementById('d')!, 1] as [Node, number],
        ],
        [
          'the second block of an editor, ending at its start',
          '<div id="ed" contenteditable="true"><p>PRIVATE-DRAFT one</p><p id="d">two</p></div>',
          () => [document.getElementById('d')!, 0] as [Node, number],
        ],
      ])('is still refused with %s', (_name, middle, end) => {
        setBody(
          `<p id="a">Public paragraph above.</p>${middle}<p id="b">Public text after the editor.</p>`,
        );
        tripleClickAbove(end);
        expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
      });
    });

    it('is not tripped by a hidden input (a CSRF token) inside the selection', () => {
      setBody(PAGE('<form><input type="hidden" name="csrf" value="t0ken"></form>'));
      selectAcross();
      expect(inspectSelection(document).ok).toBe(true);
    });
  });

  describe('CSS-only editing surfaces (-webkit-user-modify, which jsdom cannot compute)', () => {
    let restore: () => void;
    beforeEach(() => {
      restore = emulateUserModify();
    });
    afterEach(() => restore());

    const PAGE = (middle: string): string =>
      `<p id="a">Public text before the editor.</p>${middle}<p id="b">Public text after the editor.</p>`;

    function selectAcross(): void {
      const range = document.createRange();
      range.setStart(document.getElementById('a')!.firstChild!, 0);
      range.setEnd(document.getElementById('b')!.firstChild!, 11);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    }

    it('isEditableElement answers from the computed value, inherited by descendants', () => {
      setBody(
        '<div id="rw" data-user-modify="read-write"><b id="deep"><i id="deeper">x</i></b>' +
          '<span id="island" data-user-modify="read-only">y</span></div>' +
          '<div id="po" data-user-modify="read-write-plaintext-only">z</div><p id="p">p</p>',
      );
      const by = (id: string): HTMLElement => document.getElementById(id)!;
      expect(isEditableElement(by('rw'))).toBe(true);
      expect(isEditableElement(by('deeper'))).toBe(true);
      expect(isEditableElement(by('po'))).toBe(true);
      expect(isEditableElement(by('island'))).toBe(false); // an explicit read-only island
      expect(isEditableElement(by('p'))).toBe(false);
    });

    it.each(['read-write', 'read-write-plaintext-only'])(
      'refuses a selection inside a %s element',
      (value) => {
        setBody(
          `<p>Plain words here</p><div data-user-modify="${value}"><span>PRIVATE-DRAFT typed words</span></div>`,
        );
        select('PRIVATE-DRAFT typed');
        expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
        select('Plain words');
        expect(inspectSelection(document).ok).toBe(true);
      },
    );

    it.each(['read-write', 'read-write-plaintext-only'])(
      'refuses a drag from plain text across a %s editor in the middle',
      (value) => {
        setBody(
          PAGE(`<div data-user-modify="${value}"><p>PRIVATE-DRAFT typed <b>words</b></p></div>`),
        );
        selectAcross();
        expect(document.getSelection()!.toString()).toContain('PRIVATE-DRAFT'); // it would reach the quote
        expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
      },
    );

    it('refuses Select All on a page with a CSS-only editor', () => {
      setBody(`<h1>Title</h1>${PAGE('<div data-user-modify="read-write">PRIVATE-DRAFT</div>')}`);
      document.getSelection()!.selectAllChildren(document.body);
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
    });

    it('accepts a range across a read-only block that sits OUTSIDE any editor', () => {
      setBody(PAGE('<div data-user-modify="read-only"><p>Island words</p></div>'));
      selectAcross();
      expect(inspectSelection(document).ok).toBe(true);
    });

    it('does not scan a selection that is too long to save (Ctrl+A on a long page)', () => {
      const spans = Array.from(
        { length: 150 },
        (_, i) => `<span>${'x'.repeat(99)}${i % 10} </span>`,
      );
      setBody(`<p>${spans.join('')}</p>`);
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('p')!);
      document.getSelection()!.addRange(range);
      const styles = vi.spyOn(window, 'getComputedStyle');
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'too-long' });
      expect(styles.mock.calls.length).toBeLessThan(10); // not one per element
      styles.mockRestore();
    });

    it('refuses while the focused element is a CSS-only editor', () => {
      setBody(
        '<p>Visible paragraph text</p><div id="f" tabindex="0" data-user-modify="read-write">x</div>',
      );
      document.getElementById('f')!.focus();
      select('Visible paragraph');
      expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
    });

    it('withoutEditableContext cuts the context at a CSS-only editor on both sides', () => {
      setBody(
        '<div data-user-modify="read-write">PRIVATE-BEFORE draft</div>' +
          '<p>Start here. Quoted words in the middle. Then more.</p>' +
          '<div data-user-modify="read-write-plaintext-only">PRIVATE-AFTER draft</div>',
      );
      const stream = buildTextStream();
      const range = rangeOver('Quoted words in the middle.');
      const captured = captureAnchor(range, range.toString(), stream);
      if ('error' in captured) throw new Error(captured.error);
      const clean = withoutEditableContext(captured.anchorSet, stream);
      expect(clean.textQuote.prefix).toBe('Start here. ');
      expect(clean.textQuote.suffix).toBe(' Then more.');
      expect(JSON.stringify(clean)).not.toMatch(/PRIVATE/);
    });
  });

  it('treats contenteditable="false" islands as ordinary content', () => {
    setBody('<div contenteditable="false"><p>Read only words here</p></div>');
    select('Read only words');
    expect(inspectSelection(document).ok).toBe(true);
  });

  it('ignores everything while designMode is on', () => {
    setBody('<p>Some words in a design mode page</p>');
    select('Some words');
    document.designMode = 'on';
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'editable' });
  });

  it('ignores selections inside the StudyVault host', () => {
    setBody('<p>Page text</p><div data-studyvault><p id="own">Overlay words here</p></div>');
    select('Overlay words');
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'own-ui' });
  });

  it('ignores a selection that reaches into the host from the page', () => {
    setBody('<p>Page text one</p><div data-studyvault><span>inside</span></div>');
    const range = document.createRange();
    range.setStart(document.querySelector('p')!.firstChild!, 2);
    range.setEnd(document.querySelector('span')!.firstChild!, 3);
    document.getSelection()!.addRange(range);
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'own-ui' });
  });

  it('reports text the stream cannot see (svg labels, shadow components) as unreadable', () => {
    setBody(
      '<p>Normal words here</p><svg><text id="t">chart label words here</text></svg>' +
        '<div id="comp"></div>',
    );
    select('chart label words');
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'unreadable' });

    const shadow = document.getElementById('comp')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>Inside the component</p>';
    const range = document.createRange();
    range.selectNode(document.getElementById('comp')!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    // Whatever the engine reports as selection text, no stream text lies in the range.
    expect(inspectSelection(document).ok).toBe(false);
  });

  it('enforces the quote length limit', () => {
    setBody(`<p>${'word '.repeat(MAX_QUOTE_CHARS / 4)}</p>`);
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    document.getSelection()!.addRange(range);
    expect(inspectSelection(document)).toEqual({ ok: false, reason: 'too-long' });
  });

  it('accepts a selection of exactly the maximum length', () => {
    setBody(`<p>${'a'.repeat(MAX_QUOTE_CHARS)}</p>`);
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    document.getSelection()!.addRange(range);
    expect(inspectSelection(document).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('isInsideHost / isEditableElement', () => {
    setBody('<div data-studyvault><b id="x">t</b></div><input id="i"><p id="p">p</p>');
    expect(isInsideHost(document.getElementById('x'))).toBe(true);
    expect(isInsideHost(document.getElementById('x')!.firstChild)).toBe(true);
    expect(isInsideHost(document.getElementById('p'))).toBe(false);
    expect(isInsideHost(null)).toBe(false);
    expect(isEditableElement(document.getElementById('i'))).toBe(true);
    expect(isEditableElement(document.getElementById('p'))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });

  it('sameRange compares boundary points', () => {
    setBody('<p>abcdef</p>');
    expect(sameRange(rangeOver('bcd'), rangeOver('bcd'))).toBe(true);
    expect(sameRange(rangeOver('bcd'), rangeOver('bcde'))).toBe(false);
  });
});

describe('isEditingContext', () => {
  it('is true for a focused field, a focused editor, designMode and an editable event target', () => {
    setBody(
      '<p id="p">Plain</p><input id="i"><div id="c" contenteditable="true" tabindex="0">x</div>',
    );
    expect(isEditingContext(document)).toBe(false);
    expect(isEditingContext(document, document.getElementById('p'))).toBe(false);
    expect(isEditingContext(document, document.getElementById('c'))).toBe(true);
    document.getElementById('i')!.focus();
    expect(isEditingContext(document)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    expect(isEditingContext(document)).toBe(false);
    document.designMode = 'on';
    expect(isEditingContext(document)).toBe(true);
  });

  it('follows focus into a contenteditable and a CSS-only editor, not a stale selection', () => {
    const restore = emulateUserModify();
    try {
      setBody(
        '<p>Plain words</p><div id="c" contenteditable="true" tabindex="0">x</div>' +
          '<div id="r" tabindex="0" data-user-modify="read-write">y</div><input id="i">',
      );
      select('Plain words');
      expect(isEditingContext(document)).toBe(false);
      document.getElementById('c')!.focus();
      expect(isEditingContext(document)).toBe(true);
      document.getElementById('r')!.focus();
      expect(isEditingContext(document)).toBe(true);
      // jsdom leaves the caret in the field after blur; that must not count as editing.
      document.getElementById('i')!.focus();
      (document.activeElement as HTMLElement).blur();
      expect(document.getSelection()!.anchorNode).not.toBeNull();
      expect(isEditingContext(document)).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('withoutEditableContext', () => {
  function anchorFor(needle: string) {
    const stream = buildTextStream();
    const range = rangeOver(needle);
    const captured = captureAnchor(range, range.toString(), stream);
    if ('error' in captured) throw new Error(captured.error);
    return { stream, anchor: captured.anchorSet };
  }

  it('drops the start of an editor draft from the suffix and keeps the rest', () => {
    setBody(
      '<p>Public text before the editor.</p><div contenteditable="true">PRIVATE-DRAFT: still typing</div>',
    );
    const { stream, anchor } = anchorFor('Public text before the editor.');
    expect(anchor.textQuote.suffix).toContain('PRIVATE'); // what capture alone would store
    const clean = withoutEditableContext(anchor, stream);
    expect(clean.textQuote.suffix).toBe('');
    expect(clean.textQuote.prefix).toBe(anchor.textQuote.prefix);
    expect(clean.textQuote.exact).toBe(anchor.textQuote.exact);
    expect(clean.textPosition).toEqual(anchor.textPosition);
  });

  it('keeps the plain text between the quote and the editor, and the prefix after one', () => {
    setBody(
      '<div contenteditable="true">PRIVATE-DRAFT: still typing</div><p>Start here. Quoted words in the middle. Then more.</p>' +
        '<div role="textbox">ANOTHER-DRAFT words</div>',
    );
    const { stream, anchor } = anchorFor('Quoted words in the middle.');
    const clean = withoutEditableContext(anchor, stream);
    expect(clean.textQuote.prefix).toBe('Start here. ');
    expect(clean.textQuote.suffix).toBe(' Then more.');
    expect(JSON.stringify(clean)).not.toMatch(/PRIVATE|ANOTHER/);
  });

  it('returns the anchor itself when no editor is near', () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi.</p>');
    const { stream, anchor } = anchorFor('epsilon zeta eta');
    expect(withoutEditableContext(anchor, stream)).toBe(anchor);
  });
});
