# Chrome Web Store listing - StudyVault AI

Working copy of everything the Chrome Web Store dashboard asks for. Text here is written to be pasted
into the dashboard. Fields only the account owner can supply are marked `[USER-REQUIRED: ...]`;
`pnpm check:release-docs --strict` (run by release.yml for a `vX.Y.Z` tag) fails while any remain.

Each factual statement is traceable to code or a test in `docs/PRIVACY_CLAIMS.md`. The permission
table below must name every permission of the built manifest: `scripts/check-release-docs.mjs`
fails the build otherwise (see `ci.yml`, job `build`).

## Item details

| Field | Value |
| --- | --- |
| Name | StudyVault AI |
| Summary (max 132 characters) | Local-first study companion: highlight any page, save cited quotes into knowledge banks, review later. |
| Category | Productivity (sub-category Education, if the dashboard offers it; confirm the current name) |
| Language | English |
| Price | Free |
| Visibility | [USER-REQUIRED: public, unlisted or private for the first submission; unlisted is advisable] |
| Homepage URL | https://github.com/jerryboganda/studyvaultai |
| Support URL / email | [USER-REQUIRED: support email or issue tracker URL shown on the listing] |
| Privacy policy URL | [USER-REQUIRED: public URL of the hosted `PRIVACY_POLICY.md`] |
| Publisher / developer account | [USER-REQUIRED: Chrome Web Store developer account (one-time registration fee, 2-step verification, contact email verified)] |
| Store icon | `public/icon/128.png` (128 x 128, present) |

## Single purpose

> StudyVault AI lets you save cited highlights and notes from web pages and PDFs you choose,
> organise them into your own banks, and review them later. It works on your device without an
> account.

Everything in the extension serves that one purpose: capturing a passage with its source, finding it
again on the page, organising and searching what you saved, and studying it. The optional AI and sync
features operate only on the passages you saved and only after you switch them on.

## Description (paste into "Detailed description")

[USER-REQUIRED: remove any paragraph below whose feature is not in the build you submit. RELEASE.md
"Known limitations" lists what exists; do not describe anything that is not in the zip.]

```text
StudyVault AI turns the web pages and PDFs you read into a personal, searchable study library.
Select text, save it, and it is stored with its source so you can come back to the exact passage.

Everything stays on your device. There is no account, no analytics and no advertising. AI help and
cloud sync are optional, off by default, and explained before they do anything.

WHAT YOU CAN DO
- Select text on a page and save it from a small toolbar: one click, or choose a kind (essential fact,
  formula, exception, differential, weak area, correction, question).
- See your saved passages highlighted again when you return to the page, including on single-page
  sites. If a page changed so that a passage cannot be found with confidence, StudyVault says so
  instead of highlighting the wrong text.
- Keep notes beside any passage. Notes are typed in the side panel, never in the web page.
- Organise passages into banks, folders and tags; search them; export and back up your data.
- Open PDFs in StudyVault's own reader, highlight them and keep page-linked citations.
- Review what you saved with flashcards and spaced repetition that run on your device.
- Turn on optional AI help with your own API key. You see exactly what will be sent before it is
  sent, and AI output is always labelled as unverified.

PRIVACY AND CONTROL
- You decide where it runs: this tab only, one site, or all sites. Nothing runs anywhere else.
- A starter deny list switches it off on common sign-in, mail, payment and bank sites. Add your own.
- Delete all of your StudyVault data from Settings at any time.
- It does not read your browsing history and does not capture text typed into form fields.

ACCESSIBILITY
- Keyboard shortcuts for saving and for moving between highlights, labelled controls, light and dark
  themes, and highlights that do not rely on colour alone.

LIMITATIONS, STATED PLAINLY
- Chrome's built-in PDF viewer cannot be marked up by extensions. To highlight a PDF, open it in
  StudyVault's reader (from the popup or the side panel) or import the file.
- PDFs behind a sign-in cannot be fetched by the extension. Download the file and import it.
- Scanned PDFs have no text to select until OCR is run; OCR is slower and can make mistakes, which
  you can correct.
- It cannot run on chrome:// pages, the Chrome Web Store, or other pages Chrome protects, and it
  does not highlight text inside iframes or shadow DOM.
- AI output is a study aid. Verify it, especially medical and clinical content.
```

## Permission justifications (Privacy practices tab)

The manifest at the time of writing declares exactly the five permissions below, two optional host
patterns and two optional API permissions (`identity`, `alarms`, requested only when sync is turned on); `scripts/check-build.mjs` asserts the same set on every build. There is no
`host_permissions` entry, no `content_scripts` entry (scripts are injected or registered at run time),
no `web_accessible_resources` and no `externally_connectable`.

