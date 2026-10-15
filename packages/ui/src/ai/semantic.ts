// "Smart matching" for chat: passages that mean what the question means even when they share none
// of its words. Everything runs on this device with the bundled static embedding (ADR-025); no
// request is made and nothing is stored beyond an in-memory cache.
import { browser } from 'wxt/browser';
import {
  createStaticEmbedder,
  parseEmbeddingModel,
  rankBySimilarity,
  type StaticEmbedder,
} from '@search';
import { listSearchDocuments, resolveAiSources, type AiSourceRef } from '@storage';
import { AI_NOTE_PREFIX, loadStudyItems, type AiChatPassage, type StudyItem } from './chat';

const MODEL_PATH = 'models/potion-base-8m-int8.bin';
const VOCAB_PATH = 'models/potion-base-8m-vocab.json';

let embedderPromise: Promise<StaticEmbedder | null> | null = null;

/** The bundled embedder, loaded once. Null when the files cannot be read (matching then stays lexical). */
export function loadEmbedder(): Promise<StaticEmbedder | null> {
  embedderPromise ??= (async () => {
    try {
      const url = (p: string) => browser.runtime.getURL(`/${p}` as never);
      const [bin, vocab] = await Promise.all([
        fetch(url(MODEL_PATH)).then((r) =>
          r.ok ? r.arrayBuffer() : Promise.reject(new Error('model')),
        ),
        fetch(url(VOCAB_PATH)).then((r) => (r.ok ? r.json() : Promise.reject(new Error('vocab')))),
      ]);
      return createStaticEmbedder(parseEmbeddingModel(bin), vocab as string[]);
    } catch {
      embedderPromise = null;
      return null;
    }
  })();
  return embedderPromise;
}

/** The fields of a search document that matching needs. */
export interface SemanticDoc {
  id: string;
  docType: 'highlight' | 'note';
  quote: string;
  comment: string;
  banks: readonly string[];
  folderPath: readonly string[];
  tags: readonly string[];
  deletedAt: string | null;
}

interface Corpus {
  at: number;
  docs: SemanticDoc[];
}
let corpus: Corpus | null = null;
const CORPUS_TTL_MS = 30_000;
const vectorCache = new Map<string, Float32Array | null>();

async function allDocuments(): Promise<SemanticDoc[]> {
  if (corpus && Date.now() - corpus.at < CORPUS_TTL_MS) return corpus.docs;
  const docs: SemanticDoc[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < 40; page++) {
    const batch = await listSearchDocuments({ limit: 500, ...(afterId ? { afterId } : {}) });
    docs.push(...batch);
    if (batch.length < 500) break;
    afterId = batch.at(-1)!.id;
  }
  corpus = { at: Date.now(), docs: docs.filter((d) => d.deletedAt === null) };
  return corpus.docs;
}

export interface SemanticArgs {
  question: string;
  /** Names of the chosen bank, folder and tag (as the search documents carry them). */
  bankName: string | null;
  folderName: string | null;
  tagName: string | null;
  /** Highlights the chat is scoped to (for flashcards and knowledge points); null = all. */
  inScope: ReadonlySet<string> | null;
  topK?: number;
  /** Ids already offered by keyword matching. */
  exclude?: ReadonlySet<string>;
}

export interface SemanticDeps {
  embedder?: () => Promise<StaticEmbedder | null>;
  documents?: () => Promise<SemanticDoc[]>;
  studyItems?: () => Promise<StudyItem[]>;
  resolve?: (ids: readonly string[]) => Promise<Map<string, AiSourceRef>>;
}

const inNames = (d: SemanticDoc, a: SemanticArgs): boolean =>
  (a.bankName === null || d.banks.includes(a.bankName)) &&
  (a.folderName === null || d.folderPath.includes(a.folderName)) &&
  (a.tagName === null || d.tags.includes(a.tagName));

/** The passages closest in meaning to the question: highlights, notes, flashcards, knowledge points. */
export async function semanticPassages(
  a: SemanticArgs,
  deps: SemanticDeps = {},
): Promise<AiChatPassage[]> {
  const embedder = await (deps.embedder ?? loadEmbedder)();
  if (!embedder) return [];
  const exclude = a.exclude ?? new Set<string>();
  const docs = (await (deps.documents ?? allDocuments)()).filter(
    (d) =>
      !exclude.has(d.id) &&
      inNames(d, a) &&
      !(d.docType === 'note' && d.comment.startsWith(AI_NOTE_PREFIX)),
  );
  const items = (await (deps.studyItems ?? loadStudyItems)()).filter(
    (it) =>
      !exclude.has(it.id) &&
      (a.inScope === null || (it.highlightId !== null && a.inScope.has(it.highlightId))),
  );
  const candidates = [
    ...docs.map((d) => ({ id: d.id, text: `${d.quote} ${d.comment}`.trim() })),
    ...items.map((it) => ({ id: it.id, text: it.text })),
  ].filter((c) => c.text !== '');
  const hits = rankBySimilarity(embedder, a.question, candidates, {
    topK: a.topK ?? 6,
    cache: vectorCache,
  });
  if (hits.length === 0) return [];
  const itemById = new Map(items.map((it) => [it.id, it]));
  const vaultIds = hits.map((h) => h.id).filter((id) => !itemById.has(id));
  const found = await (deps.resolve ?? resolveAiSources)(vaultIds);
  const out: AiChatPassage[] = [];
  for (const h of hits) {
    const item = itemById.get(h.id);
    if (item) {
      out.push({
        id: item.id,
        kind: item.kind,
        text: item.text,
        label: item.kind === 'card' ? 'flashcard' : 'knowledge point',
      });
      continue;
    }
    const src = found.get(h.id);
    if (!src || src.deleted || src.text.trim() === '') continue;
    out.push({
      id: src.id,
      kind: src.kind,
      text: src.text,
      label: `${src.kind === 'note' ? 'note' : 'highlight'}${src.sourceTitle ? ` from ${src.sourceTitle}` : ''}`,
    });
  }
  return out;
}
