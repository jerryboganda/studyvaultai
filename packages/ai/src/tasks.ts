// Task registry: per-kind instructions, output schema, claim extraction and deterministic post-processing.
// Prompt text lives here (versioned by TEMPLATE_VERSION); the pipeline stays task-agnostic.
import type { z } from 'zod';
import type { Claim } from './grounding';
import {
  CompareTopicsOutput,
  ContradictionsModelOutput,
  ExamPearlOutput,
  ExplainOutput,
  FactCheckModelOutput,
  FlashcardsOutput,
  McqOutput,
  NOT_STATED,
  StructuredNotesOutput,
  SummaryOutput,
} from './schema';
import type { ANSWER_STATES, AiSelection, AiTaskKind, Evidence, Grounding } from './schema';

export interface TaskContext {
  selection: AiSelection;
  /** Ids of the chunks that are sent (citeable). */
  chunkIds: string[];
  /** Deterministic candidate pairs (contradictions). */
  candidates: [string, string][];
  /** fact_check statements, in order; ids are `claim_1..n`. */
  claims: string[];
  clinical: boolean;
}

export interface TaskDef {
  kind: AiTaskKind;
  minChunks: number;
  maxOutputTokens: number;
  /** False => no provider call is needed (nothing leaves the device). */
  needsCall(ctx: TaskContext): boolean;
  instructions(ctx: TaskContext): string;
  /** JSON shape shown to the model. */
  shape: string;
  /** What the model must return. */
  modelSchema: z.ZodType;
  /** Cross-field checks that Zod cannot express; any issue triggers the repair attempt. */
  semanticIssues(data: unknown, ctx: TaskContext): string[];
  /** Model output -> stored output shape (pipeline-owned fields, ordering). Pre-grounding. */
  normalize(data: unknown, ctx: TaskContext): unknown;
  claims(output: unknown, ctx: TaskContext): Claim[];
  /** Deterministic downgrades once grounding is known. */
  finalize(output: unknown, report: Grounding, ctx: TaskContext): unknown;
  conflicts(output: unknown): boolean;
  /** Output when needsCall() is false. */
  empty(ctx: TaskContext): unknown;
}

interface Spec<S extends z.ZodType, O> {
  kind: AiTaskKind;
  minChunks?: number;
  maxOutputTokens: number;
  needsCall?: (ctx: TaskContext) => boolean;
  instructions: (ctx: TaskContext) => string;
  shape: string;
  modelSchema: S;
  semanticIssues?: (data: z.infer<S>, ctx: TaskContext) => string[];
  normalize?: (data: z.infer<S>, ctx: TaskContext) => O;
  claims: (output: O, ctx: TaskContext) => Claim[];
  finalize?: (output: O, report: Grounding, ctx: TaskContext) => O;
  conflicts?: (output: O) => boolean;
  empty?: (ctx: TaskContext) => O;
}

/** The single place where the erased (unknown-typed) TaskDef is built from a typed spec. */
function defineTask<S extends z.ZodType, O = z.infer<S>>(spec: Spec<S, O>): TaskDef {
  return {
    kind: spec.kind,
    minChunks: spec.minChunks ?? 1,
    maxOutputTokens: spec.maxOutputTokens,
    needsCall: spec.needsCall ?? (() => true),
    instructions: spec.instructions,
    shape: spec.shape,
    modelSchema: spec.modelSchema,
    semanticIssues: (d, c) => spec.semanticIssues?.(d as z.infer<S>, c) ?? [],
    normalize: (d, c) => (spec.normalize ? spec.normalize(d as z.infer<S>, c) : d),
    claims: (o, c) => spec.claims(o as O, c),
    finalize: (o, r, c) => (spec.finalize ? spec.finalize(o as O, r, c) : o),
    conflicts: (o) => spec.conflicts?.(o as O) ?? false,
    empty: (c) => {
      if (!spec.empty) throw new Error(`task ${spec.kind} always needs a provider call`);
      return spec.empty(c);
    },
  };
}

const ev = (base: string, items: readonly Evidence[]): Claim[] =>
  items.map((e, i) => ({ path: `${base}/${i}/text`, quoteId: e.quoteId, quote: e.text }));

