# ADR-026: Chat context budget, quota, optional smart search, UBAG access modes

**Status:** accepted · **Date:** 2026-10-16 · Extends ADR-024 and ADR-025.

## Decisions
- **Context budget.** A chat request is trimmed to `min(10,000 tokens (the engine's limit), 60 % of the
  model's window)` before it is previewed: lowest-ranked passages first, then the oldest earlier
  turns two messages at a time; the question and the memory summary are never cut. What was left out
  is said in the chat, the header shows how full the last request was, and the exact text sent is
  still the previewed text. Windows come from `contextWindowTokens` (a cautious table; unknown = 8k).
  Long earlier turns (over 9,000 characters) are folded into the summary sooner.
- **Quota.** The daily request limit already counts every provider call, summaries and the optional
  smart-search call included. The chat header shows "N AI requests left today", and Send is disabled
  with the reason when none is left. No second counter: one limit, honestly shown.
- **No schema bump for scale.** `listAiResults({kind})` now reads through the existing `kind` index,
  so a long chat no longer reads every other AI result. A new `threadId` index (db v6, backup
  migration chain, restore guard) would add risk for no measurable gain at this size; the first 30
  turns show and the rest load on request. Revisit if a vault holds tens of thousands of turns.
- **Optional smart search** ("Let the AI suggest search words", off by default): one extra request
  carrying only the message (no notes, no earlier turns), through the same pipeline, consent,
  redaction and budget; the words are used locally and the helper result is not kept as a turn.
- **Refresh memory** rebuilds the summary on request from every turn except the newest three.
- **Accessibility.** The streamed answer sits outside the live region; one polite line announces
  that the answer has arrived.
- **UBAG access modes.** The UBAG preset offers "Username and password" (HTTP Basic, the shared
  operator login) or "Personal access token" (Bearer). On the project's VPS the nginx template gained
  a `location ^~ /v1/openai/`: `auth_basic` is switched off per request when the caller sends its own
  `Authorization: Bearer ...` (the gateway validates that token; the gateway secret is not injected),
  Basic callers behave exactly as before, requests are limited to 30/min per address (burst 20), and
  every other route (dashboard, jobs, artifacts) stays behind the Basic login. The change lives on the
  server (`deploy/small/nginx-dashboard/default.conf.template`, backup `*.bak-peruser-*`), not in this
  repository; tokens are issued with `POST /v1/auth/pat` (role `service`, 90 days, app id
  `studyvault-ext`).

## Verification
Unit tests for trimming, quota, windows, summaries, the Codex sign-in component and runtime;
Playwright (real Chromium, loaded extension) against a local fake of the UBAG facade: Basic, Bearer,
model list, thinking level, 504 rejoin, add-another-provider, per-chat provider with a new consent,
match by meaning. The live gateway was exercised with `scripts/smoke-ubag.mjs` and curl.
