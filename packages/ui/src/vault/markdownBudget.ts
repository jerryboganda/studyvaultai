/**
 * A time budget for rendering untrusted Markdown (notes, synced notes, imported notes, AI drafts).
 *
 * Why: marked 18.1.0 is quadratic or worse on some shapes of input, and a note body may be 100,000
 * characters (MAX_NOTE_BODY_CHARS). Measured on Node 24, the 100,000-character inputs
 * `'*a'.repeat(50000)` and `'_a'.repeat(50000)` take 20 s and over 25 s, `'**a '.repeat(25000)` and
 * `'*a\n'.repeat(33333)` do not finish in 25 s, and `'> '.repeat(3200)` throws a stack overflow.
 * A hostile note, a synced note or a Markdown import could freeze the extension page that previews it.
 *
 * What: two pure checks, both linear in the input, that estimate the work marked would do and refuse
 * it when it is over budget. The caller then shows the text unformatted (markdownRender.ts).
 *
 *  - `renderBudget(text)`: the raw text. Length, nesting depth of quotes and lists, and the block pass
 *    (lines, list items, task items). Runs BEFORE marked, so marked never sees a text that is too long
 *    or too deep.
 *  - `inlineBudget(runs)`: the inline runs marked's block pass produced (its own `inlineQueue`: one
 *    entry per paragraph, list item, heading and table cell), so the run boundaries are marked's, not a
 *    guess. Runs after the block pass (cheap) and before the inline pass, which is where the
 *    quadratic work is. The extension's math spans are masked first, as marked masks them.
 *
 * Both return the estimate in microseconds ("micros"). The constants in `C` are fitted to measurements
 * of marked 18.1.0 and are set at or above them: an upper bound, not an average. Balanced emphasis in a
 * long paragraph is cheap in marked but is charged as if it were not, so that an input that makes
 * marked see unbalanced delimiters where we see balanced ones gains nothing.
 *
 * The inline mechanisms, each measured:
 *  - emphasis `* _ ~`: every delimiter run that can OPEN scans forward over every later run of the same
 *    character until it finds a closer, so n unmatched openers cost n(n-1)/2 steps of about 2 us.
 *    `'**a '.repeat(1000)` takes 1.0 s. Charged: openers x later runs, per character.
 *  - the text rule's e-mail look-ahead `(?=[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+@)` runs once per text token
 *    and scans the rest of the current "word" (no spaces, brackets, `\` or `<`), so a long word with
 *    many `* _ ~ ! `` ` marks costs (marks + 1) x word length. `'*a'.repeat(10000)` takes 0.9 s.
 *  - code spans: an opening backtick run scans to the next run of the same length (or to the end).
 *  - links: every `[` scans up to 999 characters for its `]`, more with escapes or nested links.
 *  - `<` (tags), `\` (escapes), `&`, `!`, `$` (math spans), `@`, `www.`, `://` (auto-links) and any
 *    other punctuation: a few microseconds each.
 *
 * The thresholds are set so that a realistic note passes with a wide margin and a hostile one is
 * refused; markdownRender.test.ts measures both on the real pipeline.
 */

/** The largest text rendered as Markdown; MAX_NOTE_BODY_CHARS (packages/shared/src/vault.ts). */
export const RENDER_MAX_CHARS = 100_000;
/**
 * Quote / list nesting. Real notes go 3 or 4 deep. Measured: 24 deep costs 1 ms; nesting by indentation
 * is cubic (200 levels 93 ms, 800 levels 8.3 s) and a chain of `> ` overflows the stack at about 3,000.
 */
export const MAX_NESTING = 24;
/** Estimated work above which the text is shown unformatted (microseconds of the model below). */
export const BUDGET_MICROS = 150_000;

