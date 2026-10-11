# StudyVault AI - Privacy Policy

> **DRAFT: describes intended behaviour; not for publication until every docs/PRIVACY_CLAIMS.md row it depends on is `verified`.**
>
> Revised 2026-10-11 (second pass, after the backup and import, PDF reader, deletion, search index,
> database lifecycle and sync hardening changes) against the repository working tree. Each statement
> below is meant to be backed by code; `docs/PRIVACY_CLAIMS.md` lists the code, the test and an
> honest status for each one, and several are not verified end to end. On that date every completed
> `ci.yml` run of the repository had concluded `failure`, the release workflows had never run, and
> no CI run had executed the hardening changes, so no statement here has the evidence of a green
> pipeline. The hardening changes are covered by unit and integration tests written with them; none
> has been exercised in a loaded Chrome by a CI run or by the manual checklist. Where the product's
> own screens still say something different from this document, `docs/PRIVACY_CLAIMS.md` ("Open
> items for the UI and code agents") names the file and the string. This is a plain-language policy,
> not legal advice.

[USER-REQUIRED: legal review of this policy, the effective date, and the legal name and postal address
of the publisher. Delete this line when done.]

**Effective date:** [USER-REQUIRED: date of publication]
**Publisher:** [USER-REQUIRED: legal name of the person or organisation that publishes the extension]
**Contact for privacy questions:** [USER-REQUIRED: support email address]

## In short

- StudyVault AI keeps what you save **on your own device**. There is no account, no analytics and no
  advertising, and no server receives your highlights unless you switch on the optional sync.
- It does not read your browsing history and does nothing on a website until you turn it on for that
  tab or that site.
- Three things can make a request that leaves your device, and each starts with an action of yours:
  opening a PDF from a web address in the StudyVault reader, optional AI help, and optional sync. AI
  help and sync are **off by default**. For AI you see exactly what will be sent before it is sent.
- You can export your data, and you can delete all of it from the Settings page. Deleting does not
  reach a copy that a sync server holds; that is a separate control (see "Retention and deletion").

## What StudyVault stores, and where

All of it is stored in your browser profile on your device: in the extension's database (IndexedDB),
in its extension storage (`chrome.storage`; the session part is held in memory and is cleared when
the browser closes) and, for two display preferences, in the local storage of its own pages. None
of it is uploaded in the default configuration.

| What | Details |
| --- | --- |
| Passages you save | The passage exactly as written (up to 10,000 characters), a simplified copy (lower case, single spaces) and a SHA-256 fingerprint of it, used to notice the same passage saved twice and for search. |
| Where it came from | The page address, the address the page declares as its own when it names the page itself, the page title (up to 500 characters) and the site name. Before an address is stored, StudyVault removes a user name or password in it, query parameters and `;name=value` path parameters whose name looks like a credential, and any `#fragment` that is not a page route (`#/...` or `#!...`); inside a route, parameters whose name looks like a credential are removed too, a route that is really a credential blob (for example `#/access_token=...`) is dropped, and anything after a second `#` is dropped. "Looks like a credential" is judged on the name alone, split into words: it contains a stem such as token, secret, password, credential, bearer, session, csrf, signature, authorization, jwt or hmac, ends in key, has a word such as key, sig, sid, auth, oauth, otp, pass or ticket, has code as its last word, or starts with `x-amz-` or `x-goog-` (`packages/shared/src/urls.ts`, `isCredentialName`). The rule is a heuristic: it can remove a harmless parameter and it cannot recognise a secret in a parameter with an unremarkable name. Other parts of the address, such as tracking parameters, are kept as you visited. The rule is applied when an address is saved: addresses already stored are not rewritten, and a backup you restore, or an item that arrives by sync, keeps the address exactly as the device that made it stored it. |
| How to find the passage again | Up to 64 characters of page text just before and just after the passage, the nearest heading above it (up to 300 characters), a short description of where it sits in the page structure (a chain of element names and positions that stops at the nearest ancestor element carrying an `id` attribute, and includes that `id` value as the page wrote it), its position in the page text, and a hash and the length of the whole page text at the time you saved it. The hash and length only tell StudyVault that the page changed; the page text itself is not stored. |
| What you add | Your note on a highlight (up to 20,000 characters), standalone notes (title, and body up to 100,000 characters), the kind, colour and priority you chose, custom fields, the banks, folders and tags a passage is in (their names, colours and aliases), how you saved it (toolbar, shortcut, menu or import) and when. |
| Study data | Flashcards and quiz questions you create or accept, the decks they sit in and each deck's scheduling settings, knowledge points, the review history that schedules them (each rating and when), the review session in progress, and your study-day settings (time zone, hour a study day starts, ordering). |
| Documents you open in the reader | The document's title, page count, size in bytes, whether it has selectable text, a SHA-256 fingerprint of the file, the web address it was fetched from (with credentials removed; none for a file you chose from your computer), and the highlights you make. The text of pages that have a text layer is read in memory and is not stored, apart from the passages you save and their short context. Text recognised by the optional OCR feature is stored page by page (the recognised text, the position and confidence of each word, the language and engine, and your corrections). The PDF file itself is kept only if you choose to keep a copy. In a private window none of this is stored unless "Save from private windows" is on (see "Opening a PDF from a web address"). |
| Settings | Theme, density, whether the toolbar shows, default kind, colours, the last bank you saved into, your deny list, the sites you enabled, whether highlights are painted, highlight style, whether private windows may be saved, and which optional features are on. Also: study-day settings (above), your progress through the welcome tour, and the AI provider address, model, limits, price settings and usage counters. The sync server address, sign-in provider address and client id, and your choice about encrypting what is uploaded, are kept in the extension's database, not in extension storage, so that scripts running in web pages cannot change where your data is sent. For the same reason the background worker enforces your deny list, the private-window setting and the optional-feature switches from a second copy of your settings kept in that database. Saved searches are kept in the database. |
| Secrets | If you enter an AI API key it is stored in the extension's database (the `meta` store of its IndexedDB), not in `chrome.storage`, without extra encryption. Sync sign-in tokens, and the sync encryption key while it is unlocked (at most 15 minutes, see "Sync"), are kept in browser session storage: memory only, closed to web pages and content scripts, cleared when the browser closes. None of these is written to backups or synced (see below). |
| Search index | A search index built from your saved text is cached in the database so search is fast. It is derived data. After you permanently delete items or restore a backup it is rebuilt by a page that hosts search (the dashboard or the side panel), as soon as one is open or, when none is, the next time one opens; the old cached copy, which holds the text of what you deleted until then, is replaced a few seconds after the rebuild. A rebuild skips items it cannot read and counts them as rejected instead of stopping. After "Delete all StudyVault data" the new, empty database holds one random marker value (no study data) that makes open pages drop their copy of the index. |
| Change markers | Values of the form timestamp plus a random string, written to extension storage so that open StudyVault windows know to refresh. They contain no study data; the timestamp shows when something last changed. |
| Short-lived hand-over | When you choose "Save and add a note", the id of that highlight and a time stamp are held in session storage until the side panel has used them. An entry older than 30 seconds is ignored and removed the next time the panel opens, and the browser clears session storage when it closes. |
| Display preferences | Two preferences of the dashboard (the contrast choice and which folders are collapsed) are kept in the local storage of the extension's own page. |

StudyVault does **not** store the text of the pages you visit (only the passages you save, with the
short context above), form-field contents, passwords, cookies, or your browsing history.

## What StudyVault reads, and when

- **Only on pages you enabled.** StudyVault runs on a tab when you click its toolbar button, use its
  shortcut or its right-click menu item on that tab ("this tab only"), or on sites you explicitly
  allowed in Settings. It does not run anywhere else.
- **On those pages** it reads the text you select, a little text around it, the page's address, title
  and declared canonical address, and the nearest heading. To find saved passages again it reads the
  page text in memory; that text is not kept. On a page with no saved highlight the page text is read
  only when you select something to save.
- **It does not capture** text typed into form fields, editors or password fields, and it refuses to
  run on browser pages, the Chrome Web Store and other pages Chrome protects.
- **Deny list.** A starter list of well-known sign-in, mail, payment, bank and health-portal sites is
  switched off by default. The list is a starting point, not a guarantee: banks and portals differ by
  country and organisation. Add your own sites in Settings.
- **Private (incognito) windows** are not saved unless you turn on "Save from private windows" in
  Settings. The database is shared between normal and private windows, so a passage saved from a
  private window is visible from normal windows. The background worker applies this setting, your
  deny list and the optional-feature switches from its own copy of your settings (see "Settings"
  above), not from the copy that a web page's script could write. The PDF reader applies the same
  rule (see "Opening a PDF from a web address").

## What leaves your device

**In the default configuration, no study content leaves your device.** StudyVault makes no network
request of its own in normal use. It contains no analytics, advertising or telemetry code, and all of
its code ships inside the extension; none is downloaded.

Three user-started paths can make a request that leaves the device:

1. opening a PDF from a web address in the reader (below);
2. AI help, if you turn it on (below);
3. sync, if you turn it on (below).

**What the browser-enforced security policy does and does not do.** The extension declares a content
security policy that the browser enforces on its pages. It blocks remote scripts and frames, but its
`connect-src` allows `https:` (and `http://localhost` and `http://127.0.0.1`), because the PDF's web
site, the AI provider and the sync server are addresses you choose and cannot be listed in advance.
The policy therefore does not by itself stop a request from leaving. What does is that the code that
makes those requests runs only behind the feature switches and your action described below.

### Opening a PDF from a web address

- When you choose "Open in StudyVault reader" (the right-click menu on a link or page that looks like
  a PDF, or the button in the popup or side panel), the reader opens in a tab and downloads the file
  **itself** from the address. Chrome's built-in PDF viewer is not used and cannot be annotated by
  extensions.
- The first time for a web site, the reader asks Chrome for access to that one site, from your
  click and after explaining why. **When the download ends, whether it worked or not, the reader
  hands that access back**, unless you already had access to that site some other way (a site you
  enabled in Settings, an all-sites grant, a grant you gave elsewhere): then nothing is requested and
  nothing is removed, and the download starts as soon as the reader tab opens, without a prompt.
  Opening the same PDF again therefore asks again, unless you hold standing access. Handing back is
  best effort: if Chrome refuses to remove the grant, or its state cannot be read, the grant stays
  and is listed on Chrome's extension page (see "Revoking" below).
- **What the site learns:** your IP address, the address of the PDF and the usual headers a browser
  sends (for example its user agent and language). StudyVault sends no cookies or stored logins
  (credentials are omitted, so a PDF behind a sign-in cannot be fetched and the reader says so) and
  no referrer. Only https addresses are opened (plain http only for `localhost` and `127.0.0.1`),
  up to 300 MB.
- **Redirects.** The browser follows a redirect on its own and extensions cannot see the individual
  hops, so a different site that the address redirects to may receive the same request (your IP
  address, the address you were sent to, no cookies, no referrer). What StudyVault controls is what
  it reads: it checks the address the download ended at against the same rules (https, or http on
  `localhost`; no user name or password) and reads the file only if that site is the one you asked
  for or one you allow. Otherwise it discards the response unread, names the site, and asks whether
  to allow that site for this download; if you do, both sites are handed back afterwards like the
  first.
- **Private windows.** The database is shared with normal windows, so a reader tab in a private
  window stores nothing in it unless "Save from private windows" is on: no document record, no
  highlights, no recognised (OCR) text and no kept copy. The reader asks the browser whether its own
  window is private (this needs no extra permission and reads nothing about other tabs); a reader
  opened from the right-click menu in a private tab also carries that fact in its address; and a
  window that cannot be determined is treated as private. The rule is enforced where the reader
  writes to the database, not only on its screens, and the setting is read at the moment of each
  write, so turning it on or off applies to an open reader without reloading. The reader still
  opens and displays the file, and viewing, editing and deleting what is already saved stays
  possible.
- **What is not sent:** nothing of yours is uploaded. The downloaded file is read and shown in
  memory; it is kept on your device only if you choose to keep a copy. Files you pick from your own
  computer are read locally and are never fetched or uploaded.

### AI help (optional, off by default)

- You choose the AI provider address and enter your own API key. [USER-REQUIRED: confirm that the
  shipped build lets users bring their own key and does not route requests through a StudyVault
  server; if a hosted service is offered, name the operator and describe its handling here.]
- When you ask for an AI action, StudyVault shows you **a preview of exactly the text that will be
  sent** and lets you edit or remove parts of it. Personal data and secrets that look like emails,
  phone numbers, account numbers or keys are marked for removal automatically; this detection is
  heuristic, so please read the preview. Only the passages and notes you selected are sent, never a
  whole page and never your browsing history.
- The request goes **directly from your browser to the provider address you configured**, over HTTPS
  (plain `http://` is accepted only for `localhost` and `127.0.0.1`, for models you run yourself).
  The provider receives the approved text, your question if you asked one, the model name and your
  API key, and learns your IP address. Its own privacy policy governs what it does with them;
  StudyVault does not control that. The request carries no cookies and no referrer, and a redirect is
  treated as an error rather than followed with your key.
- Your API key is stored on this device in the extension's database, without extra encryption, so
  anyone with access to your browser profile on this computer can read it; use a key with a
  spending limit. It is sent only to the provider address you configured, is not written to logs,
  and is excluded from backups, exports and sync. Removing it in Settings deletes it.
- AI results are stored on your device, separately from your quotes and notes, and are labelled
  **unverified**. They never overwrite a quote or a note. When you accept a result and every
  citation in it was found word for word in your selected passages, its label changes from
  "unverified" to "Cited text found in your sources (you accepted it)". That means the cited words
  exist in your saved text; it does not mean the statement is true. Knowledge points and flashcards
  created from AI output stay marked as AI-created and needing your verification until you mark
  them checked.

### Sync (optional, off by default)

- **There is no StudyVault-operated sync service in this release.** Sync works only with a server
  that you, or someone you trust, operate: you enter its address, the address of an OpenID Connect
  sign-in provider (the "issuer") and a client id registered with that provider. The repository's
  reference server is, in its own documentation, deliberately not production-complete.
  [USER-REQUIRED: if a hosted sync service will be offered with this release, name its operator and
  location and describe its handling here; otherwise confirm that this paragraph is accurate.]
- Sync runs only after you press "Turn on sync", allow the browser permissions it asks for, and
  sign in. **Even then nothing is uploaded until you choose how uploads are protected** (see
  "Encryption" below): until you do, StudyVault may download what the server holds, from the first
  run, from the timer and from "Sync now", and it uploads nothing.
- **What is uploaded** is a log of changes (one entry for each item created, edited or deleted), with
  every field of the item except the few that stay on this device, for these categories. The list
  that Settings shows before you turn sync on is generated from the same sync policy that decides
  what is uploaded, and a unit test fails when a synchronised data type has no plain-language
  description there:
  - banks, folders and tags (names, colours, aliases);
  - sources: the page address, the address the page declared as its own, the host name and the page
    title;
  - highlights: the exact passage, the text just before and after it, the nearest heading, the
    address and title it was saved from, its kind, colour and priority, your note and custom fields,
    how and when it was saved, and which banks and tags it belongs to;
  - standalone notes (title and body);
  - flashcards, decks, knowledge points and your review history (every rating and when);
  - documents opened in the reader: title, page count, size in bytes, the web address it came from
    and whether it has text; and OCR pages: the recognised text, your corrections, the position
    and confidence of each recognised word, the language and engine.
- **What is not uploaded:** settings (including the deny list and the sites you enabled), study-day
  settings, welcome-tour progress, PDF files and kept copies, AI drafts, the AI provider settings,
  key and usage counters, saved searches, the search index, whether a highlight was found on the page
  at its last check, sign-in tokens, and the encryption key and passphrase.
- **What the server can see even with encryption on:** the type of each item (for example highlight,
  note, card), its identifier, whether it was created, changed or deleted, a revision number and a
  logical clock, the identifier of the device that made the change, timestamps, the size of each
  change, and when and how often you sync; plus your IP address and the account identity on your
  sign-in token. For documents and OCR pages the identifier is derived from the SHA-256
  fingerprint of the PDF file (and the page number), so an operator who holds the same file can tell
  that you have that document.
- **Encryption: what the code does** (unit and integration tested against the reference server; not
  yet exercised in a loaded Chrome or against a real sign-in provider).
  - **Nothing is uploaded until you choose.** After you sign in, StudyVault only downloads. You then
    either set a passphrase, and everything is encrypted on this device before it leaves, from the
    first upload, or you press "Upload without end-to-end encryption" after confirming that the
    server's operator can read everything that is uploaded. If the account on the server already
    has an encryption key, there is no plaintext option: you unlock with the passphrase. The choice
    is forgotten when you change the server address, the sign-in provider or the client id.
  - **Encryption is optional.** With a passphrase, the key is derived on your device
    (PBKDF2-SHA-256, 600,000 rounds) and content is sealed with AES-256-GCM before upload; the key and
    the passphrase are never sent. The operator cannot read content uploaded under that key, and if
    you lose the passphrase nobody can recover your synced data. Your data on this device is not
    affected. If the server must not see your content at all, do not turn on sync, or only use a
    server you control.
  - **Setting or changing a passphrase does not trust what the server holds.** Turning encryption on,
    or changing the passphrase, re-sends what this device holds under the new key and replaces what
    the server stores. Items that other devices wrote are kept when this device validated them
    under the sync rules (well-formed, no change to protected fields such as the quote and where it
    came from, a known type). Anything that fails that, for example a rewrite of a quote's source
    that the server planted, is not carried over: it is replaced by a placeholder that no key opens,
    every device refuses it, and the device that re-keyed lists it under "Refused changes" with a
    count. A log that was uploaded without encryption carries no proof of who wrote an item, so a
    well-formed edit that the server added in another device's name before encryption was set up
    cannot be told from a real one; choosing a passphrase before the first upload avoids that. Sync
    your other devices first: a change another device has not uploaded yet can lose to the re-sent
    copy. Copies the operator made earlier (logs, backups, snapshots) cannot be removed.
  - **Key custody.** After you enter the passphrase, the derived key (never the passphrase) is held
    in the browser's session storage: memory only, never written to disk, closed to web pages and
    content scripts. It is kept for at most 15 minutes from the unlock, whether or not you keep
    using sync, and it survives Chrome suspending the idle background worker within that time, so
    background sync keeps working until then. It is dropped when the time is up, when you press "Lock
    now", sign out, turn sync off, change the server or provider, delete the server's data, restore a
    backup in "Replace" mode or use "Delete all StudyVault data", and when the browser closes or the
    extension reloads. While it is dropped ("locked") nothing is downloaded, applied or uploaded, and
    nothing is uploaded unencrypted in its place. How Chrome treats session storage across worker
    suspension, browser exit and extension reload has not been verified in a loaded extension.
  - **Downgrade protection.** Once this device has enabled or unlocked encryption, a server that
    later stops presenting the key, or presents an older or different one, does not get plaintext:
    StudyVault pauses sync, shows a warning, uploads nothing and refuses to turn encryption on again
    from this device until you delete what the server holds. A newer key version (another of your
    devices changed the passphrase) is accepted, and this device waits, locked, for the new
    passphrase.
  - **AI and decrypted text.** End-to-end encryption does not cover what you choose to send to an AI
    provider: if you use the optional AI features, the text you select is decrypted on this device
    and sent only after you give a separate consent for that request.
- **The sign-in provider is a separate third party.** Signing in uses the OpenID Connect provider
  whose address you entered. The browser opens that provider's own sign-in page; StudyVault sends it
  your client id, a redirect address that contains this extension's id, and standard sign-in
  parameters (authorization code with PKCE), and exchanges the code for tokens at the provider's
  token endpoint. The provider learns your IP address, when you sign in, which account you use, and
  that this browser uses StudyVault sync; it does not receive your study data. If you sign out and
  leave "Also ask the sign-in provider to end this session" ticked, it is asked to revoke the
  tokens. The provider's privacy policy applies. The access token it issues is sent to the sync
  server as a bearer credential; tokens are kept in browser session storage (cleared when the
  browser closes), are tied to the server address, provider and client id they were issued for (a
  token that does not match the configuration in use is forgotten and never sent), and are never
  written to backups.
- Signing out removes the sign-in from this device and locks encryption. You choose whether to keep
  or remove the local copy of your data. "Delete my data from the server" erases what that server
  holds for your account; the operator's own backups are governed by the operator's policy.
- Account data held by the sync operator is limited to what the service needs to run: an account
  identifier, a device identifier, change timestamps and the change log (readable by the operator
  unless encrypted as described above). Like any web server it also sees your IP address.

### Files you create

Backups and exports are files you save yourself. StudyVault does not upload them anywhere. A backup
can be protected with a passphrase (AES-256-GCM); one without a passphrase is readable by anyone who
has the file. **A backup holds your study data, not your settings:** it does not contain your theme,
deny list, enabled sites, study-day settings, welcome-tour progress, the AI provider settings, key
and usage, the sync configuration, account and queue, your saved searches, or a review session that
is in progress, and it never contains the AI key, the sync sign-in or the sync encryption key.
Cached PDF copies are included only if you choose to include them. After restoring on a new profile
you set those up again.

**Restoring and importing.** A file is checked before anything changes: its structure, its size
limits (including what a ZIP claims to expand to, which is refused before anything is
decompressed), its checksums and every row.

- Checksums detect damage; they do not prove who made the file (a backup is not signed). Restore
  files you made or trust.
- "Merge" never changes the quote, the address and title it was saved from, how and when it was
  captured, or the other protected fields of an item you already have: it keeps your copy and lists
  the difference as a conflict. Items that are new to your vault are added with the values in the
  file. "Replace" takes the file's values as they are.
- AI results in a backup are re-checked against the passages in your vault. A result whose
  citations cannot be found is restored as unverified, with those citations removed; a result is
  never upgraded.
- Importing highlights from a Markdown or CSV file always creates sources of its own, marked as
  imported and needing your review. An imported highlight is never attached to a page you captured,
  and an address in the file is shown as a claim, not as a capture.
- Only one restore runs at a time. It stages the incoming data in a temporary database of its own
  inside the extension and removes it afterwards; a leftover of a crashed restore is removed by the
  next restore and by "Delete all StudyVault data".

**A copy StudyVault makes by itself.** Before an update that changes how data is stored, StudyVault
keeps one copy of your study data (not cached PDFs) in a database of its own, so that you can
restore it from Settings, Backup and restore. It is kept only when the data is small enough (about
64 MB uncompressed); otherwise Settings says that no copy was kept and asks you to save a backup
yourself. "Delete all StudyVault data" removes it.

## Permissions the extension holds

| Permission | What it is used for |
| --- | --- |
| `storage` | Keeps your settings on this device, and the small change markers described above. |
| `sidePanel` | Shows the StudyVault panel beside the page. |
| `contextMenus` | Adds three right-click items: "Save selection to StudyVault" (when text is selected on an http or https page) and two "Open in StudyVault reader" items, one on links and one on pages and frames, which appear only when the address looks like a PDF. |
| `activeTab` | Lets StudyVault work in the tab you are looking at, only when you ask it to. Access ends when you navigate away or reload. |
| `scripting` | Starts StudyVault's page script on tabs and sites you enabled. |
| `identity` (optional) | Not granted at install. Requested when you press "Turn on sync" in Settings, together with `alarms` and access to the sync server and sign-in provider, so the browser can run the sign-in page of the sync service you configured and hand the result back to StudyVault. Without it, sync cannot sign in. |
| `alarms` (optional) | Not granted at install. Requested at the same moment ("Turn on sync"), so StudyVault can schedule a periodic sync (every 15 minutes) while the browser is open. Nothing is scheduled while sync is off. |
| `https://*/*` and `http://*/*` (optional) | Not granted at install. Requested one site (origin) at a time, each from a click, for these separate purposes: (1) "always enable on this site", or all sites if you choose that in Settings, which is the only grant that lets StudyVault's page script start by itself on a site; (2) the web site that hosts a PDF you open in the reader (and a different site that the address redirects to, only if you allow it), handed back when the download ends unless you already had access to that site; (3) the AI provider address you enter; (4) the sync server, the sign-in provider, and the sign-in provider's token and revocation endpoints. Grants (2) to (4) are used only for requests StudyVault itself makes and never start the page script. |

**Revoking.** Sites you enabled are listed in Settings, Site access, where each can be removed. The
AI provider address can be removed with "Remove access" in Settings, AI assistance. Grant (2) is
handed back by the reader when the download ends (see "Opening a PDF from a web address"). Grant (4)
has no list in Settings and is not removed when you sign out or turn sync off: remove it on
Chrome's extension page (`chrome://extensions`, StudyVault AI, Details, Site access), or use
**Delete all StudyVault data**, which revokes every optional site grant. The optional `identity` and
`alarms` permissions cannot be revoked from Chrome's page (only the extension itself, or removing
the extension, can drop them); "Delete all StudyVault data" does not remove them. Both are inert
while sync is off.

