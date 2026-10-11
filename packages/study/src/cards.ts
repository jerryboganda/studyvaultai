import { SCHEMA_VERSION } from '@shared/constants';
import { parseCloze, renderCloze, segmentsToText } from './cloze';
import type { ClozeSegment } from './cloze';
import { shuffled } from './random';
import type { Random } from './random';
import { Card as CardSchema, LIMITS } from './schema';
import type { Card, Choice, Creator, KnowledgePoint, Rating } from './schema';
import { newFsrsState } from './scheduler';
import { toIso, toMs } from './time';
import type { DateInput } from './time';

/**
 * Card templates: turn user-supplied content plus a source link into validated card drafts.
 *
 * Nothing here "generates" knowledge: a template only arranges what the person (or an AI result the
 * person accepted) supplied. Every draft carries its source link (highlightId + a snapshot of the
 * quote) so review can jump back to the passage. Image occlusion is not offered: it needs image
 * attachments, which the vault does not store yet.
 */

/** Where a card came from. A linked highlight must come with the literal quote. */
export interface SourceRef {
  highlightId: string | null;
  quote: string | null;
  knowledgePointId?: string | null;
}

export interface CardMeta {
  tags?: readonly string[];
  createdBy?: Creator;
  /** Id of the AI result this card was accepted from, when createdBy is 'ai'. */
  aiResultId?: string | null;
  /** Force the "a person must check this" flag (always on for AI-made cards). */
  requireVerification?: boolean;
}

type Common = { source: SourceRef } & CardMeta;

export type CardDraft = Pick<
  Card,
  | 'cardType'
  | 'front'
  | 'back'
  | 'cloze'
  | 'choices'
  | 'answerChoiceId'
  | 'explanation'
  | 'tags'
  | 'knowledgePointId'
  | 'highlightId'
  | 'sourceQuote'
  | 'createdBy'
  | 'aiResultId'
  | 'needsHumanVerification'
>;

export type Built<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const blank = (s: string | undefined | null): boolean => !s || s.trim() === '';
const norm = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

type Core = Pick<
  CardDraft,
  'cardType' | 'front' | 'back' | 'cloze' | 'choices' | 'answerChoiceId'
> & {
  explanation?: string | undefined;
};

