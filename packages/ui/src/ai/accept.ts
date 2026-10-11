// Pure: turns one reviewable item of an AI result into the records the user accepts. Nothing here
// touches storage; `acceptAiItem` (@storage) validates and commits them atomically.
import { uuidv7 } from 'uuidv7';
import { UNVERIFIED_NOTICE, type AiResult } from '@ai';
import { SCHEMA_VERSION, type Note } from '@shared';
import { DEFAULT_DECK_SETTINGS, type Deck, type KnowledgePoint } from '@study/schema';
import { buildBasic, buildCloze, buildMcq, createCard, type CardDraft } from '@study/cards';
import type { AiAcceptInput, AiSourceRef } from '@storage';

export type Sources = ReadonlyMap<string, AiSourceRef>;

/** A result as stored: `explain` keeps the question that was asked. */
type WithQuestion = AiResult & { question?: string | undefined };

/** What the person sees and may edit before accepting. */
export type AiDraft =
  | { type: 'pearl'; oneLiner: string; why: string; highlightId: string }
  | { type: 'note'; title: string; body: string }
  | { type: 'basic'; front: string; back: string; highlightId: string | null }
  | { type: 'cloze'; text: string; extra: string; highlightId: string | null }
  | {
      type: 'mcq';
      stem: string;
      choices: string[];
      keyIndex: number;
      explanation: string;
      highlightId: string | null;
    };

/** Markdown-significant characters are escaped: model text stays inert text inside a note. */
const esc = (s: string): string =>
  s
    .replace(/[\\`*_[\]<>#|]/g, '\\$&')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function quoteOf(sources: Sources, id: string): string | null {
  const ref = sources.get(id);
  return ref && !ref.deleted ? ref.text : null;
}

/** First cited chunk that is a highlight the vault still holds (the card's source link). */
function highlightOf(evidence: readonly { quoteId: string }[], sources: Sources): string | null {
  for (const e of evidence) {
    const ref = sources.get(e.quoteId);
    if (ref?.kind === 'highlight' && !ref.deleted) return e.quoteId;
  }
  return null;
}

/** The immutable passages the result's verified citations point at. */
function citedSection(result: AiResult, sources: Sources): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of result.citations) {
    const id = c.highlightId ?? c.noteId;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const ref = sources.get(id);
    if (!ref || ref.deleted) continue;
    const from = ref.sourceTitle ? ` (${esc(ref.sourceTitle)})` : '';
    out.push(`> ${esc(clip(ref.text, 400))}${from}`, '');
  }
  return out.length > 0 ? ['## Cited passages', '', ...out] : [];
}

/** A note body for every result that is not a card or a knowledge point. */
export function toMarkdown(result: WithQuestion, sources: Sources): string {
  const head = [
    `> **AI-generated, unverified.** Drafted by ${esc(result.provider)} / ${esc(result.model)} on ${result.createdAt.slice(0, 10)}. Check it against your sources before relying on it.`,
    ...result.notices.filter((n) => n !== UNVERIFIED_NOTICE).map((n) => `> ${esc(n)}`),
    '',
  ];
  const body: string[] = [];
  switch (result.kind) {
    case 'summary':
      body.push(esc(result.output.summary), '', '## Key points', '');
      for (const p of result.output.keyPoints) body.push(`- ${esc(p)}`);
      break;
    case 'structured_notes':
      for (const s of result.output.sections) {
        body.push(`## ${esc(s.heading)}`, '');
        for (const b of s.bullets) body.push(`- ${esc(b.text)}`);
        body.push('');
      }
      break;
    case 'explain':
      if (result.question) body.push(`**Question:** ${esc(result.question)}`, '');
      body.push(esc(result.output.answer));
      if (result.output.uncertainty)
        body.push('', `Not settled by the sources: ${esc(result.output.uncertainty)}`);
      body.push('', `Answer state: ${result.output.answerState.replace(/_/g, ' ')}`);
      break;
    case 'compare_topics':
      for (const row of result.output.rows) {
        body.push(`## ${esc(row.aspect)}`, '');
        for (const c of row.cells) body.push(`- **${esc(c.topic)}**: ${esc(c.text)}`);
        body.push('');
      }
      break;
    case 'contradictions':
      if (result.output.contradictions.length === 0) {
        body.push(
          `No contradictions were reported among ${result.output.candidateCount} candidate pair(s).`,
        );
      }
      for (const c of result.output.contradictions) {
        body.push(`- ${esc(c.explanation)}`);
        for (const e of [c.a, c.b]) {
          const q = quoteOf(sources, e.quoteId);
          if (q) body.push(`  - > ${esc(clip(q, 300))}`);
        }
      }
      break;
    case 'fact_check':
      for (const c of result.output.checks) {
        body.push(`- **${esc(c.claim)}**: ${c.label.replace(/_/g, ' ')}. ${esc(c.explanation)}`);
      }
      break;
    default:
      body.push('(no text)');
  }
  return [...head, ...body, '', ...citedSection(result, sources)].join('\n').trimEnd() + '\n';
}

const NOTE_TITLES: Partial<Record<AiResult['kind'], string>> = {
  summary: 'AI summary',
  explain: 'AI answer',
  contradictions: 'AI contradiction check',
  fact_check: 'AI statement check',
};

