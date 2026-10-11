# Manual test checklist (what CI cannot check)

CI drives Playwright's bundled Chromium with the extension loaded unpacked. It cannot see branded
Chrome or Edge, native permission prompts, the real keyboard-shortcut layer, screen readers, OS
accessibility modes or a real upgrade. This list covers those. Run it for every release candidate,
fill in the evidence table at the bottom, and attach it to the draft GitHub release.

Do not mark a row **Pass** from memory or from CI. A row that was not run is **Not run**, and a
release with a **Fail** in a "blocker" row does not ship (ROADMAP.md Phase 7 gate).

Status on 2026-10-11: no row of this checklist has been run; every evidence cell is empty. Section 11
covers surfaces that were added after the first version of the list.

## 0. Set-up (once per run)

| Item | Value to record |
| --- | --- |
| Build under test | version, commit, SHA-256 of `studyvault-ai-<version>-chrome.zip` (compare with `SHA256SUMS`) |
| Browsers | Chrome stable (current), Chrome previous major if available, Edge stable |
| Operating systems | Windows 11 (required); macOS and Linux (where available) |
| Clean profile | A fresh browser profile with no other extensions, so results are attributable |
| Previous release | The last released zip, for the upgrade check (MT-12) |
| Fixtures | `tests/fixtures/html/*.html` served locally (`node -e` static server) plus the real sites in MT-13 |
| Screen readers | NVDA (current) with Chrome and Edge on Windows; VoiceOver with Chrome on macOS |

Install: unzip the release zip into a **stable folder**, open `chrome://extensions` (or
`edge://extensions`), turn on Developer mode, choose **Load unpacked**. Branded Chrome 137 and later
ignores `--load-extension`, so use the UI. Keep the same folder for upgrades (MT-12): the extension id
of an unpacked extension is derived from its path.

## 1. Install and first run

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-01 | Load unpacked, open the extension's details page | No errors listed under "Errors". "Site access" reads "On click" (no site is pre-granted). Permissions shown: no "all sites" access | yes |
| MT-02 | Open the popup on a normal article tab | Heading "StudyVault AI", the host name, an "Activate on this tab" button and an "Always enable on <host>" button; no console errors (inspect popup) | yes |
| MT-03 | Open the popup on `chrome://extensions`, the Chrome Web Store, `about:blank` | "StudyVault cannot run on this page" with the reason; no Activate button; "Open side panel" and "Settings and privacy" still work | yes |
| MT-04 | Open Settings from the popup | Eleven sections, in this order (`SETTINGS_SECTIONS` in `packages/ui/src/shell/paths.ts`): Site access, Appearance, Capture, Review, AI assistance, Sync, Backup and restore, Storage, Keyboard shortcuts, Privacy, Your data. Each is reachable by its `#hash` link and by keyboard. The Privacy section lists the same permissions as the details page (including the optional ones) and names the deny list | yes |

## 2. Site access and native permission prompts

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-05 | **activeTab first use.** On an article, click the toolbar icon (or use the shortcut), select a paragraph | The selection toolbar appears above the selection. Navigate to another page in the same tab: StudyVault is gone until activated again | yes |
| MT-06 | Popup > "Always enable on <host>", **Block** the native prompt | Chrome's prompt names the host only. After Block: nothing changes, the popup says Chrome did not grant access and that "Activate on this tab" still works | yes |
| MT-07 | Same, **Allow** | Open the site in a new tab: toolbar works with no activation click. Settings > Site access lists the host. Details page shows access for that host only | yes |
| MT-08 | Settings > revoke the host; then use Chrome's "Site access" toggle on the details page to switch it back and forth | The list in Settings follows Chrome's state in both directions within a few seconds; revoked sites stop injecting | yes |
| MT-09 | Settings > "Enable on all sites" and decline the prompt | The switch stays off; no site is registered; the explanation was shown before the prompt | yes |
| MT-10 | Add `127.0.0.1` (or any host you use) to the deny list, then try to activate there | Popup says StudyVault is off on that host and offers "Allow"; the keyboard shortcut and context menu say the same; nothing is saved | yes |

