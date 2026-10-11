import { HtmlAnchorSet } from '@shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureAnchor } from './capture';
import { resolveAnchor } from './resolve';
import {
  buildTextStream,
  collapseWhitespace,
  rangeToStreamOffsets,
  streamRangeToDomRange,
  streamTextOfRange,
} from './textStream';
import { prng, textNodesOf } from './testUtils';

// Small vocabulary on purpose: repeated words and phrases are the hard case for anchoring.
const WORDS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'cell',
  'membrane',
  'the',
  'of',
  'ATP',
  'x2',
  'café',
  'éclair',
  '日本語',
  'مرحبا',
  '\u{1F9EC}',
  'osmosis',
  'ratio',
  'enzyme',
  'protein',
  'a',
  'in',
  'to',
  'receptor',
  'signal',
  'pathway',
  'binding',
  'nucleus',
  'ribosome',
  'transport',
  'gradient',
];
const SEPARATORS = [' ', ' ', ' ', '  ', '\n', '\u00A0', ' \t ', ' \n  '];
const TAGS = ['p', 'div', 'span', 'strong', 'em', 'a', 'li', 'td', 'section', 'b'];

function makeText(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 6);
  let s = rand() < 0.15 ? SEPARATORS[Math.floor(rand() * SEPARATORS.length)]! : '';
  for (let i = 0; i < n; i++) {
    s += WORDS[Math.floor(rand() * WORDS.length)]!;
    if (i < n - 1 || rand() < 0.5) s += SEPARATORS[Math.floor(rand() * SEPARATORS.length)]!;
  }
  return s;
}

function fill(parent: Element, rand: () => number, depth: number): void {
  const count = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const r = rand();
    if (r < 0.45 || depth >= 5) {
      parent.appendChild(document.createTextNode(makeText(rand)));
    } else if (r < 0.52) {
      const skipped = document.createElement(
        ['script', 'style', 'textarea', 'noscript'][Math.floor(rand() * 4)]!,
      );
      // A non-JS type keeps jsdom from executing the random words as script.
      if (skipped.localName === 'script') skipped.setAttribute('type', 'text/plain');
      // Valid CSS comment keeps jsdom's stylesheet parser quiet; the stream skips it either way.
      skipped.textContent =
        skipped.localName === 'style' ? `/* ${makeText(rand)} */` : makeText(rand);
      parent.appendChild(skipped);
    } else if (r < 0.56) {
      const host = document.createElement('div');
      host.setAttribute('data-studyvault', '');
      host.textContent = makeText(rand);
      parent.appendChild(host);
    } else {
      const el = document.createElement(TAGS[Math.floor(rand() * TAGS.length)]!);
      if (rand() < 0.1) el.style.display = 'none';
      fill(el, rand, depth + 1);
      parent.appendChild(el);
    }
  }
}

function generate(seed: number): void {
  const rand = prng(seed);
  document.body.innerHTML = '';
  const root = document.createElement('main');
  const blocks = 6 + Math.floor(rand() * 10);
  for (let i = 0; i < blocks; i++) {
    if (rand() < 0.2) {
      const h = document.createElement('h' + (1 + Math.floor(rand() * 3)));
      h.textContent = makeText(rand);
      root.appendChild(h);
    }
    const block = document.createElement(rand() < 0.5 ? 'p' : 'div');
    fill(block, rand, 0);
    root.appendChild(block);
  }
  document.body.appendChild(root);
}