function finish(core: Core, common: Common, issues: string[]): Built<CardDraft> {
  const { source } = common;
  if (blank(core.front)) issues.push('The front of the card is empty.');
  if (blank(core.back)) issues.push('The back of the card is empty.');
  if (core.front.length > LIMITS.cardText || core.back.length > LIMITS.cardText) {
    issues.push(`Card text is limited to ${LIMITS.cardText} characters.`);
  }
  if (source.highlightId && blank(source.quote)) {
    issues.push('A card linked to a highlight must keep the highlight quote.');
  }
  if ((source.quote?.length ?? 0) > LIMITS.cardText) issues.push('The source quote is too long.');
  const tags: string[] = [];
  for (const raw of common.tags ?? []) {
    const t = raw.trim();
    if (t && !tags.some((x) => norm(x) === norm(t))) tags.push(t);
  }
  if (tags.length > LIMITS.tags || tags.some((t) => t.length > LIMITS.tag)) {
    issues.push(`Use at most ${LIMITS.tags} tags of ${LIMITS.tag} characters.`);
  }
  if (issues.length > 0) return { ok: false, issues };
  const createdBy = common.createdBy ?? 'user';
  const explanation = core.explanation?.trim();
  return {
    ok: true,
    value: {
      cardType: core.cardType,
      front: core.front.trim(),
      back: core.back.trim(),
      cloze: core.cloze,
      ...(core.choices ? { choices: core.choices } : {}),
      ...(core.answerChoiceId ? { answerChoiceId: core.answerChoiceId } : {}),
      ...(explanation ? { explanation } : {}),
      tags,
      knowledgePointId: source.knowledgePointId ?? null,
      highlightId: source.highlightId,
      sourceQuote: source.quote?.trim() ? source.quote : null,
      createdBy,
      aiResultId: common.aiResultId ?? null,
      needsHumanVerification: createdBy === 'ai' || common.requireVerification === true,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

export function buildBasic(
  input: Common & { question: string; answer: string; explanation?: string },
): Built<CardDraft> {
  return finish(
    {
      cardType: 'basic',
      front: input.question,
      back: input.answer,
      cloze: null,
      explanation: input.explanation,
    },
    input,
    [],
  );
}

export function buildDefinition(
  input: Common & { term: string; definition: string; example?: string },
): Built<CardDraft> {
  const issues: string[] = [];
  if (blank(input.term)) issues.push('The term is empty.');
  return finish(
    {
      cardType: 'definition',
      front: `Define: ${input.term.trim()}`,
      back: input.definition,
      cloze: null,
      explanation: input.example,
    },
    input,
    issues,
  );
}

export interface CompareRow {
  aspect: string;
  left: string;
  right: string;
}

export function buildCompare(
  input: Common & { left: string; right: string; rows: readonly CompareRow[] },
): Built<CardDraft> {
  const issues: string[] = [];
  const left = input.left.trim();
  const right = input.right.trim();
  if (!left || !right) issues.push('Both items to compare need a name.');
  else if (norm(left) === norm(right)) issues.push('The two items must differ.');
  if (input.rows.length < 1 || input.rows.length > 20) issues.push('Add between 1 and 20 aspects.');
  if (input.rows.some((r) => blank(r.aspect) || blank(r.left) || blank(r.right))) {
    issues.push('Every aspect needs a name and a value for both items.');
  }
  const back = input.rows
    .map((r) => `${r.aspect.trim()}\n  ${left}: ${r.left.trim()}\n  ${right}: ${r.right.trim()}`)
    .join('\n\n');
  return finish(
    {
      cardType: 'compare',
      front: `Differentiate: ${left} vs ${right}`,
      back,
      cloze: null,
    },
    input,
    issues,
  );
}

/**
 * Cloze cards from markup. One card per distinct deletion index (c1, c2, ...) by default: the other
 * deletions stay visible as context. `perDeletion: false` makes one card that hides everything.
 */
export function buildCloze(
  input: Common & { markup: string; perDeletion?: boolean; explanation?: string },
): Built<CardDraft[]> {
  const parsed = parseCloze(input.markup);
  if (parsed.deletions.length === 0) {
    return {
      ok: false,
      issues: ['Add at least one deletion, written as {{c1::answer}} or {{c1::answer::hint}}.'],
    };
  }
  const active: (number | null)[] = input.perDeletion === false ? [null] : parsed.indexes;
  const drafts: CardDraft[] = [];
  for (const activeIndex of active) {
    const built = finish(
      {
        cardType: 'cloze',
        front: segmentsToText(renderCloze(parsed, { activeIndex, reveal: false })),
        back: segmentsToText(renderCloze(parsed, { activeIndex, reveal: true })),
        cloze: { text: input.markup, deletions: parsed.deletions, activeIndex },
        explanation: input.explanation,
      },
      input,
      [],
    );
    if (!built.ok) return built;
    drafts.push(built.value);
  }
  return { ok: true, value: drafts };
}

/** Segments for the review UI (render each as a text node). */
export function clozeSegments(card: Pick<Card, 'cloze'>, reveal: boolean): ClozeSegment[] {
  if (!card.cloze) return [];
  return renderCloze(card.cloze.text, { activeIndex: card.cloze.activeIndex, reveal });
}

// ---------------------------------------------------------------------------------------------
// Multiple choice
// ---------------------------------------------------------------------------------------------

/** "All of the above" and friends only make sense in last position, so they are never shuffled. */
const POSITIONAL = /^(all|none|both|neither)\b.*\b(above|these|them)\b/i;

export interface McqInput extends Common {
  stem: string;
  choices: readonly string[];
  /** Position of the correct answer in `choices` (as authored, before shuffling). */
  correctIndex: number;
  explanation?: string;
  /** Injected so a shuffle is reproducible. */
  random: Random;
  /** Default true. */
  shuffle?: boolean;
}

/** Problems with a choice list and key. Empty when the key is structurally sound. */
export function mcqIssues(
  choices: readonly Pick<Choice, 'id' | 'text'>[],
  answerChoiceId: string | undefined,
): string[] {
  const issues: string[] = [];
  if (choices.length < 2) issues.push('A multiple-choice question needs at least 2 choices.');
  if (choices.length > LIMITS.choices) issues.push(`Use at most ${LIMITS.choices} choices.`);
  if (choices.some((c) => blank(c.text))) issues.push('Every choice needs text.');
  const keys = choices.map((c) => norm(c.text));
  if (new Set(keys).size !== keys.length) issues.push('Choices must be different from each other.');
  if (new Set(choices.map((c) => c.id)).size !== choices.length) issues.push('Choice ids repeat.');
  if (!answerChoiceId || !choices.some((c) => c.id === answerChoiceId)) {
    issues.push('The answer key does not point at one of the choices.');
  }
  return issues;
}

/** Choice order for display: shuffled, with positional choices ("All of the above") kept last. */
export function orderChoices<T extends { text: string }>(
  choices: readonly T[],
  random: Random,
): T[] {
  const free = choices.filter((c) => !POSITIONAL.test(c.text.trim()));
  const pinned = choices.filter((c) => POSITIONAL.test(c.text.trim()));
  return [...shuffled(free, random), ...pinned];
}

export function buildMcq(input: McqInput): Built<CardDraft> {
  const issues: string[] = [];
  if (blank(input.stem)) issues.push('The question is empty.');
  if (
    !Number.isInteger(input.correctIndex) ||
    input.correctIndex < 0 ||
    input.correctIndex >= input.choices.length
  ) {
    issues.push('Mark which choice is correct.');
  }
  const authored = input.choices.map((text, i) => ({ text: text.trim(), original: i }));
  const ordered = input.shuffle === false ? authored : orderChoices(authored, input.random);
  const choices: Choice[] = ordered.map((c, i) => ({ id: `ch${i + 1}`, text: c.text }));
  const keyAt = ordered.findIndex((c) => c.original === input.correctIndex);
  const answerChoiceId = keyAt >= 0 ? `ch${keyAt + 1}` : undefined;
  issues.push(...mcqIssues(choices, answerChoiceId));
  const answerText = keyAt >= 0 ? (choices[keyAt]?.text ?? '') : '';
  return finish(
    {
      cardType: 'mcq',
      front: input.stem,
      back: answerText,
      cloze: null,
      choices,
      answerChoiceId,
      explanation: input.explanation,
    },
    input,
    [...new Set(issues)],
  );
}

export interface McqGrade {
  correct: boolean;
  answerChoiceId: string;
}

/** Marks a chosen option; null when the card is not a valid multiple-choice card. */
export function gradeMcq(
  card: Pick<Card, 'cardType' | 'choices' | 'answerChoiceId'>,
  chosenId: string,
): McqGrade | null {
  if (card.cardType !== 'mcq' || !card.answerChoiceId) return null;
  if (!card.choices?.some((c) => c.id === chosenId)) return null;
  return { correct: chosenId === card.answerChoiceId, answerChoiceId: card.answerChoiceId };
}

/** Suggested button for a graded MCQ; the learner may still pick another. */
export const mcqSuggestedRating = (correct: boolean): Rating => (correct ? 3 : 1);

// ---------------------------------------------------------------------------------------------
// From a knowledge point
// ---------------------------------------------------------------------------------------------

export type KnowledgePointTemplate = 'pearl' | 'misconception';

/**
 * A recall card from an accepted knowledge point. The point's own wording is used verbatim; the quote
 * is attached as the source. AI-made points produce cards flagged for human verification.
 */
export function draftFromKnowledgePoint(
  kp: Pick<
    KnowledgePoint,
    'id' | 'highlightId' | 'shortOneLiner' | 'examPearl' | 'misconception' | 'createdBy'
  >,
  quote: string,
  template: KnowledgePointTemplate,
  meta: CardMeta = {},
): Built<CardDraft> {
  const common: Common = {
    ...meta,
    createdBy: meta.createdBy ?? kp.createdBy,
    source: { highlightId: kp.highlightId, quote, knowledgePointId: kp.id },
  };
  if (template === 'pearl') {
    if (blank(kp.examPearl))
      return { ok: false, issues: ['This knowledge point has no exam pearl.'] };
    return finish(
      {
        cardType: 'basic',
        front: `What is the exam pearl for: ${kp.shortOneLiner.trim()}`,
        back: kp.examPearl as string,
        cloze: null,
      },
      common,
      [],
    );
  }
  if (blank(kp.misconception)) {
    return { ok: false, issues: ['This knowledge point has no recorded misconception.'] };
  }
  return finish(
    {
      cardType: 'basic',
      front: `Common misconception: ${(kp.misconception as string).trim()}\nWhat is actually true?`,
      back: kp.shortOneLiner,
      cloze: null,
    },
    common,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// Draft -> Card
// ---------------------------------------------------------------------------------------------

/**
 * Makes a stored card from a draft. New cards start with fresh FSRS state and are due `now`.
 * Validates the whole record (throws ZodError on a programming error, e.g. a malformed id).
 */
export function createCard(
  draft: CardDraft,
  ids: { id: string; deckId: string },
  now: DateInput,
): Card {
  const at = toIso(toMs(now));
  const fsrs = newFsrsState(at);
  return CardSchema.parse({
    ...draft,
    id: ids.id,
    deckId: ids.deckId,
    schemaVersion: SCHEMA_VERSION,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    suspended: false,
    buriedUntil: null,
    dueAt: fsrs.due,
    fsrs,
  });
}

/** What review needs to open the source passage. */
export function cardSourceLink(
  card: Pick<Card, 'highlightId' | 'sourceQuote' | 'knowledgePointId'>,
): { highlightId: string; quote: string | null; knowledgePointId: string | null } | null {
  if (!card.highlightId) return null;
  return {
    highlightId: card.highlightId,
    quote: card.sourceQuote,
    knowledgePointId: card.knowledgePointId,
  };
}
