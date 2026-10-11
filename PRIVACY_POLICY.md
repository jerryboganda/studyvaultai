# StudyVault AI - Privacy Policy

**Draft of 2026-10-11 for StudyVault AI 0.1.x.** Every statement below is backed by code or a test;
`docs/PRIVACY_CLAIMS.md` lists the evidence for each one. This is a plain-language policy, not legal
advice.

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
- Anything that leaves your device (AI help, cloud sync) is **off by default** and happens only after
  you switch it on and, for AI, after you have seen exactly what will be sent.
- You can export your data, and you can delete all of it from the Settings page.

## What StudyVault stores, and where

All of it is stored in your browser profile on your device: in the extension's database (IndexedDB)
and its extension storage (`chrome.storage`). None of it is uploaded in the default configuration.

| What | Details |
| --- | --- |
| Passages you save | The passage exactly as written (up to 10,000 characters), a simplified copy (lower case, single spaces) and a SHA-256 fingerprint of it, used to notice the same passage saved twice and for search. |
| Where it came from | The page address, the address the page declares as its own when it names the page itself, the page title (up to 500 characters) and the site name. Before an address is stored, a user name or password in it, query parameters named like a token, key, code, signature or session, and any `#fragment` that is not a page route are removed. Other parts of the address, such as tracking parameters, are kept as you visited. |
| How to find the passage again | Up to 64 characters of page text just before and just after the passage, the nearest heading above it (up to 300 characters), a short description of where it sits in the page structure, its position in the page text, and a hash and the length of the whole page text at the time you saved it. The hash and length only tell StudyVault that the page changed; the page text itself is not stored. |
| What you add | Your notes (up to 20,000 characters each), the kind, colour and priority you chose, the banks and folders a passage is in, tags and custom fields, how you saved it (toolbar, shortcut or menu) and when. |
| Study data | Flashcards and quiz questions you create, and the review history that schedules them. |
| Documents you import | If you open a PDF in StudyVault's own reader: its title, page count, a fingerprint of the file, the text found on its pages and the highlights you make. The PDF file itself is kept only if you choose to keep a copy. Text recognised by the optional OCR feature is stored with the document and can be corrected by you. |
| Settings | Theme, density, whether the toolbar shows, default kind, colours, your deny list, the sites you enabled, whether highlights are painted, highlight style, whether private windows may be saved, and which optional features are on. |
| Change markers | Random tokens written to extension storage so that open StudyVault windows know to refresh. They contain no data. |
| Short-lived hand-over | When you choose "Save and add a note", the id of that highlight and a time stamp are held in session storage until the side panel has used them. An entry older than 30 seconds is ignored and removed the next time the panel opens, and the browser clears session storage when it closes. |

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
  private window is visible from normal windows.

## What leaves your device

**In the default configuration, nothing.** StudyVault makes no network requests of its own. The
extension declares a content security policy that the browser enforces on its pages, and it contains
no analytics, advertising or telemetry code. All code ships inside the extension; none is downloaded.

Two optional features can send data off the device. Both are **off by default**, both explain what
they do before they start, and both can be switched off again.

### AI help (optional, off by default)

- You choose the AI provider and enter your own API key. [USER-REQUIRED: confirm that the shipped
  build lets users bring their own key and does not route requests through a StudyVault server; if a
  hosted service is offered, name the operator and describe its handling here.]
- When you ask for an AI action, StudyVault shows you **a preview of exactly the text that will be
  sent** and lets you edit or remove parts of it. Personal data and secrets that look like emails,
  phone numbers, account numbers or keys are marked for removal automatically; this detection is
  heuristic, so please read the preview. Only the passages and notes you selected are sent, never a
  whole page and never your browsing history.
- The request goes **directly from your browser to the provider you configured** over HTTPS. The
  provider's own privacy policy governs what it does with the text. StudyVault does not control that.
- Your API key is stored on this device in the extension's local storage, is sent only to the
  provider endpoint you configured, and is not written to logs. Anyone with access to your browser
  profile on this computer can read it; use a key with a spending limit.
- AI results are stored on your device, separately from your quotes and notes, and are labelled
  **unverified**. They never overwrite a quote or a note.

### Sync (optional, off by default)

- Sync copies your study data between your own devices through a sync server. It runs only after you
  switch it on and sign in. [USER-REQUIRED: name the operator of the sync service and its location, or
  state that users point the extension at a server they run themselves.]
- What is uploaded is a log of changes to these data categories: banks, folders, tags, sources,
  highlights and which banks and tags they are in, notes, study points, flashcards, review history,
  document titles and corrected OCR text. Settings, imported PDF files and your AI keys are not
  synced.
- Content can be encrypted on your device before it is uploaded, with a key derived from a passphrase
  that only you know: then the server operator cannot read it, and if you lose the passphrase nobody
  can recover the data. [USER-REQUIRED: confirm that encryption ships and is on by default and that
  Settings states, before the first upload, which server will be used and whether content is
  encrypted. If it does not ship, delete this bullet and say plainly that the server can read synced
  content.]
- Signing out removes the sync credentials from this device. You choose whether to keep or remove the
  local copy of your data.
- Account data held by the sync operator is limited to what the service needs to run: an account
  identifier, a device identifier, change timestamps and the (encrypted) change log.

### Files you create

Backups and exports are files you save yourself. StudyVault does not upload them anywhere. A backup
can be protected with a passphrase; one without a passphrase is readable by anyone who has the file.

## Permissions the extension holds

| Permission | What it is used for |
| --- | --- |
| `storage` | Keeps your settings on this device. |
| `sidePanel` | Shows the StudyVault panel beside the page. |
| `contextMenus` | Adds "Save selection to StudyVault" to the right-click menu. |
| `activeTab` | Lets StudyVault work in the tab you are looking at, only when you ask it to. Access ends when you navigate away or reload. |
| `scripting` | Starts StudyVault's page script on tabs and sites you enabled. |
| `identity` (optional) | Not granted at install. Requested only when you turn on sync and press sign in, so the browser can run the sign-in page of the sync service you configured and hand the result back to StudyVault. Without it, sync cannot sign in. |
| `alarms` (optional) | Not granted at install. Requested only when you turn on sync, so StudyVault can schedule a periodic sync while the browser is open. Nothing is scheduled while sync is off. |
| `https://*/*` and `http://*/*` (optional) | Not granted at install. Requested one site at a time when you choose "always enable on this site", or for all sites if you choose that in Settings. You can revoke them in Settings or on the browser's extension page. |

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
- Deleting a highlight, note or bank moves it out of sight and keeps a recoverable copy on your device
  so Undo works. It is removed for good when you empty the trash (where offered) or when you use
  **Delete all StudyVault data** in Settings.
- **Delete all StudyVault data** deletes the database, the settings and session state, and withdraws
  the site access the browser granted. It cannot be undone. Files you exported earlier are not
  touched; delete them yourself.
- Removing the extension from the browser removes its stored data from that browser profile.
- If you used sync, deleting the server-side copy is done through the sync service
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
It does not sell user data, does not transfer it to third parties except as part of an optional
feature you switch on (AI help sends the text you approved to the provider you chose; sync sends your
change log to the sync service you chose), does not use it for advertising or for credit decisions,
and no person reads it.

## Changes to this policy

Material changes will be described in the extension's release notes and in this document, and the
effective date above will change. [USER-REQUIRED: the public URL where this policy is hosted. The
Chrome Web Store form and the extension's Settings page must link to the same address.]
