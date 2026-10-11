import { mathBudget } from './markdownBudget';
import type { typeset } from './mathTypeset';

/**
 * The seam between the Markdown renderer and the typesetter (ADR-015). The renderer is synchronous and
 * always produces the source-text rendering first; this file loads `mathTypeset` (temml, DOMPurify's
 * MathML pass, about 170 KB) with `import()` the first time a rendered note holds a formula, and swaps
 * the formulas it accepts for `<math>` once it is there. A page without math never fetches it, and a
 * load or typeset failure leaves the source text, which is a complete rendering on its own.
 */

let loaded: typeof typeset | null = null;
let loading: Promise<void> | null = null;

/** Starts loading the typesetter (once per page) and settles when it is ready or has failed. */
export function loadMath(): Promise<void> {
  loading ??= import('./mathTypeset').then(
    (module) => {
      loaded = module.typeset;
    },
    // Not retried: the same files would fail again, and the source text is already on screen.
    () => undefined,
  );
  return loading;
}

/** True once formulas are typeset synchronously by `typesetMath`. */
export const mathReady = (): boolean => loaded !== null;

/**
 * Replace the `<code class="math">` spans under `root` (the renderer's source-text rendering of
 * `$...$` and `$$...$$`) by typeset MathML where the cap allows (markdownBudget.ts `mathBudget`) and
 * the typesetter accepts the formula. Each span that is not replaced stays as it is.
 *
 * Before the typesetter has loaded this only starts the load, and calls `onReady` once it is there so
 * the caller can render again; it is never called when loading failed.
 */
export function typesetMath(root: ParentNode, onReady?: () => void): void {
  const spans = Array.from(root.querySelectorAll('code.math'));
  if (spans.length === 0) return;
  const run = loaded;
  if (!run) {
    void loadMath().then(() => {
      if (loaded) onReady?.();
    });
    return;
  }
  const displayed = spans.map((span) => span.classList.contains('math-display'));
  const texts = spans.map((span, i) => {
    const text = span.textContent ?? '';
    // the span is exactly what was typed, delimiters included (markdownMath.ts)
    return displayed[i] ? text.slice(2, -2) : text.slice(1, -1);
  });
  const take = mathBudget(texts.map((tex) => tex.length));
  spans.forEach((span, i) => {
    if (!take[i]) return;
    const math = run(texts[i]!, displayed[i]!);
    if (math) span.replaceWith(math);
  });
}