## 3. Commands, context menu, side panel

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-11 | `chrome://extensions/shortcuts` (Edge: `edge://extensions/shortcuts`) | Five commands are listed: open side panel (Alt+Shift+S), quick-save (Alt+Shift+H), focus toolbar (Alt+Shift+Y), next highlight (Alt+Shift+Period), previous highlight (unassigned). Settings > Keyboard shortcuts shows the same keys Chrome reports | yes |
| MT-11a | Press each assigned shortcut on an activated article page, with and without a selection | Quick-save with a selection: badge "check", highlight painted. Without a selection: badge "!" and the title says to select text first. Focus toolbar moves focus into the toolbar. Next highlight scrolls to the next painted highlight and wraps. Open side panel opens the panel | yes |
| MT-11b | Reassign one shortcut to a combination that clashes with the OS or the screen reader (for example one NVDA uses) | Chrome warns or the OS wins; StudyVault does not capture the key in the page; nothing is lost | no |
| MT-11c | On macOS and Linux, repeat MT-11a | The suggested keys map to the platform's modifier names; no unintended browser action | yes |
| MT-14 | Select text, right-click | "Save selection to StudyVault" is present with a selection, absent without one, and absent on `chrome://` pages. Using it saves to the last-used bank and shows the badge | yes |
| MT-15 | "Save and add a note in the side panel" on the toolbar | Highlight is saved at once; the side panel opens on it with the cursor in the note field. Typed text is saved and is not visible to the page | yes |
| MT-16 | Switch tabs and windows with the panel open; narrow the panel to its minimum | The panel follows the active tab, says so when the page is not running StudyVault, and has no horizontal scrolling at the narrowest width | yes |

## 4. Accessibility

Use **Chrome and Edge**. Record the screen-reader name and version.

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-17 | **NVDA.** Browse mode on an activated article. Select a sentence with Shift+Arrow. Run the focus-toolbar command | NVDA announces the toolbar "StudyVault: save selected text" and the focused button "Save selection". Arrow keys move between buttons and announce each name ("Save as Formula", ..., "Save and add a note in the side panel", "More options"). Enter saves; "Saved to Inbox" is announced once, politely, with "Undo" reachable by the focus-toolbar command | yes |
| MT-17a | NVDA: open a painted highlight (next-highlight command), read the popover, press Escape | The popover is announced as a dialog "Highlight details"; its controls are named; Escape closes it and returns focus to the page element; the note is read as text with an "Edit note in side panel" button | yes |
| MT-17b | NVDA: side panel tabs, a highlight card, the note field, the Banks tab | Tabs announce name and selected state; each card exposes quote, kind, source, buttons by name; the note field has a label; creating a bank with an empty name announces the error | yes |
| MT-17c | NVDA: Settings page: landmarks, headings, radio groups, deny-list add/remove | Headings navigate the sections; each control has a name; add/remove results are announced; no unlabeled control | yes |
| MT-18 | **VoiceOver (macOS, Chrome).** Repeat MT-17 and MT-17b with VO | Equivalent announcements; the toolbar is reachable by the shortcut and by VO navigation; no focus trap | yes |
| MT-19 | **Forced colors.** Windows "Contrast themes" (Aquatic, Desert, Night sky) on, reload a page with highlights | Highlights are drawn as underlines in the system text colour (no fill needed); the toolbar, popover, popup, panel and Settings stay readable; focus rings are visible; no information is lost | yes |
| MT-19a | `prefers-contrast: more`, `prefers-reduced-motion: reduce` (OS settings) | "Automatic" highlight style turns strong; no animation plays | no |
| MT-20 | **Zoom 200%, 300%, 400%** in Chrome on a 1280 x 720 window, on an article, the popup, the panel and Settings | Toolbar stays in the viewport and off the selection; popover and "More options" are fully reachable; panel and Settings reflow with no horizontal scrolling and no clipped control | yes |
| MT-20a | OS text scaling at 200% (Windows "Make text bigger") with the browser at 100% | Same as MT-20 | no |
| MT-20b | Keyboard only, mouse unplugged: capture, undo, note, switch panel tabs, change a setting | Every step reachable with Tab, arrows, Enter, Space and Escape; focus is always visible and never lost to `<body>` | yes |

