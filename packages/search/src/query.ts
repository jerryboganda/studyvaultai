/**
 * Query grammar. `parseQuery` NEVER throws: every malformed input degrades to a best-effort tree plus
 * `warnings` the UI can show.
 *
 *   query    := or
 *   or       := and ( "OR" and )*                     OR binds loosest
 *   and      := unary ( ["AND"] unary )*              juxtaposition is AND
 *   unary    := ("NOT" | "-") unary | atom
 *   atom     := "(" or ")" | phrase | filter | word
 *   phrase   := '"' text '"'                          exact, adjacent words (\" and \\ escape)
 *   filter   := key ":" value                         value may be "quoted"; unquoted ends at space
 *   word     := any other run of non-space characters
 *
 * Operators are UPPERCASE only (lower-case "and/or/not" are ordinary words). "-" negates only when
 * attached to the next token and not followed by a digit ("-5 mg" is the number 5). Curly quotes and
 * guillemets delimit phrases too. A single token that contains several words ("beta-blocker",
 * "mg/dL", "T2-weighted") is an implicit phrase.
 *
 * Filters (case-insensitive key; values compare accent/case/punctuation-folded and exactly; a trailing
 * "*" makes a prefix match):
 *   bank:NAME     folder:NAME   tag:NAME    kind:NAME   status:NAME
 *   host:DOMAIN   matches the domain and any subdomain (host:wikipedia.org hits en.wikipedia.org)
 *   priority:N    priority:>=N  >N  <N  <=N  =N
 *   type:highlight | type:note
 *   has:note | has:tag | has:bank | has:heading
 *
 * Limits: 512 characters, 24 words/phrases, 16 levels of parentheses; the excess is dropped with a
 * warning.
 */
import { analyzeWords, candidateTerms, foldText, partSequence, type Word } from './analyzer';

export const MAX_QUERY_LENGTH = 512;
export const MAX_QUERY_TERMS = 24;
const MAX_DEPTH = 16;

export type FilterKey =
  'bank' | 'folder' | 'tag' | 'kind' | 'status' | 'host' | 'priority' | 'type' | 'has';
export type Comparator = '=' | '>' | '>=' | '<' | '<=';

const FILTER_KEYS: ReadonlySet<string> = new Set<FilterKey>([
  'bank',
  'folder',
  'tag',
  'kind',
  'status',
  'host',
  'priority',
  'type',
  'has',
]);
const HAS_VALUES: ReadonlySet<string> = new Set(['note', 'tag', 'bank', 'heading']);
const TYPE_VALUES: ReadonlySet<string> = new Set(['highlight', 'note']);

export type QueryNode =
  | { type: 'term'; raw: string; start: number; end: number; word: Word }
  | {
      type: 'phrase';
      raw: string;
      start: number;
      end: number;
      /** Folded part sequence that must occur consecutively in one field. */
      parts: string[];
      /** `parts` without droppable stop words (used for the soft adjacency bonus). */
      contentParts: string[];
      /** Index terms that must all be present (candidate generation). */
      candidates: string[];
      quoted: boolean;
    }
  | {
      type: 'filter';
      key: FilterKey;
      raw: string;
      start: number;
      end: number;
      /** Folded value (equality / prefix) or `has`/`type` keyword. */
      value: string;
      prefix: boolean;
      cmp?: Comparator;
      num?: number;
    }
  | { type: 'and'; children: QueryNode[] }
  | { type: 'or'; children: QueryNode[] }
  | { type: 'not'; child: QueryNode };

export type WarningCode =
  | 'unknown-filter'
  | 'invalid-value'
  | 'empty-filter'
  | 'unbalanced-quote'
  | 'unbalanced-paren'
  | 'dangling-operator'
  | 'truncated'
  | 'too-many-terms'
  | 'parse-failed';

export interface QueryWarning {
  code: WarningCode;
  message: string;
  start: number;
  end: number;
}

export interface ParsedQuery {
  source: string;
  root: QueryNode | null;
  warnings: QueryWarning[];
}

type Tok =
  | { t: 'lp' | 'rp' | 'and' | 'or' | 'not' | 'minus'; start: number; end: number }
  | { t: 'phrase'; text: string; start: number; end: number; closed: boolean }
  | { t: 'word'; text: string; start: number; end: number }
  | { t: 'filter'; key: string; value: string; start: number; end: number };

const OPEN_QUOTES = '"“«';
const CLOSE_QUOTES = '"”»';
const isSpace = (c: string): boolean => /\s/.test(c);

