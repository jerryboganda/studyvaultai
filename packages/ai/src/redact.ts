// Deterministic redaction of personal data and secrets from text that is about to leave the device.
// Detection is heuristic (see LIMITATIONS): the user reviews and edits the regions in the preview.
import { findSecretSpans, looksOpaqueSecret } from './secrets';
import type { Span } from './secrets';

export const REDACTION_KINDS = [
  'url_secret',
  'api_key',
  'email',
  'card',
  'national_id',
  'phone',
  'manual',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export const PLACEHOLDERS: Record<RedactionKind, string> = {
  url_secret: '[URL_REMOVED]',
  api_key: '[API_KEY]',
  email: '[EMAIL]',
  card: '[CARD_NUMBER]',
  national_id: '[ID_NUMBER]',
  phone: '[PHONE]',
  manual: '[REDACTED]',
};

export interface RedactionRegion {
  /** `${chunkId}:${start}-${end}`; stable for the same text. */
  id: string;
  chunkId: string;
  /** Offsets into the sanitised chunk text shown in the preview. */
  start: number;
  end: number;
  kind: RedactionKind;
  placeholder: string;
  original: string;
  /** False = the user chose to keep this text (it WILL be sent). */
  enabled: boolean;
  origin: 'auto' | 'manual';
}

export interface RedactionEdits {
  /** Region ids the user decided to keep un-redacted. */
  keep?: string[];
  /** Extra regions the user marked by hand. */
  add?: { chunkId: string; start: number; end: number }[];
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const SENSITIVE_PARAM =
  /^(?:token|access_?token|id_?token|refresh_?token|key|api_?key|apikey|auth|authorization|sig|signature|secret|client_?secret|password|passwd|pwd|session|session_?id|sid|code|jwt|bearer|x-amz-(?:signature|credential|security-token)|x-goog-signature)$/i;

function urlHasSecret(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return true;
  for (const [name, value] of [
    ...u.searchParams,
    ...new URLSearchParams(u.hash.replace(/^#/, '')),
  ]) {
    if (SENSITIVE_PARAM.test(name) || looksOpaqueSecret(value)) return true;
  }
  return u.pathname.split('/').some((seg) => seg.length >= 32 && looksOpaqueSecret(seg));
}

interface Detector {
  kind: RedactionKind;
  find(text: string): Span[];
}

function regexSpans(text: string, re: RegExp, group = 0, accept?: (m: string) => boolean): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(re)) {
    const v = m[group];
    if (!v || (accept && !accept(v))) continue;
    const start = m.index + m[0].length - v.length; // captured value is the match suffix
    out.push({ start, end: start + v.length });
  }
  return out;
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

// Order = priority: an earlier detector wins an overlap (a 16 digit card must not become a phone).
const DETECTORS: Detector[] = [
  {
    kind: 'url_secret',
    find: (t) =>
      regexSpans(t, /https?:\/\/[^\s<>"'`)\]}]+/gi).flatMap((s) => {
        const raw = t.slice(s.start, s.end).replace(/[.,;:!?]+$/, '');
        return urlHasSecret(raw) ? [{ start: s.start, end: s.start + raw.length }] : [];
      }),
  },
  { kind: 'api_key', find: findSecretSpans },
  {
    kind: 'email',
    find: (t) =>
      regexSpans(
        t,
        /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,10}\.[A-Za-z]{2,24}/g,
      ),
  },
  {
    kind: 'card',
    find: (t) =>
      regexSpans(t, /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, 0, (m) => {
        const d = digitsOf(m);
        return d.length >= 13 && d.length <= 19 && luhnValid(d);
      }),
  },
  {
    kind: 'national_id',
    find: (t) => [
      ...regexSpans(t, /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/g),
      ...regexSpans(t, /(?<!\d)[23]\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{7}(?!\d)/g),
      ...regexSpans(t, /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g),
      ...regexSpans(t, /(?<!\d\s?)[2-9]\d{3}\s\d{4}\s\d{4}(?!\s?\d)/g),
      ...regexSpans(
        t,
        /\b(?:national\s{0,3}id|ssn|social\s{0,3}security(?:\s{0,3}(?:number|no\.?))?|passport(?:\s{0,3}(?:number|no\.?))?|id\s{0,3}(?:number|no\.?)|patient\s{0,3}id|medical\s{0,3}record\s{0,3}(?:number|no\.?)|mrn|nin|nric|aadhaar)\b[\s:#.=-]{0,6}((?=[A-Za-z-]*\d)[A-Za-z0-9][A-Za-z0-9-]{4,18})/gi,
        1,
        (m) => /\d/.test(m),
      ),
    ],
  },
  {
    kind: 'phone',
    find: (t) => {
      const ok = (m: string) => {
        const n = digitsOf(m).length;
        return n >= 9 && n <= 15;
      };
      return [
        ...regexSpans(
          t,
          /(?<![\w+])\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g,
          0,
          ok,
        ),
        ...regexSpans(t, /(?<!\d)\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, 0, ok),
        ...regexSpans(t, /(?<!\d)0\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{3,4}(?!\d)/g, 0, ok),
      ];
    },
  },
];

/** All auto-detected regions for one (already sanitised) chunk text, non-overlapping, in order. */
export function detectRegions(chunkId: string, text: string): RedactionRegion[] {
  const taken: RedactionRegion[] = [];
  for (const d of DETECTORS) {
    for (const s of d.find(text)) {
      if (taken.some((r) => s.start < r.end && s.end > r.start)) continue;
      taken.push(region(chunkId, s.start, s.end, d.kind, text, 'auto'));
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

function region(
  chunkId: string,
  start: number,
  end: number,
  kind: RedactionKind,
  text: string,
  origin: 'auto' | 'manual',
): RedactionRegion {
  return {
    id: `${chunkId}:${start}-${end}`,
    chunkId,
    start,
    end,
    kind,
    placeholder: PLACEHOLDERS[kind],
    original: text.slice(start, end),
    enabled: true,
    origin,
  };
}

/** Auto regions plus the user's edits (kept regions disabled, hand-marked regions added). */
export function resolveRegions(
  chunkId: string,
  text: string,
  edits: RedactionEdits | undefined,
): RedactionRegion[] {
  const keep = new Set(edits?.keep ?? []);
  const regions = detectRegions(chunkId, text).map((r) => ({ ...r, enabled: !keep.has(r.id) }));
  for (const a of edits?.add ?? []) {
    if (a.chunkId !== chunkId) continue;
    const start = Math.max(0, Math.min(a.start, text.length));
    const end = Math.max(start, Math.min(a.end, text.length));
    if (end === start || regions.some((r) => start < r.end && end > r.start)) continue;
    regions.push(region(chunkId, start, end, 'manual', text, 'manual'));
  }
  return regions.sort((a, b) => a.start - b.start);
}

export function applyRegions(text: string, regions: readonly RedactionRegion[]): string {
  let out = '';
  let pos = 0;
  for (const r of regions) {
    if (!r.enabled || r.start < pos) continue;
    out += text.slice(pos, r.start) + r.placeholder;
    pos = r.end;
  }
  return out + text.slice(pos);
}

export function summarizeRegions(
  regions: readonly RedactionRegion[],
): Partial<Record<RedactionKind, number>> {
  const out: Partial<Record<RedactionKind, number>> = {};
  for (const r of regions) if (r.enabled) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}
