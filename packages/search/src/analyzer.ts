/**
 * Text analysis: ONE definition of "a word" shared by indexing, querying, snippets and filter folding.
 *
 * Folding (per code point, so offsets into the original text stay exact):
 *  - NFKD, accents/diacritics removed (Latin, Greek, Arabic harakat, Hebrew niqqud), lower-cased.
 *  - Arabic: alef/hamza variants -> alef, alef-maksura -> yeh, teh-marbuta -> heh, tatweel dropped,
 *    Persian/Urdu kaf/yeh unified, Arabic-Indic digits -> ASCII. Hebrew final letters -> medial forms.
 *  - Latin letters without a decomposition: ss ae oe o d l h t th i. Greek final sigma -> sigma.
 *  - Apostrophes inside a word are removed ("Crohn's" -> "crohns").
 *
 * Words are runs of letters/digits. A letter<->digit boundary splits a word into `parts`
 * ("5mg" -> 5|mg, "T2" -> t|2, "B12" -> b|12); a '.' between digits stays inside the number ("7.35").
 * Every other character separates words. The index stores the whole word AND its parts, so
 * "5 mg" finds "5mg" and "T2-weighted" finds "T2 weighted".
 *
 * CJK (Han, kana, bopomofo) has no spaces: a run is indexed as character unigrams + bigrams; a query
 * run is the AND of its bigrams verified as an adjacent character sequence. Hangul is space-delimited
 * and treated as an ordinary script.
 *
 * Stop words (small English function-word list) are dropped from the index ONLY when the token is
 * written lowercase or Title-case. Any other casing (AS, IT, OR, IV, A) is kept, as is anything with a
 * digit or in a non-Latin script, so clinical abbreviations are never lost.
 */

export const ANALYZER_VERSION = 'sv-analyzer-1';

export const DEFAULT_STOP_WORDS: readonly string[] = [
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'by',
  'with',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'as',
  'than',
  'then',
  'so',
  'if',
  'but',
];

/** Terms longer than this are never indexed (base64 blobs, minified URLs). */
export const MAX_TERM_LENGTH = 64;

export interface Word {
  /** Offsets into the analysed string (UTF-16 code units), `end` exclusive. */
  start: number;
  end: number;
  /** Folded pieces: letter/digit boundaries split, CJK split per character. */
  parts: string[];
  /** `parts.join('')`. */
  whole: string;
  cjk: boolean;
  /** Droppable function word (see header). Phrase verification still sees it. */
  stop: boolean;
  /** CJK only: original offset of each character in `parts`. */
  at?: number[];
}

const SEP = 0;
const LETTER = 1;
const DIGIT = 2;
const CJK = 3;
const IGNORE = 4;
const APOS = 5;

interface Cls {
  c: number;
  t: string;
}

const EXTRA = new Map<string, string>([
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['þ', 'th'],
  ['ł', 'l'],
  ['ħ', 'h'],
  ['ŧ', 't'],
  ['ı', 'i'],
  ['ĸ', 'k'],
  ['ŋ', 'n'],
  ['ς', 'σ'],
  // Arabic / Persian / Urdu
  ['ى', 'ي'],
  ['ی', 'ي'],
  ['ة', 'ه'],
  ['ک', 'ك'],
  ['ٱ', 'ا'],
  ['ـ', ''],
  // Hebrew final forms
  ['ך', 'כ'],
  ['ם', 'מ'],
  ['ן', 'נ'],
  ['ף', 'פ'],
  ['ץ', 'צ'],
]);

const WORDCHAR = /^[\p{L}\p{N}\p{M}]$/u;
const FORMAT = /^\p{Cf}$/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const ASCII_DIGITS = /^[0-9]+$/;

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3005 && cp <= 0x3007) ||
    (cp >= 0x3105 && cp <= 0x312f) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff66 && cp <= 0xff9f) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  );
}