/**
 * Cost constants, in microseconds, fitted to marked 18.1.0 on a warm V8 (the first render in a page
 * also pays a one-time regular-expression compile of 50 to 300 ms that no input can change). The
 * structural constants are about twice what a realistic document costs; the mechanism constants
 * (emphasis, word, tick, bracket, task, lazy) are the measured worst case.
 */
const C = {
  /** Block pass, per non-blank line. Measured 3 us (paragraph, heading, rule). */
  line: 3,
  /** Block pass, per line squared: a guard for block-level shapes not modelled below. */
  lineSq: 0.001,
  /** A list item: measured 5 to 6 us more than a paragraph; loose lists scan items again. */
  item: 5,
  /**
   * A task item (`- [ ]`, `- [x]`): 14 us in a list of 25, about 100 us in a list of 250 or more, and
   * then quadratic (1,000 items 109 ms, 4,000 items 734 ms). `taskFew` is charged to a list's first 30.
   */
  taskFew: 20,
  task: 100,
  taskPair: 0.1,
  /** A quote's lazy continuation lines, times the quote's lines: 3 to 11 ns measured. */
  lazyPair: 0.01,
  /** One inline run: its tokens, render and the DOM nodes it becomes. Measured 3 to 6 us. */
  run: 8,
  /** One character of inline text; one of `>`, `"`, `'` (escaped on output): 0.15 to 0.3 us measured. */
  char: 0.15,
  punct: 0.4,
  /** One line break inside a run, soft or hard. */
  newline: 2,
  /** Emphasis: one (opener, later delimiter run) pair. 2 to 2.4 us measured. */
  emphasis: 3,
  /** The e-mail look-ahead: one (text token, character of its word) pair. 11 to 145 ns measured. */
  word: 0.15,
  /** Code span: one (opening run, character scanned) pair, 6 ns measured; and one run, 5 to 13 us. */
  tick: 0.008,
  tickRun: 8,
  /** A `[`: scans up to 999 characters for its `]`: 3 to 10 ns per character, 37 to 70 with escapes or nested links. */
  bracket: 0.06,
  bracketPlain: 0.01,
  /** `<` (tag attempt), a backslash (escape), `&`, `!`, `@`, `www.` and `://`: 1 to 15 us measured. */
  angle: 15,
  escape: 20,
  amp: 1,
  bang: 8,
  /** `$`: a math-span attempt of up to 500 characters, made twice: 4 to 9 us measured. */
  dollar: 16,
  linkish: 15,
  /** An element per delimiter run or bracket: measured 4 to 8 us with its token and DOM node. */
  element: 6,
  /** Each token start asks the math extension where the next dollar sign is: a scan of the rest. */
  tokenScan: 0.00025,
} as const;

export type BudgetReason = 'too-long' | 'too-deep' | 'too-complex';

export interface BudgetVerdict {
  ok: boolean;
  /** Why the text is refused; absent when it is accepted. */
  reason?: BudgetReason;
  /** The estimate, in microseconds (see BUDGET_MICROS). Cut short once the budget is exceeded. */
  micros: number;
}

const accept = (micros: number): BudgetVerdict => ({ ok: true, micros });
const refuse = (reason: BudgetReason, micros: number): BudgetVerdict => ({
  ok: false,
  reason,
  micros,
});

/** Task items of one list charged at the low rate. */
const FEW_TASKS = 30;
const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const BANG = 33;
const AMP = 38;
const STAR = 42;
const LT = 60;
const GT = 62;
const AT = 64;
const LBRACKET = 91;
const RBRACKET = 93;
const BACKSLASH = 92;
const UNDER = 95;
const BACKTICK = 96;
const TILDE = 126;

/** Whitespace in the sense of `\s`, claimed only for characters that really are. */
function isWhitespace(c: number): boolean {
  return (
    c === SPACE ||
    (c >= TAB && c <= CR) ||
    c === 0xa0 ||
    c === 0x3000 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c !== c // end of text (NaN from charCodeAt)
  );
}

