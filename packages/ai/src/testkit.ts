// Test helpers only (not exported from index.ts). Deterministic deps + fixtures + model-output builders.
import { createHash } from 'node:crypto';
import { AiError } from './errors';
import { createMemoryCache } from './deps';
import type { LogEvent, PipelineDeps } from './deps';
import { buildPreview, createConsentToken } from './prepare';
import type { RunOptions } from './pipeline';
import type { AiProvider } from './providers';
import type { RedactionEdits } from './redact';
import type { AiSelection, AiTaskKind, SourceChunk } from './schema';

export const T0 = Date.parse('2026-10-11T10:00:00.000Z');

export const H1: SourceChunk = {
  id: 'hl-0000001',
  kind: 'highlight',
  text: 'Metformin is the first-line pharmacological treatment for type 2 diabetes mellitus in most adults.',
};
export const H2: SourceChunk = {
  id: 'hl-0000002',
  kind: 'highlight',
  text: 'Insulin therapy is required in type 1 diabetes mellitus because pancreatic beta cells are destroyed.',
};
export const H3: SourceChunk = {
  id: 'hl-0000003',
  kind: 'highlight',
  text: 'Metformin is contraindicated as first-line treatment for type 2 diabetes mellitus in adults.',
};
export const N1: SourceChunk = {
  id: 'note-0001',
  kind: 'note',
  text: 'My note: hyperglycaemia causes polyuria and polydipsia through osmotic diuresis.',
};
/** Not clinical: used to check the notice is not attached blindly. */
export const G1: SourceChunk = {
  id: 'hl-geo-001',
  kind: 'highlight',
  text: 'The Nile flows northwards through Egypt and empties into the Mediterranean Sea.',
};

export interface TestDeps extends PipelineDeps {
  clock: { t: number };
  sleeps: number[];
  logs: LogEvent[];
  cache: ReturnType<typeof createMemoryCache>;
}

export function sha256(text: string): Promise<string> {
  return Promise.resolve(createHash('sha256').update(text).digest('hex'));
}

export function makeDeps(provider: AiProvider, over: Partial<PipelineDeps> = {}): TestDeps {
  const clock = { t: T0 };
  const sleeps: number[] = [];
  const logs: LogEvent[] = [];
  let n = 0;
  const cache = createMemoryCache();
  return {
    enabled: true,
    provider,
    now: () => clock.t,
    random: () => 0.5,
    randomId: () => `id-${String(++n).padStart(8, '0')}`,
    sha256,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      if (signal?.aborted) return Promise.reject(new Error('aborted'));
      return Promise.resolve();
    },
    // Deadline never fires unless a test overrides it.
    timeout: () => new Promise<void>(() => {}),
    cache,
    log: (e) => logs.push(e),
    ...over,
    clock,
    sleeps,
    logs,
  } as TestDeps;
}

/** Preview -> consent -> RunOptions, the way the UI does it. */
export async function approve(
  kind: AiTaskKind,
  selection: AiSelection,
  deps: PipelineDeps,
  extra: Partial<RunOptions> & { edits?: RedactionEdits } = {},
): Promise<RunOptions> {
  const preview = await buildPreview(kind, selection, deps, extra.edits);
  return { consent: createConsentToken(preview, deps), ...extra };
}

export const sel = (chunks: SourceChunk[], more: Partial<AiSelection> = {}): AiSelection => ({
  chunks,
  ...more,
});

const ev = (c: SourceChunk, from = 0, len = 40) => ({
  quoteId: c.id,
  text: c.text.slice(from, from + len),
});