| Permission | Justification to paste |
| --- | --- |
| `activeTab` | StudyVault starts on a tab only when the user clicks its toolbar button, uses its keyboard shortcut or its right-click menu item. activeTab gives temporary access to that one tab so the selection toolbar can work without requesting access to any website at install time. |
| `scripting` | Used with activeTab to inject the extension's own bundled script (`content-scripts/highlighter.js`) into the tab the user chose, and to register that same bundled script for sites the user explicitly enabled so saved highlights reappear on later visits. No remote or generated code is ever executed. |
| `storage` | Stores the user's settings (theme, colours, deny list, enabled sites, optional-feature switches) and small change markers that let open StudyVault windows refresh. Saved highlights live in IndexedDB, not in this storage. |
| `sidePanel` | Shows the StudyVault companion panel (highlights of the current page, recent saves, banks, notes) beside the page. |
| `contextMenus` | Adds one item, "Save selection to StudyVault", to the right-click menu when text is selected on an http(s) page. |
| `identity` (optional permission) | Never granted at install. Requested at run time, from a click, only when the user turns on the optional sync feature and presses sign in. Used for `chrome.identity.launchWebAuthFlow` so the browser can open the sign-in page of the sync service the user configured and return the result. Not used by any other feature. |
| `alarms` (optional permission) | Never granted at install. Requested at run time only when the user turns on the optional sync feature. Used to schedule a periodic sync while the browser is open. No alarm is created while sync is off. |
| `https://*/*`, `http://*/*` (optional host permissions) | Never granted at install. Requested at run time, from a user gesture, only when the user chooses "always enable on this site" (one origin) or the explicit "all sites" option in Settings. Needed because activeTab access ends at navigation: without a persistent grant a saved highlight could not be shown again on the next visit. The deny list is applied as an exclusion, and every grant can be revoked in Settings. |

### Permissions deliberately not requested

`tabs`, `history`, `bookmarks`, `cookies`, `webRequest`, `webNavigation`, `downloads`, `notifications`,
`declarativeNetRequest`, `<all_urls>` and any `host_permissions`. (`identity` and `alarms` exist only as
*optional* permissions for the optional sync feature.)

### Permissions or changes to re-check before submission

The following were in progress when this file was written. If the build you submit changes the
manifest, update this table, `PRIVACY_POLICY.md` and `scripts/check-build.mjs` in the same change:

| Change | Why it matters | Status |
| --- | --- | --- |
| Reader fetches a web PDF from the extension page | Needs the PDF's origin granted (optional host permission requested at that moment) and a `connect-src` that allows it. | [USER-REQUIRED: confirm against `docs/adr/006` and the built manifest] |
| AI provider endpoint | Extension-page CSP is `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` (ADR-009) because the endpoint is user-chosen. Requires the feature flag, a consent token for the exact previewed payload, and a per-origin host permission requested from a click. | confirmed in `docs/adr/009`; [USER-REQUIRED: re-confirm against the submitted build] |
| Sync server endpoint | Same policy as above; stays off until the user enables sync and signs in; needs `identity` and `alarms` (optional) and a per-origin host permission. | confirmed in `docs/adr/009`; [USER-REQUIRED: re-confirm against the submitted build] |
| `downloads`, `notifications` | Listed in SECURITY_PRIVACY.md as optional when a feature needs them (file export, review reminders). Request only with the feature, never "just in case". | none requested today |

## Remote code

> **No, this extension does not use remote code.** All JavaScript, CSS, the PDF.js worker and the OCR
> assets are bundled in the package. The extension-pages content security policy is
> `script-src 'self' 'wasm-unsafe-eval'` (the second token lets the bundled OCR and PDF decoders
> compile their own WebAssembly modules; it does not permit `eval()` or `new Function()`, see
> docs/adr/008); the build fails on `unsafe-eval`, `unsafe-inline` or any `http(s):` source in
> it (`scripts/check-build.mjs`), and on remote `<script>`, `<link>`, `<img>` or `<iframe>` in any
> extension page. Network requests made by the optional AI and sync features carry data only; their
> responses are validated as JSON data and are never executed.

## Data usage disclosures (Privacy practices tab)

"Collect" below follows the dashboard's wording conservatively: StudyVault handles this data on the
device, and sends it elsewhere only through the optional features, after explicit opt-in.

