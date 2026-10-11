# StudyVault sync server (reference implementation)

A small, dependency-light implementation of the optional sync protocol, built on `node:http` and `zod`.
It exists to define and test the protocol, to run locally, and to be the contract a production service
must meet. **There is no hosted StudyVault service.** Nothing in the extension talks to any server
unless the user turns on `Settings.features.sync`, signs in, and points the extension at a server
that somebody operates.

It is deliberately not production-complete: one process, an in-memory or JSON-file store, no
migrations, no horizontal scale. Section 5 lists exactly what has to be provided to run it for real.

## 1. Run it locally

Node 22.18 or newer runs the TypeScript directly (Node 22.6 to 22.17 need
`--experimental-strip-types`). Dependencies: only `zod`, which is in the repository's lockfile.

```bash
pnpm install --frozen-lockfile
SV_DEV_TOKENS="dev-token-0123456789=me@example" SV_PORT=8787 node server/src/main.ts
curl -s localhost:8787/v1/health
curl -s -H "Authorization: Bearer dev-token-0123456789" "localhost:8787/v1/ops?limit=10"
```

Tests (these are what the claims below rest on):

```bash
pnpm exec vitest run server packages/sync
```

The server imports the protocol schemas from `packages/sync/src/schema.ts`, `hlc.ts` and `json.ts`
(zod only), so the wire format has exactly one definition. Deploy from a checkout that contains
`packages/sync/src/` next to `server/`, or copy those three files and `zodConfig.ts` beside it.

## 2. Protocol

All bodies are JSON. Every route except `health` needs `Authorization: Bearer <access token>`.

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | Liveness. No auth. Returns only status, protocol version and time. |
| `POST /v1/ops` | Push up to 100 operations. Per-operation result: `accepted`, `duplicate` or `rejected` with a code. |
| `GET /v1/ops?since=<cursor>&limit=<n>` | Pull in server order. `limit` is capped (500) and so is page size in bytes. |
| `GET /v1/e2ee/profile` | The public key profile (salt, KDF cost, key check). 404 until created. |
| `PUT /v1/e2ee/profile` | Create the first profile (version 1). Refuses anything under 600,000 PBKDF2 rounds. |
| `POST /v1/e2ee/rotate` | Atomically replace the profile and re-encrypt every stored payload. Only at version + 1, only if the whole log is covered. |
| `DELETE /v1/data` | Erase everything held for the caller. Needs `{"confirm":"delete-all-my-data"}`. |

Behaviour that clients rely on:

- **Idempotent push.** An operation is identified by `(user, idempotencyKey)`. Replaying it returns
  `duplicate` with the original cursor and appends nothing. Reusing a key for different content is
  rejected (`idempotency_conflict`). One invalid operation never fails the batch.
- **Cursors.** Dense integers per user, returned as strings, opaque to clients. A `since` ahead of the
  server's head is `410 cursor_expired`.
- **Epoch.** Every push and pull response carries `epoch`, an identifier of the current generation of
  that user's data. It changes when the data is erased. A device that remembers another epoch stops and
  asks the user (`resync_required`) instead of uploading into a server that no longer knows its history.
- **Clock guard.** Operations stamped further ahead of server time than `SV_MAX_FUTURE_SKEW_MS`
  (default 24 h) are rejected (`hlc_in_future`): one device with a wrong clock cannot make its edits win
  everything forever.
- **Errors** are `{"error":{"code","message","retryAfterMs?"}}` with a matching HTTP status. Rate limits
  send `Retry-After`.

## 3. Security properties (and the test that shows each)

