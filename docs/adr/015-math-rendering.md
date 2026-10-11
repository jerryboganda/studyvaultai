# ADR-015: Math in notes: typeset MathML, loaded on first use, with the source text as the fallback

**Status:** accepted; amended 2026-10-12 (Amendment 1: typeset) · **Date:** 2026-10-11 · Extends the
sanitised Markdown pipeline (THREAT_MODEL C3.3) under the CSP of ADR-009.

## Amendment 1 (2026-10-12): formulas are typeset

### Why this changed
The 2026-10-11 decision below stopped at a 120 KB ceiling that the brief had set as a working limit, not
as a product requirement, and shipped TeX as styled source text. Typeset math is a PRD P1 item, and the
cost is paid only by a page that actually shows a formula (the library is a lazily loaded chunk), so the
ceiling was lifted and the total non-OCR budget in `scripts/check-build.mjs` raised from 6,800 to
7,000 KB. The decision below about the source-text rendering is **not** reversed: that rendering is
still what is painted first, what stays while the typesetter loads, and what stays for any formula the
typesetter refuses or cannot build. A formula is therefore never lost and never half-typeset.

### Decision
- **temml 0.14.0** (MIT, no dependencies, no `eval`/`new Function`, no network or storage use: grep of
  `dist/temml.mjs`), pinned exactly in `package.json` and `pnpm-lock.yaml`. It was published 2026-10-08;
  the lockfile passes pnpm's supply-chain policy (minimum release age) as installed.
- The package's own ESM entry, `dist/temml.mjs`, is used (it carries the `\ce{...}` chemistry
  extension, which study notes use); the source entry `temml.js` is about 38 KB smaller and has no
  `\ce`. Chemistry notes were judged worth the bytes.
