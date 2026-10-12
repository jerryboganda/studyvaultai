import { describe, expect, it } from 'vitest';
import { MAX_NOTE_BODY_CHARS } from '@shared';
import {
  BUDGET_MICROS,
  MATH_MAX_FORMULAS,
  MATH_MAX_FORMULA_CHARS,
  MATH_MAX_TOTAL_CHARS,
  MAX_NESTING,
  RENDER_MAX_CHARS,
  inlineBudget,
  mathBudget,
  renderBudget,
  runMicros,
} from './markdownBudget';
import { maskMath } from './markdownMath';

/**
 * The pure estimators. What they decide is checked against the real pipeline (marked, DOMPurify, jsdom)
 * in markdownRender.test.ts; here are their rules, one per mechanism of marked 18.1.0 that is
 * quadratic or worse, and the shapes that must stay cheap.
 */

const repeat = (unit: string, chars: number) =>
  unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

/** The whole decision for text that is one paragraph: the raw gate, then its single inline run. */
const decide = (text: string) => {
  const raw = renderBudget(text);
  return raw.ok ? inlineBudget([text], raw.micros, maskMath) : raw;
};

describe('renderBudget: size and nesting', () => {
  it('uses the note body cap', () => {
    expect(RENDER_MAX_CHARS).toBe(MAX_NOTE_BODY_CHARS);
    expect(renderBudget('a'.repeat(RENDER_MAX_CHARS)).ok).toBe(true);
    const over = renderBudget('a'.repeat(RENDER_MAX_CHARS + 1));
    expect(over).toMatchObject({ ok: false, reason: 'too-long' });
  });

  it('accepts empty, blank and ordinary text', () => {
    for (const text of ['', '\n\n\n', '   ', 'one line', '# Title\n\n- a\n- b\n\n> quote\n']) {
      const verdict = renderBudget(text);
      expect(verdict.ok, JSON.stringify(text)).toBe(true);
      expect(verdict.reason).toBeUndefined();
    }
  });

  it('refuses quotes and lists nested deeper than a person writes', () => {
    const ok = (text: string) => renderBudget(text).ok;
    expect(ok('> '.repeat(MAX_NESTING) + 'x')).toBe(true);
    expect(renderBudget('> '.repeat(MAX_NESTING + 1) + 'x')).toMatchObject({ reason: 'too-deep' });
    expect(renderBudget('1. '.repeat(MAX_NESTING + 1) + 'x').reason).toBe('too-deep');
    expect(renderBudget('> - '.repeat(20) + 'x').reason).toBe('too-deep');
    // nesting by indentation: 2 columns a level
    const indented = (levels: number) =>
      Array.from({ length: levels }, (_, i) => `${' '.repeat(2 * i)}- item`).join('\n');
    expect(ok(indented(MAX_NESTING))).toBe(true);
    expect(renderBudget(indented(MAX_NESTING + 5)).reason).toBe('too-deep');
    // one line of a stack-overflowing depth is refused without being read to its end
    expect(renderBudget('> '.repeat(50_000)).reason).toBe('too-deep');
  });

  it('does not take a thematic break, emphasis or a plain number for nesting', () => {
    for (const text of [
      '* '.repeat(40),
      '- '.repeat(40),
      '---',
      '***bold italic***',
      '**a** **b**',
      '2024. A year',
      '1.5 is a number',
      '-5 mg',
    ]) {
      expect(renderBudget(text).ok, text).toBe(true);
    }
  });
});

describe('renderBudget: the block pass', () => {
  it('charges lines, and refuses a text that is nothing but lines', () => {
    expect(renderBudget(repeat('- a\n', 4_000)).ok).toBe(true);
    expect(renderBudget(repeat('- a\n', 100_000))).toMatchObject({
      ok: false,
      reason: 'too-complex',
    });
    expect(renderBudget(repeat('a\n\n', 100_000)).ok).toBe(false);
    // blank lines alone are free
    expect(renderBudget('\n'.repeat(100_000)).ok).toBe(true);
  });

  it('charges the task items of one list quadratically, and separate lists linearly', () => {
    const tasks = (count: number) => '- [ ] a\n'.repeat(count);
    expect(renderBudget(tasks(300)).ok).toBe(true);
    expect(renderBudget(tasks(2_500)).ok).toBe(false);
    // 2,500 tasks as 100 lists of 25, each ended by a paragraph: the same total, no quadratic term
    const spread = ('- [ ] a\n'.repeat(25) + '\npara\n\n').repeat(100);
    expect(renderBudget(spread).ok).toBe(true);
  });

  it('charges the lazy continuation lines of a quote', () => {
    expect(renderBudget('> a\nb\n'.repeat(200)).ok).toBe(true);
    expect(renderBudget('> a\nb\n'.repeat(12_000)).ok).toBe(false);
    // quote lines with their marker are not lazy
    expect(renderBudget('> a\n'.repeat(5_000)).ok).toBe(true);
  });
});