/** ASCII punctuation and symbols. Non-ASCII characters are not classified (callers pick the safe side). */
function isAsciiPunct(c: number): boolean {
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}

// What a character is to the flanking rules.
const SPACE_KIND = 0;
const PUNCT_KIND = 1;
const WORD_KIND = 2;

/**
 * Leaning towards "can open": a character outside ASCII counts as punctuation before a delimiter
 * (which lets it open) and as a word character after one. Over-counting openers only makes the
 * estimate larger.
 */
function before(c: number): number {
  if (isWhitespace(c)) return SPACE_KIND;
  if (isAsciiPunct(c) || c > 127) return PUNCT_KIND;
  return WORD_KIND;
}
function after(c: number): number {
  if (isWhitespace(c)) return SPACE_KIND;
  if (isAsciiPunct(c)) return PUNCT_KIND;
  return WORD_KIND;
}

/** Characters of the text rule's e-mail local part: the look-ahead scans a run of these. */
function isLocal(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 46 || // .
    c === 33 || // !
    (c >= 35 && c <= 39) || // # $ % & '
    c === 42 || // *
    c === 43 || // +
    c === 47 || // /
    c === 61 || // =
    c === 63 || // ?
    c === 95 || // _
    c === 96 || // `
    (c >= 123 && c <= 126) || // { | } ~
    c === 45 // -
  );
}

/** Local characters at which the text rule ends a token: `* _ ~ !` and the backtick. */
const isMark = (c: number): boolean =>
  c === STAR || c === UNDER || c === TILDE || c === BANG || c === BACKTICK;

/** Letters, digits, spaces and non-ASCII text are cheap (`char`); other characters cost `punct`. */
const isPlain = (c: number): boolean =>
  (c >= 48 && c <= 57) ||
  (c >= 65 && c <= 90) ||
  (c >= 97 && c <= 122) ||
  c === SPACE ||
  c === LF ||
  c > 127;

/**
 * The raw text: size, nesting and the block pass. Linear. Run it before marked.
 *
 * "Non-blank line" is the unit of block work. A line's container prefix is read the way marked reads
 * it: any number of `>` quote markers, bullets (`- + *` then a space) and ordered markers (`1.` `1)`),
 * each one level; a marker indented n columns adds n/2 levels (nested lists).
 */
export function renderBudget(text: string, budget = BUDGET_MICROS): BudgetVerdict {
  const n = text.length;
  if (n > RENDER_MAX_CHARS) return refuse('too-long', Infinity);
  // Every dollar sign is a math-span attempt of up to 500 characters (markdownMath.ts), made by
  // `maskMath` and again by the tokenizer: 9 us each measured on `$\` repeated. Charged here, before
  // any run is handed to `maskMath`, so a storm of them never reaches the extension.
  let dollars = 0;
  for (let at = text.indexOf('$'); at >= 0; at = text.indexOf('$', at + 1)) dollars++;
  if (C.dollar * dollars > budget) return refuse('too-complex', C.dollar * dollars);
  let lines = 0;
  let items = 0;
  let tasks = 0;
  /** Task items so far in the current list: marked is quadratic in a list's task items. */
  let listTasks = 0;
  let fewTasks = 0;
  let taskPairs = 0;
  /** Lines of quotes, and those among them with no `>` (lazy continuation): quadratic in marked. */
  let quoted = 0;
  let lazy = 0;
  let inQuote = false;
  let blankBefore = true;
  let i = 0;
  while (i < n) {
    // [i, end) is one line, without its terminator.
    let end = text.indexOf('\n', i);
    if (end < 0) end = n;
    let p = i;
    let cols = 0;
    for (; p < end; p++) {
      const c = text.charCodeAt(p);
      if (c === SPACE) cols++;
      else if (c === TAB) cols += 4 - (cols % 4);
      else break;
    }
    if (p < end && !(end - p === 1 && text.charCodeAt(p) === CR)) {
      lines++;
      const depth = containerDepth(text, p, end, cols);
      if (depth.levels > MAX_NESTING) return refuse('too-deep', 0);
      if (depth.item) items++;
      if (depth.task) {
        if (++listTasks > FEW_TASKS) tasks++;
        else fewTasks++;
        taskPairs += listTasks;
      } else if (!depth.item && cols < 2 && blankBefore) {
        listTasks = 0; // a paragraph after a blank line ends the list
      }
      if (text.charCodeAt(p) === GT) {
        inQuote = true;
        quoted++;
      } else if (inQuote && !depth.item) {
        lazy++; // a line without `>` that continues the quote's paragraph
      } else {
        inQuote = false;
      }
      blankBefore = false;
    } else {
      blankBefore = true;
      inQuote = false;
    }
    i = end + 1;
  }
  const micros =
    C.dollar * dollars +
    C.line * lines +
    C.lineSq * lines * lines +
    C.item * items +
    C.taskFew * fewTasks +
    C.task * tasks +
    C.taskPair * taskPairs +
    C.lazyPair * lazy * (lazy + quoted);
  return micros > budget ? refuse('too-complex', micros) : accept(micros);
}

