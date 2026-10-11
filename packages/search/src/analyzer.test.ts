import { describe, expect, it } from 'vitest';
import {
  analyzeGeneric,
  analyzeWords,
  candidateTerms,
  foldText,
  indexTerms,
  partSequence,
} from './analyzer';
import { prng } from './testUtils';

const terms = (s: string): string[] => indexTerms(analyzeWords(s));
const wholes = (s: string): string[] => analyzeWords(s).map((w) => w.whole);

describe('folding', () => {
  it('folds case and Latin accents', () => {
    expect(wholes('Café NAÏVE Crème Brûlée')).toEqual(['cafe', 'naive', 'creme', 'brulee']);
    expect(wholes('Straße ﬁbrosis Æther Œdema')).toEqual([
      'strasse',
      'fibrosis',
      'aether',
      'oedema',
    ]);
  });

  it('folds full-width forms and superscripts (NFKD)', () => {
    expect(wholes('ＭＲＩ')).toEqual(['mri']);
    expect(wholes('m²')).toEqual(['m2']);
  });

  it('folds Greek tonos and final sigma', () => {
    expect(wholes('ΆΛΦΑ ΜΈΣΟΣ')).toEqual(['αλφα', 'μεσοσ']);
  });

  it('removes apostrophes inside words', () => {
    expect(wholes("Crohn's don’t")).toEqual(['crohns', 'dont']);
    expect(wholes("'quoted'")).toEqual(['quoted']);
  });

  it('keeps offsets into the ORIGINAL text exact', () => {
    const text = 'Café  au lait — ﬁbrosis';
    for (const w of analyzeWords(text)) {
      expect(text.slice(w.start, w.end).length).toBeGreaterThan(0);
    }
    const fib = analyzeWords(text).find((w) => w.whole === 'fibrosis')!;
    expect(text.slice(fib.start, fib.end)).toBe('ﬁbrosis');
  });
});

describe('RTL scripts', () => {
  it('strips Arabic harakat and unifies alef/yeh/heh variants', () => {
    expect(wholes('القَلْبُ')).toEqual(wholes('القلب'));
    expect(wholes('أحمد إبراهيم آمن')).toEqual(['احمد', 'ابراهيم', 'امن']);
    expect(wholes('مدرسة')).toEqual(wholes('مدرسه'));
    expect(wholes('على')).toEqual(wholes('علي'));
  });

  it('drops tatweel and joins Persian letter variants', () => {
    expect(wholes('مـــرحبا')).toEqual(wholes('مرحبا'));
    expect(wholes('کتاب')).toEqual(wholes('كتاب'));
  });

  it('maps Arabic-Indic digits to ASCII', () => {
    expect(wholes('٣٥ ملغ')).toEqual(['35', 'ملغ']);
    expect(wholes('۱۲۳')).toEqual(['123']);
  });

  it('tokenizes on Arabic punctuation and ignores bidi marks', () => {
    expect(wholes('قلب، كبد؟ رئة')).toEqual(['قلب', 'كبد', 'ريه']); // hamza-yeh -> yeh, marbuta -> heh
    expect(wholes('heart‏‎ rate')).toEqual(['heart', 'rate']);
  });

  it('folds Hebrew niqqud and final letters', () => {
    expect(wholes('שָׁלוֹם')).toEqual(wholes('שלום'));
    expect(wholes('שלום')).toEqual(wholes('שלומ'));
    expect(wholes('מה־שם')).toEqual(['מה', 'שמ']); // maqaf separates words
  });

  it('mixes RTL and Latin/digits in one sentence', () => {
    expect(wholes('جرعة 5 mg مرتين')).toEqual(['جرعه', '5', 'mg', 'مرتين']);
  });
});

describe('CJK', () => {
  it('indexes character unigrams and bigrams', () => {
    expect(new Set(terms('糖尿病'))).toEqual(new Set(['糖', '尿', '病', '糖尿', '尿病']));
  });

  it('a lone character is a unigram', () => {
    expect(terms('肺')).toEqual(['肺']);
  });

  it('a query run requires its bigrams and verifies the character sequence', () => {
    const [w] = analyzeWords('糖尿病');
    expect(candidateTerms([w!]).sort()).toEqual(['尿病', '糖尿']);
    expect(partSequence([w!])).toEqual(['糖', '尿', '病']);
  });

  it('separates CJK from adjacent Latin and digits', () => {
    expect(wholes('COVID患者5例')).toEqual(['covid', '患者', '5', '例']);
    expect(analyzeWords('COVID患者').map((w) => w.cjk)).toEqual([false, true]);
  });

  it('breaks CJK runs at CJK punctuation and keeps original offsets per character', () => {
    const text = '心臓、肝臓';
    const words = analyzeWords(text);
    expect(words.map((w) => w.whole)).toEqual(['心臓', '肝臓']);
    expect(words[1]!.at).toEqual([3, 4]);
    expect(text.slice(words[1]!.start, words[1]!.end)).toBe('肝臓');
  });

  it('normalises half-width katakana', () => {
    expect(wholes('ｶﾞｸ')).toEqual(wholes('ガク'));
  });

  it('treats Hangul as space-delimited words', () => {
    expect(wholes('심장 질환')).toEqual(['심장', '질환']);
  });
});

