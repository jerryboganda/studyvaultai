// "Chat with your notes": retrieval over the person's own index, on this device. Nothing here sends
// anything; what it returns is the list the consent preview shows (and lets the person untick).
import {
  contentTokens,
  expandTerms,
  questionTerms,
  retrievalQuery,
  searchPassages,
  stem,
  type PassageSearch,
} from '@ai';
import {
  cardPassage,
  knowledgePointPassage,
  listCards,
  listHighlights,
  listKnowledgePoints,
  resolveAiSources,
  type AiSourceRef,
} from '@storage';

/** Title prefix of a note made from a conversation (see ChatView "Save as a note"). */
export const AI_NOTE_PREFIX = 'AI chat:';

/** Passages offered per question. The preview shows all of them; only ticked ones are sent. */
export const CHAT_TOP_K = 8;
/** Characters of passages offered at most, so the request stays inside the engine's input limit. */
export const CHAT_MAX_CHARS = 15_000;

export interface AiChatPassage {
  /** The highlight or note id: what the answer cites, verbatim. */
  id: string;
  kind: 'highlight' | 'note' | 'card' | 'knowledge_point';
  /** The immutable quote, note body, card or knowledge point, read from the vault (never from the index). */
  text: string;
  /** Where it came from, for the list: "highlight from <page>". */
  label: string;
}

export interface AiChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** What the consent dialog needs to show a chat request: the question, the passages, earlier turns. */
export interface AiChatInput {
  question: string;
  passages: readonly AiChatPassage[];
  /** Oldest first. Only the ticked ones are sent. */
  history: readonly AiChatTurn[];
}

export interface ChatRetrieval {
  /** The search that ran; null when the question has nothing searchable in it. */
  query: string | null;
  passages: AiChatPassage[];
  /** Matches in the index before the cut to the best few. */
  matched: number;
}

const labelOf = (ref: AiSourceRef): string =>
  ref.kind === 'card'
    ? 'flashcard'
    : ref.kind === 'knowledge_point'
      ? 'knowledge point'
      : `${ref.kind === 'note' ? 'note' : 'highlight'}${ref.sourceTitle ? ` from ${ref.sourceTitle}` : ''}${
          ref.host ? ` (${ref.host})` : ''
        }`;

/**
 * The best passages of the scope for a question. The index only says WHICH highlights and notes; their
 * text is read from the vault, so what is offered (and later cited) is the immutable quote, and one
 * that was deleted since the index was built is not offered at all.
 */
export async function retrieveForChat(
  index: PassageSearch,
  args: { question: string; scope?: string; topK?: number; includeAiNotes?: boolean },
  resolve: (ids: readonly string[]) => Promise<Map<string, AiSourceRef>> = resolveAiSources,
): Promise<ChatRetrieval> {
  const query = retrievalQuery(args.question, args.scope ?? '');
  if (query === null) return { query, passages: [], matched: 0 };
  const { refs, total } = searchPassages(index, query, args.topK ?? CHAT_TOP_K);
  const found = await resolve(refs.map((r) => r.id));
  const passages: AiChatPassage[] = [];
  let chars = 0;
  for (const r of refs) {
    const src = found.get(r.id);
    if (!src || src.deleted || src.text.trim() === '') continue;
    // A chat saved as a note is the assistant's own words, not the person's study material: it is
    // only offered back to a chat when asked for, so answers do not cite earlier answers.
    if (
      !args.includeAiNotes &&
      src.kind === 'note' &&
      src.sourceTitle?.startsWith(AI_NOTE_PREFIX)
    ) {
      continue;
    }
    if (passages.length > 0 && chars + src.text.length > CHAT_MAX_CHARS) break;
    chars += src.text.length;
    passages.push({ id: src.id, kind: src.kind, text: src.text, label: labelOf(src) });
  }
  return { query, passages, matched: total };
}

/** A study item (flashcard or knowledge point) with the text that would be sent for it. */
export interface StudyItem {
  id: string;
  kind: 'card' | 'knowledge_point';
  text: string;
  /** The highlight it comes from; null for a free-standing card. Decides whether it is in scope. */
  highlightId: string | null;
}