/** Container markers at the start of a line (`start` is after `cols` columns of indentation). */
function containerDepth(
  text: string,
  start: number,
  end: number,
  cols: number,
): { levels: number; task: boolean; item: boolean } {
  let p = start;
  let levels = 0;
  let task = false;
  let item = false;
  let listMarker = false;
  while (p < end) {
    const c = text.charCodeAt(p);
    let next = p + 1;
    if (c === GT) {
      // a quote marker: `>` and an optional space
    } else if (c === 45 || c === 43 || c === STAR) {
      // a bullet needs a space (or the end of the line) after it; `***`, `---` are rules and `*a` is text
      const follow = text.charCodeAt(next);
      if (!(next >= end || follow === SPACE || follow === TAB)) break;
      if (isRule(text, p, end)) break;
      listMarker = true;
    } else if (c >= 48 && c <= 57) {
      let q = p;
      while (q < end && q - p < 9 && text.charCodeAt(q) >= 48 && text.charCodeAt(q) <= 57) q++;
      const d = text.charCodeAt(q);
      if (!(d === 46 || d === 41)) break;
      const follow = text.charCodeAt(q + 1);
      if (!(q + 1 >= end || follow === SPACE || follow === TAB)) break;
      listMarker = true;
      next = q + 1;
    } else {
      break;
    }
    if (++levels > MAX_NESTING) break; // deep enough to refuse: stop reading the line
    if (listMarker) item = true;
    p = next;
    while (p < end && (text.charCodeAt(p) === SPACE || text.charCodeAt(p) === TAB)) p++;
    if (listMarker && p < end) {
      // `- [ ] ` and `- [x] `: a task item
      if (
        text.charCodeAt(p) === LBRACKET &&
        text.charCodeAt(p + 2) === 93 &&
        (text.charCodeAt(p + 1) === SPACE ||
          text.charCodeAt(p + 1) === 120 ||
          text.charCodeAt(p + 1) === 88)
      ) {
        task = true;
      }
      listMarker = false;
    }
  }
  return { levels: levels + (levels > 0 ? Math.floor(cols / 2) : 0), task, item };
}

/** `---`, `* * *`, `_ _ _`: three or more of one of `- * _` and nothing else (spaces allowed). */
function isRule(text: string, from: number, end: number): boolean {
  const mark = text.charCodeAt(from);
  let count = 0;
  for (let p = from; p < end; p++) {
    const c = text.charCodeAt(p);
    if (c === mark) count++;
    else if (c !== SPACE && c !== TAB && c !== CR) return false;
  }
  return count >= 3;
}