describe('numbers and units', () => {
  it('splits letter/digit boundaries and keeps the whole word', () => {
    const [w] = analyzeWords('5mg');
    expect(w!.parts).toEqual(['5', 'mg']);
    expect(w!.whole).toBe('5mg');
    expect(new Set(terms('5mg'))).toEqual(new Set(['5mg', '5', 'mg']));
  });

  it('"5 mg" and "5mg" share terms', () => {
    const a = new Set(terms('5 mg'));
    for (const t of a) expect(terms('5mg')).toContain(t);
  });

  it('T2-weighted', () => {
    expect(wholes('T2-weighted')).toEqual(['t2', 'weighted']);
    expect(analyzeWords('T2-weighted')[0]!.parts).toEqual(['t', '2']);
    expect(partSequence(analyzeWords('T2-weighted'))).toEqual(['t', '2', 'weighted']);
    expect(partSequence(analyzeWords('T2 weighted'))).toEqual(['t', '2', 'weighted']);
  });

  it('keeps decimals together but splits thousands commas', () => {
    expect(wholes('pH 7.35-7.45')).toEqual(['ph', '7.35', '7.45']);
    expect(wholes('3.5 mg/dL')).toEqual(['3.5', 'mg', 'dl']);
    expect(wholes('4,500')).toEqual(['4', '500']);
    expect(wholes('Version 2.')).toEqual(['version', '2']);
  });

  it('handles hyphenated clinical shorthand', () => {
    expect(wholes('COVID-19 L5-S1 B12')).toEqual(['covid', '19', 'l5', 's1', 'b12']);
    expect(partSequence(analyzeWords('L5-S1'))).toEqual(['l', '5', 's', '1']);
  });
});

describe('stop words never drop short medical tokens', () => {
  const kept = (s: string): string[] =>
    analyzeWords(s)
      .filter((w) => !w.stop)
      .map((w) => w.whole);

  it('drops lower-case and Title-case function words', () => {
    expect(kept('the cell of the nucleus')).toEqual(['cell', 'nucleus']);
    expect(kept('The cell As noted')).toEqual(['cell', 'noted']);
  });

  it('keeps abbreviations that look like function words', () => {
    expect(kept('AS and IT or OR IV IN')).toEqual(['as', 'it', 'or', 'iv', 'in']);
    expect(kept('Vitamin A, grade A')).toEqual(['vitamin', 'a', 'grade', 'a']);
  });

  it('keeps short medical tokens and negations', () => {
    expect(kept('no ph na k mg ct mri ecg iv po bid not')).toEqual([
      'no',
      'ph',
      'na',
      'k',
      'mg',
      'ct',
      'mri',
      'ecg',
      'iv',
      'po',
      'bid',
      'not',
    ]);
    expect(kept('t2 2x 5mg')).toEqual(['t2', '2x', '5mg']);
  });

  it('keeps stop words visible to phrase verification', () => {
    const seq = partSequence(analyzeWords('cell of origin'));
    expect(seq).toEqual(['cell', 'of', 'origin']);
    expect(partSequence(analyzeWords('cell of origin'), true)).toEqual(['cell', 'origin']);
  });

  it('can be disabled', () => {
    const none = analyzeWords('the cell', new Set());
    expect(none.every((w) => !w.stop)).toBe(true);
  });
});

describe('robustness', () => {
  it('never throws on hostile input', () => {
    const rand = prng(7);
    for (let i = 0; i < 300; i++) {
      let s = '';
      const n = Math.floor(rand() * 60);
      for (let j = 0; j < n; j++) {
        const r = rand();
        const cp =
          r < 0.5
            ? Math.floor(rand() * 0x250)
            : r < 0.8
              ? Math.floor(rand() * 0x10ffff)
              : 0xd800 + Math.floor(rand() * 0x800);
        s += String.fromCodePoint(cp > 0x10ffff ? 0x41 : cp);
      }
      expect(() => analyzeWords(s)).not.toThrow();
      expect(() => foldText(s)).not.toThrow();
    }
  });

  it('skips absurdly long tokens when indexing', () => {
    expect(terms('a'.repeat(200))).toEqual([]);
  });

  it('foldText collapses punctuation and whitespace', () => {
    expect(foldText('  Internal  Medicine / Cardio ')).toBe('internal medicine cardio');
    expect(foldText("Crohn's")).toBe('crohns');
    expect(foldText('')).toBe('');
  });
});

describe('ASCII fast path', () => {
  it('is identical to the general path (seeded differential test)', () => {
    const rand = prng(2026);
    const atoms = [
      'a',
      'B',
      'z',
      'T',
      'mg',
      'MG',
      'dL',
      'the',
      'The',
      'AS',
      'as',
      'A',
      'it',
      'IT',
      '5',
      '50',
      '7.35',
      '3.',
      '.5',
      'x2',
      'T2',
      'covid',
      "Crohn's",
      "'",
      "'s",
      "don't",
      "O'Neil",
      ' ',
      '  ',
      '\t',
      '\n',
      '-',
      '/',
      ',',
      '.',
      ';',
      '(',
      ')',
      '"',
      '_',
      '*',
      '#',
      'ß',
      'é',
    ];
    const nonAscii = /[^\u0000-\u007f]/; // eslint-disable-line no-control-regex
    let asciiCases = 0;
    for (let i = 0; i < 4000; i++) {
      let s = '';
      const n = Math.floor(rand() * 14);
      for (let j = 0; j < n; j++) s += atoms[Math.floor(rand() * atoms.length)]!;
      if (!nonAscii.test(s)) asciiCases++;
      expect(analyzeWords(s), JSON.stringify(s)).toEqual(analyzeGeneric(s));
    }
    expect(asciiCases).toBeGreaterThan(1500); // the fast path really was exercised
  });

  it('long ASCII text is analysed identically', () => {
    const text =
      "The cell membrane (7.35 pH, 5mg/dL) of T2-weighted images; Crohn's AS vs as. ".repeat(200);
    expect(analyzeWords(text)).toEqual(analyzeGeneric(text));
  });
});
