# UX and Design Contract: Sunny Vault

**Status:** accepted · **Date:** 2026-10-14 · Decision record: `docs/adr/021-playful-redesign.md`.
Reference mockup: `gallery/mockups/sunny/` (clickable, sample data, not product code). Where this
document and the mockup differ, this document wins; the deliberate differences are listed in
section 15.

This contract replaces the "precise, dense, editorial" contract of Phases 0-7. Product rules that
are not about looks are unchanged: local-first, provenance immutable, AI output separate and
unverified, no dead controls, honest numbers (`CLAUDE.md`).

## 1. Principles

1. **Playful, not childish.** Bright brand blue and sunshine yellow, chunky pressable shapes, a
   friendly mascot. Original: nothing borrowed from Duolingo or any other product (section 14).
2. **Graphical first.** Status is an icon, badge, ring or bar with a number next to it. A sentence
   is the last resort.
3. **Minimal text.** Labels have at most 3 words; a screen region has at most 1 helper line; detail
   lives behind an (i) button.
4. **One decision per screen.** Any flow with more than one decision is a wizard (section 10).
   Quick actions stay one click.
5. **Four things up front.** Highlight & save, Banks, Review, Search. Everything else sits under
   "More". Nothing is deleted by the redesign; it moves.
6. **Real data only.** Every number, ring, bar and chart is computed from the vault. No sample
   numbers, no invented claims, no zero shown where there is no data.
7. **Calm by default.** Motion is short and finite, celebrations are rare, sounds are off, and the
   whole game layer can be switched off.
8. **Accessible in both themes.** WCAG 2.2 AA in light, dark and high contrast, at 320 px and 200 %
   zoom, by keyboard and screen reader (section 13).

## 2. Tokens

Plain CSS custom properties with the `--sv-` prefix (ADR-002: no Tailwind, no CSS-in-JS), in one
token file shared by extension pages and the in-page overlay (the overlay pulls it in with a
relative CSS `@import`, as `entrypoints/highlighter.content/ui/styles.css` does today; it never
imports `@ui` JavaScript). Light is the default; dark follows `prefers-color-scheme` unless
`data-theme="light"|"dark"` is set on `<html>` (extension pages) or on `.sv-root` inside the
overlay's shadow root. `:host` carries the light defaults; the overlay's host element is
page-visible and never carries the theme.

### 2.1 Colour

| Token                                    | Role                                            | Light     | Dark      |
| ---------------------------------------- | ----------------------------------------------- | --------- | --------- |
| `--sv-primary`                           | Brand blue: primary buttons, selected states    | `#2A62E5` | `#3268EA` |
| `--sv-primary-edge`                      | 3D edge under primary                           | `#1B44A8` | `#1D3F99` |
| `--sv-on-primary`                        | Text and icons on primary                       | `#FFFFFF` | `#FFFFFF` |
| `--sv-primary-soft`                      | Selected tab, pressed chip, soft tile           | `#E6EEFF` | `#1E2D57` |
| `--sv-primary-soft-ink`                  | Text on soft blue; ghost buttons; links         | `#1E4FC4` | `#A9C2FF` |
| `--sv-sun`                               | Sunshine yellow: XP, goal ring, streak, "Start" | `#FFC83D` | `#FFC83D` |
| `--sv-sun-edge`                          | 3D edge under yellow                            | `#D99A00` | `#B37E00` |
| `--sv-on-sun`                            | Text on yellow                                  | `#3A2A00` | `#2A1E00` |
| `--sv-sun-soft`                          | Soft yellow tile and badge                      | `#FFF4D1` | `#3A3014` |
| `--sv-sun-soft-ink`                      | Text on soft yellow; XP number                  | `#7A5300` | `#FFD873` |
| `--sv-sun-line`                          | Outline that gives yellow progress its 3:1 edge | `#9A6C00` | `#B37E00` |
| `--sv-canvas`                            | Page background                                 | `#EDF1F8` | `#0E1527` |
| `--sv-surface`                           | Cards, dialogs, popovers                        | `#FFFFFF` | `#172038` |
| `--sv-surface-2`                         | Inputs, nested panels                           | `#F4F6FB` | `#1D2843` |
| `--sv-sunk`                              | Tracks, icon tiles, disabled fill               | `#E3E9F4` | `#26324F` |
| `--sv-border`                            | Decorative outline of cards and chips           | `#D5DDEB` | `#2E3B5C` |
| `--sv-edge`                              | 3D edge under neutral buttons                   | `#C6D0E2` | `#0A0F1D` |
| `--sv-line-strong`                       | Boundary that identifies a control (1.4.11)     | `#75829F` | `#7E8BB0` |
| `--sv-ink`                               | Main text                                       | `#18213B` | `#ECF1FF` |
| `--sv-ink-2`                             | Secondary text, idle icons                      | `#4A5672` | `#A9B5D3` |
| `--sv-focus`                             | Focus ring                                      | `#1D4FD8` | `#FFD15C` |
| `--sv-focus-halo`                        | Halo between the ring and the control           | `#FFFFFF` | `#0E1527` |
| `--sv-flame` / `--sv-flame-ink`          | Streak flame icon / streak number               | `#FF7A1A` / `#B54A00` | `#FF8A33` / `#FF9A4D` |
| `--sv-ice`                               | Streak freeze snowflake                         | `#1F7FD6` | `#4AA8FF` |
| `--sv-bar-primary` / `--sv-bar-success`  | Progress fills (lighter in dark for 3:1)        | `#2A62E5` / `#0A8060` | `#A9C2FF` / `#6EE7B7` |
| `--sv-bar-violet`                        | Violet progress fill                            | `#6A4BE0` | `#C4B5FF` |
| `--sv-glow`                              | Halo behind the celebrating mascot              | `#FFF4D1` | `#1E2D57` |
| `--sv-scrim`                             | Modal backdrop                                  | `rgb(22 44 110 / 0.42)` | `rgb(3 6 14 / 0.7)` |
| `--sv-shadow`                            | Floating elevation                              | `0 10px 30px rgb(24 33 59 / 0.12)` | `0 10px 30px rgb(0 0 0 / 0.4)` |

Status families: `--sv-<tone>-fill` (white text on it, used for rating buttons), `-edge` (3D),
`-soft` (background) and `-ink` (text on the soft background or on surfaces). Fills and edges are
the same in both themes; soft and ink change. The legacy names `--sv-danger`, `--sv-success`,
`--sv-warning` and `--sv-info` (and their `-bg`) stay text-safe: they alias the `-ink` and `-soft`
tokens.

| Tone      | Fill      | Edge      | Soft (light / dark)   | Ink (light / dark)    | Meaning                     |
| --------- | --------- | --------- | --------------------- | --------------------- | --------------------------- |
| `success` | `#0A8060` | `#065C45` | `#DDF6EC` / `#163A33` | `#0A6E50` / `#6EE7B7` | Done, on, saved; "Good"     |
| `danger`  | `#D7373F` | `#9E2229` | `#FDE5E6` / `#3D1F27` | `#B3262D` / `#FF9AA0` | Error, delete; "Again"      |
| `warning` | `#B35600` | `#7F3D00` | `#FFEBD6` / `#3B2A17` | `#9A4C00` / `#FFB870` | Needs a look, risky; "Hard" |
| `violet`  | `#6A4BE0` | `#4A2FB3` | `#EEE9FF` / `#2A2350` | `#5B3FD6` / `#C4B5FF` | Badges, AI tiles; "Easy"    |

