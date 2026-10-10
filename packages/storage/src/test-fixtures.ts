import type { CaptureInput, HtmlAnchorSet } from '@shared';

/** Shared builders for the storage tests. Not imported by production code. */

export const PAGE = {
  url: 'https://example.com/notes/pharm?utm_source=newsletter',
  canonicalUrl: null,
  title: 'Pharmacology notes',
} satisfies CaptureInput['page'];

export function anchor(
  exact: string,
  start: number,
  prefix = 'lead-in ',
  suffix = ' trailing',
): HtmlAnchorSet {
  return {
    type: 'html',
    textAlgorithm: 'sv-text-v1',
    textQuote: { exact, prefix, suffix },
    textPosition: { start, end: start + exact.length },
    structuralPath: null,
    contentSignature: 'abc123',
    documentTextLength: 6000,
  };
}

export function cap(
  exact = 'Aspirin irreversibly inhibits cyclooxygenase.',
  start = 100,
  over: Partial<CaptureInput> = {},
): CaptureInput {
  return {
    page: { ...PAGE },
    exactQuote: exact,
    anchorSet: anchor(exact, start),
    headingContext: 'Antiplatelets',
    kind: 'essential',
    color: 'amber',
    bankId: null,
    userComment: '',
    priority: 3,
    captureMethod: 'toolbar',
    ...over,
  };
}
