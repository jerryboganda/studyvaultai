# ADR-013: AI provider router, three more task kinds and chat with your notes

**Status:** accepted · **Date:** 2026-10-11 · Extends ADR-009 (egress) and ADR-010 section 10 (AI results).

## Context
The optional AI feature had one provider, nine task kinds and no way to ask a question across a bank.
Three things were requested, none of which may weaken what the single-provider design guarantees: the
consent token binds the exact previewed payload, redaction runs first, quotes are verified verbatim,
results are `unverified` until accepted, the key is in IndexedDB `meta` only and no request leaves
before consent or past the daily budget.

## Decision

### 1. Provider router (`packages/ai/src/pipeline.ts`, `deps.ts`; settings in `packages/storage/src/ai.ts`)
- **Profiles.** The top-level fields of the `aiSettings` row stay the primary provider. `fallbacks` is
  an ordered list of at most three more providers (`AiProfileSchema`: id `p-xxxxxxxx`, label, provider
  type, address, model, JSON mode, token parameter, own price list, `fallback` flag). `routes` maps a
  task kind to the provider it STARTS with (`primary` or a profile id). The chain of a task is: that
  provider, then every other provider whose `fallback` flag is on, in list order, that is set up (address
  valid, model set, key present or not needed). A provider that is not set up is skipped and named in the
  consent dialog; if the FIRST one is not set up the request is blocked, by name.
- **Where it lives.** `PipelineDeps.fallbacks` (`FallbackTarget`: provider + its own pricing). The
  engine's `callWithRetry` walks the chain; nothing about HTTP is in the router.