StudyVault does not request the `tabs`, `history`, `bookmarks`, `cookies`, `webRequest` or `downloads`
permissions and cannot read your browsing history.

## What a website can learn about your use of StudyVault

A web page is untrusted code running in the same document StudyVault highlights. On a site where
StudyVault is active, scripts that **the site itself runs** can:

- see which passages of that page are highlighted, and each highlight's colour and kind (highlights
  are painted through the browser's shared highlight list, which the page can read);
- tell that StudyVault is running on the page.

They cannot read your notes, banks, settings or anything else StudyVault stores, and they cannot make
StudyVault save, change or send anything. Notes and bank names are typed in StudyVault's own panel,
not in the page, so the page cannot observe the keys you type. To avoid the first point on a site,
add it to the deny list or turn off "Show highlights on pages" in Settings.

## Retention and deletion

- Your data stays until you remove it. There is no automatic upload and no expiry.
- Deleting a highlight, note or bank moves it to the trash and keeps a recoverable copy on your
  device so Undo works. It is removed for good when you empty the trash or permanently delete items
  in the dashboard's Trash, or when you use **Delete all StudyVault data**.
  - Emptying the trash removes the item and what hangs off it in the same step: bank and tag
    links, notes on it, knowledge points, flashcards and review history made from it, every AI
    draft that used it as an input (not only the first), and its source page record when nothing
    else uses it. References to it as evidence inside knowledge points that stay are removed (a
    point that was marked supported only by it goes back to "not checked"). Purging a bank leaves
    its decks without a bank; purging a document removes its kept file and recognised text, and
    keeps the highlights made in it as quotes.
  - Sync records on this device: for an item that was never uploaded, every queued copy of it and
    every conflict or refused-change record that holds its text is removed, and only a deletion
    marker without content remains. For an item that was uploaded, the copies of it that the server
    already acknowledged are removed.
  - **What a purge does not reach:** a copy already uploaded stays on the sync server until you
    delete it there (a deletion marker is sent, not a request to erase history); an offline edit
    to an item that was already uploaded is still sent once, before its deletion marker, because the
    marker refers to it; an upload that was attempted but not yet acknowledged stays queued until it
    is; the sync bookkeeping that decides merges (logical clocks, truncated hashes of fields and,
    for tags, alias names) of a purged item is kept until a sync run prunes it, 90 days after the
    deletion at the earliest, so while sync is off it stays until you delete all data; the cached
    search index keeps the text until a page that hosts search rebuilds it (see "Search index"); and
    backups, exports and the automatic pre-update copy you may hold.
