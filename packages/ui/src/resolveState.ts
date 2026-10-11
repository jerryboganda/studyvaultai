import type { ResolveStatus } from '@shared';

export interface ResolveDescriptor {
  status: ResolveStatus;
  label: string;
  /** Non-colour cue; the label always carries the meaning on its own. */
  glyph: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  /** Ambiguous and orphaned highlights are not painted on the page and need the reader's eyes. */
  attention: boolean;
  explanation: string | null;
}

const DESCRIPTORS: Record<ResolveStatus, ResolveDescriptor> = {
  unchecked: {
    status: 'unchecked',
    label: 'Not checked yet',
    glyph: '·',
    tone: 'neutral',
    attention: false,
    explanation: null,
  },
  resolved: {
    status: 'resolved',
    label: 'Found on page',
    glyph: '✓',
    tone: 'success',
    attention: false,
    explanation: null,
  },
  changed: {
    status: 'changed',
    label: 'Source changed',
    glyph: '≈',
    tone: 'warning',
    attention: false,
    explanation:
      'The page text around this quote has changed. StudyVault still found it and painted it.',
  },
  ambiguous: {
    status: 'ambiguous',
    label: 'Ambiguous · not painted',
    glyph: '?',
    tone: 'warning',
    attention: true,
    explanation:
      'The quote matches more than one place on the page, so StudyVault did not paint it rather than mark the wrong passage.',
  },
  orphaned: {
    status: 'orphaned',
    label: 'Orphaned · not found on page',
    glyph: '✕',
    tone: 'danger',
    attention: true,
    explanation:
      'The quote could not be found on the page. The page may have changed or not finished loading. Your saved quote and note are unchanged.',
  },
};

export function describeResolveState(status: ResolveStatus): ResolveDescriptor {
  return DESCRIPTORS[status];
}