const supportedPaths = (r: Grounding) =>
  new Set(r.claims.filter((c) => c.supported).map((c) => c.path));

const EVIDENCE_SHAPE =
  '{"quoteId": "<id of a data block>", "text": "<verbatim span from that block>"}';

// ---------------------------------------------------------------------------------------------

const examPearl = defineTask({
  kind: 'exam_pearl',
  maxOutputTokens: 500,
  instructions: () =>
    'Write ONE exam pearl from the most testable point in the data: a one-line statement and a short ' +
    'explanation of why it matters. Base it only on the data. Cite the single data block it comes from.',
  shape:
    '{"oneLiner": "<=240 chars", "why": "<=600 chars", "sourceQuoteId": "<id of the data block>", ' +
    '"sourceQuote": "<verbatim span from that block>"}',
  modelSchema: ExamPearlOutput,
  claims: (o) => [{ path: '/sourceQuote', quoteId: o.sourceQuoteId, quote: o.sourceQuote }],
});

const summary = defineTask({
  kind: 'summary',
  maxOutputTokens: 900,
  instructions: () =>
    'Write a concise summary of the data (aim for under 120 words) and 3 to 10 key points. State only ' +
    'what the data says. Cite the passages the summary rests on.',
  shape: `{"summary": "<=2000 chars", "keyPoints": ["<=300 chars", ...], "evidence": [${EVIDENCE_SHAPE}, ...]}`,
  modelSchema: SummaryOutput,
  claims: (o) => ev('/evidence', o.evidence),
});

const structuredNotes = defineTask({
  kind: 'structured_notes',
  maxOutputTokens: 1_600,
  instructions: () =>
    'Organise the data into structured study notes: a title, then sections with short bullet points. ' +
    'Every bullet must cite the passage it comes from. Do not add facts that are not in the data.',
  shape:
    `{"title": "<=120 chars", "sections": [{"heading": "<=120 chars", "bullets": ` +
    `[{"text": "<=300 chars", "evidence": [${EVIDENCE_SHAPE}]}]}]}`,
  modelSchema: StructuredNotesOutput,
  claims: (o) =>
    o.sections.flatMap((s, i) =>
      s.bullets.flatMap((b, j) => ev(`/sections/${i}/bullets/${j}/evidence`, b.evidence)),
    ),
});

const flashcards = defineTask({
  kind: 'flashcards',
  maxOutputTokens: 2_200,
  instructions: (ctx) => {
    const n = ctx.selection.options?.count ?? 5;
    const types = ctx.selection.options?.cardTypes ?? ['basic', 'cloze'];
    return (
      `Create up to ${n} flashcards from the data. Allowed card types: ${types.join(', ')}. ` +
      'A basic card has a front (question) and a back (answer). A cloze card has one sentence with at ' +
      'least one deletion written as {{c1::answer}}. One fact per card, answerable from the data. ' +
      'Each card cites the passage it comes from.'
    );
  },
  shape:
    `{"cards": [{"type": "basic", "front": "<=400", "back": "<=800", "evidence": [${EVIDENCE_SHAPE}]}, ` +
    `{"type": "cloze", "text": "sentence with {{c1::answer}}", "extra": "<=400 optional", "evidence": [...]}]}`,
  modelSchema: FlashcardsOutput,
  semanticIssues: (d, ctx) => {
    const n = ctx.selection.options?.count ?? 5;
    const types = new Set<string>(ctx.selection.options?.cardTypes ?? ['basic', 'cloze']);
    const issues: string[] = [];
    if (d.cards.length > n) issues.push(`at most ${n} cards are allowed`);
    if (d.cards.some((c) => !types.has(c.type))) issues.push('a card type is not allowed');
    return issues;
  },
  claims: (o) => o.cards.flatMap((c, i) => ev(`/cards/${i}/evidence`, c.evidence)),
});