- **Delete all StudyVault data** (Settings, Your data) cannot be undone once it has started. It
  removes:
  - the StudyVault database (highlights, notes, banks, folders, tags, flashcards and decks,
    review history, documents, kept PDF copies, OCR text, AI drafts, the AI key, provider settings
    and usage, saved searches, the search index, all sync records, identity, configuration and
    encryption decision, and the private copy of your settings);
  - the automatic copy made before an update and every staging database of a restore (each restore
    uses its own, and a crashed one leaves its database behind), which are further full copies of
    the database;
  - everything in extension storage: settings, deny list, enabled sites, study-day settings,
    welcome-tour progress and the change markers, and session storage (sign-in tokens, the sync
    encryption key if one was unlocked, sync status);
  - every optional site grant the browser gave StudyVault, so the page script stops starting on
    those sites.

  The database is deleted first, and that request cannot be withdrawn. If another StudyVault
  window (a page or the side panel) still holds the data open, the deletion waits for it and
  finishes by itself when that window closes; until it has finished, reading and saving in this
  window fail with a message instead of hanging, and the other copies, the settings and the site
  grants are removed only after the database is gone. If you stop waiting, the deletion still
  completes by itself. The Settings page currently shows only "Deleting…" while it waits
  (`docs/PRIVACY_CLAIMS.md` U-1).
