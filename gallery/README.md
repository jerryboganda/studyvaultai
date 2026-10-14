# StudyVault screen gallery

A localhost tool for design review. It serves the **real** extension pages (`entrypoints/*/main.tsx`)
in a normal browser tab. Around them it provides a hand-written fake of the `chrome` API, an in-memory
IndexedDB (`fake-indexeddb`), and seeded scenarios. Nothing under `entrypoints/` or `packages/` is
changed for it, and it is never part of the extension build.

It shows what each screen looks like in a given state. It does **not** show that the extension works:
the background code runs inside the page, no content script runs on a real site, and every Chrome
answer comes from the fake.

## Run it

```bash
node scripts/copy-ocr-assets.mjs   # once: generates public/ocr (git-ignored), needed for the OCR states
pnpm gallery                       # Vite on http://localhost:5199
```

- `http://localhost:5199/` is the overview. It shows every page in frames at its real size. Use it to
  pick a scenario, a theme, and a state for each page.
- `http://localhost:5199/pages/<surface>.html?...` opens one page. The surfaces are `popup`,
  `sidepanel`, `dashboard`, `review`, `options`, `onboarding`, `pdf-reader` and `overlay`.

Each page has its own in-memory database, seeded again on every load. A change you make in one tab
never appears in another tab.

## Address parameters

| Parameter                  | Meaning                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenario`                 | `student` (default), `fresh`, `heavy` or `edge` (`scenarios/`).                                                                                                                         |
| `theme`                    | `light` or `dark`. `window.__gallery.setTheme('dark')` switches the theme in place.                                                                                                    |
| `tab`                      | The fake active tab the popup and side panel look at: a preset (`article`, `reference`, `inactive`, `chrome`, `denied`, `pdf`, `newtab`, `none`; see `scenarios/tabs.ts`) or any address. |
| `state`                    | A state from `catalog.json`. It adds the state's parameters and hash (parameters already in the address win) and runs its script from `states.ts`.                                     |
| `fault`                    | Injected failures (next section).                                                                                                                                                      |
| the page's own parameters  | Passed through to the page unchanged, for example `view=`, `q=`, `highlight=`, `doc=`, `src=` and hash routes.                                                                         |

`<html data-gallery>` moves from `seeding` to `mounted`, or to `error`, in which case the page shows
the error. Every fake Chrome call is recorded in `window.__gallery.calls`.

## Faults (`?fault=`)

`fault=<target>:<mode>[,<target>:<mode>…]` makes the real pages show their own error and loading
states (`faults.ts`). Faults switch on just before the page mounts, so seeding is never affected. They
pause while the gallery switches the theme.

- **Targets**
  - An RPC message type: `site.status`, `tab.activate`, `content.pageStatus`, `sync.status`, and so
    on. `*` matches every RPC.
  - `chrome.<api>` for the fake Chrome API, for example `chrome.tabs.query`,
    `chrome.storage.local.get` or `chrome.sidePanel.open`.
  - `db.<table>[.<operation>[.<index>]]` for IndexedDB. The operation is one of Dexie's DBCore
    operations: `get`, `getMany`, `query`, `openCursor`, `count` or `mutate`. The index is `primary`
    or an index name. Examples: `db.highlights`, `db.meta.mutate`, `db.notes.query.primary`, `db.*`.
  - `*` in a target matches any run of characters.
- **Modes**
  - `error`: a retryable failure.
  - `unavailable`: `storage_unavailable` (IndexedDB broken), so no Retry button is offered.
  - `slow`: answers after 3 s. Not available for `db.*`, because an IndexedDB transaction cannot wait.
  - `hang`: never answers.

Examples:

- `popup.html?fault=site.status:hang` shows "Checking this tab…".
- `dashboard.html?fault=db.notes.query.primary:hang` shows the index building while the library still
  works.
- `options.html?fault=chrome.storage.local.get:error` shows "Could not read your settings".

## Other fakes

- **Navigation.** `tabs.create`, `tabs.update({url})`, `windows.create` and
  `runtime.openOptionsPage` open the matching gallery page in a new browser tab. The new tab keeps the
  current `scenario`, `theme` and `tab`, and it is named after the fake tab, so `tabs.update` reuses
  it. Web and `chrome://` addresses are only recorded: the gallery never loads a real site. `sidePanel.open`
  is only recorded.
- **Extension files.** `runtime.getURL('/x.html')` maps to `/pages/x.html`. Any other path maps to the
  repository's `public/` folder, which Vite serves at the root (`/ocr/`, `/icon/`), as in the built
  extension.
- **AI configured** (`fakes/ai.ts`). This turns AI on with sample settings:
  - a primary provider at `https://api.sample-ai.example/v1` and a fallback at
    `https://backup.sample-ai.example`, with sample keys and a routing rule;
  - a recorded spend, so the ledger has numbers.

  `window.fetch` is wrapped for those two origins only. Requests to them get canned answers that are
  clearly labelled as samples, cite the prompt's data blocks word for word, and pass the real
  validation: Test connection, chat (explain), exam pearl, summary, flashcards, multiple choice and
  memory aids. No request leaves the page.