## 5. Privacy, windows and offline

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-21 | **Incognito, extension not allowed.** Leave "Allow in Incognito" off on the details page; open a private window | StudyVault does not run there at all (no toolbar, no popup activation) | yes |
| MT-21a | **Incognito allowed, StudyVault switch off.** Turn "Allow in Incognito" on; leave Settings > Capture "Save from private windows" off | Selecting text may show the toolbar, but saving is refused with a message that names the setting; nothing is stored | yes |
| MT-21b | **Both on.** Turn on "Save from private windows"; save a passage | It saves; the popup and panel of a normal window show it (shared database, as the setting says); turning the setting off again refuses new captures | yes |
| MT-22 | **Offline restart.** Save 5 passages on 3 pages; go offline (disable the network adapter); quit the browser completely; relaunch | All data present; highlights repaint on revisit; capture, undo, notes and search work; the extension's service worker (inspect it, Network tab) made no requests; no errors on the details page | yes |
| MT-22a | With AI and sync off, watch the service worker's and the panel's Network tab during a 10-minute session of normal use | No request leaves the browser; only `chrome-extension://` URLs | yes |
| MT-23 | Settings > Your data > Delete all data, then reload an open page | Confirmation names what is removed (and, if sync was used, says the server's copy is a separate control); afterwards the database, settings and site grants are gone, open pages repaint without highlights, the details page shows no site access | yes |
| MT-23b | After MT-23, open DevTools > Application on an extension page | IndexedDB lists no `studyvault`, `studyvault-premigration` or `studyvault-restore-staging`; extension storage (local and session) is empty. Record anything else that remains. Known gaps until the fix in `docs/PRIVACY_CLAIMS.md` P15 lands: the `localStorage` keys `sv.dashboard.contrast` and `sv.dashboard.collapsed`, and the optional `identity` and `alarms` permissions (check with `await chrome.permissions.getAll()` in an extension page console). Any other leftover is a Fail | yes |
| MT-23a | Remove the extension from `chrome://extensions`, install the same build again | No highlights, banks, settings or site grants are present (the browser removes the extension's storage on removal); backups you exported are untouched | yes |

## 6. Upgrade and data safety

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-12 | **Upgrade from the previous release.** Load the previous zip from folder F. Create: 20+ highlights on 5+ pages, 3 banks, notes, a deny-list entry, one persistent site, a changed theme. Replace the files in F with the new build and press Reload on the details page | Every highlight, note, bank and setting is present; highlights repaint; the persistent site still injects without a prompt; no "newer data" or migration error appears; the details page shows no errors | yes |
| MT-12a | **Downgrade guard.** Load the older build over data written by the newer one | Reads work; every write is refused with the message that the data was saved by a newer version; nothing is modified | yes |
| MT-12b | Export a backup before MT-12; after the upgrade, restore it into a second clean profile | Counts and a sample of quotes match; provenance (address, title, capture time) identical | yes |
| MT-24 | Import a damaged backup (truncate it, change one byte) | Import is rejected with a specific message before any change; existing data untouched | yes |

## 7. Documents (if the reader ships in this build)

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-25 | Open a public PDF in Chrome's built-in viewer; use the popup | The popup says the built-in viewer cannot be annotated and offers "Open in StudyVault reader"; it does not pretend otherwise | yes |
| MT-26 | Open the same PDF in the reader; highlight a passage across two lines; reload, zoom, close and reopen | The highlight is on the same words after each; its citation names the page and jumps back to it | yes |
| MT-27 | Import a local PDF (file picker and drag and drop) | Works without enabling "Allow access to file URLs" | yes |
| MT-28 | A scanned PDF; a PDF behind a sign-in; a password-protected PDF | Scanned: says there is no text and offers OCR; sign-in: says it could not be fetched and asks for the file; password: asks for the password and handles a wrong one | yes |
| MT-29 | A 100+ page PDF | Opens without freezing the browser; memory stays reasonable; pages render lazily | no |

## 8. Optional features (only if they ship in this build)

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-30 | Turn on AI, enter a deliberately wrong key, run an action | The preview lists exactly the selected passages; after confirming, an authentication error is shown; the key is not visible in the preview, errors or console | yes |
| MT-30a | With a valid key, compare the preview with the request body (proxy or DevTools on a loopback provider) | The two are byte-identical; redaction edits you made are applied; no other text, URL or history is sent | yes |
| MT-30b | Go offline mid-request; cancel a request; hit a quota error | Each ends with a specific message and no partial result is stored | yes |
| MT-30c | Turn the AI switch off | No AI network request is possible afterwards; stored results stay, labelled unverified | yes |
| MT-31 | Sync on two devices: edit the same note offline on both, then reconnect | No edit is lost silently; the conflict is shown with both versions | yes |
| MT-31a | Sign out, choosing to keep local data, then choosing to remove it | Credentials are gone from the device in both cases; local data is kept or removed as chosen | yes |

## 9. Real sites (public pages only; no account needed)

Run on Chrome and Edge. For each: activate, save two passages (one across inline markup), reload,
check both repaint, check selection/copy/links still work, then open the side panel.

| ID | Site and page type | Why it is in the list | Expected |
| --- | --- | --- | --- |
| MT-13a | en.wikipedia.org, a long article | Static HTML, footnotes, tables, repeated phrases | Works; repeated phrases bind to the right occurrence |
| MT-13b | developer.mozilla.org, a reference page | Static page with in-page navigation and code | Works |
| MT-13c | arxiv.org abstract page and its HTML (ar5iv) version | Academic layout, MathML | Works; math selections save as text |
| MT-13d | pubmed.ncbi.nlm.nih.gov, an abstract | Health-education content, dynamic sections | Works |
| MT-13e | github.com, a repository README | Single-page navigation (client-side routing) | Highlights follow route changes |
| MT-13f | A news site with ads and cookie banners | Third-party iframes, overlays, z-index stacks | Toolbar visible and usable; text in ad iframes is not captured |
| MT-13g | reddit.com or another site built from web components | Shadow DOM | Text inside shadow roots is not captured, and the UI says so rather than failing silently |
| MT-13h | A Google Docs published page or a canvas-rendered viewer | Text drawn on canvas | Nothing to select; no error |
| MT-13i | A page with a rich-text editor (a comment box) | Editable surfaces | No toolbar inside the editor; quick-save says fields are not captured |
| MT-13j | `file:///` HTML file | Local files need the user's opt-in | Refused with guidance until "Allow access to file URLs" is on |
| MT-13k | mail.google.com, a bank or payment site | Starter deny list | StudyVault is off there |

## 10. Store-listing review (before submission)

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-32 | Compare the permission list on the details page with `STORE_LISTING.md` and `PRIVACY_POLICY.md` | Identical; no extra warning appears when the zip is uploaded as a draft | yes |
| MT-33 | Open the privacy policy URL from the listing and from Settings | Same document, current effective date | yes |
| MT-34 | View each screenshot next to the running build | Each matches what the build really does today | yes |

## 11. Surfaces added after the first checklist

These check the dashboard, review, backup, welcome tour, web PDFs, AI consent and two-profile sync.
Where a row restates an earlier one (MT-30, MT-31) it adds the points that the privacy documents now
promise (`docs/PRIVACY_CLAIMS.md`).

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-35 | **Dashboard.** Open it from the popup. Create a bank, folder, topic and subtopic; move a highlight between banks; search with a filter; delete a highlight, find it in Trash and restore it; delete another and use "Empty the trash". Keyboard only for one pass | Every step works by keyboard with visible focus; counts match what you did; after emptying the trash the item is no longer found by search or in any bank view; a restore before the purge brings it back to a visible bank; no errors on the details page | yes |
| MT-36 | **Review session.** Create flashcards (or accept AI-created ones); start a review from the popup; rate several cards; close the tab part-way and reopen; change the study time zone and the rollover hour in Settings > Review | Due counts update after each rating; the session resumes where it stopped and nothing is rated twice; the new day boundary applies; a service-worker restart (chrome://serviceworker-internals, Stop) loses nothing | yes |
| MT-37 | **Backup round trip.** Settings > Backup and restore: export an encrypted backup including cached PDFs; Delete all data; restore the file | Counts and a sample of quotes, notes, cards, review history and OCR text match; address, title and capture time are identical; the settings (theme, deny list, enabled sites, study-day settings), the AI key and the sync sign-in are **not** restored, and the UI says so; a wrong passphrase changes nothing; with sync on, replace-restore shows the note that the account is not shrunk (ADR-010) | yes |
| MT-38 | **Onboarding first run.** Remove the extension, install the build into a clean profile | The welcome tour opens once, in a new tab, on first install; every step can be skipped and resumed; reloading or updating the extension does not open it again; nothing is requested from Chrome until a button names it; AI and sync stay off; Settings can reopen the tour | yes |
| MT-39 | **PDF from a web address.** Right-click a link to a public PDF and a page that is a PDF; choose "Open in StudyVault reader". Repeat for the same host | The two menu items appear only on PDF-looking addresses; Chrome's prompt names only that host; after Allow the file downloads; DevTools > Network on the reader page shows one request to that host, with no cookies and no `Referer`; a second open on the same host starts the download without a prompt; a PDF behind a sign-in says it could not be fetched and offers the file picker; the host grant is listed on the details page and is removed by Delete all data | yes |
| MT-39a | **OCR.** Open a scanned PDF, run OCR, cancel part-way, resume, correct one line, reload, then go offline and reopen | Progress is real; cancel stops; finished pages are kept; the correction is kept apart from the recognised text and persists; the Network tab shows no request during recognition; text is selectable and a highlight anchors | yes |
| MT-40 | **AI consent preview.** Turn on AI with a provider (a loopback model is enough), select two highlights, run an action, edit or remove one chunk in the preview, cancel once, then confirm | Nothing is sent before Send; after edits the preview text equals the request body byte for byte (proxy or DevTools); the key is absent from the preview, errors and console; "Remove access" revokes the host grant (details page); a result is labelled unverified, and accepting one whose citations were found shows "Cited text found in your sources (you accepted it)" and nothing stronger; the key is not in a backup file | yes |
| MT-41 | **Sync, two profiles.** Two clean profiles with the same build, a reference server (server/README.md) and a sign-in provider you control. Turn on sync in A (the prompt lists the server, the provider, `identity` and `alarms`), sign in, set a passphrase, change a note, leave A idle for a minute; sign in on B, enter the passphrase; edit the same note offline on both and reconnect; sign out of B choosing "remove data"; use "Delete my data from the server" on A | **Record, do not assume,** whether the first upload after A's sign-in was readable by the server (known gap P25a); after the passphrase, new changes are ciphertext on the server; after the idle minute A reports "locked" until the passphrase is entered (P25b); B receives A's data; the conflict shows both versions; B's sign-out removes its local data only; the server delete empties the account and leaves A's local data; Delete all data on A leaves the server's copy | yes |

## Evidence table

Copy this table into the release notes or an issue and fill one row per check you ran. Attach
screenshots, screen recordings or logs; name the files after the ID.

| ID | Browser and version | OS | Build (version, zip SHA-256 prefix) | Result (Pass / Fail / Not run / N/A) | Evidence (file or link) | Notes and bug link | Tester | Date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MT-01 | | | | | | | | |
| MT-02 | | | | | | | | |
| MT-03 | | | | | | | | |
| MT-04 | | | | | | | | |
| MT-05 | | | | | | | | |
| MT-06 | | | | | | | | |
| MT-07 | | | | | | | | |
| MT-08 | | | | | | | | |
| MT-09 | | | | | | | | |
| MT-10 | | | | | | | | |
| MT-11 / 11a / 11b / 11c | | | | | | | | |
| MT-12 / 12a / 12b | | | | | | | | |
| MT-13a-k | | | | | | | | |
| MT-14 | | | | | | | | |
| MT-15 | | | | | | | | |
| MT-16 | | | | | | | | |
| MT-17 / 17a / 17b / 17c | | | | | | | | |
| MT-18 | | | | | | | | |
| MT-19 / 19a | | | | | | | | |
| MT-20 / 20a / 20b | | | | | | | | |
| MT-21 / 21a / 21b | | | | | | | | |
| MT-22 / 22a | | | | | | | | |
| MT-23 / 23a / 23b | | | | | | | | |
| MT-24 | | | | | | | | |
| MT-25 to MT-29 | | | | | | | | |
| MT-30 / 30a / 30b / 30c | | | | | | | | |
| MT-31 / 31a | | | | | | | | |
| MT-32 to MT-34 | | | | | | | | |
| MT-35 | | | | | | | | |
| MT-36 | | | | | | | | |
| MT-37 | | | | | | | | |
| MT-38 | | | | | | | | |
| MT-39 / 39a | | | | | | | | |
| MT-40 | | | | | | | | |
| MT-41 | | | | | | | | |

Summary line for the release notes: *"Manual checklist run on <date> against <zip SHA-256 prefix>:
N pass, N fail, N not run. Blocker failures: none / <list>."*
