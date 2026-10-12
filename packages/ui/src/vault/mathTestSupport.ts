/**
 * Test support for the typeset-math tests (mathTypeset.test.ts, markdownRender.math.test.ts,
 * Markdown.test.tsx). Not imported by any shipped module.
 *
 * jsdom has no MathMLElement: `<math>` and its children are plain Elements, which have no `style`.
 * temml sets cell padding, rules and `math-depth` through `el.style[...] = ...` (the CSSOM, which every
 * browser's MathMLElement has and which the extension's `style-src 'self'` allows where a `style=""`
 * attribute is refused). This gives plain elements a minimal `style` that writes the attribute the way
 * the CSSOM would, so the unit tests run the same code path as Chromium. Assignment is all temml does.
 */
export function installMathmlStyle(): void {
  if ('style' in Element.prototype) return;
  const declarations = new WeakMap<Element, Map<string, string>>();
  const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  Object.defineProperty(Element.prototype, 'style', {
    configurable: true,
    get(this: Element) {
      let map = declarations.get(this);
      if (!map) declarations.set(this, (map = new Map()));
      const own = map;
      return new Proxy(
        {},
        {
          get: (_target, prop) => own.get(kebab(String(prop))) ?? '',
          set: (_target, prop, value) => {
            own.set(kebab(String(prop)), String(value));
            this.setAttribute(
              'style',
              [...own].map(([name, text]) => `${name}: ${text};`).join(' '),
            );
            return true;
          },
        },
      );
    },
  });
}