The dark `danger` fill is 3.14:1 on `--sv-surface-2`: it is a fill and a border, never text. Text in
a status colour always uses the `-ink` token (or its legacy alias).

Highlight colours are user data (`COLOR_IDS` in `packages/shared/src/constants.ts`: amber, blue, red,
purple, orange, green, teal, mapped to the seven semantic kinds by the user's palette). The redesign
keeps the seven ids and their `COLOR_SWATCH` values; it does not adopt the mockup's five colours.
Every swatch is shown with its kind's name and glyph (section 6, kind dot).

Heatmap scale (0 = no activity): light `#E3E9F4` `#C9D9FF` `#8FB0FF` `#4C7FF0` `#1F4FC7`; dark
`#26324F` `#233C75` `#2F5BC4` `#5B8CFF` `#A9C2FF`.

Mascot colours are fixed in both themes: navy `#16337F`, body `#2A62E5`, door `#E3ECFF`, hinges
`#FFC83D`, face ink `#18213B`, cheeks `#FF8FB1`.

### 2.2 Contrast evidence

Computed from the hex values above with the WCAG 2.x relative-luminance formula (the same formula
as `packages/ui/src/contrast.test.ts`). Text needs 4.5:1, non-text 3:1. The implementation must
extend `contrast.test.ts` so every row below is asserted from the real CSS in light, dark and high
contrast.

| Pair (foreground on background)                     | Use                        | Light | Dark  |
| --------------------------------------------------- | -------------------------- | ----- | ----- |
| ink on canvas / surface / sunk                      | Body text                  | 14.05 / 15.91 / 13.06 | 16.09 / 14.30 / 11.26 |
| ink-2 on canvas / surface / surface-2 / sunk        | Secondary text, placeholder | 6.47 / 7.33 / 6.78 / 6.01 | 8.86 / 7.87 / 7.12 / 6.20 |
| on-primary on primary                               | Primary button             | 5.28  | 4.88  |
| on-sun on sun                                       | Yellow button              | 8.99  | 10.58 |
| primary-soft-ink on primary-soft / surface / canvas | Selected tab, ghost, link  | 6.07 / 7.07 / 6.24 | 7.56 / 9.11 / 10.26 |
| sun-soft-ink on sun-soft / surface / canvas         | XP badge and number        | 6.24 / 6.85 / 6.05 | 9.50 / 11.78 / 13.26 |
| success / danger / warning / violet ink on soft     | Status badges              | 5.50 / 5.42 / 5.31 / 5.67 | 8.17 / 7.29 / 8.07 / 7.84 |
| white on success / danger / warning / violet fill   | Rating buttons             | 4.92 / 4.66 / 4.94 / 5.68 | same  |
| danger-ink on surface                               | Field error                | 6.50  | 7.99  |
| flame-ink on surface / canvas                       | Streak number              | 5.32 / 4.70 | 7.68 / 8.64 |
| surface on ink                                      | Tooltip                    | 15.91 | 14.30 |
| line-strong on surface / surface-2 / canvas / sunk  | Input border, switch track | 3.85 / 3.56 / 3.40 / 3.16 | 4.77 / 4.32 / 5.37 / 3.76 |
| focus on canvas / surface / sunk                    | Focus ring                 | 5.86 / 6.64 / 5.45 | 12.57 / 11.17 / 8.80 |
| focus on focus-halo                                 | Ring against its halo      | 6.64  | 12.57 |
| focus-halo on primary                               | Ring in the blue hero      | 5.28  | 3.73  |
| sun-line on sunk / surface                          | Goal ring and yellow bars  | 3.81 / 4.65 | 3.57 / 4.54 |
| bar-primary / bar-success / bar-violet on sunk      | Progress fills             | 4.33 / 4.04 / 4.66 | 7.17 / 8.34 / 6.90 |
| ice on surface / canvas                             | Freeze snowflake           | 4.15 / 3.66 | 6.41 / 7.22 |
| primary on surface                                  | Switch "on" track          | 5.28  | 3.31  |
| danger on surface-2                                 | Invalid field border       | 4.31  | 3.14  |
| ink glyph on each highlight swatch                  | Kind glyph in toolbar dots | 3.76 (purple) to 7.41 (amber) | same |

Known below 3:1, and why that is allowed:

- `--sv-focus` (light) on `--sv-primary` is 1.26:1, and the dark ring on yellow is 1.07:1. The ring
  is therefore two-tone: the ring colour plus a `--sv-focus-halo` band between it and the control
  (the existing pattern), so one of the two always reaches 3:1 against what is behind it, including
  the blue hero.
- `--sv-border` (1.37 light, 1.46 dark) and `--sv-edge` are decorative: they outline cards and
  buttons that carry their own text. Controls found by their edge use `--sv-line-strong`.
- Yellow alone on its track is 1.27:1 (light); the `--sv-sun-line` outline carries the boundary.
- Heatmap levels 0-2 are below 3:1 on the surface, and neighbouring levels are 1.2-1.9:1 apart. The
  calendar is never the only carrier: it has a visible summary ("67 active days"), a per-cell name,
  and a table view with the numbers (section 5).
- The light flame `#FF7A1A` is 2.61:1; it is a decoration beside the streak number, which carries the
  meaning.

### 2.3 High contrast and forced colours

More contrast applies under `prefers-contrast: more` (repeating the dark selectors, as
`packages/ui/src/tokens.css` explains) and under the dashboard's existing per-viewer switch
(`data-contrast="high"`; `"more"` is accepted too):

| Token                | High contrast (light and dark) | Result                                           |
| -------------------- | ------------------------------ | ------------------------------------------------ |
| `--sv-ink-2`         | `var(--sv-ink)`                | Secondary text becomes main text (14.05+ : 1)    |
| `--sv-line-strong`   | `var(--sv-ink)`                | Control boundaries 15.91:1 / 14.30:1 on surface  |
| `--sv-border`        | `var(--sv-ink)`                | Every card and chip outline becomes a real line  |
| `--sv-focus-width`   | 4px (default 3px)              | Thicker focus ring                               |

Also in high contrast: heatmap cells get a 1 px `--sv-line-strong` outline; decorative sunbursts
and dot grids are hidden. The existing `highlightStyle` setting (`auto` follows the system query,
`strong` forces it) keeps controlling page highlights.

`forced-colors: active`: box shadows disappear, so nothing may depend on the 3D edge. Buttons keep a
2 px border (`ButtonText`); selected tabs, checked picture cards and pressed chips use
`Highlight`/`HighlightText`; the focus ring is `Highlight`; chart parts are set explicitly
(`CanvasText` value, `GrayText` track, `Highlight` today). Charts have hollow or patterned series as
in the existing analytics rules. Axe cannot judge this; it needs the manual forced-colours pass
(`docs/MANUAL_TEST_CHECKLIST.md` MT-42).

### 2.4 Typography

- **Extension pages:** `--sv-font: 'Nunito Variable', ui-rounded, 'SF Pro Rounded', system-ui,
  sans-serif`, bundled from `@fontsource-variable/nunito` 5.3.0 (OFL-1.1), normal style only, all five
  unicode-range subsets (137,516 B of woff2 on disk), `font-display: swap`, served by `font-src
  'self'`. No italic file ships; emphasis uses weight or colour, never `font-style: italic`.
- **In-page overlay:** `--sv-font-page-overlay: ui-rounded, 'SF Pro Rounded', system-ui,
  -apple-system, 'Segoe UI', Roboto, sans-serif`, assigned to `--sv-font` on `:host`. No web font is
  injected into pages. On Windows it falls back to Segoe UI (expected).
- **Code and TeX source:** the existing `--sv-font-mono` stack.

| Token            | Size            | Weight | Line height | Use                                                   |
| ---------------- | --------------- | ------ | ----------- | ----------------------------------------------------- |
| `--sv-text-xs`   | 0.75rem (12)    | 800    | 1.5         | Eyebrows (uppercase, +0.08em), badges, tab labels, kbd |
| `--sv-text-sm`   | 0.875rem (14)   | 700    | 1.4         | Meta, helper line, labels (800), small buttons         |
| `--sv-text-md`   | 1rem (16)       | 600    | 1.4         | Body, quotes, inputs (700), buttons (800 at 15 px)     |
| `--sv-text-lg`   | 1.25rem (20)    | 800    | 1.15        | Section titles, empty-state titles                     |
| `--sv-text-xl`   | 1.625rem (26)   | 900    | 1.15        | Page and wizard titles, hero greeting                  |
| `--sv-text-2xl`  | 2.25rem (36)    | 900    | 1.1         | Ring centre number, large streak, review answer        |

- The review question is 1.875rem (30 px) / 800, clamped down to `--sv-text-lg` in narrow
  containers. Headings use `letter-spacing: -0.01em`.
- Nunito is thin below 600: body text is 600 everywhere, nothing is set below 600 on a coloured
  background, and big numbers (XP, streak, ring, level) are 900.
- Floor: 12 px. The mockup's 10-11.5 px sizes are not carried over; a label that does not fit at
  12 px becomes icon-only with a visually hidden label (section 7.2).
- Sizes are in `rem` so browser zoom and the user's default font size apply.

### 2.5 Spacing and density

Scale (unchanged names): `--sv-space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 24, `-6` 32. Heroes and
empty states may use 48 (`2 x --sv-space-5`). Gutters: 16 px on pages and in the side panel, 12 px
at <= 340 px, 8 px at <= 260 px. Control height `--sv-control-h` 44 px.

The existing `density` setting (`comfortable` | `compact`, applied as `data-density` on the surface
root) keeps working: compact sets `--sv-space-2..6` to 6 / 8 / 12 / 16 / 24, `--sv-press` 3 px and
`--sv-control-h` 36 px; picture-card art shrinks to 56 px. Targets never drop below 24 x 24 px
(2.5.8).

### 2.6 Radii

`--sv-radius-sm` 10 (tooltip, kbd, icon button, small button, popover, menu), `--sv-radius-md` 16
(button, chip, input, toast), `--sv-radius-lg` 20 (card, picture card, dialog), `--sv-radius-xl` 28
(art tile, hero), `--sv-radius-pill` 999 (badges, bars, progress pill).

### 2.7 Elevation and the 3D edge

| Level | What                                              | Recipe                                                                 |
| ----- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| 0     | Canvas                                            | `--sv-canvas`                                                          |
| 1     | Card, tile, picture card, idle chip               | 2 px `--sv-border` border + `box-shadow: 0 3px 0 var(--sv-border)`     |
| 2     | Button (the 3D edge)                              | 2 px border in the fill colour + `box-shadow: 0 var(--sv-press) 0 <edge>` |
| 3     | Popover, tooltip, menu, toast, in-page toolbar    | Level 1 border + `--sv-shadow`                                          |
| Top   | Modal dialog                                      | Native `<dialog>` top layer + `--sv-scrim`                              |

- `--sv-press` is 3 px (small), 4 px (medium), 5 px (large). The button reserves it with
  `margin-bottom` so pressing never moves the layout.
- Pressed (`:active`, or a state the code sets): `translateY(var(--sv-press))` and the edge shadow
  goes to 0. Disabled: `--sv-sunk` fill, `--sv-border` edge, `--sv-ink-2` text, no press.
- The edge is decoration. Pressed, selected and checked states always have a second cue (a check
  mark, a filled icon tile, `aria-pressed`/`aria-checked`/`aria-selected`).
- Focus: `outline: var(--sv-focus-width) solid var(--sv-focus)` with a 2 px offset, and the halo as
  a 2 px `box-shadow` in the gap (the overlay's existing rule). On 3D elements the halo is added as
  an extra shadow layer in front of the edge shadow, never replacing it.

### 2.8 Motion

Tokens: `--sv-motion` 140 ms (a bare duration, as before, so existing CSS that appends its own
easing keeps working; was 120 ms), `--sv-motion-slow` 500 ms, `--sv-ease-spring`
`cubic-bezier(0.3, 0.7, 0.4, 1.4)`. Both durations are 0 under reduced motion.

| Motion                          | Duration          | Easing                              |
| ------------------------------- | ----------------- | ----------------------------------- |
| Hover, colour, tooltip fade     | 120 ms            | ease                                |
| Press, chip, switch thumb       | `--sv-motion`     | `--sv-ease-spring`                  |
| Toolbar, popover, menu appear   | 200 ms            | `--sv-ease-spring`                  |
| Toast rises                     | 260 ms            | `cubic-bezier(0.3, 0.7, 0.4, 1.3)`  |
| Review card flip                | 480 ms            | `cubic-bezier(0.3, 0.7, 0.4, 1.1)`  |
| Bars fill / goal ring fills     | `--sv-motion-slow` / 600 ms | `cubic-bezier(0.3, 0.7, 0.4, 1)` |
| XP float                        | 1.2 s, once       | ease-out                            |

- Animations are finite and end within 5 s of starting (2.2.2): XP float 1.2 s once; mascot wave
  1.4 s x 2, hop 0.7 s x 3, sparkle 1.2 s x 3, Zzz 2.4 s x 2, think dots 1.4 s x 3; confetti falls
  once and its longest piece ends before 5 s. No `infinite`, ever. Nothing flashes more than three
  times a second (2.3.1).
- `prefers-reduced-motion: reduce`: every duration becomes 0 (1 ms where an `animationend` event is
  needed); no movement of any kind: no flip (the faces swap), no press travel, no toolbar pop, no
  rising XP (it fades in place over 1.4 s, opacity only), no mascot animation (its static pose
  stays), no confetti (not rendered). Progress fills jump to their value.

### 2.9 Z-index

`--sv-z-raised` 1, `--sv-z-sticky` 10, `--sv-z-menu` 30, `--sv-z-tip` 40, `--sv-z-popover` 50,
`--sv-z-celebrate` 55 (confetti layer, `pointer-events: none`), `--sv-z-toast` 60. Modal dialogs use
the top layer, not a z-index. The overlay's host element keeps its existing `2147483647` and
everything inside its shadow root uses the scale above.

### 2.10 Token migration

Existing pages must keep working while surfaces are restyled one at a time. Every legacy name keeps
existing as an alias mapped to its Sunny value, so the new token file can replace the old one
without breaking a page; new code uses the new names.

| Legacy token                                  | Maps to                                            | Watch out                                     |
| --------------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| `--sv-bg`                                     | `--sv-canvas`                                      |                                               |
| `--sv-surface`                                | same name, now white (`#FFFFFF` / `#172038`)       | Was a grey panel: such panels move to `--sv-surface-2` |
| `--sv-surface-raised`                         | white in light, `--sv-surface-2` in dark           |                                               |
| `--sv-text` / `--sv-text-muted`               | `--sv-ink` / `--sv-ink-2`                          |                                               |
| `--sv-border-strong`                          | `--sv-line-strong`                                 |                                               |
| `--sv-accent` / `-hover` / `-text`            | primary in light; `#A9C2FF` / `#C4D5FF` / `#0E1527` in dark | Text-safe in dark (10.26:1), not the dark fill |
| `--sv-danger`, `--sv-success`, `--sv-warning`, `--sv-info` (+ `-bg`) | the tone's `-ink` (+ `-soft`) | Fills are the new `-fill` names     |
| `--sv-focus`, `--sv-focus-halo`               | Sunny values (two-tone ring kept)                  |                                               |
| `--sv-radius-sm` / `--sv-radius-md`           | same names, 10 / 16 px (were 8 / 12)               | Rounder corners on old surfaces               |
| `--sv-text-sm` / `-md` / `-lg`                | same names, 14 / 16 / 20 px (were 13 / 15 / 17)    | Re-check fit at 320 px                        |
| `--sv-motion`                                 | same name, 140 ms (was 120)                        |                                               |
| `--sv-hl-*`, `--sv-solid-*`                   | unchanged                                          | Highlight palette is user data                |

Aliases are deleted only when no file references them.

## 3. Vault buddy (mascot)

An original character: a rounded blue safe with yellow hinges, a round yellow-rimmed door for a
face, dot eyes, pink cheeks, a small keyhole nose, stubby arms and feet. One SVG component
(`viewBox 0 0 120 120`), no raster files.

| Pose  | Mouth and extras             | Use it for                                                                        |
| ----- | ---------------------------- | --------------------------------------------------------------------------------- |
| wave  | Smile, one arm waving        | Greeting: first run, onboarding step 1, dashboard hero, side panel header          |
| cheer | Big grin, sparkles, hop      | Success: goal met, session done, wizard done, badge earned, level up               |
| think | Wavy "hmm", hand on chin, thought dots | A decision or explanation: wizard steps with a choice, work over 1 s, AI setup |
| sleep | Sleepy "o", Zzz              | Empty states: nothing saved, nothing due, empty trash, no results                  |

| Size   | Where                                                         |
| ------ | ------------------------------------------------------------- |
| 32 px  | Inline next to text (smallest size; the face must stay readable) |
| 40 px  | Side panel header                                             |
| 48 px  | Popup and compact cards                                       |
| 96 px  | Wizard step intro beside a one-line speech bubble             |
| 132-160 px | Empty states, done screens, dashboard hero                |

Rules: decorative by default (`aria-hidden="true"`); it gets `role="img"` and a label only when it
is the only content saying something. It never carries information alone, never speaks more than
one line, and never appears on web pages (the in-page toolbar uses the logo mark). It is hidden at
<= 260 px container width. Motion follows section 2.8. With Game mode off it still appears in
greetings and empty states; it does not cheer for XP.

## 4. Iconography

- `lucide-react` 1.48.0 (ISC), named imports only so unused icons are tree-shaken. No icon fonts, no
  remote icons, no emoji as UI icons (a bank's emoji is user content, always shown next to its name).
- Stroke 2 for icons up to 18 px; 2.4 for 20-24 px navigation and tile icons; picture-card art 38 px
  at 2.4.
- Sizes: 14 (in badges), 16 (inline, errors), 18 (in-page toolbar, info), 20 (buttons, icon
  buttons, tabs), 38 (picture-card art).
- Icons are `aria-hidden`; the control carries the name (visible label, or `aria-label` plus a
  tooltip for icon-only buttons).
- One icon, one meaning:

| Meaning           | Icon            | Meaning        | Icon              | Meaning     | Icon              |
| ----------------- | --------------- | -------------- | ----------------- | ----------- | ----------------- |
| This page         | `FileText`      | Rules          | `Workflow`        | Again       | `RotateCcw`       |
| Banks             | `Library`       | Syllabus       | `ListTree`        | Hard        | `Hourglass`       |
| Review, cards     | `Layers`        | Graph          | `Network`         | Good        | `Check`           |
| Search            | `Search`        | Exam           | `Timer`           | Easy        | `Feather`         |
| More              | `Ellipsis`      | Duplicates     | `Copy`            | XP          | `Zap`             |
| Dashboard         | `House`         | Imports        | `FileInput`       | Streak      | `Flame`           |
| Settings          | `Settings`      | AI             | `Sparkles`        | Freeze      | `Snowflake`       |
| Save              | `Bookmark`      | Sync           | `RefreshCw`       | Info        | `Info`            |
| Note              | `NotebookPen`   | Trash          | `Trash`           | Close       | `X`               |
| Jump to source    | `LocateFixed`   | Storage        | `HardDrive`       | Undo        | `Undo2`           |
| Needs a look      | `TriangleAlert` | Fields         | `SlidersHorizontal` | Done, on  | `Check`           |
| Site              | `Globe`         | Chat           | `MessagesSquare`  | Off         | `Power`           |
| Stats             | `ChartColumn`   | Backup         | `Archive`         | PDF reader  | `BookOpen`        |

## 5. Charts and game visuals

In-house SVG only (no chart library), drawn from real vault data.

- **Goal ring:** track `--sv-sunk`, value `--sv-sun` with a `--sv-sun-line` outline, round caps.
  Centre: today's XP (900) over "/30 XP". Past the goal the ring stays full and gains a check badge;
  the number keeps counting. Name: "Daily goal: 18 of 30 XP".
- **Bars** (`role="progressbar"` with min, max, now and a label): 8 / 12 / 18 px high; the number is
  printed next to the bar. Zero is an empty bar (no stub). **No data is not zero:** a bank with too
  few reviews shows "n/a" and no bar, never "0%". Every bar names its metric in its label and (i).
  The bank bar is retention of mature reviews as ADR-020 defines it (a value only from 5 reviews).
- **Streak calendar (heatmap):** 12 weeks x 7 days, Monday first, levels by XP relative to the
  goal: 0, under half, under the goal, under 1.5 x goal, 1.5 x goal or more. Today has a
  `--sv-flame-ink` outline; a day saved by a freeze shows a snowflake glyph. Each cell has a name
  ("Tue 6 Oct: 24 XP, goal met"). Above it a visible summary ("67 active days"); an icon button
  switches to a table of the same numbers (`<table>` with caption and headers).
- **Existing analytics charts** keep their data, text summary and table view; they adopt the tokens.
- **Empty data** is an empty state (section 6.10), never a zero-filled chart.

## 6. Components

Each component lives once in `@ui` (extension pages) and is mirrored only where the overlay needs it
(the overlay may not import `@ui` JavaScript; section 7.6).

1. **Button.** Variants: `primary` (blue), `sun` (yellow, at most one per screen: the main game
   action such as Start review), `secondary` (surface), `ghost` (text only), `danger` (the
   `-fill`); `success`, `warning` and `violet` fills are reserved for the four rating buttons.
   Sizes 36 / 44 / 56 px min height. Icon left, label <= 3 words. A control that cannot act now is `aria-disabled="true"`
   (still focusable) with its reason in a tooltip or (i); never a silent native `disabled`.
2. **Icon button.** 40 px (32 px small), radius 10, `aria-label` plus a tooltip on hover and focus.
   `aria-pressed` for toggles (soft blue fill when pressed).
3. **Tooltip.** Ink background, 12 px / 700, max 220 px, appears on hover and focus, can be hovered,
   and Escape hides it until the pointer or focus moves (1.4.13). Never holds information that is
   not also in the accessible name.
4. **Badge and chip.** Pill, 12 px / 800, optional 14 px icon, tone from the status families. A
   count badge on a tab or tile has a visually hidden "(14)" in the label.
5. **Toggle chip.** Square tile with an icon tile and a label (popup quick toggles). `aria-pressed`;
   pressed = blue border, soft fill, solid icon tile and a check mark in the corner.
6. **Card.** Level 1, radius 20, padding 16 (12 compact). No card inside a card more than one
   level deep.
7. **Icon tab bar.** `role="tablist"`, arrow keys, Home and End, roving tab index, `aria-selected`;
   icon over label, count badge on the icon; selected = soft blue tile with a blue border. Labels
   hide visually at <= 260 px and stay in the accessible name.
8. **More grid.** A list of tile buttons: tone art tile, label <= 2 words, optional "Off" badge for a
   feature that is switched off (the tile still opens its setup). 3 columns in the side panel, 3-4
   in the popup, 6 on the dashboard.
9. **Wizard (stepper).** In a dialog or a page. Top: eyebrow with the flow name, close button,
   progress bar with "1/4" (accessible "Step 1 of 4"). Body: a title <= 3 words, at most one helper
   line, one decision. Footer: Back (disabled with a reason on step 1) and Next or the final verb.
   Focus moves to the step title on every step change. Next validates: the error appears under the
   field with an icon and focus moves to the field. Back keeps every answer (3.3.7). The last
   decision step is a review ("Looks good?") with each answer and a way back to it; then a done
   screen with the cheering mascot and one or two actions. Escape closes; if anything was entered it
   first asks "Discard?" in a confirm dialog. Modal wizards trap focus (Tab wraps) and return focus
   to the opener. The dialog is top-aligned so it does not jump between steps. Skip only where the
   flow is optional (onboarding).
10. **Empty state.** Mascot (sleep or wave), title <= 3 words, at most one helper line, one primary
    action. Example: "Nothing saved yet" / "Select text, then Alt S".
11. **Picture-card choice.** Native radios in labels inside a `fieldset` with a `legend` (visually
    hidden when the step title says it). Each card: 72 px art tile with an icon, title <= 2 words,
    meta <= 3 words, check circle top right. Checked = blue border, soft fill, filled check, art tile
    on white. Arrow keys move between options (native radio group). Grid: 2-4 columns, 1 column
    at <= 340 px.
12. **(i) tip.** 28 px button with `aria-expanded` and `aria-controls`; opens a popover (232 px,
    radius 10) with at most three short sentences and a close button. Opens on click or Enter, never
    on hover only; Escape or a click outside closes it and returns focus to the button.
13. **Toast.** Bottom of the surface, level 3, `role="status"` through the surface's one polite
    region. Content: icon, a 1-2 word result ("Saved"), context (bank chip), the `+2 XP` chip (Game
    mode on), Undo, Dismiss. Stays 5 s, 10 s with an action, pauses on hover and focus; Undo is
    also reachable elsewhere (Trash). `scroll-padding-bottom` keeps focused content above it.
14. **XP float.** "+1 XP" rises from the XP counter (1.2 s, `aria-hidden`); the XP is spoken as part
    of the existing per-card announcement, never as a separate message.
15. **Dialog.** Native `<dialog>` with `showModal()`; focus goes to the first field or the title;
    Escape closes; focus returns to the opener. Confirmations use the existing `ConfirmDialog`
    behaviour (Cancel focused for destructive actions).
16. **Input.** 48 px high, radius 16, `--sv-surface-2` fill, 2 px `--sv-line-strong` border (blue on
    focus, danger when invalid), 16 px / 700 text, label above (14 / 800), error below with an icon,
    `aria-invalid` and `aria-describedby`.
17. **Switch.** `role="switch"` with `aria-checked`, 46 x 28 track: off = `--sv-sunk` with a 2 px
    `--sv-line-strong` inset line, on = primary with its edge; the thumb position is the non-colour
    cue; the visible label sits to the right. Async switches keep `aria-busy` while saving
    (`AsyncSwitch`).
18. **Highlight card.** A 4 px left strip in the highlight's colour, the kind glyph and name, the
    quote (16 / 700, full text, no fixed height), an optional note line, bank chip and tags, and an
    action row (Note, Make card, Jump to source, More menu) that wraps at narrow widths. A highlight
    that could not be found on the page shows a warning badge "Not found" and sits under "Needs a
    look".
19. **Kind dot** (in-page toolbar and pickers). 28 px circle in the kind's swatch with the kind's
    glyph (`KIND_LABELS`) in `--sv-ink`, a 2 px `--sv-ink-2` ring, and the kind name as its
    accessible name and tooltip ("Save as Formula").
20. **Goal ring, streak, freezes, level emblem, badge, heatmap, kbd, bank chip:** as sections 5
    and 11 describe.

## 7. Surfaces and layout

### 7.1 Popup (400 px wide, at most 600 px high)

Chrome caps the popup at 800 x 600; every default state fits without inner scrolling.

1. Header: logo mark and "StudyVault", streak (Game mode on), Settings icon button.
2. Site card: globe, host (ellipsis), page title, status badge (On / Off / PDF / Not allowed),
   counts (highlights, needs a look), then one row: **On:** "Always on" switch + (i). **Off:** "Turn
   on" (primary) and "Always on" (secondary) + (i). **PDF:** "Open in StudyVault". **Restricted
   page:** the badge and one line saying why; nothing pretends to work.
3. Today card: goal ring (48), "12 XP to goal", level emblem. Game mode off: "8 reviewed · 3 saved".
4. "Open side panel" (primary, block) and "Start review" (sun, block, due count badge).
5. Quick toggles: Highlights (paint highlights), Toolbar, Game mode.
6. Footer: Dashboard link and the save shortcut (`Alt` `S`).

### 7.2 Side panel (320-360 px; works at 200 % zoom)

- Header: mascot 40 (wave), goal ring 42 with today's XP, streak, then Dashboard and Settings icon
  buttons. Game mode off: the ring and streak are not rendered.
- Icon tab bar: This page, Banks, Review, Search, More (section 9).
- Body: card lists with 12-16 px gutters; "This page" shows "Needs a look" first, then "On this
  page"; Banks shows bank rows with a fixed-width status badge (due count or a check); Review shows
  the due mix and Start; Search shows filter chips and, while empty, Recent.
- Container queries on the panel: `<= 340px` tightens tabs and gutters; `<= 260px` (a 320 px panel
  at about 200 % zoom is 160 CSS px) hides the mascot, wraps the header, makes tabs icon-only
  (labels visually hidden) and uses 8 px gutters. No horizontal scrolling, no clipped text (titles
  wrap; only a host name may ellipsis, with the full name in its accessible name).

### 7.3 Dashboard (full page)

- Left rail (96 px): Home, Banks, Review, Search, More; Settings at the bottom. Under 900 px the rail
  becomes a top icon tab bar; at 320 px (400 % zoom) one column.
- Home, >= 1200 px: main column (hero, Your banks, More grid) and a right column (Today card, streak
  calendar, badges). 900-1199 px: the right column moves under the hero.
- Hero: blue card with a sunburst, mascot 132 (wave), greeting ("Good morning"; no name: there is no
  account or name), "14 cards ready", due mix chips (new, learning, review), "Start review" (sun).
  The two-tone focus ring keeps 3:1 on the blue (section 2.2).
- Your banks: cards with emoji tile, name, "128 saved · 64 cards", retention bar or "n/a", due
  badge or check; a dashed "New bank" tile opens the wizard.
- Banks, Search and the More destinations keep their existing panels (tree, list, preview, bulk bar,
  palette) restyled with these components; the existing narrow-layout and focus rules stay.

### 7.4 Review page

- Header: End session (X), a centred progress pill ("3/14" and a bar), XP and streak on the right
  (Game mode on). No full-width bar beside the close button (section 14).
- Stage: the card (max 700 px wide, height grows with content, never a fixed height) with bank chip
  and card type; question 30 px / 800; the answer side repeats the question small and shows the
  answer in `--sv-primary-soft-ink`, 36 px / 900 (smaller for long answers).
- Controls: "Show answer" (primary, large) with "or Space"; then four rating buttons (large, fully
  coloured, icon + label + next interval + key 1-4). Single-key shortcuts work only while focus is in
  the session and keep the existing off switch (`sv.review.keys`).
- Done screen: mascot 160 (cheer) on a `--sv-glow` halo, "Session complete!", one summary card (goal
  ring and four facts: XP earned, streak, recalled %, time), "Review again" and "Done". Focus goes
  to the title. Confetti once (not under reduced motion).
- The page's other sections (Create cards, Cards, Exam, Stats, review settings) are reached from
  More and keep their `?view=` deep links.

### 7.5 Settings, onboarding and other pages

- **Settings (options page):** section list on the left (>= 900 px) or on top (narrow); each section
  is a card; each setting is a label <= 3 words, its control and an (i). Multi-step settings open
  their wizard (section 10).
- **Onboarding:** centred card (max 760 px) on the canvas with a dot grid and a sunburst
  (decorative, hidden in high contrast), progress and Skip at the top, mascot with a one-line speech
  bubble, picture cards, Back / Next.
- **PDF reader:** chunky icon-button toolbar at the top, page on the left, companion on the right
  (the side panel's highlight cards), save bar styled like the in-page toolbar but in Nunito. Empty
  state: mascot (think) and a picture-card choice "From computer" / "From a link". A PDF without a
  text layer shows a "No text" badge, an (i) and "Recognise text".

### 7.6 In-page toolbar and save toast

- Lives in the existing Shadow DOM overlay (Preact, ADR-012); shares the token CSS file but imports
  no `@ui` JavaScript; system rounded font (`--sv-font-page-overlay`); a handful of lucide icons
  (the content-script budget in `scripts/check-build.mjs`, 230 KB, still holds).
- Layout: logo mark | seven kind dots | separator | Save | Note | bank picker (emoji + name up to
  12 characters + chevron, opens a menu of banks). Radius 18, level 3, a small arrow toward the
  selection. The existing "More options" panel (bank tree, tags, note, card) stays one click away.
- Placement: above the selection; flips below when there is no room above (required; the mockup
  does not do it yet); never covers the selection; stays inside the viewport.
- Keyboard: reachable as today; Escape closes it and returns focus to the page; the bank menu
  closes on Escape back to its button.
- After a save: the toast (bottom right of the viewport, inside the shadow root): check, "Saved",
  bank, `+2 XP` (Game mode on), Undo, Dismiss. No other game UI appears on web pages.
- Theme follows the extension setting through `data-theme` on `.sv-root` (never on the host).

## 8. Copy rules

- Labels: at most 3 words ("Start review", "Always on", "New bank"). Tabs and tiles: 1-2 words.
- Helper text: at most one line (about 60 characters) per region. Anything longer goes behind (i)
  (at most three short sentences).
- Tone: friendly, short, plain, second person, sentence case. Digits for numbers. No jargon
  ("Not found", not "re-anchor failed"; "next in 1d", not FSRS terms).
- Exclamation marks: only on a celebration title ("Session complete!", "All set!"), one per screen.
- No guilt or loss pressure ("Your streak is in danger!" is forbidden). A reminder states facts:
  "14 cards ready".
- Errors: what happened and what to do, one line ("Could not save. Try again."); details behind (i).
  A disabled control says why.
- No claims the product cannot back: no "Popular", no "most students", no names it does not know.

## 9. Navigation

The same four core destinations, in the same order, on every surface: **Highlight & save** (shown
as "This page" in the side panel and "Home" on the dashboard), **Banks**, **Review**, **Search**,
then **More**. Settings is an icon button in every header. Ctrl+K opens the command palette with
every command on the dashboard, as today.

| Feature                                      | Placement | Where                                                              | Flow                  |
| -------------------------------------------- | --------- | ------------------------------------------------------------------ | --------------------- |
| Save a selection (toolbar, Alt+S, menu)      | Core      | Web pages, PDF reader save bar                                     | One click             |
| Highlights on this page, needs a look        | Core      | Side panel "This page"                                             | -                     |
| Turn on for this tab / always on             | Core      | Popup site card                                                    | One click             |
| Banks, folders, tags, preview, bulk actions  | Core      | Side panel "Banks", dashboard "Banks"                              | -                     |
| New bank                                     | Core      | Banks ("New bank" tile or button)                                  | Wizard                |
| Move, rename, delete (with Undo)             | Core      | Banks, highlight card menu                                         | One click / dialog    |
| Study session                                | Core      | Popup "Start review", side panel "Review", dashboard hero          | One click             |
| Make a card from a highlight                 | Core      | Highlight card action                                              | One click             |
| Search, filters, saved searches, Recent      | Core      | Side panel "Search", dashboard "Search"                            | -                     |
| Exam                                         | More      | More > Exam (`?view=exam`)                                         | Wizard                |
| Syllabus editor and coverage                 | More      | More > Syllabus; coverage in Stats                                 | Wizard to create      |
| Card browser                                 | More      | More > Cards (`?view=cards`)                                       | -                     |
| Create cards (full editor)                   | More      | More > Cards > Create (`?view=create`)                             | -                     |
| Stats (review analytics)                     | More      | More > Stats (`?view=analytics`)                                   | -                     |
| Auto-filing rules                            | More      | More > Rules                                                       | Wizard                |
| Imports                                      | More      | More > Imports                                                     | Wizard                |
| Backup, restore, backup folder               | More      | More > Backup; Settings > Your data                                | Wizards               |
| Duplicates                                   | More      | More > Duplicates                                                  | -                     |
| Trash                                        | More      | More > Trash                                                       | -                     |
| Knowledge graph                              | More      | More > Graph                                                       | -                     |
| Custom fields                                | More      | More > Fields                                                      | Dialog (<= 2 inputs)  |
| Storage                                      | More      | More > Storage                                                     | -                     |
| PDF reader                                   | More      | More > PDF reader; popup on a PDF page                             | One click to open     |
| AI (off by default)                          | More      | More > AI ("Off" badge until set up)                               | Wizard                |
| Chat with your notes (AI)                    | More      | More > Chat ("Off" until AI is set up)                             | -                     |
| Sync (off by default)                        | More      | More > Sync ("Off" badge)                                          | Wizard                |
| Badges and level                             | More      | Dashboard home card, level emblem anywhere (Game mode on)          | -                     |
| Appearance, capture, privacy, shortcuts      | Settings  | Header Settings icon                                               | -                     |
| Game mode, daily goal                        | Settings  | Settings > Game; popup quick toggle                                | One click / picker    |
| Site access, blocked sites                   | Settings  | Settings > Site access                                             | Wizard                |
| Review settings, reminders                   | Settings  | Settings > Review, Settings > Reminders                            | Wizard (reminders)    |
| Delete all data                              | Settings  | Settings > Your data                                               | Wizard                |
| Welcome tour again                           | Settings  | Settings > About                                                   | Wizard                |

More grid order (most used first): Exam, Syllabus, Cards, Stats, Rules, Imports, Backup, Duplicates,
Trash, Graph, Fields, Storage, PDF reader, AI, Chat, Sync.

## 10. Wizard catalogue

Each screen holds one decision (section 6.9). The steps follow the decisions each feature's ADR
already made; the wizard changes the presentation, not the rules. A flow with at most two inputs
and no branching stays a single dialog.

| Flow                          | Opens from                         | Steps                                                                                          | Done                                |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| Welcome tour                  | First install; Settings > About    | 1 Daily goal (10 / 30 / 50 / 100, 30 suggested) · 2 Turn on a site (This tab / One site / All sites; nothing is asked during the tour) · 3 Ready (summary + Game mode switch) | "All set!", Open dashboard          |
| New bank                      | Banks                              | 1 Name · 2 Icon · 3 Colour · 4 Looks good?                                                     | Open the bank                       |
| Filing rule                   | More > Rules                       | 1 When (picture cards: site, address, title words, quote words, kind, source) · 2 Values · 3 File into (bank, folder, tags) · 4 Ask first? (on by default) · 5 Review and "Test a rule" (ADR-017) | Rule list, new rule on              |
| Import                        | More > Imports                     | 1 Format (picture cards) · 2 File · 3 Preview (counts, duplicates skipped, errors) · 4 Into bank | Import result with Undo             |
| Exam                          | More > Exam; coverage table        | 1 Cover (library or syllabus) · 2 Scope (with card counts) · 3 Questions (and shuffle) · 4 Time limit · 5 Plan (ADR-020) | The exam starts                     |
| New syllabus                  | More > Syllabus                    | 1 Start from (empty / paste outline / my banks) · 2 Name · 3 Paste with live dry run (paste only) · 4 Map topics (optional) | Editor                              |
| Backup                        | More > Backup                      | 1 Protect with a passphrase? · 2 Passphrase (if yes) · 3 Where (download / backup folder)       | File saved, where it is             |
| Restore                       | More > Backup                      | 1 File · 2 Check (version, integrity, counts) · 3 Merge or Replace (Replace is danger) · 4 Confirm | Result with counts                  |
| Backup folder                 | More > Backup                      | 1 Pick folder (Chrome's folder dialog) · 2 Copies to keep (ADR-016)                            | Folder status, "Back up now"        |
| Site access                   | Settings > Site access; popup (i)  | 1 Where (This tab / One site / All sites) · 2 Chrome asks (explains, then the Chrome prompt)   | Status per site                     |
| AI setup                      | More > AI                          | 1 Provider · 2 Address and key (stored on this device) · 3 What may be sent · 4 Test           | AI on, with "unverified" explained  |
| Sync setup                    | More > Sync                        | 1 Where · 2 End-to-end encryption (optional passphrase) · 3 First sync check                    | Sync on                             |
| Reminders                     | Settings > Reminders               | 1 Badge on icon? · 2 Daily time · 3 Permission (optional "alarms")                              | Reminder status                     |
| Delete all data               | Settings > Your data               | 1 Back up first? · 2 Confirm (existing "Delete everything" dialog)                              | Fresh start screen                  |
| Daily goal (existing users)   | One card on first open after the update | 1 Daily goal                                                                               | Card disappears                     |

Onboarding opens on install only (`entrypoints/background/index.ts`), so existing users get the
daily-goal card instead of the tour; until they choose, the goal is 30.

## 11. Game layer

On by default; every number comes from the game ledger (storage, backup and backfill are decided in
the game engine's own ADR; this section is the UX).

**XP (rating-neutral).** Review a card: 1 (any rating, so the rating stays honest). Save a highlight:
2 (a new highlight only: not a duplicate, a restore, an import, a merge restore or a synced row).
Create a card: 3 (per card created). Finish a session with at least one answer: +5, once per
session. Undoing a review or a save takes its XP back. An exam awards review XP only for the
answers the person chooses to count as review, and no session bonus.

| Element         | Rules                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily goal      | 10 / 30 / 50 / 100 XP (Casual, Regular, Serious, Intense). Picked in onboarding or Settings > Game; changes apply from the current study day.   |
| Study day       | The review settings' day boundary (time zone and rollover hour, default 04:00), the same one analytics uses.                                     |
| Goal ring       | Today's XP against the goal (section 5). Popup, side panel header, dashboard, review done screen.                                             |
| Streak          | Consecutive study days on which the goal was met. Today counts once met; an unmet today does not break it until the day ends. Flame + number. |
| Freezes         | One earned per 7 streak days, at most 2 held, used automatically on a missed day; that day shows a snowflake. Snowflakes held / 2, named "2 of 2 streak freezes". |
| Level           | Hex emblem with the number; a bar to the next level; the level road shows the next 3 levels and their XP. Each level needs 50 XP more than the one before: reaching level L takes `25·L·(L−1)` XP in all (level 2 at 50, 3 at 150, 4 at 300, 10 at 2,250; ADR-022). |
| Badges          | Earned = coloured ring and icon; locked = grey with a lock glyph and progress. Criteria never depend on ratings, time pressure or money.         |
| Celebrations    | Goal met (once a day), level up, badge earned, streak milestones (7, 30, 100, 365). Toast plus mascot cheer; confetti only for goal met and level up. One at a time, queued; never mid-card (shown at session end); never steal focus; spoken once through the polite region. |
| Sounds          | None ship. A Sounds control appears only once bundled sounds exist, off by default.                                                            |
| Game mode off   | Hides XP, the ring, streak, freezes, level, badges, XP floats, celebrations and confetti everywhere; the Today card shows plain counts. The ledger keeps recording, so switching it on shows the true state (including a streak that ended). The mascot stays. |
| Analytics       | The analytics page's day count is labelled "Study days", not "streak", so there is one streak.                                                |

## 12. Empty, error and optimistic states

- Required states: no highlights on the page, no bank yet, nothing due, PDF access denied,
  unsupported or restricted page, AI unavailable, offline, sync conflict, highlight not found on the
  page, imported data needs review, storage unavailable, corrupted backup, newer-version data.
- Each uses the empty-state component (section 6.10) or an inline notice with the right status icon;
  the explanation is one line plus (i).
- Optimistic UI only with rollback, retry and accurate status; a quote is never lost because a save
  failed.
- Loading over 1 s shows the mascot (think) or a progress bar with real progress; no fake progress.

## 13. Accessibility contract

WCAG 2.2 AA in light, dark and high contrast on every surface, checked by axe (`wcag2a`, `wcag2aa`,
`wcag21aa`, `wcag22aa`) in the e2e suites and by the manual rows of
`docs/MANUAL_TEST_CHECKLIST.md`. Passing axe is not a conformance claim.

- **1.1.1** Charts have a text summary and a table; the mascot is decorative unless it is the only
  content.
- **1.3.1 / 4.1.2** Real semantics: tabs, radios in fieldsets, switches, progress bars, dialogs, lists.
- **1.4.1** Colour is never the only cue: kinds have glyphs and names, ratings have icons and labels,
  states have check marks or text.
- **1.4.3 / 1.4.11** Text 4.5:1, control boundaries and meaningful graphics 3:1 (section 2.2,
  asserted by `contrast.test.ts`).
- **1.4.4 / 1.4.10** 200 % zoom and 320 CSS px reflow: side panel down to 160 CSS px, dashboard at
  400 %, no horizontal scroll, no clipped text.
- **1.4.12** No fixed heights on text containers (cards, review faces, rows grow).
- **1.4.13** Tooltips and popovers are hoverable, persistent and dismissible with Escape.
- **2.1.1 / 2.1.2** Everything works by keyboard; only modal dialogs and wizards trap focus, and
  Escape leaves them.
- **2.1.4** Single-key shortcuts act only while focus is inside their component and can be turned
  off (existing switches kept).
- **2.2.1** Toasts pause on hover and focus; nothing important disappears on a timer.
- **2.2.2 / 2.3.1** Animations finite and under 5 s, no flashing; reduced motion removes movement.
- **2.4.3** Focus never falls to `<body>`: wizard steps focus their title; removed controls hand
  focus on (`useFocusRescue`); Escape returns focus to the opener.
- **2.4.7 / 2.4.11** Visible two-tone focus ring, 3 px (4 px in high contrast) with its halo
  (section 2.7); toasts and sticky headers never cover the focused element (`scroll-padding`).
- **2.5.3** The visible label starts the accessible name ("Good, next in 1d").
- **2.5.7 / 2.5.8** No drag-only action; targets at least 24 x 24 px (controls are 32-56 px).
- **3.2.3 / 3.2.4** Same navigation, same order, same icons on every surface.
- **3.3.1 / 3.3.3 / 3.3.7** Errors named in text with a fix; wizards keep earlier answers.
- **4.1.3** One polite live region per surface; status is announced once and is not chatty.
- Overlay: focus management inside the Shadow DOM, no page markup changes, CSS Custom Highlight API
  for painting, styles isolated.
- Also required: `forced-colors` and `prefers-contrast: more` (section 2.3), the `density` setting,
  and screen-reader passes where feasible (NVDA, JAWS, VoiceOver rows in the checklist).

## 14. Forbidden

- **Duolingo look-alikes:** an owl or any bird mascot, a green primary, its lesson header (close X
  beside a full-width progress bar), three coloured stat tiles at the end of a lesson, hearts or
  lives, gems or any currency, leagues and leaderboards, its fonts, sounds or illustration style.
- **Fake numbers:** sample data, placeholder charts, invented social claims ("Popular"), names the
  product does not know, "0%" for no data, fake progress.
- **Pressure:** guilt copy, streak-loss alarms, rewards that depend on ratings or speed, anything
  bought.
- **Infinite or long animation**, flashing, autoplaying sound.
- **Text walls:** more than one helper line in a region, paragraphs in panels, labels over 3 words.
- **Dead controls:** toggles for features that do not exist (Sounds before sounds ship), handles that
  do nothing, buttons without an action or an explanation.
- **Hover-only** information or actions; **colour-only** status.
- **Platform breaks:** remote fonts, icons or code; `<style>` elements or `style=""` markup (React
  `style={{}}` through the CSSOM is fine); Tailwind or CSS-in-JS; the overlay importing `@ui`; the
  theme attribute on the overlay's host; emoji as UI icons.

## 15. Deliberate differences from the mockup

The mockup is approved for look and feel; these points change on purpose:

1. Onboarding goal card tag "Popular" becomes "Suggested" (no data backs "Popular").
2. Dashboard greeting has no name ("Good morning"): the product has no account or name.
3. Easy uses `Feather`, not `Sparkles` (reserved for AI).
4. The popup's Sounds chip is not shown until sounds exist.
5. Toolbar dots are the seven semantic kinds with their glyphs and names, not five colour names.
6. A bank without enough reviews shows "n/a", not "0%".
7. The focus ring is two-tone (ring plus halo) everywhere, so it stays visible in the blue hero.
8. The "Perfect day" badge (no Again) is replaced by a rating-neutral badge.
9. The overlay shares the extension's `--sv-*` token file (no separate `--tb-*` set), and the theme
   attribute sits on `.sv-root`, never on the host.
10. The toolbar flips below the selection when there is no room above.
11. No text below 12 px; review card faces grow with content instead of a fixed 350 px height.
12. The More grid also holds Cards, Stats, Backup and PDF reader; Settings stays in the header.
13. Violet progress in dark uses `--sv-bar-violet` `#C4B5FF` (the mockup's `#6A4BE0` is 2.24:1 on
    its track).

Open owner questions (the default in brackets is what ships unless the owner says otherwise):
rating buttons fully coloured or tinted [fully coloured]; dashboard hero solid blue or white card
[solid blue]; new-bank wizard four steps or three [four]; a streak day is a day the goal was met, or
any day with XP [goal met].
