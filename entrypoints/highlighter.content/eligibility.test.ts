import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_QUOTE_CHARS } from '@shared';
import { inspectSelection, isEditableElement, isInsideHost, sameRange } from './eligibility';
import { clearSelection, rangeOver, select, setBody } from './testUtils';

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