const mcq = defineTask({
  kind: 'mcq',
  maxOutputTokens: 1_200,
  instructions: (ctx) => {
    const n = ctx.selection.options?.choiceCount ?? 4;
    return (
      `Write ONE multiple-choice question with exactly ${n} choices (ids A, B, C...). Exactly one choice ` +
      'is correct according to the data; distractors must be plausible but contradicted or unsupported by ' +
      'the data. Give the key, a short explanation, and cite the passages that justify the key. Set ' +
      'requiresHumanVerification to true if the key is not stated directly in the data.'
    );
  },
  shape:
    `{"stem": "<=500", "choices": [{"id": "A", "text": "<=300"}, ...], "keyChoiceId": "A", ` +
    `"explanation": "<=800", "evidence": [${EVIDENCE_SHAPE}], "requiresHumanVerification": true|false}`,
  modelSchema: McqOutput,
  semanticIssues: (d, ctx) => {
    const n = ctx.selection.options?.choiceCount ?? 4;
    return d.choices.length === n ? [] : [`exactly ${n} choices are required`];
  },
  claims: (o) => ev('/evidence', o.evidence),
  finalize: (o, r, ctx) => ({
    ...o,
    requiresHumanVerification: o.requiresHumanVerification || ctx.clinical || r.unsupported > 0,
  }),
});

const explain = defineTask({
  kind: 'explain',
  maxOutputTokens: 1_000,
  instructions: () =>
    'Answer the question in the data block with kind="question", using ONLY the other data blocks. If ' +
    'the data does not answer it, set answerState to "insufficient_sources" and say what is missing. Use ' +
    '"partially_answered" when only part is covered. Cite every passage you rely on. Never answer from ' +
    'outside knowledge.',
  shape:
    `{"answer": "<=2000", "answerState": "answered"|"partially_answered"|"insufficient_sources", ` +
    `"uncertainty": "<=300, what the sources do not settle (may be empty)", "evidence": [${EVIDENCE_SHAPE}]}`,
  modelSchema: ExplainOutput,
  semanticIssues: (_d, ctx) => (ctx.selection.question ? [] : ['a question is required']),
  claims: (o) => ev('/evidence', o.evidence),
  finalize: (o, r) => {
    const ok = supportedPaths(r);
    const good = o.evidence.filter((_, i) => ok.has(`/evidence/${i}/text`)).length;
    if (o.answerState === 'insufficient_sources') return o;
    // Deterministic downgrade: never present an answer as supported when its citations are not.
    const answerState: (typeof ANSWER_STATES)[number] =
      good === 0
        ? 'insufficient_sources'
        : good < o.evidence.length
          ? 'partially_answered'
          : o.answerState;
    if (answerState === o.answerState) return o;
    return {
      ...o,
      answerState,
      uncertainty: o.uncertainty || 'Some cited passages could not be found in your sources.',
    };
  },
});

const compareTopics = defineTask({
  kind: 'compare_topics',
  minChunks: 2,
  maxOutputTokens: 1_800,
  instructions: (ctx) =>
    (ctx.selection.topics
      ? `Compare exactly these topics: ${ctx.selection.topics.map((t) => JSON.stringify(t)).join(', ')}. `
      : 'Pick 2 to 6 topics the data discusses and compare them. ') +
    'Build a table: each row is an aspect, each row has exactly one cell per topic. If the data does not ' +
    `state something for a topic, set stated=false and text="${NOT_STATED}" with no evidence. A stated cell ` +
    'must cite the passage it comes from.',
  shape:
    `{"topics": ["<=80", ...], "rows": [{"aspect": "<=80", "cells": [{"topic": "<one of topics>", ` +
    `"stated": true|false, "text": "<=300", "evidence": [${EVIDENCE_SHAPE}]}]}]}`,
  modelSchema: CompareTopicsOutput,
  semanticIssues: (d, ctx) => {
    const want = ctx.selection.topics;
    if (!want) return [];
    const a = [...want]
      .map((t) => t.toLowerCase())
      .sort()
      .join('|');
    const b = [...d.topics]
      .map((t) => t.toLowerCase())
      .sort()
      .join('|');
    return a === b ? [] : ['topics must be exactly the requested topics'];
  },
  normalize: (d) => ({
    ...d,
    rows: d.rows.map((r) => ({
      ...r,
      cells: r.cells.map((c) => (c.stated ? c : { ...c, text: NOT_STATED, evidence: [] })),
    })),
  }),
  claims: (o) =>
    o.rows.flatMap((r, i) =>
      r.cells.flatMap((c, j) => ev(`/rows/${i}/cells/${j}/evidence`, c.evidence)),
    ),
});

