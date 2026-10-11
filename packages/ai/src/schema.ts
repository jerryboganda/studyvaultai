import './zodConfig';
import { z } from 'zod';
import { AI_TASK_KINDS } from './constants';
import { REDACTION_KINDS } from './redact';

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** Highlight or note id (opaque, validated loosely like @shared Id but without importing it). */
export const ChunkId = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/, 'invalid id');
const IsoDate = z.iso.datetime();
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const short = (max: number) => z.string().trim().min(1).max(max);

export const AiTaskKind = z.enum(AI_TASK_KINDS);
export type AiTaskKind = z.infer<typeof AiTaskKind>;

export const VerificationState = z.enum([
  'unverified',
  'source_supported',
  'conflicting',
  'unsupported',
]);
export type VerificationState = z.infer<typeof VerificationState>;

export const VERIFICATION_LABELS: Record<VerificationState, string> = {
  unverified: 'Unverified AI draft',
  source_supported: 'Cited text found in your sources (you accepted it)',
  conflicting: 'Conflicts with your sources',
  unsupported: 'Contains citations not found in your sources',
};

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** One user-approved passage: a saved highlight (exactQuote) or a note body. */
export const SourceChunk = z.strictObject({
  id: ChunkId,
  kind: z.enum(['highlight', 'note']),
  text: z.string().min(1).max(100_000),
});
export type SourceChunk = z.infer<typeof SourceChunk>;

export const AiSelection = z.strictObject({
  chunks: z.array(SourceChunk).min(1).max(50),
  /** explain: the user's question. Treated as untrusted data as well. */
  question: z.string().trim().min(1).max(500).optional(),
  /** compare_topics: optional topic names to compare (otherwise the model derives 2-6). */
  topics: z.array(short(80)).min(2).max(6).optional(),
  /** fact_check: the statements to check against the selected chunks. */
  claims: z.array(short(300)).min(1).max(10).optional(),
  /**
   * explain (bank chat): earlier turns the person chose to send for context. They are previewed like
   * every other block, are never citeable and are treated as untrusted data.
   */
  history: z
    .array(z.strictObject({ role: z.enum(['user', 'assistant']), text: short(1500) }))
    .min(1)
    .max(6)
    .optional(),
  options: z
    .strictObject({
      /** flashcards: how many cards (1-20, default 5). */
      count: z.number().int().min(1).max(20).optional(),
      /** flashcards: which card types are allowed. */
      cardTypes: z
        .array(z.enum(['basic', 'cloze']))
        .min(1)
        .max(2)
        .optional(),
      /** mcq: number of answer choices (3-6, default 4). */
      choiceCount: z.number().int().min(3).max(6).optional(),
    })
    .optional(),
  /** Force (true/false) or auto-detect (undefined) the clinical study-aid notice. */
  clinical: z.boolean().optional(),
});
export type AiSelection = z.infer<typeof AiSelection>;

// ---------------------------------------------------------------------------------------------
// Per-kind outputs. All strict: unknown keys (tool calls, extra instructions) make the output invalid.
// ---------------------------------------------------------------------------------------------

/** A verbatim quote the model cites. `text` must exist in the chunk named by `quoteId` (grounding). */
export const Evidence = z.strictObject({ quoteId: ChunkId, text: z.string().min(1).max(600) });
export type Evidence = z.infer<typeof Evidence>;

export const ExamPearlOutput = z.strictObject({
  oneLiner: short(240),
  why: short(600),
  sourceQuoteId: ChunkId,
  /** Verbatim from the chunk `sourceQuoteId`. The UI shows the immutable highlight quote, not this. */
  sourceQuote: z.string().min(1).max(600),
});

export const SummaryOutput = z.strictObject({
  summary: short(2000),
  keyPoints: z.array(short(300)).min(1).max(10),
  evidence: z.array(Evidence).min(1).max(10),
});