describe('runMicros and inlineBudget: the quadratic mechanisms', () => {
  it('refuses a storm of unmatched emphasis openers (2 us per pair measured)', () => {
    expect(decide('**a '.repeat(150)).ok).toBe(true);
    expect(decide('**a '.repeat(900)).ok).toBe(false);
    expect(decide('__a '.repeat(900)).ok).toBe(false);
    expect(decide('~~a '.repeat(900)).ok).toBe(false);
    expect(decide('*a\n'.repeat(900)).ok).toBe(false);
    expect(decide('[*a]('.repeat(900)).ok).toBe(false);
  });

  it('keeps balanced emphasis cheap, however much of it there is', () => {
    const balanced = repeat('**bold** and *em* and _under_ and ~~del~~. ', 30_000);
    const verdict = decide(balanced);
    expect(verdict.ok).toBe(true);
    // 750 spans in one paragraph: the pairs scan one run each, not the paragraph
    expect(runMicros(balanced)).toBeLessThan(BUDGET_MICROS);
    expect(runMicros('**a** '.repeat(2_000))).toBeLessThan(runMicros('**a '.repeat(2_000)) / 20);
  });

  it('charges nesting by the work it makes, not by its depth alone', () => {
    const nested = (depth: number) => '*a '.repeat(depth) + 'a* '.repeat(depth);
    expect(decide(nested(40)).ok).toBe(true);
    expect(decide(nested(700)).ok).toBe(false);
  });

  it('refuses long words with many marks (the text rule scans the whole word per token)', () => {
    expect(decide('*a'.repeat(5_000)).ok).toBe(false);
    expect(decide('_a'.repeat(5_000)).ok).toBe(false);
    expect(decide('a_b_'.repeat(2_500)).ok).toBe(false);
    expect(decide('!a'.repeat(5_000)).ok).toBe(false);
    // a long URL or file name with a few underscores is ordinary
    expect(
      decide('See https://example.com/files/some_long_file_name_v2_final.pdf for details.').ok,
    ).toBe(true);
    expect(decide('a'.repeat(100_000)).ok).toBe(true);
    expect(decide('word '.repeat(20_000)).ok).toBe(true);
  });

  it('charges code spans by the distance to a partner of the same length', () => {
    expect(decide('`a` and `b` and `c`. '.repeat(500)).ok).toBe(true);
    // 300 runs, one of every length: none has a partner, each scans to the end of the run
    const distinct = Array.from({ length: 300 }, (_, i) => '`'.repeat(i + 1) + 'a ').join('');
    // the same number of runs and characters, every run the same length: each is closed by the next
    const paired = '`a '.repeat(300).padEnd(distinct.length, 'x');
    expect(runMicros(distinct)).toBeGreaterThan(runMicros(paired) * 3);
  });

  it('charges brackets, more when labels hold escapes or nested brackets', () => {
    expect(
      decide('See [the guide](https://example.com/g) and [the notes](/n). '.repeat(300)).ok,
    ).toBe(true);
    expect(decide('[a '.repeat(20_000)).ok).toBe(false);
    expect(decide('[\\'.repeat(5_000)).ok).toBe(false);
    // closed brackets either way; the escapes make every label scan far longer
    expect(runMicros('[a]\\'.repeat(1_000))).toBeGreaterThan(runMicros('[a]'.repeat(1_000)) * 3);
  });

  it('charges punctuation that starts a token (tags, escapes, entities, images)', () => {
    expect(decide('<'.repeat(30_000)).ok).toBe(false);
    expect(decide('\\*'.repeat(10_000)).ok).toBe(false);
    expect(decide('!'.repeat(30_000)).ok).toBe(false);
  });

  it('is not fooled by characters outside ASCII next to a delimiter', () => {
    expect(decide('*あ'.repeat(5_000)).ok).toBe(false);
    expect(decide('*😀'.repeat(5_000)).ok).toBe(false);
    expect(decide('細胞膜はリン脂質二重層であり、選択的透過性を持つ。'.repeat(3_000)).ok).toBe(
      true,
    );
  });

  it('holds `spent` and the budget together', () => {
    const half = Math.floor(BUDGET_MICROS * 0.6);
    const run = 'word '.repeat(4_000);
    expect(inlineBudget([run], 0).ok).toBe(true);
    expect(inlineBudget([run], half).ok).toBe(true);
    // each run is about 3 ms: sixty of them do not fit in what is left of the budget
    expect(
      inlineBudget(
        Array.from({ length: 60 }, () => run),
        half,
      ).ok,
    ).toBe(false);
    expect(inlineBudget([run], 0, undefined, 10).ok).toBe(false);
    expect(renderBudget('- a\n- b\n', 1)).toMatchObject({ ok: false, reason: 'too-complex' });
  });
});

