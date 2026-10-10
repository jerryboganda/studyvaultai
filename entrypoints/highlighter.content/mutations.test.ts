import { afterEach, describe, expect, it } from 'vitest';
import { affectsPageText } from './mutations';
import { setBody } from './testUtils';

/** Runs `mutate` and returns whether any resulting record can change the page text stream. */
function relevant(mutate: () => void): boolean {
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  mutate();
  const records = observer.takeRecords();
  observer.disconnect();
  expect(records.length).toBeGreaterThan(0);
  return records.some(affectsPageText);
}

afterEach(() => {
  setBody('');
  document.head.innerHTML = '';
});

describe('affectsPageText', () => {
  it('counts added and removed text-bearing elements', () => {
    setBody('<div id="root"><p id="p">old</p></div>');
    const root = document.getElementById('root')!;
    expect(relevant(() => root.insertAdjacentHTML('beforeend', '<p>new paragraph</p>'))).toBe(true);
    expect(relevant(() => document.getElementById('p')!.remove())).toBe(true);
  });

  it('counts text edits', () => {
    setBody('<p id="p">counter 1</p>');
    const text = document.getElementById('p')!.firstChild as Text;
    expect(relevant(() => (text.data = 'counter 2'))).toBe(true);
  });

  it('counts a text node appended directly', () => {
    setBody('<p id="p"></p>');
    expect(relevant(() => document.getElementById('p')!.append('hello'))).toBe(true);
  });

  it('ignores the StudyVault overlay, being added or changing', () => {
    setBody('<p>page</p>');
    const host = document.createElement('div');
    host.setAttribute('data-studyvault', '');
    expect(relevant(() => document.body.appendChild(host))).toBe(false);
    expect(relevant(() => host.appendChild(document.createElement('span')))).toBe(false);
    expect(relevant(() => host.remove())).toBe(false);
  });

  it('ignores <head>, scripts, styles and svg (not part of the text stream)', () => {
    setBody('<div id="root"><svg id="chart"><text>1</text></svg></div>');
    const root = document.getElementById('root')!;
    expect(relevant(() => document.head.appendChild(document.createElement('style')))).toBe(false);
    expect(relevant(() => root.appendChild(document.createElement('script')))).toBe(false);
    expect(relevant(() => root.appendChild(document.createElement('style')))).toBe(false);
    expect(
      relevant(() => document.getElementById('chart')!.appendChild(document.createElement('g'))),
    ).toBe(false);
    const style = document.head.appendChild(document.createElement('style'));
    expect(relevant(() => (style.textContent = 'p{color:red}'))).toBe(false);
  });

  it('ignores comments and attribute-free no-ops', () => {
    setBody('<p id="p">x</p>');
    expect(relevant(() => document.body.appendChild(document.createComment('analytics')))).toBe(
      false,
    );
  });
});
