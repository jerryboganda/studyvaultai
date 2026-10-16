// Deterministic grounding: every quote a model cites must exist verbatim in the chunk it names.
// No LLM-as-judge. This proves "the cited text is in your source", never that the claim is true.
import type { Citation, Grounding } from './schema';
import { matchForm } from './text';

export interface Claim {
  /** JSON pointer into the output where the quote lives (e.g. `/evidence/0/text`). */
  path: string;
  quoteId: string;
  quote: string;
  /** Contradictions: the (a, b) chunk ids this claim belongs to; must be a deterministic candidate. */
  candidate?: readonly [string, string];
}

/** Quotes shorter than this are only accepted when they are the whole chunk. */
export const MIN_QUOTE_CHARS = 8;

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface ChunkText {
  id: string;
  kind: 'highlight' | 'note' | 'card' | 'knowledge_point';
  /** The text as sent to the provider (sanitised, truncated, redacted). */
  sent: string;
}

export function groundClaims(
  claims: readonly Claim[],
  chunks: ReadonlyMap<string, ChunkText>,
  candidateKeys?: ReadonlySet<string>,
): Grounding {
  const forms = new Map<string, string>();
  const formOf = (id: string, text: string) => {
    let f = forms.get(id);
    if (f === undefined) forms.set(id, (f = matchForm(text)));
    return f;
  };
  const out: Grounding['claims'] = claims.map((c) => {
    const base = { path: c.path, quoteId: c.quoteId };
    const chunk = chunks.get(c.quoteId);
    if (!chunk) return { ...base, supported: false, reason: 'unknown_id' as const };
    const q = matchForm(c.quote);
    const text = formOf(chunk.id, chunk.sent);
    if (q.length === 0 || (q.length < MIN_QUOTE_CHARS && q !== text)) {
      return { ...base, supported: false, reason: 'quote_too_short' as const };
    }
    if (!text.includes(q)) return { ...base, supported: false, reason: 'quote_not_found' as const };
    if (candidateKeys && c.candidate && !candidateKeys.has(pairKey(...c.candidate))) {
      return { ...base, supported: false, reason: 'not_a_candidate' as const };
    }
    return { ...base, supported: true, reason: 'ok' as const };
  });
  const supported = out.filter((c) => c.supported).length;
  return { checked: out.length, supported, unsupported: out.length - supported, claims: out };
}

/** Citations for the supported claims only, de-duplicated, as highlightId/noteId + verbatim quote. */
export function citationsFrom(
  claims: readonly Claim[],
  report: Grounding,
  chunks: ReadonlyMap<string, ChunkText>,
): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  claims.forEach((c, i) => {
    if (!report.claims[i]?.supported) return;
    const chunk = chunks.get(c.quoteId);
    if (!chunk) return;
    const key = `${chunk.id}\u0001${matchForm(c.quote)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const quote = c.quote;
    out.push(
      chunk.kind === 'highlight'
        ? { highlightId: chunk.id, quote }
        : chunk.kind === 'card'
          ? { cardId: chunk.id, quote }
          : chunk.kind === 'knowledge_point'
            ? { knowledgePointId: chunk.id, quote }
            : { noteId: chunk.id, quote },
    );
  });
  return out;
}
