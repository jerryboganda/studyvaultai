# Chrome Web Store listing - StudyVault AI

> **DRAFT: describes intended behaviour; not for publication until every docs/PRIVACY_CLAIMS.md row it depends on is `verified`.**
>
> Revised 2026-10-11 (second pass, after the backup and import, PDF reader, deletion, search index,
> database lifecycle and sync hardening changes). Nothing below may be pasted into the dashboard
> while a row it depends on is `in progress`, `unit-only`, `open` or `fix in progress` in
> `docs/PRIVACY_CLAIMS.md`. On that date every completed `ci.yml` run had concluded `failure`,
> `release.yml` had never run, no CI run had executed the hardening changes, and the manual
> checklist (`docs/MANUAL_TEST_CHECKLIST.md`) had not been run.

Working copy of everything the Chrome Web Store dashboard asks for. Text here is written to be pasted
into the dashboard. Fields only the account owner can supply carry a bracketed USER-REQUIRED marker;
`pnpm check:release-docs --strict` (run by release.yml for a `vX.Y.Z` tag) fails while any remain.

Each factual statement is meant to be traceable to code or a test in `docs/PRIVACY_CLAIMS.md`, which
also records which ones are not verified yet. The permission table below must name every permission
of the built manifest: `scripts/check-release-docs.mjs` fails the build otherwise (see `ci.yml`, job
`build`).

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
again on the page, organising and searching what you saved, and studying it. The optional AI help
operates only on passages you select and approve, and optional sync only on what you saved, and
both only after you switch them on.

## Description (paste into "Detailed description")

[USER-REQUIRED: remove any paragraph below whose feature is not in the build you submit. RELEASE.md
"Known limitations" lists what exists; do not describe anything that is not in the zip.]

```text
StudyVault AI turns the web pages and PDFs you read into a personal, searchable study library.
Select text, save it, and it is stored with its source so you can come back to the exact passage.

Your study library stays on your device. There is no account, no analytics and no advertising.
Optional AI help and optional sync with a server you operate (advanced) are off by default and
explained before they do anything. Opening a PDF from a web address downloads it directly from that
site.

WHAT YOU CAN DO
- Select text on a page and save it from a small toolbar: one click, or choose a kind (essential fact,
  formula, exception, differential, weak area, correction, question).
- See your saved passages highlighted again when you return to the page, including on single-page
  sites. If a page changed so that a passage cannot be found with confidence, StudyVault says so
  instead of highlighting the wrong text.
- Keep notes beside any passage. Notes are typed in the side panel, never in the web page.
- Organise passages into banks, folders and tags; search them; export your data and back it up
  (a backup holds your study data, not your settings, AI key or sync sign-in).
- Open PDFs in StudyVault's own reader, highlight them and keep page-linked citations.
- Review what you saved with flashcards and spaced repetition that run on your device.
- Turn on optional AI help with your own API key. You see exactly what will be sent before it is
  sent, and AI output is always labelled as unverified.
- Advanced and optional: sync between your own devices through a sync server that you operate. You
  supply the server address, an OpenID Connect sign-in provider and a client id; there is no hosted
  StudyVault service. Off by default.

PRIVACY AND CONTROL
- You decide where it runs: this tab only, one site, or all sites. Nothing runs anywhere else.
- A starter deny list switches it off on common sign-in, mail, payment and bank sites. Add your own.
- Delete all of your StudyVault data from Settings at any time (a copy on a sync server is deleted
  separately).
- The PDF reader saves nothing from a private window unless you allow it, and gives back the site
  access it asked for once a download is over.
- It does not read your browsing history and does not capture text typed into form fields.

ACCESSIBILITY
- Keyboard shortcuts for saving and for moving between highlights, labelled controls, light and dark
  themes, and highlights that do not rely on colour alone.

LIMITATIONS, STATED PLAINLY
- Chrome's built-in PDF viewer cannot be marked up by extensions. To highlight a PDF, open it in
  StudyVault's reader (from the popup or the side panel) or import the file.
- PDFs behind a sign-in cannot be fetched by the extension. Download the file and import it.
- Sync needs a server that you operate or trust. Nothing is uploaded until you either set a sync
  passphrase or explicitly choose to upload without encryption; without a passphrase, whoever runs
  that server can read what you sync. Settings and the AI key are not synced or backed up.
- Scanned PDFs have no text to select until OCR is run; OCR is slower and can make mistakes, which
  you can correct.
- It cannot run on chrome:// pages, the Chrome Web Store, or other pages Chrome protects, and it
  does not highlight text inside iframes or shadow DOM.
- AI output is a study aid. Verify it, especially medical and clinical content.
```