const contradictions = defineTask({
  kind: 'contradictions',
  minChunks: 2,
  maxOutputTokens: 1_400,
  needsCall: (ctx) => ctx.candidates.length > 0,
  instructions: (ctx) =>
    `The app pre-selected ${ctx.candidates.length} candidate pair(s) of passages (listed under CANDIDATE ` +
    'PAIRS). Judge ONLY those pairs. Report a pair only if the two passages genuinely contradict each ' +
    'other about the same thing; differences of scope, population or wording are not contradictions. For ' +
    'each reported pair give both verbatim quotes. If no pair contradicts, return an empty list.',
  shape: `{"contradictions": [{"a": ${EVIDENCE_SHAPE}, "b": ${EVIDENCE_SHAPE}, "explanation": "<=400"}]}`,
  modelSchema: ContradictionsModelOutput,
  normalize: (d, ctx) => ({
    contradictions: d.contradictions,
    candidateCount: ctx.candidates.length,
  }),
  claims: (o) =>
    o.contradictions.flatMap((c, i) => {
      const candidate = [c.a.quoteId, c.b.quoteId] as const;
      return [
        { path: `/contradictions/${i}/a/text`, quoteId: c.a.quoteId, quote: c.a.text, candidate },
        { path: `/contradictions/${i}/b/text`, quoteId: c.b.quoteId, quote: c.b.text, candidate },
      ];
    }),
  empty: () => ({ contradictions: [], candidateCount: 0 }),
});

const factCheck = defineTask({
  kind: 'fact_check',
  maxOutputTokens: 1_400,
  instructions: (ctx) =>
    `Check each statement (data blocks claim_1..claim_${ctx.claims.length}) against the OTHER data blocks ` +
    'only. Label each: "source_supported" if a passage states or clearly entails it; "conflicting" if a ' +
    'passage states the opposite; "not_checked" if the passages do not settle it. You have no access to ' +
    'the outside world: never use outside knowledge and never claim real-world verification. Cite the ' +
    'passage for every label other than "not_checked".',
  shape:
    `{"checks": [{"claimId": "claim_1", "label": "not_checked"|"source_supported"|"conflicting", ` +
    `"explanation": "<=400", "evidence": [${EVIDENCE_SHAPE}]}]}`,
  modelSchema: FactCheckModelOutput,
  semanticIssues: (d, ctx) => {
    const valid = new Set(ctx.claims.map((_, i) => `claim_${i + 1}`));
    const seen = new Set<string>();
    const issues: string[] = [];
    for (const c of d.checks) {
      if (!valid.has(c.claimId)) issues.push(`unknown claimId ${c.claimId}`);
      if (seen.has(c.claimId)) issues.push(`duplicate claimId ${c.claimId}`);
      seen.add(c.claimId);
    }
    return issues;
  },
  // Stored order is the claim order; a statement the model skipped becomes not_checked.
  normalize: (d, ctx) => ({
    externallyVerified: false as const,
    checks: ctx.claims.map((claim, i) => {
      const claimId = `claim_${i + 1}`;
      const c = d.checks.find((x) => x.claimId === claimId);
      return c
        ? { ...c, claim }
        : {
            claimId,
            claim,
            label: 'not_checked' as const,
            explanation: 'The model returned no judgement for this statement.',
            evidence: [],
          };
    }),
  }),
  claims: (o) => o.checks.flatMap((c, i) => ev(`/checks/${i}/evidence`, c.evidence)),
  finalize: (o, r) => {
    const ok = supportedPaths(r);
    return {
      ...o,
      checks: o.checks.map((c, i) => {
        const grounded =
          c.evidence.length > 0 &&
          c.evidence.every((_, k) => ok.has(`/checks/${i}/evidence/${k}/text`));
        return c.label !== 'not_checked' && !grounded ? { ...c, label: 'not_checked' as const } : c;
      }),
    };
  },
  conflicts: (o) => o.checks.some((c) => c.label === 'conflicting'),
});

export const TASKS: Readonly<Record<AiTaskKind, TaskDef>> = {
  exam_pearl: examPearl,
  summary,
  structured_notes: structuredNotes,
  flashcards,
  mcq,
  explain,
  compare_topics: compareTopics,
  contradictions,
  fact_check: factCheck,
};
