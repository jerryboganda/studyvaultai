# Manual test checklist (what CI cannot check)

CI drives Playwright's bundled Chromium with the extension loaded unpacked. It cannot see branded
Chrome or Edge, native permission prompts (the e2e build holds the loopback hosts as required
permissions, so Chromium never asks), a real incognito window, a hosted sign-in provider over
https, the real keyboard-shortcut layer, screen readers, OS accessibility modes (forced colours,
400% zoom) or a real upgrade. This list covers those. Run it for every release candidate, fill in
the evidence table at the bottom, and attach it to the draft GitHub release.

Do not mark a row **Pass** from memory or from CI. A row that was not run is **Not run**, and a
release with a **Fail** in a "blocker" row does not ship (ROADMAP.md Phase 7 gate).

Status on 2026-10-12: no row of this checklist has been run; every evidence cell is empty. Section 11
covers surfaces that were added after the first version of the list; section 12 (MT-41a, MT-42 to
MT-53) holds what the accessibility and performance reviews and the e2e wave could not check
(`docs/A11Y_REVIEW.md` "Needs a real browser", `docs/PRIVACY_CLAIMS.md` `test.fixme` rows); section 13
(MT-54 to MT-61) holds what the finish wave added and no spec can drive: the real folder prompt,
reminders across a restart, filing-rule toasts, the exam and the graph with a screen reader, real
office files, two real AI providers and the Preact overlay; section 14 (MT-62 to MT-65) holds what the
PDF reader's three late changes added (links, scans stored sideways, the real-document corpus) and
no spec can drive. The agent-run local e2e passes recorded
in `docs/PRIVACY_CLAIMS.md` are not evidence for any row here.

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
| MT-11 | `chrome://extensions/shortcuts` (Edge: `edge://extensions/shortcuts`) | Six commands are listed: open side panel (Alt+Shift+S), quick-save (Alt+Shift+H), focus toolbar (Alt+Shift+Y), next highlight (Alt+Shift+Period), previous highlight (unassigned), search your highlights / `focus-search` (unassigned: assign a key, press it in a normal tab, and the side panel opens on Search with the cursor in the box; with the dashboard in front, its own search box takes focus). Settings > Keyboard shortcuts shows the same keys Chrome reports | yes |
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
| MT-23b | After MT-23, open DevTools > Application on an extension page | IndexedDB lists no `studyvault-premigration` and no `studyvault-restore-staging*`; `studyvault` is either absent or has every table empty apart from the one `meta` row `searchIndexStale` (an opaque token) and, once a StudyVault page was opened, the default Inbox bank; extension storage (local and session) is empty. Record anything else that remains. **Removed by the Settings page once the wipe is over** (U-16, `docs/PRIVACY_CLAIMS.md` P15; best effort, and a refusal is named in the final message, which is itself a result to record): the `localStorage` keys `sv.dashboard.contrast`, `sv.dashboard.collapsed`, `sv.dashboard.singleKeys`, `sv.review.keys` and `sv.toasts.keep` (display preferences, no study data), and the optional `identity` and `alarms` permissions (check with `await chrome.permissions.getAll()` in an extension page console; host origins must be gone; `await chrome.alarms.getAll()` is empty). In `meta` there is no `aiProfileKeys`, `examSession`, `examHistory`, `syllabusThresholds`, `backupFolder.handle` or `backupFolder.state` row, the `filingRules`, `syllabi` and `relations` tables are empty, and `chrome.storage.session` holds no `sv.filing.*` or `reminderDue` key. Files that a backup folder already holds stay by design. The confirmation dialog does not yet name the new kinds of data (U-17). Any other leftover is a Fail | yes |
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
| MT-39 | **PDF from a web address.** Right-click a link to a public PDF and a page that is a PDF; choose "Open in StudyVault reader". Repeat for the same host | The two menu items appear only on PDF-looking addresses; Chrome's prompt names only that host; after Allow the file downloads; DevTools > Network on the reader page shows one request to that host, with no cookies and no `Referer`; when the fetch ends the reader hands the access back (`docs/PRIVACY_CLAIMS.md` P1c): the host is no longer listed on the details page, and a second open on the same host **asks again**, unless that host is also enabled under Settings > Site access or the all-sites grant is on, in which case it starts without a prompt and the access stays; a PDF behind a sign-in says it could not be fetched and offers the file picker; **Block** fetches nothing, says why, and the file picker still works; Delete all data leaves no host grant (MT-23b) | yes |
| MT-39a | **OCR.** Open a scanned PDF, run OCR, cancel part-way, resume, correct one line, reload, then go offline and reopen | Progress is real; cancel stops; finished pages are kept; the correction is kept apart from the recognised text and persists; the Network tab shows no request during recognition; text is selectable and a highlight anchors | yes |
| MT-40 | **AI consent preview.** Turn on AI with a provider (a loopback model is enough), select two highlights, run an action, edit or remove one chunk in the preview, cancel once, then confirm | Nothing is sent before Send; after edits the preview text equals the request body byte for byte (proxy or DevTools); the key is absent from the preview, errors and console; "Remove access" revokes the host grant (details page); a result is labelled unverified, and accepting one whose citations were found shows "Cited text found in your sources (you accepted it)" and nothing stronger; the key is not in a backup file | yes |
| MT-41 | **Sync, two profiles.** Two clean profiles with the same build, a reference server (server/README.md) and a sign-in provider you control. Turn on sync in A (the prompt lists the server, the provider, `identity` and `alarms`), sign in, before choosing a passphrase look at what the server holds; set a passphrase, change a note, leave A idle for 16 minutes; sign in on B, enter the passphrase; edit the same note offline on both and reconnect; sign out of B choosing "remove data"; use "Delete my data from the server" on A | After A's sign-in nothing has been uploaded: the card says so, "Sync now" is disabled with its reason, and the server holds no operations until a passphrase, or "Upload without end-to-end encryption" after its acknowledgement, is chosen (P25a: record the server's operation count before and after the choice); after the passphrase the server holds only ciphertext (no quote, title or address in its store) and a key profile; A reports "locked" about 15 minutes after the unlock and not before, whatever was done in between (P25b), until the passphrase is entered; B signs in, is locked, refuses a wrong passphrase and receives A's data with the right one; the conflict shows both versions; B's sign-out with "remove data" removes B's local data only; "Delete my data from the server" empties the account and leaves A's local data; Delete all data on A leaves the server's copy | yes |
| MT-41a | **Sync key and worker in real Chrome.** After MT-41's passphrase on A: stop the extension's service worker (`chrome://serviceworker-internals`, Stop, or wait for it to stop), then edit a note; later press "Lock now"; then unlock, close the browser completely and reopen it; then unlock, press Reload on the extension's details page | After the stop the edit still reaches the server and the card still says unlocked (the key is in `chrome.storage.session`, P25b); "Lock now" pauses everything and nothing is sent; after the browser restart the sign-in and the key are gone, the server address, the choice and the data are kept, and sign-in then asks for the passphrase; after the extension reload the same holds. This is the "not verified" half of P25b: Playwright's Chromium was observed to do this for a worker stop and a browser restart, branded Chrome and Edge and the extension reload were not | yes |

