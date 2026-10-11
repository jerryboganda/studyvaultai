// Text hygiene shared by redaction, prompt building, grounding and output sanitising. Pure.

/** Control (except \n \t), format (zero-width, bidi, tag characters) and variation selectors. */
const INVISIBLE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Variation_Selector}]/gu;

/** What is actually sent to a provider for a captured passage: NFC, no invisible/control characters. */
export function sanitizeSourceText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Comparison form used by grounding: NFKC + invisible-free + whitespace collapsed. Case is kept. */
export function matchForm(s: string): string {
  return collapseWhitespace(sanitizeSourceText(s).normalize('NFKC'));
}

/** Cut at `max` UTF-16 units without splitting a surrogate pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function estimateTokens(chars: number, charsPerToken = 3): number {
  return Math.ceil(chars / charsPerToken);
}

/**
 * Turns model-generated text into inert plain text: markup removed, links dropped, invisible characters
 * stripped. Idempotent. NOT applied to verbatim-grounded quotes (they are the user's own source text).
 */
export function toPlainText(s: string): string {
  let t = sanitizeSourceText(s);
  t = t.replace(/<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/?[A-Za-z!?][^>]*>/g, ' ');
  t = t.replace(/!?\[([^\]]*)\]\(\s*[^)]*\)/g, '$1');
  t = t.replace(
    /\b(?:https?|ftp|file|javascript|data|vbscript|blob):[^\s<>"'`)\]]*/gi,
    '[link removed]',
  );
  t = t.replace(/\bwww\.[^\s<>"'`)\]]+/gi, '[link removed]');
  return t
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
