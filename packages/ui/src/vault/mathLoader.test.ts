import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MATH_MAX_FORMULAS } from './markdownBudget';

/**
 * The lazy seam (mathLoader.ts): the typesetter is fetched once, only when a rendered note holds a
 * formula, and a failed fetch leaves the source text. The module under test keeps state, so each test
 * gets a fresh copy (`vi.resetModules`) and a counting stand-in for `./mathTypeset`.
 */

type Typeset = (tex: string, display: boolean) => Element | null;

let loads = 0;

function standIn(typeset: Typeset) {
  vi.doMock('./mathTypeset', () => {
    loads++;
    return { typeset };
  });
}

/** A fragment shaped like the renderer's output for `$a$` and `$$b$$`. */
function fragment(): DocumentFragment {
  const holder = document.createElement('div');
  holder.innerHTML =
    '<p>one <code class="math">$a$</code> two</p><p><code class="math math-display">$$b$$</code></p>';
  const fragment = document.createDocumentFragment();
  fragment.append(...holder.childNodes);
  return fragment;
}

const mathElement = (tex: string, display: boolean) => {
  const el = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
  el.textContent = `${display ? 'D' : 'I'}:${tex}`;
  return el;
};

beforeEach(() => {
  loads = 0;
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock('./mathTypeset');
});

describe('loadMath and typesetMath', () => {
  it('does not fetch the typesetter until a formula is rendered', async () => {
    standIn(mathElement);
    const { typesetMath, mathReady } = await import('./mathLoader');
    expect(loads).toBe(0);
    typesetMath(document.createRange().createContextualFragment('<p>no math <code>x</code></p>'));
    expect(loads).toBe(0);
    expect(mathReady()).toBe(false);
  });

  it('starts one load for many calls, and calls back once each when it is there', async () => {
    standIn(mathElement);
    const { typesetMath, mathReady, loadMath } = await import('./mathLoader');
    const first = fragment();
    const second = fragment();
    const ready = [vi.fn(), vi.fn()];
    typesetMath(first, ready[0]);
    typesetMath(second, ready[1]);
    // the source text is untouched until the load has finished
    expect(first.querySelectorAll('code.math')).toHaveLength(2);
    expect(mathReady()).toBe(false);
    await loadMath();
    expect(loads).toBe(1);
    expect(mathReady()).toBe(true);
    expect(ready[0]).toHaveBeenCalledTimes(1);
    expect(ready[1]).toHaveBeenCalledTimes(1);
  });

  it('typesets synchronously once loaded, display and inline told apart, delimiters removed', async () => {
    standIn(mathElement);
    const { typesetMath, loadMath } = await import('./mathLoader');
    await loadMath();
    const root = fragment();
    const onReady = vi.fn();
    typesetMath(root, onReady);
    expect(root.querySelector('code')).toBeNull();
    expect([...root.querySelectorAll('math')].map((m) => m.textContent)).toEqual(['I:a', 'D:b']);
    // already loaded: nothing to wait for
    expect(onReady).not.toHaveBeenCalled();
  });

  it('keeps the source text of a formula the typesetter refuses', async () => {
    standIn((tex, display) => (tex === 'a' ? null : mathElement(tex, display)));
    const { typesetMath, loadMath } = await import('./mathLoader');
    await loadMath();
    const root = fragment();
    typesetMath(root);
    expect([...root.querySelectorAll('code.math')].map((c) => c.textContent)).toEqual(['$a$']);
    expect(root.querySelectorAll('math')).toHaveLength(1);
  });

  it('does not call the typesetter for formulas over the budget', async () => {
    const calls: string[] = [];
    standIn((tex, display) => {
      calls.push(tex);
      return mathElement(tex, display);
    });
    const { typesetMath, loadMath } = await import('./mathLoader');
    await loadMath();
    const holder = document.createElement('div');
    holder.innerHTML = `<p>${'<code class="math">$x$</code> '.repeat(MATH_MAX_FORMULAS + 30)}</p>`;
    typesetMath(holder);
    expect(calls).toHaveLength(MATH_MAX_FORMULAS);
    expect(holder.querySelectorAll('code.math')).toHaveLength(30);
  });

  it('leaves the source text, and never calls back, when the load fails; it is not retried', async () => {
    vi.doMock('./mathTypeset', () => {
      loads++;
      throw new Error('chunk failed to load');
    });
    const { typesetMath, mathReady, loadMath } = await import('./mathLoader');
    const root = fragment();
    const onReady = vi.fn();
    typesetMath(root, onReady);
    await loadMath();
    expect(mathReady()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(root.querySelectorAll('code.math')).toHaveLength(2);
    typesetMath(root, onReady);
    await loadMath();
    expect(loads).toBe(1);
    expect(onReady).not.toHaveBeenCalled();
  });
});