| Dashboard category | Answer | Why |
| --- | --- | --- |
| Personally identifiable information | No | Not requested. A name or email may appear only inside text the user chooses to save, and stays on the device. |
| Health information | No | Not requested or inferred. Users may save study text about health; it is user content, handled as "Website content". |
| Financial and payment information | No | Not requested. Payment and bank sites are on the starter deny list. |
| Authentication information | No | Passwords and cookies are never read. The optional AI key and sync credentials are the user's own, stored locally. |
| Personal communications | No | Mail and chat sites are on the starter deny list; no messages are read. |
| Location | No | Not used. |
| Web history | Yes (conservative) | The address and title of a page are stored with each passage the user saves from it. The browser history is never read. |
| User activity | No | No clicks, keystrokes, scrolling or mouse positions are recorded. Review ratings the user gives flashcards are study data, stored locally. |
| Website content | Yes | The text the user selects (with a little surrounding context) is stored locally; it leaves the device only if the user turns on AI help (text they approved in a preview) or sync. |

Certifications (all three can be ticked):

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

[USER-REQUIRED: re-read the dashboard's current wording of these categories at submission time; it
changes. If you ship a hosted AI or sync service, the answers for "Authentication information" and
"Website content" must describe that service's handling as well.]

## Limited use statement

> The use of information received by StudyVault AI is limited to providing and improving its single
> purpose: saving cited highlights and notes from web pages and PDFs and helping the user review them.
> The data is not sold or transferred to third parties, except as part of an optional feature the user
> switches on (AI help sends text the user approved to the provider the user chose; sync sends the
> user's change log to the sync service the user chose). It is not used for personalised advertising,
> credit decisions or any unrelated purpose, and no person reads it.

## Screenshots

The store takes 1 to 5 screenshots at 1280 x 800 or 640 x 400, JPEG or 24-bit PNG without alpha.
`tests/e2e/screenshots.spec.ts` produces real pictures of the loaded extension on every CI run
(`gh run download <run-id> -n screenshots-ubuntu-latest`); page shots are already 1280 x 800. Panel
and popup shots are narrower and need composing onto a 1280 x 800 canvas, and PNGs may carry an alpha
channel that the store rejects: flatten them.

| # | File in the artifact | Shows | Caption to use |
| --- | --- | --- | --- |
| 1 | `01-toolbar-over-article.png` | Toolbar above a selected paragraph | Save any passage in one click |
| 2 | `04-saved-toast-and-highlight.png` | Passage highlighted after saving, with Undo | Your highlights come back when you return |
| 3 | `05-note-handover-side-panel.png` | Side panel with the note field focused | Notes are typed in the side panel, never in the page |
| 4 | `06-sidepanel-tab-1-this-page.png` | Side panel, highlights of this page | Everything you saved, with its source |
| 5 | `14-dark-side-panel.png` | Side panel in dark mode | Light and dark themes |
| spare | `11-options-privacy.png`, `09-popup-running.png` | Privacy section; popup | Clear privacy controls |

The exact file names, sizes and a description of every picture are in `manifest.json` next to the
PNGs. [USER-REQUIRED: choose and compose the final screenshots, and review them against the shipped
build; the list above names the files that exist at the time of writing.]
Optional: small promo tile 440 x 280 and marquee 1400 x 560 (not generated;
[USER-REQUIRED: design assets if wanted]).

## PDF limitations (also in the description and in the extension)

- Chrome's built-in PDF viewer is a protected browser context. Extensions cannot read selections in it
  or draw on it, and StudyVault does not claim to. Chrome's own PDF annotations are not accessible to
  extensions either.
- StudyVault's own reader (an extension page using a bundled PDF.js) is the supported way to highlight
  PDFs: open a PDF there from the popup or side panel, or import a file. Files up to 300 MB are
  accepted.
- A PDF that needs a sign-in or cookies cannot be fetched, because the extension fetches web PDFs
  without cookies or stored credentials. It says so and asks you to import the file instead.
- A scanned PDF has no selectable text. OCR can add it; recognition runs on the device, is slow on
  long documents and can be wrong. Results can be corrected, and corrected text is kept apart from the
  original recognition.
- `file://` PDFs open only through the file picker or drag and drop; StudyVault does not need the
  "Allow access to file URLs" switch for that.

## Keywords and discovery

The store has no keyword field; ranking uses the name, summary and description. Terms worth keeping
in the text: study, highlighter, annotations, flashcards, spaced repetition, PDF, notes, citations,
exam, local-first, privacy, offline.

## Submission checklist

1. `pnpm check:release-docs --strict` passes (no `[USER-REQUIRED: ...]` marker left in this file or the policy).
2. Privacy policy hosted at the URL entered above, and linked from the extension's Settings page.
3. Zip from the draft GitHub release (`studyvault-ai-<version>-chrome.zip`); its SHA-256 matches
   `SHA256SUMS`.
4. Permission justifications, remote-code answer and data-usage answers pasted from this file.
5. Screenshots composed and uploaded; icon 128 x 128.
6. Manual checks in `docs/MANUAL_TEST_CHECKLIST.md` filled in for this build (Chrome and Edge).
7. Submit for review; choose staged or deferred publishing so the release can be paused.