## 12. What the reviews and the e2e wave could not check

Each row below exists because an automated spec is `test.fixme`, drives only a stand-in, or the
review that found the issue could not run a browser. The spec or document that points here is named
in the Check column. Run on Chrome and Edge unless a row says otherwise.

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-42 | **Forced colors on the newer surfaces** (`docs/A11Y_REVIEW.md` #13, #18). Windows "Contrast themes" (Aquatic, Desert, Night sky) on. Dashboard: a selected row, the current tree item, the current view button (Library, Trash, Duplicates, Storage), a focused duplicate group. Review: analytics charts and their swatches. PDF reader: a selected card in the companion list, OCR confidence bands. Options and the welcome tour | Each state is told apart without a fill colour (an outline, `Highlight` text, a heavy edge on the second chart series); focus rings are visible on every control; nothing becomes unreadable or disappears | yes |
| MT-43 | **400% zoom (320 CSS px) on the newer surfaces** (`docs/A11Y_REVIEW.md` #6, N2, N8, "Needs a real browser"). Chrome at 400% on a 1280 x 720 window: dashboard (the Banks panel and its toggle, the Preview panel, the "View options" popover, a dialog opened from the tree or the palette), review (session, charts), PDF reader (toolbar wrap), options, welcome tour | No horizontal scrolling and no clipped or covered control; the Banks panel toggle stays reachable and Escape closes the panel and returns focus to it; a dialog opened from the tree is visible and holds focus; record any result row that clips under a text-spacing override (N2) and the "View options" popover if it scrolls inside the header (N8) | yes |
| MT-44 | **Screen readers on the newer surfaces** (`docs/A11Y_REVIEW.md` "Needs a real browser"; extends MT-17, MT-18). NVDA and JAWS with Chrome on Windows, VoiceOver with Chrome on macOS. Dashboard (list, tree, preview, palette, bulk bar, Trash), a review session (reveal, rate, undo, summary, "Turn single-key shortcuts off"), PDF reader (text layer, find count, OCR progress, save bar), welcome tour, Options (the Delete-all wait states, the AI consent dialog, sync status and the encryption card) | Every control has a name and a state; each announcement is heard once and is not doubled with a toast's text; a change of scope or filter announces its count; removing the control that had focus (clearing the bulk bar, removing a tag chip, deleting a card) leaves focus inside the same region, never on the page body; the single-key shortcuts can be switched off and stay off | yes |
| MT-45 | **A real incognito window with the PDF reader** (`tests/e2e/pdf.spec.ts` "private windows" > `test.fixme`; `docs/PRIVACY_CLAIMS.md` P10a; MT-21 with a PDF). "Allow in Incognito" on for the extension, "Save from private windows" off. In a private window right-click a link to a PDF > "Open in StudyVault reader"; read, search, select text; then turn the setting on and off again. Inspect IndexedDB from a normal window | The reader says nothing is being saved; saving a highlight and keeping a copy are refused with the reason; no `documents`, `highlights`, `attachments` or `ocrPages` row appears; with the setting on the open reader saves, with it off it refuses again without a reload; opening the reader in a window Chrome cannot identify refuses too | yes |
| MT-46 | **A hosted sign-in provider over https** (`tests/e2e/sync.spec.ts` > `test.fixme` "a hosted OpenID Connect provider over https"; MT-41 with a real tenant and a TLS-fronted server). Register the extension's redirect address shown in Settings; sign in through the provider's own screens (consent, MFA if configured); use short access-token lifetimes; end the session at the provider; sign out | The redirect address in Settings equals the registered one; sign-in completes; refresh happens without a prompt while the provider's refresh token lives; after the provider ends the session the status returns to "sign in" and nothing waiting is lost; sign-out asks the provider to revoke (provider log); the provider's log shows the IP address, time, account and client id and no study data (P24b) | yes, if sync ships |
| MT-47 | **The native host-permission prompt for the sync and AI origins, Allow and Block** (`tests/e2e/sync.spec.ts` > `test.fixme` "declining Chrome's permission prompt ..." and "a server or provider origin Chrome has not granted ..."; `tests/e2e/ai.spec.ts` header). Use the production zip (no loopback hosts). Settings > Sync: a server and an issuer on other hosts, "Turn on sync". Settings > AI: a provider host, "Save", then the access control. Revoke an origin on the details page and try again | The prompt lists `identity`, `alarms` and the named origins (a token endpoint on another origin asks at the next click); **Block**: sync (or AI) stays off or unusable, the page says Chrome did not grant access and no request left; **Allow**: it turns on; an origin that was revoked afterwards shows "Allow access to ..." and works after Allow; AI "Remove access" revokes the host (details page); record what the details page lists after sign-out and after turning sync off (no remove control exists, U-9) | yes |
| MT-48 | **A web PDF behind a redirect to another host, Allow and Block** (`docs/PRIVACY_CLAIMS.md` P1d, THREAT_MODEL R19). A link on host A that 302s to a PDF on host B, B a server you control; production zip | The first open asks for A only; the reader then names B and offers "Allow access to B and open", which asks for both origins in one prompt; Allow opens the PDF and both grants are handed back afterwards (details page); **Block** reads nothing and offers the file picker; whichever you choose, B's server log shows one GET without cookies or `Referer` from the first open (the browser followed the redirect: accepted limit R19, record it) | yes |
| MT-49 | **The sync alarm in the first worker lifetime** (`tests/e2e/sync.spec.ts` > `test.fixme` "a sync alarm wakes the worker that handled the permission grant, once it was stopped"; ADR-010 amendment 3; `docs/PRIVACY_CLAIMS.md` P30). Fresh install or extension reload; turn sync on and sign in; choose an encryption option; then close every StudyVault page and do nothing; watch `chrome://serviceworker-internals` and the server log across two periods of `sv-sync-periodic` (`await chrome.alarms.getAll()`) | Record whether the stopped worker is started by the alarm and a sync reaches the server. If it is not until a StudyVault page is opened or the browser restarts, that is the known platform limit and not a regression; the same check after the worker has been started once by a page must pass | no |
| MT-50 | **"Delete all data" held up by a second window** (`docs/PRIVACY_CLAIMS.md` P15b, U-15). Keep a dashboard or side panel open in a second tab; Settings > Delete all data > confirm | Settings shows "Waiting for another StudyVault window" with "Stop waiting" and "Check again" and the wait is announced; before the other window closes the settings, deny list and site access are still there; "Stop waiting" says the deletion is still queued, not cancelled; closing the other window finishes the deletion without another click; afterwards MT-23b holds | yes |
| MT-51 | **A restore started twice** (`docs/PRIVACY_CLAIMS.md` P26f, U-15). Two Options tabs with the same backup file; start the restore in A and, while it runs, in B; separately, close the browser by killing it during a restore and reopen | B is refused in plain words (another restore is running) and nothing is mixed; A completes and reports an integrity check; no `studyvault-restore-staging-*` database remains afterwards; after the killed restore the next restore, or Delete all data, removes the leftover staging database | yes |
| MT-52 | **The search index after a purge, a restore and Delete all data** (`docs/PRIVACY_CLAIMS.md` P31, U-15). Open the dashboard and the side panel (two search hosts). Permanently delete a highlight from Trash and search for its words in both, then reload both; restore a backup while both are open; run Delete all data (close the dashboard if it blocks) | The purged words are found in neither; both pages converge on the restored content within seconds without a manual reload; after Delete all data nothing of the deleted text is searchable and, once a search page has rebuilt, the `meta` row `searchIndex` holds none of it (until then it may, R15: record how long) | yes |
| MT-53 | **Other manual items of the accessibility review** (`docs/A11Y_REVIEW.md` "Needs a real browser", N1, N2, #14). `prefers-reduced-motion: reduce` through a whole review session; caret browsing (F7) then selecting text in the PDF reader and pressing `H`; a touch device or emulation for the tree's expand and collapse target; four stacked toasts over the dashboard list; an OS text-spacing override on the dashboard list | No animation plays and scrolling is instant; the selection reaches the save bar by keyboard; the 24 px twist is hit reliably; the active row is not hidden under the toasts and its focus ring stays visible; record row clipping under the override (N2) | no |

## 13. The finish wave (2026-10-12): what no spec can drive

ADR-011 to ADR-020 added features whose loaded-extension specs are written and not yet run in CI
(`docs/PRIVACY_CLAIMS.md` P20a to P20c, P26j, P33 to P44; `TEST_PLAN.md`). The rows below are what
only a person with a real browser, real files or a screen reader can check. Use the production zip and
branded Chrome and Edge, not the e2e build.

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-54 | **Backup folder on a real disk** (`tests/e2e/backup-folder.spec.ts` replaces the picker with an OPFS directory; P26h, P26i, ADR-016). Settings > Backup and restore > "Back up to a folder": choose an empty folder on a real drive and set "keep" to 2; press "Back up now" three times; put an unrelated file and a look-alike named `studyvault-20200101-000000.zip` (not made by StudyVault) in the folder and back up again; back up once with a passphrase; quit Chrome completely, reopen and press the button; remove the folder's grant in Chrome's site settings and press it; delete the folder, or fill the drive, and press it; then "Stop using this folder" | Chrome's own prompt names that folder when it is picked; each press writes a dated file and reports it read back and checked, with size and hash; only the newest 2 of StudyVault's own files remain and the unrelated file and the look-alike are untouched; the passphrase file is `.svbackup` and a plain one opens as a ZIP; after the restart the page asks again from the next click and a "no" changes nothing; after the grant is removed the page offers "Allow and try again"; a missing or full drive is explained and leaves no empty file; "Stop using this folder" says Chrome's grant stays until removed in its settings; once the last backup is older than the interval a notice appears on the dashboard and Settings and nothing is written by itself; Delete all data forgets the folder and leaves its files (MT-23b) | yes |
| MT-55 | **Reminders across a restart** (`tests/e2e/reminders.spec.ts` creates the alarm a few seconds ahead; P35, ADR-019). Settings > Review > Study reminders: turn on and compare the icon with the popup; save a daily time two minutes ahead and answer Chrome's prompt; close every StudyVault page and wait; dismiss; repeat in a second profile and decline the prompt; save a time, quit Chrome, reopen it after the time has passed | The icon and its tooltip show the due count with no prompt; the prompt names the optional timer permission and appears only from the click that saves the time; at the time the icon shows "!" and the popup and side panel say "Time to review: N cards due" until Dismiss, nothing is due or the study day ends; no system notification appears; declining keeps the count and the page says the time is idle; for a time that passed while Chrome was closed, record whether a notice appears after the restart (StudyVault adds no catch-up of its own; what Chrome does with a missed alarm is not under its control, ADR-019). Record whether the first notice after the grant arrives with every StudyVault page closed (the known first-lifetime limit, MT-49) | yes, if reminders ship |
| MT-56 | **Filing-rule toasts on real pages** (`tests/e2e/rules.spec.ts`; P33, ADR-017). Make one rule for a real host with "Ask me before filing" on and one with it off; on that host save with the toolbar and with the shortcut and use File, Not now and Undo; repeat in a PDF in the reader; save with a bank picked in "More options"; delete a rule's bank and save again; restore a backup and import a file that match the rule; try a private window with "Save from private windows" on | A suggestion offers File and Not now and moves nothing until File; the quiet rule files at once with "Filed in X by rule" and an Undo that restores the old place; a bank named by the capture is never changed; a gone bank says why and the highlight stays where capture put it; the side panel card shows a pending chip; the reader shows the same notices; a restore and an import file nothing; each toast is announced once and Undo is reachable by keyboard; the private window follows the capture setting | yes |
| MT-57 | **The exam with a screen reader** (`tests/e2e/exam.spec.ts` runs axe only; P36, ADR-020). NVDA and VoiceOver with Chrome. Review > Exam: 5 questions, a 2-minute limit; answer one multiple-choice and one recall question; let the clock pass 50 %, 10 %, one minute and the end; mark the recall questions; read the results and the missed list; tick and untick "Count this exam as review" | The question and the picked option are named; the timer is read when asked and not every second; the four milestones are each announced once, "time is up" included although the screen changes at that moment; there is no single-key shortcut; a recall answer appears only in marking; the results announce the score and the table has headers; focus lands on the new heading after each phase | yes |
| MT-58 | **The knowledge graph with a screen reader** (`tests/e2e/graph.spec.ts` runs axe and the keyboard only; P34, ADR-018). NVDA, JAWS and VoiceOver with Chrome. Make six links across highlights, a note and a knowledge point; open the graph around one; use Tab once, then the arrows, Enter, C, Escape, + and -; read the Connections table; move one end to the Trash | The diagram is one tab stop and its help is read; each item's name gives its kind, text, link count and distance; the arrows reach every item and a dead end is announced; the table lists every item and link in words and its Open and Centre buttons work; the trashed end disappears from the picture and the table and the change is announced | yes |
| MT-59 | **Import of real office files** (`tests/e2e/import-formats.spec.ts` uses files built in Node; P26j, ADR-014). Import a .docx saved by Word and one saved by LibreOffice, a .pptx with speaker notes and a hidden slide from PowerPoint, an EPUB from a real e-book, an Anki "Notes in Plain Text" export with cloze notes and tags, and a saved web page (.html); then a password-protected .docx, an .apkg, a legacy .doc and a DRM-protected EPUB | The dry run counts match what the file holds; each highlight carries the file name and "Paragraph n", "Slide n" or "Chapter n, paragraph m"; images, footnotes, comments and speaker notes are listed as not imported; DevTools > Network shows no request; nothing is stored before the import button; Undo moves exactly that import to the Trash; the refused files say why and write nothing | yes, if import ships |
| MT-60 | **AI fallback with two real providers** (`tests/e2e/ai-extras.spec.ts` uses two fake providers on loopback; P20a, ADR-013). Settings > AI: a real provider as primary and a second real provider (or a local model on another origin) as a fallback with its own key; run an action. Then (a) revoke the first key at its provider, (b) make the first address unreachable (firewall rule or a dead host), (c) reorder the list after the preview was shown | Chrome's prompt lists both origins in one prompt and Block sends nothing; the preview lists both addresses in order with each key's state; (a) a rejected key stays on the first provider and is reported by name, the second hears nothing (provider log); (b) the second provider receives the same previewed text, and the result names the provider that answered; the usage ledger counts both attempts; (c) the earlier confirmation no longer applies | yes, if fallbacks ship |
| MT-61 | **The Preact overlay, and a selection made before activation** (ADR-012; only unit-tested). The production zip in branded Chrome and Edge, on the sites of MT-13a to MT-13k: select text first, then activate with the toolbar button or the shortcut; select with the keyboard; open "More options", the highlight popover and a toast with Undo; look at the extension folder and DevTools > Memory on one tab | The toolbar appears for the selection that existed before activation; focus, Escape, positioning and forced colours behave as MT-17 to MT-20 describe; no console error; `content-scripts/highlighter.js` is about 209 KB; nothing is rendered outside the shadow root | yes |

## 14. The PDF reader after the finish wave (2026-10-12): links and sideways scans

ADR-006 amendments 3 and 4 added link following and the turned reading of scans stored sideways; the
real-document corpus (`tests/fixtures/pdf/real/`, eleven public-domain files, `SOURCES.md`) gave the
tests real files. `tests/e2e/pdf-links.spec.ts`, `pdf-real.spec.ts` and `pdf-real-memory.spec.ts` are
written and not yet run in CI (`docs/PRIVACY_CLAIMS.md` P45 to P47). The rows below are what only a
person with a real browser, a screen reader or a scanner can check. Use the production zip in branded
Chrome and Edge; the real PDFs are in the repository and can be chosen with the reader's file picker.

| ID | Check | Expected | Blocker |
| --- | --- | --- | --- |
| MT-62 | **Following a real link with a screen reader** (`pdf-links.spec.ts` runs axe and the keyboard only; P45, `docs/A11Y_REVIEW.md` addendum "links in the PDF reader"). NVDA and JAWS with Chrome on Windows, VoiceOver with Chrome on macOS. Open `nist-cswp29-csf-2-0.pdf`; go to page 4 (the contents), Tab into the page, listen to the first three links, press Enter on one, listen, press Alt+Left. On page 2 activate the web address and the `mailto:` link. Open the navigation pane's "Links" tab and follow an entry. Then open `cdc-sti-guidelines-2021.pdf`, go to page 138 (references) and Tab into the page once | Each link is announced as a link by its name ("Link to page 6", "External link to www.nist.gov"); Enter lands on the target page, "Went to page N." is heard once and focus is on the page; Alt+Left, or the Back button named "Back to page N", returns to where the link was; the web address opens a dialog that reads the whole address and the site and starts on Cancel; the `mailto:` link is named "Link that StudyVault will not open" and, when activated, a notice says why; the Links tab lists every link by name and follows it; page 138 has **one** tab stop, the arrow keys, Home and End move between its links, and its group label says so; nothing is announced twice | yes |
| MT-63 | **The new tab and Chrome's pop-up blocker** (P45; `noopener` makes `window.open` return null, so the reader cannot know whether the tab opened). Production zip in branded Chrome with pop-ups at the default. In `nist-cswp29-csf-2-0.pdf`, page 2, follow the web address and confirm; follow it again with "Always allow this site" ticked (the second click opens without the dialog); then, in Chrome's site settings for the extension's address (`chrome-extension://<id>`), set "Pop-ups and redirects" to blocked and repeat; follow a link while another window has focus | By default the tab opens next to the reader with `window.opener` null in its console and no `Referer` in the site's own log; the address bar shows the address the dialog showed; with pop-ups blocked Chrome shows its own blocked-pop-up indicator, the reader still says "Opening {host} in a new tab." (the known limit: record it), stays usable and opens nothing else; the reader's Network panel shows no request from StudyVault; a reader that cannot return to its page or dialog is a failure | no |
| MT-64 | **OCR of a physically sideways scan** (`pdf-real.spec.ts` covers the one real file in the repository; P46, ADR-006 amendment 4). Scan one printed English page of at least 15 lines to image-only PDFs with `/Rotate 0` (a scanner's PDF mode or a phone scan app, not print-to-PDF): sheet turned a quarter turn one way, the other way, upside down, and upright. Open each in the reader, press "OCR this page", time it, read the *Page text* tab; turn the view with Rotate, select four recognised words, save the highlight, reload the reader and choose the file again; repeat the first with the network off. Add one scan with a sideways table beside upright text | Each turned scan comes back as English text and the outcome names it ("Page 1 is stored sideways (its lines run from bottom to top); it was turned to be read.", "... from top to bottom", "... upside down"); the Page text tab says the same; "Checking orientation of page 1..." appears only for the turned ones; the upright scan takes one reading (compare the times with each other and with MT-39a); the highlight sits on the words and is found again after the reload with no new recognition; nothing is requested while it runs; the mixed page is read in one orientation only (record what comes back: the known limit) | no |
| MT-65 | **Forced colours on PDF links** (`docs/A11Y_REVIEW.md` addendum "links in the PDF reader"; extends MT-42). Windows "Contrast themes" (Aquatic, Desert, Night sky) on. Open `nist-cswp29-csf-2-0.pdf`, page 4, and Tab through the contents links; `cdc-sti-guidelines-2021.pdf` page 138 (one tab stop and the arrow keys); the confirmation dialog and the Back button | The focused link has a visible `Highlight` ring that is not clipped by the page edge and does not hide the text under it; on the dense page the ring follows the arrow keys; the dialog, the Back button and the Links list are readable in every theme; the pointer over a link is a hand | yes |

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
| MT-41 / 41a | | | | | | | | |
| MT-42 | | | | | | | | |
| MT-43 | | | | | | | | |
| MT-44 | | | | | | | | |
| MT-45 | | | | | | | | |
| MT-46 | | | | | | | | |
| MT-47 | | | | | | | | |
| MT-48 | | | | | | | | |
| MT-49 | | | | | | | | |
| MT-50 | | | | | | | | |
| MT-51 | | | | | | | | |
| MT-52 | | | | | | | | |
| MT-53 | | | | | | | | |
| MT-54 | | | | | | | | |
| MT-55 | | | | | | | | |
| MT-56 | | | | | | | | |
| MT-57 | | | | | | | | |
| MT-58 | | | | | | | | |
| MT-59 | | | | | | | | |
| MT-60 | | | | | | | | |
| MT-61 | | | | | | | | |
| MT-62 | | | | | | | | |
| MT-63 | | | | | | | | |
| MT-64 | | | | | | | | |
| MT-65 | | | | | | | | |

Summary line for the release notes: *"Manual checklist run on <date> against <zip SHA-256 prefix>:
N pass, N fail, N not run. Blocker failures: none / <list>."*
