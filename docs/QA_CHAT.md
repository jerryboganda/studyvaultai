# Manual QA: AI providers and Chat

## Run record (2026-10-16, build from commit on `feat/ui-redesign`)
| Check | How | Result |
| --- | --- | --- |
| UBAG gateway lists models and answers (Basic) | `scripts/smoke-ubag.mjs` against the live gateway | pass: models 200 in 0.8 s, chat 200 in 10.6 s, reply `OK` |
| UBAG personal access token on `/v1/openai/*` | curl against the live gateway after the nginx change | pass: models 200, chat 200 in 13 s; `/v1/jobs` with the token stays 401 at the edge; bogus token gets the gateway's JSON 401 |
| Shared Basic login still works, old password rejected after rotation | curl | pass |
| Wizard, Basic/Bearer, model list, thinking level, 504 rejoin, add provider, provider switch consent | Playwright, real Chromium, loaded extension, local fake gateway (`tests/e2e/ai-ubag.spec.ts`) | pass locally (4 of 4); CI run recorded in the commit |
| Match by meaning finds a paraphrase, off = no note | Playwright (`ai-extras.spec.ts`) | pass |
| ChatGPT sign-in, refresh, refusal, sign-out | component and runtime tests with fakes | pass; **not run against a real ChatGPT account** |
| Everything below | manual, by the owner | not run by the assistant |


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