/** Live flashcards and knowledge points of the vault, as passages. */
export async function loadStudyItems(): Promise<StudyItem[]> {
  const [cards, points] = await Promise.all([listCards({ limit: 2000 }), listKnowledgePoints()]);
  return [
    ...cards.cards.map((c) => ({
      id: c.id,
      kind: 'card' as const,
      text: cardPassage(c),
      highlightId: c.highlightId,
    })),
    ...points.map((k) => ({
      id: k.id,
      kind: 'knowledge_point' as const,
      text: knowledgePointPassage(k),
      highlightId: k.highlightId,
    })),
  ];
}

const wordsOf = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const w of contentTokens(text)) {
    out.add(w);
    out.add(stem(w));
  }
  return out;
};

/**
 * The flashcards and knowledge points that best match a question, on this device: their words
 * against the question's words (with stems and spelled-out abbreviations), rarer words counting
 * more. Needs more than one shared word when the question has several, so a stray common word does
 * not drag a card in. Nothing is sent.
 */
export async function retrieveStudyItems(
  question: string,
  topK = 4,
  load: () => Promise<StudyItem[]> = loadStudyItems,
  /**
   * The highlights the chat is scoped to (a bank, folder or tag); null = everything. An item belongs
   * to the scope through the highlight it was made from, so a free-standing card is only offered
   * when the scope is everything.
   */
  inScope: ReadonlySet<string> | null = null,
): Promise<AiChatPassage[]> {
  const base = questionTerms(question);
  if (base.length === 0) return [];
  // One group per word of the question: the word, its stem and what an abbreviation spells out.
  const groups = base.map((t) => expandTerms([t], 6));
  const loaded = await load();
  const items = inScope
    ? loaded.filter((it) => it.highlightId !== null && inScope.has(it.highlightId))
    : loaded;
  if (items.length === 0) return [];
  const docs = items.map((it) => ({ it, words: wordsOf(it.text) }));
  const df = groups.map((g) => docs.filter((d) => g.some((v) => d.words.has(v))).length);
  const need = base.length >= 4 ? 2 : 1;
  return docs
    .map((d) => {
      let hits = 0;
      let score = 0;
      groups.forEach((g, i) => {
        if (!g.some((v) => d.words.has(v))) return;
        hits += 1;
        score += Math.log(1 + docs.length / (1 + (df[i] ?? 0)));
      });
      return { d, hits, score };
    })
    .filter((x) => x.hits >= need)
    .sort((a, b) => b.score - a.score || (a.d.it.id < b.d.it.id ? -1 : 1))
    .slice(0, topK)
    .map(({ d }) => ({
      id: d.it.id,
      kind: d.it.kind,
      text: d.it.text,
      label: d.it.kind === 'card' ? 'flashcard' : 'knowledge point',
    }));
}

/**
 * The text of the `answer` field of a JSON reply that is still being written, decoded as far as it
 * has arrived. '' until the field starts. Only for showing progress: the finished reply is parsed
 * and validated as usual.
 */
export function partialAnswer(json: string): string {
  const start = /"answer"\s*:\s*"/.exec(json);
  if (!start) return '';
  let out = '';
  for (let i = start.index + start[0].length; i < json.length; i++) {
    const c = json[i]!;
    if (c === '"') break;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = json[i + 1];
    if (n === undefined) break;
    if (n === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(Number.parseInt(hex, 16) || 63);
      i += 5;
      continue;
    }
    out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    i += 1;
  }
  return out;
}

/** Upper bound on the highlights read to decide what is in a scope (500 per page, 20 pages). */
const SCOPE_PAGES = 20;

/**
 * Ids of the live highlights in a bank, folder (with its subtree) and/or tag: the scope of a chat.
 * Null when the scope is everything.
 */
export async function highlightIdsInScope(scope: {
  bankId: string | null;
  folderId: string | null;
  tagIds: readonly string[];
}): Promise<Set<string> | null> {
  if (scope.bankId === null && scope.folderId === null && scope.tagIds.length === 0) return null;
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < SCOPE_PAGES; page++) {
    const res: Awaited<ReturnType<typeof listHighlights>> = await listHighlights({
      ...(scope.folderId !== null
        ? { folderId: scope.folderId }
        : scope.bankId !== null
          ? { bankId: scope.bankId }
          : {}),
      ...(scope.tagIds.length > 0 ? { tagIds: [...scope.tagIds], tagMode: 'all' as const } : {}),
      limit: 500,
      cursor,
    });
    for (const item of res.items) ids.add(item.highlight.id);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return ids;
}