function readQuoted(src: string, from: number): { text: string; end: number; closed: boolean } {
  let text = '';
  let i = from + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\' && (src[i + 1] === '"' || src[i + 1] === '\\')) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (CLOSE_QUOTES.includes(c)) return { text, end: i + 1, closed: true };
    text += c;
    i++;
  }
  return { text, end: src.length, closed: false };
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (isSpace(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      toks.push({ t: c === '(' ? 'lp' : 'rp', start: i, end: i + 1 });
      i++;
    } else if (OPEN_QUOTES.includes(c)) {
      const q = readQuoted(src, i);
      toks.push({ t: 'phrase', text: q.text, start: i, end: q.end, closed: q.closed });
      i = q.end;
    } else if (
      c === '-' &&
      i + 1 < src.length &&
      !isSpace(src[i + 1]!) &&
      !/\d/.test(src[i + 1]!)
    ) {
      toks.push({ t: 'minus', start: i, end: i + 1 });
      i++;
    } else {
      let j = i;
      let key: string | null = null;
      while (j < src.length && !isSpace(src[j]!) && src[j] !== '(' && src[j] !== ')') {
        if (OPEN_QUOTES.includes(src[j]!)) break;
        if (src[j] === ':' && key === null && j > i) key = src.slice(i, j);
        j++;
      }
      // key:"quoted value"
      if (j < src.length && OPEN_QUOTES.includes(src[j]!) && src[j - 1] === ':' && key !== null) {
        const q = readQuoted(src, j);
        toks.push({ t: 'filter', key, value: q.text, start: i, end: q.end });
        i = q.end;
        continue;
      }
      if (j === i) {
        // a quote char directly after text: end the word, the quote becomes its own token
        j = i + 1;
      }
      const text = src.slice(i, j);
      if (key !== null && FILTER_KEYS.has(key.toLowerCase())) {
        toks.push({ t: 'filter', key, value: text.slice(key.length + 1), start: i, end: j });
      } else if (text === 'AND' || text === 'OR' || text === 'NOT') {
        toks.push({ t: text === 'AND' ? 'and' : text === 'OR' ? 'or' : 'not', start: i, end: j });
      } else {
        toks.push({ t: 'word', text, start: i, end: j });
      }
      i = j;
    }
  }
  return toks;
}

function offsetWord(w: Word, base: number): Word {
  return { ...w, start: w.start + base, end: w.end + base };
}

export function parseQuery(input: string): ParsedQuery {
  const warnings: QueryWarning[] = [];
  try {
    return parseInner(typeof input === 'string' ? input : '', warnings);
  } catch {
    // Defensive: a parser bug must never surface to the user as an exception.
    const source = typeof input === 'string' ? input.slice(0, MAX_QUERY_LENGTH) : '';
    const words = analyzeWords(source).filter((w) => !w.stop || source.length < 8);
    const children: QueryNode[] = words.map((w) => ({
      type: 'term',
      raw: source.slice(w.start, w.end),
      start: w.start,
      end: w.end,
      word: w,
    }));
    return {
      source,
      root: children.length === 0 ? null : { type: 'and', children },
      warnings: [
        {
          code: 'parse-failed',
          message: 'The query could not be parsed; it was searched as plain words.',
          start: 0,
          end: source.length,
        },
      ],
    };
  }
}

