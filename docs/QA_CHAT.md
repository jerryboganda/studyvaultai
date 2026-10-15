# Manual QA: AI providers and Chat

Run after loading the built extension (`chrome://extensions`, Developer mode, Load unpacked). CI
covers the same flows against fakes; this list is for a real Chrome and real providers. Record the
result of each line (pass / fail / not run) and the build id.

## Providers
- [ ] AI settings, Set up AI: UBAG card shows; credentials `user:password`; "Load model list" fills the
      model suggestions; Save and test answers `OK`.
- [ ] Reasoning/thinking dropdown is disabled with a reason where the model has none.
- [ ] Add another provider: same steps; it appears under "Backups, tried in order"; at most three.
- [ ] ChatGPT Codex (experimental): Sign in opens a tab; the address `localhost:1455` is detected or can
      be pasted; "Check ChatGPT quota" shows real windows; Sign out removes the tokens.
- [ ] OpenRouter: "Check OpenRouter usage" shows spend.
- [ ] Permission prompt appears once per provider origin; "Remove access" works.

## Chat
- [ ] With an empty vault: ask a general question; the first message asks once and shows the exact text.
- [ ] Second message does not ask again; it carries the earlier turn (memory).
- [ ] With notes: relevant highlight, note, flashcard and knowledge point are cited word for word;
      "N of your notes were sent" matches.
- [ ] Scope: choose a bank and a tag; cards from other banks are not offered.
- [ ] Switch provider in the header: asks once more; the answer comes from that provider.
- [ ] Reasoning effort dropdown changes the request (check the provider's dashboard or logs).
- [ ] Streaming providers show "answer so far"; Stop cancels and saves nothing.
- [ ] UBAG: a slow answer shows the elapsed timer; after 4 minutes the request is joined again, not
      restarted (the gateway dashboard shows ONE job).
- [ ] Memory panel: edit and clear; rename; Download .md; Save as a note.
- [ ] Reload the page: conversation list and turns persist; delete a conversation removes its turns.
- [ ] Two dashboard tabs: a message in one is visible in the other after refresh; no duplicate turns.
- [ ] Offline: chat explains it needs a connection and sends nothing; the rest of the app works.
- [ ] Backup then restore: turns are back; each conversation asks consent again.
- [ ] Settings, Your data, Delete all AI data: conversations and tokens are gone.
