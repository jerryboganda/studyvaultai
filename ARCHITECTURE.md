# Technical Architecture

## Runtime boundaries
- `entrypoints/background.ts`: Manifest V3 event-driven service worker. Handles routing, context menus, permissions, alarms, messaging, sync scheduling. Never assumes it stays alive; no long-running in-memory database state.
- `entrypoints/highlighter.content/`: selection capture + anchored highlight renderer + Shadow DOM toolbar. No access to application secrets. Trust page data as untrusted input.
- `entrypoints/sidepanel/`: continuous study companion with page context, bank browser, review, search and quick save.
- `entrypoints/popup/`: minimal status / entry point, not the sole workspace.
- `entrypoints/options/`: permissions, providers, security, data storage, export/import and customization.
- `entrypoints/dashboard/`: full-page personal knowledge workspace, study metrics and bank administration.
- `entrypoints/pdf-reader/`: extension-owned PDF.js application and text-layer annotation mapping.
- `packages/core/`: typed domain services and validation; no Chrome API or UI imports.
- `packages/storage/`: IndexedDB/Dexie repositories, migrations, transaction boundary, import/export.
- `packages/highlights/`: source anchors, rehydration, selector precedence, signature/checksum.
- `packages/study/`: flashcards, review scheduling, analytics and due queue.
- `packages/ai/`: opt-in provider-agnostic structured AI tasks with provenance and schema validation.
- `packages/sync/`: optional operation log, offline queue, idempotency and conflict resolution.
- `packages/shared/`: types, contracts, protocol schemas and safe utilities.

## Selection capture and persistence
1. On `pointerup`, selected keyboard event, or explicit context-menu action, capture a clone of `Selection.getRangeAt(0)` before focus moves to toolbar.
2. Ignore empty selections, password/secret inputs, editable app surfaces by default, unsafe or excluded domains, protected or unsupported origins.
3. Normalize selected text while retaining the raw quote; capture W3C-inspired `TextQuoteSelector(exact,prefix,suffix)` and `TextPositionSelector(start,end)`, structural DOM selector, URL, title, heading, capture time and content signature.
4. Send a schema-validated typed message from content script to extension repository; persist atomically and generate searchable derived fields.
5. Render highlights with CSS Custom Highlight API when supported, without modifying DOM. Use an accessible fallback only where necessary, and never break page structure.
6. On reloading a document, anchor in order: exact structural and quote match; quote+context; position with verification; fuzzy match requiring a threshold. Surface ambiguous/orphaned states, never quietly mark wrong text.
7. On SPA navigation, content changes and lazy-loading, use a throttled/targeted MutationObserver and cleanup listeners on unmount. Rehydrate only for the current canonical source. Avoid scan-per-mutation over entire document.
8. Preserve highlight identity, color, bank memberships and state independently of how it is rendered.

## PDF pathway
- Chrome's built-in viewer is not a supported integration surface for direct selection/markup. Add a clear 'Open in StudyVault reader' action.
- Package the PDF.js worker and viewer scripts locally (Manifest V3 remote-executable-code requirements).
- For online files, request only needed host access and fetch documents from an extension-controlled context, subject to permissions, auth, response behavior and access control. Do not use brittle redirects/hacks to intercept all PDFs.
- Support explicit local import and drag/drop. `file://` access requires a user setting when used directly; file picker uploads do not rely on that permission.
- Generate stable PDF fingerprints / content hashes; annotation selector includes page number, normalized page coordinates, text-layer quote and offsets, local bounding boxes and document version/fingerprint.
- Persist annotations independently of PDF binaries. Optionally cache only user-approved PDF originals and clearly show storage use; revocable storage.
- Scanned PDFs need OCR to create selectable text. OCR may have errors; preserve page coordinate mapping and let user correct text.
- Implement zoom, rotate, select, search, page jump, reading focus, split notes, multi-page selection or explicit restriction where not yet supported.
- For auth-gated/cross-origin/signed-URL content, provide manual upload/fallback and a nonmisleading error; never bypass authentication.

## Storage choices
- User corpus in IndexedDB using Dexie: collections, folders, highlights, source metadata, notes, cards, reviews, OCR artifacts, related links, operations.
- `chrome.storage.local`: lightweight settings/metadata; `chrome.storage.sync` only small, nonsensitive preferences, NOT a full knowledge base (around 100 KB total quota).
- Objects/images/PDF binaries: IndexedDB Blob and optional OPFS where feasible and tested; optional cloud object storage with quotas.
- Versioned schema migrations with rollback/checksum backup and integration tests; all writes idempotent where possible.
- Data deletion: soft delete plus purge, orphan cleanup and export-delete verification.

## Optional backend (not required for P0)
- API: TypeScript on Fastify or Hono, authenticated OAuth/OIDC session with PKCE; provider choice at implementation time.
- Database: PostgreSQL with relational bank/source/annotation/card/review data and optional pgvector when semantic search is enabled.
- Object storage: encrypted-at-rest private S3-compatible storage (R2 compatible) for user-approved PDFs and images.
- Synchronization: local changes immediately, append operation log with clientId, monotonic logical versions, idempotency key, tombstones; per-record revisions, user-resolvable conflicts; tests covering simultaneous edits/offline recovery.
- E2EE (optional): keys derived and kept client-side with recovery path. Server-side AI cannot read end-to-end encrypted data unless the user explicitly decrypts and sends selected content for processing.
- High-cost AI: backend proxy with secret storage, per-user token budgets, provider routing, explicit consent, status tracking, retry and cancellation.

## AI pipeline
1. User clicks AI action on explicit selected source or subset of bank.
2. Preview exactly which content will leave device; allow edit/redaction.
3. Quote is immutable; AI generated fields are versioned separate derived objects.
4. Use structured schemas (Zod), citations back to saved source IDs, explicit 'unverified' labels.
5. Build evidence retrieval for external claims only with approved, reputable sources, and distinguish source consistency from real-world verification.
6. Apply source-text prompt-injection defenses: untrusted data boundaries, strict tool policy, deny arbitrary external links/scripts/code execution.
7. Support timeout, per-task caps, retry/backoff, caching, abort, and graceful fallback when provider unavailable.
8. For MCQs save question, choices, proposed key, explanation and evidence ID per claim, including 'requires human verification' where needed.

## Failure modes and recovery
- MV3 service worker suspension: durable queues; wake/resume on events, never depend on pending global promises.
- Page DOM changes: staged reanchoring with user-visible recovery controls.
- Storage quota/private browsing: clear informational errors and safe fallbacks.
- Multiple tabs/same URL: isolate tab-session UI; content saved to source identity.
- Network unavailable: core local flows continue; sync tasks queue.
- Extension update: migrates data transactionally; validate existing annotations and review logs.
