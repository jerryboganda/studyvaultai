// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256.ts';

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto across block boundaries and non-ASCII text', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = 'x'.repeat(n);
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
    }
    const mixed = 'exactQuote: naïve café 日本語 🧪 \u0000 end';
    expect(sha256Hex(mixed)).toBe(createHash('sha256').update(mixed).digest('hex'));
  });
});
