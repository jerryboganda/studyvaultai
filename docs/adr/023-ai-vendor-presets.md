# ADR-023: AI vendor presets, reasoning effort and the ChatGPT (Codex) login

**Status:** accepted · **Date:** 2026-10-16 · Extends ADR-009 (egress), ADR-013 (router).

## Context
The AI settings knew two wire protocols and five picture cards. Requested: UBAG (browser gateway),
NVIDIA NIM, OpenCode Go, OpenRouter and a ChatGPT (Codex) subscription login, each with a model
dropdown and a reasoning-effort dropdown, without weakening consent, redaction, key containment or the
per-origin host permission.

## Decision
- **Protocols stay few.** `openai_compatible` and `anthropic` are unchanged; `codex_responses` is added
  (primary provider only). Vendors are *presets*: `vendor`, `reasoningEffort` and `authScheme` are stored
  with the provider (defaults make old rows load without a migration; `readSettings` is tolerant).
- **Registry** `packages/ui/src/ai/vendors.ts`: address, auth scheme, how effort is sent
  (`reasoning_effort` for OpenAI/NIM/OpenCode Go, `reasoning:{effort}` for OpenRouter, none for UBAG),
  curated models and a live `GET /models` list. The list is only fetched on a button press, after the
  per-origin permission, with the typed or saved key; failure falls back to the curated list.
- **UBAG.** `https://<host>/v1/openai/*` is OpenAI-compatible, synchronous (<= 240 s) and not streaming.
  A thinking level is its own model id (`target|Medium`), so the effort dropdown swaps the model id.
  The public host sits behind HTTP Basic auth (one shared operator credential = one tenant): the key
  slot holds `user:password` and is sent as `Authorization: Basic`. Per-user isolation needs a
  per-user bearer route on the gateway (not part of this change). Request deadline is raised to 270 s.
- **Codex login (unofficial).** PKCE authorization-code flow against `auth.openai.com` with the public
  Codex CLI client and the `localhost:1455` redirect; the callback is read from the opened tab (needs
  the optional `http://localhost/*` host permission) or pasted. Tokens live in IndexedDB `meta` row
  `aiCodexAuth` (an `AI_SECRET_META_KEYS` entry: never in backups, exports or sync) and are refreshed
  before expiry. Requests go to `chatgpt.com/backend-api/codex/responses` (SSE, assembled in the
  adapter). Quota comes from `chatgpt.com/backend-api/wham/usage`. Endpoints and the client id can
  change without notice; every failure is surfaced, never guessed around.
- **Not changed:** CSP (`connect-src https:` already covers the new origins), consent token, redaction,
  `redirect:'error'`, `credentials:'omit'`, origin-guarded fetch.

## Consequences
- Four cloud origins and the ChatGPT origins are new egress destinations, each behind its own
  optional-permission prompt and listed in every confirmation.
- Reasoning effort is a request hint: providers that reject the parameter return a normal error.
- Live behaviour of NIM, OpenCode Go, OpenRouter and the Codex backend is not exercised in CI (no
  credentials); unit tests use recorded-shape fakes.