- **When a provider hands over.** Only on `network`, `server_error` (5xx and an unreadable gateway
  answer) and `timeout`, after the provider's own attempts (the retry policy, capped at 2 while another
  provider follows, so a hung endpoint costs minutes, not a quarter of an hour). Never on `auth`
  (401/403), `quota_exhausted` (402, 429 with an exhausted account), `rate_limited` (a plain 429 is
  retried with Retry-After on the same provider and then fails: another origin is not a remedy for "slow
  down"), `bad_request`, `refused`, `output_truncated`, `invalid_output`, `budget_exceeded`, `aborted`.
  `failsOver(code)` is the one place this is decided and `router.test.ts` pins it as a table of HTTP
  statuses and of error codes.
- **Repair.** A malformed answer is repaired by the provider that gave it (the repair call continues
  from the provider that answered; it can still hand over on a network failure, never backwards).
- **Ledger.** Every attempt on every provider is counted (`tally.requests`), failures included, each
  provider's tokens priced by its own price list; `Usage.estimatedCostUsd` is `null` as soon as a provider
  of the chain has no prices. Before another provider is tried the daily budget is checked again
  (`chain.gate`): a fallback is another request and goes out only while the budget has room
  (`budget_exceeded`, with the attempts already made in `budgetAfter`). A cost estimate in the preview
  is the upper bound over the chain (highest input price and highest output price), `unknown` when any
  provider has no prices.
- **Consent covers the chain.** `AiRequestPreview.recipients` lists every provider that may receive the
  text and the consent hash includes them (only when there are fallbacks, so single-provider hashes are
  unchanged). A provider added, removed or reordered after the preview is `consent_mismatch`; every
  provider sees byte-identical messages, the previewed ones. The dialog shows every address (origin, model,
  key state) before Send, says which failures do and do not move on, and the button names the fallback
  count. The result records the provider and model that ANSWERED (`AiResult.provider/model`).
- **Permission per origin.** One `permissions.request({origins})` lists every origin of the chain, as the
  first await of the click; already granted ones are not asked again; a refusal sends nothing. Each
  provider's `fetch` is guarded to its own origin. Options > Site access labels every AI address.
- **Keys.** One more `meta` row, `aiProfileKeys`: `{ [profileId]: { apiKey, origin } }`, same containment
  as `aiKey` (extension-origin IndexedDB, bound to the origin it was saved for, read only through
  `getAiProfileApiKey`, never in a result, backup, export or sync row because `meta` is none of those).
  `AI_SECRET_META_KEYS` now lists both. Removing a provider removes its key and its routes in the same
  transaction (`updateAiSettings`, a read-modify-write so the primary form and the provider list never
  overwrite each other); "Delete all AI data" and "Delete all data" remove the row. No Dexie schema
  change (meta rows are free-form): no migration, no backup-registry entry, `meta` stays local-only.

### 2. Task kinds `mnemonic`, `short_viva`, `study_outline` (`schema.ts`, `tasks.ts`)
Defined exactly like the existing kinds: strict Zod output, instructions + shape in `tasks.ts`,
evidence `{quoteId, text}` grounded verbatim, `unverified` until accepted, `TEMPLATE_VERSION` bumped
(`sv-ai/2026-10-11.2`: cached answers of the old prompts are not reused).
- `mnemonic`: 1 to 5 aids, each with the fact it anchors, the aid, how it maps and 1 to 2 quotes. The
  stored output carries `aidNotFact: true`, written by the pipeline (a model that sends the key is out of
  format), plus the fixed `MNEMONIC_NOTICE`; the card shows the vault's quote first and then the aid under
  a "Memory aid, not a fact" badge; accepted, it becomes a marked note, never a card or a knowledge point.
- `short_viva`: 1 to 5 questions (the prompt asks for 3 to 5 and for fewer when the sources cannot support
  three; the schema allows fewer rather than forcing invention), each with a model answer and its quotes.
- `study_outline`: a title and a flat list of items with `level` 1 to 3 (no recursive schema); the first
  item is level 1 and a level never jumps by more than one (a semantic issue, so the single repair call
  handles it), each item cited.
Restore re-grounding (`restoreGuards.ts`) is path-based and needed no change.

### 3. Chat with your notes (`packages/ai/src/retrieve.ts`, `packages/ui/src/ai/chat.ts`, `entrypoints/dashboard/Chat*.tsx`)
- A chat turn is an `explain` request: the question, the retrieved passages as data blocks, optionally
  earlier turns. No new kind, no new schema: `answerState: insufficient_sources` is "cannot answer from
  your notes", an answer without a grounded citation is downgraded to it, and an invented quote is
  `unsupported` and flagged. `AiSelection.history` (at most 6 messages, `explain` only) adds blocks
  `kind="history"` (ids `history_N`, reserved, never citeable, redacted like any passage).
- **Retrieval is local.** The question's content words (`contentTokens`: lower-case letters and digits,
  so no search operator can come out of it) become `(a OR b OR c)` plus the scope tokens of the search
  grammar (`bank:"X"`, `folder:"Y"`, `tag:"Z"`, built with the dashboard's own `toSearchQuery`) and run
  against the dashboard's `@search` index. Only ids come from the index; the text is read from the vault
  (`resolveAiSources`), so what is offered and cited is the immutable quote or the note body, and
  something deleted since the index was built is not offered. At most 8 passages and 15,000 characters.
  Nothing is sent at this step; no match means no request and the view says so.
- **Preview.** The consent dialog lists the passages and the earlier turns, each with a checkbox (the two
  newest turns start ticked), above the exact outbound text, which is rebuilt on every change; with none
  ticked Send is disabled with the reason. The history lives in the page's React state only: reloading
  clears it, "Clear this conversation" clears it, and a turn leaves the device only while ticked and then
  only inside the previewed text. Each answer is stored as an ordinary AI draft (purge cascade, ledger,
  "Delete all AI data" apply) and shown with `AiResultCard`.
- **Entry points.** Dashboard view `chat` (nav, command palette, `?view=chat&bank=<id>`) and a "Chat (AI)"
  button per bank in the side panel's Banks tab (disabled with the reason while AI is off).

### 4. Laziness and size
Nothing new loads unless the feature is on: the chat view (`ChatView`) is a `lazy()` chunk behind a gate
that reads only the settings flag, the provider list (`AiRoutingSection`) is a `lazy()` chunk inside the AI
settings section, and the side panel now fetches the AI engine and screens (`HighlightAiActions`, the
~68 KB `ai` chunk) when a card's "AI drafts" is opened instead of on every panel start. Measured with
`scripts/build-e2e.mjs` (same code and minification as the production build) on a `git archive HEAD` copy
with and without this change: total (non-OCR) +44.0 KB (6486.9 -> 6530.9), of which `AiRoutingSection`
+13.1 and `ChatView` +5.2 are on-demand, the shared `ai` chunk +9.6, `src` +7.2, `background.js` +3.7,
`dashboard` +1.5, `sidepanel` +0.9 and +3.3 for the dynamic-import runtime. The content script does not
change. The options page still loads the `ai` chunk with the page (its switch and explanation live in
the same module as the provider form; splitting them is a follow-up).

## Consequences
- The consent text and the settings page now say that an AI request can reach more than one address,
  which ones, and which failures move it on; docs/PRIVACY_CLAIMS.md P20 and P22 and the AI rows of
  SECURITY_PRIVACY.md must say "every configured provider" where they say "the endpoint".
- A fallback means a request can reach a second origin without a second click: that is consented once,
  for the exact list, in the dialog the person confirms; changing the list invalidates the confirmation.
- `rate_limited` does not fall over. A person who wants "any provider that answers" gets that for network,
  5xx and timeouts only; the 429 case waits or fails with the wait shown.
- The model-side limits are unchanged: a model that ignores the instruction to answer only from the
  passages is caught only through its citations (deterministic, verbatim), not through its prose.

## Not done, and why
- Order of the PRIMARY provider cannot be changed from the list (route a task to another provider, or
  swap the fields); a fallback can be moved up or down.
- No streaming, no per-task model parameters, no automatic model discovery (the person pastes the model id).
- Retrieval is lexical (the existing index); there is no embedding search (ROADMAP: out of scope).
- Chrome's own permission prompt for a second origin is not driven by the e2e suite (the e2e build holds
  loopback host permissions); the single `permissions.request({origins})` call is unit-tested.

## Amendment 1 (2026-10-12): the Anthropic provider kind has an e2e spec
The Messages API adapter (`createAnthropicProvider`: `x-api-key`, `anthropic-version`, the system text in
the top-level `system` field, the provider's `usage` in the ledger) was already in `@ai`. What changed is
its evidence and one classification: an empty account answers `400 invalid_request_error` whose only
tell is the message ("credit balance is too low"), which `classifyHttp` now reads as `quota_exhausted`
(not retryable, the text never shown). `tests/e2e/ai-anthropic.spec.ts` (four tests: the preset and the
key, a request and its ledger, every failure, and Anthropic as a fallback behind an OpenAI-compatible
provider) and `tests/e2e/backup-secrets.spec.ts` (no key, fallback key or AI setting in a plain or an
encrypted backup) ran and passed in Actions run 38186957997 on Ubuntu and Windows. **Both run against a
local stand-in in `tests/e2e/aiServer.ts` that enforces the published request shape: no live provider
was contacted and the repository holds no key** (docs/PRIVACY_CLAIMS.md P20d, manual row MT-67).