## Permission justifications (Privacy practices tab)

The manifest at the time of writing declares exactly the five permissions below, two optional host
patterns and two optional API permissions (`identity`, `alarms`, requested when the user presses
"Turn on sync", not at install). There is no `host_permissions` entry, no `content_scripts` entry
(scripts are injected or registered at run time), no `web_accessible_resources` and no
`externally_connectable`.

What guards this on every build: `scripts/check-build.mjs` asserts the install-time permissions, the
two optional host patterns, the commands, the extension-pages CSP and the absence of the entries
above. As of 2026-10-11 the committed script did not assert `optional_permissions`; the working tree
adds a pin to exactly `alarms,identity` (and a directive-by-directive CSP table), which has not yet
run in CI. Independently, `scripts/check-release-docs.mjs` fails when any declared permission,
optional ones included, is missing from this file or from `PRIVACY_POLICY.md`.

| Permission | Justification to paste |
| --- | --- |
| `activeTab` | StudyVault starts on a tab only when the user clicks its toolbar button, uses its keyboard shortcut or its right-click menu item. activeTab gives temporary access to that one tab so the selection toolbar can work without requesting access to any website at install time. |
| `scripting` | Used with activeTab to inject the extension's own bundled script (`content-scripts/highlighter.js`) into the tab the user chose, and to register that same bundled script for sites the user explicitly enabled so saved highlights reappear on later visits. No remote or generated code is ever executed. |
| `storage` | Stores the user's settings (theme, colours, deny list, enabled sites, optional-feature switches, study-day settings, welcome-tour progress), small change markers that let open StudyVault windows refresh and, in its memory-only session area, sync sign-in tokens and, while unlocked, the sync encryption key. Saved highlights, the sync server and sign-in provider addresses and a second, authoritative copy of the settings live in IndexedDB, not in this storage. |
| `sidePanel` | Shows the StudyVault companion panel (highlights of the current page, recent saves, banks, notes) beside the page. |
| `contextMenus` | Adds three right-click items: "Save selection to StudyVault" when text is selected on an http(s) page, and two "Open in StudyVault reader" items (one for links, one for pages and frames) that appear only when the address looks like a PDF, so the user can open it in the extension's own reader. |
| `identity` (optional permission) | Never granted at install. Requested at run time, from the click on "Turn on sync" in Settings (together with `alarms` and access to the sync server and sign-in provider), only when the user turns on the optional sync feature. Used for `chrome.identity.launchWebAuthFlow` so the browser can open the sign-in page of the sign-in provider the user configured and return the result. Not used by any other feature. |
| `alarms` (optional permission) | Never granted at install. Requested at run time from the same "Turn on sync" click. Used to schedule a periodic sync (every 15 minutes) while the browser is open. No alarm is created while sync is off. |
| `https://*/*`, `http://*/*` (optional host permissions) | Never granted at install. Requested at run time, one origin at a time, from a user gesture, for four separate purposes: (1) the user chooses "always enable on this site" or the explicit "all sites" option in Settings (needed because activeTab access ends at navigation: without a persistent grant a saved highlight could not be shown again on the next visit; the deny list is applied as an exclusion; this is the only grant that lets the page script start by itself); (2) the user opens a PDF from a web address in the reader, which downloads it from that site (and reads it from a different site the address redirects to, only if the user allows it); this access is handed back when the download ends, successful or not, unless the user already had access to that site for another reason; (3) the user enters an AI provider address and uses AI help; (4) the user turns on sync, for the sync server, the sign-in provider and the provider's token and revocation endpoints. Grants (2) to (4) are used only for requests the extension itself makes and never start the page script. Grants for (1) and the AI address can be removed in Settings; grant (4) has no list in Settings; all can be removed on Chrome's extension page, and "Delete all StudyVault data" removes every one. |

