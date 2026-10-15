# ADR-024: Chat as a conversation: general chat, saved threads, rolling memory

**Status:** accepted · **Date:** 2026-10-16 · Extends ADR-013 section 3 (chat) and ADR-023.

## Context
"Chat with your notes" was a strict one-shot: find passages, tick them, press Send. It refused to
send without matching passages, kept nothing after a reload and had no notion of memory. The owner
asked for a real assistant: usable with no study material, with memory, cross-referencing the vault.

## Decision
- **New task kind `chat`** (`packages/ai`). `minChunks: 0`: a conversation may carry no passage.
  Output `{answer, basis: notes|mixed|general, evidence[]}`. Quotes are still grounded verbatim
  (`groundClaims`); `finalize` downgrades `basis` to `general` when no citation can be found and to
  `mixed` when only some are. The system prompt for this kind replaces rule 5 ("only the data blocks")
  with "use relevant blocks and cite them, otherwise answer from general knowledge and say so".
  Results stay `unverified`; nothing here can change a saved quote or note.
- **Context blocks** (never citeable, untrusted, redacted like everything else): up to 12 earlier
  messages (`history_N`, 2000 chars each) and a `memory` block (rolling summary, 4000 chars).
- **Threads** (`packages/storage/src/chat.ts`, no schema bump): turns are `aiResults` rows (kind
  `chat`, `threadId`), so they are backed up, restored and purged with the vault. Title, summary and
  the per-thread agreement live in the `meta` row `aiChatThreads`; a restored thread without a meta
  row is listed with defaults and asks for agreement again. Deleting a thread deletes its turns.
- **Rolling summary:** when more than 6 turns are not yet summarised, all but the newest 3 are
  summarised by one more `chat` request (same pipeline, consent, budget and redaction); the summary
  is stored on the thread, the helper result is not kept as a turn.
- **Retrieval:** every message searches the person's own index on this device (scope, tag and the
  previous message's words for follow-ups), offers up to 10 passages and sends them as cited sources.
  "Use my notes" off, or no match, is simply a general conversation.
- **Consent:** the per-message preview dialog is replaced, for chat only, by a one-time agreement per
  conversation that shows the exact text of its first message, the recipients and the redaction
  count. Redaction, the daily budget, the origin guard, `redirect:'error'` and the consent token
  (created from the same preview in the same action) are unchanged; every answer shows how many notes
  were sent with it.

## Consequences
- The conversation is now stored on the device and in backups (PRIVACY_CLAIMS P20b changes).
- The per-message "tick each passage" review is gone for chat; the other AI actions keep it.
- Summaries and general answers are model output: labelled unverified, never evidence.