/** A valid, fully grounded model reply for each kind, built from the fixtures above. */
export function goodReply(kind: AiTaskKind, s: AiSelection): unknown {
  const a = s.chunks[0]!;
  const b = s.chunks[1] ?? a;
  switch (kind) {
    case 'exam_pearl':
      return {
        oneLiner: 'Metformin is first-line for type 2 diabetes.',
        why: 'It is the standard initial drug choice in most adults.',
        sourceQuoteId: a.id,
        sourceQuote: a.text.slice(0, 45),
      };
    case 'summary':
      return {
        summary: 'Metformin is first-line for type 2 diabetes; insulin is needed in type 1.',
        keyPoints: ['Metformin first-line in T2DM', 'Insulin required in T1DM'],
        evidence: [ev(a), ev(b)],
      };
    case 'structured_notes':
      return {
        title: 'Diabetes treatment',
        sections: [
          {
            heading: 'Type 2',
            bullets: [{ text: 'Metformin is first-line.', evidence: [ev(a)] }],
          },
        ],
      };
    case 'flashcards':
      return {
        cards: [
          {
            type: 'basic',
            front: 'What is first-line pharmacological treatment for type 2 diabetes?',
            back: 'Metformin',
            evidence: [ev(a)],
          },
          {
            type: 'cloze',
            text: '{{c1::Metformin}} is the first-line treatment for type 2 diabetes mellitus.',
            evidence: [ev(a)],
          },
        ],
      };
    case 'mcq':
      return {
        stem: 'Which drug is first-line for type 2 diabetes mellitus in most adults?',
        choices: [
          { id: 'A', text: 'Metformin' },
          { id: 'B', text: 'Insulin glargine' },
          { id: 'C', text: 'Sulfonylurea' },
          { id: 'D', text: 'Acarbose' },
        ],
        keyChoiceId: 'A',
        explanation: 'The source names metformin as the first-line pharmacological treatment.',
        evidence: [ev(a)],
        requiresHumanVerification: false,
      };
    case 'explain':
      return {
        answer: 'Metformin is the first-line treatment according to the passage.',
        answerState: 'answered',
        uncertainty: '',
        evidence: [ev(a)],
      };
    case 'compare_topics':
      return {
        topics: ['Type 1', 'Type 2'],
        rows: [
          {
            aspect: 'Treatment',
            cells: [
              { topic: 'Type 1', stated: true, text: 'Insulin therapy', evidence: [ev(b)] },
              { topic: 'Type 2', stated: true, text: 'Metformin first-line', evidence: [ev(a)] },
            ],
          },
          {
            aspect: 'Prognosis',
            cells: [
              { topic: 'Type 1', stated: false, text: 'x', evidence: [] },
              { topic: 'Type 2', stated: false, text: 'x', evidence: [] },
            ],
          },
        ],
      };
    case 'contradictions':
      return {
        contradictions: [
          {
            a: ev(a, 0, 60),
            b: ev(b, 0, 60),
            explanation: 'One passage says first-line, the other says contraindicated.',
          },
        ],
      };
    case 'fact_check':
      return {
        checks: (s.claims ?? []).map((_, i) => ({
          claimId: `claim_${i + 1}`,
          label: 'source_supported',
          explanation: 'The passage states this.',
          evidence: [ev(a)],
        })),
      };
    case 'mnemonic':
      return {
        aids: [
          {
            type: 'acronym',
            fact: 'Metformin is first-line for type 2 diabetes.',
            mnemonic: 'M for Metformin, M for Majority of adults.',
            howItWorks: 'Both M words point to the drug and to the usual starting choice.',
            evidence: [ev(a)],
          },
        ],
      };
    case 'short_viva':
      return {
        questions: [
          {
            question: 'What is the first-line drug for type 2 diabetes in most adults?',
            modelAnswer: 'Metformin is the first-line pharmacological treatment.',
            evidence: [ev(a)],
          },
          {
            question: 'Why is insulin therapy required in type 1 diabetes?',
            modelAnswer: 'Pancreatic beta cells are destroyed.',
            evidence: [ev(b)],
          },
        ],
      };
    case 'study_outline':
      return {
        title: 'Diabetes mellitus',
        items: [
          { level: 1, text: 'Type 2 diabetes', evidence: [ev(a)] },
          { level: 2, text: 'First-line drug', evidence: [ev(a)] },
          { level: 1, text: 'Type 1 diabetes', evidence: [ev(b)] },
        ],
      };
  }
}

/** Selection that satisfies each kind's input requirements. */
export function selectionFor(kind: AiTaskKind): AiSelection {
  switch (kind) {
    case 'explain':
      return sel([H1, N1], { question: 'What is first-line treatment for type 2 diabetes?' });
    case 'compare_topics':
      return sel([H1, H2]);
    case 'contradictions':
      return sel([H1, H3]);
    case 'fact_check':
      return sel([H1, H2], { claims: ['Metformin is first-line treatment for type 2 diabetes.'] });
    case 'mcq':
      return sel([H1], { options: { choiceCount: 4 } });
    default:
      return sel([H1, H2]);
  }
}

export const rateLimited = (retryAfterMs?: number) =>
  new AiError('rate_limited', {
    status: 429,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
