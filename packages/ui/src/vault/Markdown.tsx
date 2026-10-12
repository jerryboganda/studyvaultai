import { useLayoutEffect, useRef } from 'react';
import { renderMarkdown } from './markdownRender';

/**
 * Rendered, sanitised Markdown (see markdownRender.ts). Never receives or emits an HTML string.
 *
 * TeX is on screen as its source text first; when the note holds a formula and the typesetter has not
 * loaded yet, `renderMarkdown` starts the load and calls `paint` again once it is there, so the same
 * text is rendered a second time with the formulas typeset (ADR-015). The DOM is replaced in place and
 * React state is not involved.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    const paint = () => {
      if (live) el.replaceChildren(renderMarkdown(source, paint));
    };
    paint();
    return () => {
      live = false;
    };
  }, [source]);
  return <div ref={host} className={`sv-md${className ? ` ${className}` : ''}`} dir="auto" />;
}