export const StructuredNotesOutput = z.strictObject({
  title: short(120),
  sections: z
    .array(
      z.strictObject({
        heading: short(120),
        bullets: z
          .array(z.strictObject({ text: short(300), evidence: z.array(Evidence).min(1).max(2) }))
          .min(1)
          .max(12),
      }),
    )
    .min(1)
    .max(12),
});

const CardBase = { evidence: z.array(Evidence).min(1).max(3) };
export const FlashcardsOutput = z.strictObject({
  cards: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({
          type: z.literal('basic'),
          front: short(400),
          back: short(800),
          ...CardBase,
        }),
        z.strictObject({
          type: z.literal('cloze'),
          /** Anki-style cloze: "The {{c1::liver}} produces bile." */
          text: short(800).regex(/\{\{c\d{1,2}::[^{}]+\}\}/, 'cloze needs {{c1::answer}}'),
          extra: z.string().trim().max(400).optional(),
          ...CardBase,
        }),
      ]),
    )
    .min(1)
    .max(20),
});

const ChoiceId = z.string().regex(/^[A-F]$/);
export const McqOutput = z
  .strictObject({
    stem: short(500),
    choices: z
      .array(z.strictObject({ id: ChoiceId, text: short(300) }))
      .min(3)
      .max(6),
    keyChoiceId: ChoiceId,
    explanation: short(800),
    evidence: z.array(Evidence).min(1).max(5),
    /** The pipeline forces true for clinical content and for any ungrounded evidence. */
    requiresHumanVerification: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const ids = v.choices.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate choice ids' });
    }
    if (!ids.includes(v.keyChoiceId)) {
      ctx.addIssue({ code: 'custom', message: 'keyChoiceId is not one of the choices' });
    }
    const texts = v.choices.map((c) => c.text.toLowerCase());
    if (new Set(texts).size !== texts.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate choice texts' });
    }
  });

export const ANSWER_STATES = ['answered', 'partially_answered', 'insufficient_sources'] as const;
export const ExplainOutput = z.strictObject({
  answer: short(2000),
  answerState: z.enum(ANSWER_STATES),
  /** What the sources do not settle (may be empty). */
  uncertainty: z.string().trim().max(300),
  evidence: z.array(Evidence).max(8),
});

export const NOT_STATED = 'Not stated in the selected sources';
const CompareCell = z
  .strictObject({
    topic: short(80),
    stated: z.boolean(),
    text: short(300),
    evidence: z.array(Evidence).max(2),
  })
  .refine((c) => !c.stated || c.evidence.length > 0, 'a stated cell needs evidence');
export const CompareTopicsOutput = z
  .strictObject({
    topics: z.array(short(80)).min(2).max(6),
    rows: z
      .array(z.strictObject({ aspect: short(80), cells: z.array(CompareCell).min(2).max(6) }))
      .min(1)
      .max(12),
  })
  .superRefine((v, ctx) => {
    const want = [...v.topics].sort().join('|');
    v.rows.forEach((r, i) => {
      if (
        r.cells
          .map((c) => c.topic)
          .sort()
          .join('|') !== want
      ) {
        ctx.addIssue({ code: 'custom', message: `row ${i} must have exactly one cell per topic` });
      }
    });
  });

const Contradiction = z.strictObject({ a: Evidence, b: Evidence, explanation: short(400) });
export const ContradictionsModelOutput = z.strictObject({
  contradictions: z.array(Contradiction).max(40),
});
export const ContradictionsOutput = z.strictObject({
  contradictions: z.array(Contradiction).max(40),
  /** Number of deterministic candidate pairs the model was asked to judge (pipeline-owned). */
  candidateCount: z.number().int().min(0),
});

