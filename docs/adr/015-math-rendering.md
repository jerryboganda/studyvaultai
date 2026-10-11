# ADR-015: TeX in notes is shown as source text, not typeset

**Status:** accepted · **Date:** 2026-10-11 · Extends the sanitised Markdown pipeline (THREAT_MODEL
C3.3) under the CSP of ADR-009.

## Context
Notes are user-typed Markdown. Study material needs formulas (`$E = mc^2$`, `$$ \int_0^1 x\,dx $$`).
The brief preferred `temml` (TeX to MathML, MIT) loaded lazily on the first math span, with a hard stop:
if it is over **120 KB minified**, or MathML cannot be allow-listed safely, ship nothing partial and
implement only the fallback of showing math as styled source text.

The constraints that apply to any choice: the extension-pages CSP has no `unsafe-eval` and no inline
script (ADR-009), everything rendered goes through the DOMPurify allow-list in
`packages/ui/src/vault/markdownRender.ts`, nothing may touch the network, and pages without math must
pay nothing.

## Measurement (the stop condition)
Registry: `temml` 0.14.0 (published 2026-10-08) and 0.13.5 (2026-08-28), MIT, no dependencies, no use of
`eval` or `new Function` (grep: 0 matches), so the CSP was not the problem. Sizes of the code that
would ship, measured on this machine with Node 24:

