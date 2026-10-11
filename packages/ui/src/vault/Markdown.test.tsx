import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * <Markdown> with formulas (ADR-015): the source text is painted first, then the same text is painted
 * again with the formulas typeset once the lazy typesetter has loaded. The module keeps state (the
 * loader), so every test gets fresh modules; `mathTypeset` is the real one unless a test stands in
 * for it to control when it arrives.
 */

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const stand = (tex: string, display: boolean) => {
  const el = document.createElementNS(MATHML_NS, 'math');
  el.textContent = `${display ? 'D' : 'I'}:${tex}`;
  return el;
};

let loads = 0;
/** Replace `./mathTypeset` by a stand-in that arrives when `gate()` is called (or fails). */
function gated(fail = false) {
  let open!: () => void;
  const arrived = new Promise<void>((resolve) => {
    open = resolve;
  });
  vi.doMock('./mathTypeset', async () => {
    loads++;
    await arrived;
    if (fail) throw new Error('chunk failed to load');
    return { typeset: stand };
  });
  return open;
}

async function fresh() {
  vi.resetModules();
  const { Markdown } = await import('./Markdown');
  return Markdown;
}

beforeEach(() => {
  loads = 0;
});
afterEach(() => {
  cleanup();
  vi.doUnmock('./mathTypeset');
});

describe('Markdown with TeX', () => {
  it('shows the source text first and the typeset formula once the typesetter has loaded', async () => {
    const Markdown = await fresh();
    const { container } = render(<Markdown source={String.raw`Rate $v_1$ and $$x^2$$.`} />);
    // painted synchronously, before anything has loaded
    expect([...container.querySelectorAll('code.math')].map((c) => c.textContent)).toEqual([
      '$v_1$',
      '$$x^2$$',
    ]);
    expect(container.querySelector('math')).toBeNull();
    await waitFor(() => expect(container.querySelectorAll('math')).toHaveLength(2));
    expect(container.querySelector('code.math')).toBeNull();
    expect(container.querySelector('math[display="block"]')).not.toBeNull();
    expect(container.querySelector('.sv-md')!.textContent?.trim()).toBe('Rate v1 and x2.');
  });

  it('typesets at once when the typesetter is already there', async () => {
    const Markdown = await fresh();
    const first = render(<Markdown source="$a$" />);
    await waitFor(() => expect(first.container.querySelector('math')).not.toBeNull());
    const second = render(<Markdown source="and $b$" />);
    expect(second.container.querySelector('code.math')).toBeNull();
    expect(second.container.querySelector('math')).not.toBeNull();
  });

  it('paints the new text when the source changes, before and after the load', async () => {
    const open = gated();
    const Markdown = await fresh();
    const { container, rerender } = render(<Markdown source="one $a$" />);
    rerender(<Markdown source="two $b$" />);
    expect(container.textContent?.trim()).toBe('two $b$');
    open();
    await waitFor(() => expect(container.querySelector('math')).not.toBeNull());
    // only the latest source is painted, once
    expect(container.querySelectorAll('math')).toHaveLength(1);
    expect(container.textContent?.trim()).toBe('two I:b');
    rerender(<Markdown source="three, no formula" />);
    expect(container.textContent?.trim()).toBe('three, no formula');
    expect(container.querySelector('math')).toBeNull();
  });

  it('does not touch the page after it has been unmounted', async () => {
    const open = gated();
    const Markdown = await fresh();
    const { container, unmount } = render(<Markdown source="$a$" />);
    const host = container.querySelector('.sv-md')!;
    unmount();
    open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loads).toBe(1);
    expect(host.querySelector('math')).toBeNull();
  });

  it('keeps the source text when the typesetter fails to load', async () => {
    const open = gated(true);
    const Markdown = await fresh();
    const { container } = render(<Markdown source={String.raw`$\frac{a}{b}$`} />);
    open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loads).toBe(1);
    expect(container.querySelector('code.math')?.textContent).toBe(String.raw`$\frac{a}{b}$`);
    expect(container.querySelector('math')).toBeNull();
  });

  it('loads the typesetter once for many notes, and not at all for notes without a formula', async () => {
    const open = gated();
    const Markdown = await fresh();
    render(<Markdown source="# Plain **note**, it costs $5 and $10" />);
    render(<Markdown source="no math here" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loads).toBe(0);
    const a = render(<Markdown source="$a$" />);
    const b = render(<Markdown source="$b$" />);
    open();
    await waitFor(() => {
      expect(a.container.querySelector('math')).not.toBeNull();
      expect(b.container.querySelector('math')).not.toBeNull();
    });
    expect(loads).toBe(1);
  });
});