export const FACT_LABELS = ['not_checked', 'source_supported', 'conflicting'] as const;
export const FactLabel = z.enum(FACT_LABELS);
const CheckBase = {
  claimId: z.string().regex(/^claim_\d{1,2}$/),
  label: FactLabel,
  explanation: short(400),
  evidence: z.array(Evidence).max(4),
};
export const FactCheckModelOutput = z.strictObject({
  checks: z.array(z.strictObject(CheckBase)).min(1).max(10),
});
export const FactCheckOutput = z.strictObject({
  checks: z
    .array(z.strictObject({ ...CheckBase, claim: z.string().max(300) }))
    .min(1)
    .max(10),
  /** Always false: external retrieval is out of scope. */
  externallyVerified: z.literal(false),
});

export const MNEMONIC_TYPES = ['acronym', 'rhyme', 'image', 'story', 'chunking', 'other'] as const;
const MnemonicAid = {
  type: z.enum(MNEMONIC_TYPES),
  /** The fact the aid anchors, in the model's words; the cited quote is the authority. */
  fact: short(300),
  mnemonic: short(300),
  howItWorks: short(300),
  evidence: z.array(Evidence).min(1).max(2),
};
export const MnemonicModelOutput = z.strictObject({
  aids: z.array(z.strictObject(MnemonicAid)).min(1).max(5),
});
export const MnemonicOutput = z.strictObject({
  aids: z.array(z.strictObject(MnemonicAid)).min(1).max(5),
  /** Always true (pipeline-owned): the text is a device for recall, never a statement of fact. */
  aidNotFact: z.literal(true),
});

export const ShortVivaOutput = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        question: short(300),
        modelAnswer: short(800),
        evidence: z.array(Evidence).min(1).max(3),
      }),
    )
    .min(1)
    .max(5),
});

export const StudyOutlineOutput = z.strictObject({
  title: short(120),
  /** A flat list in reading order; `level` makes it a hierarchy without recursive schemas. */
  items: z
    .array(
      z.strictObject({
        level: z.number().int().min(1).max(3),
        text: short(240),
        evidence: z.array(Evidence).min(1).max(2),
      }),
    )
    .min(1)
    .max(40),
});

export const OUTPUT_SCHEMAS = {
  exam_pearl: ExamPearlOutput,
  summary: SummaryOutput,
  structured_notes: StructuredNotesOutput,
  flashcards: FlashcardsOutput,
  mcq: McqOutput,
  explain: ExplainOutput,
  compare_topics: CompareTopicsOutput,
  contradictions: ContradictionsOutput,
  fact_check: FactCheckOutput,
  mnemonic: MnemonicOutput,
  short_viva: ShortVivaOutput,
  study_outline: StudyOutlineOutput,
} as const;

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

export const Usage = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0).nullable(),
});
export type Usage = z.infer<typeof Usage>;

export const Citation = z
  .strictObject({
    highlightId: ChunkId.optional(),
    noteId: ChunkId.optional(),
    /** Verbatim text that was found in the cited chunk as sent (after redaction). */
    quote: z.string().min(1).max(600),
  })
  .refine(
    (c) => (c.highlightId === undefined) !== (c.noteId === undefined),
    'exactly one of highlightId/noteId',
  );
export type Citation = z.infer<typeof Citation>;

export const GroundingClaim = z.strictObject({
  /** JSON pointer into `output`, e.g. `/evidence/0/text`. */
  path: z.string().max(200),
  quoteId: z.string().max(80),
  supported: z.boolean(),
  reason: z.enum(['ok', 'unknown_id', 'quote_not_found', 'quote_too_short', 'not_a_candidate']),
});
export const Grounding = z.strictObject({
  checked: z.number().int().min(0),
  supported: z.number().int().min(0),
  unsupported: z.number().int().min(0),
  claims: z.array(GroundingClaim).max(500),
});
export type Grounding = z.infer<typeof Grounding>;