- **Sync signed in** (`fakes/sync.ts`). The sync RPC is answered with canned status views through
  `gallery.answers`. A conflict is written to the real `syncConflicts` table.
- **Files** (`fakes/files.ts`):
  - a file input is filled the way the browser's file picker would fill it;
  - restore uses a backup of the seeded vault made by the real export, and two frozen fixtures from
    `packages/backup/src/fixtures`: an old-model backup and a protected one;
  - Anki text comes from the golden fixture;
  - `showDirectoryPicker` returns a real folder in the page's origin-private file system;
  - the PDF states use the password-protected PDF `fixtures/locked-notes.pdf` and a public-domain
    scanned PDF from `tests/fixtures/pdf/real`.

  `fixtures/locked-notes.pdf` is two pages with the password `gallery`. It was generated once with
  `buildPdf(proseFixture(2), { userPassword: 'gallery' })` from `packages/pdf/src/testing/pdfWriter.ts`.

## States (`catalog.json`)

`catalog.json` is the single list of surfaces, states and scenarios. `boot.ts`, the overview and
`capture.mjs` all read it. A state has these fields:

- `id` and `title`;
- `scenarios`, to use other scenarios than the surface's own;
- `query` and `hash`: address parameters, and this is where a fault goes;
- `fullPage`, for a whole-page shot;
- `viewport`, to use another size than the surface's (the narrow dashboard);
- `expectErrors: true` on a state that injects a fault.

A state that needs data or clicks also has a script in `states.ts`. Its `prepare` runs after seeding
and before mount, and its `run` drives the mounted page and waits for its result, so a missed click
fails loudly.

## Capture

```bash
node gallery/capture.mjs [--url http://localhost:5199] [--out .ci-artifacts/gallery] \
                         [--surface popup,sidepanel] [--scenario student] [--state default,check-error]
```

- Without `--url` it starts its own Vite server on port 5199. It runs `scripts/copy-ocr-assets.mjs`
  first when `public/ocr` is missing.
- It loads every surface × state × scenario one at a time in one Chromium, and shoots light and dark,
  plus the extra widths.
- It writes `<out>/<scenario>/<surface>[-<state>]-<theme>[-w<width>].png` and `<out>/report.json`. The
  report lists console errors and warnings, page errors and failed requests for each shot.
- A filtered run merges its entries into the existing report.
- It exits 1 when a shot:
  - has an uncaught page error;
  - did not reach its state;
  - rendered blank;
  - logged a console error in a state without `expectErrors`.

CI runs it as the advisory `gallery (screenshots)` job in `.github/workflows/ci.yml`.

## Not reachable here, and why

- **Crash screens** (each page's ErrorBoundary). Reaching one needs a render that throws. The real
  data paths validate every row first, and there is no seam for a throwing component without
  changing product code.
- **Overlay behaviour that belongs to the content-script controller.** The overlay page drives the real
  overlay UI through a stand-in for the controller. Stepping between highlights, deny-listed sites
  and refused selections live in that controller.
- **Anything that needs a real web page or server**:
  - the content script on a site: `captureSelection` always answers "no selection";
  - real sign-in (`identity.launchWebAuthFlow` rejects) and real sync progress;
  - PDF download progress and failures from a web address;
  - AI provider failures (401, 429, timeout): the fake provider only answers successfully;
  - browser downloads ("Create backup file" saves through the browser and is not shown).
- **States that are reachable but not in the catalog yet.** A fault or a script can reach them. They
  include the sync dialogs (sign out, delete server data), the timed-exam warnings, the PDF drop
  overlay and link dialog, the onboarding "could not open the side panel" error
  (`fault=chrome.sidePanel.open:error`), and most per-control save errors.

## Files

| Path                         | What it is                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `vite.config.ts`             | aliases, including `wxt/browser` pointing at the fake; the manifest define; `publicDir`       |
| `boot.ts`                    | page bootstrap: in-memory IndexedDB, fake chrome, faults, seeding, state script, real entrypoint |
| `shim/chrome.ts`             | the fake Chrome API                                                                           |
| `backend.ts`                 | the real background RPC handlers and sync RPC, served in the page; a stand-in content script |
| `faults.ts`                  | `?fault=` parsing, the RPC, Chrome and Dexie fault hooks                                      |
| `fakes/`                     | AI provider, sync status, files and folder picker                                             |
| `scenarios/`                 | seeded data                                                                                   |
| `catalog.json`, `catalog.ts` | surfaces, states and scenarios                                                                |
| `states.ts`, `dom.ts`        | state scripts and their DOM helpers                                                           |
| `index.html`, `index.tsx`    | overview                                                                                      |
| `overlay.tsx`, `pages/`      | one HTML document per surface                                                                 |
| `capture.mjs`                | the screenshot script                                                                         |
| `fixtures/`                  | `locked-notes.pdf`                                                                            |
| `mockups/`                   | redesign mockups (separate work)                                                              |
