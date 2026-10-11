# Chrome Web Store listing - StudyVault AI

> **DRAFT: describes intended behaviour; not for publication until every docs/PRIVACY_CLAIMS.md row it depends on is `verified`.**
>
> Revised 2026-10-11 (second pass, after the backup and import, PDF reader, deletion, search index,
> database lifecycle and sync hardening changes). Nothing below may be pasted into the dashboard
> while a row it depends on is `in progress`, `unit-only`, `open` or `fix in progress` in
> `docs/PRIVACY_CLAIMS.md`. When this was first written every completed `ci.yml` run had concluded
> `failure`; run 38139836238 (https://github.com/jerryboganda/studyvaultai/actions/runs/38139836238, commit `d641515b1154aa46597e7ebb069d2341014c125c`) is the first in which every
> job succeeded (`docs/PRIVACY_CLAIMS.md` says what it does and does not back). `release.yml` has
> never run and the manual checklist (`docs/MANUAL_TEST_CHECKLIST.md`) has not been run.
>
> Revised 2026-10-12 for the finish wave (ADR-011 to ADR-020, `docs/PRIVACY_CLAIMS.md` rows P20a to
> P20c, P26j, P33 to P44, S17, S18): the description gained the new features and their limits, the
> `alarms` justification now covers reminders as well as sync, and the file-system note was added.
> The manifest did not change. No run of the branch that holds the wave has concluded `success`, so
> every statement about those features is `unit-only` with its e2e spec not yet run in CI; run 38139836238
> predates them.
>
> Revised 2026-10-12 (second pass): run 38173629818
> (https://github.com/jerryboganda/studyvaultai/actions/runs/38173629818, commit
> `79d8cbc38111bfcde0e621f37d4795fd3f38e736`, branch `feat/finish-all`) concluded `success` in
> every job and executed the loaded-extension specs of the finish wave in Playwright's bundled
> Chromium on Ubuntu and Windows, which supersedes the sentence above that no run had.
> `docs/PRIVACY_CLAIMS.md` records which statements that run backs and which it does not
> (branded Chrome or Edge, a real incognito window, Chrome's prompts and folder picker, a hosted
> sign-in provider, a screen reader, the Web Store review); its rows still name unit-only or
> manual parts, so this listing is still a draft. This revision adds one sentence about links
> inside a PDF to the description and to "PDF limitations" (open item U-23).

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
again on the page, organising and searching what you saved (banks, tags, filing rules, links, a
syllabus), and studying it (flashcards, exam practice, reminders). The optional AI help
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
- Review what you saved with flashcards and spaced repetition that run on your device. Optionally
  show the number of cards due on the toolbar icon and get a daily reminder notice inside StudyVault
  (no system notifications).
- Practise a timed exam from your own cards: no feedback until the end, your own marking of recall
  questions, a score by bank and tag, and the questions you missed with a link to their source. An
  exam does not change your review schedule unless you ask it to.
- Outline an exam or course as a syllabus, map each topic to your banks and tags, and see how much
  material and review each topic has. Nothing is guessed from text: coverage is what you mapped.
- File new highlights with rules you write (for example, everything from one site into one bank). A
  rule asks first unless you tell it not to, and every filing can be undone.
- Draw links between highlights, notes and knowledge points, see them as a graph that also comes as a
  table, and see which of your other highlights share words with the one you are reading.
- Import Word (.docx), PowerPoint (.pptx), EPUB, HTML and Anki plain-text exports. Files are read on
  your device and you see what was found before anything is saved.
- Back up into a folder you choose: dated files, each read back and checked, with a reminder when
  it is time. A backup starts when you press the button.
- Write TeX in notes (such as $E = mc^2$). It is kept exactly as typed and shown as source text.
- Turn on optional AI help with your own API key, and optionally fallback providers. You see exactly
  what will be sent, and to which addresses, before it is sent, and AI output is always labelled as
  unverified. You can also ask questions of your own notes: the passages are found on your device and
  you choose which of them are sent.
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
- Links inside a PDF that point to a web address open only after you confirm the full address
  in the reader (unless you chose "Always allow this site" in that reader tab), in a new tab;
  StudyVault makes no request for a link itself, and mail, script and file links are not
  opened.
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
- TeX in notes is shown as text, not typeset.
- A backup into a folder starts only when you press the button; StudyVault cannot back up in the
  background. Reminders appear only while the browser is running and are not system notifications.
- Imports read .docx, .pptx, EPUB, HTML and Anki plain-text exports. Anki .apkg packages, old .doc
  and .ppt files and password-protected or DRM-protected files are refused; images, footnotes,
  comments and speaker notes are not imported.
- "Related" finds highlights that share words; there is no search by meaning.
- Not built: shared or collaborative banks, calendar or cloud-drive sync, YouTube captions, image
  occlusion and a reading view.
```

## Permission justifications (Privacy practices tab)

The manifest at the time of writing declares exactly the five permissions below, two optional host
patterns and two optional API permissions (`identity`, requested when the user presses "Turn on
sync"; `alarms`, requested by that click and by the click that saves a daily study-reminder time;
neither at install). There is no `host_permissions` entry, no `content_scripts` entry
(scripts are injected or registered at run time), no `web_accessible_resources` and no
`externally_connectable`.

What guards this on every build: `scripts/check-build.mjs` asserts the install-time permissions, the
two optional host patterns, the commands, the extension-pages CSP and the absence of the entries
above. As of 2026-10-11 the committed script did not assert `optional_permissions`; the working tree
adds a pin to exactly `alarms,identity` (and a directive-by-directive CSP table), which passed in the
`build` job of run 38139836238. Independently, `scripts/check-release-docs.mjs` fails when any declared permission,
optional ones included, is missing from this file or from `PRIVACY_POLICY.md`.

| Permission | Justification to paste |
| --- | --- |
| `activeTab` | StudyVault starts on a tab only when the user clicks its toolbar button, uses its keyboard shortcut or its right-click menu item. activeTab gives temporary access to that one tab so the selection toolbar can work without requesting access to any website at install time. |
| `scripting` | Used with activeTab to inject the extension's own bundled script (`content-scripts/highlighter.js`) into the tab the user chose, and to register that same bundled script for sites the user explicitly enabled so saved highlights reappear on later visits. No remote or generated code is ever executed. |
| `storage` | Stores the user's settings (theme, colours, deny list, enabled sites, optional-feature switches, study-day settings, welcome-tour progress), small change markers that let open StudyVault windows refresh and, in its memory-only session area, sync sign-in tokens and, while unlocked, the sync encryption key. Saved highlights, the sync server and sign-in provider addresses and a second, authoritative copy of the settings live in IndexedDB, not in this storage. |
| `sidePanel` | Shows the StudyVault companion panel (highlights of the current page, recent saves, banks, notes) beside the page. |
| `contextMenus` | Adds three right-click items: "Save selection to StudyVault" when text is selected on an http(s) page, and two "Open in StudyVault reader" items (one for links, one for pages and frames) that appear only when the address looks like a PDF, so the user can open it in the extension's own reader. |
| `identity` (optional permission) | Never granted at install. Requested at run time, from the click on "Turn on sync" in Settings (together with `alarms` and access to the sync server and sign-in provider), only when the user turns on the optional sync feature. Used for `chrome.identity.launchWebAuthFlow` so the browser can open the sign-in page of the sign-in provider the user configured and return the result. Not used by any other feature. |
| `alarms` (optional permission) | Never granted at install. Requested at run time, from a user click, for two optional features: the "Turn on sync" click (used to schedule a periodic sync, every 15 minutes, while the browser is open) and the click that saves a daily study-reminder time in Settings, Review (used to schedule one alarm per day at that time, so a reminder notice can be shown inside the extension's popup and side panel). No alarm is created while both features are off. Without the permission the reminder's toolbar count still works and only the daily time is idle. Not used by any other feature. |
| `https://*/*`, `http://*/*` (optional host permissions) | Never granted at install. Requested at run time, one origin at a time, from a user gesture, for four separate purposes: (1) the user chooses "always enable on this site" or the explicit "all sites" option in Settings (needed because activeTab access ends at navigation: without a persistent grant a saved highlight could not be shown again on the next visit; the deny list is applied as an exclusion; this is the only grant that lets the page script start by itself); (2) the user opens a PDF from a web address in the reader, which downloads it from that site (and reads it from a different site the address redirects to, only if the user allows it); this access is handed back when the download ends, successful or not, unless the user already had access to that site for another reason; (3) the user enters an AI provider address and uses AI help (and, when the user has added fallback providers, each fallback's address, requested with the others in one prompt from the same click); (4) the user turns on sync, for the sync server, the sign-in provider and the provider's token and revocation endpoints. Grants (2) to (4) are used only for requests the extension itself makes and never start the page script. Grants for (1) and the AI address can be removed in Settings; grant (4) has no list in Settings; all can be removed on Chrome's extension page, and "Delete all StudyVault data" removes every one. |

### Permissions deliberately not requested

`tabs`, `history`, `bookmarks`, `cookies`, `webRequest`, `webNavigation`, `downloads`, `notifications`,
`declarativeNetRequest`, `<all_urls>` and any `host_permissions`. (`identity` and `alarms` exist only as
*optional* permissions: `identity` for the optional sync feature, `alarms` for sync and for the optional
daily study reminder.) `notifications` is not requested: reminders are a toolbar count and a notice
inside the extension's own popup and side panel, never a system notification.

### File access for backups (no manifest permission)

Backing up into a folder uses the File System Access API from the settings page
(`showDirectoryPicker`, called from the user's click). The permission is Chrome's own per-folder grant,
shown by Chrome when the user picks the folder: it covers that one folder, can be removed in Chrome's
site settings for the extension, and is asked for again from the next click if Chrome lets it lapse.
Nothing is added to the manifest and `scripts/check-build.mjs` still pins the permission lists.
Nothing runs in the background: the extension cannot write to the folder without a click, and the
interval the user sets only decides when a notice reminds them. Where the browser has no folder
picker the settings page says so and the ordinary download stays. There is nothing to paste into the
dashboard for this.

### Permissions or changes to re-check before submission

The following were new or changed in the working tree when this file was written and have not been
checked in a loaded build. If the build you submit changes the manifest, update this table,
`PRIVACY_POLICY.md` and `scripts/check-build.mjs` in the same change:

| Change | Why it matters | Status |
| --- | --- | --- |
| Reader fetches a web PDF from the extension page (a third user-initiated network path beside AI and sync) | Needs the PDF's origin granted (optional host permission requested from a click, or already granted) and a `connect-src` that allows it. The host sees the user's IP address and the PDF address; the request omits credentials and the referrer (`packages/pdf/src/source.ts`, `entrypoints/pdf-reader/Reader.tsx`). The access is handed back when the download ends unless the user already had it (`packages/pdf/src/grant.ts`); a redirect to another site is read only if the user allows that site (`source.ts`, failure kind `redirect-needs-access`); in a private window, or one that cannot be identified, the reader stores nothing unless "Save from private windows" is on (`entrypoints/pdf-reader/privacy.ts`, `packages/storage/src/pdf.ts`). | confirmed in code and `docs/adr/006`, `docs/adr/009`; hand-back, redirect rule and private-window rule are unit-tested (`docs/PRIVACY_CLAIMS.md` P1a, P1c, P1d, P10a); loaded-extension e2e specs for the fetch, the redirect and the private-tab reader passed in run 38139836238 (a real incognito window and Chrome's permission prompt are not driven); [USER-REQUIRED: re-confirm against the built manifest and the submitted build] |
| AI provider endpoint | Extension-page CSP is `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` (ADR-009) because the endpoint is user-chosen; this CSP does not itself stop a request, the feature switch, the consent token and the per-origin grant do. Requires the feature flag, a consent token for the exact previewed payload, and a per-origin host permission requested from a click. | confirmed in `docs/adr/009`; [USER-REQUIRED: re-confirm against the submitted build] |
| Sync server, sign-in provider and its token and revocation endpoints | Same CSP; stays off until the user enables sync and signs in, and uploads nothing until the user chooses a passphrase or explicitly chooses to upload without encryption; needs `identity` and `alarms` (optional, requested at "Turn on sync") and a per-origin host permission for each origin. | confirmed in `docs/adr/009`, `docs/adr/010`; first-upload gate and key custody are unit and integration tested and passed loaded-extension e2e specs against the reference server and a stand-in provider in run 38139836238 (`docs/PRIVACY_CLAIMS.md` P25a, P25b); [USER-REQUIRED: re-confirm against the submitted build] |
| Optional API permissions pinned by the build gate | `scripts/check-build.mjs` pins `optional_permissions` to `alarms,identity` in the working tree; the committed script did not. | pinned by `scripts/check-build.mjs`, which passed in the `build` job of run 38139836238, and asserted against the production build in `permissions.spec.ts` |
| `downloads`, `notifications` | Listed in SECURITY_PRIVACY.md as optional when a feature needs them (file export, review reminders). Request only with the feature, never "just in case". | none requested today: exports are client-side Blob downloads, and reminders (ADR-019) use the toolbar count and an in-extension notice |
| `alarms` also requested by the reminder time (finish wave) | A second control asks for the same optional permission; the justification above and `PRIVACY_POLICY.md` name both. The manifest is unchanged, so `scripts/check-release-docs.mjs` has nothing new to fail on and cannot catch a text that is out of date | confirmed in `entrypoints/options/Reminders.tsx` and `docs/adr/019-reminders.md`; unit-tested (`Reminders.test.tsx` "asks for the timer permission from the click that saves a time, then saves it"); `tests/e2e/reminders.spec.ts` written, not yet run in CI (`docs/PRIVACY_CLAIMS.md` P30, P35); [USER-REQUIRED: re-confirm against the submitted build] |
| Fallback AI providers (finish wave) | Up to three more provider addresses can receive the same approved text, only after the one before did not answer; the consent hash covers the list and one prompt asks for every origin. Same CSP and per-origin grant as the single provider; no new permission | confirmed in `docs/adr/013-ai-router-and-tasks.md`; unit-tested (`router.test.ts`, `ai-router-ui.test.tsx`; `docs/PRIVACY_CLAIMS.md` P20a); `ai-extras.spec.ts` written, not yet run in CI; Chrome's prompt for the second origin is not driven (MT-60); [USER-REQUIRED: re-confirm against the submitted build] |
| Backup folder (finish wave) | Chrome's File System Access grant, not a manifest permission; writes only from a click; `showDirectoryPicker` does not exist in every browser and the page says so | confirmed in `docs/adr/016-backup-folder.md`; unit-tested (`folder.test.ts`, `backupFolder.test.tsx`; P26h, P26i); `backup-folder.spec.ts` replaces the picker with an OPFS directory and is not yet run in CI; the real folder prompt on a real disk is MT-54 |

## Remote code

> **No, this extension does not use remote code.** All JavaScript, CSS, the PDF.js worker and the OCR
> assets are bundled in the package. The extension-pages content security policy is
> `script-src 'self' 'wasm-unsafe-eval'` (the second token lets the bundled OCR and PDF decoders
> compile their own WebAssembly modules; it does not permit `eval()` or `new Function()`, see
> docs/adr/008); the build fails on `unsafe-eval`, `unsafe-inline` or any `http(s):` source in
> it (`scripts/check-build.mjs`), and on remote `<script>`, `<link>`, `<img>` or `<iframe>` in any
> extension page. The three user-initiated network paths (the reader downloading a PDF, optional AI
> help and optional sync) return data only: JSON that is validated against a schema, or PDF bytes
> parsed by the bundled PDF.js with PDF scripting disabled. Nothing that is fetched is executed. Files
> the user imports (Word, PowerPoint, EPUB, HTML, Anki text) are read as inert text by the extension's
> own code and are never executed or fetched from.

## Data usage disclosures (Privacy practices tab)

"Collect" below follows the dashboard's wording conservatively: StudyVault handles this data on the
device, and sends it elsewhere only through the optional features (and the reader's PDF download,
which sends no study data), after an explicit action by the user.

| Dashboard category | Answer | Why |
| --- | --- | --- |
| Personally identifiable information | Yes (conservative; only when sync is on) | Not requested. A name or email may appear inside text the user chooses to save, and stays on the device unless the user turns on AI help or sync. With sync on, the sign-in provider's account identifier is held in session storage, shown in Settings, and sent to the sync server the user configured as part of the sign-in token. [USER-REQUIRED: owner to confirm this reading of the dashboard's wording] |
| Health information | No | Not requested or inferred. Users may save study text about health; it is user content, handled as "Website content". |
| Financial and payment information | No | Not requested. Payment and bank sites are on the starter deny list. |
| Authentication information | Yes (conservative) | Passwords and cookies are never read. The user may enter an AI provider API key, and one more for each fallback provider (stored on the device in the extension's database, without extra encryption, never in backups, exports or sync) and, with sync on, signs in to a provider the user configured (tokens kept in browser session storage, tied to the server, provider and client id they were issued for; the sync encryption key, derived from the user's passphrase, is held there too for at most 15 minutes and never leaves the device). These credentials never leave the device except to the endpoint the user configured: each key to the AI provider address it was saved for, the tokens to the sync server and the sign-in provider. |
| Personal communications | No | Mail and chat sites are on the starter deny list; no messages are read. |
| Location | No | Not used. |
| Web history | Yes (conservative) | The address and title of a page are stored with each passage the user saves from it (and the address a PDF was downloaded from). The browser history is never read. |
| User activity | No | No clicks, keystrokes, scrolling or mouse positions are recorded. Review ratings the user gives flashcards are study data, stored locally (and synced only if the user turns sync on). The answers and marks of an exam simulation and a short history of its results are also kept on the device only (not in backups, not synced). |
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
> data; AI help sends text the user approved to the provider the user chose, and to the fallback
> providers the user listed only when the one before could not be reached; sync sends the user's
> change log to the sync server the user chose and signs in through the provider the user chose).
> It is not used for personalised advertising, credit decisions or any unrelated purpose, and no
> person reads it.

## Screenshots

The store takes 1 to 5 screenshots at 1280 x 800 or 640 x 400, JPEG or 24-bit PNG without alpha.
`tests/e2e/screenshots.spec.ts` produces real pictures of the loaded extension on every CI run
(`gh run download <run-id> -n screenshots-ubuntu-latest-4`); page shots are already 1280 x 800. Panel
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
PNGs. The set predates the finish wave: no picture shows the rules manager, the syllabus, the graph,
the exam or the backup-folder panel, so a listing that mentions them has no picture to match
(`tests/e2e/screenshots.spec.ts` was not extended). [USER-REQUIRED: choose and compose the final screenshots, and review them against the shipped
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
- Links inside a PDF that point to a web address open only after you confirm the full address
  in the reader (unless you chose "Always allow this site" in that reader tab), in a new tab;
  StudyVault makes no request for a link itself, and mail, script and file links are not
  opened.
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
exam, exam practice, syllabus, knowledge graph, local-first, privacy, offline. Do not add "semantic
search", "math rendering" or "notifications": the product does not do those (docs/PRIVACY_CLAIMS.md
S18).

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