- **It does not remove:**
  - the copy a sync server holds for you (use "Delete my data from the server" in Settings, Sync,
    first; your data on the server is otherwise untouched);
  - files you exported or saved yourself (backups, exports): delete them yourself;
  - the dashboard display preferences kept in the extension page's local storage, and the optional
    `identity` and `alarms` browser permissions, if you had granted them. Removing the extension
    clears the preferences and the permissions.
- Removing the extension from the browser removes its stored data from that browser profile.
- If you used sync, deleting the server-side copy is done with "Delete my data from the server" in
  Settings, or through the operator of the sync service you used
  [USER-REQUIRED: describe how an account and its server-side data are deleted, and how long that
  takes].

## Your choices

Everything above can be inspected and changed in Settings: sites StudyVault may run on, the deny list,
private windows, whether highlights are painted, and the optional features. You can export your data
in open formats at any time. [USER-REQUIRED: if you offer the extension in the EEA, UK or California,
state the rights process and who handles requests.]

## Children

StudyVault is a study tool for general audiences and is not directed at children under 13.
[USER-REQUIRED: confirm the minimum age appropriate to your jurisdiction and audience.]

## Study content and health information

People use StudyVault to study, including medical and clinical material. What you save is yours, is
stored on your device, and is handled as described above. AI output is a study aid, not clinical
advice: verify it against authoritative references.

## Chrome Web Store limited use

StudyVault uses the information described above only to provide and improve the single purpose of
the extension: saving cited highlights and notes from web pages and PDFs and helping you review them.
It does not sell user data, does not transfer it to third parties except as part of a feature you
use (the reader requests a web PDF from the site that hosts it, which receives no study data; AI
help sends the text you approved to the provider you chose; sync sends your change log to the sync
server you chose and signs in through the provider you chose), does not use it for advertising or
for credit decisions, and no person reads it.

## Changes to this policy

Material changes will be described in the extension's release notes and in this document, and the
effective date above will change. [USER-REQUIRED: the public URL where this policy is hosted. The
Chrome Web Store form and the extension's Settings page must link to the same address.]