### Permissions deliberately not requested

`tabs`, `history`, `bookmarks`, `cookies`, `webRequest`, `webNavigation`, `downloads`, `notifications`,
`declarativeNetRequest`, `<all_urls>` and any `host_permissions`. (`identity` and `alarms` exist only as
*optional* permissions for the optional sync feature.)

### Permissions or changes to re-check before submission

The following were new or changed in the working tree when this file was written and have not been
checked in a loaded build. If the build you submit changes the manifest, update this table,
`PRIVACY_POLICY.md` and `scripts/check-build.mjs` in the same change:

| Change | Why it matters | Status |
| --- | --- | --- |
| Reader fetches a web PDF from the extension page (a third user-initiated network path beside AI and sync) | Needs the PDF's origin granted (optional host permission requested from a click, or already granted) and a `connect-src` that allows it. The host sees the user's IP address and the PDF address; the request omits credentials and the referrer (`packages/pdf/src/source.ts`, `entrypoints/pdf-reader/Reader.tsx`). The access is handed back when the download ends unless the user already had it (`packages/pdf/src/grant.ts`); a redirect to another site is read only if the user allows that site (`source.ts`, failure kind `redirect-needs-access`); in a private window, or one that cannot be identified, the reader stores nothing unless "Save from private windows" is on (`entrypoints/pdf-reader/privacy.ts`, `packages/storage/src/pdf.ts`). | confirmed in code and `docs/adr/006`, `docs/adr/009`; hand-back, redirect rule and private-window rule are unit-tested (`docs/PRIVACY_CLAIMS.md` P1a, P1c, P1d, P10a); e2e specs exist but are unproven in CI; [USER-REQUIRED: re-confirm against the built manifest and the submitted build] |
| AI provider endpoint | Extension-page CSP is `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` (ADR-009) because the endpoint is user-chosen; this CSP does not itself stop a request, the feature switch, the consent token and the per-origin grant do. Requires the feature flag, a consent token for the exact previewed payload, and a per-origin host permission requested from a click. | confirmed in `docs/adr/009`; [USER-REQUIRED: re-confirm against the submitted build] |
| Sync server, sign-in provider and its token and revocation endpoints | Same CSP; stays off until the user enables sync and signs in, and uploads nothing until the user chooses a passphrase or explicitly chooses to upload without encryption; needs `identity` and `alarms` (optional, requested at "Turn on sync") and a per-origin host permission for each origin. | confirmed in `docs/adr/009`, `docs/adr/010`; first-upload gate and key custody are unit and integration tested (`docs/PRIVACY_CLAIMS.md` P25a, P25b), unproven in CI; [USER-REQUIRED: re-confirm against the submitted build] |
| Optional API permissions pinned by the build gate | `scripts/check-build.mjs` pins `optional_permissions` to `alarms,identity` in the working tree; the committed script did not. | in the working tree; unproven until a CI run passes it |
| `downloads`, `notifications` | Listed in SECURITY_PRIVACY.md as optional when a feature needs them (file export, review reminders). Request only with the feature, never "just in case". | none requested today |

## Remote code

> **No, this extension does not use remote code.** All JavaScript, CSS, the PDF.js worker and the OCR
> assets are bundled in the package. The extension-pages content security policy is
> `script-src 'self' 'wasm-unsafe-eval'` (the second token lets the bundled OCR and PDF decoders
> compile their own WebAssembly modules; it does not permit `eval()` or `new Function()`, see
> docs/adr/008); the build fails on `unsafe-eval`, `unsafe-inline` or any `http(s):` source in
> it (`scripts/check-build.mjs`), and on remote `<script>`, `<link>`, `<img>` or `<iframe>` in any
> extension page. The three user-initiated network paths (the reader downloading a PDF, optional AI
> help and optional sync) return data only: JSON that is validated against a schema, or PDF bytes
> parsed by the bundled PDF.js with PDF scripting disabled. Nothing that is fetched is executed.

