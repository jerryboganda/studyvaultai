import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH, MAX_QUERY_TERMS, QUERY_SYNTAX, parseQuery } from './query';
import type { QueryNode } from './query';
import { prng } from './testUtils';

/** Compact S-expression of a tree for readable assertions. */
function show(n: QueryNode | null): string {
  if (!n) return '∅';
  switch (n.type) {
    case 'term':
      return n.word.whole;
    case 'phrase':
      return `"${n.parts.join(' ')}"`;
    case 'filter':
      return `${n.key}:${n.cmp && n.cmp !== '=' ? n.cmp : ''}${n.num ?? n.value}${n.prefix ? '*' : ''}`;
    case 'and':
      return `(${n.children.map(show).join(' & ')})`;
    case 'or':
      return `(${n.children.map(show).join(' | ')})`;
    case 'not':
      return `!${show(n.child)}`;
  }
}
const s = (q: string): string => show(parseQuery(q).root);
const codes = (q: string): string[] => parseQuery(q).warnings.map((w) => w.code);

describe('valid queries', () => {
  it('juxtaposition is AND, OR binds loosest', () => {
    expect(s('cell membrane')).toBe('(cell & membrane)');
    expect(s('a1 OR b1 c1')).toBe('(a1 | (b1 & c1))');
    expect(s('a1 AND b1 OR c1')).toBe('((a1 & b1) | c1)');
    expect(s('(a1 OR b1) c1')).toBe('((a1 | b1) & c1)');
  });

  it('NOT and leading minus', () => {
    expect(s('valve NOT prosthetic')).toBe('(valve & !prosthetic)');
    expect(s('valve -prosthetic')).toBe('(valve & !prosthetic)');
    expect(s('-(a1 OR b1)')).toBe('!(a1 | b1)');
    expect(s('NOT NOT cell')).toBe('!!cell');
  });

  it('lower-case operators are ordinary words', () => {
    expect(s('salt and water')).toBe('(salt & and & water)');
    expect(s('not or')).toBe('(not & or)');
  });

  it('a minus before a digit is a number, not a negation', () => {
    expect(s('-5 mmHg')).toBe('(5 & mmhg)');
    expect(s('a-b')).toBe('"a b"');
  });

  it('phrases are exact and keep stop words for verification', () => {
    const q = parseQuery('"cell of origin"');
    const n = q.root!;
    expect(n.type).toBe('phrase');
    if (n.type === 'phrase') {
      expect(n.parts).toEqual(['cell', 'of', 'origin']);
      expect(n.contentParts).toEqual(['cell', 'origin']);
      expect(n.candidates.sort()).toEqual(['cell', 'origin']);
      expect(n.quoted).toBe(true);
    }
  });

  it('escapes inside phrases', () => {
    expect(s('"say \\"hi\\""')).toBe('"say hi"');
    expect(s('"back\\\\slash"')).toBe('"back slash"');
    expect(codes('"say \\"hi\\""')).toEqual([]);
  });

  it('accepts curly quotes and guillemets', () => {
    expect(s('“cell membrane”')).toBe('"cell membrane"');
    expect(s('«cell membrane»')).toBe('"cell membrane"');
  });

  it('a token with several words is an implicit phrase', () => {
    expect(s('beta-blocker')).toBe('"beta blocker"');
    expect(s('mg/dL')).toBe('"mg dl"');
    expect(s('T2-weighted')).toBe('"t 2 weighted"');
  });

  it('CJK runs are phrases of characters', () => {
    expect(s('糖尿病')).toBe('"糖 尿 病"');
    expect(s('糖尿病 患者')).toBe('("糖 尿 病" & "患 者")');
  });
});

describe('filters', () => {
  it('parses every documented filter', () => {
    expect(s('bank:Cardiology')).toBe('bank:cardiology');
    expect(s('BANK:Cardiology')).toBe('bank:cardiology');
    expect(s('tag:"exam pearl"')).toBe('tag:exam pearl');
    expect(s('tag:neuro*')).toBe('tag:neuro*');
    expect(s('kind:formula')).toBe('kind:formula');
    expect(s('host:wikipedia.org')).toBe('host:wikipedia org');
    expect(s('status:orphaned')).toBe('status:orphaned');
    expect(s('folder:"Valves & Disease"')).toBe('folder:valves disease');
    expect(s('has:note')).toBe('has:note');
    expect(s('has:Tag')).toBe('has:tag');
    expect(s('type:note')).toBe('type:note');
  });

  it('priority comparators', () => {
    expect(s('priority:>=3')).toBe('priority:>=3');
    expect(s('priority:>3')).toBe('priority:>3');
    expect(s('priority:<=2')).toBe('priority:<=2');
    expect(s('priority:<2')).toBe('priority:<2');
    expect(s('priority:4')).toBe('priority:4');
    expect(s('priority:=4')).toBe('priority:4');
  });

  it('mixes with text and negation', () => {
    expect(s('mitral bank:Cardiology -tag:old')).toBe('(mitral & bank:cardiology & !tag:old)');
  });

  it('bad values are dropped with a warning, not an error', () => {
    expect(s('priority:high mitral')).toBe('mitral');
    expect(codes('priority:high mitral')).toEqual(['invalid-value']);
    expect(s('has:wings')).toBe('∅');
    expect(codes('has:wings')).toEqual(['invalid-value']);
    expect(codes('type:essay')).toEqual(['invalid-value']);
    expect(codes('tag:')).toEqual(['empty-filter']);
    expect(codes('tag:""')).toEqual(['empty-filter']);
    expect(codes('tag:***')).toEqual(['empty-filter']);
  });

  it('unknown keys are plain words with a warning', () => {
    expect(s('colour:blue')).toBe('"colour blue"');
    expect(codes('colour:blue')).toEqual(['unknown-filter']);
    expect(codes('http://example.com/a')).toEqual([]);
    expect(codes('ratio 3:1 at 10:30')).toEqual([]);
  });
});

