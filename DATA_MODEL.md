# Data Model and Provenance Contract

All records have UUIDv7/ULID-style sortable IDs or an equivalent validated identifier, schemaVersion, createdAt, updatedAt, and soft-deletion metadata where appropriate. Do not assume `id` is a globally unique numeric database key. Use normalized storage and typed DTOs.

## Core entities
- `Profile`: local identity, security mode, locale, timezone, preferences; account optional.
- `Workspace`: optional grouping of all data, e.g. personal vs team.
- `Bank`: name, icon/color, user-defined ordered nested hierarchy, privacy policy, presets and permissions.
- `Folder`: bankId, parentFolderId, position, depth check, alias and smart-filter metadata.
- `Tag`: name, aliases, color; many-to-many through tag relations.
- `Source`: type (web/pdf/image/video/manual), canonicalUrl, originalUrl, title, authors, publisher, contentType, documentFingerprint, contentHash, publishedAt, capturedAt, retrievalStatus, license/copyright metadata when supplied, access notes.
- `Highlight`: sourceId, exactQuote, normalizedQuote, quoteHash, anchorSet, color, kind, priority, userComment, sourceStatus, captureMethod, capturedAt, lastResolvedAt, resolveConfidence.
- `HighlightBank`: highlightId, bankId, folderId; many-to-many membership so a highlight can be filed in multiple banks without duplication.
- `Note`: optional sourceId/highlightId, userAuthoredBody, richText/Markdown, title, pinned and review state.
- `KnowledgePoint`: compact user-approved derived concept, primaryQuoteId, topic relationship, shortOneLiner, examPearl, misconception, verificationStatus, claims/evidence.
- `Card`: note/knowledgePoint relation, deck/bank, cardType, front, back, cloze/image refs, dueAt and FSRS state.
- `ReviewLog`: cardId, reviewedAt, rating, previous/new scheduling state, sessionId, duration, algorithmVersion, optional userCorrection.
- `Relationship`: directed connection (prerequisite, differential, contradicts, supports, same-as), createdBy, confidence.
- `Attachment`: binary/blobRef, mime, length, sha256, source, localOnly/syncAllowed flags.
- `AIResult`: inputSourceIds, inputFingerprint, provider, model, templateVersion, output, token/estimate metadata, citations, verification state, createdAt, acceptedByUserAt, explicit consent reference.
- `SyllabusNode`: user-created path, expected topics, related knowledge points, exam mode.
- `ActivityEvent`: feature name, timestamp, private/local metrics only unless user opts in.
- `SyncOperation`: entityType, entityId, opType, clientId, revision, idempotencyKey, payloadEncrypted flag, tombstone, createdAt.

## Example saved highlight (conceptual schema)
```json
{
  "id": "01H_EXAMPLE_UNIQUE_ID",
  "sourceId": "source-123",
  "exactQuote": "Representative exact source wording.",
  "anchorSet": {
    "type": "html",
    "textQuote": {"exact": "Representative exact source wording.", "prefix": "Before ", "suffix": " After"},
    "textPosition": {"start": 4210, "end": 4247},
    "structuralPath": "main article p:nth-of-type(3)"
  },
  "kind": "exam_pearl",
  "color": "amber",
  "priority": 4,
  "verificationStatus": "not_checked",
  "createdAt": "2026-10-10T10:00:00.000Z"
}
```
`TextPosition` offsets above are illustrative. Actual offsets must be computed using a documented text normalization algorithm, not invented from a CSS selector. DOM structural paths are hints, not absolute truth.

## Evidence and fact integrity rules
- `exactQuote` is an immutable captured source record. User edits to an interpretation go in a separate note or a correctedQuote field with an audit trail.
- Never represent an AI summary as the original quotation.
- Claims can have multiple evidence pointers, contradictory evidence, and explicit reliability grades.
- Document/page anchors must include source fingerprint/version; note if a reopened remote source no longer matches.
- Preserve timestamps with UTC storage, user display in selected timezone.
- Export includes schema version, linked entity IDs, checksum, and provenance so round trips are lossless.

## Search indexes
- Exact lookup by source identity and capture fingerprint; bank/folder/tag; last saved; priority; review due; note type; verification state.
- Full-text on title, quote, user notes, AI-derived texts in separately labeled index fields; fuzzy matching may be later.
- Optional vector embeddings are derived/cachable data; never authoritative and must be regenerable.

## Migration and backup
- Every migration is tested against at least three earlier schema fixtures.
- Export a validated pre-migration backup; migrations transactional where supported.
- Restore into a staging database, integrity-check relationships and checksums, then offer replace/merge, with dry-run and rollback.
- Maintain stable source and annotation IDs across exports.