## Data usage disclosures (Privacy practices tab)

"Collect" below follows the dashboard's wording conservatively: StudyVault handles this data on the
device, and sends it elsewhere only through the optional features (and the reader's PDF download,
which sends no study data), after an explicit action by the user.

| Dashboard category | Answer | Why |
| --- | --- | --- |
| Personally identifiable information | Yes (conservative; only when sync is on) | Not requested. A name or email may appear inside text the user chooses to save, and stays on the device unless the user turns on AI help or sync. With sync on, the sign-in provider's account identifier is held in session storage, shown in Settings, and sent to the sync server the user configured as part of the sign-in token. [USER-REQUIRED: owner to confirm this reading of the dashboard's wording] |
| Health information | No | Not requested or inferred. Users may save study text about health; it is user content, handled as "Website content". |
| Financial and payment information | No | Not requested. Payment and bank sites are on the starter deny list. |
| Authentication information | Yes (conservative) | Passwords and cookies are never read. The user may enter an AI provider API key (stored on the device in the extension's database, without extra encryption, never in backups, exports or sync) and, with sync on, signs in to a provider the user configured (tokens kept in browser session storage, tied to the server, provider and client id they were issued for; the sync encryption key, derived from the user's passphrase, is held there too for at most 15 minutes and never leaves the device). These credentials never leave the device except to the endpoint the user configured: the key to the AI provider address, the tokens to the sync server and the sign-in provider. |
| Personal communications | No | Mail and chat sites are on the starter deny list; no messages are read. |
| Location | No | Not used. |
| Web history | Yes (conservative) | The address and title of a page are stored with each passage the user saves from it (and the address a PDF was downloaded from). The browser history is never read. |
| User activity | No | No clicks, keystrokes, scrolling or mouse positions are recorded. Review ratings the user gives flashcards are study data, stored locally (and synced only if the user turns sync on). |
| Website content | Yes | The text the user selects (with a little surrounding context) is stored locally; it leaves the device only if the user turns on AI help (text they approved in a preview) or sync (readable by the sync server's operator unless the user sets a passphrase; nothing is uploaded until the user chooses a passphrase or explicitly chooses to upload without encryption, see `PRIVACY_POLICY.md`). Opening a web PDF requests the file from its host and sends it nothing of the user's. |

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
> The data is not sold or transferred to third parties, except as part of a feature the user uses
> (the reader requests a web PDF from the site that hosts it, which receives none of the user's study
> data; AI help sends text the user approved to the provider the user chose; sync sends the user's
> change log to the sync server the user chose and signs in through the provider the user chose).
> It is not used for personalised advertising, credit decisions or any unrelated purpose, and no
> person reads it.

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
- Opening a PDF from a web address is a network request made by the extension page: the host sees
  your IP address and the PDF's address (no cookies, no referrer), and the reader first asks Chrome
  for access to that one site and gives that access back when the download ends, unless you already
  had it. If the address redirects to another site, the browser follows it, but the reader reads the
  file from that site only if you allow it. Nothing of yours is uploaded.
- In a private window (or one the reader cannot identify) the reader opens and shows the PDF but
  stores nothing (no document record, highlights, recognised text or kept copy) unless "Save from
  private windows" is on.
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

0. Every `docs/PRIVACY_CLAIMS.md` row that this file and the policy depend on is `verified`, with a
   green `ci.yml` run URL recorded, and the DRAFT banners are removed from both documents.
1. `pnpm check:release-docs --strict` passes (no bracketed USER-REQUIRED marker left in this file or the policy).
2. Privacy policy hosted at the URL entered above, and linked from the extension's Settings page.
3. Zip from the draft GitHub release (`studyvault-ai-<version>-chrome.zip`); its SHA-256 matches
   `SHA256SUMS`.
4. Permission justifications, remote-code answer and data-usage answers pasted from this file.
5. Screenshots composed and uploaded; icon 128 x 128.
6. Manual checks in `docs/MANUAL_TEST_CHECKLIST.md` filled in for this build (Chrome and Edge).
7. Submit for review; choose staged or deferred publishing so the release can be paused.
