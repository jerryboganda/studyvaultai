# Verification Plan

## Testing philosophy
Test behaviors in actual MV3 contexts. jsdom alone cannot validate extension permission lifecycle, content script isolation, native browser UI limitations, PDF viewer correctness or service worker termination. Prefer deterministic fixtures and real Chromium-based extension harness.

## Automated tests
- Unit: text normalization; W3C-style selectors; match scores; bank hierarchy validation; reference integrity; dedup; migrations; FSRS preview and transition rules; schema validation; export/import; date/timezones; URL sanitization.
- Component: toolbar placement, keyboard capture, accessible bank picker, selection preservation, optimistic save rollback, popover focus, long title truncation.
- Integration: messaging between content script/background/side panel; atomic Dexie transactions; source to highlight to note to card; unload/reload; permission grant/revocation; service worker suspend/resume.
- Browser/E2E: use actual Chrome extension-loaded profile, not mocked extension APIs. Ensure tests work under GitHub Actions.
- Contract: AI output schema and provenance, sync idempotency/conflicts, import schema and content hashing.
- Security: injected malicious HTML, prompt injection, risky URLs, cross-frame spoofing, CSRF in optional backend, CSP, sensitive-site exclusions, storage token leaks.

## HTML compatibility matrix
1. Simple article, repeated text in same page.
2. Nested formatting links/strong/inline math.
3. Dynamic SPA navigation, virtualized/lazy-loaded article sections.
4. ContentEditable editors and input fields (must not show toolbar by default).
5. Third-party components, Shadow DOM and iframes with permitted vs unpermitted origin.
6. Large academic article; multi-column layout and footnotes.
7. Extremely restrictive CSS and z-index stacks, page zoom 125%-200%, dark theme.
8. Restricted Chrome internal URL, Chrome Web Store, incognito by default, file:// permission disabled.
9. Duplicate quotation occurrences where the prefix/suffix is necessary.
10. Source mutated after save, ambiguous anchor, orphaned anchor; never silently link to wrong text.

## PDF compatibility matrix
1. Plain selectable text PDF, 10 pages.
2. Multi-column scientific PDF, tables, equations and superscripts.
3. Rotated pages, zoom scales, landscape.
4. Long PDF (100+ pages) and memory pressure; lazy render.
5. Scanned image-only PDF with no extractable text.
6. Password-protected PDF with proper user-supplied password.
7. Remote public PDF and redirected URL with content-type application/pdf without .pdf extension.
8. Authenticated content inaccessible to extension (clear manual upload fallback).
9. Local imported file; close/reopen document with stable fingerprint.
10. Annotation selection across line wraps and multiple text-layer spans, duplicate text occurrences.

## Review and AI matrix
- Deterministic known FSRS fixtures with Again/Hard/Good/Easy.
- UTC/DST/timezone changes, user clock drift and backlog behavior.
- Optional AI disabled; provider key missing; provider timeout; rate limit; quota exhausted; cancellation; two simultaneous requests; retry idempotency.
- Page text containing an instruction to reveal API keys; verify it is treated only as untrusted study content.
- Incorrect MCQ key and contradictory sources: display unverified/correction labels, don't overwrite original.
- Document with personal/sensitive text: consent preview and redaction controls are effective.

## Performance targets (engineering budgets, refine after measurement)
- Aim for <150ms added p95 input responsiveness for common highlight interactions on representative articles, excluding rendering or backend latency.
- Aim for <300ms p95 local lookup for typical filtered searches of a seeded 10k-highlight corpus on target hardware.
- Avoid unconditional full-document extraction or constant DOM polling; debounce and scope mutation processing.
- Lazy load PDF pages and OCR work; virtualize large highlight lists; bound queues and memory use.
- Track extension bundle size, page script footprint, median/p95 CPU/memory under representative tests. These are goals, not verified measurements.

## Exit reports
Every phase handoff must provide: completed workflows; test commands actually executed + pass/fail counts; screenshots; browser/OS tested; permissions tested; 5 most serious unresolved defects; rollback strategy; exact next task. Never mark skipped tests as passed.