describe('math spans', () => {
  it('does not charge a formula as emphasis (the extension masks it)', () => {
    const formulas = repeat('Let $a_1 * b_2 * c_3$ and $x_i_j$ hold, then $\\{a,b\\}$. ', 30_000);
    const masked = inlineBudget([formulas], 0, maskMath, 1e12).micros;
    const unmasked = inlineBudget([formulas], 0, undefined, 1e12).micros;
    expect(masked).toBeLessThan(unmasked / 5);
    expect(decide(formulas).ok).toBe(true);
  });

  it('charges every dollar sign before the extension sees the text', () => {
    // `$\` repeated: 9 us per dollar sign in maskMath alone (454 ms for 100,000 characters)
    const storm = repeat('$\\', 100_000);
    const started = performance.now();
    const verdict = renderBudget(storm);
    expect(verdict).toMatchObject({ ok: false, reason: 'too-complex' });
    expect(performance.now() - started).toBeLessThan(100);
    expect(renderBudget(repeat('It costs $5 and $10 today. ', 3_000)).ok).toBe(true);
    expect(renderBudget(repeat('$', 100_000)).ok).toBe(false);
  });
});

describe('the estimators are linear and fast', () => {
  const hostile: Record<string, string> = {
    stars: repeat('*a', 100_000),
    openers: repeat('**a ', 100_000),
    underscores: repeat('_a', 100_000),
    brackets: repeat('[\\', 100_000),
    backticks: Array.from({ length: 440 }, (_, i) => '`'.repeat(i + 1) + 'a ')
      .join('')
      .slice(0, 100_000),
    quotes: repeat('> ', 100_000),
    lines: repeat('- [ ] a\n', 100_000),
    dollars: repeat('$\\', 100_000),
    prose: repeat(
      'The plasma membrane is a phospholipid bilayer; it is selective (see [1]). ',
      100_000,
    ),
  };

  it.each(Object.entries(hostile))(
    'decides on %s at the cap in well under a second',
    (_name, text) => {
      const started = performance.now();
      const verdict = decide(text);
      const elapsed = performance.now() - started;
      expect(verdict.ok).toBe(_name === 'prose');
      // measured 0.01 to 30 ms; the margin is for a loaded CI runner
      expect(elapsed).toBeLessThan(500);
    },
  );
});

describe('mathBudget: how many formulas are typeset', () => {
  it('takes everything within the three caps', () => {
    expect(mathBudget([])).toEqual([]);
    expect(mathBudget([1, 50, MATH_MAX_FORMULA_CHARS])).toEqual([true, true, true]);
  });

  it('skips an empty formula and one over the per-formula cap, and takes the neighbours', () => {
    expect(mathBudget([5, 0, 5, MATH_MAX_FORMULA_CHARS + 1, 5])).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('stops at the formula count', () => {
    const verdict = mathBudget(Array.from({ length: MATH_MAX_FORMULAS + 5 }, () => 3));
    expect(verdict.filter(Boolean)).toHaveLength(MATH_MAX_FORMULAS);
    expect(verdict.slice(0, MATH_MAX_FORMULAS).every(Boolean)).toBe(true);
    expect(verdict.slice(MATH_MAX_FORMULAS).some(Boolean)).toBe(false);
  });

  it('stops at the total length, first fit: a small one after a refused one is still taken', () => {
    const near = MATH_MAX_FORMULA_CHARS - 1;
    // as many near-cap formulas as fit, leaving a few characters of the total
    const fit = Math.floor(MATH_MAX_TOTAL_CHARS / near);
    const left = MATH_MAX_TOTAL_CHARS - fit * near;
    expect(fit).toBeGreaterThanOrEqual(2);
    expect(left).toBeGreaterThanOrEqual(1);
    const big = Array.from({ length: fit }, () => near);
    expect(mathBudget([...big, near, left, 1])).toEqual([
      ...big.map(() => true),
      false, // one more near-cap formula does not fit
      true, // a small one that exactly fills the rest does
      false, // and then nothing does
    ]);
  });

  it('is linear: a note of thousands of formulas is decided at once', () => {
    const started = performance.now();
    const verdict = mathBudget(Array.from({ length: 200_000 }, () => 4));
    expect(verdict.filter(Boolean)).toHaveLength(MATH_MAX_FORMULAS);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