function parseInner(input: string, warnings: QueryWarning[]): ParsedQuery {
  let source = input;
  if (source.length > MAX_QUERY_LENGTH) {
    warnings.push({
      code: 'truncated',
      message: `Only the first ${MAX_QUERY_LENGTH} characters of the query were used.`,
      start: MAX_QUERY_LENGTH,
      end: source.length,
    });
    source = source.slice(0, MAX_QUERY_LENGTH);
  }
  const toks = lex(source);
  let pos = 0;
  let leaves = 0;
  let tooMany = false;

  const warn = (code: WarningCode, message: string, start: number, end: number): void => {
    warnings.push({ code, message, start, end });
  };
  const peek = (): Tok | undefined => toks[pos];

  const wordLeaf = (text: string, start: number, end: number): QueryNode | null => {
    const words = analyzeWords(text);
    if (words.length === 0) return null;
    if (leaves >= MAX_QUERY_TERMS) {
      if (!tooMany) {
        tooMany = true;
        warn('too-many-terms', `Only the first ${MAX_QUERY_TERMS} words were used.`, start, end);
      }
      return null;
    }
    leaves++;
    if (words.length === 1) {
      const w = words[0]!;
      if (w.cjk) {
        return {
          type: 'phrase',
          raw: text,
          start,
          end,
          parts: partSequence(words),
          contentParts: partSequence(words, true),
          candidates: candidateTerms(words),
          quoted: false,
        };
      }
      return { type: 'term', raw: text, start, end, word: offsetWord(w, start) };
    }
    return {
      type: 'phrase',
      raw: text,
      start,
      end,
      parts: partSequence(words),
      contentParts: partSequence(words, true),
      candidates: candidateTerms(words),
      quoted: false,
    };
  };

  const phraseLeaf = (tok: Extract<Tok, { t: 'phrase' }>): QueryNode | null => {
    if (!tok.closed) {
      warn(
        'unbalanced-quote',
        'Missing closing quote; the rest of the query was used as a phrase.',
        tok.start,
        tok.end,
      );
    }
    const words = analyzeWords(tok.text);
    if (words.length === 0) return null;
    if (leaves >= MAX_QUERY_TERMS) {
      if (!tooMany) {
        tooMany = true;
        warn(
          'too-many-terms',
          `Only the first ${MAX_QUERY_TERMS} words were used.`,
          tok.start,
          tok.end,
        );
      }
      return null;
    }
    leaves++;
    return {
      type: 'phrase',
      raw: tok.text,
      start: tok.start,
      end: tok.end,
      parts: partSequence(words),
      contentParts: partSequence(words, true),
      candidates: candidateTerms(words),
      quoted: true,
    };
  };

  const filterLeaf = (tok: Extract<Tok, { t: 'filter' }>): QueryNode | null => {
    const key = tok.key.toLowerCase() as FilterKey;
    const raw = source.slice(tok.start, tok.end);
    let value = tok.value.trim();
    if (value === '') {
      warn('empty-filter', `"${tok.key}:" needs a value.`, tok.start, tok.end);
      return null;
    }
    if (key === 'priority') {
      const m = /^(>=|<=|>|<|=)?\s*(-?\d+(?:\.\d+)?)$/.exec(value);
      if (!m) {
        warn(
          'invalid-value',
          'priority: expects a number, optionally with >=, >, <, <= or =.',
          tok.start,
          tok.end,
        );
        return null;
      }
      return {
        type: 'filter',
        key,
        raw,
        start: tok.start,
        end: tok.end,
        value,
        prefix: false,
        cmp: (m[1] as Comparator | undefined) ?? '=',
        num: Number(m[2]),
      };
    }
    if (key === 'has' || key === 'type') {
      value = value.toLowerCase();
      const ok = key === 'has' ? HAS_VALUES : TYPE_VALUES;
      if (!ok.has(value)) {
        warn('invalid-value', `${key}: accepts ${[...ok].join(', ')}.`, tok.start, tok.end);
        return null;
      }
      return { type: 'filter', key, raw, start: tok.start, end: tok.end, value, prefix: false };
    }
    let prefix = false;
    if (value.endsWith('*')) {
      prefix = true;
      value = value.slice(0, -1);
    }
    const folded = foldText(value);
    if (folded === '') {
      warn('empty-filter', `"${tok.key}:" needs a value.`, tok.start, tok.end);
      return null;
    }
    return { type: 'filter', key, raw, start: tok.start, end: tok.end, value: folded, prefix };
  };

  const parseUnary = (depth: number): QueryNode | null => {
    const tok = peek();
    if (!tok) return null;
    switch (tok.t) {
      case 'not':
      case 'minus': {
        pos++;
        const inner = parseUnary(depth);
        if (!inner) {
          if (tok.t === 'not')
            warn('dangling-operator', 'NOT needs something to negate.', tok.start, tok.end);
          return null;
        }
        return { type: 'not', child: inner };
      }
      case 'lp': {
        pos++;
        const inner = depth >= MAX_DEPTH ? parseOr(depth) : parseOr(depth + 1);
        if (peek()?.t === 'rp') pos++;
        else warn('unbalanced-paren', 'Missing closing parenthesis.', tok.start, tok.end);
        return inner;
      }
      case 'phrase':
        pos++;
        return phraseLeaf(tok);
      case 'filter':
        pos++;
        if (!FILTER_KEYS.has(tok.key.toLowerCase())) {
          warn(
            'unknown-filter',
            `"${tok.key}:" is not a filter; searched as plain words.`,
            tok.start,
            tok.end,
          );
          return wordLeaf(source.slice(tok.start, tok.end), tok.start, tok.end);
        }
        return filterLeaf(tok);
      case 'word': {
        pos++;
        if (/^[A-Za-z][A-Za-z0-9_-]+:\S/.test(tok.text) && !/^[A-Za-z]+:\/\//.test(tok.text)) {
          warn(
            'unknown-filter',
            `"${tok.text.slice(0, tok.text.indexOf(':'))}:" is not a filter; searched as plain words.`,
            tok.start,
            tok.end,
          );
        }
        return wordLeaf(tok.text, tok.start, tok.end);
      }
      default:
        // stray AND / OR / ')' handled by callers
        return null;
    }
  };

  const parseAnd = (depth: number): QueryNode | null => {
    const items: QueryNode[] = [];
    for (;;) {
      const tok = peek();
      if (!tok || tok.t === 'or' || tok.t === 'rp') break;
      if (tok.t === 'and') {
        pos++;
        const nxt = peek();
        if (items.length === 0 || !nxt || nxt.t === 'or' || nxt.t === 'rp') {
          warn('dangling-operator', 'AND needs a term on both sides.', tok.start, tok.end);
        }
        continue;
      }
      const before = pos;
      const node = parseUnary(depth);
      if (node) items.push(node);
      if (pos === before) pos++; // always make progress
    }
    if (items.length === 0) return null;
    return items.length === 1 ? items[0]! : { type: 'and', children: items };
  };

  const parseOr = (depth: number): QueryNode | null => {
    const alts: QueryNode[] = [];
    const first = parseAnd(depth);
    if (first) alts.push(first);
    while (peek()?.t === 'or') {
      const op = peek()!;
      pos++;
      const rhs = parseAnd(depth);
      if (rhs) alts.push(rhs);
      if (!first || !rhs)
        warn('dangling-operator', 'OR needs a term on both sides.', op.start, op.end);
    }
    if (alts.length === 0) return null;
    return alts.length === 1 ? alts[0]! : { type: 'or', children: alts };
  };

  const top: QueryNode[] = [];
  while (pos < toks.length) {
    const node = parseOr(0);
    if (node) top.push(node);
    const t = peek();
    if (t && t.t === 'rp') {
      warn('unbalanced-paren', 'Unmatched closing parenthesis.', t.start, t.end);
      pos++;
    }
  }
  const root: QueryNode | null =
    top.length === 0 ? null : top.length === 1 ? top[0]! : { type: 'and', children: top };
  return { source, root, warnings };
}