- **Loading.** `packages/ui/src/vault/mathLoader.ts` calls `import('./mathTypeset')` the first time a
  rendered note holds a `<code class="math">` span. A page without math never fetches the chunk or its
  stylesheet (asserted: `mathLoader.test.ts`, `Markdown.test.tsx`, `math.spec.ts`). The chunk is fetched
  once per page; a failed fetch is not retried and leaves the source text. `renderMarkdown` stays
  synchronous: it returns the source-text rendering and, when the typesetter is not there yet, starts
  the load and calls an optional `onMathReady`; `Markdown.tsx` paints again from it. Surfaces: every
  place that renders notes goes through `<Markdown>` (dashboard note list and preview, the editor's
  preview, the side panel's notes), so all of them are covered; flashcard faces and AI result cards
  render text as React text nodes and are unchanged.
- **Order of guards.** `renderBudget` (length, nesting, `$` count) then `inlineBudget` (marked's inline
  cost) run first, exactly as before, and a refused note never reaches the typesetter (asserted with a
  spy on temml). Then `mathBudget` (markdownBudget.ts) decides which of the formulas that survived are
  typeset: at most 60 formulas, at most 1,000 characters of TeX each and 3,000 in all, first fit in
  document order; what does not fit stays source text. Only then temml runs. The numbers come from
  the measurement under "Measured cost" (about a quarter second for the worst note the caps admit).
- **temml options.** `trust: false`, `strict: true`, `throwOnError: true`, `maxExpand: 1000`,
  `maxSize: [10, 100]` (em, pt), `displayMode` from the delimiters, no `macros`, no `annotate`. Not
  `renderToString`: `render` builds the nodes with `createElementNS` and the CSSOM, so no HTML parser
  sees the output (no mutation-XSS class of bug, no parser depth limit that would silently reshape a
  deep formula) and no `style=""` markup is parsed under `style-src 'self'` (a parsed `style` attribute
  is refused under that policy, as ADR-009 notes; a CSSOM assignment is not, and no CSP violation was
  logged in the e2e runs). Macro definition and expansion-control primitives
  (`\def \gdef \edef \xdef \let \futurelet \global \long \outer \newcommand \renewcommand
  \providecommand \expandafter \noexpand \csname \endcsname`) are refused before temml runs: they are
  the only way a formula can make temml build more than its source is long (macros do not outlive one
  `$...$`, so nothing is lost). mhchem, the largest parser in the package, was run in Node on
  2,000-character inputs of 18 shapes (carets, braces, arrows, charges, nested `\ce`, and so on)
  without finding anything over 40 ms or any exception that is not a TeX error; in Chromium its
  output is the largest per character (about 2 elements per character), which is what the element
  limit below is for.
- **Sanitising.** The element is sanitised in place by a second DOMPurify instance (the Markdown one
  has hooks that must not see MathML) with an explicit allow-list, and any removal (`DOMPurify.removed`)
  rejects the formula. Then `admit` walks the result independently: MathML namespace on every element,
  closed value patterns on every attribute, a closed list of `style` declarations, classes only from
  the set `math.css` defines (others with no meaning in Chromium are dropped, the rest refuse the
  formula), text only in `mi mn mo mtext`, fewer than 2,000 elements (checked first, with one native
  call, before the sanitiser walks anything) and at most 40 levels, and exactly one non-empty
  `<math>` root. A formula that fails either stage is shown as source text.

### What temml needs (measured, not assumed)
Method: 101 TeX strings (fractions, sums, integrals, matrices of every kind, cases, aligned and numbered
environments, chemistry, accents, over/under constructs, delimiters, fonts, spacing, boxes and strikes,
and the commands this ADR refuses), rendered inline and displayed with the options above; plus the
`setAttribute` and `style` sites of temml's source. 154 of the 200 renderings are typeset; the 46
refused are the commands below and display-only environments used inline.

| Allow-list | Contents | Where it came from |
| --- | --- | --- |
| Elements | `math mrow mi mn mo mtext mspace msup msub msubsup mfrac msqrt mroot mtable mtr mtd mover munder munderover mstyle mpadded mphantom menclose mmultiscripts mprescripts none` | all that temml emits for the corpus except the HTML ones below |
| Attributes | `display mathvariant displaystyle scriptlevel fence stretchy separator symmetric movablelimits largeop accent form linebreak lspace rspace width height depth voffset minsize maxsize linethickness mathsize notation`, each with a closed value pattern, plus `class` and `style` | observed attribute names; `mathcolor`, `mathbackground`, `href`, `id`, `title`, `actiontype`, `encoding`, `xmlns` are not allowed |
| `style` | `padding` and its four sides, `margin-left/right`, `width`, `height`, `border` and its four sides (`<length> solid\|double\|dashed`), `math-depth`, `font-weight: bold`, `text-align` | cell padding of arrays, rules of `\hline` and `\boxed`, `\pmb`, fraction and accent depth. No colour, position, display, transform or `url()`; values have no parenthesis, quote, backslash or colon |
| Classes kept (CSS in `math.css`) | `tml-left tml-right tml-jot tml-small tml-sml-pad tml-med-pad tml-lrg-pad chr-sml chr-med chr-lrg chr-sml-vec chr-med-vec chr-lrg-vec tml-overline tml-underline tml-fbox tml-cancel upstrike downstrike sout tml-xcancel tml-hat-1..4 tml-tilde-2..4` | Chromium rules of temml's own stylesheet |
| Classes dropped | `wbk-*`, `tml-display`, `tml-prime`, `tml-vec`, `tml-tag`, `tml-tageqn`, `tml-eqn`, `tml-label`, `mathcal`, `mathscr` | WebKit and Firefox corrections, equation numbering, the Temml font |

Not allowed, so the formula falls back to source: `semantics`, `annotation`, `annotation-xml`, `maction`,
`mglyph`, `malignmark`, `ms`, `mfenced`, every HTML or SVG element, `href`/`xlink:*`/`id`/`title`/
`data-*`/`aria-*`/`role`/`tabindex`, `on*`, colour, and any class or `style` property above.

Refused TeX (each is an asserted case in `mathTypeset.test.ts`): `\includegraphics` (temml: not
trusted), `\class \id \style \data` (strict mode), `\href \url \htmlClass \htmlStyle \htmlId \htmlData`
(not temml commands: unsupported), `\color \textcolor \colorbox \fcolorbox` and `\rule` (colour is
not carried: it would ignore the theme, and a black box vanishes in dark mode), `\ref \eqref` (an HTML
`<a>`), `\mathllap \mathrlap \mathclap` (absolute positioning), `\phase \textcircled \angl` and other
enclosures without styles here, macro definitions (above), any TeX error, `{align}`/`{equation}`/`{CD}`
and `\tag` outside display math (temml's own rule). `\label` is accepted and inert; numbered
environments are typeset without their numbers (temml draws them with a CSS counter on an empty
`<span>`, which is dropped).

### Accessibility
- No `annotation`/`semantics`. MathML Core renders only the first child of `<semantics>`, so a TeX
  annotation is `display: none`: it never reaches assistive technology, and it is the classic vehicle
  for namespace-confusion attacks. It is not kept.
- No `aria-label` and no `role` on `<math>`. An accessible name from the TeX source would replace the
  element's own structure (`role="math"` has presentational children), so a screen reader would read
  `e caret open brace i backslash pi` instead of the fraction, superscript and root that Chromium
  exposes. Checked in a loaded Chromium through the DevTools accessibility tree
  (`Accessibility.getFullAXTree`): `MathMLMath`, `MathMLFraction`, `MathMLRoot`, `MathMLSubSup`,
  `MathMLTable`, `MathMLTableRow`, `MathMLTableCell`, `MathMLIdentifier`, `MathMLOperator` and the rest
  are present with their text. **Not tested with a screen reader** (no NVDA, JAWS or VoiceOver run);
  that is a manual item (`docs/MANUAL_TEST_CHECKLIST.md` MT-44).
- While the typesetter loads, and for any refused formula, assistive technology reads the TeX source
  in a `<code>` element, as before; nothing is announced when the swap happens.
- Display math that is wider than the column scrolls inside its own box (`overflow-x: auto`). Not
  verified: that the scroller is keyboard-reachable (no test formula overflows, so axe's scrollable
  region rule was never exercised). Inline formulas do not wrap.
- Formulas are `direction: ltr` and `unicode-bidi: isolate` inside a right-to-left note. The stylesheet
  has no colour of its own (everything is `currentColor`); the strike of `\cancel` is a filled shape and
  is kept visible under forced colours with `forced-color-adjust: none` and `CanvasText`. Asserted in
  `math.spec.ts` with axe in light, dark and forced colours.

### Measured cost
Real production-variant build (`scripts/build-e2e.mjs`, same minifier as production):

| What | Minified | gzip |
| --- | ---: | ---: |
| `chunks/mathTypeset-*.js` (temml with mhchem, the DOMPurify MathML pass, limits), lazy | 207,531 B | 60,880 B |
| `assets/mathTypeset-*.css`, lazy | 2,290 B | 743 B |
| Eager: `mathLoader` and `mathBudget` in the `vault` chunk (same bundler, before and after) | +573 B | +516 B |

The non-OCR total of that build was 6,903 KB with the whole tree of the finish wave in it, of which the
two lazy files are 205 KB; the budget is 7,000 KB. The content script and the service worker do not
include any of it (the loader is reachable only from the pages that render notes).

Time, in Chromium (Playwright's bundled Chromium 1248, new headless, Windows 11, 4 CPUs shared with
other agents' work, so each figure is a range over runs). 50 formulas of the shape
`\frac{x_{i}+1}{\sqrt{y^{2}+i}} = \sum_{k=0}^{i} k` in one note, `math.spec.ts` "fifty formulas":

| What | ms |
| --- | ---: |
| Click on Preview to 50 `<math>` on screen, first use (fetch of the chunk and its stylesheet, then typesetting) | 286 to 289 |
| The same click with the typesetter already loaded | 162 to 235 |
| The same 50 lines as plain text (marked, DOMPurify, React, no typesetting) | 20 to 22 |
| So typesetting 50 formulas, in the page, layout included | 141 to 213 |
| `typeset` called directly, 50 formulas (no marked, no React), median of 5 | 103 to 147 |
| `typeset` called directly, 100 formulas | 170 to 275 |
| First call after the chunk has loaded | 11 to 14 |
| One dense formula of 997 characters (a matrix, `x^2+x^2+...`: 975 to 999 elements) | 39 to 43 |
| One mhchem formula of 999 characters (1,990 elements) | 105 |

That is about 0.3 ms per formula plus 40 to 85 us per output element, which is what the caps in
`markdownBudget.ts` are derived from: 60 ordinary formulas are 100 to 170 ms and the dense worst case
that the caps admit (3,000 characters) 120 to 255 ms. Before the size check on the output was added
a refused 2,000-character mhchem formula cost 340 ms. jsdom timings are not recorded: its DOM is far
slower than Chromium's. Nothing here was measured on Linux or macOS, in Edge, or on a slow device.

### Consequences and limits (stated plainly)
- Selecting a typeset formula and copying it copies the flattened text of the MathML (`E=mc2`), not the
  TeX. The note's stored body, search, export and backup are unchanged and keep the TeX; to copy the TeX
  open the note for editing.
- Colour (`\color`, `\textcolor`, `\colorbox`) and `\rule` fall back to source text. `\label`/`\ref` and
  equation numbers are not carried. `\newcommand` and `\def` are not available.
- Tuned for Chromium (Chrome, and Edge by the same engine). Not tuned for Firefox or Safari: the
  WebKit and Firefox corrections of temml's stylesheet are not shipped.
- The Temml font (`Temml.woff2`, script capitals and primes) is not shipped: `\mathscr`, `\mathcal`
  and `'` use the platform's math font (Cambria Math on Windows, STIX/Noto Math where installed).
- Inline formulas do not wrap (Chromium has no line breaking in MathML); a very long inline formula
  widens its line.
- `strict: true` makes temml print `Temml parse error: Command ... is invalid in math mode.` with
  `console.log` for text-only accents in math mode, and refuses Unicode letters outside its symbol
  tables in math mode (`$é$`: use `\text{é}`).
- `\ce` brings temml's mhchem parser (about 38 KB minified) into the chunk.
- jsdom has no `MathMLElement`, so the unit tests give plain elements a minimal `style`
  (`mathTestSupport.ts`); the CSSOM path itself is exercised only in the e2e run.
- A release-time grep for `fetch` over the *built* output finds `parser.fetch()` (a tokenizer method)
  in the typesetter chunk; it is not a network call. The source-level grep of `PRIVACY_CLAIMS.md` P1
  does not cover `node_modules`.

### Verification
- `packages/ui/src/vault/mathTypeset.test.ts` (render, golden samples, refusals, limits, throw
  handling, a hostile node battery against `cleanMath`), `markdownRender.math.test.ts` (the renderer
  with the typesetter loaded: placement, budget before temml, failure fallback, the shared hostile
  battery in `markdownHostile.ts`), `mathLoader.test.ts` (lazy, once, failure), `Markdown.test.tsx`
  (source first, then typeset, unmount, source change), `markdownBudget.test.ts` (`mathBudget`),
  `entrypoints/dashboard/Preview.test.tsx` (the editor preview); `markdownRender.test.ts` and
  `markdownRender.budget.test.ts` run with a typesetter that refuses everything, so they keep asserting
  the source-text contract.
- `tests/e2e/math.spec.ts` (9 tests): typeset in the real extension with real MathML layout, source
  kept through edit, reload and search, nothing fetched before a formula exists and one script and one
  stylesheet after, hostile payload inert, a refused formula and a failed fetch fall back, axe in light,
  dark and forced colours, RTL, Chromium's accessibility tree, and the 50-formula timing.
  `tests/e2e/math-panel.spec.ts`: the same for a card note in the side panel, with axe in both schemes.
  Run by this change on one machine only (Windows, Chromium 1248, private build); the CI `e2e` jobs have
  not run it.

### What differs from the design recorded under "If this is revisited"
`style` and `class` could not be left out: array cell padding and the strike and box drawing need
them, so both are allowed with closed value sets instead. `semantics`/`annotation` are left out as
designed. The numeric sizing attributes were widened to the list above (measured). The `maxExpand`
limit was kept at temml's own 1,000 and the real bound on output is the macro refusal plus the length
and element caps.

---

## Original decision (2026-10-11), kept for history

> Everything below is what was decided and measured on 2026-10-11. Where it says that formulas are not
> typeset or that nothing of temml was added, Amendment 1 supersedes it. The source-text rendering it
> specifies (the `<code class="math">` contract, the scanner and its caps, the `class` rule, the AI
> `esc()`) is unchanged and is what runs while the typesetter loads and whenever it refuses a formula.

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