const resultBase = {
  id: z.string().min(8).max(64),
  inputSourceIds: z.array(ChunkId).min(1).max(50),
  inputFingerprint: Sha256Hex,
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  templateVersion: z.string().min(1).max(64),
  citations: z.array(Citation).max(200),
  verificationState: VerificationState,
  usage: Usage,
  createdAt: IsoDate,
  acceptedByUserAt: IsoDate.nullable(),
  /** Id of the ConsentToken that authorised the call. */
  consentRef: z.string().min(1).max(64),
  grounding: Grounding,
  notices: z.array(z.string().max(300)).max(8),
};

const variant = <K extends AiTaskKind, O extends z.ZodType>(kind: K, output: O) =>
  z.strictObject({ ...resultBase, kind: z.literal(kind), output });

export const AiResult = z.discriminatedUnion('kind', [
  variant('exam_pearl', ExamPearlOutput),
  variant('summary', SummaryOutput),
  variant('structured_notes', StructuredNotesOutput),
  variant('flashcards', FlashcardsOutput),
  variant('mcq', McqOutput),
  variant('explain', ExplainOutput),
  variant('compare_topics', CompareTopicsOutput),
  variant('contradictions', ContradictionsOutput),
  variant('fact_check', FactCheckOutput),
  variant('mnemonic', MnemonicOutput),
  variant('short_viva', ShortVivaOutput),
  variant('study_outline', StudyOutlineOutput),
]);
export type AiResult = z.infer<typeof AiResult>;

// ---------------------------------------------------------------------------------------------
// Preview and consent
// ---------------------------------------------------------------------------------------------

export const RedactionRegionSchema = z.strictObject({
  id: z.string().max(200),
  chunkId: ChunkId,
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  kind: z.enum(REDACTION_KINDS),
  placeholder: z.string().max(40),
  original: z.string().max(200_000),
  enabled: z.boolean(),
  origin: z.enum(['auto', 'manual']),
});

export const AiRequestPreview = z.strictObject({
  kind: AiTaskKind,
  templateVersion: z.string(),
  provider: z.string(),
  model: z.string(),
  /**
   * Every provider that may receive this text, in the order they are tried: the one above first,
   * then the fallbacks. The consent hash covers the whole list, so a fallback that is added or
   * removed after the preview invalidates the confirmation.
   */
  recipients: z
    .array(
      z.strictObject({ provider: z.string(), model: z.string(), origin: z.string().optional() }),
    )
    .min(1),
  /** False when the task needs no provider call (e.g. no contradiction candidates). */
  willSend: z.boolean(),
  /** The exact messages that will be sent. `outboundText` is the same content rendered for display. */
  messages: z.array(
    z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }),
  ),
  outboundText: z.string(),
  previewHash: Sha256Hex,
  chunks: z.array(
    z.strictObject({
      id: ChunkId,
      /** `question`, `claim` and `history` blocks are sent too but are not citeable. */
      kind: z.enum(['highlight', 'note', 'question', 'claim', 'history']),
      originalChars: z.number().int().min(0),
      truncated: z.boolean(),
      /** Sanitised, truncated, NOT yet redacted: redaction offsets refer to this text. */
      text: z.string(),
      /** What is sent for this chunk. */
      sentText: z.string(),
    }),
  ),
  redactions: z.array(RedactionRegionSchema),
  redactionSummary: z.record(z.string(), z.number().int().min(0)),
  estimate: z.strictObject({
    inputChars: z.number().int().min(0),
    inputTokens: z.number().int().min(0),
    maxOutputTokens: z.number().int().min(0),
    /** Upper bound; null when the caller supplied no pricing. */
    estimatedCostUsd: z.number().min(0).nullable(),
  }),
  candidatePairs: z.array(z.tuple([ChunkId, ChunkId])),
  warnings: z.array(z.string().max(300)),
});
export type AiRequestPreview = z.infer<typeof AiRequestPreview>;

export const ConsentToken = z.strictObject({
  id: z.string().min(8).max(64),
  previewHash: Sha256Hex,
  kind: AiTaskKind,
  provider: z.string(),
  model: z.string(),
  createdAt: IsoDate,
});
export type ConsentToken = z.infer<typeof ConsentToken>;