/** Every term/phrase leaf in reading order, with whether it sits under a NOT. */
export function collectLeaves(
  node: QueryNode | null,
  out: Array<{ node: Extract<QueryNode, { type: 'term' | 'phrase' }>; negated: boolean }> = [],
  negated = false,
): typeof out {
  if (!node) return out;
  switch (node.type) {
    case 'term':
    case 'phrase':
      out.push({ node, negated });
      break;
    case 'and':
    case 'or':
      for (const c of node.children) collectLeaves(c, out, negated);
      break;
    case 'not':
      collectLeaves(node.child, out, !negated);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Examples shown by the UI as search help. Each one is asserted in the test suite to parse without
 * warnings, so the help cannot drift from the grammar.
 */
export const QUERY_SYNTAX: readonly { example: string; meaning: string }[] = [
  { example: 'cell membrane', meaning: 'both words (typos and word starts also match)' },
  { example: '"cell membrane"', meaning: 'the exact phrase' },
  { example: 'mitral OR aortic', meaning: 'either word' },
  { example: 'valve -prosthetic', meaning: 'exclude a word (or NOT prosthetic)' },
  { example: '(mitral OR aortic) stenosis', meaning: 'group with parentheses' },
  { example: 'bank:Cardiology', meaning: 'only this bank' },
  { example: 'tag:"exam pearl"', meaning: 'only this tag (quote names with spaces)' },
  { example: 'tag:neuro*', meaning: 'tags that start with "neuro"' },
  { example: 'kind:formula', meaning: 'only this highlight kind' },
  { example: 'host:wikipedia.org', meaning: 'a site and its subdomains' },
  { example: 'priority:>=3', meaning: 'priority comparison (>=, >, <, <=, =)' },
  { example: 'status:orphaned', meaning: 'highlights by restore status' },
  { example: 'has:note', meaning: 'has your own note (also has:tag, has:bank, has:heading)' },
  { example: 'type:note', meaning: 'notes only (or type:highlight)' },
];
