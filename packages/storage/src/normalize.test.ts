// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeQuote, quoteHash } from './normalize';

describe('normalizeQuote', () => {
  it('applies NFKC, collapses whitespace, trims and lowercases', () => {
    expect(normalizeQuote('  Áspirin  \n\tACTS  ')).toBe('áspirin acts');
    expect(normalizeQuote('ﬁbrin ＡBC')).toBe('fibrin abc');
  });

  it('is stable for already-normalised text', () => {
    const once = normalizeQuote('Some  Mixed\tCase');
    expect(normalizeQuote(once)).toBe(once);
  });

  it('maps cosmetically different quotes to the same text', () => {
    expect(normalizeQuote('Heart  Failure\n')).toBe(normalizeQuote('heart failure'));
  });
});

describe('quoteHash', () => {
  it('is the SHA-256 hex digest', async () => {
    expect(await quoteHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is 64 lowercase hex characters', async () => {
    expect(await quoteHash('')).toMatch(/^[0-9a-f]{64}$/);
  });
});