| What | Minified | gzip |
| --- | ---: | ---: |
| `dist/temml.min.js` 0.13.5 (the authors' terser build) | 168,222 B (164.3 KB) | 49,811 B |
| `dist/temml.min.js` 0.14.0 | 167,881 B (164.0 KB) | 49,690 B |
| `temml.js` source entry through the project's bundler (rolldown 1.2.13, as used by Vite 8.3.4), tree-shaken | 167,250 B (163.3 KB) | 50,297 B |
| `dist/temml.mjs` through the same bundler | 205,852 B (201.0 KB) | 59,968 B |

Every figure is above the 120 KB ceiling (by 43 to 81 KB); tree-shaking does not help because the
symbol, macro and function tables register at import time. The stylesheet and font are separate (about
9 KB each) and were not counted. For scale: the non-OCR extension total is 6,486 of 6,500 KB
(`docs/PERF_REVIEW.md`, `scripts/check-build.mjs`), so even as a lazy chunk the library would need the
budget raised by roughly 150 to 190 KB.

The second condition (a safe MathML allow-list) was therefore not evaluated, and nothing of temml was
added: no dependency, no lockfile change, no allow-listed MathML.

## Decision
TeX is **kept as its source text**, recognised and styled, never evaluated.

- `$...$` is inline math and `$$...$$` is display math. Both become `<code class="math">` (display:
  `class="math math-display"`), and the text content is the span exactly as typed, delimiters included.
- The span is lifted out before Markdown sees it (a marked extension, `markdownMath.ts`), so `_`, `*`,
  `\`, `<`, `&` and `&amp;` inside a formula are not read as emphasis, escapes, HTML or entities, and a
  stray `+ c` or `- c` line inside a `$$` block does not become a list. Emphasis can still wrap a
  formula (`*see $a*b$ here*`): the formula's own stars are masked from the emphasis scanner.
- Delimiter rules are pandoc's, so prices are not math: `$` opens only before a non-space and closes
  only after a non-space that is not followed by a digit; `\$` is a literal dollar sign and an escaped
  dollar is honoured inside a span. Inline math stays on one line and is at most 500 characters;
  `$$` may span lines and blank lines, must start a line (and end its closing line) to be a block, and
  is at most 10,000 characters. Anything unmatched or longer is ordinary text. Each attempt is bounded
  by those caps and the paragraph look-ahead is windowed (2,000 characters), so work stays linear:
  measured parse of 90,000 characters of `$a$` spans, 88,000 characters of `para`/`$$ x` pairs and
  100,000 characters of `- i` lines is 78, 160 and 324 ms (plain marked: 29, 69 and 416 ms).
- One attribute is added to the sanitiser's allow-list: `class`. A hook keeps it only on `<code>` and
  only when the value is exactly `math` or `math math-display`; it is removed everywhere else, which also
  strips the `language-*` classes marked puts on fenced code. Raw HTML typed by the user is still shown
  as text, so a user cannot write the class themselves.
- Nothing about TeX is executed or fetched: `\href`, `\url`, `\includegraphics`, `\style`, `\class`,
  `\htmlId` are characters. The hostile battery in `markdownRender.test.ts` carries 16 new vectors
  (those commands, `<math>`/`<svg>`/`<script>`/`<img>` inside and around spans, attribute and element
  breakouts, entities, raw `<code class="math">`, `<p class="math">`, fence languages), and the audit
  asserts the class rule on every element of every output.
- Copy, search, export and backup see the source, because they never see the rendering: the stored
  `Note.body` is untouched; the search index holds the body, so `frac`, `alpha` or `varepsilon` find the
  note (`searchIndex.test.ts`); Markdown export writes note bodies as written while still escaping `$`
  in text captured from pages (`exports.test.ts`); selecting the rendered text copies the same
  characters including the delimiters.
- **AI-drafted notes**: `esc()` in `packages/ui/src/ai/accept.ts` now also escapes `$`. Model text and
  quoted page text must not become a math span, and inside a span its other escapes (`\_`, `\*`) would
  be shown as typed. A note the user writes or edits by hand can use `$...$`.
- Flashcard faces, AI result cards and every other surface that renders text as React text nodes are
  not Markdown surfaces and are unchanged: TeX there is shown as typed. Math-aware rendering applies
  wherever `Markdown` is used: the dashboard note list and editor preview and the side panel's notes.

## Cost
`markdownMath.ts` minified is 1,235 B (696 B gzip). Bundling the renderer module with and without it
(same bundler, marked and DOMPurify included): 74,447 B to 75,805 B, +1,358 B (+554 B gzip). The
stylesheet adds about 170 B. It lands in the `vault` chunk that notes already load, so no chunk is
added, nothing is lazy, and the content script and service worker are untouched (verified: the new
strings occur only in `chunks/vault-*.js` and `assets/vault-*.css` of the e2e build).

## Consequences
- Formulas are readable TeX, not typeset. This is honest and local-first, and it costs no bytes worth
  budgeting, but it is not "math rendering" in the sense of fractions and radicals. The listing and docs
  must not claim typesetting.
- Assistive technology reads the TeX source (a `code` element), which is what a screen-reader user of
  a LaTeX-aware tool would also get. No `role="math"` is added because the element is not math markup.
- GFM table cells split on `|` before the inline pass, so a formula containing `|` in a table cell
  needs `\|` (marked's own rule).
- Review and AI cards do not get styled math; a future change that renders them as Markdown must go
  through the same renderer (and keep the escaping contract of `esc()`).

## If this is revisited
A typeset renderer fits only if one is under the ceiling or the ceiling and total budget are raised
deliberately. The shape that was designed and not built: `import()` on the first span (a page without
math pays nothing), `trust: false`, `maxSize`, `maxExpand` and `throwOnError: false` with a `try/catch`
that falls back to this source rendering; MathML output through DOMPurify with an explicit element list
(`math`, `mrow`, `mi`, `mn`, `mo`, `mtext`, `mspace`, `msup`, `msub`, `msubsup`, `mfrac`, `msqrt`,
`mroot`, `munder`, `mover`, `munderover`, `mtable`, `mtr`, `mtd`, `mpadded`, `mphantom`), attributes
limited to `display`, `mathvariant`, `displaystyle`, `scriptlevel` and the numeric sizing ones, and no
`href`, `xlink:*`, `style`, `class`, `id`, `annotation` or `semantics`. The hostile battery above is the
acceptance test for it. The `math` / `math-display` class contract here would stay as the fallback.