| Property | Where it is enforced | Test |
| --- | --- | --- |
| Tenant isolation: user A can never read or write B | The store interface takes the authenticated user id in every method and has no cross-user query; the id comes only from the verified token | `app.test.ts` "user A can never read or write user B", `store.test.ts` contract |
| Idempotent replays, no double append | `(user, idempotencyKey)` index + content hash | `app.test.ts`, `store.test.ts` |
| Size limits | Body streamed against `SV_MAX_BODY_BYTES` (413, connection closed); per-operation 256 KiB; 100 operations per push | `app.test.ts` |
| Malformed input | Bad JSON 400, wrong content type 415, schema failure 400, bad cursor 400 | `app.test.ts` |
| Auth failures | Missing, malformed or unknown token is 401 with `WWW-Authenticate: Bearer`; the 401 body reveals nothing | `app.test.ts` |
| Rate limits | Per address (before any token work) and per user, with `Retry-After` | `app.test.ts` |
| Token verification | Static development tokens, constant-time compare; or OIDC JWT access tokens (RS256/ES256 only, `none` and HMAC refused, `iss`/`aud`/`exp`/`nbf`/`sub` checked, JWKS cached with flood protection) | `auth.test.ts` |
| Fail-closed configuration | No auth configured, public bind without a TLS proxy, wildcard CORS, dev tokens under `NODE_ENV=production`: the process exits with a reason | `config.test.ts`, `process.test.ts` |
| Durable and corruption-safe file store | fsync per append, torn tail discarded, real corruption makes that user's requests fail instead of serving a partial log, directories named by digest | `store.test.ts` |
| No secrets or content in logs | Logs carry route, status, latency and a truncated digest of the user id; never tokens, bodies or ids | `app.test.ts` "never logs" |
| Works end to end | The real client engine and HTTP transport against this server over a socket, including E2EE and rotation | `integration.test.ts` |

### Why CSRF does not apply

The API authenticates with a bearer token in the `Authorization` header and sets no cookies. Browsers
never attach such a header on their own, so a page on another site cannot make a request that carries
a user's credentials. CORS is an allow-list of exact origins (`SV_CORS_ORIGINS`, for example
`chrome-extension://<extension id>`); it is never `*` and `Access-Control-Allow-Credentials` is never
sent. A request with an `Origin` that is not on the list is refused (403). If a cookie-based web
dashboard is ever added to this service, it needs its own CSRF defence (SameSite cookies plus a token);
this API must not start accepting cookies.

### What the server can and cannot see

- **Without E2EE** (the default when sync is on): the operator can read every payload. TLS protects it in
  transit and the database can be encrypted at rest, but that is *not* end-to-end encryption and the
  client never calls it that.
- **With E2EE** (the user chose a passphrase): payloads are AES-256-GCM ciphertext. The key is derived on
  the device (PBKDF2-SHA-256, 600,000 rounds) and never sent; the server stores only salt, cost and a
  check value. The server still sees entity type and id, operation type, revision, clock, sizes and
  timing. Server-side AI cannot read E2EE data. Decrypted passages reach an AI provider only through the
  separate, explicit AI consent in the extension.
- Anyone who obtains a database backup can attempt offline guessing of the passphrase (the key check
  value allows it, as does any ciphertext). The cost is the KDF; the answer is a strong passphrase.

## 4. Configuration (environment only)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SV_HOST` / `SV_PORT` | `127.0.0.1` / `8787` | Listen address. A non-loopback host needs `SV_BEHIND_TLS_PROXY=1`. |
| `SV_BEHIND_TLS_PROXY` | unset | Declares that TLS is terminated in front of this process. |
| `SV_OIDC_ISSUER`, `SV_OIDC_AUDIENCE`, `SV_OIDC_JWKS_URI` | unset | Production token verification (all three). |
| `SV_DEV_TOKENS` | unset | `token=userId,...` (tokens 16+ chars). Development only; refused when `NODE_ENV=production`. |
| `SV_CORS_ORIGINS` | empty | Comma-separated exact origins. |
| `SV_STORAGE` / `SV_DATA_DIR` | `memory` | `file` needs a directory (mode 0700). |
| `SV_MAX_BODY_BYTES` | 2 MiB | Request body cap. |
| `SV_RATE_USER_PER_MIN` / `SV_RATE_IP_PER_MIN` | 120 / 600 | In-process fixed-window limits. |
| `SV_QUOTA_BYTES` | 256 MiB | Per-user stored bytes. |
| `SV_MAX_FUTURE_SKEW_MS` | 24 h | Operation clock guard. |
| `SV_TRUST_PROXY` | unset | `1`: client address from the last `X-Forwarded-For` entry (one trusted hop). |

There are no secrets in the code or the repository, and none have defaults.

## 5. Deployment checklist: what you must provide

The repository ships the protocol, the reference server and tests. Running this for real requires
decisions and resources that are not in it. Each box is something a person has to do or supply.