/**
 * Per-character delimiter bookkeeping (`*`, `_`, `~`). An opener scans forward over the later runs of
 * its character until its closer. Two kinds are told apart:
 *  - a pure opener (certainly left-flanking only, ASCII around it) that meets a pure closer (right-
 *    flanking only) of equal length, as in `**bold**` and `*em*`, scans just the runs between them;
 *    this is what makes balanced text cheap, and it is paired as CommonMark pairs: nearest first;
 *  - every other run that can open, and every pure opener left without a closer, is charged as if it
 *    scanned to the end of the run (an upper bound for any pairing marked may make).
 */
interface Delimiters {
  /** Runs seen. */
  runs: number;
  /** Openers charged to the end of the run, and the sum of their ordinals (0-based). */
  openers: number;
  openerOrdinals: number;
  /** Runs scanned by the pairs found. */
  paired: number;
  /** Pure openers waiting for a closer: ordinal, length, ordinal, length ... */
  stack: number[];
}

const delimiters = (): Delimiters => ({
  runs: 0,
  openers: 0,
  openerOrdinals: 0,
  paired: 0,
  stack: [],
});

/** Runs scanned in all: the pairs, plus sum over charged openers of (runs - 1 - ordinal). */
function emphasisSteps(d: Delimiters): number {
  let openers = d.openers;
  let ordinals = d.openerOrdinals;
  for (let k = 0; k < d.stack.length; k += 2) {
    openers++;
    ordinals += d.stack[k]!;
  }
  return d.paired + (openers > 0 ? openers * (d.runs - 1) - ordinals : 0);
}

const AUTOLINK_START = /www\.|:\/\//g;