function randomRange(rand: () => number): Range | null {
  const nodes = textNodesOf(document.body);
  if (nodes.length < 2) return null;
  const range = document.createRange();
  const kind = rand();
  if (kind < 0.3) {
    // A word-sized selection inside one text node: short quotes repeat, which is the hard case.
    const node = nodes[Math.floor(rand() * nodes.length)]!;
    if (node.data.length < 2) return null;
    const so = Math.floor(rand() * (node.data.length - 1));
    const eo = Math.min(node.data.length, so + 1 + Math.floor(rand() * 12));
    range.setStart(node, so);
    range.setEnd(node, eo);
    return range;
  }
  if (kind < 0.65) {
    // Arbitrary character offsets in two text nodes.
    let i = Math.floor(rand() * nodes.length);
    let j = Math.floor(rand() * nodes.length);
    if (i > j) [i, j] = [j, i];
    const a = nodes[i]!;
    const b = nodes[j]!;
    const ao = Math.floor(rand() * (a.data.length + 1));
    const bo = Math.floor(rand() * (b.data.length + 1));
    range.setStart(a, ao);
    range.setEnd(b, bo);
    if (range.collapsed && ao > bo) return null;
    return range;
  }
  if (kind < 0.8) {
    // Whole-element selection (triple-click / select-all-in-block style).
    const els = Array.from(document.body.querySelectorAll('*'));
    const el = els[Math.floor(rand() * els.length)]!;
    range.selectNodeContents(el);
    return range;
  }
  // Element-container boundaries at arbitrary child indices of two parents.
  const parents = [document.body, ...Array.from(document.body.querySelectorAll('*'))];
  const p1 = parents[Math.floor(rand() * parents.length)]!;
  const p2 = parents[Math.floor(rand() * parents.length)]!;
  const o1 = Math.floor(rand() * (p1.childNodes.length + 1));
  const o2 = Math.floor(rand() * (p2.childNodes.length + 1));
  range.setStart(p1, o1);
  range.setEnd(p2, o2);
  // An end before the start collapses the range onto the end: capture must report 'empty'.
  return range;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('property: capture then resolve on the unchanged page (seeded)', () => {
  it('300+ random ranges over generated nested DOMs always resolve to the stream slice', () => {
    let attempted = 0;
    let captured = 0;
    let multi = 0;
    const statusCounts: Record<string, number> = {};

    for (let seed = 1; seed <= 40; seed++) {
      generate(seed);
      const rand = prng(seed * 7919);
      for (let k = 0; k < 14; k++) {
        const range = randomRange(rand);
        if (!range) continue;
        attempted++;
        const stream = buildTextStream();
        const result = captureAnchor(range, range.toString(), stream);
        if ('error' in result) continue;
        captured++;

        const { anchorSet } = result;
        expect(HtmlAnchorSet.safeParse(anchorSet).success).toBe(true);
        const { start, end } = anchorSet.textPosition;
        expect(anchorSet.textQuote.exact).toBe(stream.text.slice(start, end));
        expect(anchorSet.textQuote.exact.startsWith(' ')).toBe(false);
        expect(anchorSet.textQuote.exact.endsWith(' ')).toBe(false);

        // Restore on a freshly built stream, exactly like a page reload.
        const fresh = buildTextStream();
        const res = resolveAnchor(anchorSet, fresh);
        statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
        expect(res.status, `seed ${seed} #${k}: ${anchorSet.textQuote.exact}`).toBe('resolved');
        expect(res.range).not.toBeNull();
        if (res.candidateCount > 1) multi++;

        const slice = fresh.text.slice(start, end);
        expect(streamTextOfRange(res.range!)).toBe(slice);
        expect(collapseWhitespace(streamTextOfRange(res.range!))).toBe(anchorSet.textQuote.exact);
        expect(rangeToStreamOffsets(fresh, res.range!)).toEqual({ start, end });
      }
    }
    // Make sure the generator really exercised the engine (and the hard repeated-quote path).
    console.log(
      `property: attempted=${attempted} captured=${captured} multiCandidate=${multi}`,
      statusCounts,
    );
    expect(captured).toBeGreaterThanOrEqual(300);
    expect(multi).toBeGreaterThan(10);
  }, 120_000);

  it('stream <-> DOM offsets round-trip for random (start, end) pairs', () => {
    for (let seed = 100; seed < 110; seed++) {
      generate(seed);
      const rand = prng(seed);
      const stream = buildTextStream();
      const n = stream.text.length;
      for (let k = 0; k < 40; k++) {
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        const s = Math.min(a, b);
        const e = Math.max(a, b) + 1;
        if (e > n) continue;
        const range = streamRangeToDomRange(stream, s, e);
        expect(range).not.toBeNull();
        expect(rangeToStreamOffsets(stream, range!)).toEqual({ start: s, end: e });
        expect(streamTextOfRange(range!)).toBe(stream.text.slice(s, e));
      }
    }
  });
});

// Deeper local exploration: SV_PROPERTY_SEEDS=600 pnpm exec vitest run packages/highlights
const EXTRA = Number(process.env.SV_PROPERTY_SEEDS ?? 0);
const SEED_COUNT = EXTRA > 0 ? EXTRA : 40;

describe('property: never a silently wrong highlight after the page is edited', () => {
  it('decoy copies of the quote never capture a highlight whose original is still intact', () => {
    let resolved = 0;
    let ambiguous = 0;
    let other = 0;
    let intactCount = 0;
    let wrong = 0;

    for (let seed = 200; seed < 200 + SEED_COUNT; seed++) {
      generate(seed);
      const rand = prng(seed * 31);
      for (let k = 0; k < 6; k++) {
        const range = randomRange(rand);
        if (!range) continue;
        const stream = buildTextStream();
        const result = captureAnchor(range, range.toString(), stream);
        if ('error' in result) continue;
        const { anchorSet } = result;
        const { start, end } = anchorSet.textPosition;

        // Live range over the original quote; it stays equal to the quote text only while the
        // original text is intact (an insertion inside it makes the range swallow the insertion).
        const original = streamRangeToDomRange(stream, start, end)!;
        const firstChar = streamRangeToDomRange(stream, start, start + 1)!;
        const originNode = firstChar.startContainer;
        const originOffset = firstChar.startOffset;

        // A decoy paragraph made of the same vocabulary that contains the quote twice, inserted at
        // a random block boundary (sometimes directly after/before the original).
        const decoy = document.createElement('p');
        decoy.textContent =
          anchorSet.textQuote.exact + ' ' + makeText(rand) + ' ' + anchorSet.textQuote.exact;
        const blocks = Array.from(document.querySelectorAll('main > *'));
        const at = blocks[Math.floor(rand() * blocks.length)]!;
        if (rand() < 0.5) at.before(decoy);
        else at.after(decoy);

        const intact = streamTextOfRange(original) === anchorSet.textQuote.exact;
        if (intact) intactCount++;
        const res = resolveAnchor(anchorSet, buildTextStream());
        if (res.status === 'resolved') {
          resolved++;
          const sameSpot =
            res.range!.startContainer === originNode && res.range!.startOffset === originOffset;
          if (intact && !sameSpot) wrong++;
          expect(
            !intact || sameSpot,
            `seed ${seed} #${k} picked a decoy over an intact original: ${anchorSet.textQuote.exact.slice(0, 60)}`,
          ).toBe(true);
        } else if (res.status === 'ambiguous') {
          ambiguous++;
          expect(res.range).toBeNull();
        } else {
          other++;
          expect(res.status === 'changed' || res.range === null).toBe(true);
        }
        decoy.remove();
      }
    }
    console.log(
      `decoy property: seeds=${SEED_COUNT} intact=${intactCount} resolved=${resolved} ` +
        `ambiguous=${ambiguous} other=${other} wrongWhileIntact=${wrong}`,
    );
    expect(wrong).toBe(0);
    expect(resolved).toBeGreaterThan(20);
  }, 300_000);

  it('a one-character edit inside the quote is found in place as changed', () => {
    let cases = 0;
    let changed = 0;
    for (let seed = 600; seed < 600 + SEED_COUNT; seed++) {
      generate(seed);
      const rand = prng(seed * 13);
      for (let k = 0; k < 4; k++) {
        const nodes = textNodesOf(document.body).filter(
          (n) =>
            n.data.trim().length > 50 &&
            !n.parentElement!.closest('script,style,textarea,noscript,[data-studyvault]'),
        );
        if (nodes.length === 0) break;
        const node = nodes[Math.floor(rand() * nodes.length)]!;
        const a = Math.floor(rand() * (node.data.length - 40));
        const range = document.createRange();
        range.setStart(node, a);
        range.setEnd(node, a + 40);
        const result = captureAnchor(range, range.toString(), buildTextStream());
        if ('error' in result) continue;
        const { anchorSet } = result;
        if (anchorSet.textQuote.exact.length < 30) continue;
        cases++;

        const original = node.data;
        const i = a + 10 + Math.floor(rand() * 20);
        node.data =
          original.slice(0, i) + (original[i] === 'z' ? 'y' : 'z') + original.slice(i + 1);
        const res = resolveAnchor(anchorSet, buildTextStream());
        // Repeated vocabulary can make an edited quote coincide with another copy; the contract is
        // "never the wrong place": changed/resolved must be the original node, else ambiguous.
        if (res.status === 'changed' || res.status === 'resolved') {
          expect(res.range!.startContainer, `seed ${seed} #${k}`).toBe(node);
          if (res.status === 'changed') changed++;
        } else {
          expect(res.status).toBe('ambiguous');
        }
        node.data = original;
      }
    }
    console.log(`in-place edit property: cases=${cases} changed=${changed}`);
    expect(cases).toBeGreaterThan(20);
    expect(changed / cases).toBeGreaterThan(0.8);
  }, 300_000);

  it('an edited original is never replaced by a verbatim copy elsewhere', () => {
    let cases = 0;
    let ambiguous = 0;
    let atOriginal = 0;
    for (let seed = 400; seed < 400 + SEED_COUNT; seed++) {
      generate(seed);
      const rand = prng(seed * 17);
      for (let k = 0; k < 4; k++) {
        const nodes = textNodesOf(document.body).filter(
          (n) =>
            n.data.trim().length > 50 &&
            !n.parentElement!.closest('script,style,textarea,noscript,[data-studyvault]'),
        );
        if (nodes.length === 0) break;
        const node = nodes[Math.floor(rand() * nodes.length)]!;
        const a = Math.floor(rand() * (node.data.length - 40));
        const range = document.createRange();
        range.setStart(node, a);
        range.setEnd(node, a + 40);
        const result = captureAnchor(range, range.toString(), buildTextStream());
        if ('error' in result) continue;
        const { anchorSet } = result;
        const exact = anchorSet.textQuote.exact;
        if (exact.length < 30) continue;
        cases++;

        // The page corrects one character inside the quote, and a verbatim copy lives elsewhere.
        const original = node.data;
        const i = a + 10 + Math.floor(rand() * 20);
        node.data =
          original.slice(0, i) + (original[i] === 'z' ? 'y' : 'z') + original.slice(i + 1);
        const copy = document.createElement('aside');
        copy.textContent = `Summary: ${exact}`;
        document.body.appendChild(copy);

        const res = resolveAnchor(anchorSet, buildTextStream());
        if (res.status === 'resolved' || res.status === 'changed') {
          expect(
            res.range!.startContainer,
            `seed ${seed} #${k} snapped to the copy: ${exact}`,
          ).toBe(node);
          atOriginal++;
        } else {
          ambiguous++;
          expect(res.range).toBeNull();
        }
        copy.remove();
        node.data = original;
      }
    }
    console.log(
      `edited-original property: cases=${cases} ambiguous=${ambiguous} atOriginal=${atOriginal}`,
    );
    expect(cases).toBeGreaterThan(20);
  }, 300_000);
});
