// Preview + consent. `prepare` is the single place that decides what leaves the device; both
// `buildPreview` (what the user reviews) and `runTask` (what is sent) call it, and consent is bound to a
// hash of its output, so the user can only approve exactly what will be transmitted.
import { candidatePairs } from './candidates';
import { CHARS_PER_TOKEN, DEFAULT_LIMITS, TEMPLATE_VERSION } from './constants';
import { chainOf, worstPricing } from './deps';
import type { PipelineDeps } from './deps';
import { AiError } from './errors';
import type { ChunkText } from './grounding';
import { buildMessages, renderOutbound } from './prompt';
import type { DataBlock, Message } from './prompt';
import { applyRegions, resolveRegions, summarizeRegions } from './redact';
import type { RedactionEdits, RedactionRegion } from './redact';
import { AiSelection, AiTaskKind, ConsentToken } from './schema';
import type { AiRequestPreview } from './schema';
import { clip, collapseWhitespace, estimateTokens, sanitizeSourceText } from './text';
import { TASKS } from './tasks';
import type { TaskContext, TaskDef } from './tasks';

export type PrepareDeps = Pick<
  PipelineDeps,
  'provider' | 'fallbacks' | 'sha256' | 'limits' | 'pricing'
>;

export interface Prepared {
  kind: AiTaskKind;
  task: TaskDef;
  ctx: TaskContext;
  willSend: boolean;
  messages: Message[];
  maxOutputTokens: number;
  /** Citeable chunks by id, as sent. */
  chunkTexts: Map<string, ChunkText>;
  preview: AiRequestPreview;
}

/** Characters scanned past the cut so that a straddling token is detected whole. */
const DETECT_MARGIN = 512;

const CLINICAL_TERMS =
  /\b(?:patients?|diagnos\w*|clinical\w*|symptom\w*|syndrome|disease\w*|therap\w*|treatment\w*|dos(?:e|es|age)|contraindicat\w*|pathology|pathophysiolog\w*|radiolog\w*|ultrasound|mri|biops\w*|lesions?|carcinoma|tumou?rs?|surg\w*|prognos\w*|medication\w*|infections?|diabet\w*|mellitus|insulin|hyperglyc\w*|hypoglyc\w*|hypertens\w*|pharmacolog\w*|antibiotic\w*|vaccin\w*|oncolog\w*|mg\/kg|\d+\s?mg|mmhg)\b/gi;

/** Heuristic: two or more distinct medical terms. `selection.clinical` overrides it. */
export function looksClinical(text: string): boolean {
  const found = new Set<string>();
  for (const m of text.matchAll(CLINICAL_TERMS)) found.add(m[0].toLowerCase());
  return found.size >= 2;
}

function invalid(detail: string, issues?: string[]): AiError {
  return new AiError('invalid_selection', { detail, ...(issues ? { issues } : {}) });
}

interface Piece {
  id: string;
  kind: 'highlight' | 'note' | 'question' | 'claim' | 'history';
  original: string;
  text: string;
  truncated: boolean;
  regions: RedactionRegion[];
  sent: string;
}

/** Sanitise -> detect -> cut (never through a region) -> redact. Offsets stay valid for `text`. */
function piece(
  id: string,
  kind: Piece['kind'],
  raw: string,
  maxChars: number,
  edits: RedactionEdits | undefined,
): Piece {
  // Only the head is scanned (detectors are linear in it; a 100k-char paste must not cost quadratic time).
  // The margin lets a token that straddles the cut be seen whole.
  const full = sanitizeSourceText(raw);
  const clean = clip(full, maxChars + DETECT_MARGIN);
  const all = resolveRegions(id, clean, edits);
  let cut = Math.min(clean.length, maxChars);
  // Never end mid-token: back up to the previous whitespace, then out of any region.
  if (cut < full.length && /\S/.test(clean.charAt(cut - 1)) && /\S/.test(clean.charAt(cut))) {
    const ws = clean.slice(Math.max(0, cut - 256), cut).search(/\s\S*$/);
    if (ws >= 0) cut = Math.max(0, cut - 256) + ws;
  }
  for (const r of all) if (r.start < cut && r.end > cut) cut = r.start;
  const text = clip(clean, cut);
  const regions = all.filter((r) => r.end <= text.length);
  return {
    id,
    kind,
    original: raw,
    text,
    truncated: text.length < full.length,
    regions,
    sent: applyRegions(text, regions),
  };
}

