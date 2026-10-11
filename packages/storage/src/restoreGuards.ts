import type { TableRegistry } from '@shared';
import { groundClaims } from '@ai';
import {
  ALL_FIELDS,
  type CitationGuard,
  type ImmutableFields,
  type Passage,
  type Row,
} from '@backup';
import { STUDYVAULT_SYNC_POLICY, type SyncPolicy } from '@sync/policy';
import { StoredAiResultSchema } from './ai';

/**
 * What a restore must not take from an archive, decided here (the storage side) and handed to the
 * pure @backup engine through its ports (`RestoreTarget.immutableFields`, `.citationGuard`).
 */

// ---------------------------------------------------------------------------------------------
// Provenance: the sync policy's immutable list is the only list
// ---------------------------------------------------------------------------------------------

/**
 * Per registry table, the fields a merge-restore may not change on an existing row: exactly the
 * `immutable` members of the sync policy (capturedUrl, source urlKey/originalUrl/host, card
 * sourceQuote ...), and every field of an append-only table. A forged archive therefore cannot
 * repoint a citation at another address through a merge. Read when a restore starts, so schemas and
 * policy changes made by other modules are seen.
 */
export function immutableFieldsOf(
  registry: TableRegistry,
  policy: SyncPolicy = STUDYVAULT_SYNC_POLICY,
): ImmutableFields {
  const out: Record<string, readonly string[]> = {};
  for (const spec of registry.tables) {
    const p = Object.hasOwn(policy, spec.name) ? policy[spec.name] : undefined;
    if (!p) continue;
    const fields = p.appendOnly === true ? [ALL_FIELDS] : [...(p.immutable ?? [])];
    if (fields.length > 0) out[spec.name] = fields;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// AI results: re-ground what an archive claims
// ---------------------------------------------------------------------------------------------

export const RESTORE_REGROUND_NOTICE =
  'Restored from a backup: its citations were re-checked against the passages in your vault, and the ones that could not be found were removed.';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value a JSON pointer ("/cards/0/evidence/1/text") names inside plain data, else undefined. */
function valueAt(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = root;
  for (const segment of pointer.split('/').slice(1)) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(cur)) {
      cur = /^\d{1,6}$/.test(key) ? cur[Number(key)] : undefined;
    } else if (isObject(cur) && Object.hasOwn(cur, key)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

const MAX_CITED_PER_ROW = 700;

interface StoredClaim {
  path: string;
  quoteId: string;
  supported: boolean;
  reason: 'ok' | 'unknown_id' | 'quote_not_found' | 'quote_too_short' | 'not_a_candidate';
}

function storedClaims(row: Row): StoredClaim[] {
  const grounding = row.grounding;
  if (!isObject(grounding) || !Array.isArray(grounding.claims)) return [];
  const out: StoredClaim[] = [];
  for (const c of grounding.claims.slice(0, 500)) {
    if (!isObject(c) || typeof c.path !== 'string' || typeof c.quoteId !== 'string') continue;
    out.push({
      path: c.path,
      quoteId: c.quoteId,
      supported: c.supported === true,
      reason: (typeof c.reason === 'string' ? c.reason : 'ok') as StoredClaim['reason'],
    });
  }
  return out;
}

/**
 * Re-check one stored AI result against the passages the vault actually holds, with the same
 * deterministic rule the pipeline used (`groundClaims`: the cited text must be a verbatim span of
 * the cited passage). A claim is only ever downgraded, never upgraded.
 *  - the grounding report is recomputed (unsupported claims stay listed, as unsupported);
 *  - citations that cannot be found are dropped;
 *  - `source_supported` survives only for a result the person accepted whose citations all hold;
 *    `conflicting` only while its evidence holds; everything else is `unverified`;
 *  - per-task labels the pipeline would have downgraded are downgraded the same way (fact-check
 *    verdicts, explain answer state, MCQ human-verification flag).
 * Returns the same object when nothing needs to change.
 */
function regrade(row: Row, passages: ReadonlyMap<string, Passage>): Row {
  const chunks = new Map<string, { id: string; kind: 'highlight' | 'note'; sent: string }>();
  for (const [id, p] of passages) {
    chunks.set(id, { id, kind: p.table === 'notes' ? 'note' : 'highlight', sent: p.text });
  }
  const before = storedClaims(row);
  const quoteOf = (path: string): string => {
    const v = valueAt(row.output, path);
    return typeof v === 'string' ? v : '';
  };
  const local = groundClaims(
    before.map((c) => ({ path: c.path, quoteId: c.quoteId, quote: quoteOf(c.path) })),
    chunks,
  );
  const claims = before.map((c, i): StoredClaim => {
    const l = local.claims[i];
    if (!c.supported || !l || l.supported) return c;
    return { path: c.path, quoteId: c.quoteId, supported: false, reason: l.reason };
  });
  const supportedCount = claims.filter((c) => c.supported).length;
  const grounding = {
    checked: claims.length,
    supported: supportedCount,
    unsupported: claims.length - supportedCount,
    claims,
  };
  let changed = claims.some((c, i) => c.supported !== before[i]?.supported);
  const supportedPaths = new Set(claims.filter((c) => c.supported).map((c) => c.path));

  // citations: a quote must be a verbatim span of the highlight/note it names
  const citations: unknown[] = [];
  if (Array.isArray(row.citations)) {
    for (const c of row.citations) {
      if (!isObject(c) || typeof c.quote !== 'string') {
        changed = true;
        continue;
      }
      const id = typeof c.highlightId === 'string' ? c.highlightId : c.noteId;
      const want = typeof c.highlightId === 'string' ? 'highlights' : 'notes';
      const passage = typeof id === 'string' ? passages.get(id) : undefined;
      const held =
        passage?.table === want &&
        typeof id === 'string' &&
        groundClaims([{ path: '', quoteId: id, quote: c.quote }], chunks).claims[0]?.supported ===
          true;
      if (held) citations.push(c);
      else changed = true;
    }
  }

  // the label
  let verificationState = row.verificationState;
  const accepted = typeof row.acceptedByUserAt === 'string';
  const holds = grounding.checked > 0 && grounding.unsupported === 0;
  if (verificationState === 'source_supported' && !(accepted && holds)) {
    verificationState = 'unverified';
  } else if (verificationState === 'conflicting' && grounding.unsupported > 0) {
    verificationState = 'unverified';
  }
  if (verificationState !== row.verificationState) changed = true;

  // per-task labels (what the pipeline's `finalize` would have done with this grounding)
  let output = row.output;
  if (isObject(output)) {
    if (row.kind === 'fact_check' && Array.isArray(output.checks)) {
      const original: unknown[] = output.checks;
      const checks = original.map((c, i) => {
        if (!isObject(c) || c.label === 'not_checked') return c;
        const evidence = Array.isArray(c.evidence) ? c.evidence : [];
        const grounded =
          evidence.length > 0 &&
          evidence.every((_, k) => supportedPaths.has(`/checks/${i}/evidence/${k}/text`));
        return grounded ? c : { ...c, label: 'not_checked' };
      });
      if (checks.some((c, i) => c !== original[i])) {
        changed = true;
        output = { ...output, checks };
      }
    } else if (row.kind === 'mcq' && grounding.unsupported > 0) {
      if (output.requiresHumanVerification !== true) {
        changed = true;
        output = { ...output, requiresHumanVerification: true };
      }
    } else if (
      row.kind === 'explain' &&
      Array.isArray(output.evidence) &&
      output.answerState !== 'insufficient_sources'
    ) {
      const total = output.evidence.length;
      const good = output.evidence.filter((_, i) =>
        supportedPaths.has(`/evidence/${i}/text`),
      ).length;
      const answerState =
        good === 0
          ? 'insufficient_sources'
          : good < total
            ? 'partially_answered'
            : output.answerState;
      if (answerState !== output.answerState) {
        changed = true;
        const uncertainty =
          typeof output.uncertainty === 'string' && output.uncertainty !== ''
            ? output.uncertainty
            : 'Some cited passages could not be found in your sources.';
        output = { ...output, answerState, uncertainty };
      }
    }
  }
  if (!changed) return row;

  const notices = Array.isArray(row.notices)
    ? row.notices.filter((n) => typeof n === 'string')
    : [];
  const next: Row = {
    ...row,
    output,
    grounding,
    citations,
    verificationState,
    notices: notices.includes(RESTORE_REGROUND_NOTICE)
      ? notices
      : [...notices.slice(0, 7), RESTORE_REGROUND_NOTICE],
  };
  if (StoredAiResultSchema.safeParse(next).success) return next;
  // The rebuilt row did not validate: at least never keep a label the check did not support.
  return {
    ...row,
    verificationState: row.verificationState === 'unsupported' ? 'unsupported' : 'unverified',
  };
}

/** Citation guard for the `aiResults` table: highlights' quotes and notes' bodies are the passages. */
export const aiCitationGuard: CitationGuard = {
  table: 'aiResults',
  passages: { highlights: 'exactQuote', notes: 'body' },
  cited(row) {
    const ids = new Set<string>();
    const add = (v: unknown) => {
      if (typeof v === 'string' && v.length > 0 && v.length <= 80 && ids.size < MAX_CITED_PER_ROW) {
        ids.add(v);
      }
    };
    if (Array.isArray(row.citations)) {
      for (const c of row.citations.slice(0, 200)) {
        if (isObject(c)) {
          add(c.highlightId);
          add(c.noteId);
        }
      }
    }
    for (const c of storedClaims(row)) add(c.quoteId);
    return [...ids];
  },
  regrade,
};
