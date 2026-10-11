// Secret-shaped string detection shared by the redactor (outbound text) and the log scrubber.
import { shannonEntropy } from './entropy';

interface Pattern {
  re: RegExp;
  /** Capture group holding the secret value (whole match when absent). */
  group?: number;
}

const PATTERNS: Pattern[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { re: /\bAKIA[0-9A-Z]{16}\b/g },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
  {
    re: /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|token|password|passwd|pwd)\b["']?\s*[:=]\s*["']?([^\s"',;&]{6,})/gi,
    group: 1,
  },
];

export interface Span {
  start: number;
  end: number;
}

const OPAQUE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;

/** True for long mixed alphanumeric strings that look like generated secrets, not words or hashes in prose. */
export function looksOpaqueSecret(s: string): boolean {
  return s.length >= 24 && /\d/.test(s) && /[A-Za-z]/.test(s) && shannonEntropy(s) >= 3.5;
}

/** Non-overlapping spans of secret-like substrings, in order. */
export function findSecretSpans(text: string): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number) => {
    if (end > start && !spans.some((s) => start < s.end && end > s.start))
      spans.push({ start, end });
  };
  for (const { re, group } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = group ? m[group] : m[0];
      if (!value) continue;
      // The captured value is always the suffix of the match.
      const start = m.index + m[0].length - value.length;
      add(start, start + value.length);
    }
  }
  for (const m of text.matchAll(OPAQUE)) {
    if (looksOpaqueSecret(m[0])) add(m.index, m.index + m[0].length);
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Log/error scrubber. Replaces exact `knownSecrets` (raw and URL-encoded) and secret-shaped strings.
 * Everything that leaves this package in a message or log goes through it.
 */
export function scrubSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length < 6) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join('[REDACTED]');
    }
  }
  const spans = findSecretSpans(out);
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]!;
    out = `${out.slice(0, s.start)}[REDACTED]${out.slice(s.end)}`;
  }
  return out;
}