describe('error recovery', () => {
  it('unterminated phrase uses the rest of the query', () => {
    expect(s('"cell membr')).toBe('"cell membr"');
    expect(codes('"cell membr')).toEqual(['unbalanced-quote']);
  });

  it('unbalanced parentheses', () => {
    expect(s('(a1 OR b1')).toBe('(a1 | b1)');
    expect(codes('(a1 OR b1')).toEqual(['unbalanced-paren']);
    expect(s('a1 b1)')).toBe('(a1 & b1)');
    expect(codes('a1 b1)')).toEqual(['unbalanced-paren']);
    expect(s('())')).toBe('∅');
  });

  it('dangling operators', () => {
    expect(s('a1 OR')).toBe('a1');
    expect(s('OR a1')).toBe('a1');
    expect(s('a1 AND')).toBe('a1');
    expect(s('NOT')).toBe('∅');
    expect(s('a1 OR OR b1')).toBe('(a1 | b1)');
    for (const q of ['a1 OR', 'OR a1', 'a1 AND', 'NOT', 'a1 OR OR b1']) {
      expect(codes(q)).toContain('dangling-operator');
    }
  });

  it('empty and punctuation-only input', () => {
    expect(parseQuery('').root).toBeNull();
    expect(parseQuery('   ').root).toBeNull();
    expect(parseQuery('!!! ??? ,,,').root).toBeNull();
    expect(parseQuery('').warnings).toEqual([]);
  });

  it('limits length, term count and nesting', () => {
    const long = parseQuery('word '.repeat(400));
    expect(long.source.length).toBe(MAX_QUERY_LENGTH);
    expect(long.warnings.map((w) => w.code)).toContain('truncated');
    const many = parseQuery(
      Array.from({ length: 60 }, (_, i) => `w${'a'.repeat(i % 5)}x${i}`).join(' '),
    );
    expect(many.warnings.map((w) => w.code)).toContain('too-many-terms');
    const leaves = (n: QueryNode | null): number =>
      !n
        ? 0
        : n.type === 'and' || n.type === 'or'
          ? n.children.reduce((a, c) => a + leaves(c), 0)
          : 1;
    expect(leaves(many.root)).toBeLessThanOrEqual(MAX_QUERY_TERMS);
    expect(() => parseQuery('('.repeat(5000) + 'a1' + ')'.repeat(5000))).not.toThrow();
    expect(parseQuery('('.repeat(300) + 'a1').root).not.toBeNull();
  });

  it('never throws on random input (seeded fuzz)', () => {
    const rand = prng(99);
    const alphabet = [
      'a',
      'B',
      '1',
      ' ',
      ' ',
      '"',
      '“',
      '”',
      '(',
      ')',
      '-',
      ':',
      '*',
      '\\',
      'AND',
      'OR',
      'NOT',
      'tag:',
      'bank:',
      'priority:>=',
      '糖',
      'ق',
      '<',
      '>',
      '\u0000',
      '\ud800',
    ];
    for (let i = 0; i < 2000; i++) {
      let q = '';
      const n = Math.floor(rand() * 40);
      for (let j = 0; j < n; j++) q += alphabet[Math.floor(rand() * alphabet.length)]!;
      expect(() => parseQuery(q), JSON.stringify(q)).not.toThrow();
    }
  });

  it('tolerates non-string input', () => {
    expect(() => parseQuery(undefined as unknown as string)).not.toThrow();
    expect(parseQuery(42 as unknown as string).root).toBeNull();
  });
});

describe('documented syntax', () => {
  it('every example in QUERY_SYNTAX parses without warnings to a non-empty tree', () => {
    for (const { example } of QUERY_SYNTAX) {
      const p = parseQuery(example);
      expect(p.warnings, example).toEqual([]);
      expect(p.root, example).not.toBeNull();
    }
  });
});