**Hosting and runtime**
- [ ] A host or platform that runs Node 22.18+ (or 22.6+ with the flag) as a supervised, restarting process.
- [ ] Exactly one instance, unless the store below is replaced by a database with per-user transactions
      (cursor assignment is serialised in-process here).
- [ ] A domain name for the API and a `https://` origin for it.

**TLS**
- [ ] TLS termination in front of the process (reverse proxy, load balancer or platform) with a valid
      certificate, HSTS, and `SV_BEHIND_TLS_PROXY=1`. The process itself speaks plain HTTP and refuses
      a public bind otherwise.
- [ ] Proxy-level request limits and timeouts as the outer fence (this server's limiter is per process).

**Identity (OIDC provider)**
- [ ] A provider that issues JWT access tokens (RS256 or ES256) and publishes a JWKS: a hosted service
      or one you run. Account creation, password policy, MFA, recovery and deletion of identities are
      the provider's job; the sync server only reads `sub`.
- [ ] A public client registration (no secret) for the extension: authorisation-code with PKCE, redirect
      URI `https://<extension id>.chromiumapp.org/<path>` (`chrome.identity.getRedirectURL()`), scope
      `openid` (+ `offline_access` if refresh tokens are wanted).
- [ ] The access token's `aud` set to a value you choose, configured as `SV_OIDC_AUDIENCE`; the issuer
      and JWKS URI configured as `SV_OIDC_ISSUER` and `SV_OIDC_JWKS_URI`.
- [ ] Token lifetimes decided (short access tokens; refresh policy). The extension keeps tokens only in
      session-scoped storage and drops them on sign-out.

**Database (production)**
- [ ] A transactional database implementing the `OpStore` interface in `src/store.ts`. A PostgreSQL
      sketch: `ops(user_id, cursor bigint, id, idempotency_key, hash, op jsonb, bytes, primary key
      (user_id, cursor), unique (user_id, idempotency_key))`, `user_state(user_id primary key, epoch,
      head)`, `key_profile(user_id primary key, profile jsonb)`; assign cursors with a row lock on
      `user_state`; add row-level security keyed on `user_id` as a second fence.
- [ ] Encryption at rest, backups, and a restore procedure. **Restoring an old backup rolls every
      device's history back**; give the restored data a new epoch (delete each user's `meta.json` in the
      file store, or reset `epoch` in your schema) so devices detect it and offer re-upload.
- [ ] A retention decision for tombstones and old operations. This reference never compacts, so
      tombstones are kept forever; clients prune their own after 90 days.

**Secrets and operations**
- [ ] A secret manager or platform environment for the OIDC settings; nothing is committed.
- [ ] Log shipping and retention that match your privacy policy (logs here contain no tokens or content).
- [ ] Monitoring and alerting (5xx rate, 401/429 spikes, disk or quota usage).
- [ ] Abuse handling and an account-deletion process that also purges backups (`DELETE /v1/data`
      erases the live data only).

**Extension and policy (not part of this task, required before enabling sync in a release)**
- [x] Add the server origin to the extension's CSP `connect-src` and request it as an optional host
      permission at the moment the user turns sync on, plus the `identity` permission for sign-in.
      Done in the extension, nothing to do on the server side: `connect-src` allows `https:` and
      loopback (docs/adr/009), `identity` and `alarms` are `optional_permissions` in `wxt.config.ts`,
      and the settings page requests `identity`, `alarms` and the server and issuer origins from the
      click that turns sync on (a token endpoint on another origin, from the next click).
- [ ] Privacy policy and Chrome Web Store data-use disclosures that name the server operator, the data
      categories, and the difference between E2EE and non-E2EE sync.
- [ ] A user-facing explanation in the settings screen before the flag can be switched on.

## 6. Known limitations

- Single process, single machine; JSON-file store is for development and small self-hosting only.
- Rate limiting and per-user serialisation are in-process.
- No operation compaction or tombstone expiry on the server; the log only grows (bounded by the quota).
- A server restored from an older backup loses the operations after it; devices that had already
  pulled them detect it (cursor ahead, or a changed epoch) and offer re-upload, devices that had not
  cannot know.
- Rotation re-encrypts the live log; copies of the old ciphertext in backups remain readable with the
  old passphrase until those backups expire.
- The JWT verifier checks signature and claims, not revocation: a revoked access token stays valid until
  it expires (keep lifetimes short).
