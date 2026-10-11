import { useLayoutEffect, useRef } from 'react';
import { renderMarkdown } from './markdownRender';

/** Rendered, sanitised Markdown (see markdownRender.ts). Never receives or emits an HTML string. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    host.current?.replaceChildren(renderMarkdown(source));
  }, [source]);
  return <div ref={host} className={`sv-md${className ? ` ${className}` : ''}`} dir="auto" />;
}
