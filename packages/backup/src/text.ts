import { MAX_URL_CHARS } from '@shared';
import { toHex } from './canonical';
import type { Subtle } from './crypto';

/** Same rule as @storage `normalizeQuote` (quoteHash input). Duplicated because @backup is pure. */
export function normalizeQuote(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Same as @storage `quoteHash`: SHA-256 hex of the normalised quote. */
export async function quoteHash(subtle: Subtle, normalized: string): Promise<string> {
  const d = await subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return toHex(new Uint8Array(d));
}

// C0/C1 controls except \t \n, DEL, and the bidirectional embedding/override/isolate controls that
// make text render differently from how it reads (spoofing). LRM/RLM/ALM are kept: real RTL text.
/* eslint-disable no-control-regex */
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
/* eslint-enable no-control-regex */

/** Strip characters that are never legitimate in imported or exported prose. Keeps \n and \t. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNSAFE_CHARS, '');
}

/**
 * An http(s) URL without credentials, or null. Everything else (javascript:, data:, file:, blob:,
 * chrome-extension:, relative strings) is refused: these end up in links users click.
 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_CHARS) return null;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.username = '';
  u.password = '';
  return u.href;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
export const isoDay = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