export function initialDraft(result: WithQuestion, path: string, sources: Sources): AiDraft {
  switch (result.kind) {
    case 'exam_pearl':
      return {
        type: 'pearl',
        oneLiner: result.output.oneLiner,
        why: result.output.why,
        highlightId: result.output.sourceQuoteId,
      };
    case 'flashcards': {
      const card = result.output.cards[Number(path.split('/')[2])];
      if (!card) return { type: 'basic', front: '', back: '', highlightId: null };
      const highlightId = highlightOf(card.evidence, sources);
      return card.type === 'basic'
        ? { type: 'basic', front: card.front, back: card.back, highlightId }
        : { type: 'cloze', text: card.text, extra: card.extra ?? '', highlightId };
    }
    case 'mcq': {
      const o = result.output;
      return {
        type: 'mcq',
        stem: o.stem,
        choices: o.choices.map((c) => c.text),
        keyIndex: Math.max(
          0,
          o.choices.findIndex((c) => c.id === o.keyChoiceId),
        ),
        explanation: o.explanation,
        highlightId: highlightOf(o.evidence, sources),
      };
    }
    case 'structured_notes':
      return {
        type: 'note',
        title: clip(result.output.title, 200),
        body: toMarkdown(result, sources),
      };
    case 'compare_topics':
      return {
        type: 'note',
        title: clip(`AI comparison: ${result.output.topics.join(' vs ')}`, 200),
        body: toMarkdown(result, sources),
      };
    default:
      return {
        type: 'note',
        title: NOTE_TITLES[result.kind] ?? 'AI note',
        body: toMarkdown(result, sources),
      };
  }
}

export interface BuildContext {
  now: Date;
  sources: Sources;
  /** Existing deck, or a new one to create (cards only). */
  deck: { id: string } | { name: string } | null;
}

export type BuildOutcome = { ok: true; input: AiAcceptInput } | { ok: false; issues: string[] };

const failed = (...issues: string[]): BuildOutcome => ({ ok: false, issues });

/** Records for one accepted item. Every AI-made record is flagged for human verification. */
export function buildAccept(
  result: WithQuestion,
  path: string,
  draft: AiDraft,
  edited: boolean,
  ctx: BuildContext,
): BuildOutcome {
  const ts = ctx.now.toISOString();
  const base = { resultId: result.id, itemPath: path, edited };
  const record = { schemaVersion: SCHEMA_VERSION, createdAt: ts, updatedAt: ts, deletedAt: null };

  if (draft.type === 'pearl') {
    if (!draft.oneLiner.trim()) return failed('The one-line statement is empty.');
    const knowledgePoint: KnowledgePoint = {
      id: uuidv7(),
      ...record,
      highlightId: draft.highlightId,
      primaryQuoteId: draft.highlightId,
      shortOneLiner: draft.oneLiner.trim(),
      examPearl: draft.why.trim() || null,
      misconception: null,
      // The model's wording is not checked against anything: it starts, and stays, unchecked.
      verificationStatus: 'not_checked',
      claims: [
        {
          text: draft.oneLiner.trim(),
          evidenceHighlightIds: [draft.highlightId],
          reliability: 'unrated',
        },
      ],
      createdBy: 'ai',
      acceptedAt: ts,
    };
    return { ok: true, input: { ...base, knowledgePoint } };
  }

  if (draft.type === 'note') {
    if (!draft.body.trim()) return failed('The note is empty.');
    const refs = result.inputSourceIds.map((id) => ctx.sources.get(id));
    const highlights = refs.filter((r): r is AiSourceRef => r?.kind === 'highlight' && !r.deleted);
    const only = highlights.length === 1 ? highlights[0] : undefined;
    const sourceIds = new Set(highlights.map((h) => h.sourceId));
    const sourceId = sourceIds.size === 1 ? ([...sourceIds][0] ?? null) : null;
    const note: Note = {
      id: uuidv7(),
      ...record,
      highlightId: only?.id ?? null,
      sourceId,
      title: draft.title.trim().slice(0, 200),
      body: draft.body,
      pinned: false,
    };
    return { ok: true, input: { ...base, note } };
  }

  // Cards
  if (!ctx.deck) return failed('Choose a deck for the card.');
  let deckId: string;
  let deck: Deck | undefined;
  if ('id' in ctx.deck) deckId = ctx.deck.id;
  else {
    const name = ctx.deck.name.trim();
    if (!name) return failed('Name the new deck.');
    deckId = uuidv7();
    deck = {
      id: deckId,
      ...record,
      bankId: null,
      name: name.slice(0, 80),
      settings: { ...DEFAULT_DECK_SETTINGS },
    };
  }
  const quote = draft.highlightId ? quoteOf(ctx.sources, draft.highlightId) : null;
  const source = {
    highlightId: quote === null ? null : draft.highlightId,
    quote,
    knowledgePointId: null,
  };
  const meta = { source, createdBy: 'ai' as const, aiResultId: result.id };
  let drafts: CardDraft[];
  if (draft.type === 'basic') {
    const built = buildBasic({ ...meta, question: draft.front, answer: draft.back });
    if (!built.ok) return failed(...built.issues);
    drafts = [built.value];
  } else if (draft.type === 'cloze') {
    const built = buildCloze({
      ...meta,
      markup: draft.text,
      ...(draft.extra.trim() ? { explanation: draft.extra.trim() } : {}),
    });
    if (!built.ok) return failed(...built.issues);
    drafts = built.value;
  } else {
    const built = buildMcq({
      ...meta,
      stem: draft.stem,
      choices: draft.choices,
      correctIndex: draft.keyIndex,
      ...(draft.explanation.trim() ? { explanation: draft.explanation.trim() } : {}),
      random: Math.random,
      shuffle: false,
      requireVerification: true,
    });
    if (!built.ok) return failed(...built.issues);
    drafts = [built.value];
  }
  try {
    const cards = drafts.map((d) => createCard(d, { id: uuidv7(), deckId }, ctx.now));
    return { ok: true, input: { ...base, cards, ...(deck ? { deck } : {}) } };
  } catch (e) {
    return failed(e instanceof Error ? e.message : 'The card is not valid.');
  }
}