export async function prepare(
  kindInput: unknown,
  selectionInput: unknown,
  deps: PrepareDeps,
  edits?: RedactionEdits,
): Promise<Prepared> {
  const k = AiTaskKind.safeParse(kindInput);
  if (!k.success) throw invalid('unknown task kind');
  const kind = k.data;
  const parsed = AiSelection.safeParse(selectionInput);
  if (!parsed.success) {
    throw invalid(
      'selection failed validation',
      parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const sel = parsed.data;
  const task = TASKS[kind];
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };

  if (sel.chunks.length > limits.maxChunks)
    throw new AiError('input_too_large', { detail: 'too many passages' });
  if (new Set(sel.chunks.map((c) => c.id)).size !== sel.chunks.length)
    throw invalid('duplicate passage id');
  // `question`, `claim_N` and `history_N` name the non-citeable blocks; a passage must not shadow them.
  if (sel.chunks.some((c) => c.id === 'question' || /^(?:claim|history)_\d+$/.test(c.id))) {
    throw invalid('reserved passage id');
  }
  if (sel.chunks.length < task.minChunks)
    throw invalid(`${kind} needs at least ${task.minChunks} passages`);
  if (kind === 'explain' && !sel.question) throw invalid('explain needs a question');
  if (kind === 'fact_check' && !sel.claims) throw invalid('fact_check needs statements to check');
  if (sel.history && kind !== 'explain') throw invalid('earlier turns are only used by explain');

  const pieces: Piece[] = sel.chunks.map((c) =>
    piece(c.id, c.kind, c.text, limits.maxChunkChars, edits),
  );
  if (pieces.some((p) => p.text.trim() === '')) throw invalid('a passage is empty after cleaning');
  const extras: Piece[] = [];
  (sel.history ?? []).forEach((h, i) =>
    extras.push(
      piece(
        `history_${i + 1}`,
        'history',
        `${h.role === 'user' ? 'The user asked' : 'The assistant answered'}: ${h.text}`,
        limits.maxChunkChars,
        edits,
      ),
    ),
  );
  if (kind === 'explain' && sel.question) {
    extras.push(piece('question', 'question', sel.question, limits.maxChunkChars, edits));
  }
  if (kind === 'fact_check') {
    (sel.claims ?? []).forEach((c, i) =>
      extras.push(piece(`claim_${i + 1}`, 'claim', c, limits.maxChunkChars, edits)),
    );
  }

  const chunkTexts = new Map<string, ChunkText>(
    pieces.map((p) => [p.id, { id: p.id, kind: p.kind as 'highlight' | 'note', sent: p.sent }]),
  );
  const sentAll = [...pieces, ...extras].map((p) => p.sent).join('\n');
  const candidates =
    kind === 'contradictions'
      ? candidatePairs(
          pieces.map((p) => ({ id: p.id, text: p.sent })),
          { maxPairs: limits.maxCandidatePairs },
        )
      : [];
  const ctx: TaskContext = {
    selection: sel,
    chunkIds: pieces.map((p) => p.id),
    candidates,
    claims: extras.filter((p) => p.kind === 'claim').map((p) => p.sent),
    clinical: sel.clinical ?? looksClinical(sentAll),
  };
  const willSend = task.needsCall(ctx);

  const blocks: DataBlock[] = [...pieces, ...extras].map((p) => ({
    id: p.id,
    kind: p.kind,
    text: p.sent,
  }));
  // Derived from the whole input with a real hash: a page cannot know it, so it cannot forge the closing
  // marker. Deterministic, so preview and run build byte-identical prompts.
  // Whitespace-normalised so that whitespace-only edits keep the same prompt (and the same cache key).
  const normalizedBlocks = JSON.stringify(
    blocks.map((b) => ({ ...b, text: collapseWhitespace(b.text) })),
  );
  let nonce = '';
  for (let i = 0; i < 8; i++) {
    nonce = (await deps.sha256(`${TEMPLATE_VERSION}\n${kind}\n${i}\n${normalizedBlocks}`)).slice(
      0,
      16,
    );
    if (!blocks.some((b) => b.text.includes(nonce))) break;
  }
  const messages = willSend ? buildMessages(task, ctx, blocks, nonce) : [];
  const maxOutputTokens = willSend ? Math.min(task.maxOutputTokens, limits.maxOutputTokens) : 0;

  const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = estimateTokens(inputChars, CHARS_PER_TOKEN);
  if (inputTokens > limits.maxInputTokens) {
    throw new AiError('input_too_large', {
      detail: `about ${inputTokens} tokens, limit ${limits.maxInputTokens}`,
    });
  }
  const chain = chainOf(deps);
  const pricing = worstPricing(chain);
  const estimatedCostUsd = !willSend
    ? 0
    : pricing
      ? (inputTokens * pricing.inputUsdPerMTok + maxOutputTokens * pricing.outputUsdPerMTok) /
        1_000_000
      : null;

  const regions = [...pieces, ...extras].flatMap((p) => p.regions);
  const warnings: string[] = [];
  for (const p of [...pieces, ...extras]) {
    if (p.truncated)
      warnings.push(
        `Passage ${p.id} is longer than ${limits.maxChunkChars} characters; only the start is sent.`,
      );
  }
  const enabled = regions.filter((r) => r.enabled).length;
  if (enabled > 0)
    warnings.push(
      `${enabled} sensitive-looking item(s) will be replaced before sending. Review them.`,
    );
  if (/<\/?[a-z][^>]*>|\]\(\s*\w+:/i.test(sentAll)) {
    warnings.push(
      'The text contains markup or links. It is sent as plain data and never followed.',
    );
  }
  if (!willSend) warnings.push('Nothing needs to be sent for this request.');

  const previewHash = await deps.sha256(
    JSON.stringify({
      v: 1,
      provider: deps.provider.id,
      model: deps.provider.model,
      origin: deps.provider.origin ?? null,
      // Only present with fallbacks: every provider that may receive the text, in order.
      ...(chain.length > 1
        ? {
            chain: chain.map((t) => [t.provider.id, t.provider.model, t.provider.origin ?? null]),
          }
        : {}),
      kind,
      templateVersion: TEMPLATE_VERSION,
      maxOutputTokens,
      messages,
    }),
  );

  const preview: AiRequestPreview = {
    kind,
    templateVersion: TEMPLATE_VERSION,
    provider: deps.provider.id,
    model: deps.provider.model,
    recipients: chain.map((t) => ({
      provider: t.provider.id,
      model: t.provider.model,
      ...(t.provider.origin ? { origin: t.provider.origin } : {}),
    })),
    willSend,
    messages,
    outboundText: renderOutbound(messages),
    previewHash,
    chunks: [...pieces, ...extras].map((p) => ({
      id: p.id,
      kind: p.kind,
      originalChars: p.original.length,
      truncated: p.truncated,
      text: p.text,
      sentText: p.sent,
    })),
    redactions: regions,
    redactionSummary: summarizeRegions(regions) as Record<string, number>,
    estimate: { inputChars, inputTokens, maxOutputTokens, estimatedCostUsd },
    candidatePairs: candidates,
    warnings,
  };
  return { kind, task, ctx, willSend, messages, maxOutputTokens, chunkTexts, preview };
}

/** What the user reviews: the exact outbound text, redaction regions (editable) and size/cost estimate. */
export async function buildPreview(
  kind: AiTaskKind,
  selection: AiSelection,
  deps: PrepareDeps,
  edits?: RedactionEdits,
): Promise<AiRequestPreview> {
  return (await prepare(kind, selection, deps, edits)).preview;
}

/** Records that the user approved this exact preview (hash). Persist `id` as `AiResult.consentRef`. */
export function createConsentToken(
  preview: AiRequestPreview,
  deps: Pick<PipelineDeps, 'now' | 'randomId'>,
): ConsentToken {
  return ConsentToken.parse({
    id: deps.randomId(),
    previewHash: preview.previewHash,
    kind: preview.kind,
    provider: preview.provider,
    model: preview.model,
    createdAt: new Date(deps.now()).toISOString(),
  });
}