/** Estimated work of one inline run, in microseconds. */
export function runMicros(src: string): number {
  const n = src.length;
  // created on first use: most runs have none (a list item, a heading)
  let star: Delimiters | null = null;
  let under: Delimiters | null = null;
  let tilde: Delimiters | null = null;
  let wordLen = 0;
  let wordMarks = 0;
  let wordCost = 0;
  let puncts = 0;
  let brackets = 0;
  let openBrackets = 0;
  let nestedBrackets = false;
  let angles = 0;
  let escapes = 0;
  let amps = 0;
  let bangs = 0;
  let newlines = 0;
  let linkish = 0;
  let tickRuns = 0;
  let tickCost = 0;
  let ticks: Map<number, number> | null = null;

  for (let i = 0; i < n; i++) {
    const c = src.charCodeAt(i);
    if (isLocal(c)) {
      wordLen++;
      if (isMark(c)) wordMarks++;
    } else if (wordLen > 0) {
      wordCost += (wordMarks + 1) * wordLen;
      wordLen = 0;
      wordMarks = 0;
    }
    if (!isPlain(c)) puncts++;
    if (c === STAR || c === UNDER || c === TILDE) {
      if (i > 0 && src.charCodeAt(i - 1) === c) continue; // inside a run already counted
      let j = i + 1;
      while (j < n && src.charCodeAt(j) === c) j++;
      const d =
        c === STAR
          ? (star ??= delimiters())
          : c === UNDER
            ? (under ??= delimiters())
            : (tilde ??= delimiters());
      const prevCode = i === 0 ? NaN : src.charCodeAt(i - 1);
      const nextCode = j >= n ? NaN : src.charCodeAt(j);
      const prev = i === 0 ? SPACE_KIND : before(prevCode);
      const next = j >= n ? SPACE_KIND : after(nextCode);
      // left-flanking: not before a space, and not before punctuation unless after space/punctuation
      const left = next !== SPACE_KIND && (next !== PUNCT_KIND || prev !== WORD_KIND);
      const right = prev !== SPACE_KIND && (prev !== PUNCT_KIND || next !== WORD_KIND);
      // an underscore does not open inside a word: it must not be right-flanking, or follow punctuation
      const canOpen = left && (c !== UNDER || !right || prev === PUNCT_KIND);
      // Certain only with ASCII on both sides: `x` before only (an opener), `x` after only (a closer)
      const ascii = !(prevCode > 127) && !(nextCode > 127);
      const length = j - i;
      if (ascii && left && !right) {
        d.stack.push(d.runs, length);
      } else if (ascii && right && !left) {
        // a closer meets the nearest opener when their lengths are equal: it scanned the runs between
        const top = d.stack.length - 1;
        if (top > 0 && d.stack[top] === length) {
          d.paired += d.runs - d.stack[top - 1]!;
          d.stack.length = top - 1;
        }
      } else if (canOpen) {
        // can open but may also close, or is not provably paired: it may scan to the end
        d.openers++;
        d.openerOrdinals += d.runs;
      }
      d.runs++;
    } else if (c === BACKTICK) {
      if (i > 0 && src.charCodeAt(i - 1) === BACKTICK) continue;
      let j = i + 1;
      while (j < n && src.charCodeAt(j) === BACKTICK) j++;
      tickRuns++;
      ticks ??= new Map();
      const last = ticks.get(j - i);
      // an opener scans to the next run of the same length (which closes it), or to the end
      if (last !== undefined) tickCost += i - last;
      ticks.set(j - i, i);
    } else if (c === LBRACKET) {
      brackets++;
      if (openBrackets++ > 0) nestedBrackets = true;
    } else if (c === RBRACKET) {
      if (openBrackets > 0) openBrackets--;
    } else if (c === LT) {
      angles++;
    } else if (c === BACKSLASH) {
      escapes++;
    } else if (c === AT) {
      linkish++;
    } else if (c === AMP) {
      amps++;
    } else if (c === BANG) {
      bangs++;
    } else if (c === LF) {
      newlines++;
    }
  }
  if (wordLen > 0) wordCost += (wordMarks + 1) * wordLen;
  if (ticks) {
    // a run that found no partner scans to the end of the run
    for (const last of ticks.values()) tickCost += n - last;
  }
  // `www.` and `://` start an auto-link candidate
  if (n > 3 && (src.includes('www.') || src.includes('://'))) {
    linkish += (src.match(AUTOLINK_START) ?? []).length;
  }

  const emphasis =
    (star ? emphasisSteps(star) : 0) +
    (under ? emphasisSteps(under) : 0) +
    (tilde ? emphasisSteps(tilde) : 0);
  const elements = (star?.runs ?? 0) + (under?.runs ?? 0) + (tilde?.runs ?? 0) + brackets;
  const tokens = elements + tickRuns + bangs + angles + escapes;
  return (
    C.run +
    C.char * n +
    C.punct * puncts +
    C.emphasis * emphasis +
    C.word * wordCost +
    C.tick * tickCost +
    C.tickRun * tickRuns +
    // escapes, code spans and nested brackets make a label scan far longer than a plain one
    (nestedBrackets || escapes > 0 || tickRuns > 0 ? C.bracket : C.bracketPlain) *
      brackets *
      Math.min(n, 2000) +
    C.angle * angles +
    C.escape * escapes +
    C.amp * amps +
    C.bang * bangs +
    C.newline * newlines +
    C.linkish * linkish +
    C.element * elements +
    C.tokenScan * tokens * n
  );
}

/**
 * The inline runs of a document (marked's `lexer.inlineQueue` sources after its block pass).
 * `spent` is the estimate `renderBudget` returned for the same document; the sum is held to the same
 * budget. `mask` is the extension's own masking (math spans are not parsed as Markdown), applied to
 * each run first so a formula full of `_` and `*` is not charged as emphasis. Dollar signs are not
 * charged here: `renderBudget` charged every one, before any mask ran.
 */
export function inlineBudget(
  runs: Iterable<string>,
  spent = 0,
  mask: (run: string) => string = (run) => run,
  budget = BUDGET_MICROS,
): BudgetVerdict {
  let micros = spent;
  for (const run of runs) {
    micros += runMicros(mask(run));
    if (micros > budget) return refuse('too-complex', micros);
  }
  return accept(micros);
}
