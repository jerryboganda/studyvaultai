/**
 * A rough, honest strength estimate for the sync passphrase. It cannot know what an attacker
 * knows, so it says "estimate". The key is derived with PBKDF2 at 600,000 rounds, which makes each
 * guess slow, but anyone who obtains a copy of the server data can guess offline: a weak
 * passphrase stays weak.
 */

export const MIN_PASSPHRASE_CHARS = 12;

export type StrengthLabel = 'Too short' | 'Weak' | 'Fair' | 'Good' | 'Strong';

export interface PassphraseStrength {
  /** 0 = too short ... 4 = strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: StrengthLabel;
  /** Estimated guessing work in bits. A guide, not a promise. */
  bits: number;
  /** True when it is long enough and at least "Fair". */
  acceptable: boolean;
  tips: string[];
}

const COMMON = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'abc123',
  '123456',
  'studyvault',
  'medicine',
  'monkey',
  'dragon',
];
const SEQUENCES = ['abcdefg', '1234567', 'qwertyu', 'asdfghj', 'zxcvbnm', '0987654'];

export function assessPassphrase(input: string): PassphraseStrength {
  const text = input.normalize('NFKC');
  const chars = [...text];
  const length = chars.length;
  const tips: string[] = [];
  if (length < MIN_PASSPHRASE_CHARS) {
    return {
      score: 0,
      label: 'Too short',
      bits: 0,
      acceptable: false,
      tips: [`Use at least ${MIN_PASSPHRASE_CHARS} characters; several unrelated words work well.`],
    };
  }

  const distinct = new Set(chars).size;
  const effective = Math.min(length, distinct * 3);
  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/[0-9]/.test(text)) pool += 10;
  if (/[ -/:-@[-`{-~]/.test(text)) pool += 33;
  if (chars.some((c) => (c.codePointAt(0) ?? 0) > 127)) pool += 100;
  let bits = effective * Math.log2(Math.max(pool, 2));

  // Typed text is far from uniform: charge for what a guesser tries first.
  if (/(.)\1{2,}/.test(text)) {
    bits *= 0.8;
    tips.push('Avoid repeating the same character.');
  }
  const lower = text.toLowerCase();
  if (SEQUENCES.some((s) => lower.includes(s))) {
    bits *= 0.8;
    tips.push('Avoid keyboard and number sequences.');
  }
  if (COMMON.some((w) => lower.includes(w))) {
    bits = Math.min(bits, 28);
    tips.push('Avoid common words and phrases.');
  }
  bits = Math.min(bits * 0.65, 128); // "typed by a person" discount

  const words = text.split(/[\s\-_.,;:]+/).filter((w) => w.length >= 3);
  if (words.length >= 4 && new Set(words.map((w) => w.toLowerCase())).size === words.length) {
    bits = Math.max(bits, Math.min(words.length * 11, 77));
  }
  bits = Math.round(bits);

  const score = bits < 28 ? 1 : bits < 40 ? 2 : bits < 60 ? 3 : 4;
  if (score <= 2 && tips.length === 0) {
    tips.push('Add more unrelated words, or make it longer.');
  }
  const label: StrengthLabel = (['Too short', 'Weak', 'Fair', 'Good', 'Strong'] as const)[score];
  return { score, label, bits, acceptable: score >= 2, tips };
}