/** Combining marks that carry no search meaning in the scripts we fold. */
function isFoldedMark(cp: number): boolean {
  return (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x483 && cp <= 0x489) ||
    (cp >= 0x591 && cp <= 0x5c7 && cp !== 0x5be && cp !== 0x5c0 && cp !== 0x5c3 && cp !== 0x5c6) ||
    (cp >= 0x64b && cp <= 0x65f) ||
    cp === 0x670 ||
    (cp >= 0x6d6 && cp <= 0x6ed) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

const IGNORED: Cls = { c: IGNORE, t: '' };
const SEPARATOR: Cls = { c: SEP, t: ' ' };
const APOSTROPHE: Cls = { c: APOS, t: '' };

const ASCII: Cls[] = [];
for (let cp = 0; cp < 128; cp++) {
  if (cp >= 48 && cp <= 57) ASCII.push({ c: DIGIT, t: String.fromCharCode(cp) });
  else if (cp >= 97 && cp <= 122) ASCII.push({ c: LETTER, t: String.fromCharCode(cp) });
  else if (cp >= 65 && cp <= 90) ASCII.push({ c: LETTER, t: String.fromCharCode(cp + 32) });
  else if (cp === 39) ASCII.push(APOSTROPHE);
  else ASCII.push(SEPARATOR);
}

const cache = new Map<number, Cls>();
const CACHE_LIMIT = 20_000; // bounds memory against hostile text made of every code point

function classifyOther(cp: number): Cls {
  if (cp === 0x2019 || cp === 0x2018) return APOSTROPHE;
  if (isFoldedMark(cp)) return IGNORED;
  const ch = String.fromCodePoint(cp);
  if (isCjk(cp)) return { c: CJK, t: ch.normalize('NFKC') };
  if (cp >= 0xac00 && cp <= 0xd7a3) return { c: LETTER, t: ch }; // Hangul stays composed
  if (FORMAT.test(ch)) return IGNORED;

  let out = '';
  let dropped = false;
  for (const u of ch.normalize('NFKD')) {
    for (const x of u.toLowerCase()) {
      const xc = x.codePointAt(0)!;
      if (isFoldedMark(xc)) continue;
      let y = x;
      if (xc >= 0x660 && xc <= 0x669) y = String(xc - 0x660);
      else if (xc >= 0x6f0 && xc <= 0x6f9) y = String(xc - 0x6f0);
      else {
        const m = EXTRA.get(x);
        if (m !== undefined) y = m;
      }
      for (const z of y) {
        if (WORDCHAR.test(z)) out += z;
        else dropped = true;
      }
    }
  }
  if (out === '') return LETTER_OR_MARK.test(ch) ? IGNORED : SEPARATOR;
  if (dropped) return SEPARATOR; // e.g. "1/2" vulgar fraction: not a word character
  return { c: ASCII_DIGITS.test(out) ? DIGIT : LETTER, t: out };
}

function classify(cp: number): Cls {
  if (cp < 128) return ASCII[cp]!;
  let k = cache.get(cp);
  if (k === undefined) {
    k = classifyOther(cp);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(cp, k);
  }
  return k;
}

function lowerOrTitle(orig: string): boolean {
  if (orig === orig.toLowerCase()) return true;
  const rest = orig.slice(1);
  return orig.length > 1 && rest === rest.toLowerCase();
}

export function stopSet(words: readonly string[] | false | undefined): ReadonlySet<string> {
  return new Set(words === false ? [] : (words ?? DEFAULT_STOP_WORDS));
}

const DEFAULT_STOP = stopSet(undefined);

/** 0 separator, 1 letter, 2 digit, 5 apostrophe; index = ASCII code. */
const ASCII_CLASS = new Uint8Array(128);
for (let cp = 0; cp < 128; cp++) {
  ASCII_CLASS[cp] =
    cp >= 48 && cp <= 57
      ? DIGIT
      : (cp >= 97 && cp <= 122) || (cp >= 65 && cp <= 90)
        ? LETTER
        : cp === 39
          ? APOS
          : SEP;
}

/**
 * Fast path for pure-ASCII text (most highlights): same output as `analyzeGeneric`, built from slices
 * instead of per-character appends. Returns null at the first non-ASCII character so the caller can
 * fall back; a differential test keeps the two paths identical.
 */
function analyzeAscii(text: string, stop: ReadonlySet<string>): Word[] | null {
  const out: Word[] = [];
  const n = text.length;
  const fold = (a: number, b: number, apos: boolean): string => {
    const piece = text.slice(a, b);
    return (apos ? piece.replace(/'/g, '') : piece).toLowerCase();
  };
  let i = 0;
  while (i < n) {
    let c = text.charCodeAt(i);
    if (c >= 128) return null;
    let k = ASCII_CLASS[c]!;
    if (k !== LETTER && k !== DIGIT) {
      i++;
      continue;
    }
    const start = i;
    const parts: string[] = [];
    let partStart = i;
    let partCls = k;
    let apos = false;
    let end = ++i;
    for (; i < n; i++) {
      c = text.charCodeAt(i);
      if (c >= 128) return null;
      k = ASCII_CLASS[c]!;
      if (k === LETTER || k === DIGIT) {
        if (k !== partCls) {
          parts.push(fold(partStart, i, apos));
          partStart = i;
          partCls = k;
          apos = false;
        }
        end = i + 1;
        continue;
      }
      const next = i + 1 < n ? text.charCodeAt(i + 1) : 0;
      if (next >= 128) return null;
      const nextCls = ASCII_CLASS[next]!;
      if (k === APOS && partCls === LETTER && nextCls === LETTER) {
        apos = true; // Crohn's -> crohns
        continue;
      }
      if (c === 46 && partCls === DIGIT && nextCls === DIGIT) continue; // 7.35 stays one number
      break;
    }
    parts.push(fold(partStart, end, apos));
    const whole = parts.length === 1 ? parts[0]! : parts.join('');
    const isStop = parts.length === 1 && stop.has(whole) && lowerOrTitle(text.slice(start, end));
    out.push({ start, end, parts, whole, cjk: false, stop: isStop });
  }
  return out;
}

/** Split `text` into words with exact original offsets. Never throws. */
export function analyzeWords(text: string, stop: ReadonlySet<string> = DEFAULT_STOP): Word[] {
  return analyzeAscii(text, stop) ?? analyzeGeneric(text, stop);
}

/** @internal the general (Unicode) path; exported so tests can compare it with the ASCII fast path. */
export function analyzeGeneric(text: string, stop: ReadonlySet<string> = DEFAULT_STOP): Word[] {
  const out: Word[] = [];
  const n = text.length;
  let parts: string[] = [];
  let cur = '';
  let curCls = SEP;
  let start = -1;
  let end = 0;
  let cjk: string[] | null = null;
  let at: number[] = [];
  let cjkStart = 0;
  let cjkEnd = 0;

  const flushWord = (): void => {
    if (start < 0) return;
    if (cur !== '') parts.push(cur);
    const whole = parts.length === 1 ? parts[0]! : parts.join('');
    const isStop = parts.length === 1 && stop.has(whole) && lowerOrTitle(text.slice(start, end));
    out.push({ start, end, parts, whole, cjk: false, stop: isStop });
    parts = [];
    cur = '';
    curCls = SEP;
    start = -1;
  };
  const flushCjk = (): void => {
    if (cjk === null) return;
    out.push({
      start: cjkStart,
      end: cjkEnd,
      parts: cjk,
      whole: cjk.join(''),
      cjk: true,
      stop: false,
      at,
    });
    cjk = null;
    at = [];
  };
  const classAt = (i: number): number => (i < n ? classify(text.codePointAt(i)!).c : SEP);

  for (let i = 0; i < n;) {
    const cp = text.codePointAt(i)!;
    const w = cp > 0xffff ? 2 : 1;
    const k = classify(cp);
    switch (k.c) {
      case LETTER:
      case DIGIT:
        flushCjk();
        if (start < 0) start = i;
        if (cur !== '' && curCls !== k.c) {
          parts.push(cur);
          cur = '';
        }
        cur += k.t;
        curCls = k.c;
        end = i + w;
        break;
      case CJK:
        flushWord();
        if (cjk === null) {
          cjk = [];
          cjkStart = i;
        }
        for (const ch of k.t) {
          if ((ch === '゙' || ch === '゚') && cjk.length > 0) {
            // (half-width) dakuten / handakuten: compose with the previous kana
            cjk[cjk.length - 1] = (cjk[cjk.length - 1]! + ch).normalize('NFC');
          } else {
            cjk.push(ch);
            at.push(i);
          }
        }
        cjkEnd = i + w;
        break;
      case IGNORE:
        break;
      default: {
        if (k.c === APOS && start >= 0 && curCls === LETTER && classAt(i + w) === LETTER) break;
        if (cp === 46 && start >= 0 && curCls === DIGIT && classAt(i + 1) === DIGIT) {
          cur += '.';
          break;
        }
        flushWord();
        flushCjk();
      }
    }
    i += w;
  }
  flushWord();
  flushCjk();
  return out;
}

function pushWordTerms(w: Word, out: string[]): void {
  if (w.cjk) {
    const c = w.parts;
    for (let i = 0; i < c.length; i++) {
      out.push(c[i]!);
      if (i + 1 < c.length) out.push(c[i]! + c[i + 1]!);
    }
    return;
  }
  if (w.stop) return;
  if (w.whole.length <= MAX_TERM_LENGTH) out.push(w.whole);
  if (w.parts.length > 1) for (const p of w.parts) if (p.length <= MAX_TERM_LENGTH) out.push(p);
}

/** Terms the index stores for one word (empty for stop words and over-long tokens). */
export function wordIndexTerms(w: Word): string[] {
  const terms: string[] = [];
  pushWordTerms(w, terms);
  return terms;
}

export function indexTerms(words: readonly Word[]): string[] {
  const terms: string[] = [];
  for (const w of words) pushWordTerms(w, terms);
  return terms;
}

/** Index terms that must ALL be present for these words to occur as a phrase (a superset test). */
export function candidateTerms(words: readonly Word[]): string[] {
  const set = new Set<string>();
  for (const w of words) {
    if (w.cjk) {
      const c = w.parts;
      if (c.length === 1) set.add(c[0]!);
      for (let i = 0; i + 1 < c.length; i++) set.add(c[i]! + c[i + 1]!);
    } else if (!w.stop) {
      for (const p of w.parts) if (p.length <= MAX_TERM_LENGTH) set.add(p);
    }
  }
  return [...set];
}

/** Flat folded part sequence used for phrase/adjacency checks. */
export function partSequence(words: readonly Word[], skipStop = false): string[] {
  const seq: string[] = [];
  for (const w of words) {
    if (skipStop && w.stop) continue;
    for (const p of w.parts) seq.push(p);
  }
  return seq;
}

/** Fold for equality: lower-cased, accent-free, punctuation and runs of space collapsed to one space. */
export function foldText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    const k = classify(cp);
    if (k.c === SEP) {
      if (out !== '' && out[out.length - 1] !== ' ') out += ' ';
    } else out += k.t;
  }
  return out.endsWith(' ') ? out.slice(0, -1) : out;
}
