/** Document identity (ADR-006): sha-256 of the file bytes, so reopening the same file is stable. */

/** Above this the bytes are not hashed in one go; pdf.js's own fingerprint is used instead. */
export const FINGERPRINT_MAX_BYTES = 512 * 1024 * 1024;

export type FingerprintKind = 'sha256' | 'pdfjs';

export interface DocumentFingerprint {
  /** Hex digest. sha-256 is 64 chars; the pdf.js fallback is 32 chars. */
  id: string;
  kind: FingerprintKind;
  /** Shown to the user when the fallback was used. */
  note: string | null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // digest() of a view hashes exactly its bytes, whatever the underlying buffer holds.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * WebCrypto has no incremental digest, and the bytes are already in memory for pdf.js, so the hash is
 * one native call over them. Files above FINGERPRINT_MAX_BYTES use the pdf.js fingerprint (an MD5 of
 * the file's leading bytes): stable for the same file but not a content hash, which the UI says.
 */
export async function documentFingerprint(
  bytes: Uint8Array,
  pdfjsFingerprint: string | null,
): Promise<DocumentFingerprint> {
  if (bytes.byteLength <= FINGERPRINT_MAX_BYTES) {
    return { id: await sha256Hex(bytes), kind: 'sha256', note: null };
  }
  if (!pdfjsFingerprint) throw new Error('This file is too large to identify.');
  return {
    id: pdfjsFingerprint,
    kind: 'pdfjs',
    note: 'This file is very large, so it is identified by a quick fingerprint of its structure instead of a full content hash. Edited copies with the same start may be treated as the same document.',
  };
}
