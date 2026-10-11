// "Chat with your notes": retrieval over the person's own index, on this device. Nothing here sends
// anything; what it returns is the list the consent preview shows (and lets the person untick).
import { retrievalQuery, searchPassages, type PassageSearch } from '@ai';
import { resolveAiSources, type AiSourceRef } from '@storage';

/** Passages offered per question. The preview shows all of them; only ticked ones are sent. */
export const CHAT_TOP_K = 8;
/** Characters of passages offered at most, so the request stays inside the engine's input limit. */
export const CHAT_MAX_CHARS = 15_000;

export interface AiChatPassage {
  /** The highlight or note id: what the answer cites, verbatim. */
  id: string;
  kind: 'highlight' | 'note';
  /** The immutable quote or the note body, read from the vault (never from the index). */
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
  `${ref.kind === 'note' ? 'note' : 'highlight'}${ref.sourceTitle ? ` from ${ref.sourceTitle}` : ''}${
    ref.host ? ` (${ref.host})` : ''
  }`;

/**
 * The best passages of the scope for a question. The index only says WHICH highlights and notes; their
 * text is read from the vault, so what is offered (and later cited) is the immutable quote, and one
 * that was deleted since the index was built is not offered at all.
 */
export async function retrieveForChat(
  index: PassageSearch,
  args: { question: string; scope?: string; topK?: number },
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
    if (passages.length > 0 && chars + src.text.length > CHAT_MAX_CHARS) break;
    chars += src.text.length;
    passages.push({ id: src.id, kind: src.kind, text: src.text, label: labelOf(src) });
  }
  return { query, passages, matched: total };
}
